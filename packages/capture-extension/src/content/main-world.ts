// SPDX-License-Identifier: GPL-3.0-only
/**
 * MAIN-world content script (PRD FR-2, FR-3, FR-10).
 *
 * Runs at document_start in the page's own JavaScript context — the only place where
 * `navigator.globalPrivacyControl` can be defined such that page scripts actually see it.
 * Not an async <script> tag, which races: page scripts can read the property before it
 * exists and see `undefined` while the extension reports success anyway. A
 * manifest-declared MAIN world at document_start has no such race.
 *
 * Cannot use chrome.* (page context), so it talks to the ISOLATED bridge over DOM events.
 * See protocol.ts for why the state is both pushed and answerable on request.
 */

import { assertSignal, lockSignal, ownerSince, ownsSignal, withdrawSignal } from "../signal/assert.js";
import { detectSignalSource } from "../signal/detect.js";
import {
  STATE_EVENT,
  STATE_REQUEST_EVENT,
  READ_EVENT,
  OBSERVE_EVENT,
  POLICY_EVENT,
  parsePolicy,
  type SignalPolicy,
  type SignalStateDetail,
  type ObserveDetail,
} from "./protocol.js";
import { interceptConsentApi, attributeCaller } from "../observe/consent-api.js";
import {
  interceptDocumentCookie,
  interceptCookieStore,
  type DocumentCookieCoverage,
  type DocumentCookieInterceptor,
} from "../observe/js-cookies.js";
import { createReadSampler, DEFAULT_READ_SAMPLE_POLICY, UNCAPPED_READ_SAMPLE_POLICY } from "../observe/read-attribution.js";
import {
  toGppObservation,
  uspStringFrom,
  toTcfObservation,
  consentFromDataLayerPush,
  dataLayerPushArgs,
  detectGtmContainers,
  gtmLoadersFromDocument,
  toGtmObservation,
  consentCommandOf,
  readEffectiveConsent,
  findConfirmationNotice,
  matchesConfirmationNotice,
  dataLayerNamesFromGtmGlobal,
} from "../observe/consent-data.js";
import { watchForLateConfirmation } from "../observe/late-confirmation.js";
import { OpenShadowRoots, renderedText, type ElementLike, type NodeLike } from "../observe/page-text.js";
import { acceptJoins, offerChannel } from "./channel.js";
import { documentHost } from "./document-origin.js";

/**
 * The private node every event to the bridge goes over (see channel.ts). Detached, so no
 * page script can reach it to listen or to dispatch.
 */
const channel: EventTarget = document.createElement("span");

// Read LAZILY, per property access, not once here.
//
// Sending off comes from main-world-deny.js, which the service worker registers only while
// sending is off, and which joins through channel.ts. Statically declared content scripts
// run before dynamically registered ones, so reading it at this point would read it before
// it is ever given, and the setting would appear to do nothing on every page including
// fresh loads. Both scripts run at document_start and page scripts run after, so a lazy read
// is correct. It is this script's own, never a window global the page could set.
//
// The default is true, the property defined at once, because this script is the only one
// the browser runs from the moment the extension loads, as the header rule is live from
// then. The scripts the worker registers come to life on the browser's own schedule after
// an install, an update, a reload or a browser start, and a page that loads in that moment
// runs this script without them. A false there, or no property, would be a claim about the
// reader's choice that the extension cannot back, beside a header that says the opposite;
// true is the setting almost every reader has. The worker's start-up pass then brings such a
// page to the current setting (the policy below), and a page whose setting is off has the
// property removed, so it reads what the browser gives it, as with no extension at all.
let denied = false;
/** Given by main-world-trace-all.js while "Limit GPC read tracing" is off. Read lazily too. */
let traceAll = false;
/** Given by main-world-no-confirmation.js while the confirmation scan is off in Settings. */
let skipConfirmation = false;
const enabled = (): boolean => !denied;
/** Set when the property was defined after the page loaded (protocol.ts, setLate). */
let setLate = false;

/**
 * Who read the property, on a sample of reads.
 *
 * The sampler is built here rather than inside assert.ts deliberately: assert.ts guarantees
 * that a throwing reporter can never reach the page's read, and keeping the stack capture
 * on this side of that boundary means the guarantee still covers it.
 */
const readSampler = createReadSampler(
  () => new Error().stack ?? undefined,
  () => (traceAll ? UNCAPPED_READ_SAMPLE_POLICY : DEFAULT_READ_SAMPLE_POLICY),
);
let traceCapReported = false;

function reportRead(): void {
  const sample = readSampler.onRead();
  // Once per page: the moment tracing thinned out, so the popup can say a read may have
  // been missed for that reason and point at the setting that lifts the cap.
  if (!traceCapReported && readSampler.capReached()) {
    traceCapReported = true;
    observe({ kind: "read-trace-cap" });
  }
  // Unsampled reads dispatch a bare event, so the COUNT stays complete and exact while
  // attribution covers only the sample.
  channel.dispatchEvent(
    sample ? new CustomEvent(READ_EVENT, { detail: sample }) : new CustomEvent(READ_EVENT),
  );
}

/** Replaced when the property is taken back, removed, or defined again by the policy. */
let result = assertSignal(enabled, navigator, reportRead);

/**
 * Whether this document is the page's top one. Every state report says so: the worker keeps
 * the top frame's report over a frame's (sw.ts).
 */
const isTopFrame = (() => {
  try {
    return window.top === window.self;
  } catch {
    // Cross-origin access to window.top throws; that itself proves we are in a subframe.
    return false;
  }
})();

function currentDetail(): SignalStateDetail {
  // Read back, not only derived from the first result: another extension's script that
  // runs after this one can replace our accessor (it is configurable while the lock is
  // off). Pages then read that owner's value, and their reads no longer reach our counter,
  // so read tracking is reported unavailable from here on.
  const since = ownerSince(result, navigator);
  if (since !== null) {
    return { source: since.source, readTracking: "unavailable", asserted: false, value: since.value, topFrame: isTopFrame };
  }
  // No property of ours (sending is off, or it could not be defined), and none of anyone
  // else's when this script ran: another extension may define one later, such as one that
  // sets the property only where the page reads no signal, which it does once the deny has
  // removed ours. Read what owns it now; its getter is not ours, so no read is counted.
  if (result.readTracking === "unavailable" && (result.detection.source === "none" || result.detection.source === "this-extension")) {
    const now = detectSignalSource(navigator);
    if (now.source === "native" || now.source === "other-extension") {
      return { source: now.source, readTracking: "unavailable", asserted: false, value: now.value, topFrame: isTopFrame };
    }
  }
  // Recomputed rather than captured: what the property reports can change once the
  // permission script runs, and a detail object frozen at document_start would report the
  // state before that happened.
  const owned = result.detection.source === "none" || result.detection.source === "this-extension";
  // Another owner is overridden while sending is on, unless it already reads true: then the
  // value is the same either way and the credit stays with the owner. Not the result's
  // effectiveSource, which was decided while sending was still taken to be on: once the
  // deny arrives, the page reads the owner's value and the credit is the owner's.
  const overriding =
    !owned && result.readTracking === "active" && enabled() && result.detection.value !== true;
  return {
    source: owned || overriding
      ? enabled()
        ? "this-extension"
        : "none"
      : result.detection.source,
    readTracking: result.readTracking,
    asserted: (owned || overriding) && enabled(),
    value: currentValue(owned),
    topFrame: isTopFrame,
    ...(setLate ? { setLate: true } : {}),
  };
}

/**
 * What a page script would read from the property RIGHT NOW.
 *
 * Derived, never read back: reading `navigator.globalPrivacyControl` here would go through
 * our own counting accessor and inflate the read count with our own access, which would
 * then be attributed to nobody. The branches reproduce what each accessor returns.
 *
 * Not `result.detection.value`, which is the value detected BEFORE we asserted, and on the
 * ordinary page (nothing owned the property) always "absent". Nor derived from the SOURCE,
 * which answers a different question: a native or other-extension owner reporting `false`
 * with sending off would be recorded as `true` purely because a source exists, and
 * "absent" could never be reported at all.
 */
function currentValue(owned: boolean): true | false | "absent" {
  if (!owned) {
    // Someone else owns the property. Where we wrapped it, sending on answers true (see
    // assert.ts); otherwise the page reads what the owner returned at detection.
    if (result.readTracking === "active" && enabled()) return true;
    return result.detection.value;
  }
  // Ours: the accessor answers true while sending is on and nothing once it is off, so the
  // setting IS the value. Where defineProperty failed, or the property was removed, there
  // is no property to read at all: "absent", a different claim from `false`.
  return result.readTracking === "unavailable" || !enabled() ? "absent" : true;
}

function announce(): void {
  channel.dispatchEvent(new CustomEvent(STATE_EVENT, { detail: currentDetail() }));
}

function announceCapabilities(): void {
  observe({ kind: "capabilities", capabilities: { ...capabilities } });
}

// Answer any later request. Registered BEFORE the channel is offered, since a bridge that
// already runs takes the offer and asks for the state inside offerChannel.
channel.addEventListener(STATE_REQUEST_EVENT, announce);

offerChannel(document, channel);

announce();

/**
 * Sending is off: remove the property this extension defined, so the page reads what the
 * browser gives it, and stop counting, since there is nothing of ours to read. An owner's
 * property is left, and its wrapper answers the owner's value from now on (assert.ts).
 */
function deny(): void {
  denied = true;
  // Only where nothing else owned the property: over an owner's, ours is the wrapper, and
  // removing it would take the owner's property with it.
  const nothingElseOwned = result.detection.source === "none" || result.detection.source === "this-extension";
  if (nothingElseOwned && withdrawSignal(navigator)) result = assertSignal(enabled, navigator, reportRead);
}

/**
 * Take the property back from an extension that replaced it, and lock it, so a script that
 * runs later cannot replace it either (lockSignal in assert.ts). Only while sending is on.
 */
function lock(): void {
  if (denied) return;
  if (!ownsSignal(navigator)) result = assertSignal(enabled, navigator, reportRead);
  lockSignal(navigator);
}

/**
 * The worker's current setting, from its start-up pass (sw.ts) through the bridge. A page
 * that loaded before the registered scripts reached it, or was open before this script
 * could run, is brought to the setting without a reload: sending off removes the property,
 * sending on defines it where it is missing, and the lock is applied with it.
 */
function applyPolicy(policy: SignalPolicy): void {
  if (!policy.send) {
    deny();
  } else {
    const wasMissing = denied;
    denied = false;
    if (wasMissing && !ownsSignal(navigator)) result = assertSignal(enabled, navigator, reportRead);
    if (policy.lock) lock();
    const now = currentDetail();
    if ((wasMissing || policy.injected) && now.source === "this-extension" && now.value === true) setLate = true;
  }
  announce();
}

channel.addEventListener(POLICY_EVENT, (e) => {
  const policy = parsePolicy((e as CustomEvent<unknown>).detail);
  if (policy !== null) applyPolicy(policy);
});

// The scripts the worker registers by setting, which run after this one and before any page
// script. The state is announced again when sending off arrives, as it changes the value.
acceptJoins(document, (detail) => {
  if (detail.slot === "deny") {
    deny();
    announce();
  } else if (detail.slot === "lock") {
    // Registered only while sending is on. Another extension's script may have replaced the
    // accessor since this one ran: take the property back over its value, then lock it.
    lock();
    announce();
  } else if (detail.slot === "trace-all") {
    traceAll = true;
  } else if (detail.slot === "no-confirmation") {
    skipConfirmation = true;
  } else {
    detail.receive((d) => observe(d as ObserveDetail));
  }
});

// ---------------------------------------------------------------------------
// Consent-API observation (FR-11..FR-15)
// ---------------------------------------------------------------------------

function observe(detail: ObserveDetail): void {
  try {
    channel.dispatchEvent(new CustomEvent(OBSERVE_EVENT, { detail }));
  } catch {
    /* never break the page */
  }
}

const capabilities = {
  documentCookie: false,
  cookieStore: false,
  gpp: false,
  uspapi: false,
  tcfapi: false,
  dataLayer: false,
};

for (const api of ["__gpp", "__uspapi", "__tcfapi"] as const) {
  const installed = interceptConsentApi(
    window,
    api,
    (call) => observe({ kind: "consent-call", call }),
    (which, _command, data) => {
      if (which === "__gpp") {
        const gpp = toGppObservation(data);
        if (gpp) observe({ kind: "gpp", gpp });
      } else if (which === "__uspapi") {
        const value = uspStringFrom(data);
        if (value !== null) observe({ kind: "usp", value });
      } else {
        // __tcfapi's payload is decoded and displayed as its OWN fact (page-level context
        // plus a per-vendor purposes line where a call is attributable), never folded into
        // a GPC finding or used to infer GPC compliance. TCF has no obligation relationship
        // to GPC, and decoding it does not change that relationship: it keeps a fact a
        // reader may want to see, the same way `gpp` and `usPrivacy` are decoded without
        // implying either binds GPC compliance.
        const tcf = toTcfObservation(data);
        if (tcf) observe({ kind: "tcf", tcf });
      }
    },
  );
  if (api === "__gpp") capabilities.gpp = installed;
  else if (api === "__uspapi") capabilities.uspapi = installed;
  else capabilities.tcfapi = installed;
}

// --- JavaScript-set cookies (FR-9) ---
//
// Installed before any page script runs. Without it cookies written from JS are invisible
// entirely, which understates every count: apparel-c.example reported one cookie for a full ad
// stack.

/**
 * Report what sits in front of the document.cookie accessor. Sent when a flag becomes true
 * (checked at every write) and on each re-scan from onReady; the worker keeps the top
 * frame's, as it does for the insertion observer's coverage.
 */
function reportCookieCoverage(coverage: DocumentCookieCoverage): void {
  observe({ kind: "cookie-coverage", coverage: { ...coverage }, topFrame: isTopFrame });
}

let cookieInterceptor: DocumentCookieInterceptor | null = null;
{
  // The host the document runs under: in an about:blank, srcdoc or blob: frame the address
  // has none, and a cookie written there belongs to the creator's site (document-origin.ts).
  const pageHost = documentHost(location.hostname, self.origin);
  const report = (cookie: unknown) => observe({ kind: "js-cookie", cookie });
  // Both report false when the API exists and could not be wrapped (an absent cookieStore,
  // on an http:// page, is nothing to observe and reads true). Recording that is the point:
  // an uninstalled interceptor observes nothing, and without this the popup would report
  // the resulting zero as a fact about the site.
  cookieInterceptor = interceptDocumentCookie(document, pageHost, report, { onCoverage: reportCookieCoverage });
  capabilities.documentCookie = cookieInterceptor !== null;
  capabilities.cookieStore = interceptCookieStore(window, pageHost, report);
}

// --- GTM: container detection and Consent Mode state via dataLayer.push ---

let consentState: ReturnType<typeof consentFromDataLayerPush> = null;

/**
 * Which container's frame pushed each consent command, by the innermost tag-manager frame
 * on the push's stack. The store the commands feed is page-wide (see readEffectiveConsent),
 * so who set it is the only per-container fact about it. Site code (the inline default
 * snippet) and pushes replayed from the queue before we attached have no container and
 * stay null.
 */
const consentSetBy: { default: string | null; update: string | null } = {
  default: null,
  update: null,
};

/**
 * Every dataLayer name worth watching right now: those named by loader URLs in the document
 * and those running Google tags report on window.google_tag_manager (apparel-c.example serves its
 * loader from a path that names nothing; see dataLayerNamesFromGtmGlobal).
 */
function dataLayerCandidates(loaders: GtmLoaders = gtmLoadersFromDocument(document)): string[] {
  return [...new Set([...loaders.dataLayerNames, ...dataLayerNamesFromGtmGlobal(window)])];
}

type GtmLoaders = ReturnType<typeof gtmLoadersFromDocument>;

/** The last report sent, so the slow poll below can skip one that says nothing new. */
let lastGtmReport = "";

/** `loaders`: the document's loaders when the caller has just read them, so they are read once. */
function reportGtm(onlyIfChanged = false, loaders?: GtmLoaders): void {
  const fromGlobals = detectGtmContainers(window);
  const fromLoaders = loaders ?? gtmLoadersFromDocument(document);
  const containers = [...new Set([...fromGlobals, ...fromLoaders.containerIds])];
  const gtagIds = fromLoaders.gtagIds;

  const w = window as unknown as Record<string, unknown>;
  const anyDataLayer = dataLayerCandidates(fromLoaders).some((n) => Array.isArray(w[n]));

  const gtm = toGtmObservation(containers, gtagIds, consentState, anyDataLayer, {
    consentModeDefaultSetBy: consentSetBy.default,
    consentModeUpdateSetBy: consentSetBy.update,
    effectiveConsent: readEffectiveConsent(window),
  });
  const json = JSON.stringify(gtm);
  if (onlyIfChanged && json === lastGtmReport) return;
  lastGtmReport = json;
  observe({ kind: "gtm", gtm });
}

function instrumentOneDataLayer(name: string): boolean {
  const w = window as unknown as Record<string, unknown>;
  const dl = w[name];
  if (!Array.isArray(dl)) return false;
  const arr = dl as unknown[] & { push: (...items: unknown[]) => number };
  if ((arr as unknown as Record<string, unknown>)["__gpcWrapped"] === true) return true;

  const originalPush = arr.push.bind(arr);
  // Replay anything already queued before we arrived — including gtag()'s arguments-shaped
  // entries, via the same normalization the live push wrapper below applies. Without this,
  // a consent call made through gtag() before we attached would be silently invisible,
  // while the identical call made through a raw dataLayer.push() would not be.
  for (const entry of arr) {
    const args = dataLayerPushArgs(entry);
    if (args) {
      const next = consentFromDataLayerPush(args, consentState);
      if (next) consentState = next;
    }
  }

  arr.push = (...items: unknown[]) => {
    for (const item of items) {
      const args = dataLayerPushArgs(item);
      if (args) {
        const next = consentFromDataLayerPush(args, consentState);
        if (next) {
          consentState = next;
          // Same stack capture as every other interceptor, guarded the same way: a
          // consent push is a handful per page, and knowing which container made it is
          // what lets the engine say whose check reached whom.
          const command = consentCommandOf(args);
          if (command) {
            let stack: string | undefined;
            try {
              stack = new Error().stack ?? undefined;
            } catch {
              stack = undefined;
            }
            consentSetBy[command] = attributeCaller(stack).containerUrls[0] ?? null;
          }
          reportGtm();
        }
      }
    }
    return originalPush(...items);
  };
  try {
    Object.defineProperty(arr, "__gpcWrapped", { value: true, enumerable: false });
  } catch {
    // A frozen array still had its push replaced above; the marker is only for idempotency.
  }
  return true;
}

/**
 * Claim a dataLayer NAME, not just a moment in time.
 *
 * The standard GTM snippet is `window.dataLayer = window.dataLayer || []` — an assignment,
 * not a mutation of something already there. Polling for an existing array only ever catches
 * whatever happened to run before a given check landed, capped at whatever cutoff the poll
 * gives up at. Defining an accessor here means the page's OWN assignment is what tells us the
 * array now exists — the same late-definition pattern consent-api.ts uses for
 * __gpp/__uspapi/__tcfapi. There is no cutoff: the trap stays live for the rest of the page,
 * so an assignment made five minutes from now, after a consent banner is dismissed, is caught
 * exactly as reliably as one made on the next tick.
 *
 * Idempotent per name, so the poll loop below can call this every tick without redefining an
 * already-claimed property.
 */
const watchedDataLayerNames = new Set<string>();

function watchForDataLayer(name: string): void {
  if (watchedDataLayerNames.has(name)) return;
  watchedDataLayerNames.add(name);

  const w = window as unknown as Record<string, unknown>;
  if (Array.isArray(w[name])) {
    if (instrumentOneDataLayer(name)) onDataLayerCaptured();
    return;
  }

  let backing: unknown = w[name];
  try {
    Object.defineProperty(w, name, {
      configurable: true,
      enumerable: true,
      get() {
        return backing;
      },
      set(value: unknown) {
        backing = value;
        // Wrap synchronously: a push on the very next line must already be observed.
        if (Array.isArray(value) && instrumentOneDataLayer(name)) onDataLayerCaptured();
      },
    });
  } catch {
    // Something non-configurable already holds the name (another extension, or a page that
    // defined it non-configurable). Left alone; the poll loop below still catches it
    // directly on the rare page where it becomes a plain array later anyway.
  }
}

function onDataLayerCaptured(): void {
  const wasAlreadyKnown = capabilities.dataLayer;
  capabilities.dataLayer = true;
  // Corrects a capability report already sent: without this, a dataLayer that only becomes
  // observable after the one-shot report in onReady would stay recorded as unobservable for
  // the rest of the tab's life, even though it is tracked correctly from this point on.
  if (!wasAlreadyKnown) announceCapabilities();
  reportGtm();
}

// Watch every dataLayer name known right now...
for (const name of dataLayerCandidates()) watchForDataLayer(name);

// ...and keep looking for a NAME we did not know about yet: a site can inject its loader
// script (revealing a renamed dataLayer through the `l=` parameter) after document_start,
// and a container served from a first-party path names its dataLayer only on
// window.google_tag_manager once it runs. Every 250ms for the first five seconds, when
// loaders appear, then every two seconds to a minute, for a container that waits on a
// consent banner or a slow page. Every frame looks for names: a frame reports nothing on
// this cadence, but a dataLayer it finds is wrapped, and that frame's consent pushes are
// reported through the wrapper (a frame that stopped there would miss a container it loads
// after five seconds). Bounded, unlike watchForDataLayer's traps.
const DL_FAST_MS = 250;
const DL_FAST_TICKS = 20;
const DL_SLOW_MS = 2000;
const DL_WATCH_MS = 60_000;
const dlStartedAt = Date.now();
let dlTicks = 0;
function dataLayerTick(): void {
  dlTicks++;
  const loaders = gtmLoadersFromDocument(document);
  for (const name of dataLayerCandidates(loaders)) watchForDataLayer(name);
  if (!isTopFrame) return;
  // Containers and gtag ids can appear via a newly-inserted script tag with no dataLayer
  // push alongside it, and consent set from a template never pushes at all; re-report so
  // neither waits for the next push. In the slow phase only a report that changed is sent,
  // except every tenth second, which restores the top frame's report if a frame's own
  // report replaced it.
  if (dlTicks <= DL_FAST_TICKS) {
    if (dlTicks % 4 === 0) reportGtm(false, loaders);
  } else {
    reportGtm((dlTicks - DL_FAST_TICKS) % 5 !== 0, loaders);
  }
}
/**
 * In a frame, whether a slow tick could find something new: a script added since the last
 * look, or a Google tag running here. Most frames are ad frames with neither, and a full
 * scan every two seconds for a minute in each of them would be work for nothing; a
 * container a frame loads late still adds a script.
 */
let dlScriptsSeen: readonly HTMLScriptElement[] | null = null;
function frameMayHaveNews(): boolean {
  // The scripts themselves, not their count: a loader that removes its own tag as it adds a
  // container leaves the count as it was.
  const now = Array.from(document.scripts);
  const seen = dlScriptsSeen;
  const added = seen === null || now.length !== seen.length || now.some((s, i) => s !== seen[i]);
  dlScriptsSeen = now;
  return added || (window as unknown as Record<string, unknown>)["google_tag_manager"] !== undefined;
}
const dlFastTimer = setInterval(() => {
  dataLayerTick();
  if (dlTicks < DL_FAST_TICKS) return;
  clearInterval(dlFastTimer);
  const dlSlowTimer = setInterval(() => {
    if (isTopFrame || frameMayHaveNews()) dataLayerTick();
    if (Date.now() - dlStartedAt >= DL_WATCH_MS) clearInterval(dlSlowTimer);
  }, DL_SLOW_MS);
}, DL_FAST_MS);

// --- Confirmation notice scan (FR-14) ---
//
// Top frame only. See matchesConfirmationNotice for why.

let confirmationFound = false;

/** Taken at document_start, before a page script can replace it. */
const elementLocalName = Object.getOwnPropertyDescriptor(Element.prototype, "localName")?.get;

/** The page's open shadow roots, read by the scan and observed by the watcher. */
const shadowRoots = new OpenShadowRoots({
  page: () => (document.documentElement ? [document.documentElement as unknown as NodeLike] : []),
  isDefined: (name) => customElements.get(name) !== undefined,
  whenDefined: (name) => customElements.whenDefined(name),
  localName: (el) => (elementLocalName ? elementLocalName.call(el) : el.localName),
});

/** The rendered text of the page, its open shadow roots' included, in reading order. */
function confirmationText(): string {
  const body = document.body;
  if (!body) return "";
  shadowRoots.discover();
  return renderedText(body as unknown as ElementLike, shadowRoots.roots, (el) =>
    getComputedStyle(el as unknown as Element).display,
  );
}

/**
 * Scan the rendered text once, its open shadow roots' included. Returns whether a notice was
 * found. A match is always reported. A miss is reported only by the last timed scan
 * (`final`): until then the record stays undetermined, so a summary saved while the scans
 * run says so rather than "not seen". The late watcher below reports only a match, since a
 * miss it found says nothing new.
 */
function scanConfirmation(final = false): boolean {
  if (confirmationFound) return true;
  if (skipConfirmation) return false;
  const match = findConfirmationNotice(confirmationText());
  if (match) confirmationFound = true;
  if (match || final) {
    observe({
      kind: "confirmation",
      state: match ? "detected" : "not-detected",
      evidence: match?.snippet ?? null,
      phrase: match?.phrase ?? null,
      patternIndex: match?.patternIndex ?? null,
      final,
    });
  }
  return match !== null;
}

/**
 * Beside the timed scans, and for as long as the page is open, watch for a notice that
 * renders between them or later still (news-f.example's Osano banner, 2026-09-25). See
 * observe/late-confirmation.ts for the schedule, its stop while the page is hidden, and its
 * cost.
 * Only while the page reads the signal as set: a confirmation of a signal the page never saw
 * is not what this row asks about.
 */
function watchLateConfirmation(): void {
  if (confirmationFound || skipConfirmation || typeof MutationObserver !== "function") return;
  if (currentDetail().value !== true) return;
  const root = document.documentElement;
  if (!root) return;
  watchForLateConfirmation({
    root,
    shadowRoots,
    documentText: () => (document.body?.textContent ?? "") + shadowRoots.textContent(),
    mightBeNotice: matchesConfirmationNotice,
    scan: () => scanConfirmation(false),
    found: () => confirmationFound,
    createObserver: (callback) => new MutationObserver((records) => callback(records)),
    isHidden: () => document.visibilityState === "hidden",
    onVisibilityChange: (listener) => {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
  });
}

/**
 * Announce again if another script replaced our accessor, or defined a property where we
 * have none, since the last look. Asked at DOMContentLoaded and after it: an extension's
 * script at document_idle runs after DOMContentLoaded, at the latest when the page has
 * loaded. The bridge relays a report only when it changed.
 */
function recheckOwner(): void {
  if (!ownsSignal(navigator)) announce();
}

function onReady(): void {
  if (!isTopFrame) return;
  // Re-announce: the initial report was made before the deny script may have run, so the
  // source it carried could be stale in exactly the way the lazy read guards against.
  // It also reads ownership back (currentDetail).
  announce();
  if (document.readyState === "complete") recheckOwner();
  else window.addEventListener("load", recheckOwner, { once: true });
  // A baseline snapshot at DOMContentLoaded, not the last word: reporting at document_start
  // itself would call every single page a dataLayer installation failure, since none has
  // had a chance to run yet. onDataLayerCaptured() sends a correction later if a dataLayer
  // only becomes observable after this point.
  announceCapabilities();
  reportGtm();
  // Turned off in Settings: say so once, so the record reads "not checked" rather than
  // "still checking", and read none of the page's text.
  if (skipConfirmation) {
    observe({ kind: "confirmation", state: "not-checked", evidence: null, phrase: null, patternIndex: null, final: true });
  }
  scanConfirmation();
  // The cookie coverage as of now, reported once even when nothing is in front of us, so
  // the worker can tell "checked, nothing there" from "never reported".
  if (cookieInterceptor !== null) {
    cookieInterceptor.rescan();
    reportCookieCoverage(cookieInterceptor.coverage);
  }
  // Sites render the notice late (CMP callbacks, hydration). Re-scan a few times before
  // settling on "not detected", so a slow banner is not mistaken for an absent one, and
  // watch from now for one that renders later still. The watcher starts here, not after the
  // last scan: between scans 1.5 seconds apart, a toast shown for less than that would go
  // unread. A tool that wraps document.cookie late is caught on the same cadence, so the timer
  // runs its four ticks even once a notice is found (a found notice makes the scan a no-op).
  // The interval is cleared first and the scan runs last, so a scan that throws on a page
  // the reader cannot fix neither keeps the timer running nor skips the cookie rescan.
  let scans = 0;
  const timer = setInterval(() => {
    scans++;
    if (scans >= 4) clearInterval(timer);
    recheckOwner();
    cookieInterceptor?.rescan();
    scanConfirmation(scans >= 4);
  }, 1500);
  watchLateConfirmation();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", onReady, { once: true });
} else {
  onReady();
}

export {};
