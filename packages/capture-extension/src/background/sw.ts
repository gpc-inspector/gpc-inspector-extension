// SPDX-License-Identifier: GPL-3.0-only
/**
 * The service worker (PRD FR-7, FR-8, FR-22, NFR-2).
 *
 * CRITICAL STRUCTURAL RULE: every listener is registered SYNCHRONOUSLY at top level.
 * MV3 dispatches an event to a sleeping worker by starting it and replaying the event —
 * but only to listeners that exist by the time the top-level script finishes. A listener
 * registered inside an async callback (after an `await`) is registered too late and
 * silently misses events. This is the single most common MV3 capture bug.
 *
 * Corollary: nothing here may `await` before the listeners are attached. Settings are
 * read INSIDE handlers, not at module scope.
 *
 * The second structural rule is NFR-2: no state in module-level variables. Everything
 * observed goes to chrome.storage.session via state.ts. A module variable would be lost
 * on worker termination, and the data loss would then reach users as a site failure.
 */

import {
  evaluate,
  countCookiesSetWithSignal,
  countDistinctCookiesSetWithSignal,
  countDistinctCookiesSetWithoutSignal,
} from "@gpc-inspector/engine";
import type { ObservationSet, NetworkObservation, CookieRecord, JarState, WellKnownGpc } from "@gpc-inspector/schema";
import { isCookieDeletion, isGoogleTagScript, lostKeptRecords, consentModeNeedsDataLayer } from "@gpc-inspector/schema";
import { SCHEMA_VERSION, type ScriptInsertionCoverage, type CookieCaptureCoverage } from "@gpc-inspector/schema";
import { mergeConsentCall } from "./consent-calls.js";
import { mergeInsertion, type ReportedInsertion } from "./insertions.js";

import type { Settings, TabState } from "./state.js";
import {
  holdTopLevel,
  takeHeldTopLevel,
  getSettings,
  initSettingsIfAbsent,
  getCachedWellKnown,
  putCachedWellKnown,
  updateTabState,
  getTabState,
  settleTab,
  clearTabState,
  forgetTab,
  resetTab,
  markIncomplete,
  mutableTallies,
  parseStoredState,
  followKept,
  notePrerenderDocument,
  takePrerenderDocument,
  restorePastPage,
} from "./state.js";
import { migrateLegacySettings, removeLegacyRules } from "./migrate.js";
import {
  observationFromRequest,
  mergeResponse,
  observationFromResponse,
  isRetainable,
  hostOf,
  belongsToRequest,
  hopId,
  isTrackableTopLevel,
} from "./requests.js";
import {
  enableGpcHeader,
  disableGpcHeader,
  verifyGpcRuleInstalled,
  isGpcHeaderEnabled,
} from "../signal/dnr.js";
import {
  mergeUsPrivacy,
  usPrivacyFromUrl,
  mergeGpp,
  mergeGppWire,
  gppFromUrl,
  checkUspWire,
  checkGppWire,
  withInvalidUspWire,
  withInvalidGppWire,
  mergeTcf,
  withFrameSeenContainers,
} from "../observe/consent-data.js";
import {
  fetchWellKnown,
  isFresh,
  asCached,
  originOf,
  watchRedirectWithWebRequest,
  gotNoAnswer,
  retryReading,
  RetryAfterLoad,
} from "../observe/well-known.js";
import { getClassifier, getOwnerCookies, getOwnerNames } from "./classifier.js";
import { actionTitleKey, iconStateFor, type SignalIconState } from "../ui/view-model.js";
import {
  tallyRequest,
  tallyCookies,
  untallyCookie,
  talliesWithout,
  isRecordedKey,
  noteWriteTest,
  noteRemovedAfter,
  noteForPair,
  noteForVendor,
  noteForContainer,
  noteForUnlisted,
  cookieKey,
  type ChargeOf,
  type MutableTallies,
  type TallyClassification,
} from "./tally.js";
import { cookieCharge, type CookieCharge } from "@gpc-inspector/engine";
import { cookieWriteAccepted, markCounted, markRemoved, settleRemoval, hold, release, isPending } from "./cookie-events.js";
import { fromOtherPage, noteCommit, sourceOf } from "./documents.js";
import { HeldPrerenders, frameOf, isPrerendering, isTopFrame, type EventFrame } from "./prerender.js";
import { chromeJar, JarChecks, type JarAnswer } from "./jar-check.js";

// ---------------------------------------------------------------------------
// Listeners — all registered synchronously, before any await anywhere.
// ---------------------------------------------------------------------------

/**
 * When this worker instance started.
 *
 * MV3 reclaims an idle worker after roughly 30 seconds, and the in-memory request list dies
 * with it. Recording the start time makes a restart visible: without it, an empty list is
 * indistinguishable from a page that made no requests — and opening the devtools console is
 * itself enough to start a sleeping worker, so the act of looking destroys the evidence.
 */
const WORKER_STARTED_AT = Date.now();

const ALL_URLS = { urls: ["<all_urls>"] };

/**
 * The checks of recorded cookies against the browser's cookie jar (1.30.0). Held in memory:
 * a check the worker does not live to make leaves its records unchecked, and they still
 * count. The keys waiting on a check are in the tab's state (CookieLedger.pending), and a
 * worker that reads a state back shows them (state.ts).
 */
const jarChecks = new JarChecks(chromeJar(), (tabId, answers, unchecked) => {
  void updateTabState(tabId, (s) => applyJarAnswers(s, answers, unchecked));
  scheduleBadge(tabId);
});

/**
 * The id for a request's next hop: the first of `requestId`, `requestId#1`, and on that no
 * observation holds. Hops are numbered in order, so it is the one after the hops seen.
 *
 * A state read back after a reclaim counts its kept records too (1.27.0). The worker before
 * saw the request's first hops, and one that set a cookie is kept by its id. Counted from the
 * list alone, which is empty after a reclaim, the next hop would take that id, and the
 * Requests tab would list the new hop and hide the kept one.
 *
 * Counted, not looked up, as script writes are (scriptWriteId): a scan of the list per
 * request costs the whole list, which has no cap, on every request. The count for a list is
 * taken from what it and the kept records already hold the first time it is asked, which
 * after a reclaim is the kept records alone, and every hop pushed after that takes its id
 * here.
 */
function nextHopId(s: TabState, requestId: string): string {
  let next = hopsTaken.get(s.network);
  if (next === undefined) {
    next = new Map();
    const note = (id: string): void => {
      const hash = id.indexOf("#");
      const request = hash < 0 ? id : id.slice(0, hash);
      const n = hash < 0 ? 0 : Number(id.slice(hash + 1));
      if (Number.isInteger(n)) next?.set(request, Math.max(next.get(request) ?? 0, n + 1));
    };
    for (const o of s.network) note(o.id);
    for (const k of s.keptCookies ?? []) note(k.id);
    hopsTaken.set(s.network, next);
  }
  const n = next.get(requestId) ?? 0;
  next.set(requestId, n + 1);
  return hopId(requestId, n);
}

/** Per request list, the next hop number of each request. A new page's list starts over. */
const hopsTaken = new WeakMap<NetworkObservation[], Map<string, number>>();

/** Tabs owed one more published-file read once their page has loaded. */
const wellKnownRetries = new RetryAfterLoad();

/** What prerendered pages did before they were shown (see prerender.ts). */
const prerenders = new HeldPrerenders<TabState>();

/**
 * Queue a change for the page an event came from: the tab's, or, from a document being
 * prerendered, that prerender's, which the tab is handed if the page is shown.
 */
function updateFor(tabId: number, from: EventFrame, change: (s: TabState) => void): void {
  // A page in the back/forward cache is not the tab's page, however many pages back it is:
  // what it sends as it is frozen belongs to the page it was. Only the page left last has
  // its documents retired (documents.ts).
  if (from.documentLifecycle === "cached") return;
  if (!prerenders.hold(tabId, from, change)) void updateTabState(tabId, change);
}

/** FR-7: capture every request, not just the first. */
chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0) return; // not attributable to a tab (e.g. SW-initiated)
    const obs = observationFromRequest(details);
    const frame = frameOf(details);
    if (details.type === "main_frame") {
      // Before the retention filter: the top document is what the icon is about, whether
      // or not the request itself is worth keeping. A redirect hop that carried the
      // header counts — the signal went out to a server that served this page.
      updateFor(details.tabId, frame, (s) => {
        s.documentSigned = s.documentSigned === true || obs.secGpcPresent;
      });
    }
    if (!isRetainable(obs)) return;
    updateFor(details.tabId, frame, (s) => {
      // A beacon the page being left sends on its way out is not this page's request.
      if (fromOtherPage(s, sourceOf(details))) return;
      // onSendHeaders fires once per REDIRECT HOP with the same requestId, so pushing
      // blindly would produce several observations sharing an id. That would defeat
      // anything keyed on id: the hop-merge logic in onHeadersReceived could not tell which
      // of them a response belongs to.
      //
      // Later hops get the same #N suffix scheme the response side already uses.
      const id = nextHopId(s, details.requestId);
      const stored = id === obs.id ? obs : { ...obs, id };
      s.network.push(stored);

      // Counted here, before any retention decision. Response-side facts (cookies) are
      // folded in when the response arrives; this pass counts the request itself. With the
      // stored id: the summaries name their first request by it, and a later hop that
      // reaches another vendor must not name the first hop's request (1.22.0). A top-level
      // request waits for the commit, which says which site the navigation landed on.
      if (!holdTopLevel(s, details.type, stored.id, "request")) countRequest(s, stored);
      if (isGoogleTagScript(obs.url)) s.googleTagFetched = true;
      // FR-13's third surface: what actually shipped on the wire, which can disagree with
      // what the CMP's API reports. That disagreement is itself the finding.
      //
      // Checked first: a parameter is whatever the tag put there, and an unfilled `[GPP]` or
      // an empty `us_privacy=` is not a string (see consent-data.ts). Invalid values are
      // kept apart, with the host that sent them, and never feed a disagreement.
      const wireHost = hostOf(details.url);
      const usp = checkUspWire(usPrivacyFromUrl(details.url));
      if (usp?.kind === "valid") s.usPrivacy = mergeUsPrivacy(s.usPrivacy, "wire", usp.value, wireHost);
      else if (usp?.kind === "invalid") s.usPrivacy = withInvalidUspWire(s.usPrivacy, usp, wireHost);
      // Same failure mode, GPP side: what __gpp reports can likewise disagree with what a
      // vendor's sync pixel or bid request actually carried on the wire.
      const gpp = checkGppWire(gppFromUrl(details.url));
      if (gpp?.kind === "valid") s.gpp = mergeGppWire(s.gpp, gpp.value, wireHost);
      else if (gpp?.kind === "invalid") s.gpp = withInvalidGppWire(s.gpp, gpp, wireHost);
    });
    scheduleBadge(details.tabId);
    // A tab that was already open when the extension loaded never fires onCommitted, so
    // resetTab() never ran and topSite is empty. Without topSite the engine cannot
    // determine first- vs third-party, making every observation from that tab
    // unclassifiable. Backfill it from the tab itself. This is the common real-world
    // case: users install the extension with tabs already open.
    void ensureTopSite(details.tabId);
  },
  ALL_URLS,
  ["requestHeaders", "extraHeaders"],
);

/**
 * FR-8: the response path. `extraHeaders` is load-bearing: without it Set-Cookie is
 * invisible.
 */
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    updateFor(details.tabId, frameOf(details), (s) => {
      // The response to the page being left, arriving after the reset: not this page's.
      if (fromOtherPage(s, sourceOf(details))) return;
      // Match by REQUEST, not by exact id. onSendHeaders suffixes redirect hops (`req#1`,
      // `req#2`) so their ids are distinct, and an exact-id lookup would miss them: every hop
      // would fall through to the push-a-new-observation path below and create a duplicate
      // that is never tallied. A retained array of 600 observations against tallies of 520
      // requests is the sign: something is being stored without being counted.
      //
      // The LAST unanswered observation for this request is the one this response belongs
      // to: hops are answered in order.
      let idx = -1;
      for (let i = s.network.length - 1; i >= 0; i--) {
        const o = s.network[i];
        if (o && belongsToRequest(o.id, details.requestId) && o.statusCode === null) {
          idx = i;
          break;
        }
      }
      if (idx >= 0) {
        const existing = s.network[idx];
        if (existing) {
          const merged = mergeResponse(existing, details);
          s.network[idx] = merged;
          if (!holdTopLevel(s, details.type, merged.id, "response")) countCookies(s, merged);
        }
        return;
      }
      // A redirect hop reuses the requestId after the first response is already filled
      // in. Record it as its own observation so hop-set cookies are not lost.
      const prior = s.network.filter((o) => belongsToRequest(o.id, details.requestId));
      if (prior.length > 0) {
        const base = prior[0];
        if (base) {
          const hop = {
            ...mergeResponse(base, details),
            id: nextHopId(s, details.requestId),
            url: details.url,
          };
          s.network.push(hop);
          if (!holdTopLevel(s, details.type, hop.id, "response")) countCookies(s, hop);
        }
        return;
      }
      // No request at all: it went out before this worker started, and the response reached
      // this one after a reclaim or a restart (reproduced 2026-09-29). It is kept, marked as
      // a lost request, and its cookies are listed by name and counted nowhere, since what
      // the request carried was not seen. The request itself was counted by the worker that
      // saw it go out.
      //
      // Only in a state this worker read back after a restart. One it reset or created has
      // seen every request since, so a response matching none there is the page before's,
      // arriving after the reset: a page that never committed under the extension (a tab
      // open before install) retires no documents, and fromOtherPage cannot tell. Dropped.
      if (!s.incompleteReasons.includes("worker-restarted")) return;
      const response = observationFromResponse(details);
      if (response.setCookies.length === 0 || !isRetainable(response)) return;
      // A later hop of a request the last worker saw: its first hop may be kept by the bare id.
      const id = nextHopId(s, details.requestId);
      const lost = id === response.id ? response : { ...response, id };
      s.network.push(lost);
      if (!holdTopLevel(s, details.type, lost.id, "response")) countCookies(s, lost);
    });
    scheduleBadge(details.tabId);
  },
  ALL_URLS,
  ["responseHeaders", "extraHeaders"],
);

/** Reset per-tab observations when the user navigates to a new page. */
/**
 * Reset per-navigation state at the START of a navigation, not at commit.
 *
 * This ordering is load-bearing. Content scripts run at document_start, and Chrome does
 * NOT order that relative to webNavigation.onCommitted — so a reset on commit could (and
 * did, on a live page) wipe the signal-state message the content scripts had already
 * delivered, producing the self-contradictory capture "source: none, readCount: 1724".
 *
 * onBeforeNavigate fires before the new document exists, therefore before any content
 * script for it can run. Resetting here cannot clobber their report. Server redirects do
 * not re-fire it, so a redirect chain still resets exactly once.
 */
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  // A prerender's frames navigate under their own frame ids, never 0 (see prerender.ts).
  const frame = frameOf(details);
  if (isPrerendering(frame)) prerenders.started(details.tabId, frame);
  if (details.frameId !== 0) return; // top-level only
  // Before either branch: a check left waiting for a tab cleared below would write a fresh
  // state back for it when it runs.
  jarChecks.forgetTab(details.tabId);
  wellKnownRetries.navigated(details.tabId);
  if (!isTrackableTopLevel(details.url)) {
    // The site goes with the state, and a lookup may fill it in again: a navigation that
    // never commits leaves the page on screen, and its requests keep coming.
    topSiteSources.delete(details.tabId);
    void clearTabState(details.tabId);
    return;
  }
  noteTopSiteFromNavigation(details.tabId);
  void resetTab(details.tabId, hostOf(details.url), details.url);
  // Clear immediately: a count from the previous page would be wrong the moment the new
  // one starts loading.
  void chrome.action.setBadgeText({ tabId: details.tabId, text: "" }).catch(() => {
    // The tab closed before the clear landed. Not a finding, and not worth an error entry.
  });
});

/**
 * The top document did not load: Chrome shows its own error page, where no content script
 * runs, so nothing the popup would read from the page ever arrives. Recorded so the popup
 * can say the page did not load instead of rendering the empty defaults as a page with the
 * signal off (ticketing-b.example, 2026-09-25: "signal is not set" beside a request that
 * carried Sec-GPC).
 *
 * Not for net::ERR_ABORTED. That is a navigation that stopped rather than failed: the user
 * went somewhere else, the response was a download or a 204, or Chrome's own retry of a
 * failed load failed again (it retries about a second later, and the retry ends as an
 * abort with the error page still showing). Whatever was on screen stays there, so the
 * error, if there was one, stays too: resetTab carries it across the start of a navigation
 * to the same address, and only a commit clears it (onCommitted below).
 */
chrome.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.frameId !== 0) return;
  if (details.error === "net::ERR_ABORTED") return;
  if (!isTrackableTopLevel(details.url)) return;
  void updateTabState(details.tabId, (s) => {
    s.loadError = details.error;
    s.loadErrorUrl = details.url;
  });
});

/**
 * At commit, only fill in the resolved site. Never reset here (see above).
 * The committed URL is the authoritative one — it reflects where redirects landed.
 */
chrome.webNavigation.onCommitted.addListener((details) => {
  // Every frame's document joins the page it committed into, so that when the next
  // navigation starts they can be told apart from the new page's (see documents.ts).
  if (details.frameId !== 0) {
    const frame = frameOf(details);
    const { documentId } = sourceOf(details);
    // A prerender's top document: the tab's record keeps its id, so its activation is known
    // for one even by a worker that does not hold what it did.
    if (isPrerendering(frame) && isTopFrame(frame) && documentId !== undefined) {
      prerenders.committed(details.tabId, details.frameId, documentId);
      void updateTabState(details.tabId, (s) => notePrerenderDocument(s, documentId));
    }
    updateFor(details.tabId, frame, (s) => noteCommit(s, { frameId: details.frameId, ...sourceOf(details) }));
    return;
  }
  if (!isTrackableTopLevel(details.url)) {
    topSiteSources.delete(details.tabId);
    void clearTabState(details.tabId);
    return;
  }
  noteTopSiteFromNavigation(details.tabId);
  // A prerendered page being shown: what it did while it loaded is handed over after the
  // commit, in the order it happened, as the start of the page.
  const { documentId } = sourceOf(details);
  const activation = prerenders.activate(details.tabId, documentId);
  void updateTabState(details.tabId, (s) => {
    // A prerender whose page was loaded while nothing kept it: the worker that held it
    // stopped, or it went past the cap. What came after must not pass for the page.
    if (takePrerenderDocument(s, documentId) ? activation?.complete !== true : activation?.complete === false) {
      markIncomplete(s, "prerender-lost");
    }
    // A page the tab left, back from the back/forward cache: it loaded under the capture the
    // navigation away from it replaced, and nothing it did then is here. No request and no
    // content-script report follow a restore, so without this the capture would wait for
    // them for as long as the tab stayed open.
    restorePastPage(s, documentId);
    s.topSite = hostOf(details.url);
    s.finalUrl = details.url;
    // A document committed, so the tab no longer shows an error page (see onErrorOccurred).
    s.loadError = null;
    s.loadErrorUrl = null;
    noteCommit(s, { frameId: 0, ...sourceOf(details) });
    // Now which site the navigation landed on is known: count what was held for it, the
    // redirect hops' cookies included, against that site (1.26.0).
    for (const { obs, what } of takeHeldTopLevel(s)) {
      if (what === "request") countRequest(s, obs);
      else countCookies(s, obs);
    }
  });
  for (const change of activation?.changes ?? []) void updateTabState(details.tabId, change);
  scheduleBadge(details.tabId);
  // At commit, not at onBeforeNavigate: the committed URL is where redirects actually
  // landed, and that is the origin whose declaration matters.
  void checkWellKnown(details.tabId, details.url);
});

/**
 * The top document finished loading: the moment a published-file read that got no answer
 * during the load is tried once more (RetryAfterLoad in well-known.ts).
 */
chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId !== 0) return;
  const origin = originOf(details.url);
  if (origin !== null && wellKnownRetries.loaded(details.tabId, origin)) void retryWellKnown(details.tabId, origin);
});

/** Clean up when a tab closes. */
chrome.tabs.onRemoved.addListener((tabId) => {
  jarChecks.forgetTab(tabId);
  prerenders.forgetTab(tabId);
  topSiteSources.delete(tabId);
  wellKnownRetries.navigated(tabId);
  void forgetTab(tabId);
});

/** Messages from content scripts (read counts, GPP/GTM observations). */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  // POPUP MESSAGES FIRST, dispatched by kind rather than by whether a tab is attached.
  //
  // A message from the popup has no sender.tab, so a guard ahead of this switch that drops
  // anything without one would leave get-signal-status and settings-changed unanswered:
  // the popup would receive undefined, read it as "not sending", and render "sending off in
  // settings" while the setting is on and the rule is installed.
  switch (message?.type) {
    case "get-observations": {
      const target = typeof message.tabId === "number" ? message.tabId : tabId;
      void (async () => {
        if (target === undefined) {
          sendResponse(null);
          return;
        }
        // A tab that was open before this worker has no site until something asks, and
        // otherwise only a request from that tab asks. Opened on a quiet tab straight after
        // an update, the popup would get an empty topSite and say "only evaluates http://
        // and https:// webpages" about an https page (seen on a live page, 2026-09-21). A
        // page that really is ineligible stays empty. Before settling, because the write
        // this queues is batched like every other.
        await ensureTopSite(target);
        await settleTab(target);
        // Fire and forget: the answer lands in state for the popup's next refresh.
        void ensureWellKnown(target).catch(() => {
          // A closed tab or a network failure is not a finding; the row keeps "checking".
        });
        sendResponse(await buildObservationSet(target));
      })();
      return true;
    }

    case "get-signal-status": {
      void (async () => {
        // Reconcile before answering, so opening the popup repairs any drift between the
        // setting and the rule rather than reporting the drift as the user's choice.
        await applySignalPolicy();
        const settings = await getSettings();
        const ruleInstalled = await isGpcHeaderEnabled();
        // Where the signal can reach: the reader's settings in the browser, read for
        // Settings, which says where it does not go.
        const { allSites, incognito } = await signalReach();
        sendResponse({ sendSignal: settings.sendSignal, ruleInstalled, allSitesAccess: allSites, incognitoAccess: incognito });
      })();
      return true;
    }

    case "settings-changed":
      void applySignalPolicy();
      return false;

    default:
      break;
  }

  // Everything below is from a content script and needs a tab to attribute to.
  if (tabId === undefined) return false;

  // Only this page's documents: the page being left keeps writing cookies while it unloads,
  // and those messages arrive after the tab was reset for the next one (see documents.ts).
  const from = sourceOf(sender);
  const frame = frameOf(sender);
  const updatePage = (mutate: (s: TabState) => void): Promise<void> => {
    updateFor(tabId, frame, (s) => {
      if (!fromOtherPage(s, from)) mutate(s);
    });
    return Promise.resolve();
  };

  switch (message?.type) {
    case "signal-state":
      void updatePage((s) => {
        s.stateMessages += 1;
        // Frames report independently (all_frames: true). Once the top document has
        // reported, a frame's report is about that frame, and the page's source and value
        // stay the top document's (TabState.topFrameReported). A report with no `topFrame`
        // is an older content script's, taken as before.
        if (message.topFrame === true) s.topFrameReported = true;
        else if (message.topFrame === false && s.topFrameReported === true) return;
        // Before that, a subframe that finds nothing must not downgrade a report: prefer
        // any concrete source over "none".
        if (s.signalSource === "none" || message.source !== "none") {
          s.signalSource = message.source;
        }
        if (message.readTracking === "unavailable") {
          s.readTracking = "unavailable";
        }

        // The observed property value, under the same frame rule as the source above:
        // "absent" is this field's empty state, so a subframe that has no property must
        // not erase a concrete report from the top frame. A concrete value always wins,
        // including a later `false` correcting an earlier `true` when sending is toggled
        // off without a reload.
        //
        // A message with no `value` is an older content script talking to a newer worker
        // (mid-session extension update). Falling back to the old source-derived reading
        // keeps that window behaving as it did rather than blanking the field.
        const incoming: true | false | "absent" =
          message.value === true || message.value === false || message.value === "absent"
            ? message.value
            : message.source === "none"
              ? false
              : true;
        if (s.propertyValue === "absent" || incoming !== "absent") {
          s.propertyValue = incoming;
        }
      });
      // The icon follows the report at once rather than waiting for the badge pass; a
      // second of the wrong color on every page is the kind of gap a reader notices.
      void settleTab(tabId)
        .then(() => refreshIcon(tabId))
        .catch(() => {
          // A closed tab is not a finding; leave the icon alone.
        });
      return false;

    case "signal-read":
      void updatePage((s) => {
        s.signalReads += message.count ?? 1;

        // Attribution rides along on the same message and is present only when the bridge
        // actually sampled something. Merged rather than replaced: this arrives once per
        // flush window, several times per page.
        const a = message.attribution as
          | {
              sampled?: number;
              unattributed?: number;
              viaTagManager?: number;
              byContainer?: Record<string, number>;
              byScript?: Record<string, number>;
            }
          | undefined;
        if (!a) return;
        // A state persisted before 1.12.0 has no per-container map; treat as empty.
        const byContainer = { ...(s.readAttribution.viaTagManagerByContainer ?? {}) };
        for (const [url, n] of Object.entries(a.byContainer ?? {})) {
          if (typeof n !== "number") continue;
          byContainer[url] = (byContainer[url] ?? 0) + n;
        }
        s.readAttribution = {
          ...s.readAttribution,
          sampled: s.readAttribution.sampled + (a.sampled ?? 0),
          unattributed: s.readAttribution.unattributed + (a.unattributed ?? 0),
          viaTagManager: s.readAttribution.viaTagManager + (a.viaTagManager ?? 0),
          viaTagManagerByContainer: byContainer,
        };
        for (const [url, n] of Object.entries(a.byScript ?? {})) {
          if (typeof n !== "number") continue;
          s.readsByScript[url] = (s.readsByScript[url] ?? 0) + n;
        }
      });
      return false;

    case "gpp":
      void updatePage((s) => {
        // A CMP emits several payloads per page (ping, then getGPPData). Merge so a later
        // sparse payload cannot erase the richer earlier one.
        s.gpp = mergeGpp(s.gpp, message.gpp);
      });
      return false;

    case "gtm":
      void updatePage((s) => {
        s.gtm = message.gtm;
      });
      return false;

    case "confirmation-notice":
      void updatePage((s) => {
        // Only ever upgrade to "detected": the MAIN world scans several times, and watches
        // after that, because sites render the notice late. A miss counts only from the last
        // timed scan (`final`); until then the state stays undetermined, so a summary saved
        // during the scans says it was still checking, not that none was seen.
        if (message.state === "detected") {
          s.confirmationNotice = "detected";
          if (typeof message.evidence === "string") s.confirmationEvidence = message.evidence;
          if (typeof message.phrase === "string") s.confirmationText = message.phrase;
        } else if (message.state === "not-checked" && s.confirmationNotice === "indeterminate") {
          s.confirmationNotice = "not-checked";
        } else if (message.final === true && s.confirmationNotice === "indeterminate") {
          s.confirmationNotice = "not-detected";
        }
      });
      return false;

    case "js-cookie":
      void updatePage((s) => {
        const c = message.cookie as {
          name: string;
          value: string;
          domain: string;
          path: string;
          expiresMs: number | "session" | null;
          sameSite: "Strict" | "Lax" | "None" | "unspecified";
          secure: boolean;
          partitioned: boolean;
          writerScriptUrl: string | null;
          viaTagManager: boolean;
          wrapperScriptUrl?: string | null;
          via: "documentCookie" | "cookieStore";
          timeMs: number;
          frameHost?: string;
          writeTest?: boolean;
          present?: boolean;
        };
        if (!c || typeof c.name !== "string") return;

        // Whom the cookie is charged to, decided once (1.25.0) and used by the refused
        // write, the probe path and the tally alike. See the engine's cookie-charge.ts.
        //
        // With no writer found, a write in a cross-site frame is the frame's: a script there
        // can only write its own frame's domain, and charging it to the page would put a
        // third party's cookie among the site's own. Anywhere else it is the page's.
        // `frameHost` is a bare host, so it is made a URL before it is classified.
        const frameUrl = c.frameHost ? `https://${c.frameHost}/` : null;
        const writerUrl =
          c.writerScriptUrl ??
          (frameUrl !== null && getClassifier().classify(frameUrl, s.topSite).party === "third" ? frameUrl : s.finalUrl);
        const charge = cookieCharge(
          { name: c.name, via: c.via, writerScriptUrl: c.writerScriptUrl },
          writerUrl,
          s.topSite,
          getClassifier(),
          getOwnerNames(),
        );

        // A write the browser refused set nothing, and is not counted. Scripts probing for
        // the widest domain they may use write `domain=.com` first (news-g.example, marketplace-b.example,
        // retailer-e.example, retailer-d.example, news-h.example; 2026-09-22).
        if (!cookieWriteAccepted(c.domain, c.frameHost ?? "")) {
          s.rejectedCookieWrites += 1;
          // Kept against the writing script's vendor, so its panel can say so (1.18.0), and
          // against that vendor in the script's category (1.20.0). A write inside a
          // container is kept on the container's summary, and on its owner only when the
          // name is the owner's (1.25.0).
          if (c.writerScriptUrl) noteRefusedWrite(mutableTallies(s), charge, `${c.name} (${c.domain})`);
          return;
        }

        // A JS cookie is not a response, so it gets its own observation rather than being
        // attached to an unrelated request.
        //
        // secGpcPresent comes from the OBSERVED property value, not from a constant. A
        // hardcoded `true` would count a script-written cookie as "set while the signal was
        // on" even when the property says `false` or does not exist (sending switched off,
        // or another owner asserting false), and feed cookie-set-with-signal,
        // declared-honor-cookie-set and the ad-cookie tallies with an unsigned cookie, and
        // those are the product's strongest claims. The property is the right surface here
        // precisely because a script-written cookie has no request of its own: the property
        // is the only signal a page script could have consulted before writing it.
        //
        // Two writes of one name can land in the same millisecond, so a later one gets `#N`,
        // as a redirect hop does. fides-gpp removes each opted-out cookie twice, with
        // `domain=www.news-g.example` and `domain=.www.news-g.example`, and 433 ids on news-g.example
        // were shared by 2 to 4 entries (2026-09-30). A jar check's answer is written on a
        // record by its observation's id, and two records under one id would both take it.
        const jsObs: NetworkObservation = {
          id: scriptWriteId(s.network, `js-${c.name}-${c.timeMs}`),
          url: writerUrl,
          method: "SCRIPT",
          resourceType: "other",
          initiator: s.finalUrl,
          secGpcPresent: s.propertyValue === true,
          // A JS cookie is not an HTTP exchange, so nothing was carried back on it.
          cookiesSent: [],
          requestHeaders: [],
          statusCode: null,
          responseHeaders: null,
          isRedirectHop: false,
          setCookies: [
            {
              name: c.name,
              value: c.value,
              domain: c.domain,
              path: c.path,
              expiresMs: c.expiresMs,
              sameSite: c.sameSite,
              httpOnly: false,
              secure: c.secure,
              partitioned: c.partitioned,
              via: c.via,
              writerScriptUrl: c.writerScriptUrl,
              writerViaTagManager: c.viaTagManager,
              // What attribution stepped over to find the writer (1.23.0). Kept only when
              // something was: the field is absent, not null, on every other cookie.
              ...(typeof c.wrapperScriptUrl === "string" ? { writerWrapperUrl: c.wrapperScriptUrl } : {}),
            },
          ],
          captureMethod: c.via,
          timeMs: c.timeMs,
        };
        s.network.push(jsObs);
        // Tallied like any other cookie observation. Without this a JS-set cookie would be
        // stored but counted nowhere, so the headline would undercount exactly the cookies
        // that response-header capture is blind to.
        // A write with no domain is host-only: the jar holds it under the writing frame's host.
        countCookies(s, jsObs, () => charge, c.frameHost || hostOf(s.finalUrl), {
          writeTest: c.writeTest === true,
          present: typeof c.present === "boolean" ? c.present : undefined,
        });
      });
      scheduleBadge(tabId);
      return false;

    case "delivery-gap":
      // The content scripts observed things that never reached us. The record is real but
      // partial, and saying so is the difference between a partial view and a wrong one.
      void updatePage((s) => {
        markIncomplete(s, "delivery-gap");
      });
      return false;

    case "capabilities":
      void updatePage((s) => {
        if (message.capabilities && typeof message.capabilities === "object") {
          s.capabilities = { ...s.capabilities, ...message.capabilities };
        }
      });
      return false;

    case "read-trace-cap":
      void updatePage((s) => {
        s.readAttribution = { ...s.readAttribution, traceCapReached: true };
      });
      return false;

    case "script-insertions":
      void updatePage((s) => {
        const records = Array.isArray(message.records) ? (message.records as unknown[]) : [];
        for (const r of records) {
          const rep = r as Partial<ReportedInsertion>;
          if (!rep || typeof rep.key !== "string" || typeof rep.url !== "string" || !rep.loader) continue;
          if (rep.element !== "script" && rep.element !== "iframe") continue;
          mergeInsertion(s.scriptInsertions, rep as ReportedInsertion);
        }
      });
      return false;

    case "request-initiations":
      void updatePage((s) => {
        const records = Array.isArray(message.records) ? (message.records as unknown[]) : [];
        for (const r of records) {
          const rep = r as Partial<ReportedInsertion>;
          if (!rep || typeof rep.key !== "string" || typeof rep.url !== "string" || !rep.loader) continue;
          if (rep.element !== "image" && rep.element !== "fetch" && rep.element !== "xhr" && rep.element !== "beacon") continue;
          mergeInsertion(s.requestInitiators, rep as ReportedInsertion);
        }
      });
      return false;

    case "request-initiation-coverage":
      if (message.topFrame !== true) return false;
      void updatePage((s) => {
        if (message.coverage && typeof message.coverage === "object") {
          s.requestInitiatorCoverage = message.coverage as ScriptInsertionCoverage;
        }
      });
      return false;

    case "cookie-coverage":
      // The top frame's accessor is the page's; a sub-frame's has its own prototypes and
      // its own tools, as with the insertion observer's coverage below.
      if (message.topFrame !== true) return false;
      void updatePage((s) => {
        const c = message.coverage as Partial<CookieCaptureCoverage> | undefined;
        if (!c || typeof c !== "object") return;
        s.cookieCoverage = {
          wrappedOver: c.wrappedOver === true || s.cookieCoverage?.wrappedOver === true,
          onInstance: c.onInstance === true || s.cookieCoverage?.onInstance === true,
        };
      });
      return false;

    case "script-insertion-coverage":
      // Every frame has its own observer and reports its own counters. The top frame's
      // are the page's; a sub-frame's would otherwise overwrite them with its own small
      // numbers (seen on the fixture: a one-script iframe replaced a 30-record page).
      if (message.topFrame !== true) return false;
      void updatePage((s) => {
        if (message.coverage && typeof message.coverage === "object") {
          s.scriptInsertionCoverage = message.coverage as ScriptInsertionCoverage;
        }
      });
      return false;

    case "consent-call":
      void updatePage((s) => {
        // Merged, not appended: one page polled __uspapi 20,096 times and filled session
        // storage for every tab (see consent-calls.ts). A full list drops the call and says
        // so, rather than growing until every write fails.
        if (mergeConsentCall(s.consentApiCalls, message.call) === "dropped") markIncomplete(s, "consent-calls-capped");
      });
      return false;

    case "usp":
      // The page's two surfaces only: the wire is recorded from the request itself above.
      if (message.surface !== "api" && message.surface !== "cookie") return false;
      if (typeof message.value !== "string") return false;
      void updatePage((s) => {
        s.usPrivacy = mergeUsPrivacy(s.usPrivacy, message.surface, message.value);
      });
      return false;

    case "tcf":
      void updatePage((s) => {
        s.tcf = mergeTcf(s.tcf, message.tcf);
      });
      return false;

    default:
      return false;
  }
});

/**
 * First install: write defaults ONCE. Never on wake (see getSettings in state.ts).
 *
 * An update from v0.1.4 arrives here too, carrying its options and its header rule (see
 * migrate.ts). Both are dealt with before the defaults are written and the policy applied,
 * and neither step is gated on `details.reason`: each is a no-op when there is nothing
 * left over, and a failed first attempt gets another on the next update.
 */
chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    await removeLegacyRules().catch(() => undefined);
    await migrateLegacySettings().catch(() => false);
    await initSettingsIfAbsent();
    await applySignalPolicy();
    if (details.reason === "install") {
      // First-run disclosure (D13) is shown by the popup on first open.
    }
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void applySignalPolicy();
});

/**
 * Re-apply the signal policy whenever the setting changes.
 *
 * Without this the toggle would write to storage and nothing would read it: with
 * applySignalPolicy run only at install and startup, the DNR rule would stay installed and
 * Sec-GPC would keep going out on every request after the user turned sending off. A
 * privacy tool that ignores the one control it offers is worse than one that offers none.
 *
 * Registered at top level like every other listener — a settings change can arrive while
 * the worker is asleep.
 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || changes["settings"] === undefined) return;
  void applySignalPolicy();
});

// The reader's site access setting in the browser grants or withholds our host access, and
// the default icon says which (applySignalPolicyNow). Changed in the browser's extension
// settings, with no popup open to ask.
chrome.permissions.onAdded.addListener(() => {
  void applySignalPolicy();
});
chrome.permissions.onRemoved.addListener(() => {
  void applySignalPolicy();
});

// ---------------------------------------------------------------------------
// Helpers — everything below runs inside handlers, never at top level.
// ---------------------------------------------------------------------------

/**
 * Install or remove the DNR header rule to match the user's setting.
 *
 * Note this governs ONLY our own assertion (D10). The MAIN-world script independently
 * decides whether to set the property, based on what already owns it. If Chrome or
 * another extension is sending the signal, turning this off does not stop it — and the
 * UI says so.
 */
function applySignalPolicy(): Promise<void> {
  const run = policyRuns.then(applySignalPolicyNow, applySignalPolicyNow);
  policyRuns = run.catch(() => undefined);
  return run;
}

/**
 * The policy runs, one at a time. A settings change starts two (storage.onChanged and the
 * popup's message), and opening the popup a third. Each reads the setting and then checks
 * what is registered and installed before changing it; run side by side, a run for "on" and
 * a run for "off" can each read the registration before the other changes it, and the
 * assert script or the header rule can stay installed with sending off. In sequence, each run
 * reads the setting as the one before it left things, and the last reads the latest.
 *
 * In memory, against this file's rule, because losing it is harmless: a new worker has no
 * run in flight.
 */
let policyRuns: Promise<void> = Promise.resolve();

async function applySignalPolicyNow(): Promise<void> {
  const settings = await getSettings();

  // The page property is governed by a content script, and a content script cannot read
  // chrome.storage from the MAIN world. Registering the permission only while sending is
  // enabled is what makes the toggle reach the MAIN world.
  await applySettingsScripts(settings);

  if (settings.sendSignal) {
    await enableGpcHeader();
    const verified = await verifyGpcRuleInstalled();
    const { allSites } = await signalReach();
    // The default icon, for tabs that have not reported: what we are doing ourselves.
    // A tab's own report replaces it the moment the page says what it sees. With site access
    // limited, a tab that never reports is one the browser withholds from us, where no rule
    // applied and no script ran: gray, titled with the reason.
    await applyActionIcon(verified.ok && allSites ? "on" : "off");
    if (verified.ok && !allSites) {
      await chrome.action.setTitle({ title: chrome.i18n.getMessage("actionTitleSiteAccessLimited") });
    }
    if (!verified.ok) {
      // PRD §8: fail loudly. Never present observations as signal-on when the rule was
      // rejected by the browser.
      // The reason is for someone debugging, not for a hover title.
      console.warn(`GPC Inspector: the GPC header rule was not installed (${verified.reason})`);
      await chrome.action.setBadgeText({ text: "!" });
      await chrome.action.setTitle({ title: chrome.i18n.getMessage("actionTitleRuleFailed") });
    }
  } else {
    await disableGpcHeader();
    await applyActionIcon("off");
  }
}

/**
 * Where the signal can reach, by the reader's settings in the browser rather than ours.
 *
 *   - `allSites`: whether the browser grants the host access the manifest asks for. Site
 *     access "On click" or "On specific sites" withholds it, and on a withheld site the
 *     browser applies no header rule and runs no content script, static or registered.
 *     The rule itself stays installed, so verifyGpcRuleInstalled cannot tell.
 *   - `incognito`: whether the extension runs in private windows. It does not until the
 *     reader allows it there, and nothing is sent in those windows meanwhile.
 *
 * A browser that cannot answer is taken to grant both, as before these were asked.
 */
async function signalReach(): Promise<{ allSites: boolean; incognito: boolean }> {
  const allSites = await chrome.permissions.contains({ origins: ["<all_urls>"] }).catch(() => true);
  const incognito = await chrome.extension.isAllowedIncognitoAccess().catch(() => true);
  return { allSites, incognito };
}

// ---------------------------------------------------------------------------
// Toolbar icon.
// ---------------------------------------------------------------------------

/**
 * One PNG set per state; Chrome picks the nearest size. Rendered by scripts/icons.mjs
 * and committed — see that file for what the two states mean.
 */
const ICON_PATHS: Record<SignalIconState, Record<string, string>> = {
  on: { 16: "icons/gpc-on-16.png", 32: "icons/gpc-on-32.png", 48: "icons/gpc-on-48.png", 128: "icons/gpc-on-128.png" },
  off: { 16: "icons/gpc-off-16.png", 32: "icons/gpc-off-32.png", 48: "icons/gpc-off-48.png", 128: "icons/gpc-off-128.png" },
};

/** Set the icon and its hover title, for one tab or (no tabId) as the default. */
async function applyActionIcon(state: SignalIconState, tabId?: number): Promise<void> {
  const target = tabId === undefined ? {} : { tabId };
  await chrome.action.setIcon({ ...target, path: ICON_PATHS[state] });
  await chrome.action.setTitle({ ...target, title: chrome.i18n.getMessage(actionTitleKey(state, tabId !== undefined)) });
}

/**
 * Re-derive one tab's icon from what its page reported. Called when a signal-state
 * report lands and again from the badge pass, which follows the top document's request.
 * A tab with no site keeps the default: nothing was observed there, so nothing is claimed.
 */
async function refreshIcon(tabId: number): Promise<void> {
  const s = await getTabState(tabId);
  if (s.topSite === "") return;
  const state = iconStateFor({ propertyValue: s.propertyValue, documentSigned: s.documentSigned });
  await applyActionIcon(state, tabId);
}

/**
 * Tabs whose site is already on its way into state: a top-level navigation this worker saw
 * queued it, or a lookup of the tab is in flight or found it.
 *
 * A queued write is not visible to getTabState until it applies, so without this every
 * request in that window would ask the tab again. During a navigation the tab still reports
 * the page being left, and each of those lookups would start a check of that page's file.
 */
const topSiteSources = new Map<number, Promise<void>>();

/** The tab's site is supplied by a navigation this worker saw: no lookup needed. */
function noteTopSiteFromNavigation(tabId: number): void {
  topSiteSources.set(tabId, Promise.resolve());
}

/**
 * Ensure a tab's topSite is known, querying the tab when it isn't.
 *
 * At most one lookup per tab: calls while one is in flight share it, and one that found the
 * site stands until the tab navigates or closes. A lookup that found nothing is forgotten,
 * so a later call asks again.
 */
function ensureTopSite(tabId: number): Promise<void> {
  const known = topSiteSources.get(tabId);
  if (known !== undefined) return known;
  const lookup: Promise<void> = lookUpTopSite(tabId).then((found) => {
    if (!found && topSiteSources.get(tabId) === lookup) topSiteSources.delete(tabId);
  });
  topSiteSources.set(tabId, lookup);
  return lookup;
}

/**
 * Fill in a tab's topSite from the tab itself, when state has none. True when the tab has
 * a site afterwards.
 *
 * Failures are swallowed: a tab that has closed, or one we cannot read, leaves topSite
 * empty, and an empty topSite is surfaced honestly rather than guessed at.
 */
async function lookUpTopSite(tabId: number): Promise<boolean> {
  const state = await getTabState(tabId);
  if (state.topSite !== "") return true;
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url ?? "";
    if (!isTrackableTopLevel(url)) return false;
    await updateTabState(tabId, (s) => {
      if (s.topSite === "") {
        s.topSite = hostOf(url);
        s.finalUrl = url;
      }
    });
    // The commit listener never ran for this tab, so neither did the published-file check,
    // and no load of this page will be seen either: the tab says whether it has loaded.
    void checkWellKnown(tabId, url, async () => tab.status === "complete");
    return true;
  } catch {
    // Tab gone or unreadable. Leave topSite empty; never invent one.
    return false;
  }
}

/** Tabs whose published-file check is in flight, so a popup refreshing twice fetches once. */
const wellKnownInFlight = new Set<number>();

/**
 * Start the published-file check for a tab it never ran on.
 *
 * The check runs at commit, and a tab that was open before the worker started (or whose
 * worker was restarted mid-session) never commits under this worker, and without this its
 * row would wait forever for a file nobody looked for. The popup asking for observations is
 * the moment that matters, so the check starts there and the popup's next refresh picks up
 * the answer. checkWellKnown consults the setting and the per-origin cache itself; this
 * only decides whether to call it.
 *
 * A row that got no answer is looked at again too: the answer another tab's retry cached
 * meanwhile replaces it, without a request. While the cached failure is fresh the check
 * finds that and sends nothing either; once it has aged out, the check reads the site, as
 * the next page of it would.
 */
async function ensureWellKnown(tabId: number): Promise<void> {
  if (wellKnownInFlight.has(tabId)) return;
  const state = await getTabState(tabId);
  if ((state.wellKnown !== null && !gotNoAnswer(state.wellKnown)) || state.finalUrl === "") return;
  wellKnownInFlight.add(tabId);
  try {
    await checkWellKnown(tabId, state.finalUrl, () => tabHasLoaded(tabId));
  } finally {
    wellKnownInFlight.delete(tabId);
  }
}

/** Whether a tab's page has finished loading, by the tab itself. A tab gone is not loaded. */
async function tabHasLoaded(tabId: number): Promise<boolean> {
  try {
    return (await chrome.tabs.get(tabId)).status === "complete";
  } catch {
    return false;
  }
}

/** The id the settings scripts are registered under, and the ids they had before 1.0.0. */
const SETTINGS_SCRIPTS_ID = "gpc-settings";
const LEGACY_SCRIPT_IDS = ["gpc-assert", "gpc-insertion", "gpc-trace-all"];

/**
 * The MAIN-world scripts a setting turns on, in the order they run, and the seal last.
 *
 * `main-world.js` always runs and does the observing: wrapping whatever owns the property
 * so reads can be counted, and instrumenting the consent APIs. A MAIN-world content script
 * has no access to chrome.storage and no way to be told a setting at document_start, and the
 * property has to exist before the page's first script runs, which rules out anything
 * asynchronous. So each setting that reaches the MAIN world is a script registered only while
 * it is on, and that script joins main-world.js (content/channel.ts):
 *
 *   - `main-world-assert.js` while sending is on: permission to assert. With it absent the
 *     observer still runs and still reports honestly: the property reads `false`, meaning
 *     supported-but-off rather than unsupported (FR-4).
 *   - `main-world-lock.js` while sending AND "Lock the GPC page property" are on: after the
 *     permission, it has main-world.js take the property back from another extension and
 *     make it non-configurable (lockSignal in signal/assert.ts).
 *   - `main-world-trace-all.js` while "Limit GPC read tracing" is OFF: it lifts the cap.
 *   - `main-world-no-confirmation.js` while "Check page for messaging that the GPC or
 *     Opt-Out signal was honored" is OFF: the confirmation scan never reads the page.
 *   - `main-world-insertion.js` while "observe how scripts are loaded" is on: the
 *     provenance observer. Off means the prototypes are never touched, not merely that
 *     nothing is recorded.
 *
 * One registration, so they run in this order, and `main-world-seal.js` after them closes
 * main-world.js's joins: a slot whose setting is off cannot be claimed by the page.
 */
function settingsScripts(
  settings: Pick<Settings, "sendSignal" | "lockSignal" | "capReadTraces" | "observeScriptLoading" | "checkConfirmation">,
): string[] {
  return [
    ...(settings.sendSignal ? ["main-world-assert.js"] : []),
    ...(settings.sendSignal && settings.lockSignal ? ["main-world-lock.js"] : []),
    ...(settings.capReadTraces ? [] : ["main-world-trace-all.js"]),
    ...(settings.checkConfirmation ? [] : ["main-world-no-confirmation.js"]),
    ...(settings.observeScriptLoading ? ["main-world-insertion.js"] : []),
    "main-world-seal.js",
  ];
}

/**
 * Register the settings scripts for these settings, replacing a registration of other
 * scripts. Registration can fail on a browser that restricts it: the observer still runs,
 * and the popup reports the source it actually finds rather than the one we intended, and
 * shows no provenance rather than a wrong one, since the capability is never reported.
 *
 * A changed list is swapped in place (updateContentScripts), never unregistered and then
 * registered: a page that started between the two would run with no assert script and no
 * seal. The legacy ids go after the new registration, for the same reason.
 */
async function applySettingsScripts(settings: Settings): Promise<void> {
  const js = settingsScripts(settings);
  const registration: chrome.scripting.RegisteredContentScript = {
    id: SETTINGS_SCRIPTS_ID,
    js,
    matches: ["<all_urls>"],
    runAt: "document_start",
    world: "MAIN",
    allFrames: true,
    // Frames that inherit the page's origin (about:blank, srcdoc, blob:) have no URL the
    // pattern matches; the property must exist there too. Accepted from Chrome 119, the
    // manifest's minimum.
    matchOriginAsFallback: true,
  };
  let legacy: string[] = [];
  try {
    const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [SETTINGS_SCRIPTS_ID, ...LEGACY_SCRIPT_IDS] });
    legacy = registered.filter((r) => LEGACY_SCRIPT_IDS.includes(r.id)).map((r) => r.id);
    const current = registered.find((r) => r.id === SETTINGS_SCRIPTS_ID);
    if (current === undefined) {
      await chrome.scripting.registerContentScripts([registration]);
    } else if (JSON.stringify(current.js ?? []) !== JSON.stringify(js) || current.matchOriginAsFallback !== true) {
      // A registration persists across an update, so one an earlier version made without
      // the fallback is extended here, in place like a changed list.
      try {
        await chrome.scripting.updateContentScripts([{ id: SETTINGS_SCRIPTS_ID, js, matchOriginAsFallback: true }]);
      } catch {
        // A stale list must not stay registered (the assert script with sending off), so
        // where the swap fails the old registration goes, and the new one is registered.
        await chrome.scripting.unregisterContentScripts({ ids: [SETTINGS_SCRIPTS_ID] });
        await chrome.scripting.registerContentScripts([registration]);
      }
    }
  } catch {
    // See above: the page keeps the defaults main-world.js starts with.
  }
  try {
    if (legacy.length > 0) await chrome.scripting.unregisterContentScripts({ ids: legacy });
  } catch {
    // Nothing more to do: the next run finds them again.
  }
}

/** Assemble the schema-shaped ObservationSet for a tab. */
async function buildObservationSet(tabId: number): Promise<ObservationSet> {
  const s = await getTabState(tabId);
  const settings = await getSettings();

  // From the tallies, which survive a worker reclaim; the request list does not. The
  // tallies count HTTP requests only, not the synthetic observations of script-written
  // cookies, which is what "sent on N requests" means. The worker tallies every request it
  // keeps but one kind: a response whose request was lost to a restart (1.26.0) is listed
  // and was counted by the worker that saw it go out, so the list can hold more than this.
  const signed = s.tallies.signedRequests;
  const total = s.tallies.totalRequests;

  // A container seen on a check's stack demonstrably RAN, which is stronger evidence
  // than a loader tag or a global that it exists, and the only evidence for a container
  // loaded in a way the loader scan misses. Unioned into the reported ids here so the
  // popup's container list and the per-container check counts agree.
  const gtm = withFrameSeenContainers({ ...s.gtm, scriptFetched: s.googleTagFetched }, [
    ...s.consentApiCalls.flatMap((c) => c.containerUrls ?? []),
    ...Object.keys(s.readAttribution.viaTagManagerByContainer ?? {}),
  ]);
  // A page with no Google tag has no Consent Mode to observe, and one whose consent store was
  // read had it observed, so a dataLayer nobody watched there is nothing rather than a
  // capture gap (schema CaptureCapabilities.dataLayer, 1.31.0). The popup applies the same
  // test through the same function, so the bundle and the panel agree about the page. Without
  // it the bundle would list the capability as failed where the popup, correctly, says
  // nothing: on 20 of the 60 corpus sites.
  const capabilities =
    s.capabilities.dataLayer || consentModeNeedsDataLayer(gtm) ? s.capabilities : { ...s.capabilities, dataLayer: true };

  // A cookie whose key still waits for its first jar check is in no part of what a reader
  // is given: not in a count or a summary, and not on its request. It is all there once the
  // check answers, or nowhere if the browser did not store it, so no number shown has to be
  // taken back.
  const waiting = s.cookieLedger.pending ?? [];
  const network = waiting.length === 0 ? s.network : withoutWaiting(s.network, new Set(waiting));

  return {
    schemaVersion: SCHEMA_VERSION,
    context: {
      finalUrl: s.finalUrl,
      topSite: s.topSite,
      extensionVersion: chrome.runtime.getManifest().version,
      browserUserAgent: navigator.userAgent,
      os: navigator.platform,
      capturedAt: new Date().toISOString(),
      mode: settings.observePassively ? "passive" : "on-open",
      incomplete: s.incomplete,
      incompleteReasons: s.incompleteReasons,
      loadObserved: s.loadObserved,
      ...(s.restoredFromCache === true ? { restoredFromCache: true } : {}),
      ...(s.scanId === undefined ? {} : { scanId: s.scanId }),
      loadError: s.loadError ?? null,
    },
    signal: {
      secGpcRequestCount: signed,
      totalRequestCount: total,
      source: s.signalSource,
      propertyValue: s.propertyValue,
      readTracking: s.readTracking,
      readCount: s.readTracking === "active" ? s.signalReads : null,
      // Both gated on read tracking for the same reason the count is: with no counting
      // accessor installed there were no reads to attribute, and reporting an empty map as
      // though we had looked would state an absence we could not observe.
      readsByScript: s.readTracking === "active" ? s.readsByScript : {},
      readAttribution: s.readTracking === "active" ? s.readAttribution : null,
    },
    network,
    // The kept records of cookie-setting requests the list no longer holds (1.27.0): what the
    // Requests tab lists after a reclaim. The others repeat an observation in `network`, and
    // at the cap would send about 1.3 MB more on every popup and panel refresh.
    keptCookieResponses: lostKeptRecords({ network: s.network, keptCookieResponses: s.keptCookies }),
    ...(s.keptCookiesIncomplete === true ? { keptCookieResponsesIncomplete: true as const } : {}),
    consentApiCalls: s.consentApiCalls,
    gpp: s.gpp,
    usPrivacy: s.usPrivacy,
    tcf: s.tcf,
    gtm,
    confirmationNotice: s.confirmationNotice,
    ...(s.confirmationNotice === "detected" && s.confirmationText ? { confirmationText: s.confirmationText } : {}),
    capabilities,
    // Present only once the observer has reported (the setting is on and the script ran);
    // a set with neither field is exactly what an older bundle looks like.
    ...(s.capabilities.scriptInsertion !== undefined
      ? { scriptInsertions: s.scriptInsertions, scriptInsertionCoverage: s.scriptInsertionCoverage }
      : {}),
    ...(s.capabilities.requestInitiation !== undefined
      ? { requestInitiators: s.requestInitiators, requestInitiatorCoverage: s.requestInitiatorCoverage }
      : {}),
    // Absent until the top frame reports, which is what an older bundle looks like too.
    ...(s.cookieCoverage !== null ? { cookieCoverage: s.cookieCoverage } : {}),
    wellKnown: s.wellKnown,
    // The list the tallies were charged by (1.25.0).
    ownerList: getOwnerCookies().provenance,
    tallies: talliesWithout(s.tallies, waiting),
  };
}

/**
 * The request list without the set records of keys that wait for their first jar check. A
 * record the jar has answered for keeps its place, as a removal does: only a write nothing
 * is known of yet is left out. A script write is the observation of its one cookie and is
 * left out with it; a request stays, with the cookies that are known.
 */
function withoutWaiting(network: readonly NetworkObservation[], waiting: ReadonlySet<string>): NetworkObservation[] {
  const out: NetworkObservation[] = [];
  for (const o of network) {
    if (o.setCookies.length === 0) {
      out.push(o);
      continue;
    }
    const known = o.setCookies.filter((c) => c.jar !== undefined || isCookieDeletion(c, o.timeMs) || !waiting.has(cookieKey(c)));
    if (known.length === o.setCookies.length) out.push(o);
    else if (known.length > 0 || o.method !== "SCRIPT") out.push({ ...o, setCookies: known });
  }
  return out;
}

/** Classification in the shape the tally needs. */
function tallyClassifier(topSite: string): (url: string) => TallyClassification {
  const classifier = getClassifier();
  return (url: string) => {
    const c = classifier.classify(url, topSite);
    return { party: c.party, category: c.category, entityName: c.entity?.name ?? null, domain: c.registrableDomain };
  };
}

/**
 * Count a request as it arrives.
 *
 * Separated from cookie counting because a request is observed once, on onSendHeaders,
 * while its cookies arrive later on the response. Counting both in one place would either
 * miss the cookies or double-count the request.
 */
function countRequest(s: TabState, obs: NetworkObservation): void {
  tallyRequest(mutableTallies(s), obs, tallyClassifier(s.topSite));
}

/** Whether a cookie key is in one of the counts. */
function isCountedKey(t: MutableTallies, key: string): boolean {
  return t.adCookieKeys.has(key) || t.adCookieKeysUnsigned.has(key) || t.firstPartyVendorCookieKeys.has(key);
}

/**
 * Whom each of an observation's cookies is charged to (1.25.0): the engine's one rule, with
 * the observation's URL, which for a script-written cookie is its writer's.
 */
function chargesFor(s: TabState, obs: NetworkObservation): ChargeOf {
  const classifier = getClassifier();
  const owners = getOwnerNames();
  return (cookie) => cookieCharge(cookie, obs.url, s.topSite, classifier, owners);
}

/** A charge as the tally's classification of a company; null for a container's, which names none. */
function chargedCompany(charge: CookieCharge): TallyClassification | null {
  if (charge.kind === "container") return null;
  return { party: charge.party, category: charge.category, entityName: charge.entity?.name ?? null };
}

/** A refused write, noted where its charge says: the company, and the container it ran in. */
function noteRefusedWrite(t: MutableTallies, charge: CookieCharge, entry: string): void {
  const company = chargedCompany(charge);
  if (company !== null && company.entityName !== null) {
    noteForVendor(t.refusedCookieWrites, company.entityName, entry);
    noteForPair(t, company, "refusedWrites", entry);
  }
  if (charge.kind !== "host") noteForContainer(t, charge.container, "refusedWrites", entry);
  noteForUnlisted(t, charge, "refusedWrites", entry);
}

/**
 * What the page says of a script write beyond its record (js-cookies.ts): whether it is a
 * write test, and for a removal whether the cookie was in the document when it was made.
 */
interface ScriptWrite {
  readonly writeTest: boolean;
  readonly present: boolean | undefined;
}

/**
 * Fold an observation's cookies into the tallies once, when it arrives. `writerHost`, for a
 * script write, is the host of the frame that wrote it: a host-only cookie is recorded with
 * no domain, and the jar check looks it up under that host.
 *
 * A set is tallied at once. Where the jar is asked about its key and no reader has been
 * shown the key yet, the key is held back from every reader until the answer (the ledger's
 * `pending`), so a cookie the browser did not store is never shown and a count only rises.
 *
 * A removal is not a set, and it takes nothing out of a count. Where the cookie was in the
 * browser when it was removed, the jar is asked about it, and its key is marked removed,
 * staying where it was, when the jar no longer holds it. A write test is noted and adds no
 * key: the page left out the write it removed.
 */
function countCookies(
  s: TabState,
  obs: NetworkObservation,
  chargeOf: ChargeOf = chargesFor(s, obs),
  writerHost?: string,
  script?: ScriptWrite,
): void {
  if (obs.setCookies.length === 0) return;
  const t = mutableTallies(s);
  const ledger = s.cookieLedger;
  const classify = tallyClassifier(s.topSite);

  const page = { topSite: s.topSite, scheme: s.finalUrl.startsWith("http:") ? "http" : "https" };
  const sets: CookieRecord[] = [];
  for (const cookie of obs.setCookies) {
    if (!isCookieDeletion(cookie, obs.timeMs)) {
      sets.push(cookie);
      continue;
    }
    const key = cookieKey(cookie);
    if (script?.writeTest === true) {
      if (!ledger.probes.includes(key)) ledger.probes.push(key);
      noteWriteTest(t, obs, cookie, chargeOf(cookie), classify);
    }
    // Whether the cookie was in the browser when this removed it. A script's removal says:
    // the page read the document's cookies first, and a write test had written it itself. A
    // response's does where its own request carried the cookie. With neither, the removal
    // may have found nothing, and it changes nothing here.
    const found = script !== undefined ? script.writeTest || script.present === true : obs.cookiesSent.includes(cookie.name);
    if (!found) continue;
    if (markRemoved(ledger, key, obs.timeMs) === null) continue;
    // It was in the browser, which is what its jar check was to find out, and the jar can no
    // longer say: the key is shown from here.
    release(ledger, key);
    // Said to be removed once the jar no longer holds it (applyJarAnswers). A removal with
    // no host to look it up under is never said.
    const domain = cookie.domain === "" ? writerHost : cookie.domain;
    if (domain === undefined || domain === "") continue;
    jarChecks.add(s.tabId, page, key, obs.id, { name: cookie.name, domain, value: cookie.value, partitioned: cookie.partitioned }, true);
  }
  if (sets.length === 0) return;

  // The keys a reader has already been shown: in the tallies, and not waiting.
  const shown = new Set(
    sets.map(cookieKey).filter((key) => !isPending(ledger, key) && (isCountedKey(t, key) || isRecordedKey(t, key))),
  );
  tallyCookies(t, sets.length === obs.setCookies.length ? obs : { ...obs, setCookies: sets }, classify, classify, chargeOf);
  const landed = new Set(ledger.landed ?? []);
  for (const cookie of sets) {
    const key = cookieKey(cookie);
    // Only a key the tallies hold is remembered and checked: counted, or recorded by a
    // summary (a category that does not count, a container, an unlisted domain, the first
    // party).
    if (!isCountedKey(t, key) && !isRecordedKey(t, key)) continue;
    markCounted(ledger, key, obs.timeMs);
    // And checked against the cookie jar, until the jar is found to hold it (1.30.0). A
    // host-only write with no host to look it up under is left unchecked, and counts.
    if (landed.has(key)) continue;
    const domain = cookie.domain === "" ? writerHost : cookie.domain;
    if (domain === undefined || domain === "") continue;
    jarChecks.add(s.tabId, page, key, obs.id, { name: cookie.name, domain, value: cookie.value, partitioned: cookie.partitioned });
    // Held back until that check answers, unless a reader has seen the key already: a key
    // in a count is never taken back out of it.
    if (!shown.has(key)) hold(ledger, key);
  }
}

/** Per request list, how many script writes have taken each base id. A new page's list starts over. */
const scriptWriteIds = new WeakMap<NetworkObservation[], Map<string, number>>();

/**
 * A script write's id: `base` the first time the list sees it, then `base#1`, `base#2`.
 * Counted, not looked up: a scan of the list for each write costs the whole list, which
 * has no cap, per write.
 */
function scriptWriteId(network: NetworkObservation[], base: string): string {
  let uses = scriptWriteIds.get(network);
  if (uses === undefined) {
    uses = new Map();
    scriptWriteIds.set(network, uses);
  }
  const n = uses.get(base) ?? 0;
  uses.set(base, n + 1);
  return n === 0 ? base : `${base}#${n}`;
}

/**
 * The cookie jar's answers for a tab (1.30.0). Each record checked is marked with what the
 * jar held, and the key's first answer decides whether it is shown at all.
 *
 * Held and found: the key is shown from here. Held and not there: it comes out of every
 * count and summary without ever having been shown, and is listed as a write the jar did
 * not hold; its records stay on their requests, marked, for the Requests tab. A key a reader
 * has already been shown stays in the count whatever a later write's check says, so a count
 * never falls. A key whose check could not be made is shown unchecked: the jar was not
 * asked, so nothing says the browser kept nothing.
 *
 * A removal's answer marks nothing on a record. The key is said to be removed when the jar
 * no longer holds the cookie, and is as it was before the removal when it still does.
 */
function applyJarAnswers(s: TabState, answers: readonly JarAnswer[], unchecked: readonly string[]): void {
  const ledger = s.cookieLedger;
  const landed = new Set(ledger.landed ?? []);
  // Where each observation is, found once for the batch rather than by a scan per answer.
  const at = new Map(s.network.map((o, i) => [o.id, i]));
  for (const a of answers) {
    if (a.removal) {
      const afterMs = settleRemoval(ledger, a.key, a.state !== "not-stored");
      if (afterMs !== null) noteRemovedAfter(mutableTallies(s), a.key, afterMs);
      continue;
    }
    // Removed while it was in the browser, after the writes this check covers: the jar holds
    // nothing because of the removal, which is on record, and not because the browser kept
    // nothing.
    if (a.state === "not-stored" && ledger.removedAt?.[a.key] !== undefined) continue;
    // Each record takes its own domain's answer: a write refused in one frame is marked not
    // stored though the key landed under another host, and counts by the key's answer below.
    let made: NetworkObservation | null = null;
    for (const m of a.marks) made = markJar(s, at, a.key, m.observationIds, m.state) ?? made;
    // None of the records is on the list: the page changed since the check was queued, and
    // the answer is the last page's.
    if (made === null) continue;
    if (a.state === "landed") {
      landed.add(a.key);
      release(ledger, a.key);
    } else if (a.state === "unknown") {
      release(ledger, a.key);
    } else if (isPending(ledger, a.key) && jarChecks.isLatest(s.tabId, a)) {
      const t = mutableTallies(s);
      untallyCookie(t, a.key, a.name);
      delete ledger.setAt[a.key];
      release(ledger, a.key);
      // Listed where a refused script write is, "Not in the browser's cookie jar", against whoever
      // the count charged it to.
      const cookie = made.setCookies.find((c) => cookieKey(c) === a.key);
      if (cookie !== undefined) noteRefusedWrite(t, chargesFor(s, made)(cookie), cookie.domain === "" ? cookie.name : `${cookie.name} (${cookie.domain})`);
    }
  }
  for (const key of unchecked) release(ledger, key);
  if (landed.size > 0) ledger.landed = [...landed];
}

/**
 * Mark a key's records on these observations with the jar's answer. Returns the first
 * observation marked, or null when none was found.
 *
 * A kept record follows its observation (followKept) when the answer is not-stored: kept
 * before the answer came, it would otherwise list a cookie the jar did not hold as counted
 * after a reclaim. A landed or unknown answer changes nothing a kept record is read for, and
 * following it would write nearly every kept chunk a second time, a second after the first.
 */
function markJar(s: TabState, at: ReadonlyMap<string, number>, key: string, ids: readonly string[], state: JarState): NetworkObservation | null {
  const network = s.network;
  let first: NetworkObservation | null = null;
  for (const id of ids) {
    const i = at.get(id);
    const o = i === undefined ? undefined : network[i];
    if (i === undefined || o === undefined) continue;
    const marked = o.setCookies.map((c) => (cookieKey(c) === key && !isCookieDeletion(c, o.timeMs) ? { ...c, jar: state } : c));
    if (!marked.some((c, n) => c !== o.setCookies[n])) continue;
    const replaced = { ...o, setCookies: marked };
    network[i] = replaced;
    if (state === "not-stored") followKept(s, replaced);
    first ??= replaced;
  }
  return first;
}

/**
 * Read the site's published GPC resource, once per origin.
 *
 * Runs on top-level navigation only. A cached observation is reused when it is under a day
 * old (ten minutes for a failed read), and counts as fresh only when it is under
 * CURRENT_READ_MS old (well-known.ts), which is what stops a possibly-retracted declaration
 * from supporting an accusation without making the finding unreachable after a site's
 * first page.
 */
async function checkWellKnown(
  tabId: number,
  url: string,
  pageLoaded: () => Promise<boolean> = async () => false,
): Promise<void> {
  const settings = await getSettings();
  if (!settings.checkWellKnown) return;

  const origin = originOf(url);
  if (origin === null) return;

  // Only onto a page of the origin it was read for. The tab can navigate while the read is
  // in flight, and the answer would then reach the next page: a slow fetch for a site whose
  // file says `gpc: true`, landing after the next site's own check, would rest that site's
  // declared-honor finding on another site's file.
  const sameOrigin = (s: TabState): boolean => originOf(s.finalUrl) === origin;

  const { reading, fetched } = await readWellKnown(origin);
  let onOrigin = false;
  await updateTabState(tabId, (s) => {
    if (!sameOrigin(s)) return;
    s.wellKnown = reading;
    onOrigin = true;
  });
  if (fetched) scheduleBadge(tabId);
  // A read this navigation fetched that got no answer is tried once more after the load. One
  // served from the cache never is.
  if (!fetched || !gotNoAnswer(reading)) return;
  // The write above is queued: settled, so that whether the tab is still on this origin is
  // known. A slow read for the page before, landing after the next page's own read got no
  // answer, would replace that page's retry with one for a page the tab has left.
  await settleTab(tabId);
  if (!onOrigin) return;
  // Where this worker saw no load of the page (a check started from a request or the popup),
  // onCompleted will not come: the tab says whether the page has loaded, and the retry runs now.
  const now = wellKnownRetries.noAnswer(tabId, origin) || ((await pageLoaded()) && wellKnownRetries.loaded(tabId, origin));
  if (now) await retryWellKnown(tabId, origin);
}

/**
 * The one retry of a read that got no answer. An answer replaces the cached failure and the
 * tab's row; another failure leaves both as they were (retryReading).
 */
async function retryWellKnown(tabId: number, origin: string): Promise<void> {
  const settings = await getSettings();
  if (!settings.checkWellKnown) return;
  const reading = await retryReading(origin, {
    read: () => fetchWellKnownOnce(origin),
    getCached: getCachedWellKnown,
    putCached: putCachedWellKnown,
  });
  if (reading === null) return;
  await updateTabState(tabId, (s) => {
    if (originOf(s.finalUrl) === origin) s.wellKnown = reading;
  });
  scheduleBadge(tabId);
}

/** Reads of an origin's published file in progress, so checks that overlap share one. */
const wellKnownReads = new Map<string, Promise<{ reading: WellKnownGpc; fetched: boolean }>>();

/**
 * An origin's published file, from the cache when it is fresh and from the site otherwise.
 *
 * One read per origin at a time. Several checks for the same origin can start together (a
 * tab's first requests, the commit, the popup, other tabs on the site), and each would find
 * the cache empty and send its own request. The cache lookup is inside the shared read, and
 * the entry is dropped only after the result is cached, so a check that starts later finds
 * one or the other.
 */
function readWellKnown(origin: string): Promise<{ reading: WellKnownGpc; fetched: boolean }> {
  return shareInFlight(wellKnownReads, origin, async () => {
    const cached = await getCachedWellKnown(origin);
    const now = Date.now();
    if (cached !== null && isFresh(cached, now)) return { reading: asCached(cached, now), fetched: false };
    const observed = await fetchWellKnownOnce(origin);
    // A request that failed, or a server error, says nothing about the file, and is cached
    // for minutes rather than a day (isFresh): uncached, a failing site would be fetched on
    // every navigation.
    await putCachedWellKnown(origin, observed);
    return { reading: observed, fetched: true };
  });
}

/** Requests for an origin's file in progress, so a retry that overlaps another shares one. */
const wellKnownFetches = new Map<string, Promise<WellKnownGpc>>();

/** One request for an origin's file at a time: tabs that shared a failed read retry with one request. */
function fetchWellKnownOnce(origin: string): Promise<WellKnownGpc> {
  return shareInFlight(wellKnownFetches, origin, () => fetchWellKnown(origin, undefined, watchRedirectWithWebRequest));
}

/** Run `start` once per key at a time: a call while one is in flight gets that one's result. */
function shareInFlight<T>(inFlight: Map<string, Promise<T>>, key: string, start: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key);
  if (running !== undefined) return running;
  const run = start().finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

/**
 * FR-22, D11: the badge shows the count of advertising cookies set on requests that
 * carried the signal. With sending off it shows the unsigned count instead, so the two
 * numbers a reader is comparing are both on the toolbar; the icon is already gray there.
 *
 * The count comes from the ENGINE, not from a second implementation here. The badge and
 * the popup read the same number from the same function, so they cannot disagree — a
 * disagreement between the icon and the panel would undermine the one thing this product
 * sells, which is that its numbers are trustworthy.
 *
 * Color is neutral gray, never red or green (D4). The badge reports a count, not a
 * verdict; a color would smuggle a judgment into a fact.
 */
async function computeBadge(tabId: number): Promise<void> {
  // Flush pending writes before reading. updateTabState serializes through a promise
  // chain, so a read taken mid-chain sees a partial snapshot. The popup settles before it
  // reads, and so does the badge: they must read the same state or neither can be trusted.
  await settleTab(tabId);

  // The icon rides the same pass: the signed-request count it depends on moves with
  // every request, and this is the one place that already settles and re-reads per tab.
  await refreshIcon(tabId);

  const settings = await getSettings();
  if (!settings.showBadge) {
    await chrome.action.setBadgeText({ tabId, text: "" });
    return;
  }

  const state = await getTabState(tabId);
  // No site means nothing to classify: party determination needs the top document, and
  // an unknown site would make every request look third-party. Show nothing rather than
  // a number derived from a guess.
  if (state.topSite === "") {
    await chrome.action.setBadgeText({ tabId, text: "" });
    return;
  }

  const obs = await buildObservationSet(tabId);
  const count =
    obs.signal.source === "none"
      ? countDistinctCookiesSetWithoutSignal(obs, getClassifier(), getOwnerNames())
      : countDistinctCookiesSetWithSignal(obs, getClassifier(), getOwnerNames());

  // Cap the displayed text: Chrome truncates a badge beyond ~4 characters, and a precise
  // four-digit count is no more informative than "lots" at a glance. The exact figure
  // stays available in the panel.
  const text = count === 0 ? "" : count > 99 ? "99+" : String(count);
  await chrome.action.setBadgeText({ tabId, text });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#6b6a64" });
}

/**
 * Debounced badge refresh.
 *
 * A busy page fires hundreds of response events; recomputing per event would parse the
 * observation set hundreds of times for a number that changes rarely. Coalescing to one
 * update per second keeps the badge current without the cost. State is in a promise map
 * rather than a data cache, so nothing that must survive worker termination lives here
 * (NFR-2).
 */
const badgeTimers = new Map<number, ReturnType<typeof setTimeout>>();

function scheduleBadge(tabId: number): void {
  if (badgeTimers.has(tabId)) return;
  const timer = setTimeout(() => {
    badgeTimers.delete(tabId);
    void computeBadge(tabId).catch(() => {
      // A closed tab or a revoked permission is not a finding; leave the badge alone.
    });
  }, 1000);
  badgeTimers.set(tabId, timer);
}

export { computeBadge };

export { buildObservationSet, applySignalPolicy };

// ---------------------------------------------------------------------------
// Debug hooks.
//
// chrome.runtime.sendMessage dispatched FROM the service worker does not reach the
// service worker's own onMessage listener — Chrome routes it to other extension
// contexts. So the message handler above, while correct for the popup, is not callable
// from the worker's own devtools console. These globals are how a developer inspects a
// live capture. They read state; they never mutate it.
// ---------------------------------------------------------------------------

interface GpcDebugGlobals {
  gpcDump?: (tabId?: number) => Promise<ObservationSet>;
  gpcTabs?: () => Promise<number[]>;
  gpcSettings?: () => Promise<unknown>;
  gpcState?: (tabId?: number) => Promise<unknown>;
  gpcFindings?: (tabId?: number) => Promise<unknown>;
  gpcDebug?: () => Promise<unknown>;
}

const dbg = globalThis as unknown as GpcDebugGlobals;

dbg.gpcTabs = async () => {
  const all = await chrome.storage.session.get(null);
  const rows = Object.entries(all)
    .filter(([k]) => k.startsWith("tab:"))
    .map(([k, v]) => {
      const st = parseStoredState(v) as TabState;
      return {
        tabId: Number(k.slice(4)),
        site: st.topSite || "(unknown)",
        requests: st.network.length,
      };
    })
    .sort((a, b) => b.requests - a.requests);
  console.table(rows);
  return rows.map((r) => r.tabId);
};

dbg.gpcDump = async (tabId?: number) => {
  let id = tabId;

  if (id === undefined) {
    // NOTE: `currentWindow: true` returns nothing here — a service worker has no
    // associated window, so there is no "current" one. Query the last focused window
    // instead, and fall back to whichever tab we actually have state for.
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    id = active?.id;
  }

  if (id === undefined) {
    const tracked = (await dbg.gpcTabs?.()) ?? [];
    id = tracked[0];
  }

  if (id === undefined) {
    throw new Error(
      "no captured tab found. Load a page first, then gpcDump(), or pass an id from gpcTabs().",
    );
  }

  await settleTab(id);
  return buildObservationSet(id);
};

dbg.gpcSettings = async () => getSettings();

/**
 * One snapshot of everything worth knowing, for a bug report or a console paste.
 *
 * It answers what a one-off console expression cannot. In particular: opening the service
 * worker console STARTS the worker if it was asleep, so an empty in-memory request list
 * looks identical whether nothing was captured or the worker was replaced a moment ago.
 * `workerAgeMs` distinguishes them: a worker seconds old with populated tallies means the
 * list was lost to a restart, not never gathered.
 */
dbg.gpcDebug = async () => {
  const settings = await getSettings();
  const rules = await chrome.declarativeNetRequest.getDynamicRules().catch(() => []);
  const scripts = await chrome.scripting
    .getRegisteredContentScripts()
    .catch(() => [] as chrome.scripting.RegisteredContentScript[]);
  const all = await chrome.storage.session.get(null).catch(() => ({}));

  const tabs = Object.entries(all)
    .filter(([k]) => k.startsWith("tab:"))
    .map(([k, v]) => {
      const st = parseStoredState(v) as TabState;
      return {
        tabId: Number(k.slice(4)),
        site: st.topSite || "(unknown)",
        // Retained list versus complete counts. The gap between these two numbers IS the
        // in-memory model working as designed, not a fault.
        retainedRequests: st.network.length,
        countedRequests: st.tallies.totalRequests,
        adVendorRequests: st.tallies.adVendorRequests,
        // As a reader is shown it: without the keys still waiting for their jar check.
        adCookies: talliesWithout(st.tallies, st.cookieLedger?.pending ?? []).adCookieKeys.length,
        vendors: Object.keys(st.tallies.byEntity),
        signalSource: st.signalSource,
        stateMessages: st.stateMessages,
        incomplete: st.incomplete,
        wellKnown: st.wellKnown?.present ? `gpc:${String(st.wellKnown.gpc)}` : "none",
        capabilitiesFailed: Object.entries(st.capabilities)
          .filter(([, ok]) => ok === false)
          .map(([name]) => name),
      };
    })
    .sort((a, b) => b.countedRequests - a.countedRequests);

  return {
    workerStartedAt: new Date(WORKER_STARTED_AT).toISOString(),
    workerAgeMs: Date.now() - WORKER_STARTED_AT,
    extensionVersion: chrome.runtime.getManifest().version,
    settings,
    headerRuleInstalled: rules.some((r) => r.id === 1),
    registeredScripts: scripts.map((sc) => sc.id),
    listProvenance: getClassifier().provenance,
    wellKnownCached: Object.keys(all).filter((k) => k.startsWith("wk:")).length,
    tabs,
  };
};

/**
 * Run the ENGINE over a captured tab and return its findings.
 *
 * This is the first place all four packages meet: capture produced the ObservationSet,
 * lists supplies classification, the engine turns them into findings. If this returns
 * sensible output on a live page, every architectural boundary in the PRD has been
 * exercised in a real browser.
 */
dbg.gpcFindings = async (tabId?: number) => {
  let id = tabId;
  if (id === undefined) {
    const tracked = (await dbg.gpcTabs?.()) ?? [];
    id = tracked[0];
  }
  if (id === undefined) throw new Error("no captured tab found");
  await settleTab(id);
  const obs = await buildObservationSet(id);
  const classifier = getClassifier();
  return {
    site: obs.context.topSite,
    badgeCount: countDistinctCookiesSetWithSignal(obs, classifier, getOwnerNames()),
    cookieSetEvents: countCookiesSetWithSignal(obs, classifier, getOwnerNames()),
    listVersion: classifier.provenance.version,
    findings: evaluate(obs, classifier, getOwnerNames()),
  };
};

/**
 * Raw per-tab capture state, including diagnostics that are deliberately NOT part of the
 * schema (the ObservationSet is a fixed contract; debug counters do not belong in it).
 */
dbg.gpcState = async (tabId?: number) => {
  let id = tabId;
  if (id === undefined) {
    const tracked = (await dbg.gpcTabs?.()) ?? [];
    id = tracked[0];
  }
  if (id === undefined) throw new Error("no captured tab found");
  await settleTab(id);
  const s = await getTabState(id);
  return {
    tabId: s.tabId,
    topSite: s.topSite,
    signalSource: s.signalSource,
    propertyValue: s.propertyValue,
    readTracking: s.readTracking,
    signalReads: s.signalReads,
    readsByScript: s.readsByScript,
    readAttribution: s.readAttribution,
    stateMessages: s.stateMessages,
    confirmationNotice: s.confirmationNotice,
    confirmationEvidence: s.confirmationEvidence,
    confirmationText: s.confirmationText ?? null,
    requests: s.network.length,
    incomplete: s.incomplete,
  };
};
