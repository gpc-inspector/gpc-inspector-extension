// SPDX-License-Identifier: GPL-3.0-only
/**
 * vendor-signal-check — did each vendor's own script check for GPC specifically
 * (PRD FR-10, FR-11, FR-17).
 *
 * It keeps "no script executed" (the question does not apply: a pixel-only vendor) apart
 * from "a script executed and did not check" (an actual absence), so a pixel-only vendor
 * never reads like one that ran ad-tech and never looked.
 *
 * TWO MECHANISMS, NOT ONE.
 *
 * A vendor can check for GPC in either of two ways, and this rule counts both:
 *
 *   1. calling the GPP consent API (`__gpp`), whose response carries the choice;
 *   2. reading `navigator.globalPrivacyControl` directly — the mechanism the GPC
 *      specification itself defines for scripts.
 *
 * Counting only the first would label a vendor that read the property and never touched
 * GPP as not having read GPC: an absence not looked for, reported as one observed, under a
 * label naming the exact mechanism not measured. Reads are attributed to their calling
 * script by capture-extension observe/read-attribution.ts.
 *
 * The two are not equally precise and the code keeps them apart. A call count is exact; an
 * attributed read count comes from a SAMPLE of reads, so it is a lower bound and is only
 * ever tested against zero. The artifact records which mechanism was actually seen.
 *
 * ONE COMPANY, ONE CATEGORY AT A TIME. The unit judged is a company from the domains of
 * one category: Microsoft from its Advertising domains apart from Microsoft from its
 * Analytics ones, and every category is judged, not only the two that count. A read, a
 * call and "its script ran" belong to the category of the domain the script or request
 * came from. Judged per company, a script from a company's Content domain that ran and
 * read nothing would put that company's advertising pixel under "did not read", a claim
 * about the pixel made on the strength of another product; and what Google documents of its
 * own handling is per product. "Vendor" below means that unit.
 *
 * Five states per vendor, in this decision order:
 *
 *   vendor-read-gpc                  an attributable __gpp call from this vendor's own
 *                                     script, or an attributable direct read of the
 *                                     property by it (neither resolved via a container)
 *   vendor-no-script-observed         only passive requests seen (image/font/etc) and no
 *                                     JS-written cookie attributable to this vendor — the
 *                                     question does not apply, this is not an accusation
 *   vendor-did-not-read-gpc           this vendor's own script executed (script/xhr
 *                                     request, or a JS-written cookie attributed to it)
 *                                     and neither kind of check was attributable to it, on
 *                                     a page with no tag-manager container present at all
 *   vendor-gpc-unread-via-container   same as above, but the page runs a container and
 *                                     that container made zero GPC checks page-wide
 *   vendor-gpc-check-unattributable   same, but the container made some GPC checks and
 *                                     which tag they belonged to is unknown
 *
 * WHAT ATTRIBUTION STILL MISSES, in both mechanisms alike: a vendor bundle served from the
 * site's own domain classifies as first-party and is not attributed to the vendor, and
 * vendor code running inside a tag-manager container resolves to the container. The second
 * is what the last two states exist to say out loud rather than guess at.
 *
 * The last two deliberately borrow a PAGE-WIDE fact (the container's own call count),
 * which is close to a claim view-model.ts's VendorRow deliberately never makes for a
 * different question ("this vendor was loaded through GTM" — a script-provenance claim
 * stamped from an unrelated page-level fact, wrong on retailer-m.example and news-f.example
 * alike). This differs in what it claims: it never asserts how the vendor's OWN script
 * arrived — that still comes from `network`, not from any container fact — only that
 * (a) this vendor's own script ran and made no attributable check, and (b) separately,
 * this is what the page's container(s) show. "(via tag manager)" in the display copy
 * means "this page runs one", not "this vendor loaded through it" (view-model.ts's
 * VendorRow comment makes the parallel note).
 *
 * The insertion records (provenance) say who loaded each vendor's script, and a vendor
 * whose loaders all resolved is judged by its LOADER CHAIN instead of the page-wide
 * container count above: see decideByChain at the bottom of this file. The page-wide path
 * serves vendors the records could not resolve and bundles that carry no records, which
 * is why the five flags and the two artifact kinds both stay.
 *
 * A DOMAIN WITH NO COMPANY (1.26.0). A third-party registrable domain the list names no
 * company for, outside the categories that count, is a unit of its own beside the company in
 * a category, judged the same way to the same five states: its calls, its sampled reads,
 * whether its code ran, and who loaded it, all resolved per domain. The finding's entity is
 * the domain (`unlisted: true`) and makes no claim about who operates it. Only the rows of
 * the vendor list's last group are judged (unlistedDomainHasRow, or a script from the domain
 * read GPC), from the tallies' byUnlistedDomain, so a bundle without that summary gets no such finding, and no
 * company's finding changes with them.
 */

import type { Finding, FindingArtifact, FindingEntity, ObservationSet, LoaderIdentity, LoaderRoute, ContainerIdentity } from "@gpc-inspector/schema";
import { containerIdentity, containerKey, entityCategoryKey, ACTIVE_RESOURCE_TYPES, callCount, unlistedDomainHasRow } from "@gpc-inspector/schema";
import type { Classifier, Classification } from "../classifier.js";
import { RANK } from "../ranks.js";
import { COUNTING_CATEGORIES } from "../classifier.js";
import { resolveLoaders, recordKeyOf } from "../provenance.js";
import { withPersistedShape } from "../normalize.js";
import { gppCheckTest } from "../gpp-check.js";
import { cookieCharge, isCounted } from "../cookie-charge.js";
import { NO_OWNERS, type OwnerNames } from "../owner-names.js";

/**
 * A vendor is a third-party domain the list names a company for, in ANY category,
 * "unknown" included. What is COUNTED is narrower: the cookie rule and the tallies keep to
 * COUNTING_CATEGORIES, and nothing here feeds a count.
 */
function isVendorEntity(cls: Classification): cls is Classification & { entity: NonNullable<Classification["entity"]> } {
  return cls.party === "third" && cls.entity !== null;
}

/**
 * The registrable domain a URL is judged under when the list names no company for it: third
 * party, no company, and outside the categories that count, as the tallies' byUnlistedDomain
 * keeps it. null for every other URL. A counted domain with no company stays under its
 * category, where the number above it counts its cookies, and is not judged here.
 */
function unlistedDomainOf(cls: Classification): string | null {
  return cls.party === "third" && cls.entity === null && !COUNTING_CATEGORIES.has(cls.category) ? cls.registrableDomain : null;
}


/**
 * resourceTypes that mean "this vendor's own script executed" as opposed to a passive
 * resource (image/font/stylesheet/media/ping/etc) merely loading from its domain. Kept
 * narrow deliberately: this rule makes an absence claim (vendor-did-not-read-gpc), and
 * an unfounded accusation is the failure this product exists to avoid, so the bar for
 * "the script ran" is real code execution evidence, not any request to the domain.
 *
 * How many vendors this puts in vendor-no-script-observed on a real page is a question for
 * real captures, not an assumption.
 */
// The set itself lives in the schema (ACTIVE_RESOURCE_TYPES), shared with the worker's
// tally so EntityTally.scriptRan and this rule agree on what execution means.

/**
 * Whether an `xmlhttprequest` to a vendor's domain counts as that vendor's own execution
 * only when the request-initiator records show it came from the vendor's own frames.
 *
 * OFF. A container's Custom HTML tag, or a header-bidding wrapper, can make an XHR to a
 * vendor's endpoint with no vendor code on the page; with this off, that XHR makes the
 * vendor "did not read GPC" instead of "no script ran". Turning this on moves such vendors
 * into `vendor-no-script-observed`, which is a claim about them, and how often that
 * applies is not measured. When on, an XHR with no initiator record at all (made before
 * the observer ran, or from a worker) still counts; only a record that names someone else
 * excludes it.
 */
export const REQUIRE_XHR_FROM_OWN_FRAMES = false;

interface EntityAgg {
  readonly name: string;
  readonly category: string;
  readonly domains: Set<string>;
  /** A request proving active execution (script/xhr, or a JS-written cookie). */
  scriptObservationId: string | null;
  /** Any request at all, for the no-script-observed artifact (a passive one, typically). */
  anyObservationId: string | null;
  directGpcCallCount: number;
  /** Sampled reads of navigator.globalPrivacyControl attributed to this vendor's script. */
  directReadCount: number;
  /**
   * The tallies' per-vendor summary (1.13.0): requests were counted, and whether its code
   * ran, for when the individual requests were not retained.
   */
  talliedRequests: boolean;
  talliedScriptRan: boolean;
}

function entityOf(byPair: Map<string, EntityAgg>, name: string, category: string, registrableDomain: string | null): EntityAgg {
  const key = entityCategoryKey(name, category);
  const existing = byPair.get(key);
  if (existing) {
    if (registrableDomain !== null) existing.domains.add(registrableDomain);
    return existing;
  }
  const fresh: EntityAgg = {
    name,
    category,
    domains: new Set(registrableDomain === null ? [] : [registrableDomain]),
    scriptObservationId: null,
    anyObservationId: null,
    directGpcCallCount: 0,
    directReadCount: 0,
    talliedRequests: false,
    talliedScriptRan: false,
  };
  byPair.set(key, fresh);
  return fresh;
}

export function vendorSignalCheck(given: ObservationSet, classifier: Classifier, owners: OwnerNames = NO_OWNERS): Finding[] {
  const obs = withPersistedShape(given);
  const topSite = obs.context.topSite;
  const byPair = new Map<string, EntityAgg>();
  // The domains with no company (1.26.0), each a unit with no category. Only for a bundle
  // that keeps their summary: an older one has no row to show them in.
  const byDomain = new Map<string, EntityAgg>();
  const judgeDomains = obs.tallies.byUnlistedDomain !== undefined;
  const domainOf = (domain: string): EntityAgg => entityOf(byDomain, domain, "", domain);
  // Resolved once, before the network loop, because the XHR gate below asks it who made
  // each request. It does not depend on the aggregation.
  const provenance = resolveLoaders(obs, classifier);

  // The summaries (1.20.0) hold everything this rule reads from a request: which company
  // and category, whether its code ran, and (1.22.0, derived for older bundles) the first
  // request and the first proof it ran. So they are the only source, and the findings are
  // the same before and after a worker reclaim empties the request list. The request list
  // is read for a bundle from before the summaries.
  //
  // Except with REQUIRE_XHR_FROM_OWN_FRAMES on: whether an XHR was the vendor's own is
  // decided per request, from the initiator records, and a summary cannot say. The
  // requests are read then, and a summary's own evidence counts only when it is not an
  // XHR (scriptRanOutsideXhr). After a reclaim such a vendor loses its XHR evidence and
  // reads "no script observed", the claim that accuses nobody.
  const fromSummaries = !REQUIRE_XHR_FROM_OWN_FRAMES && obs.tallies.byEntityCategory !== undefined;

  // A JS-written cookie is real evidence the vendor's code ran, independent of the
  // resourceType Chrome reported for whatever request carries the synthetic observation.
  // The code that ran is the WRITER's, so the evidence goes to the writer's category,
  // where the writer is the same company as the request's. In a capture the observation's
  // URL is the writer's, and the two are one. Charged by the one rule (1.25.0): a write
  // inside a container is evidence for its owner, in the name's category, only where the
  // name is the owner's own, as the tally marks it; any other is nobody's. A write charged
  // to a domain with no company is that domain's evidence where the request is the domain's.
  const noteWrites = (net: ObservationSet["network"][number], requestCls: Classification): void => {
    const requestEntity = isVendorEntity(requestCls) ? requestCls.entity.name : null;
    for (const cookie of net.setCookies) {
      if (cookie.via !== "documentCookie" && cookie.via !== "cookieStore") continue;
      if (!cookie.writerScriptUrl) continue;
      const charge = cookieCharge(cookie, cookie.writerScriptUrl, topSite, classifier, owners);
      if (charge.kind === "container" || charge.party !== "third") continue;
      if (charge.entity === null) {
        if (!judgeDomains || charge.kind !== "host" || isCounted(charge) || charge.domain === undefined) continue;
        if (unlistedDomainOf(requestCls) !== charge.domain) continue;
        const unit = domainOf(charge.domain);
        unit.anyObservationId ??= net.id;
        unit.scriptObservationId ??= net.id;
        continue;
      }
      if (charge.kind === "host" && charge.entity.name !== requestEntity) continue;
      const writerDomain = classifier.classify(cookie.writerScriptUrl, topSite).registrableDomain;
      const writer = entityOf(byPair, charge.entity.name, charge.category, writerDomain);
      if (writer.anyObservationId === null) writer.anyObservationId = net.id;
      if (writer.scriptObservationId === null) writer.scriptObservationId = net.id;
    }
  };

  for (const net of fromSummaries ? [] : obs.network) {
    const cls = classifier.classify(net.url, topSite);
    if (!isVendorEntity(cls)) {
      const domain = judgeDomains ? unlistedDomainOf(cls) : null;
      if (domain !== null) {
        const unit = domainOf(domain);
        unit.anyObservationId ??= net.id;
        if (
          ACTIVE_RESOURCE_TYPES.has(net.resourceType) &&
          unit.scriptObservationId === null &&
          countsAsExecutionOf(net, { domain }, obs, provenance, classifier, REQUIRE_XHR_FROM_OWN_FRAMES)
        ) {
          unit.scriptObservationId = net.id;
        }
      }
      // A container's script names no company, and what it wrote can still be an owner's.
      noteWrites(net, cls);
      continue;
    }
    const agg = entityOf(byPair, cls.entity.name, cls.category, cls.registrableDomain);
    if (agg.anyObservationId === null) agg.anyObservationId = net.id;
    if (
      ACTIVE_RESOURCE_TYPES.has(net.resourceType) &&
      agg.scriptObservationId === null &&
      countsAsExecution(net, cls.entity.name, obs, provenance, classifier, REQUIRE_XHR_FROM_OWN_FRAMES, cls.category)
    ) {
      agg.scriptObservationId = net.id;
    }

    noteWrites(net, cls);
  }

  // The summary the tallies keep, per company and category (1.20.0). A vendor whose
  // requests were all lost to a worker restart is still in the summaries, and they say
  // whether its code ran, so it is judged rather than rendered "Not captured".
  const summaries = obs.tallies.byEntityCategory;
  if (summaries !== undefined) {
    for (const tally of Object.values(summaries)) {
      // A company seen only through a cookie its script wrote has no requests and did run,
      // and is judged on that. A summary with neither says nothing.
      if (tally.requests === 0 && !tally.scriptRan) continue;
      const mine = tally.hosts
        .map((h) => classifier.classify(`https://${h}/`, topSite))
        .filter((hc) => isVendorEntity(hc) && hc.entity.name === tally.entity && hc.category === tally.category);
      // The list the bundle was recorded under gave these hosts to this company and
      // category. If today's does not, the summary describes a vendor this evaluation does
      // not have, and it is left out rather than judged under a name it no longer holds.
      // A summary with no hosts at all was made by an owner's name written inside its
      // container (1.25.0), which names no host of the company's, and is judged on that.
      if (mine.length === 0 && tally.hosts.length > 0) continue;
      const agg = entityOf(byPair, tally.entity, tally.category, mine[0]?.registrableDomain ?? null);
      for (const hc of mine) agg.domains.add(hc.registrableDomain);
      agg.talliedRequests = true;
      const ran = tally.scriptRan && (!REQUIRE_XHR_FROM_OWN_FRAMES || tally.scriptRanOutsideXhr === true);
      if (ran) agg.talliedScriptRan = true;
      if (fromSummaries) {
        agg.anyObservationId ??= tally.firstObservationId ?? null;
        if (ran) agg.scriptObservationId ??= tally.executionObservationId ?? null;
      }
    }
  } else {
    // A bundle from before the summaries has the per-company one (1.13.0), which cannot
    // say which category's code ran. Each category the company's hosts fall in takes the
    // company's answer. A bundle from before THAT is judged from retained requests alone.
    for (const [name, tally] of Object.entries(obs.tallies.byEntity)) {
      if (tally.scriptRan === undefined || tally.requests === 0) continue;
      for (const h of tally.hosts) {
        const hc = classifier.classify(`https://${h}/`, topSite);
        if (!isVendorEntity(hc) || hc.entity.name !== name) continue;
        const agg = entityOf(byPair, name, hc.category, hc.registrableDomain);
        agg.talliedRequests = true;
        if (tally.scriptRan) agg.talliedScriptRan = true;
      }
    }
  }

  // The domains' summaries (1.26.0), read as the companies' are just above: whether the
  // domain's code ran, and the first request and proof of it, where the requests are gone.
  for (const u of judgeDomains ? Object.values(obs.tallies.byUnlistedDomain ?? {}) : []) {
    if (u.requests === 0 && !u.scriptRan) continue;
    // As for a company: a summary today's list no longer leaves without a company is not
    // judged under the domain. One with no hosts (a refused write) is judged on itself.
    const mine = u.hosts.filter((h) => unlistedDomainOf(classifier.classify(`https://${h}/`, topSite)) === u.domain);
    if (mine.length === 0 && u.hosts.length > 0) continue;
    const unit = domainOf(u.domain);
    unit.talliedRequests = true;
    // A summary stored by an early build of 1.26.0 has none of the four below.
    const ran = u.scriptRan === true && (!REQUIRE_XHR_FROM_OWN_FRAMES || u.scriptRanOutsideXhr === true);
    if (ran) unit.talliedScriptRan = true;
    if (fromSummaries) {
      unit.anyObservationId ??= u.firstObservationId ?? null;
      if (ran) unit.scriptObservationId ??= u.executionObservationId ?? null;
    }
  }

  // The unit a checking script is judged under: its company in its category, or its domain.
  const unitOf = (url: string): EntityAgg | null => {
    const cls = classifier.classify(url, topSite);
    if (isVendorEntity(cls)) return entityOf(byPair, cls.entity.name, cls.category, cls.registrableDomain);
    const domain = judgeDomains ? unlistedDomainOf(cls) : null;
    return domain === null ? null : domainOf(domain);
  };

  // A `ping` counts only where its answer carries the string, GPP 1.1 and later. Under 1.0
  // it returns version and signal status and no string, and counting it would report a
  // vendor that only asked whether a CMP exists as having asked what the reader chose.
  const isGppCheck = gppCheckTest(obs);
  for (const call of obs.consentApiCalls) {
    if (!isGppCheck(call)) continue;
    if (call.callerScriptUrl === null || call.viaTagManager) continue;
    const agg = unitOf(call.callerScriptUrl);
    if (agg !== null) agg.directGpcCallCount += callCount(call);
  }

  // Direct reads of the property, the OTHER mechanism a vendor can check with. Attributed
  // on a sample (see schema readsByScript), so a count here is a lower bound — which is why
  // it is only ever tested against zero, never reported as "how often".
  for (const [scriptUrl, count] of Object.entries(obs.signal.readsByScript)) {
    if (count <= 0) continue;
    const agg = unitOf(scriptUrl);
    if (agg !== null) agg.directReadCount += count;
  }

  const containerPresent = obs.gtm.present;
  const consentModeActive = obs.gtm.consentMode !== null;
  // Checks the page's container(s) made, by either mechanism. A property read whose stack
  // resolved into a container is the same kind of evidence as a __gpp call from one: a
  // check demonstrably happened and which tag made it cannot be determined.
  let containerGpcCheckCount = obs.signal.readAttribution?.viaTagManager ?? 0;
  for (const call of obs.consentApiCalls) {
    if (!isGppCheck(call) || !call.viaTagManager) continue; // the same test as the direct calls above
    containerGpcCheckCount += callCount(call);
  }

  // Who loaded each vendor's scripts, from the insertion records, and what each loader
  // itself did about GPC. Attached as `loadedVia`, and also CONSULTED: a vendor whose
  // loaders are all positively resolved is judged by its loader chain rather than by the
  // page-wide container count. Absent records mean the page-wide behavior, so a bundle
  // recorded without them is judged page-wide.
  const loaderChecks = loaderCheckEvidence(obs, classifier, provenance);
  const consentModeSetters = consentModeSetBy(obs);

  const findings: Finding[] = [];
  const judge = (
    agg: EntityAgg,
    entity: FindingEntity,
    loaders: readonly LoaderIdentity[] | undefined,
    undetermined: boolean,
    loadedAt: number | null,
  ): void => {
    const loadedVia = loaders !== undefined && loaders.length > 0 ? { loadedVia: loaders } : {};
    // The artifact for "its script ran": the retained request when one is left, else the
    // tallies that say so.
    const ranArtifact = (chain?: { chainChecked: true }): FindingArtifact =>
      agg.scriptObservationId !== null
        ? { kind: "network", observationId: agg.scriptObservationId, ...loadedVia, ...chain }
        : { kind: "tally", ...loadedVia, ...chain };

    // Either mechanism counts. The artifact says WHICH was observed, and a call wins when
    // both were: it carries an exact count, where an attributed read count is a sample. The
    // read count rides along, because whether the call read GPC depends on what the string
    // recorded, and a direct read stays a read whatever it says.
    if (agg.directGpcCallCount > 0 || agg.directReadCount > 0) {
      findings.push({
        flag: "vendor-read-gpc",
        rank: RANK.VENDOR_READ_GPC,
        entity,
        // Who loaded it, as every other state carries (1.26.0): the row names its loader
        // whether or not it read.
        artifact:
          agg.directGpcCallCount > 0
            ? {
                kind: "consent-api",
                api: "__gpp",
                callCount: agg.directGpcCallCount,
                ...(agg.directReadCount > 0 ? { readCount: agg.directReadCount } : {}),
                ...loadedVia,
              }
            : { kind: "signal-read", readCount: agg.directReadCount, ...loadedVia },
      });
      return;
    }

    if (agg.scriptObservationId === null && !agg.talliedScriptRan) {
      const artifact: FindingArtifact =
        agg.anyObservationId !== null
          ? { kind: "network", observationId: agg.anyObservationId, ...loadedVia }
          : agg.talliedRequests
            ? { kind: "tally", ...loadedVia }
            : { kind: "none" };
      findings.push({
        flag: "vendor-no-script-observed",
        rank: RANK.VENDOR_NO_SCRIPT_OBSERVED,
        entity,
        artifact,
      });
      return;
    }

    // --- The loader chain. Only when every loader of this vendor resolved. ---
    if (loaders !== undefined && loaders.length > 0 && !undetermined) {
      const decided = decideByChain(loadedAt, loaders, loaderChecks, consentModeSetters, consentModeActive);
      if (decided !== null) {
        // A "did not read" decided here checked every loader of the chain (decideByChain's
        // step 4), and the artifact says so: the view names the loader as having not read
        // GPC only then.
        findings.push({
          ...decided,
          entity,
          ...(decided.flag === "vendor-did-not-read-gpc" ? { artifact: ranArtifact({ chainChecked: true }) } : {}),
        });
        return;
      }
    }

    if (!containerPresent) {
      findings.push({
        flag: "vendor-did-not-read-gpc",
        rank: RANK.VENDOR_DID_NOT_READ_GPC,
        entity,
        artifact: ranArtifact(),
      });
      return;
    }

    if (containerGpcCheckCount === 0) {
      findings.push({
        flag: "vendor-gpc-unread-via-container",
        rank: RANK.VENDOR_GPC_UNREAD_VIA_CONTAINER,
        entity,
        artifact: { kind: "vendor-check-container", containerCallCount: 0, consentModeActive, ...loadedVia },
      });
      return;
    }

    findings.push({
      flag: "vendor-gpc-check-unattributable",
      rank: RANK.VENDOR_GPC_CHECK_UNATTRIBUTABLE,
      entity,
      artifact: {
        kind: "vendor-check-container",
        containerCallCount: containerGpcCheckCount,
        consentModeActive,
        ...loadedVia,
      },
    });
  };

  for (const [pair, agg] of byPair) {
    const entity = { name: agg.name, domains: [...agg.domains].sort(), category: agg.category };
    judge(agg, entity, provenance.byPair.get(pair), provenance.undeterminedPairs.has(pair), provenance.firstInsertionByPair.get(pair) ?? null);
  }
  // Only a domain with a row: the view draws a row for every domain judged here and for no
  // other, and one that was only contacted would be carried in every export for nothing. A
  // domain with a summary whose script read GPC or asked __gpp has one too, though it set
  // nothing, so a row says what else it did.
  const signalOn = obs.signal.source !== "none";
  const checked = new Set([...byDomain.values()].filter((a) => a.directReadCount > 0 || a.directGpcCallCount > 0).map((a) => a.name));
  const rows = new Set(
    Object.values(obs.tallies.byUnlistedDomain ?? {})
      .filter((u) => unlistedDomainHasRow(u, signalOn, checked.has(u.domain)))
      .map((u) => u.domain),
  );
  for (const agg of byDomain.values()) {
    const domain = agg.name;
    if (!rows.has(domain)) continue;
    const entity = { name: domain, domains: [domain], unlisted: true as const };
    judge(agg, entity, provenance.byDomain.get(domain), provenance.undeterminedDomains.has(domain), provenance.firstInsertionByDomain.get(domain) ?? null);
  }

  return findings;
}

/**
 * Whether a request is evidence that THIS vendor's own code ran.
 *
 * A script request always is. An XHR is, unless the request-initiator records name who
 * made it and that is not this vendor: a container's tag or a bidding wrapper calling a
 * vendor's endpoint is the caller's execution, not the vendor's. With `require` off (the
 * shipped default) every XHR counts. With it on, an XHR with no record still counts, since
 * an unobserved request is not evidence of anyone else.
 */
export function countsAsExecution(
  net: { readonly url: string; readonly resourceType: string },
  entityName: string,
  obs: ObservationSet,
  provenance: ReturnType<typeof resolveLoaders>,
  classifier: Classifier,
  require: boolean,
  /** The category the vendor is judged in. Absent, any of the company's scripts is its own. */
  category?: string,
): boolean {
  return countsAsExecutionOf(net, { entityName, ...(category !== undefined ? { category } : {}) }, obs, provenance, classifier, require);
}

/** The unit whose execution a request may prove: a company (in a category), or a domain with none. */
type ExecutionUnit = { readonly entityName: string; readonly category?: string } | { readonly domain: string };

function countsAsExecutionOf(
  net: { readonly url: string; readonly resourceType: string },
  unit: ExecutionUnit,
  obs: ObservationSet,
  provenance: ReturnType<typeof resolveLoaders>,
  classifier: Classifier,
  require: boolean,
): boolean {
  if (!require || net.resourceType !== "xmlhttprequest") return true;
  const key = recordKeyOf(net.url);
  const record = (obs.requestInitiators ?? []).find((r) => r.key === key);
  if (!record) return true;
  const topSite = obs.context.topSite;
  const own = (name: string | undefined, cat: string | undefined): boolean =>
    "entityName" in unit && name === unit.entityName && (unit.category === undefined || cat === undefined || cat === unit.category);
  for (const l of record.loaders) {
    const inner = l.insertedBy[0];
    if (inner === undefined) {
      // Inline-only or no frames: nobody named; the vendor is not excluded on that.
      if (l.containerUrls.length === 0) return true;
      continue;
    }
    const cls = classifier.classify(inner, topSite);
    if ("domain" in unit ? unlistedDomainOf(cls) === unit.domain : own(cls.entity?.name, cls.category)) return true;
  }
  // Every initiator named is someone else (a container, another entity, the site), unless
  // the resolution still reaches this unit through an inherited record.
  const ids = provenance.byKey.get(key) ?? [];
  return ids.some((id) => ("domain" in unit ? id.kind === "host" && id.domain === unit.domain : id.kind === "entity" && own(id.name, id.category)));
}

// ---------------------------------------------------------------------------
// The loader chain
// ---------------------------------------------------------------------------

/** What one loader did about GPC: how many checks, and when the first exact one was. */
interface CheckEvidence {
  readonly checks: number;
  /** Earliest `__gpp` call time, or null when the only evidence is sampled reads. */
  readonly firstCallMs: number | null;
}

interface LoaderCheckEvidence {
  readonly container: (identity: ContainerIdentity) => CheckEvidence;
  /** A company's checks from one category's scripts; from any of them when none is named. */
  readonly entity: (name: string, category?: string) => CheckEvidence;
  readonly host: (domain: string) => CheckEvidence;
  readonly site: () => CheckEvidence;
}

/**
 * Check evidence per kind of loader, gathered once per evaluation.
 *
 * A container's checks are the calls and sampled reads that resolved INTO it. An entity's
 * are the attributable calls and reads from its own scripts in the category the loader came
 * from, exactly what would give that company and category `vendor-read-gpc`. The site's are the calls and reads attributed to first-party
 * script URLs, which the page-level "read GPC: yes, by the site" row already counts. Only
 * calls carry a usable time: reads are sampled, and the first sampled read can postdate a
 * load an unsampled read preceded.
 */
function loaderCheckEvidence(
  obs: ObservationSet,
  classifier: Classifier,
  provenance: ReturnType<typeof resolveLoaders>,
): LoaderCheckEvidence {
  const topSite = obs.context.topSite;
  const containerFirstCall = new Map<string, number>();
  const byEntity = new Map<string, { checks: number; firstCallMs: number | null }>();
  const byPair = new Map<string, { checks: number; firstCallMs: number | null }>();
  const byHost = new Map<string, { checks: number; firstCallMs: number | null }>();
  const site = { checks: 0, firstCallMs: null as number | null };

  const bump = (
    map: Map<string, { checks: number; firstCallMs: number | null }>,
    key: string,
    n: number,
    callMs: number | null,
  ): void => {
    const e = map.get(key) ?? { checks: 0, firstCallMs: null };
    e.checks += n;
    if (callMs !== null && (e.firstCallMs === null || callMs < e.firstCallMs)) e.firstCallMs = callMs;
    map.set(key, e);
  };

  const isGppCheck = gppCheckTest(obs);
  for (const call of obs.consentApiCalls) {
    if (!isGppCheck(call)) continue;
    if (call.viaTagManager) {
      const url = call.containerUrls?.[0] ?? call.callerScriptUrl;
      const id = url ? containerIdentity(url) : null;
      if (id && id.id !== null) {
        const k = containerKey(id);
        const t = containerFirstCall.get(k);
        if (t === undefined || call.timeMs < t) containerFirstCall.set(k, call.timeMs);
      }
      continue;
    }
    if (call.callerScriptUrl === null) continue;
    const cls = classifier.classify(call.callerScriptUrl, topSite);
    if (cls.party === "first") {
      site.checks += callCount(call);
      if (site.firstCallMs === null || call.timeMs < site.firstCallMs) site.firstCallMs = call.timeMs;
    } else if (cls.entity) {
      bump(byEntity, cls.entity.name, callCount(call), call.timeMs);
      bump(byPair, entityCategoryKey(cls.entity.name, cls.category), callCount(call), call.timeMs);
    } else bump(byHost, cls.registrableDomain, callCount(call), call.timeMs);
  }
  for (const [url, count] of Object.entries(obs.signal.readsByScript)) {
    if (count <= 0) continue;
    const cls = classifier.classify(url, topSite);
    if (cls.party === "first") site.checks += count;
    else if (cls.entity) {
      bump(byEntity, cls.entity.name, count, null);
      bump(byPair, entityCategoryKey(cls.entity.name, cls.category), count, null);
    } else bump(byHost, cls.registrableDomain, count, null);
  }

  return {
    container: (identity) => {
      const k = containerKey(identity);
      return { checks: provenance.checks.get(k)?.checks ?? 0, firstCallMs: containerFirstCall.get(k) ?? null };
    },
    // A loader from a bundle recorded before 1.20.0 names no category, and is credited
    // with any of the company's checks, as it was then.
    entity: (name, category) =>
      (category === undefined ? byEntity.get(name) : byPair.get(entityCategoryKey(name, category))) ?? { checks: 0, firstCallMs: null },
    host: (domain) => byHost.get(domain) ?? { checks: 0, firstCallMs: null },
    site: () => site,
  };
}

/** The containers whose frames pushed the latest Consent Mode default and update. */
function consentModeSetBy(obs: ObservationSet): ContainerIdentity[] {
  const out: ContainerIdentity[] = [];
  for (const url of [obs.gtm.consentModeDefaultSetBy, obs.gtm.consentModeUpdateSetBy]) {
    if (!url) continue;
    const id = containerIdentity(url);
    if (id && id.id !== null && !out.some((o) => containerKey(o) === containerKey(id))) out.push(id);
  }
  return out;
}

type Decided = Pick<Finding, "flag" | "rank" | "artifact">;

/**
 * Judge a vendor by its loader chain. Returns null when none of the steps below applies,
 * which cannot happen for a fully resolved chain but keeps the caller honest.
 *
 * Order: a loader that checked (the loader itself, never a container above it); else, with
 * a container in the chain, an unrelated container that checked AND set Consent Mode;
 * else, with a container in the chain, "no read via container" scoped to the chain,
 * carrying a parent container that read as context (route "ancestor") when one did; else
 * "did not read", even on a container page, because no loader of this vendor read GPC and
 * the page's containers are not its loaders.
 *
 * A child container is judged like any container. Nothing a parent reads reaches a child's
 * tags on its own: GTM passes no value between containers, and the parent's only channels
 * are gating whether the child loads at all (in which case the child loaded anyway),
 * Consent Mode (its own route), and a dataLayer variable the child's tag consumes (not
 * observed). A site script or another entity that loaded the vendor stays a "loader" route
 * because it can hand the value to the vendor's code directly, which a parent container
 * cannot.
 */
function decideByChain(
  /** The vendor's earliest insertion time, for `checkedBeforeLoad`. */
  loadedAt: number | null,
  loaders: readonly LoaderIdentity[],
  evidence: LoaderCheckEvidence,
  consentModeSetters: readonly ContainerIdentity[],
  consentModeActive: boolean,
): Decided | null {
  const before = (e: CheckEvidence): boolean | null =>
    e.firstCallMs === null || loadedAt === null ? null : e.firstCallMs < loadedAt;
  const artifact = (loader: LoaderIdentity, route: LoaderRoute, e: CheckEvidence): FindingArtifact => ({
    kind: "vendor-check-loader",
    loader,
    route,
    containerCallCount: e.checks,
    checkedBeforeLoad: e.checks > 0 ? before(e) : null,
    consentModeActive,
    loadedVia: loaders,
  });
  const evidenceOf = (l: LoaderIdentity): CheckEvidence => {
    switch (l.kind) {
      case "container":
        return evidence.container(l.identity);
      case "entity":
        return evidence.entity(l.name, l.category);
      case "host":
        return evidence.host(l.domain);
      case "site":
        return evidence.site();
    }
  };

  // Containers first: the more cautious reading wins when the same vendor was loaded
  // both ways.
  const ordered = [...loaders.filter((l) => l.kind === "container"), ...loaders.filter((l) => l.kind !== "container")];

  // 1. A loader in the chain that checked. Containers above a loader are not consulted
  //    here: a parent's read does not reach a child's tags (see the function comment).
  for (const l of ordered) {
    const e = evidenceOf(l);
    if (e.checks > 0) {
      return { flag: "vendor-gpc-check-unattributable", rank: RANK.VENDOR_GPC_CHECK_UNATTRIBUTABLE, artifact: artifact(l, "loader", e) };
    }
  }

  const containerLoaders = ordered.filter((l): l is Extract<LoaderIdentity, { kind: "container" }> => l.kind === "container");
  if (containerLoaders.length > 0) {
    // 2. An unrelated container that checked and set Consent Mode, which every container
    //    on the page shares.
    const chainKeys = new Set<string>();
    for (const l of containerLoaders) {
      chainKeys.add(containerKey(l.identity));
      for (const a of l.ancestors) chainKeys.add(containerKey(a));
    }
    for (const setter of consentModeSetters) {
      if (chainKeys.has(containerKey(setter))) continue;
      const e = evidence.container(setter);
      if (e.checks > 0) {
        const other: LoaderIdentity = { kind: "container", identity: setter, ancestors: [], mixed: false };
        return { flag: "vendor-gpc-check-unattributable", rank: RANK.VENDOR_GPC_CHECK_UNATTRIBUTABLE, artifact: artifact(other, "consent-mode", e) };
      }
    }
    // 3. No loader in the chain read GPC, and no observable route from any other container.
    //    A parent container that read is kept on the artifact as context, with the
    //    ordering, so the help can say it without changing the state.
    for (const l of containerLoaders) {
      for (const ancestor of l.ancestors) {
        const ae = evidence.container(ancestor);
        if (ae.checks > 0) {
          const parent: LoaderIdentity = { kind: "container", identity: ancestor, ancestors: [], mixed: false };
          return { flag: "vendor-gpc-unread-via-container", rank: RANK.VENDOR_GPC_UNREAD_VIA_CONTAINER, artifact: artifact(parent, "ancestor", ae) };
        }
      }
    }
    return {
      flag: "vendor-gpc-unread-via-container",
      rank: RANK.VENDOR_GPC_UNREAD_VIA_CONTAINER,
      artifact: artifact(containerLoaders[0]!, "loader", { checks: 0, firstCallMs: null }),
    };
  }

  // 4. Every loader is positively resolved and none is a container: the page's containers
  //    did not load this vendor, so their checks are not its loaders'. The caller builds
  //    the network artifact with the loaders on it.
  return { flag: "vendor-did-not-read-gpc", rank: RANK.VENDOR_DID_NOT_READ_GPC, artifact: { kind: "none" } };
}
