// SPDX-License-Identifier: GPL-3.0-only
/**
 * The MAIN <-> ISOLATED content-script protocol.
 *
 * These two scripts both run at document_start with NO GUARANTEED ORDER, and they cannot
 * share variables — MAIN world sees the page's globals, ISOLATED sees chrome.*. DOM
 * events are the only channel both can reach.
 *
 * The race this protocol solves (observed on a real page): a state MAIN dispatches once,
 * immediately, is lost forever when MAIN runs first, because the bridge has not yet
 * attached its listener. The capture then reports `source: "none"` while simultaneously
 * counting 2,040 property reads, which is self-contradictory.
 *
 * So a request/response pair is layered over the one-shot push, and the state arrives
 * regardless of which script initializes first:
 *
 *   MAIN first   -> its push is lost, then the bridge asks and MAIN answers.
 *   BRIDGE first -> its request is lost, then MAIN pushes and the bridge hears it.
 *
 * Deliberately event-only, never a DOM attribute for the bridge to read at leisure: simpler,
 * but a page-visible marker, a fingerprinting surface this extension must not add.
 *
 * Every event below goes over the private node channel.ts hands from MAIN to the bridge,
 * never over `document`: there, a page script could send any of them and its payload would
 * be recorded as an observation of the page.
 */

/** MAIN -> ISOLATED: here is my signal state. */
export const STATE_EVENT = "__gpcInspectorState";

/** ISOLATED -> MAIN: I am listening now; please (re)send your state. */
export const STATE_REQUEST_EVENT = "__gpcInspectorStateReq";

/**
 * MAIN -> ISOLATED: a page script just read navigator.globalPrivacyControl.
 *
 * Carries a `SampledRead` detail on the sampled minority of reads and nothing on the rest.
 * The bare event is what keeps the COUNT complete: attribution is sampled because capturing
 * a stack on a path that runs thousands of times per page is not free, but every read is
 * still counted. See observe/read-attribution.ts.
 */
export const READ_EVENT = "__gpcInspectorRead";

/** MAIN -> ISOLATED: a consent-API observation (call, GPP payload, GTM state, notice). */
export const OBSERVE_EVENT = "__gpcInspectorObserve";

export interface SignalStateDetail {
  readonly source: string;
  readonly readTracking: string;
  readonly asserted: boolean;
  /**
   * What a page script reading `navigator.globalPrivacyControl` would get in THIS frame,
   * as of this announcement (PRD FR-4's tri-state: true = asserting, false = supported but
   * off, "absent" = no property at all).
   *
   * The only observation of the value there is. The worker cannot derive it: who owns the
   * property and what it says are separate facts, and a native or other-extension owner
   * can perfectly well own it and report `false`.
   */
  readonly value: true | false | "absent";
  /** Whether the report is the page's top document's; the worker keeps it over a frame's. */
  readonly topFrame?: boolean;
}

/**
 * MAIN -> ISOLATED observation payloads. A discriminated union so the bridge can relay
 * each to the right service-worker message without knowing the details.
 */
export type ObserveDetail =
  | { readonly kind: "consent-call"; readonly call: unknown }
  | { readonly kind: "gpp"; readonly gpp: unknown }
  | { readonly kind: "usp"; readonly value: string | null }
  | { readonly kind: "tcf"; readonly tcf: unknown }
  | { readonly kind: "gtm"; readonly gtm: unknown }
  | { readonly kind: "js-cookie"; readonly cookie: unknown }
  /** What sits in front of the document.cookie accessor (1.23.0). Latched flags. */
  | { readonly kind: "cookie-coverage"; readonly coverage: unknown; readonly topFrame: boolean }
  | { readonly kind: "capabilities"; readonly capabilities: unknown }
  /** Read tracing thinned out on this page (the cap in read-attribution.ts). Once per page. */
  | { readonly kind: "read-trace-cap" }
  /** A script or iframe insertion, from the dynamically registered observer. */
  | { readonly kind: "script-insertion"; readonly insertion: unknown }
  | { readonly kind: "script-insertion-coverage"; readonly coverage: unknown; readonly topFrame: boolean }
  /** A page-initiated request (pixel, fetch, XHR, beacon), from the same observer script. */
  | { readonly kind: "request-initiation"; readonly request: unknown }
  | { readonly kind: "request-initiation-coverage"; readonly coverage: unknown; readonly topFrame: boolean }
  | {
      readonly kind: "confirmation";
      readonly state: "detected" | "not-detected";
      /** The matched text plus context. Null when nothing matched. */
      readonly evidence: string | null;
      /** The matched words alone. Null when nothing matched. */
      readonly phrase: string | null;
      readonly patternIndex: number | null;
      /** The report of the last timed scan: only its miss says the scans found nothing. */
      readonly final: boolean;
    };
