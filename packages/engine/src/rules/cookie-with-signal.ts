// SPDX-License-Identifier: GPL-3.0-only
/**
 * cookie-set-with-signal / cookie-set-on-redirect — the core network findings
 * (PRD FR-8, FR-9, FR-17).
 *
 * For each network observation: if the request carried Sec-GPC: 1, the responding
 * domain classifies as advertising or analytics, and the response set a cookie, that is
 * a finding. If the response was a redirect hop, it is the redirect variant — a
 * signature tracking-pixel pattern that a Set-Cookie harness measured as a large share
 * of real-world cookie setting and that onResponseStarted-based capture would miss.
 *
 * Emits one finding per distinct cookie (name and domain) set on a signed request, so the
 * artifact names the exact cookie (IDE, MUID, _fbp), not "a cookie", and the findings
 * number what the headline counts. Rolls the domain up to its entity via the injected
 * classifier. Unclassified domains never reach here (category !== ad/analytics).
 *
 * Built from the tallies (1.22.0), not the request list, so the findings are the same
 * after a worker reclaim loses the list: one per signed counted key, its artifact the
 * first signed request that set it, the redirect variant when any signed set of it came on
 * a redirect hop. Not one finding per Set-Cookie event: a refreshing ad slot multiplies
 * those and a reclaim erases them. A bundle from before 1.22.0 has its details derived from
 * its requests (withPersistedShape) and is read the same way.
 *
 * What this rule deliberately does NOT do: infer intent, decide legality, or care about
 * jurisdiction. It reports that a header came back on a request that carried the signal.
 */

import type { Finding, ObservationSet, NetworkObservation, CookieRecord, CookieDetail, TagManagerKind } from "@gpc-inspector/schema";
import { isCookieSet, isTallied } from "@gpc-inspector/schema";
import type { Classifier } from "../classifier.js";
import { COUNTING_CATEGORIES as COOKIE_DRIVING_CATEGORIES } from "../classifier.js";
import { RANK } from "../ranks.js";
import { withPersistedShape } from "../normalize.js";
import { cookieCharge, isCounted, type CookieCharge } from "../cookie-charge.js";
import { NO_OWNERS, type OwnerNames } from "../owner-names.js";

/**
 * The cookies a response or script actually SET: its cookie records minus deletions. A
 * vendor clearing its own cookie (an expiry in the past, or max-age=0) set nothing, and
 * counting the deletion counts its clean-up against it (seen 2026-09-22: probe cookies
 * set and removed within a second counted twice). Minus, too, a cookie the browser's jar
 * was found not to hold (1.30.0), which the worker's counts left out already.
 */
export function cookiesSet(net: NetworkObservation): readonly CookieRecord[] {
  return net.setCookies.filter((c) => isCookieSet(c, net.timeMs));
}

/**
 * Does this observation describe an identifier leaving to a third party?
 *
 * Party matters, because cookies written by JavaScript are captured too. A cookie returned
 * by doubleclick.net on a signed cross-site request is data going to a third party. A
 * first-party `_ga` written by Google's script into the site's own jar is a different
 * fact: the vendor's code ran, but nothing crossed a site boundary in that act.
 *
 * Both are worth reporting. Counting them as the same thing would inflate the headline
 * number with something the headline does not describe — technically true, and overstated,
 * which is the failure this product exists to avoid.
 */
function isThirdPartyRecipient(cls: { party: string; category: string }): boolean {
  return cls.party === "third" && COOKIE_DRIVING_CATEGORIES.has(cls.category);
}

/**
 * The cookies an observation set that the count includes, each with its charge (1.25.0).
 * Per cookie, not per request: a script's observation can carry a name its container's
 * owner wrote beside one it did not, and only the first counts.
 */
function countedIn(
  net: NetworkObservation,
  topSite: string,
  classifier: Classifier,
  owners: OwnerNames,
): { cookie: CookieRecord; charge: CookieCharge }[] {
  const out: { cookie: CookieRecord; charge: CookieCharge }[] = [];
  for (const cookie of cookiesSet(net)) {
    const charge = cookieCharge(cookie, net.url, topSite, classifier, owners);
    if (isCounted(charge)) out.push({ cookie, charge });
  }
  return out;
}

/** The entity a charge names, as a finding carries it. */
function findingEntity(charge: CookieCharge, domain: string): Finding["entity"] {
  return charge.kind !== "container" && charge.entity !== null ? { name: charge.entity.name, domains: [domain] } : null;
}

export function cookieSetWithSignal(
  given: ObservationSet,
  classifier: Classifier,
  owners: OwnerNames = NO_OWNERS,
): Finding[] {
  const obs = withPersistedShape(given);
  // The same test as the counts below: with tallies, the findings are the headline's keys.
  if (isTallied(obs.tallies)) return fromTallies(obs, classifier, owners, obs.tallies.cookieDetails ?? {});

  // A set with no tallies (before 1.13.0, or a hand-built fixture): one finding per
  // Set-Cookie event in its requests, the only record it has.
  const findings: Finding[] = [];
  const topSite = obs.context.topSite;

  for (const net of obs.network) {
    // Must have carried the signal on the request.
    if (!net.secGpcPresent) continue;
    // Only what the count includes drives this finding (FR-18: unknown drives nothing).
    const domain = classifier.classify(net.url, topSite).registrableDomain;
    for (const { cookie, charge } of countedIn(net, topSite, classifier, owners)) {
      const entity = findingEntity(charge, domain);
      findings.push({
        flag: net.isRedirectHop ? "cookie-set-on-redirect" : "cookie-set-with-signal",
        rank: net.isRedirectHop
          ? RANK.COOKIE_SET_ON_REDIRECT
          : RANK.COOKIE_SET_WITH_SIGNAL,
        entity,
        artifact: {
          kind: "cookie",
          observationId: net.id,
          cookieName: cookie.name,
        },
      });
    }
  }

  return findings;
}

/** The manager of a `containerKey`, which is `manager:id`. */
function managerOf(containerKey: string): TagManagerKind {
  return containerKey.slice(0, containerKey.indexOf(":")) as TagManagerKind;
}

/** One finding per signed counted cookie key, in key order. */
function fromTallies(
  obs: ObservationSet,
  classifier: Classifier,
  owners: OwnerNames,
  details: Readonly<Record<string, CookieDetail>>,
): Finding[] {
  const findings: Finding[] = [];
  const topSite = obs.context.topSite;
  for (const key of [...obs.tallies.adCookieKeys].sort()) {
    const detail = details[key];
    if (detail === undefined || detail.firstSignedObservationId === null || detail.host === "") continue;
    const cookieName = key.slice(0, key.indexOf("\u0000"));
    // Classified again under today's lists, as vendor-signal-check does with the summaries:
    // a host the list no longer gives to an advertising or analytics company is left out
    // rather than reported under a category it no longer holds. A key written inside a
    // container (1.25.0) takes its company and category from the owner's list, as the tally
    // did, never from the host: googletagmanager.com names nobody, and tags.tiqcdn.com
    // names Tealium for Adobe's names too. A name today's list no longer gives the owner
    // drives no finding.
    const cls = classifier.classify(`https://${detail.host}/`, topSite);
    const own = detail.container === undefined ? null : owners.match(managerOf(detail.container), cookieName);
    if (detail.container !== undefined && own === null) continue;
    const who = own === null ? cls : { party: cls.party, category: own.category, entity: own.entity };
    if (!isThirdPartyRecipient(who)) continue;
    findings.push({
      flag: detail.onRedirectSigned ? "cookie-set-on-redirect" : "cookie-set-with-signal",
      rank: detail.onRedirectSigned ? RANK.COOKIE_SET_ON_REDIRECT : RANK.COOKIE_SET_WITH_SIGNAL,
      entity: who.entity ? { name: who.entity.name, domains: [cls.registrableDomain] } : null,
      artifact: { kind: "cookie", observationId: detail.firstSignedObservationId, cookieName },
    });
  }
  return findings;
}

/**
 * Count of ad cookies set on signed requests — the badge number and the popup headline
 * (PRD FR-22, D11). This is the same underlying fact as the findings above, counted.
 *
 * Exposed separately because the badge needs the number without materializing findings,
 * and because the null-state rules (5.6) that decide whether the number is even shown
 * live at the report level, not here. Here we just count.
 */
export function countCookiesSetWithSignal(
  obs: ObservationSet,
  classifier: Classifier,
  owners: OwnerNames = NO_OWNERS,
): number {
  if (isTallied(obs.tallies)) return obs.tallies.adCookieEvents;

  let count = 0;
  const topSite = obs.context.topSite;
  for (const net of obs.network) {
    if (!net.secGpcPresent) continue;
    count += countedIn(net, topSite, classifier, owners).length;
  }
  return count;
}

/**
 * The same event count for requests that did NOT carry the signal.
 *
 * The baseline for a comparison: turn sending off, reload, and this is the number the
 * signed count is measured against. Whether behavior changes with the signal is one of
 * the ways a regulator judges support, so the two counts come from one counter and are
 * never added together.
 */
export function countCookiesSetWithoutSignal(
  obs: ObservationSet,
  classifier: Classifier,
  owners: OwnerNames = NO_OWNERS,
): number {
  if (isTallied(obs.tallies)) return obs.tallies.adCookieEventsUnsigned ?? 0;

  let count = 0;
  const topSite = obs.context.topSite;
  for (const net of obs.network) {
    // A lost request's signal was not observed, which is not its absence (1.26.0).
    if (net.secGpcPresent || net.requestLost === true) continue;
    count += countedIn(net, topSite, classifier, owners).length;
  }
  return count;
}

/**
 * Count of DISTINCT advertising cookies set on signed requests — the badge number
 * (PRD FR-22, D11).
 *
 * Distinct by name + domain, not per event. Ad slots refresh, so a library re-setting
 * `IDE` every 30 seconds produces a new Set-Cookie each time; every one is genuinely a
 * cookie set on a signed request, and counting them all is factually true but measures
 * dwell time as much as site behavior. Observed live: a badge climbing 44 → 53 while the
 * page sat idle. A number that only grows also cannot be compared between sites or
 * visits, and a tab left open overnight would read in the thousands.
 *
 * Distinct identifiers answer the question a person is actually asking — how many
 * advertising cookies this site placed while the signal was on — and the answer is stable.
 * The per-event total remains available via countCookiesSetWithSignal for the detail
 * panel, where "set 53 times" is useful context rather than a headline.
 */
export function countDistinctCookiesSetWithSignal(
  obs: ObservationSet,
  classifier: Classifier,
  owners: OwnerNames = NO_OWNERS,
): number {
  // Prefer the tallies: they are maintained at capture time and are complete, whereas
  // `network` is a sample bounded by the storage quota. Scanning the sample makes this
  // count a function of what survived eviction rather than of what happened — on one page
  // it read 87, then 25, then 0 as the retention rule changed underneath it.
  if (isTallied(obs.tallies)) return obs.tallies.adCookieKeys.length;

  const seen = new Set<string>();
  const topSite = obs.context.topSite;
  for (const net of obs.network) {
    if (!net.secGpcPresent) continue;
    for (const { cookie } of countedIn(net, topSite, classifier, owners)) {
      seen.add(`${cookie.name}\u0000${cookie.domain}`);
    }
  }
  return seen.size;
}

/** Distinct advertising cookies set on requests that did NOT carry the signal. */
export function countDistinctCookiesSetWithoutSignal(
  obs: ObservationSet,
  classifier: Classifier,
  owners: OwnerNames = NO_OWNERS,
): number {
  if (isTallied(obs.tallies)) return (obs.tallies.adCookieKeysUnsigned ?? []).length;

  const seen = new Set<string>();
  const topSite = obs.context.topSite;
  for (const net of obs.network) {
    // A lost request's signal was not observed, which is not its absence (1.26.0).
    if (net.secGpcPresent || net.requestLost === true) continue;
    for (const { cookie } of countedIn(net, topSite, classifier, owners)) {
      seen.add(`${cookie.name}\u0000${cookie.domain}`);
    }
  }
  return seen.size;
}

/**
 * Count of third-party advertising/analytics REQUESTS observed (PRD 5.6).
 *
 * A different question from "how many cookies were set", and conflating the two produces
 * a factual error. Observed live: apparel-c.example set no cookies via response headers during a
 * page load, so a cookie-derived check reported "no third-party ad or analytics requests
 * observed" — the identical message shown for en.encyclopedia-a.example, which genuinely has none.
 * apparel-c's ad stack was plainly running: 18 scripts read the signal.
 *
 * These are two distinct states and must render distinctly:
 *   no ad-tech requests at all      -> nothing was observable; excluded from all totals
 *   ad-tech requests, zero cookies  -> a real, countable zero
 */
export function countAdTechRequests(obs: ObservationSet, classifier: Classifier): number {
  if (isTallied(obs.tallies)) return obs.tallies.adVendorRequests;

  let count = 0;
  const topSite = obs.context.topSite;
  for (const net of obs.network) {
    // Only its response was seen; the worker that saw it go out counted it (1.26.0).
    if (net.requestLost === true) continue;
    const cls = classifier.classify(net.url, topSite);
    if (!isThirdPartyRecipient(cls)) continue;
    count++;
  }
  return count;
}

/**
 * Count of first-party cookies written by a script attributable to an ad/analytics vendor.
 *
 * Separate from the headline count on purpose. `_ga` in the site's own jar is a real fact
 * about a vendor's code running on the page, and it is not the same fact as an identifier
 * being sent to that vendor's domain. The popup shows it as supporting detail rather than
 * folding it into the number a person reads as "how much left".
 *
 * Only cookies whose writing script was ATTRIBUTABLE are counted. An unattributable JS
 * cookie could have been written by the site's own code, and attributing it to a vendor
 * on the strength of its name would be a guess.
 */
export function countFirstPartyVendorCookies(
  obs: ObservationSet,
  classifier: Classifier,
  owners: OwnerNames = NO_OWNERS,
): number {
  if (isTallied(obs.tallies)) return obs.tallies.firstPartyVendorCookieKeys.length;

  const seen = new Set<string>();
  const topSite = obs.context.topSite;
  for (const net of obs.network) {
    for (const cookie of cookiesSet(net)) {
      if (cookie.via !== "documentCookie" && cookie.via !== "cookieStore") continue;
      if (cookie.writerScriptUrl === null || cookie.writerScriptUrl === undefined) continue;
      // The count's own rule (1.25.0): a name written inside a container is a vendor's only
      // by the owner's list, and a first-party container's names are nobody's.
      const charge = cookieCharge(cookie, cookie.writerScriptUrl, topSite, classifier, owners);
      if (charge.kind !== "host" || !COOKIE_DRIVING_CATEGORIES.has(charge.category)) continue;
      seen.add(`${cookie.name}\u0000${cookie.domain}`);
    }
  }
  return seen.size;
}

/** Helper kept local so tests can assert on the redirect split without re-deriving it. */
export function isTrackingCookieResponse(
  net: NetworkObservation,
  classifier: Classifier,
  topSite: string,
): boolean {
  if (!net.secGpcPresent || cookiesSet(net).length === 0) return false;
  const cls = classifier.classify(net.url, topSite);
  return isThirdPartyRecipient(cls);
}
