// SPDX-License-Identifier: GPL-3.0-only
/**
 * Observation primitives — the raw, captured facts. No interpretation lives here;
 * that is the engine's job. Everything in this file is something the capture layer
 * literally observed on the wire or in the DOM.
 *
 * Two rules in this file come directly from a Set-Cookie harness run on real sites
 * (2026-07-21), and both are load-bearing:
 *
 *  1. `resourceType` is an OPEN string, not a closed union. The harness's real-site
 *     browsing produced `media`, `websocket`, and `other` — types the local test
 *     target never generated. A closed enum would make the capture layer drop
 *     observations it should record. We provide KNOWN_RESOURCE_TYPES for reference
 *     and completion, but the field accepts any string Chrome emits.
 *
 *  2. Responses carry `isRedirectHop`. The harness proved that ~40% of image-tracking
 *     Set-Cookie headers on a real site arrived on 302 redirect responses, visible to
 *     onHeadersReceived but NOT to onResponseStarted. Redirect-hop cookie setting is a
 *     signature tracking-pixel pattern, so a cookie set on a redirect is a first-class
 *     observation, never discarded.
 */

/** Reference list of resource types Chrome is known to emit. NOT exhaustive and NOT enforced. */
export const KNOWN_RESOURCE_TYPES = [
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "csp_report",
  "media",
  "websocket",
  "webbundle",
  "other",
] as const;

export type KnownResourceType = (typeof KNOWN_RESOURCE_TYPES)[number];

/**
 * Resource type as reported by the browser. Accepts KnownResourceType for editor
 * completion, but any string is valid — the capture layer records whatever Chrome
 * emits. The `(string & {})` keeps the known literals visible in tooling without closing
 * the type.
 */
export type ResourceType = KnownResourceType | (string & {});

/** How the observation's response headers were captured (PRD FR-8). */
export type CaptureMethod =
  | "onHeadersReceived" // primary path; fires per redirect hop
  | "onResponseStarted" // tamper-proof cross-check; final responses only
  | "documentCookie" // MAIN-world document.cookie setter interception (FR-9)
  | "cookieStore"; // cookieStore API (FR-9)

/** A single HTTP header, name preserved as observed, lowercased name for matching. */
export interface Header {
  /** Header name exactly as observed (e.g. "Set-Cookie"). */
  readonly name: string;
  /** Lowercased name, precomputed for stable matching. */
  readonly nameLower: string;
  /** Header value. Subject to redaction before export (FR-24) — see EvidenceBundle. */
  readonly value: string;
}

/** SameSite attribute as observed on a Set-Cookie header. */
export type SameSite = "Strict" | "Lax" | "None" | "unspecified";

/**
 * A cookie observed being set — via Set-Cookie response header OR document.cookie/
 * cookieStore in the page. `partitioned` (CHIPS) is captured because a partitioned
 * cookie cannot do cross-site tracking and must never be presented equivalently to an
 * unpartitioned identifier like IDE (PRD FR-9, edge-case table).
 */
export interface CookieRecord {
  readonly name: string;
  /** Cookie value. Redacted in every report, and in an export unless the reader saves it unmasked (FR-24). */
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  /** Expiry in ms since epoch, or "session" for a session cookie, or null if unknown. */
  readonly expiresMs: number | "session" | null;
  readonly sameSite: SameSite;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  /** CHIPS partitioned attribute. A partitioned cookie is not cross-site capable. */
  readonly partitioned: boolean;
  /** How this cookie was observed. */
  readonly via: CaptureMethod;
  /**
   * For JS-set cookies: the script that wrote it, resolved from the call stack.
   *
   * A cookie set via `document.cookie` has no responding domain, so attribution can only
   * come from the stack — and that frequently fails (bundled code, inline script,
   * tag-manager containers execute vendor code in their own context). null means
   * unattributable, which is recorded honestly rather than guessed: an unattributed cookie
   * is a fact, a misattributed one is a false accusation.
   *
   * Absent for cookies observed on response headers, where the responding domain is the
   * attribution and no inference is needed.
   */
  readonly writerScriptUrl?: string | null;
  /**
   * For JS-set cookies: true when the stack resolved only into a tag-manager container.
   * Not read by the counting rule (1.25.0), which takes the container from
   * `writerScriptUrl` with `containerIdentity`, so a capture from before the rule reads the
   * same. Kept as a record of what capture saw.
   */
  readonly writerViaTagManager?: boolean;
  /**
   * For JS-set cookies (1.23.0): the script of a `document.cookie` wrapper, a consent
   * tool's or the site's own, that the write passed through and attribution stepped over to find the writer, so a
   * bundle shows what was skipped. Absent when nothing was stepped over, from an older
   * bundle, and for response-header cookies.
   */
  readonly writerWrapperUrl?: string;
  /**
   * What the browser's cookie jar held for this cookie when it was checked (1.30.0): the
   * worker reads the jar by the cookie's name and domain a moment after the write.
   *
   * - "landed": the jar holds it with this value.
   * - "not-stored": the jar holds no cookie of that name and domain. The browser did not
   *   store it (its SameSite, Secure or Domain rules, or a request sent without cookies),
   *   or something removed it before the check without the capture seeing it in the
   *   browser. It counts nowhere. A cookie seen removed while it was in the browser is not
   *   marked: it was stored, and it counts (1.40.0, CookieDetail.removedAfterMs).
   * - "unknown": the jar holds one of that name and domain with another value, an older
   *   write's or a later one's. Counted, as before the check.
   *
   * Absent when not checked: a cookie no summary records, a cookie whose key had already
   * landed on this page, a check that could not be made or that the worker did not live to
   * make, and every older bundle. Counted, as before the check. The jar's own value is
   * compared and dropped, never kept.
   */
  readonly jar?: JarState;
}

/** See CookieRecord.jar. */
export type JarState = "landed" | "not-stored" | "unknown";

/**
 * What sat in front of capture's `document.cookie` accessor in the top frame (1.23.0).
 *
 * Capture installs its accessor on the object that owns the native property, so a consent
 * tool that wraps the property later wraps over it, as it would over the browser. Either
 * flag means page writes reach capture through someone else's accessor, and attribution
 * steps over that accessor's frames. Latched: a flag that became true stays true.
 */
export interface CookieCaptureCoverage {
  /**
   * Another accessor sits in front of capture's: the owner's accessor was replaced, or an
   * object between the document and the owner defines its own (Osano, Transcend).
   */
  readonly wrappedOver: boolean;
  /** The document itself carries a `cookie` property of its own (Ketch). */
  readonly onInstance: boolean;
}

/**
 * Whether a cookie record removes a cookie rather than setting one: an expiry at or before
 * the moment it was written (`max-age=0` is recorded as 0). A deletion is never a cookie
 * set, and counting one as a set counts a vendor's clean-up against it. `atMs` is when
 * the record was observed.
 */
/** Hostname of a URL, or "" when it does not parse. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

export function isCookieDeletion(cookie: Pick<CookieRecord, "expiresMs">, atMs: number): boolean {
  return typeof cookie.expiresMs === "number" && cookie.expiresMs <= atMs;
}

/**
 * Whether a record set a cookie: not a deletion, and not one the browser's cookie jar was
 * found not to hold (1.30.0). What every reader that counts or lists cookies set goes by, so
 * the engine's findings, the Requests tab and the worker's counts agree.
 */
export function isCookieSet(cookie: Pick<CookieRecord, "expiresMs" | "jar">, atMs: number): boolean {
  return !isCookieDeletion(cookie, atMs) && cookie.jar !== "not-stored";
}

/**
 * One observed network request and whatever response we saw for it.
 *
 * A request may appear as multiple hops in a redirect chain. Each hop is its own
 * NetworkObservation with `isRedirectHop: true` for the intermediate responses. This
 * is deliberate: cookies set on redirect hops are the finding, not noise.
 */
export interface NetworkObservation {
  /** Stable id for this observation within the set (capture-assigned). */
  readonly id: string;
  /** Final request URL for this hop. */
  readonly url: string;
  readonly method: string;
  readonly resourceType: ResourceType;
  /**
   * The URL of the frame/document that initiated this request, if known. Used with
   * the Public Suffix List to decide first- vs third-party against the TOP document
   * (PRD FR-17), not the immediate parent.
   */
  readonly initiator: string | null;
  /** Whether Sec-GPC: 1 was present on THIS request (the whole point). */
  readonly secGpcPresent: boolean;
  /** Request headers as observed (pre-redaction). */
  readonly requestHeaders: readonly Header[];

  /**
   * Names of cookies this request carried BACK, from its Cookie header. Values are never
   * captured.
   *
   * A cookie set for a domain is returned to that domain on later requests — that is HTTP,
   * not an inference. Recording which names went back turns "this vendor set an identifier"
   * into "this vendor received it again", which is the leg of the exchange that makes the
   * first one consequential.
   *
   * Partitioned cookies are recorded here like any other. A `Partitioned` cookie is keyed
   * to the top-level site and cannot build a cross-site profile, which is a real
   * difference — but whether that difference makes a disclosure lawful is a legal
   * conclusion no regulator has published, and excluding them would encode that conclusion
   * silently. The attribute travels with the fact instead.
   */
  readonly cookiesSent: readonly string[];

  /** HTTP status of the response, or null if no response was observed. */
  readonly statusCode: number | null;
  /** Response headers as observed (pre-redaction), or null if none seen. */
  readonly responseHeaders: readonly Header[] | null;
  /** True if this response is a redirect (3xx) hop rather than a final response. */
  readonly isRedirectHop: boolean;
  /** Cookies set by THIS response's Set-Cookie header(s). */
  readonly setCookies: readonly CookieRecord[];
  /** Which listener produced the response headers for this observation. */
  readonly captureMethod: CaptureMethod;
  /** Event time, ms since epoch. */
  readonly timeMs: number;
  /**
   * Built from its response alone (1.26.0): the request went out before the worker that
   * received the response started, after a worker reclaim or restart, so what it carried was
   * not observed. `secGpcPresent` is false and says nothing, `cookiesSent` is empty, and the
   * request is not counted again. Its cookies are kept by name, never counted (see
   * `EntityCategoryTally.cookieKeysRequestLost`). Absent on every other observation.
   */
  readonly requestLost?: true;
}

/**
 * An observation that set a cookie, kept past a worker reclaim (1.27.0). The request list
 * lives in the worker's memory and a reclaim empties it; this record is written to session
 * storage beside the tab's state, so the Requests tab can still list every cookie the page
 * set. What the tab draws for such a row and no more: the URL without its query (a tag
 * container's id kept, as insertion records keep it), and each cookie without its value,
 * which is never persisted. Nothing counts from it and the engine never reads it.
 */
export interface KeptCookieResponse {
  readonly id: string;
  /** The observation's URL with no query or fragment, a container's `?id=` kept; at most 256 characters. */
  readonly url: string;
  readonly method: string;
  readonly resourceType: ResourceType;
  readonly statusCode: number | null;
  readonly secGpcPresent: boolean;
  readonly isRedirectHop: boolean;
  readonly captureMethod: CaptureMethod;
  readonly timeMs: number;
  /** As on the observation: only its response was seen. */
  readonly requestLost?: true;
  /**
   * The cookies it set, each without its value; a writer's URL shortened as `url` is. A set
   * later found to be a probe is taken back out, as it is from the observation, so this can
   * be empty. A cookie the jar was found not to hold is marked `jar: "not-stored"` whenever
   * the answer came (1.30.0); a landed or unknown answer is on it only when it came before
   * the record was kept, since nothing reads those from a kept record.
   */
  readonly setCookies: readonly Omit<CookieRecord, "value">[];
}

/** Cookie-setting observations kept per tab (1.27.0). Past it, the rest are not kept. */
export const KEPT_COOKIE_RESPONSE_CAP = 2000;

// ---------------------------------------------------------------------------
// Script insertion (provenance, schema 1.12.0)
// ---------------------------------------------------------------------------

/**
 * How a script or iframe element entered the document: the wrapped insertion method, a
 * `document.write` whose text named a src, or the parser (it was in the HTML). The parser
 * value is a POSITIVE record made by enumerating `document.scripts` against the elements
 * the observer saw inserted; an absence in `scriptInsertions` therefore means "loaded by
 * something that is not an element" (a dynamic import, a worker), never "the site's HTML".
 */
export type ScriptInsertionVia =
  // Request initiators reuse the record with these: the API that made the request.
  | "src" // HTMLImageElement.prototype.src setter (a pixel)
  | "fetch"
  | "open" // XMLHttpRequest.prototype.open
  | "sendBeacon"
  | "appendChild"
  | "insertBefore"
  | "replaceChild"
  | "append"
  | "prepend"
  | "before"
  | "after"
  | "replaceWith"
  | "insertAdjacentElement"
  | "insertNode"
  | "write"
  | "parser";

/**
 * One distinct way a given script URL was inserted: the distilled stack at the moment of
 * insertion. A URL inserted the same way again only bumps `count`; a URL inserted from a
 * different stack (the site's HTML and, later, a container) gets a second entry, up to
 * three per record, which is how the same-vendor-loaded-both-ways case stays visible.
 *
 * Frame URLs keep their query (a container's id lives there) and are bounded in length.
 * Extension frames are removed. Inline frames (URL equal to the document's, at
 * document_start or now) are removed and noted in `inlineFrames`, because an inline
 * snippet is not a loader that can be named: `currentScriptKey` says which inline element
 * was executing when the stack was inline-only, which is what turns "inline" into "the
 * site's snippet" or "a Custom HTML tag the container inserted".
 */
export interface ScriptInsertionLoader {
  /** Distinct frame URLs, innermost first, max 6, extension and inline frames removed. */
  readonly insertedBy: readonly string[];
  /**
   * Frames removed as belonging to another wrapper of the same methods (a script-blocking
   * CMP, an APM agent), kept so the bundle shows what was skipped. Measured on real pages:
   * such a frame sits directly beneath ours on nearly every stack and would otherwise be
   * credited with every insertion on the page.
   */
  readonly wrapperFrames?: readonly string[];
  /** At least one inline frame was on the stack. */
  readonly inlineFrames: boolean;
  /**
   * `key` of the inline element's own record when an inline-only stack was resolved
   * through `document.currentScript`; null when there was no inline-only stack to resolve
   * or the current script was not one the observer saw inserted.
   */
  readonly currentScriptKey: string | null;
  /**
   * Every tag-manager frame on the stack, innermost first, query kept. The innermost is
   * the loader; the rest are the containers beneath it on the stack. More than one
   * distinct id was measured as rare and the innermost was the right container each time.
   */
  readonly containerUrls: readonly string[];
  readonly via: ScriptInsertionVia;
  /** Origin of the inserting frame, and whether it was the top frame. On the entry, not
   *  the record, because a top-frame and a sub-frame insertion of one URL share a key. */
  readonly frameOrigin: string;
  readonly topFrame: boolean;
  /** Insertions of this key by this loader. */
  readonly count: number;
  /** First insertion by this loader, ms since epoch. */
  readonly timeMs: number;
}

/**
 * One script or iframe URL and every distinct way it was inserted (provenance 1.12.0).
 *
 * Keyed on the URL without its query so a cache-busted loader is one record. Kept apart
 * from `network` on purpose: `network` is a retained sample bounded by the storage quota;
 * this list is small and bounded on its own terms (300 keys per frame), so a vendor that
 * fell out of the sample still carries provenance. Joined to entities in the engine by
 * classifying `url`, the way `writerScriptUrl` is, which needs no ordering between the
 * request and the insertion message.
 */
export interface ScriptInsertion {
  /** URL without query, capped at 256 characters. */
  readonly key: string;
  /** First full URL seen for this key, capped at 256 characters. */
  readonly url: string;
  /**
   * What was inserted or requested. "script" and "iframe" are element insertions; the
   * rest are page-initiated requests recorded by the request-initiator observer, which
   * never touch the DOM and would otherwise have no provenance at all.
   */
  readonly element: "script" | "iframe" | "image" | "fetch" | "xhr" | "beacon";
  /** Up to three distinct insertion stacks, sorted by `timeMs`. */
  readonly loaders: readonly ScriptInsertionLoader[];
}

/**
 * What the insertion observer covered, so an empty `scriptInsertions` can be told from a
 * wrapper that observed nothing (the `ReadAttribution` pattern). Every count is per page.
 */
export interface ScriptInsertionCoverage {
  /** Script or iframe elements with a resolvable src that were recorded. */
  readonly recorded: number;
  /** Elements found by the `document.scripts` enumeration that the observer had not seen. */
  readonly parser: number;
  /** Insertions of an already-recorded key by an already-recorded loader. */
  readonly duplicates: number;
  /** Inline script elements inserted (recorded by element for currentScript lookups). */
  readonly inline: number;
  /** Inline-only stacks that `document.currentScript` resolved to a recorded element. */
  readonly inlineResolvedByCurrentScript: number;
  /** Script elements whose type does not execute (text/plain, JSON, a gated CMP script). */
  readonly nonExecuting: number;
  /** Script elements whose src was still empty a microtask after insertion. */
  readonly srcUnresolved: number;
  /** Stack captures that threw. */
  readonly stackFailed: number;
  /** Stacks naming more than one distinct container id. */
  readonly ambiguousContainer: number;
  /** Insertions past the per-frame cap, counted only. */
  readonly capExceeded: number;
  /**
   * True when a later check found `Node.prototype.appendChild` no longer the observer's
   * own function: another wrapper (a CMP, an APM agent) replaced it after us and sits on
   * every subsequent stack. Its frames are the `wrapperFrames` the engine removes.
   */
  readonly wrappedOver: boolean;
  /**
   * True when the observer stopped recording after its recorder threw three times on one
   * page. The prototypes stay wrapped and delegating; only the recording stops. Records
   * made before that point stand.
   */
  readonly selfDisabled: boolean;
}
