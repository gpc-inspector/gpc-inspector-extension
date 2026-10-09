// SPDX-License-Identifier: GPL-3.0-only
/**
 * Consent-API instrumentation (PRD FR-11, FR-12, FR-13).
 *
 * Wraps `__gpp`, `__uspapi`, and `__tcfapi` in the MAIN world to observe two things:
 *   1. WHO called them, and how often — the "did this vendor even check?" question.
 *   2. WHAT they returned — the GPP and US Privacy strings the site broadcasts to its
 *      advertising vendors, which is where the flagship finding lives.
 *
 * THE LATE-DEFINITION PROBLEM
 *
 * A CMP defines `window.__gpp` whenever its script happens to load, which is almost never
 * before our document_start injection. So we cannot simply wrap what exists — at
 * document_start, nothing exists yet.
 *
 * The fix is to install an accessor on `window` that intercepts the CMP's own assignment:
 * when the CMP writes `window.__gpp = fn`, our setter stores `fn` and hands back a
 * wrapper. Page scripts calling `window.__gpp(...)` get the wrapper, which records the
 * call and delegates. If no CMP ever defines it, the getter returns undefined exactly as
 * it would have, so feature-detection (`if (window.__gpp)`) is unaffected.
 *
 * WHAT THIS MUST NOT DO
 *
 * It must not change any value the page or the CMP sees. We record and delegate; we never
 * substitute, block, or alter arguments or results. An instrumentation layer that changed
 * behavior would make every observation a measurement of ourselves.
 */

import { isTagManagerFrame } from "@gpc-inspector/schema";

export type ConsentApiName = "__gpp" | "__uspapi" | "__tcfapi";

export interface RecordedCall {
  readonly api: ConsentApiName;
  readonly command: string | null;
  /** Best-effort caller script URL from the stack. null when unattributable. */
  readonly callerScriptUrl: string | null;
  /** True when the caller frame resolved into a tag-manager container. */
  readonly viaTagManager: boolean;
  /** Every tag-manager frame on the stack, innermost first. See schema ConsentApiCall. */
  readonly containerUrls: readonly string[];
  readonly timeMs: number;
}

/**
 * Whether `attributeCaller` skips an inline frame (one whose URL is the document's) when a
 * named frame lies beneath it.
 *
 * ON. Without the skip, a `__gpp` call from a GTM Custom HTML snippet resolves to the page
 * URL, classifies first-party, and drops out of the vendor rule as neither a vendor check
 * nor a container check; with the skip it is a container check by the container beneath
 * the snippet. Measured 2026-09-13 on the fixture and five real pages: inline-only stacks
 * are the exception. The constant stays so the tests can exercise both settings and so it
 * can be turned off in one place.
 */
export const SKIP_INLINE_FRAMES = true;

/**
 * Skip A: whether cookie capture steps over a `document.cookie` wrapper that sits in front
 * of ours, a consent tool's or the site's own.
 *
 * Our accessor is installed on the object that owns the native property, so a tool that
 * wraps the property later wraps over us, and every page write reaches us through the
 * tool's frames. Without the skip, 430 of 430 writes on news-f.example named Osano. Used
 * by cookie capture only, and only when the capture reports that it is wrapped over. The
 * constant stays so the tests can exercise both settings.
 */
export const SKIP_COOKIE_WRAPPER_FRAMES = true;

/**
 * Skip B: whether attribution steps over a wrapped DOM insertion method. A script inserted
 * inline by a tag manager runs inside the insertion call and its frames carry no URL, so
 * the next frame with one is the wrapper a consent tool put on `insertBefore`: without the
 * skip, `nwf_byline` on news-f.example named Osano, not the Tag Manager container that
 * inserted the snippet. Applies to cookie writes, GPC reads and consent calls, which share
 * this function and the same error.
 */
export const SKIP_DOM_METHOD_FRAMES = true;

/**
 * How V8 renders a function installed as a DOM insertion method under another name. A
 * genuine loader calls the method from its own function and is not rendered this way.
 */
const DOM_METHOD_LABELS = [
  "[as insertBefore]",
  "[as appendChild]",
  "[as append]",
  "[as prepend]",
  "[as replaceChild]",
  "[as insertAdjacentElement]",
] as const;

/**
 * How a `document.cookie` wrapper's frame renders, either of two ways. Called on the
 * document, V8 names the receiver: `HTMLDocument.set [as cookie]` when a tool replaces the
 * prototype's accessor (Osano, Transcend), `HTMLDocument.n` when it defines one on the
 * document itself (Ketch), which carries no label. A function whose inferred name already
 * holds a dot drops the receiver and keeps the label: `c.set [as cookie]` on airline-a.example and
 * `Rk.c.set [as cookie]` on retailer-a.example, both the sites' own scripts.
 */
const DOCUMENT_RECEIVER = "HTMLDocument.";
const COOKIE_LABEL = "[as cookie]";

export interface AttributedCaller {
  /** The first usable frame's URL (the code that made the call), or null. */
  readonly url: string | null;
  /** True when that first frame is a tag-manager container. */
  readonly viaTagManager: boolean;
  /**
   * Every tag-manager frame anywhere on the stack, innermost first, deduplicated. Kept
   * regardless of what `url` resolved to: a vendor script called from inside a container
   * tag has the vendor on top and the container beneath, and both facts are wanted.
   */
  readonly containerUrls: readonly string[];
  /**
   * The stack lines beneath the cookie wrapper skip A stepped over, or beneath ours when
   * nothing was: the page's call chain, positions included. Two writes whose chains agree
   * as far as both stacks reach came from one page call; cookie capture uses it to drop a
   * tool's second call of the original setter for one page write.
   */
  readonly below: readonly string[];
  /** The script of the cookie wrapper skip A stepped over, or null when none was. */
  readonly wrapperUrl: string | null;
}

/** What only some callers of `attributeCaller` know. Every field is optional. */
export interface AttributionOptions {
  /**
   * Cookie capture only: another accessor sits in front of ours, so the frames directly
   * beneath ours may be a tool's wrapper rather than the writer. Skip A runs only then.
   */
  readonly cookieWrappedOver?: boolean;
  /** Skip A. Defaults to SKIP_COOKIE_WRAPPER_FRAMES. */
  readonly skipCookieWrapper?: boolean;
  /** Skip B. Defaults to SKIP_DOM_METHOD_FRAMES. */
  readonly skipDomMethod?: boolean;
}

/** One line of a V8 stack. */
export interface StackFrame {
  /** The line without its leading `at `. */
  readonly line: string;
  /** What precedes the location: `HTMLDocument.set [as cookie]`, or "" for a bare location. */
  readonly name: string;
  /** The first http(s) URL in the location, without line and column, or null. */
  readonly url: string | null;
  /** A frame from an extension: ours, or another extension's. Never an answer. */
  readonly extension: boolean;
  /** Carries a line and column: code from some script, as opposed to a builtin. */
  readonly positioned: boolean;
}

const URL_IN_LOCATION = /https?:\/\/[^\s):]+/;
const EXTENSION_LOCATION = /(?:chrome|moz|safari-web)-extension:\/\//;
const POSITION = /:\d+:\d+$/;

/** Split a V8 stack into frames, innermost first. The message line is dropped. */
export function parseStack(stack: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const raw of stack.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("at ")) continue;
    const line = trimmed.slice(3);
    // `name (location)`, or a bare location. The first " (" separates them: a name never
    // holds one, and an eval location nests its own parentheses.
    const open = line.indexOf(" (");
    const named = open >= 0 && line.endsWith(")");
    const name = named ? line.slice(0, open) : "";
    const location = named ? line.slice(open + 2, -1) : line;
    frames.push({
      line,
      name,
      url: URL_IN_LOCATION.exec(location)?.[0] ?? null,
      extension: EXTENSION_LOCATION.test(location),
      positioned: POSITION.test(location),
    });
  }
  return frames;
}

/**
 * Where the frames beneath ours start, and how far the run of one script directly
 * beneath them reaches (exclusive). `runEnd === start` when that first frame has no URL.
 */
export function leadingRun(frames: readonly StackFrame[]): { start: number; runEnd: number } {
  let start = 0;
  while (start < frames.length && frames[start]!.extension) start++;
  const runUrl = frames[start]?.url ?? null;
  let runEnd = start;
  if (runUrl !== null) while (runEnd < frames.length && frames[runEnd]!.url === runUrl) runEnd++;
  return { start, runEnd };
}

// Which frames mean "a tag manager ran this", not "this vendor ran this", is decided by
// the schema package's tag-manager module, so capture, engine and popup share one answer.
// It covers GTM and the other managers too (Matomo, Piwik PRO, Ensighten, Commanders Act,
// self-hosted Tealium and Launch).

/**
 * Attribute a call to the script that made it, from the JS stack.
 *
 * Deliberately conservative. A frame that resolves into a tag-manager container tells us
 * the container ran the code, NOT which vendor's code it was — GTM executes vendor tags
 * inside its own context, so the vendor has no frame of its own. Reporting the container
 * as the caller would credit or blame Google for every vendor on the page, so those calls
 * are marked unattributable instead (PRD 5.5).
 *
 * `url` is the FIRST usable frame and nothing else, which is right for "who made this
 * call". `containerUrls` walks the whole stack, because which container a call happened
 * under is a different question with a different answer: a Custom HTML snippet's frame
 * is the page URL and the container is three frames down.
 *
 * Two wrappers are stepped over first, each behind its own constant. Skip A, cookie
 * capture only and only when wrapped over: someone else's `document.cookie` accessor
 * directly beneath ours. Skip B, for every caller: a function installed as a DOM
 * insertion method (`[as insertBefore]` and the rest) with another script beneath it.
 *
 * @param documentUrl the page's URL, needed only to recognize inline frames when
 *                    `skipInline` is on; frames equal to it are inline script.
 * @param skipInline  skip an inline frame when a named frame lies beneath it. Defaults to
 *                    SKIP_INLINE_FRAMES; see that constant.
 * @param options     skip A's gate and the two skips' settings; see AttributionOptions.
 */
export function attributeCaller(
  stack: string | undefined,
  documentUrl?: string,
  skipInline: boolean = SKIP_INLINE_FRAMES,
  options: AttributionOptions = {},
): AttributedCaller {
  if (!stack) return { url: null, viaTagManager: false, containerUrls: [], below: [], wrapperUrl: null };
  // The callers in the MAIN world do not pass the document URL; read it here so the skip
  // applies to them. Tests run where `location` is undefined and pass it explicitly.
  if (documentUrl === undefined && typeof location !== "undefined") documentUrl = location.href;
  const skipWrapper = options.skipCookieWrapper ?? SKIP_COOKIE_WRAPPER_FRAMES;
  const skipDomMethod = options.skipDomMethod ?? SKIP_DOM_METHOD_FRAMES;

  const frames = parseStack(stack);
  const containerUrls: string[] = [];
  for (const f of frames) {
    if (f.url !== null && isTagManagerFrame(f.url) && !containerUrls.includes(f.url)) containerUrls.push(f.url);
  }

  // Skip A. The leading run is the frames directly beneath ours that share one script; its
  // deepest frame called on the document, or run as a `cookie` setter, is the tool's
  // accessor, and the writer is beneath it. No such frame means the tool called us directly, from its own code, and is the
  // writer: nothing is skipped.
  const { start, runEnd } = leadingRun(frames);
  let from = 0;
  let wrapperUrl: string | null = null;
  if (skipWrapper && options.cookieWrappedOver === true) {
    for (let i = runEnd - 1; i >= start; i--) {
      const name = frames[i]!.name;
      if (!name.startsWith(DOCUMENT_RECEIVER) && !name.endsWith(COOKIE_LABEL)) continue;
      wrapperUrl = frames[start]!.url;
      // Nothing at all beneath the accessor: the wrapper's own script is the writer.
      if (i === frames.length - 1) {
        const f = frames[i]!;
        return { url: f.url, viaTagManager: isTagManagerFrame(f.url!), containerUrls, below: [], wrapperUrl };
      }
      from = i + 1;
      break;
    }
  }
  const below = frames.slice(wrapperUrl !== null ? from : start).map((f) => f.line);

  const isInline = (raw: string): boolean =>
    documentUrl !== undefined && stripHash(raw) === stripHash(documentUrl);

  for (let i = from; i < frames.length; i++) {
    const f = frames[i]!;
    const raw = f.url;
    if (raw === null) continue;
    const beneath = frames.slice(i + 1);
    // An inline frame is only skipped when something named lies beneath it; on its own it
    // is still the answer (the site's own inline snippet read the property).
    if (skipInline && isInline(raw) && beneath.some((g) => g.url !== null && !isInline(g.url))) continue;
    // Skip B. A wrapped insertion method passes the call through; the code beneath it made
    // it. "Another script" includes one with no URL, such as an inline snippet: stepping
    // over the wrapper then leaves nothing named, and the answer is null, not the wrapper.
    if (
      skipDomMethod &&
      DOM_METHOD_LABELS.some((label) => f.name.endsWith(label)) &&
      beneath.some((g) => !g.extension && (g.url !== null ? g.url !== raw : g.positioned))
    ) {
      continue;
    }

    return { url: raw, viaTagManager: isTagManagerFrame(raw), containerUrls, below, wrapperUrl };
  }

  return { url: null, viaTagManager: false, containerUrls, below, wrapperUrl };
}

function stripHash(url: string): string {
  const i = url.indexOf("#");
  return i < 0 ? url : url.slice(0, i);
}

/**
 * Extract the command argument.
 *
 * All three APIs take the command as their first argument (__gpp('getGPPData', cb),
 * __uspapi('getUSPData', 1, cb), __tcfapi('getTCData', 2, cb)), so one implementation
 * covers them. A non-string first argument means we cannot name the command, and we
 * record null rather than guessing.
 */
function commandOf(args: unknown[]): string | null {
  const first = args[0];
  return typeof first === "string" ? first : null;
}

/**
 * Install interception for one API name.
 *
 * @param onCall  invoked for every call, with the recorded metadata
 * @param onResult invoked when a callback delivers data, so the caller can capture
 *                 GPP/USP payloads without re-implementing each API's callback shape
 */
export function interceptConsentApi(
  win: Window & typeof globalThis,
  api: ConsentApiName,
  onCall: (call: RecordedCall) => void,
  onResult: (api: ConsentApiName, command: string | null, data: unknown) => void,
): boolean {
  let real: unknown = (win as unknown as Record<string, unknown>)[api];

  const wrapper = function (this: unknown, ...args: unknown[]): unknown {
    const command = commandOf(args);

    let stack: string | undefined;
    try {
      stack = new Error().stack ?? undefined;
    } catch {
      stack = undefined;
    }
    const { url, viaTagManager, containerUrls } = attributeCaller(stack);

    try {
      onCall({
        api,
        command,
        callerScriptUrl: url,
        viaTagManager,
        containerUrls,
        timeMs: Date.now(),
      });
    } catch {
      // Instrumentation must never break the page's consent flow.
    }

    if (typeof real !== "function") return undefined;

    // Wrap a callback argument so we can observe the result without altering it.
    const wrappedArgs = args.map((arg) => {
      if (typeof arg !== "function") return arg;
      return function (this: unknown, ...cbArgs: unknown[]) {
        try {
          onResult(api, command, cbArgs[0]);
        } catch {
          /* never break the page */
        }
        return (arg as (...a: unknown[]) => unknown).apply(this, cbArgs);
      };
    });

    return (real as (...a: unknown[]) => unknown).apply(this, wrappedArgs);
  };

  try {
    Object.defineProperty(win, api, {
      configurable: true,
      enumerable: true,
      get() {
        // Only hand back a wrapper once the real implementation exists, so
        // `if (window.__gpp)` feature-detection behaves exactly as it would have.
        return real === undefined ? undefined : wrapper;
      },
      set(value: unknown) {
        // The CMP is defining (or replacing) its API. Keep the real one; keep serving
        // the wrapper.
        real = value;
      },
    });
    return true;
  } catch {
    // Something non-configurable already holds the name. Leave it entirely alone rather
    // than risk breaking the page's consent mechanism — and report the failure, so the UI
    // says "not observable" instead of reporting the resulting silence as "not present".
    return false;
  }
}
