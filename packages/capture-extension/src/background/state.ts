// SPDX-License-Identifier: GPL-3.0-only
/**
 * Observation state (PRD NFR-2).
 *
 * THE RULE: no in-memory service-worker state, ever. MV3 terminates the worker after
 * ~30 seconds idle, and anything held in a module-level variable is gone without warning.
 *
 * Data held only in a worker's memory vanishes when the worker dies, and a report built on
 * what is left presents that absence to the user as a site *failure*. Hence this project's
 * governing principle: **absence of data is never a finding.**
 *
 * So: everything lands in chrome.storage.session (cleared when the browser closes, which
 * is the right lifetime for per-page observations). Writes are batched to avoid hammering
 * storage on every request, but the batch window is short and every flush is awaited
 * before the worker can be considered idle.
 *
 * The worker also keeps a working copy of each tab's state (see liveByTab). That copy is
 * never the record: it is read from storage the first time a worker instance needs it, and
 * every change to it is written back, so a restarted worker picks up exactly what the store
 * holds.
 */

import { emptyTalliesFrozen, thawTallies, freezeTallies, type MutableTallies } from "./tally.js";
import { TAB_KEY_PREFIX as KEY_PREFIX, tabKey as keyFor } from "./tab-key.js";
import { isTallied } from "@gpc-inspector/schema";
import type {
  NetworkObservation,
  ConsentApiCall,
  GppObservation,
  UsPrivacyObservation,
  TcfObservation,
  GtmObservation,
  ConfirmationNoticeState,
  CaptureCapabilities,
  WellKnownGpc,
  Tallies,
  ScriptInsertion,
  ScriptInsertionCoverage,
  CookieCaptureCoverage,
  IncompleteReason,
  KeptCookieResponse,
} from "@gpc-inspector/schema";
import { internInsertions, expandInsertions, type InternedInsertions } from "./insertions.js";
import { chunkWrites, chunksPresent, keepNew, keptKeys, keptTabOf, readChunks, remakeKept, sourcesOf, type KeptSources } from "./kept-cookies.js";
import type { CookieLedger } from "./cookie-events.js";

/** Per-tab accumulated observations. Keyed by tabId. */
export interface TabState {
  readonly tabId: number;
  /** eTLD+1 of the top document — set on main_frame navigation. */
  topSite: string;
  finalUrl: string;
  /**
   * The retained request list. NOT persisted — see observationsByTab. Present on TabState
   * so callers read and mutate it like any other field.
   */
  network: NetworkObservation[];
  consentApiCalls: ConsentApiCall[];
  gpp: GppObservation | null;
  usPrivacy: UsPrivacyObservation | null;
  tcf: TcfObservation | null;
  gtm: GtmObservation;
  /**
   * Script and iframe insertions (provenance, 1.12.0), plain records in memory. Persisted
   * interned (see insertions.ts) so the repeated loader URLs are stored once.
   */
  scriptInsertions: ScriptInsertion[];
  /** The observer's coverage counters, latest report wins. null until it reports. */
  scriptInsertionCoverage: ScriptInsertionCoverage | null;
  /** Page-initiated requests (provenance), same shape and persistence as insertions. */
  requestInitiators: ScriptInsertion[];
  requestInitiatorCoverage: ScriptInsertionCoverage | null;
  /**
   * What sits in front of the top frame's document.cookie accessor (1.23.0). null until
   * the top frame reports; each flag, once true, stays true for the page.
   */
  cookieCoverage: CookieCaptureCoverage | null;
  confirmationNotice: ConfirmationNoticeState;
  /**
   * The text that triggered a confirmation match, with surrounding context.
   *
   * Kept out of the schema deliberately: the context is whatever text sat around the notice
   * on the page, evidence for tuning rather than something to show or save. The matched
   * words alone are `confirmationText`, which the ObservationSet carries.
   */
  confirmationEvidence: string | null;
  /** The matched words of a confirmation, what the Overview quotes. Optional: older records have none. */
  confirmationText?: string | null;
  /**
   * Which interceptors installed. Defaults to all true: on a page where the content
   * scripts never reported, `incomplete` already covers the gap, and defaulting to false
   * would render every observation as unavailable on ordinary pages.
   */
  capabilities: CaptureCapabilities;
  /** The site's published GPC resource, when checked. null when not checked. */
  wellKnown: WellKnownGpc | null;
  /**
   * Complete counts, accumulated as observations arrive. NOT derived from `network`, which
   * is a retained sample — that is the entire point.
   */
  tallies: Tallies;
  /** Read-counter totals reported by the MAIN-world script. Complete: every read counts. */
  signalReads: number;
  /**
   * Who read the property, over the SAMPLE of reads a stack was captured for.
   *
   * Bounded by the sampler's cap (observe/read-attribution.ts), so this is a few dozen keys
   * on a heavy page rather than one per read — small enough for chrome.storage.session.
   */
  readsByScript: Record<string, number>;
  /** What that sample covered, so an empty readsByScript is never read as an absence. */
  readAttribution: {
    sampled: number;
    unattributed: number;
    viaTagManager: number;
    /** Container reads by container frame URL (schema ReadAttribution). */
    viaTagManagerByContainer: Record<string, number>;
    /** Read tracing thinned out on this page (1.13.0); see ReadAttribution. */
    traceCapReached?: boolean;
  };
  readTracking: "active" | "unavailable";
  signalSource: "native" | "this-extension" | "other-extension" | "none";
  /**
   * Whether the request that loaded the top document carried Sec-GPC; null until it has
   * been observed. Recorded on its own rather than found in `network`, which keeps only
   * retainable requests, and frozen for the life of the page on purpose: this is the
   * signal AS THE PAGE LOADED, which is what the toolbar icon reports. The setting can
   * change afterwards and the header rule follows it at once, but the page's scripts and
   * cookies already ran under the earlier state, so the icon keeps that state until a
   * reload — the same rule the status row states as "reload the page to apply".
   */
  documentSigned: boolean | null;
  /**
   * What page scripts actually read from the property, as reported by the MAIN world.
   *
   * Kept as its own field, not DERIVED from signalSource, because those are different
   * questions. The derivation (`source === "none" ? false : true`) reports `true` for a
   * native or other-extension owner whose value is `false`, and can never produce "absent"
   * at all, which leaves `signal-property-absent` unreachable and lets `signal-not-read`
   * fire for a signal that is switched off.
   *
   * Defaults to `false` (supported, not enabled): on a page where the content scripts
   * never reported, that is the reading that claims least — no finding rests on it, and no
   * script-written cookie is counted as having been set under the signal. A page this
   * extension's scripts ran on reports "absent" while sending is off or before the
   * permission script has run (1.43.0): the extension defines no property then, and the
   * page reads what the browser gives it.
   */
  propertyValue: true | false | "absent";
  /**
   * How many signal-state messages the content scripts have delivered for this
   * navigation. Diagnostic: a source of "none" with stateMessages > 0 means the state
   * arrived and was then overwritten; with stateMessages === 0 it never arrived at all.
   * The two failures have entirely different causes and this distinguishes them.
   */
  stateMessages: number;
  /**
   * Whether the page's top document has reported the signal state. From then on a frame's
   * report no longer changes the source or the value: the top document re-reads ownership
   * after it loads (another extension can replace our accessor late), and a frame that
   * loads later reports from its own start, before any such script runs in it. Absent in a
   * record stored before it existed, which reads as false.
   */
  topFrameReported?: boolean;
  /** True when capture was interrupted, for any of `incompleteReasons`. */
  incomplete: boolean;
  /**
   * Why, sorted (1.22.0). Set through markIncomplete, which keeps it and `incomplete` in
   * step. A state stored before the field existed reads as incomplete with no reason.
   */
  incompleteReasons: IncompleteReason[];
  /**
   * Whether a Google tag script was requested (1.22.0). Recorded as the request is seen,
   * so it survives a worker reclaim; `gtm` is replaced whole by the page's reports and
   * would not keep it.
   */
  googleTagFetched: boolean;
  /**
   * Whether this version saw the page START loading. Set by resetTab, which runs at
   * onBeforeNavigate, and by nothing else.
   *
   * False for a tab that was already open when the extension was installed, updated or
   * re-enabled: Chrome clears session storage and does not inject the new content scripts
   * into a document that already exists, so nothing the page did while loading was seen and
   * the old version's scripts in it are orphaned. Requests the page makes afterwards still
   * reach webRequest, which is what makes this worth a flag: without it a handful of late
   * requests renders as a full, quiet page. The popup asks for a reload instead.
   *
   * It survives a worker restart with the rest of the state, so a restart mid-session does
   * not raise it. A page loaded under this version stays observed.
   */
  loadObserved: boolean;
  /**
   * The network error Chrome reported for the top document, when it did not load and Chrome
   * showed its own error page (schema CaptureContext.loadError). Set when a top-level
   * navigation fails, kept across the start of the next navigation to the same address (the
   * error page is still what the tab shows, and Chrome's own retry of a failed load ends as
   * an abort), and cleared when a top-level document commits. No content script runs on
   * that page, so without this the defaults above render as a page with the signal
   * switched off (seen on ticketing-b.example, 2026-09-25).
   */
  loadError: string | null;
  /**
   * The address whose load failed. A navigation to another one starts a page of its own:
   * one that ends without committing (a download, a 204) would leave the state saying the
   * new address did not load.
   */
  loadErrorUrl: string | null;
  startedAtMs: number;
  /**
   * The id of this capture, made with the state and so replaced on navigation. Every
   * export of the page carries it. Optional because a state stored by an earlier version
   * has none.
   */
  scanId?: string;
  /**
   * When each cookie the tallies hold was last set, which were write tests, which the jar
   * was found to hold, and which still wait for their first jar check. See cookie-events.ts.
   * Not in the schema: it is how the counts are kept right, not an observation.
   */
  cookieLedger: CookieLedger;
  /**
   * Script cookie writes the browser would have refused (a public-suffix Domain, or one the
   * writing frame's host is not under). Not counted as cookies; kept as a diagnostic.
   */
  rejectedCookieWrites: number;
  /**
   * The documents of this page, and of the page before it, so what the previous page does
   * while it unloads is not counted on this one (see documents.ts). Not in the schema.
   */
  pageDocuments: string[];
  retiredDocuments: string[];
  /**
   * The top documents of prerenders started in this tab, most recent last, at most
   * PRERENDER_DOCUMENTS_CAP (see prerender.ts). Kept across the reset that starts a page,
   * because an activation starts with one: at the commit that follows, a document listed
   * here whose prerender this worker no longer holds was loaded while nothing was kept of
   * it. Not in the schema.
   */
  prerenderDocuments?: string[];
  /**
   * The pages this tab left, most recent last, at most PAST_PAGES_CAP: each one's top
   * document and the signal it reported. Kept across the reset that starts a page. A
   * document listed here that commits again was restored from the back/forward cache, and
   * the signal it reported at its load still holds. Not in the schema.
   */
  pastPages?: PastPage[];
  /** The page was restored from the back/forward cache (schema CaptureContext.restoredFromCache). */
  restoredFromCache?: boolean;
  /**
   * A top-level navigation has started and not yet committed (1.26.0): which site it lands
   * on is not known, since a redirect can take it anywhere. Set by resetTab, cleared by the
   * top frame's commit. Not in the schema.
   */
  awaitingCommit?: boolean;
  /**
   * The main-frame requests and responses seen while awaiting commit, in order, not yet
   * counted: judged against the first URL's site, a cross-site redirect's cookie was the
   * site's own and the landed site's own was a third party's (reproduced 2026-09-29). The
   * commit counts them against the site it landed on. At most HELD_TOP_LEVEL_CAP; past it
   * they are counted as they arrive. Ids into the request list, so a worker that
   * ends mid-navigation, which only a crash does, loses them with the list.
   */
  heldTopLevel?: { id: string; what: "request" | "response" }[];
  /**
   * Every observation that set a cookie, in the form kept past a reclaim (1.27.0; see
   * kept-cookies.ts). In memory like `network`, and NOT part of the state's own write: it
   * is stored as strings under its own keys, and read back by a worker's first use of the
   * tab.
   */
  keptCookies?: KeptCookieResponse[];
  /**
   * A record was not kept: past the cap, dropped to make room, or lost with a worker that
   * ended before writing it. Written with the state. It says so and stops nothing; what
   * stops keeping is the cap, and a drop to make room (keptStopped).
   */
  keptCookiesIncomplete?: boolean;
}

/**
 * A page the tab left: its top document, what it reported about the signal, and whether it
 * showed a confirmation notice. The confirmation fields are optional because a record
 * stored before they existed has none.
 */
export interface PastPage {
  documentId: string;
  signalSource: TabState["signalSource"];
  propertyValue: TabState["propertyValue"];
  readTracking: TabState["readTracking"];
  documentSigned: TabState["documentSigned"];
  confirmationNotice?: TabState["confirmationNotice"];
  confirmationEvidence?: TabState["confirmationEvidence"];
  confirmationText?: TabState["confirmationText"];
}

/** Pages a tab's record keeps: more than the browser keeps in its back/forward cache for a tab. */
export const PAST_PAGES_CAP = 20;

/**
 * At a top-level commit: when the committed document is a page the tab left, which is a
 * restore from the back/forward cache, mark the capture as one whose load was not observed
 * and give it back the signal the page reported and the result of its confirmation scan.
 * The page is taken off the list.
 *
 * The confirmation scan runs as the page loads, and a restored page is resumed, not
 * loaded: no scan reports again. Without the result the row would say "checking" for as
 * long as the tab stayed on the page. A record without the fields keeps the reset's
 * "indeterminate".
 */
export function restorePastPage(s: TabState, documentId: string | undefined): boolean {
  const past = s.pastPages ?? [];
  const page = documentId === undefined ? undefined : past.find((p) => p.documentId === documentId);
  if (page === undefined) return false;
  s.pastPages = past.filter((p) => p !== page);
  s.loadObserved = false;
  s.restoredFromCache = true;
  s.signalSource = page.signalSource;
  s.propertyValue = page.propertyValue;
  s.readTracking = page.readTracking;
  s.documentSigned = page.documentSigned;
  if (page.confirmationNotice !== undefined) {
    s.confirmationNotice = page.confirmationNotice;
    s.confirmationEvidence = page.confirmationEvidence ?? null;
    s.confirmationText = page.confirmationText ?? null;
  }
  return true;
}

/** The page being left, added to the pages the tab left. */
function withPastPage(s: TabState): PastPage[] {
  const past = s.pastPages ?? [];
  const top = (s.pageDocuments ?? [])[0];
  if (top === undefined) return past;
  const page: PastPage = {
    documentId: top,
    signalSource: s.signalSource,
    propertyValue: s.propertyValue,
    readTracking: s.readTracking,
    documentSigned: s.documentSigned,
    confirmationNotice: s.confirmationNotice,
    confirmationEvidence: s.confirmationEvidence,
    confirmationText: s.confirmationText ?? null,
  };
  return [...past.filter((p) => p.documentId !== top), page].slice(-PAST_PAGES_CAP);
}

/** Prerendered top documents a tab's record keeps: more than Chrome runs at once for one page. */
export const PRERENDER_DOCUMENTS_CAP = 20;

/** Record the top document of a prerender started in the tab. */
export function notePrerenderDocument(s: TabState, documentId: string): void {
  const listed = (s.prerenderDocuments ?? []).filter((id) => id !== documentId);
  s.prerenderDocuments = [...listed, documentId].slice(-PRERENDER_DOCUMENTS_CAP);
}

/**
 * At a top-level commit: whether the committed document is a listed prerender's, which is
 * its activation, taken off the list.
 */
export function takePrerenderDocument(s: TabState, documentId: string | undefined): boolean {
  const listed = s.prerenderDocuments ?? [];
  if (documentId === undefined || !listed.includes(documentId)) return false;
  s.prerenderDocuments = listed.filter((id) => id !== documentId);
  return true;
}

/** Main-frame events held for the commit: request and response of 20 redirect hops. */
export const HELD_TOP_LEVEL_CAP = 40;

/**
 * Hold a main-frame request or response until the navigation commits (1.26.0), and say
 * whether it was held. Only while a navigation is awaiting its commit, only the main frame,
 * and only up to HELD_TOP_LEVEL_CAP: anything else is counted as it arrives.
 */
export function holdTopLevel(s: TabState, type: string, id: string, what: "request" | "response"): boolean {
  if (type !== "main_frame" || s.awaitingCommit !== true) return false;
  const held = s.heldTopLevel ?? [];
  if (held.length >= HELD_TOP_LEVEL_CAP) return false;
  s.heldTopLevel = [...held, { id, what }];
  return true;
}

/**
 * At the top frame's commit: the held events, in the order they arrived, each with the
 * observation it names where the request list still has it. Clears the hold.
 */
export function takeHeldTopLevel(s: TabState): { obs: NetworkObservation; what: "request" | "response" }[] {
  const held = s.heldTopLevel ?? [];
  s.awaitingCommit = false;
  s.heldTopLevel = [];
  const out: { obs: NetworkObservation; what: "request" | "response" }[] = [];
  for (const h of held) {
    const obs = s.network.find((o) => o.id === h.id);
    if (obs !== undefined) out.push({ obs, what: h.what });
  }
  return out;
}

/**
 * Each tab's working state, in MEMORY. Observations live only here; everything else is
 * also written to storage.
 *
 * The request list is the bulk of the data — roughly 449 bytes each, so a heavy page's 800
 * requests is ~350KB, and a dozen such tabs would approach chrome.storage.session's ~10MB
 * quota. Exceeding it does not degrade gracefully: every write fails, including the
 * navigation reset and the content scripts' signal report, and the extension keeps
 * rendering confidently on state that stopped updating. That failure shows as "GPC signal
 * is not set" on a page that is demonstrably sending the header.
 *
 * Keeping the list in memory removes that risk entirely, with no cap on the list. It is
 * safe because the TALLIES persist: if the worker is terminated the counts survive and
 * only the enumeration is lost. That is a real cost (MV3 reclaims an idle worker after
 * about 30 seconds, so the Requests tab can come back empty), but it is a bounded, visible,
 * honest loss rather than silent corruption of every number.
 *
 * A restart is detectable: tallies reporting requests while memory holds none can only mean
 * the worker was replaced, and the capture is marked incomplete so the UI says so.
 *
 * The rest of the state is held here as well, and storage is read once per tab per worker
 * instance. A flush that reads the tab's full state back from storage and then writes it
 * makes two round trips to the browser process. With ten news sites loading at once those
 * round trips queue behind one another (measured 2026-09-23: 1,485 flushes waiting on the
 * news-i.co.uk tab's chain after 30 seconds, 577 seconds of reads in total against 64 ms
 * of actual mutation, and the popup, which waited for that chain, took over 9 seconds to
 * answer on every tab). Reading from here, a flush is a mutation and one write.
 */
const liveByTab = new Map<number, TabState>();
/** Reads from storage in flight, so concurrent first uses of a tab read it once. */
const loadingByTab = new Map<number, Promise<TabState>>();

/**
 * Trim an observation to what is actually needed downstream.
 *
 * Full header arrays are the bulk of the payload and are only interesting for responses
 * that did something: the engine needs url, type, secGpcPresent, status, and setCookies,
 * all of which are extracted at capture time. Keeping every header for every request costs
 * roughly an order of magnitude more storage than the facts themselves.
 *
 * Headers ARE kept on responses that set cookies, because those are the observations that
 * produce findings and a finding must be able to carry its artifact.
 */
function slim(obs: NetworkObservation): NetworkObservation {
  if (!needsSlimming(obs)) return obs;
  return {
    ...obs,
    requestHeaders: obs.requestHeaders.filter((h) => h.nameLower === "sec-gpc"),
    responseHeaders: null,
  };
}

/** Whether slim() would change an observation. Checked each flush, so it has to be cheap. */
function needsSlimming(obs: NetworkObservation): boolean {
  if (obs.setCookies.length > 0) return false;
  return obs.responseHeaders !== null || obs.requestHeaders.some((h) => h.nameLower !== "sec-gpc");
}

export function emptyTabState(tabId: number): TabState {
  return {
    tabId,
    topSite: "",
    finalUrl: "",
    network: [],
    consentApiCalls: [],
    gpp: null,
    usPrivacy: null,
    tcf: null,
    gtm: { present: false, containerIds: [], gtagIds: [], consentMode: null },
    scriptInsertions: [],
    scriptInsertionCoverage: null,
    requestInitiators: [],
    requestInitiatorCoverage: null,
    cookieCoverage: null,
    confirmationNotice: "indeterminate",
    confirmationEvidence: null,
    confirmationText: null,
    wellKnown: null,
    tallies: emptyTalliesFrozen(),
    capabilities: {
      documentCookie: true,
      cookieStore: true,
      gpp: true,
      uspapi: true,
      tcfapi: true,
      dataLayer: true,
    },
    signalReads: 0,
    readsByScript: {},
    readAttribution: { sampled: 0, unattributed: 0, viaTagManager: 0, viaTagManagerByContainer: {} },
    readTracking: "active",
    signalSource: "none",
    documentSigned: null,
    propertyValue: false,
    stateMessages: 0,
    topFrameReported: false,
    incomplete: false,
    incompleteReasons: [],
    googleTagFetched: false,
    loadObserved: false,
    loadError: null,
    loadErrorUrl: null,
    startedAtMs: Date.now(),
    scanId: crypto.randomUUID(),
    cookieLedger: { setAt: {}, probes: [] },
    rejectedCookieWrites: 0,
    pageDocuments: [],
    retiredDocuments: [],
    keptCookies: [],
    // Explicit, so a new page assigned over the last one clears it.
    keptCookiesIncomplete: false,
  };
}

/**
 * Each working state's tallies in their mutable form, thawed once per worker instance.
 *
 * Thawing and refreezing on every request would copy every set and every cookie detail per
 * event, on the worker's hot path, while a page loads. So the mutable form is kept beside
 * the working state and frozen once per flush (applyPending) and before any read or write.
 * `base` is the frozen tallies it was thawed from or last frozen to: a mutation that
 * replaces `state.tallies` outright (a new page) leaves it stale, and it is thawed again.
 */
interface TallyCache {
  base: Tallies;
  t: MutableTallies;
  changed: boolean;
}
const tallyCache = new WeakMap<TabState, TallyCache>();

/** The working state's tallies, to change in place. Frozen back when the batch is applied. */
export function mutableTallies(state: TabState): MutableTallies {
  let c = tallyCache.get(state);
  if (c === undefined || c.base !== state.tallies) {
    c = { base: state.tallies, t: thawTallies(state.tallies), changed: false };
    tallyCache.set(state, c);
  }
  c.changed = true;
  return c.t;
}

/** Bring `state.tallies` up to date with changes made through mutableTallies. */
function freezeChangedTallies(state: TabState): void {
  const c = tallyCache.get(state);
  if (c === undefined || !c.changed || c.base !== state.tallies) return;
  state.tallies = freezeTallies(c.t);
  c.base = state.tallies;
  c.changed = false;
}

/** Mark a state incomplete for a reason, once. */
export function markIncomplete(state: TabState, reason: IncompleteReason): void {
  state.incomplete = true;
  state.incompleteReasons = withReason(state.incompleteReasons, reason);
}

function withReason(reasons: readonly IncompleteReason[] | undefined, reason: IncompleteReason): IncompleteReason[] {
  const out = [...(reasons ?? [])];
  if (!out.includes(reason)) out.push(reason);
  return out.sort();
}

/**
 * Read a tab's state.
 *
 * A READ failure and a genuinely new tab would both produce an empty state, which are very
 * different things: the first means we lost everything observed so far, the second means
 * there was nothing yet. The next write would then store that empty state, destroying
 * prior observations without a trace, the mirror image of a write the store refuses, and
 * the same governing principle applies: absence of data is never a finding.
 *
 * On failure the returned state is marked `incomplete`, so whatever is rebuilt on top of
 * it is reported as partial rather than presented as the whole record.
 */
export async function getTabState(tabId: number): Promise<TabState> {
  const state = await liveState(tabId);
  freezeChangedTallies(state);
  // A copy, so a reader cannot change the working state by accident. The request list is
  // shared; nothing that reads it writes to it.
  if (!writeFailed.has(tabId)) return { ...state };
  return { ...state, incomplete: true, incompleteReasons: withReason(state.incompleteReasons, "write-failed") };
}

/** The working state, read from storage on this worker's first use of the tab. */
async function liveState(tabId: number): Promise<TabState> {
  const held = liveByTab.get(tabId);
  if (held) return held;
  const inFlight = loadingByTab.get(tabId);
  if (inFlight) return inFlight;
  const load: Promise<TabState> = readStoredState(tabId).then((stored) => {
    // Cleared while the read was in flight: the store no longer holds what was read.
    const cleared = loadingByTab.get(tabId) !== load;
    if (!cleared) loadingByTab.delete(tabId);
    const state = liveByTab.get(tabId) ?? (cleared ? emptyTabState(tabId) : stored);
    if (!closedTabs.has(tabId)) liveByTab.set(tabId, state);
    return state;
  });
  loadingByTab.set(tabId, load);
  return load;
}

/**
 * A tab's record as stored, parsed. It is written as one JSON string: chrome.storage.session
 * counts a nested object at 3.4 to 4.2 times its JSON length against the quota, and a
 * string at its own length (measured 2026-09-30: retailer-k.example's state, 498 KB of JSON, counted
 * 1,669 KB as an object). An object, as an earlier version stored it, is read as it is.
 * Throws on a string that does not parse.
 */
export function parseStoredState(raw: unknown): StoredTabState | undefined {
  if (raw === undefined || raw === null) return undefined;
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as StoredTabState;
}

/**
 * A tab's record as written: the working state with its insertions interned, and how many
 * chunks of kept cookie records are its own (1.27.0), which only the store needs.
 */
export type StoredTabState = TabState & {
  scriptInsertionsInterned?: InternedInsertions;
  requestInitiatorsInterned?: InternedInsertions;
  keptCookieChunks?: number;
};

/** Read a tab's state from storage. Only a worker's first use of a tab gets here. */
async function readStoredState(tabId: number): Promise<TabState> {
  const key = keyFor(tabId);
  // This worker instance has no request list for the tab: this is its first use of it.
  const network: NetworkObservation[] = [];
  try {
    // The kept cookie records' keys in the same read (1.27.0), every one a tab can have: a
    // second read, once the state says how many there are, would make every first use of a
    // tab after a reclaim wait for two round trips.
    const got = await chrome.storage.session.get([key, dirtyKeyFor(tabId), ...keptKeys(tabId)]);
    // An unreadable string throws, and is reported below as a failed read.
    const existing = parseStoredState(got[key]);
    // A worker that ended with changes it had not written left its marker behind. An idle
    // reclaim never does: it comes 30 seconds after the last event, and the marker is gone
    // a second after the last write. So the counts may be behind what the page did, which
    // is what a failed write means too.
    const marker = got[dirtyKeyFor(tabId)];
    const interrupted = typeof marker === "string" && marker !== WORKER_ID;
    if (existing === undefined) {
      const fresh = emptyTabState(tabId);
      fresh.network = network;
      if (writeFailed.has(tabId) || interrupted) markIncomplete(fresh, "write-failed");
      return fresh;
    }
    // The worker was replaced if we have counts but no observations to go with them, and a
    // stored state read here always arrives without its list. The numbers are still right;
    // the list is not, and saying so is the difference between a partial view and a wrong one.
    const restarted = isTallied(existing.tallies);
    // Insertions are persisted interned; expand them here so nothing else sees that form.
    // A state written before the field existed expands to an empty list.
    const stored = existing as StoredTabState;
    const { scriptInsertionsInterned, requestInitiatorsInterned, keptCookieChunks = 0, ...rest } = stored;
    // The kept cookie records. The state names how many chunks are its own; one missing
    // (dropped to make room) or unreadable marks them incomplete, and the next write stores
    // them whole again. A chunk past those, which a failed removal left, is removed by it.
    const kept = readChunks(got, tabId, keptCookieChunks);
    keptWritten.set(tabId, { list: kept.records, count: kept.complete ? kept.records.length : 0 });
    keptChunksStored.set(tabId, Math.max(keptCookieChunks, chunksPresent(got, tabId)));
    return {
      ...rest,
      keptCookies: kept.records,
      // A worker that ended mid-batch took the records it had not written with it, as it
      // took the counts.
      keptCookiesIncomplete: existing.keptCookiesIncomplete === true || !kept.complete || interrupted,
      scriptInsertions: expandInsertions(scriptInsertionsInterned),
      scriptInsertionCoverage: existing.scriptInsertionCoverage ?? null,
      requestInitiators: expandInsertions(requestInitiatorsInterned),
      requestInitiatorCoverage: existing.requestInitiatorCoverage ?? null,
      cookieCoverage: existing.cookieCoverage ?? null,
      network,
      // A write that did not land lost the mutations it carried, and the record it would
      // have replaced is what we just read. The flag is in memory because the store is
      // exactly what failed; see writeFailed.
      incomplete: existing.incomplete || restarted || writeFailed.has(tabId) || interrupted,
      incompleteReasons: [
        ...(existing.incompleteReasons ?? []),
        ...(restarted ? (["worker-restarted"] as const) : []),
        ...(writeFailed.has(tabId) || interrupted ? (["write-failed"] as const) : []),
      ].reduce<IncompleteReason[]>((acc, r) => withReason(acc, r), []),
      googleTagFetched: existing.googleTagFetched ?? false,
      // A state stored before the ledger existed has none. One read back shows every key
      // that was waiting for its jar check: the checks were the last worker's, in its
      // memory, and a key no check will ever answer for would stay hidden. They count
      // unchecked, as a write the jar could not be asked about does.
      cookieLedger: withoutPending(existing.cookieLedger ?? { setAt: {}, probes: [] }),
      rejectedCookieWrites: existing.rejectedCookieWrites ?? 0,
    };
  } catch {
    const fresh = emptyTabState(tabId);
    fresh.network = network;
    markIncomplete(fresh, "read-failed");
    return fresh;
  }
}

/** A ledger with no key waiting: what a worker that holds none of the checks starts from. */
function withoutPending(ledger: CookieLedger): CookieLedger {
  if (ledger.pending === undefined) return ledger;
  const { pending: _shown, ...rest } = ledger;
  return rest;
}

export async function putTabState(state: TabState): Promise<void> {
  freezeChangedTallies(state);
  const tabId = state.tabId;
  // Observations are held in memory and excluded from the write. They are the bulk of the
  // payload and what puts the quota at risk. The kept cookie records go under keys
  // of their own, as strings, only the chunks that changed (1.27.0).
  const { network: _omitted, scriptInsertions, requestInitiators, keptCookies = [], ...persisted } = state;
  // Only the list the store last took has records there. Any other, a new page's even at the
  // same length, is written from its start.
  const stored = keptWritten.get(tabId);
  const written = stored?.list === keptCookies ? stored.count : 0;
  const kept = chunkWrites(tabId, keptCookies, written, keptChunksStored.get(tabId) ?? 0);
  // Counted now, not once the write lands: the list keeps growing while the write is in
  // flight, and records added meanwhile are not in it. A record remade meanwhile lowers the
  // count again (followKept).
  const taking = { list: keptCookies, count: keptCookies.length };
  keptWritten.set(tabId, taking);
  try {
    // As one JSON string: see parseStoredState for why.
    await chrome.storage.session.set({
      [keyFor(tabId)]: JSON.stringify({
        ...persisted,
        network: [],
        keptCookieChunks: kept.chunks,
        scriptInsertionsInterned: internInsertions(scriptInsertions),
        requestInitiatorsInterned: internInsertions(requestInitiators),
      }),
      ...kept.set,
    });
  } catch (err) {
    // Nothing was stored, so the store holds what it held before.
    taking.count = Math.min(taking.count, written);
    throw err;
  }
  keptChunksStored.set(tabId, kept.chunks);
  // What a new page left behind. The state above no longer names these chunks, so a failed
  // removal leaves unread bytes, which the next reclaim of space removes.
  if (kept.remove.length > 0) await chrome.storage.session.remove(kept.remove).catch(() => undefined);
}

/**
 * Per tab, the kept list the store last took and how many of its first records it holds as
 * they are, and in how many chunks. By list, not by length: a new page's list can reach the
 * length of the last page's before its first write.
 */
const keptWritten = new Map<number, { readonly list: readonly KeptCookieResponse[]; count: number }>();
const keptChunksStored = new Map<number, number>();
/** Per kept list, where each record is. A new list starts its own. */
const keptSources = new WeakMap<readonly KeptCookieResponse[], KeptSources>();
/**
 * Kept lists that keep no more: the list their records were dropped from to make room
 * (forgetKept), whose observations still in memory would be written straight back into the
 * space just freed. A new page's list, or one a later worker reads back, keeps again.
 */
const keptStopped = new WeakSet<readonly KeptCookieResponse[]>();

/**
 * Keep each observation that set a cookie and is not yet kept (1.27.0). Past the cap nothing
 * more is kept, and after a drop to make room nothing more for the page in this worker
 * (keptStopped). The records already kept still follow their observations (followKept).
 */
function keepCookieResponses(state: TabState): void {
  const kept = (state.keptCookies ??= []);
  if (keptStopped.has(kept)) return;
  if (keepNew(state.network, kept, keptSourcesOf(kept))) state.keptCookiesIncomplete = true;
}

function keptSourcesOf(kept: readonly KeptCookieResponse[]): KeptSources {
  let sources = keptSources.get(kept);
  if (sources === undefined) {
    sources = sourcesOf(kept);
    keptSources.set(kept, sources);
  }
  return sources;
}

/**
 * Remake the kept record of `obs`, an observation replaced since it was kept, from what it is
 * now. One change reaches what a record holds: markJar, in sw.ts, marks a cookie the jar did
 * not hold, and the record follows it. Called where that happens, not found by comparing
 * every observation on every flush. The store's copy is then out of date, so its chunk is
 * written again.
 */
export function followKept(state: TabState, obs: NetworkObservation): void {
  const kept = state.keptCookies;
  if (kept === undefined) return;
  const at = remakeKept(obs, kept, keptSourcesOf(kept));
  const stored = keptWritten.get(state.tabId);
  if (at !== null && stored?.list === kept) stored.count = Math.min(stored.count, at);
}

export async function clearTabState(tabId: number): Promise<void> {
  // The changes still queued are the page being left's. Applied after the clear, they would
  // make a fresh state, put that page's requests in it under no site, and write it back.
  dropPending(tabId);
  liveByTab.delete(tabId);
  loadingByTab.delete(tabId);
  writeFailed.delete(tabId);
  keptWritten.delete(tabId);
  keptChunksStored.delete(tabId);
  forgetMarker(tabId);
  // Every key the kept records can be under, so nothing is read first: that read, for a tab
  // this worker never loaded, would parse the whole stored state for one number, and run
  // before anything in memory is cleared.
  await chrome.storage.session.remove([keyFor(tabId), dirtyKeyFor(tabId), ...keptKeys(tabId)]);
}

// --- The unwritten-changes marker ---

/**
 * This worker instance, so it does not read its own marker as a predecessor's.
 *
 * A worker that dies between a change and the write that carries it loses that change, and
 * the next one cannot tell from the stored state, which looks like any other. So a tab's
 * first change after a quiet spell writes a small marker naming this worker, and a second
 * of quiet after the last write that landed removes it. A new worker that finds another
 * worker's marker knows that one ended mid-batch. Busy pages write it once per busy spell,
 * not once per flush.
 */
const WORKER_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const DIRTY_PREFIX = "dirty:";
const CLEAN_AFTER_MS = 1000;
/** Tabs whose marker this worker has written and not yet removed. */
const markedDirty = new Set<number>();
const cleanTimers = new Map<number, ReturnType<typeof setTimeout>>();

function dirtyKeyFor(tabId: number): string {
  return `${DIRTY_PREFIX}${tabId}`;
}

function markDirty(tabId: number): void {
  const timer = cleanTimers.get(tabId);
  if (timer !== undefined) {
    clearTimeout(timer);
    cleanTimers.delete(tabId);
  }
  if (markedDirty.has(tabId)) return;
  markedDirty.add(tabId);
  void chrome.storage.session.set({ [dirtyKeyFor(tabId)]: WORKER_ID }).catch(() => undefined);
}

/** After a write lands: remove the marker once the tab has been quiet for a second. */
function scheduleClean(tabId: number): void {
  if (!markedDirty.has(tabId) || cleanTimers.has(tabId)) return;
  cleanTimers.set(
    tabId,
    setTimeout(() => {
      cleanTimers.delete(tabId);
      if (pending.has(tabId) || flushTimers.has(tabId) || unwritten.has(tabId) || writes.has(tabId)) return;
      markedDirty.delete(tabId);
      void chrome.storage.session.remove(dirtyKeyFor(tabId)).catch(() => undefined);
    }, CLEAN_AFTER_MS),
  );
}

function forgetMarker(tabId: number): void {
  markedDirty.delete(tabId);
  const timer = cleanTimers.get(tabId);
  if (timer !== undefined) clearTimeout(timer);
  cleanTimers.delete(tabId);
}

/**
 * Tabs that have closed. Chrome does not reuse a tab id within a session.
 *
 * A beacon sent as a page unloads arrives after tabs.onRemoved, and its queued write would
 * put a fresh state back under the closed tab's key (seen 2026-09-22: about 2 KB per
 * closed tab, left in a store with a 10 MB quota). Writes for a closed tab are dropped.
 *
 * In memory, against this file's rule, because losing it is harmless: a worker restart
 * forgets which tabs closed, an orphan can then be written again, and reclaimSessionSpace
 * removes it the next time space is needed.
 */
const closedTabs = new Set<number>();

/** Forget a tab that has closed, and refuse any write for it that is still in flight. */
export async function forgetTab(tabId: number): Promise<void> {
  closedTabs.add(tabId);
  dropPending(tabId);
  // A write already started before the tab closed still lands, and removing the key before
  // it does let it put the full state back: 6 of 10 closed tabs, 70 to 127 KB each, in a
  // live run on 2026-09-22. Wait it out, then remove.
  await writes.get(tabId)?.catch(() => undefined);
  await clearTabState(tabId);
}

/**
 * Tabs whose last write did not land.
 *
 * The persisted `incomplete` flag cannot report a failed write: it is written to the store
 * that just refused the write. Without this, a full store leaves every tab rendering its
 * last saved numbers as current (seen 2026-09-22: headline counts frozen while the in-memory
 * request list kept growing, with nothing marked partial). getTabState ORs this in, and a failed
 * write also marks the working state, so the next write that does land carries
 * `incomplete: true` into the store, and the flag is cleared.
 *
 * In memory for the same reason. A worker restart loses it, and a restart already marks
 * the capture incomplete (tallies with no observations; see getTabState).
 */
const writeFailed = new Set<number>();

/** Share of the session quota above which space is reclaimed before it runs out. */
const RECLAIM_AT = 0.8;
/** chrome.storage.session.QUOTA_BYTES, with the documented value as the fallback. */
const SESSION_QUOTA_BYTES = 10 * 1024 * 1024;
const BUDGET_CHECK_MS = 10_000;
let lastBudgetCheck = 0;

/**
 * Free session storage, one step a call, the first step that finds something to free:
 *
 *   1. The state and kept cookie records of tabs that are no longer open.
 *   2. The kept cookie records of the other open tabs (1.27.0). They serve only a Requests
 *      tab after a reclaim, and a tab whose counts stop updating costs more.
 *   3. The published-GPC-file cache: it costs a re-fetch per site, which is cheaper still.
 *   4. The kept cookie records of `keepTabId`, the tab being written.
 *
 * Steps 2 and 4 only with `keptRecords`, for a write the store refused. While it still takes
 * writes, those records are worth the room, and the check near the quota leaves them.
 * Never the state of an open tab. Returns how many keys went, 0 when there was nothing to
 * free.
 *
 * `keys`, when given, is the store's keys as the caller read them, and what goes is taken
 * out of it: a refused write tries step after step, and reading the store for each would
 * read every value in it up to four times, on a store already too full to write.
 */
export async function reclaimSessionSpace(
  keepTabId?: number,
  { keptRecords = false, keys }: { readonly keptRecords?: boolean; readonly keys?: Set<string> } = {},
): Promise<number> {
  try {
    const present = keys ?? (await storedKeys());
    const open = new Set((await chrome.tabs.query({})).map((t) => t.id));
    const remove = async (gone: readonly string[]): Promise<void> => {
      await chrome.storage.session.remove([...gone]);
      for (const k of gone) present.delete(k);
    };
    const staleOf = (prefix: string) =>
      [...present].filter((k) => {
        if (!k.startsWith(prefix)) return false;
        const id = Number(k.slice(prefix.length));
        return id !== keepTabId && !open.has(id);
      });
    const stale = staleOf(KEY_PREFIX);
    // A closed tab's unwritten-changes marker goes with it, and is not counted as space
    // freed: a few bytes, and counting them would skip the cache below when it is what
    // would actually make room. Its kept cookie records go with it too (1.27.0).
    const markers = staleOf(DIRTY_PREFIX);
    const keptOf = (tab: (id: number) => boolean) =>
      [...present].filter((k) => {
        const id = keptTabOf(k);
        return id !== null && tab(id);
      });
    const staleKept = keptOf((id) => id !== keepTabId && !open.has(id));
    if (stale.length + markers.length + staleKept.length > 0) await remove([...stale, ...markers, ...staleKept]);
    if (stale.length + staleKept.length > 0) return stale.length + staleKept.length;
    // Another tab's state is never dropped for its kept records.
    const others = keptRecords ? keptOf((id) => id !== keepTabId) : [];
    if (others.length > 0) {
      await remove(others);
      forgetKept(new Set(others.map((k) => keptTabOf(k) as number)));
      return others.length;
    }
    const cached = [...present].filter((k) => k.startsWith("wk:"));
    if (cached.length > 0) {
      await remove(cached);
      return cached.length;
    }
    const own = keptRecords ? keptOf((id) => id === keepTabId) : [];
    if (own.length > 0) {
      await remove(own);
      forgetKept(new Set([keepTabId as number]));
    }
    return own.length;
  } catch {
    return 0; // nothing could be freed; the caller reports the write as failed
  }
}

/** The steps reclaimSessionSpace frees in. A refused write tries again after each. */
const RECLAIM_STEPS = 4;

/**
 * The keys session storage holds. The values come with them: chrome.storage.session.getKeys
 * needs Chrome 130, and the extension runs from 119.
 */
async function storedKeys(): Promise<Set<string>> {
  return new Set(Object.keys(await chrome.storage.session.get(null)));
}

/**
 * Whether a failed write was the store refusing it for room: Chrome rejects with "Session
 * storage quota bytes exceeded. Values were not stored." Only that failure is one that
 * freeing space can fix.
 */
function isQuotaError(err: unknown): boolean {
  return /quota/i.test(err instanceof Error ? err.message : String(err));
}

/**
 * Kept records removed to make room: each working state this worker holds forgets them, says
 * they are incomplete, keeps no more for the page, and its next write stores no chunks. A tab
 * this worker has not loaded finds them missing when it does, and says the same.
 */
function forgetKept(tabs: ReadonlySet<number>): void {
  for (const tabId of tabs) {
    const state = liveByTab.get(tabId);
    keptWritten.delete(tabId);
    keptChunksStored.set(tabId, 0);
    if (state === undefined) continue;
    state.keptCookies = [];
    keptStopped.add(state.keptCookies);
    state.keptCookiesIncomplete = true;
  }
}

/**
 * Reclaim before the quota is reached, not only after a write has failed. Throttled: the
 * byte count reads the whole store, and a busy page flushes every 120 ms.
 *
 * Closed tabs' records and the file cache only, never an open tab's kept cookie records.
 * With them, every check above the mark would drop one more kind: in a browser whose tab
 * states alone pass it, every open tab's records would go within 30 seconds, and every new
 * page's within 10 seconds of being kept, while the store still takes every write.
 */
async function reclaimIfNearQuota(tabId: number): Promise<void> {
  const now = Date.now();
  if (now - lastBudgetCheck < BUDGET_CHECK_MS) return;
  lastBudgetCheck = now;
  const area = chrome.storage.session as typeof chrome.storage.session & {
    getBytesInUse?: (keys: null) => Promise<number>;
    QUOTA_BYTES?: number;
  };
  if (typeof area.getBytesInUse !== "function") return;
  try {
    const used = await area.getBytesInUse(null);
    if (used > (area.QUOTA_BYTES ?? SESSION_QUOTA_BYTES) * RECLAIM_AT) await reclaimSessionSpace(tabId);
  } catch {
    /* the check is an optimization; a failed write still reclaims */
  }
}

/**
 * Pending mutations, coalesced per tab.
 *
 * A read-modify-write of the ENTIRE network array per observation is O(n²) serializations
 * at n requests: on news-g.example, 479 requests meant roughly 115,000 observation-writes, and
 * the popup waited about five seconds for the write chain to settle before it could read.
 *
 * So mutations queue and are applied together on a short timer, or at once when a reader
 * settles the tab. Applying is synchronous once the working state is in memory, so the
 * mutations for a tab always apply in the order they arrived and never interleave. Worker
 * death loses at most what was not yet written, which is what `incomplete` exists to record.
 */
const pending = new Map<number, ((state: TabState) => void)[]>();
const flushTimers = new Map<number, ReturnType<typeof setTimeout>>();
const FLUSH_MS = 120;

/**
 * Queue a change to a tab's state. It applies within FLUSH_MS, or when a reader settles
 * the tab. The returned promise resolves at once: storage is written in the background and
 * nothing waits for it.
 */
export function updateTabState(
  tabId: number,
  mutate: (state: TabState) => void,
): Promise<void> {
  if (closedTabs.has(tabId)) return Promise.resolve();
  const queue = pending.get(tabId) ?? [];
  queue.push(mutate);
  pending.set(tabId, queue);
  // Marked only once this worker has read the tab's stored state, and with it any marker a
  // predecessor left: written first, this worker's own marker would replace that one unread.
  if (liveByTab.has(tabId)) markDirty(tabId);
  else void liveState(tabId).then(() => markDirty(tabId), () => undefined);

  if (!flushTimers.has(tabId)) {
    flushTimers.set(
      tabId,
      setTimeout(() => {
        flushTimers.delete(tabId);
        void applyPending(tabId).catch(() => undefined);
      }, FLUSH_MS),
    );
  }
  return Promise.resolve();
}

/** Drop a tab's queued changes, its flush timer, and any write it was still owed. */
function dropPending(tabId: number): void {
  pending.delete(tabId);
  const timer = flushTimers.get(tabId);
  if (timer !== undefined) {
    clearTimeout(timer);
    flushTimers.delete(tabId);
  }
  unwritten.delete(tabId);
}

/** Apply every queued mutation to the working state, then write it. */
async function applyPending(tabId: number): Promise<void> {
  if (!pending.has(tabId)) return;
  const state = await liveState(tabId);
  // Cleared while the read was in flight: apply to what replaced it.
  if (liveByTab.get(tabId) !== state) {
    if (closedTabs.has(tabId)) return;
    return applyPending(tabId);
  }
  // Another caller may have applied the queue while this one waited for the read.
  const queued = pending.get(tabId);
  if (queued === undefined) return;
  pending.delete(tabId);
  for (const mutate of queued) mutate(state);
  freezeChangedTallies(state);

  // Still slimmed: headers are the bulk of an observation, and memory is not free either.
  // There is no cap; the observations do not reach storage. In place, and only the ones
  // that still carry headers, so a flush on a heavy page does not copy the whole list.
  const network = state.network;
  for (let i = 0; i < network.length; i++) {
    const obs = network[i];
    if (obs !== undefined && needsSlimming(obs)) network[i] = slim(obs);
  }
  keepCookieResponses(state);
  void writeTab(tabId);
}

/** Tabs whose working state has changed since their last write started. */
const unwritten = new Set<number>();
/** The write in flight per tab. At most one: the store sees a tab's writes in order. */
const writes = new Map<number, Promise<void>>();

/**
 * Write a tab's working state, coalescing with a write already in flight.
 *
 * One write per tab at a time. Changes made while it is in flight go out in the next one,
 * which carries all of them, so a slow store gets fewer, larger writes instead of a queue
 * that grows with every flush. That queue is a stall: a new write chained every 120 ms
 * whether or not the last one has finished.
 */
function writeTab(tabId: number): Promise<void> {
  unwritten.add(tabId);
  const inFlight = writes.get(tabId);
  if (inFlight) return inFlight;
  const run: Promise<void> = (async () => {
    await null; // registered in `writes` before the first check below
    try {
      while (unwritten.has(tabId)) {
        unwritten.delete(tabId);
        const state = liveByTab.get(tabId);
        // The tab may have closed while earlier writes were in flight.
        if (state === undefined || closedTabs.has(tabId)) return;
        await writeState(state);
      }
    } finally {
      // Synchronous with the loop's last check, so a change made after it starts a new write.
      // Nothing else can have registered: a new write starts only when none is in flight.
      writes.delete(tabId);
    }
  })();
  writes.set(tabId, run);
  return run;
}

async function writeState(state: TabState): Promise<void> {
  const tabId = state.tabId;
  try {
    await putTabState(state);
    writeFailed.delete(tabId);
    scheduleClean(tabId);
    // Not awaited: the check reads the whole store, and this tab's next write should not
    // queue behind it.
    void reclaimIfNearQuota(tabId);
  } catch (err) {
    // The store is full, or unavailable. When full, free space a step at a time, trying the
    // write again after each, so no more goes than the write needs: one step and one retry
    // would fail the write while kept cookie records a later step would drop still held the
    // room. When unavailable, nothing is freed: room does not help, and freeing would drop
    // every open tab's kept records for an error that is not about room. When the write
    // still fails, the store is missing this batch's mutations, and saying so is all that is
    // left. Retrying the same write with `incomplete` set fails for the same reason and
    // reports nothing.
    let refused = isQuotaError(err);
    // The store's keys, read once for every step: each read of them reads every value too.
    const keys = refused ? await storedKeys().catch(() => undefined) : undefined;
    for (let step = 0; refused && keys !== undefined && step < RECLAIM_STEPS; step++) {
      if ((await reclaimSessionSpace(tabId, { keptRecords: true, keys })) === 0) break;
      try {
        await putTabState(state);
        writeFailed.delete(tabId);
        scheduleClean(tabId);
        return;
      } catch (retryErr) {
        refused = isQuotaError(retryErr);
      }
    }
    writeFailed.add(tabId);
    // Set on the working state too, so the next write that does land carries it.
    markIncomplete(state, "write-failed");
  }
}

/**
 * Apply pending mutations now. Call before reading state for display.
 *
 * Cancels the timer rather than waiting out the window: a reader is asking now, and 120ms
 * of latency on every popup open would be a poor trade for a batching optimization they
 * never see. It does not wait for storage. The working state is what the store will hold
 * once the write lands, and a reader that waits for the store waits behind every other
 * tab's writes too.
 */
export async function settleTab(tabId: number): Promise<void> {
  const timer = flushTimers.get(tabId);
  if (timer !== undefined) {
    clearTimeout(timer);
    flushTimers.delete(tabId);
  }
  await applyPending(tabId).catch(() => undefined);
}

/** Reset a tab's observations on a new top-level navigation. */
export async function resetTab(tabId: number, topSite: string, finalUrl: string): Promise<void> {
  // A new page: an earlier failed write lost the previous page's mutations, not this one's.
  // If the reset's own write fails, the flag comes back.
  writeFailed.delete(tabId);
  await updateTabState(tabId, (s) => {
    const fresh = emptyTabState(tabId);
    // The page being left keeps running until the new one commits; its documents are
    // retired so what it does meanwhile is not counted here (see documents.ts). When no
    // page committed since the last reset, the navigation it started was abandoned and the
    // page being left is still the one retired then: keep those, or its unload writes
    // would land on the page after.
    const page = s.pageDocuments ?? [];
    const retiredDocuments = page.length > 0 ? page : (s.retiredDocuments ?? []);
    // An error page stays on screen until a navigation commits, so its error outlives the
    // start of the next one to the same address: Chrome retries a failed load on its own
    // about a second later, and a retry that fails again ends as net::ERR_ABORTED with the
    // same error page still showing (seen on every corpus run, 2026-09-25). The commit
    // clears it (sw.ts). A navigation elsewhere is its own page, whatever it ends as.
    const retry = (s.loadError ?? null) !== null && s.loadErrorUrl === finalUrl;
    Object.assign(s, fresh, {
      topSite,
      finalUrl,
      loadObserved: true,
      retiredDocuments,
      prerenderDocuments: s.prerenderDocuments ?? [],
      pastPages: withPastPage(s),
      restoredFromCache: false,
      awaitingCommit: true,
      heldTopLevel: [],
      loadError: retry ? s.loadError : null,
      loadErrorUrl: retry ? finalUrl : null,
    });
  });
}

// --- Settings (chrome.storage.local: must survive browser restart) ---

/**
 * Cached GPC resource observations, keyed by origin.
 *
 * In SESSION storage: a durable cache keyed by origin is a browsing history on disk,
 * created by a privacy tool. Nothing would transmit it, but it would exist, and that is not
 * a sentence this extension's disclosure should have to contain.
 */
export async function getCachedWellKnown(origin: string): Promise<WellKnownGpc | null> {
  const key = wkKey(origin);
  try {
    const got = await chrome.storage.session.get(key);
    return (got[key] as WellKnownGpc | undefined) ?? null;
  } catch {
    return null; // an unreadable cache is a cache miss, not a failure worth surfacing
  }
}

export async function putCachedWellKnown(origin: string, entry: WellKnownGpc): Promise<void> {
  try {
    await chrome.storage.session.set({ [wkKey(origin)]: entry });
    await evictWellKnownIfNeeded();
  } catch {
    // A failed write means the next navigation re-reads. Costly, not wrong.
  }
}

function wkKey(origin: string): string {
  return `wk:${origin}`;
}

/**
 * Keep the cache bounded.
 *
 * Session storage has a quota, and exhausting it silently fails every write and makes the
 * popup confidently wrong. Evicting the oldest entries is cheap insurance against that
 * failure coming from somewhere unrelated.
 *
 * Throttled, and by key where the browser can list keys: reading the whole store would read
 * every open tab's state and kept cookie records on every navigation to a new origin, to
 * count a few hundred small entries. The cap is generous, so a minute's overshoot costs nothing.
 */
const EVICT_CHECK_MS = 60_000;
let lastEvictCheck = 0;

async function evictWellKnownIfNeeded(max = 500): Promise<void> {
  const now = Date.now();
  if (now - lastEvictCheck < EVICT_CHECK_MS) return;
  lastEvictCheck = now;
  // chrome.storage.session.getKeys needs Chrome 130; the extension runs from 119.
  const area = chrome.storage.session as typeof chrome.storage.session & { getKeys?: () => Promise<string[]> };
  const keys = typeof area.getKeys === "function" ? (await area.getKeys()).filter((k) => k.startsWith("wk:")) : null;
  if (keys !== null && keys.length <= max) return;
  const all = await chrome.storage.session.get(keys);
  const entries = Object.entries(all).filter(([k]) => k.startsWith("wk:")) as [
    string,
    WellKnownGpc,
  ][];
  if (entries.length <= max) return;
  entries.sort((a, b) => a[1].observedAtMs - b[1].observedAtMs);
  const doomed = entries.slice(0, entries.length - max).map(([k]) => k);
  await chrome.storage.session.remove(doomed);
}

export interface Settings {
  /** "Send GPC" (PRD 5.4): the header, and the page property over any owner's value. */
  sendSignal: boolean;
  /**
   * Lock the page property while sending is on: take it back from an extension that
   * replaced it, then make it non-configurable, so an extension that runs later cannot set
   * it either (its attempt throws). Off by default: the lock breaks that extension's write.
   */
  lockSignal: boolean;
  /** Passive observation on/off (D13: on by default, with first-run disclosure). */
  observePassively: boolean;
  /** Show the cookie count on the toolbar icon. */
  showBadge: boolean;
  /** Read each site's published GPC resource. Involves a network request; see settings copy. */
  checkWellKnown: boolean;
  /**
   * Observe how scripts are loaded (provenance). Registers the MAIN-world insertion
   * observer; off leaves the page's insertion methods untouched. Default on.
   */
  observeScriptLoading: boolean;
  /**
   * Limit tracing of GPC reads on pages with very high read volume (read-attribution.ts:
   * the first 5,000 traced, then a sample to a hard cap of 7,000). On by default; off
   * traces every read at a stack capture each. The popup points here when a page went
   * past the cap.
   */
  capReadTraces: boolean;
  /**
   * Check page for messaging that the GPC or Opt-Out signal was honored: the confirmation
   * scan of the top frame's visible text (FR-14). On by default; off registers
   * main-world-no-confirmation.js, and the page's text is never read.
   */
  checkConfirmation: boolean;
  /** Whether the first-run disclosure has been shown. */
  firstRunComplete: boolean;
  /**
   * Carried over from v0.1.4 (set by migrate.ts, never by the defaults). The first-run
   * screen shows these users the state of their signal under the title.
   */
  returningUser: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  sendSignal: true,
  lockSignal: false,
  observePassively: true,
  showBadge: true,
  checkWellKnown: true,
  observeScriptLoading: true,
  capReadTraces: true,
  checkConfirmation: true,
  firstRunComplete: false,
  returningUser: false,
};

/**
 * Read settings, filling in defaults for anything absent.
 *
 * NOTE: settings are written ONCE at install and then only on explicit user action.
 * Defaults written unconditionally at service-worker top level would silently reset the
 * user's choices on every worker wake: a privacy tool overriding the user's opt-out. Never
 * write defaults on wake.
 */
export async function getSettings(): Promise<Settings> {
  const got = await chrome.storage.local.get("settings");
  const stored = (got["settings"] ?? {}) as Partial<Settings>;
  return { ...DEFAULT_SETTINGS, ...stored };
}

/**
 * How often a page load got one half of the signal and not the other (1.43.0), kept in
 * `storage.local` under this key for the bug report's settings line. The header is a
 * request rule and the page property a registered script, and the browser brings each to
 * life on its own schedule after the extension loads, updates or starts; a page that loads
 * in that moment is counted once, by which half it missed. Never reset: the count is the
 * profile's history, and the report is where it is read.
 */
export const SIGNAL_SPLIT_KEY = "signalSplit";

export interface SignalSplitCounts {
  /** Loads where the request that fetched the page carried Sec-GPC and the page reported no property. */
  readonly headerWithoutProperty: number;
  /** Loads where the page reported this extension's property reading true and the request carried no Sec-GPC. */
  readonly propertyWithoutHeader: number;
}

export async function readSignalSplitCounts(): Promise<SignalSplitCounts> {
  const got = await chrome.storage.local.get(SIGNAL_SPLIT_KEY);
  const stored = (got[SIGNAL_SPLIT_KEY] ?? {}) as Partial<Record<keyof SignalSplitCounts, unknown>>;
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  return { headerWithoutProperty: n(stored.headerWithoutProperty), propertyWithoutHeader: n(stored.propertyWithoutHeader) };
}

export async function setSettings(partial: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const next = { ...current, ...partial };
  await chrome.storage.local.set({ settings: next });
  return next;
}

/** Write defaults only if nothing has ever been stored. Safe to call on install only. */
export async function initSettingsIfAbsent(): Promise<void> {
  const got = await chrome.storage.local.get("settings");
  if (got["settings"] === undefined) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }
}
