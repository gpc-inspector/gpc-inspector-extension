// SPDX-License-Identifier: GPL-3.0-only
/**
 * Request-initiator observation: who made each page-initiated request (provenance).
 *
 * WHY THIS EXISTS
 *
 * Pixels never enter the DOM (`new Image().src = ...`), and neither do `fetch`,
 * `XMLHttpRequest` or `navigator.sendBeacon`, so the script-insertion observer never sees
 * them. Two things follow. A pixel-only vendor gets no provenance line at all. And the
 * check rule counts an `xmlhttprequest` to a vendor's domain as "this vendor's own script
 * ran", when a container's Custom HTML tag can make that request with no vendor code on
 * the page. That second one is a latent over-claim in the rule, and these records are what
 * can tighten it (REQUIRE_XHR_FROM_OWN_FRAMES in the engine's vendor-signal-check.ts, off).
 *
 * WHAT IS RECORDED
 *
 * The same record shape as a script insertion (schema ScriptInsertion), with `element`
 * naming the request kind and `via` the API, so the engine resolves them with the same
 * rules and the popup shows the same line. Four APIs: the `src` setter on
 * HTMLImageElement.prototype (an accessor, wrapped like document.cookie), `fetch`,
 * `XMLHttpRequest.prototype.open` and `Navigator.prototype.sendBeacon`. The stack is
 * captured at the call, which is the moment the initiator is on it.
 *
 * WHAT THIS MUST NOT DO
 *
 * Same guarantees as the insertion observer: delegate to the original with the original
 * `this` and arguments, return its result or rethrow its exception, and never let the
 * recorder reach the page; self-disable recording after three recorder exceptions. The
 * recorder here is a small copy of the insertion observer's rather than a shared module,
 * on purpose: the two observers are measured apart, and a change to one does not move the
 * other.
 */

import { isTagManagerFrame, containerIdentity, containerKey } from "@gpc-inspector/schema";
import type { ScriptInsertionLoader, ScriptInsertionCoverage } from "@gpc-inspector/schema";
import { capUrl, dedupeKey, distillStack, STACK_LIMIT, KEY_CAP, SELF_DISABLE_AFTER } from "./script-insertion.js";

export type RequestKind = "image" | "fetch" | "xhr" | "beacon";

export interface ObservedRequest {
  readonly key: string;
  readonly url: string;
  readonly element: RequestKind;
  readonly loader: ScriptInsertionLoader;
}

export interface RequestObserverOptions {
  readonly initialUrl: string;
  readonly frameOrigin: string;
  readonly topFrame: boolean;
  readonly captureStack?: () => string | undefined;
  readonly now?: () => number;
}

export interface RequestObserverReport {
  onRequest(request: ObservedRequest): void;
  onCoverage(coverage: ScriptInsertionCoverage): void;
}

export interface RequestObserver {
  /** Re-report coverage; called on the page's re-scans. */
  rescan(): void;
  readonly coverage: ScriptInsertionCoverage;
}

/** Resolve a request URL the way the browser will, against the document. */
function absolute(raw: unknown, base: string): string | null {
  if (typeof raw !== "string") return null;
  if (raw === "" || raw.startsWith("data:") || raw.startsWith("blob:")) return null;
  try {
    return new URL(raw, base).href;
  } catch {
    return null;
  }
}

/**
 * Install the observer. Returns null when nothing could be wrapped, which the caller
 * reports as `capabilities.requestInitiation: false`.
 */
export function installRequestInitiatorObserver(
  win: Window & typeof globalThis,
  doc: Document,
  opts: RequestObserverOptions,
  report: RequestObserverReport,
): RequestObserver | null {
  const captureStack =
    opts.captureStack ??
    ((): string | undefined => {
      const ErrorCtor = win.Error as ErrorConstructor & { stackTraceLimit: number };
      const prev = ErrorCtor.stackTraceLimit;
      try {
        ErrorCtor.stackTraceLimit = STACK_LIMIT;
        return new ErrorCtor().stack ?? undefined;
      } finally {
        try {
          ErrorCtor.stackTraceLimit = prev;
        } catch {
          /* frozen Error */
        }
      }
    });
  const now = opts.now ?? ((): number => Date.now());

  const coverage: { -readonly [K in keyof ScriptInsertionCoverage]: ScriptInsertionCoverage[K] } = {
    recorded: 0,
    parser: 0,
    duplicates: 0,
    inline: 0,
    inlineResolvedByCurrentScript: 0,
    nonExecuting: 0,
    srcUnresolved: 0,
    stackFailed: 0,
    ambiguousContainer: 0,
    capExceeded: 0,
    wrappedOver: false,
    selfDisabled: false,
  };
  const table = new Map<string, Map<string, { count: number }>>();
  let recorderThrows = 0;

  const signature = (l: ScriptInsertionLoader): string =>
    `${l.via}|${l.frameOrigin}|${l.topFrame ? 1 : 0}|${l.insertedBy.join(" ")}`;

  function baseUrl(): string {
    try {
      return doc.baseURI || win.location.href || opts.initialUrl;
    } catch {
      return opts.initialUrl;
    }
  }

  function record(url: string, element: RequestKind, via: ScriptInsertionLoader["via"]): void {
    let stack: string | undefined;
    try {
      stack = captureStack();
    } catch {
      coverage.stackFailed++;
      stack = undefined;
    }
    let currentUrl = opts.initialUrl;
    try {
      currentUrl = win.location.href;
    } catch {
      /* keep */
    }
    const d = distillStack(stack, opts.initialUrl, currentUrl);
    if (d.ambiguousContainer) coverage.ambiguousContainer++;
    // No currentScript resolution here: a request from an inline snippet is that
    // snippet's, and the engine resolves it through the element record the insertion
    // observer made, by the same key the snippet was given there. Not available across
    // observers, so an inline-only request stack stays inline-only: undetermined.
    const loader: ScriptInsertionLoader = {
      insertedBy: d.insertedBy,
      inlineFrames: d.inlineFrames,
      currentScriptKey: null,
      containerUrls: d.containerUrls,
      via,
      frameOrigin: opts.frameOrigin,
      topFrame: opts.topFrame,
      count: 1,
      timeMs: now(),
    };
    const key = dedupeKey(url);
    let byLoader = table.get(key);
    if (!byLoader) {
      if (table.size >= KEY_CAP) {
        coverage.capExceeded++;
        return;
      }
      byLoader = new Map();
      table.set(key, byLoader);
    }
    const sig = signature(loader);
    const existing = byLoader.get(sig);
    if (existing) {
      coverage.duplicates++;
      existing.count++;
      return;
    }
    if (byLoader.size >= 3) {
      coverage.duplicates++;
      return;
    }
    byLoader.set(sig, { count: 1 });
    coverage.recorded++;
    report.onRequest({ key, url: capUrl(url), element, loader });
  }

  function guarded(fn: () => void): void {
    if (coverage.selfDisabled) return;
    try {
      fn();
    } catch {
      recorderThrows++;
      if (recorderThrows >= SELF_DISABLE_AFTER) coverage.selfDisabled = true;
    }
  }

  let installed = 0;

  // --- HTMLImageElement.prototype.src: an accessor, wrapped like document.cookie ---
  const imageProto = win.HTMLImageElement?.prototype as unknown as object | undefined;
  if (imageProto) {
    const desc = Object.getOwnPropertyDescriptor(imageProto, "src");
    if (desc?.set && desc.get && desc.configurable) {
      const originalSet = desc.set;
      const originalGet = desc.get;
      try {
        Object.defineProperty(imageProto, "src", {
          configurable: true,
          enumerable: desc.enumerable ?? true,
          get(this: unknown) {
            return originalGet.call(this);
          },
          set(this: unknown, value: unknown) {
            guarded(() => {
              const url = absolute(value, baseUrl());
              if (url !== null) record(url, "image", "src");
            });
            originalSet.call(this, value);
            /*! GPC Inspector: if chrome://extensions lists a page error with this line as its stack
             *  frame, the source of the error is from the page rather than the extension. This wrapper
             *  records who made a request then hands the call back to the browser which logs errors such
             *  as CSP refusals against the nearest script frame (which is this one!). To stop the
             *  extension from displaying the errors, the feature that attributes a script to a GPC call
             *  must be disabled. Open the extension settings and turn off "Observe how scripts are
             *  loaded". */
          },
        });
        installed++;
      } catch {
        /* a page that made src non-configurable keeps it; the other three still install */
      }
    }
  }

  // --- fetch ---
  const w = win as unknown as Record<string, unknown>;
  const originalFetch = w["fetch"];
  if (typeof originalFetch === "function") {
    const orig = originalFetch as (...a: unknown[]) => unknown;
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
      guarded(() => {
        const input = args[0];
        const raw =
          typeof input === "string"
            ? input
            : input && typeof input === "object" && typeof (input as { url?: unknown }).url === "string"
              ? (input as { url: string }).url
              : input && typeof input === "object" && typeof (input as { href?: unknown }).href === "string"
                ? (input as { href: string }).href
                : null;
        const url = absolute(raw, baseUrl());
        if (url !== null) record(url, "fetch", "fetch");
      });
      return orig.apply(this, args);
      /*! GPC Inspector: if chrome://extensions lists a page error with this line as its stack
       *  frame, the source of the error is from the page rather than the extension. This wrapper
       *  records who made a request then hands the call back to the browser which logs errors such
       *  as CSP refusals against the nearest script frame (which is this one!). To stop the
       *  extension from displaying the errors, the feature that attributes a script to a GPC call
       *  must be disabled. Open the extension settings and turn off "Observe how scripts are
       *  loaded". */
    };
    try {
      w["fetch"] = wrapper;
      installed++;
    } catch {
      /* non-writable fetch */
    }
  }

  // --- XMLHttpRequest.prototype.open ---
  const xhrProto = win.XMLHttpRequest?.prototype as unknown as Record<string, unknown> | undefined;
  if (xhrProto && typeof xhrProto["open"] === "function") {
    const orig = xhrProto["open"] as (...a: unknown[]) => unknown;
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
      guarded(() => {
        const url = absolute(args[1], baseUrl());
        if (url !== null) record(url, "xhr", "open");
      });
      return orig.apply(this, args);
      /*! GPC Inspector: if chrome://extensions lists a page error with this line as its stack
       *  frame, the source of the error is from the page rather than the extension. This wrapper
       *  records who made a request then hands the call back to the browser which logs errors such
       *  as CSP refusals against the nearest script frame (which is this one!). To stop the
       *  extension from displaying the errors, the feature that attributes a script to a GPC call
       *  must be disabled. Open the extension settings and turn off "Observe how scripts are
       *  loaded". */
    };
    try {
      Object.defineProperty(xhrProto, "open", { value: wrapper, configurable: true, writable: true });
      installed++;
    } catch {
      /* leave it */
    }
  }

  // --- navigator.sendBeacon ---
  const navProto = win.Navigator?.prototype as unknown as Record<string, unknown> | undefined;
  if (navProto && typeof navProto["sendBeacon"] === "function") {
    const orig = navProto["sendBeacon"] as (...a: unknown[]) => unknown;
    const wrapper = function (this: unknown, ...args: unknown[]): unknown {
      guarded(() => {
        const url = absolute(args[0], baseUrl());
        if (url !== null) record(url, "beacon", "sendBeacon");
      });
      return orig.apply(this, args);
      /*! GPC Inspector: if chrome://extensions lists a page error with this line as its stack
       *  frame, the source of the error is from the page rather than the extension. This wrapper
       *  records who made a request then hands the call back to the browser which logs errors such
       *  as CSP refusals against the nearest script frame (which is this one!). To stop the
       *  extension from displaying the errors, the feature that attributes a script to a GPC call
       *  must be disabled. Open the extension settings and turn off "Observe how scripts are
       *  loaded". */
    };
    try {
      Object.defineProperty(navProto, "sendBeacon", { value: wrapper, configurable: true, writable: true });
      installed++;
    } catch {
      /* leave it */
    }
  }

  if (installed === 0) return null;

  return {
    coverage,
    rescan(): void {
      report.onCoverage({ ...coverage });
    },
  };
}

// Re-exported so a consumer that only needs the identity helpers for request records does
// not have to know they live in the schema package.
export { isTagManagerFrame, containerIdentity, containerKey };
