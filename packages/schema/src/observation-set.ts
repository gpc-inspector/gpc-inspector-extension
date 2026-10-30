// SPDX-License-Identifier: GPL-3.0-only
/**
 * ObservationSet — the complete captured record of one page, and the ONLY input the
 * engine accepts (PRD FR-25, D5). Capture produces it; the engine consumes it; they
 * share nothing else. If a fact isn't in here, the engine cannot use it.
 *
 * This is a pure data structure: no methods, no behavior, deeply readonly. It must be
 * JSON-serializable without loss, because it is the payload of the evidence bundle and
 * must replay through the engine offline months later.
 */

import type { SchemaVersion } from "./version.js";
import type { CookieCaptureCoverage, KeptCookieResponse, NetworkObservation, ScriptInsertion, ScriptInsertionCoverage } from "./observation.js";
import type {
  SignalObservation,
  ConsentApiCall,
  GppObservation,
  UsPrivacyObservation,
  TcfObservation,
  GtmObservation,
  ConfirmationNoticeState,
  CaptureCapabilities,
  WellKnownGpc,
  Tallies,
} from "./signal.js";

/** Capture-environment provenance, recorded once per set (PRD FR-23). */
export interface CaptureContext {
  /** Final URL of the top-level document after redirects. */
  readonly finalUrl: string;
  /** eTLD+1 of the top document, precomputed by capture for party determination. */
  readonly topSite: string;
  readonly extensionVersion: string;
  readonly browserUserAgent: string;
  readonly os: string;
  /** ISO 8601 UTC. */
  readonly capturedAt: string;
  /**
   * Whether observation ran continuously (passive) or was a single popup-open snapshot
   * (PRD D5, D13). Affects nothing in the engine; recorded for the bundle.
   */
  readonly mode: "passive" | "on-open";
  /** True if capture was marked incomplete, for any of `incompleteReasons`. */
  readonly incomplete: boolean;
  /**
   * Why the capture is incomplete (1.22.0), sorted. Empty when it is not. The reasons lose
   * different things, so the popup says different things: a worker reclaim loses only the
   * request list, while a failed storage write can leave the counts stale. Absent in older
   * bundles, where `incomplete` stands with no reason given.
   */
  readonly incompleteReasons?: readonly IncompleteReason[];
  /**
   * Whether capture saw this document start loading (1.14.0). False for a tab that was
   * already open when the extension was installed, updated or re-enabled: only requests
   * made afterwards were seen, and no content script ran in the page. False too for a page
   * restored from the back/forward cache (1.39.0, `restoredFromCache`). Absent in bundles
   * recorded before 1.14.0, which readers treat as true.
   */
  readonly loadObserved?: boolean;
  /**
   * The top document was restored from the browser's back/forward cache (1.39.0). It loaded
   * earlier, under a capture that the navigation away from it replaced, so this capture has
   * only what the page did after it was restored, and `loadObserved` is false. The signal
   * fields are the page's own report from that load: the document is the same one, so they
   * still hold. Absent when the page was not restored.
   */
  readonly restoredFromCache?: boolean;
  /**
   * One id per capture (1.24.0): created when capture of this document began and carried
   * by every bundle sealed from it, so a masked copy, an unmasked file and the readable
   * text of one capture name the same scan. Absent in bundles recorded before 1.24.0,
   * whose bundle-level `scanId` was generated at each export.
   */
  readonly scanId?: string;
  /**
   * The top document did not load (1.31.0): the network error Chrome reported for it, such
   * as `net::ERR_NAME_NOT_RESOLVED`. Chrome shows its own error page in its place, and no
   * content script runs there, so the page reported nothing: no property value, no reads, no
   * confirmation scan. Only the requests made before the failure were seen. Absent or null
   * when the document loaded, and in bundles recorded before 1.31.0.
   */
  readonly loadError?: string | null;
  /**
   * Whether the request that fetched the top document carried `Sec-GPC` (1.43.0): true or
   * false once the browser reported that request, null where it reported none (a site the
   * browser keeps the extension off, a page it did not fetch). With the page's own report of
   * the property, this tells a load where the header went out and the property was not set
   * (the extension's registered script missed the load) from one where neither happened.
   * Absent in bundles recorded before 1.43.0.
   */
  readonly documentSigned?: boolean | null;
  /**
   * True when this extension's page property reads true and was set after the page had
   * loaded (1.44.0): the extension's start-up pass, after an install, an update, a reload or
   * a browser start, injected its scripts into a page open before they could run, or turned
   * sending on in a page that loaded with it off. Scripts that ran before then read no
   * signal, so a count of reads covers only what ran after. Absent otherwise, and in bundles
   * recorded before 1.44.0.
   */
  readonly propertySetLate?: boolean;
}

/** Which compiled list of cookie names, by source, version, commit and hash (1.25.0). */
export interface OwnerListProvenance {
  readonly source: string;
  readonly version: string;
  readonly commit: string;
  readonly hash: string;
}

/**
 * What made a capture incomplete (1.22.0).
 *
 *   worker-restarted      the service worker was reclaimed and the request list with it;
 *                         the tallies and everything else survived
 *   write-failed          a write to session storage did not land; counts may be stale
 *   read-failed           the tab's stored state could not be read; everything before is lost
 *   delivery-gap          the content scripts observed things that never reached the worker
 *   consent-calls-capped  the per-tab list of consent API call records was full
 *   prerender-lost        the page was prerendered, and some of what it did before it was
 *                         shown was not kept: the worker stopped while it waited, or it did
 *                         more than the worker holds for one (1.38.0)
 */
export type IncompleteReason =
  | "worker-restarted"
  | "write-failed"
  | "read-failed"
  | "delivery-gap"
  | "consent-calls-capped"
  | "prerender-lost";

export interface ObservationSet {
  readonly schemaVersion: SchemaVersion;
  readonly context: CaptureContext;

  /** Signal-side facts: what we sent, who set it, who read it. */
  readonly signal: SignalObservation;

  /** Every network observation, including redirect hops. */
  readonly network: readonly NetworkObservation[];

  /**
   * The observations that set a cookie and were lost with the list, kept in session storage
   * (1.27.0), so the Requests tab can list them after a worker reclaim empties `network`.
   * Only those whose id `network` lacks: where it holds an observation, it is the record. An
   * earlier 1.27.0 or later bundle can carry the others too, and a reader skips them. Never
   * read by the engine. Absent in older bundles.
   */
  readonly keptCookieResponses?: readonly KeptCookieResponse[];
  /**
   * Not every cookie-setting observation was kept: past KEPT_COOKIE_RESPONSE_CAP, or dropped
   * to make room in session storage, which drops these before anything else of an open tab.
   */
  readonly keptCookieResponsesIncomplete?: true;

  /** Every consent-API call we observed. */
  readonly consentApiCalls: readonly ConsentApiCall[];

  /** Decoded GPP broadcast, or null if none observed. */
  readonly gpp: GppObservation | null;

  /** US Privacy across three surfaces, or null if none observed. */
  readonly usPrivacy: UsPrivacyObservation | null;

  /**
   * Decoded TCF state, or null if none observed. A GDPR mechanism, unrelated to GPC
   * (see TcfObservation) — carried here as plain observation data, not a finding, for
   * exactly the same reason `gpp` and `usPrivacy` are: it has no "wrong" state, so
   * there is no evaluative claim for a finding to make.
   */
  readonly tcf: TcfObservation | null;

  /** Tag-manager state. `present: false` when no container detected. */
  readonly gtm: GtmObservation;

  /**
   * Confirmation-notice scan result. "not-detected" is recorded only once the timed scans
   * have ended without a match (1.41.0); until then, and on a page that closed before, it
   * stays "indeterminate". "not-checked" when the scan was turned off in Settings as the page
   * loaded (1.42.0): the page was not read, so nothing is claimed about it.
   */
  readonly confirmationNotice: ConfirmationNoticeState;

  /**
   * The page's words that matched, on one line, when `confirmationNotice` is "detected": what
   * the Overview quotes (1.41.0). The matched phrase only, not the text around it. Absent
   * otherwise, and in a bundle made before 1.41.0.
   */
  readonly confirmationText?: string;

  /**
   * Which capture capabilities installed. A false here means the corresponding
   * observation is UNAVAILABLE, not absent — the difference between "the site did not do
   * this" and "we could not look".
   */
  readonly capabilities: CaptureCapabilities;

  /**
   * The site's published GPC resource, when it was checked. null when the check is off in
   * settings or has not run — which is NOT the same as the site having no file, and is why
   * absence is represented by a null rather than a `present: false`.
   */
  readonly wellKnown: WellKnownGpc | null;

  /**
   * Every script and iframe URL the page inserted, with the distilled stack of each
   * distinct insertion (provenance, 1.12.0). Absent from a bundle recorded before the
   * observer existed; empty with `scriptInsertionCoverage.recorded === 0` means the page
   * inserted nothing dynamically. See ScriptInsertion for why this is not part of
   * `network`.
   */
  readonly scriptInsertions?: readonly ScriptInsertion[];
  /**
   * What the insertion observer covered. null when the capability is off or the observer
   * did not install; absent from an older bundle.
   */
  readonly scriptInsertionCoverage?: ScriptInsertionCoverage | null;
  /**
   * Page-initiated requests that never touch the DOM (pixels, fetch, XHR, beacons), with
   * the distilled stack of each distinct initiator (provenance). Same record shape and
   * the same resolution as `scriptInsertions`; kept apart because the two observers are
   * measured apart and because a request is not an execution of anything.
   */
  readonly requestInitiators?: readonly ScriptInsertion[];
  readonly requestInitiatorCoverage?: ScriptInsertionCoverage | null;

  /**
   * What sat in front of the `document.cookie` accessor in the top frame (1.23.0). Absent
   * from an older bundle and from a capture whose top frame never reported it.
   */
  readonly cookieCoverage?: CookieCaptureCoverage;

  /**
   * The list of container owners' cookie names the worker charged this capture's cookies by
   * (1.25.0): a cookie written inside a tag container counts only when that list gives its
   * name to the container's owner. Absent from an older bundle, whose tallies were counted
   * with no such list.
   */
  readonly ownerList?: OwnerListProvenance;

  /**
   * Complete counts, maintained as observations arrive and never evicted.
   *
   * `network` below is a retained SAMPLE bounded by the storage quota; these are not. Any
   * number shown to a person should come from here, so that truncation changes what can be
   * enumerated and never what is counted.
   */
  readonly tallies: Tallies;
}

/**
 * The kept cookie records the request list no longer holds (1.27.0): what a reclaim took.
 * A record whose every set was a probe, taken back out as it was from its request, set
 * nothing and is left out. The worker sends these, the Requests tab lists them, and an issue
 * report counts them, so the three agree.
 */
export function lostKeptRecords(obs: {
  readonly network: readonly NetworkObservation[];
  readonly keptCookieResponses?: readonly KeptCookieResponse[] | undefined;
}): KeptCookieResponse[] {
  const kept = obs.keptCookieResponses ?? [];
  if (kept.length === 0) return [];
  const held = new Set(obs.network.map((n) => n.id));
  return kept.filter((k) => !held.has(k.id) && k.setCookies.length > 0);
}
