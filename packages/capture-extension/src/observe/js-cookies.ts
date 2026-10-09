// SPDX-License-Identifier: GPL-3.0-only
/**
 * JavaScript-set cookie observation (PRD FR-9).
 *
 * `Set-Cookie` response headers alone miss every cookie written from page script. Modern
 * ad tech increasingly writes them that way: from headers alone, apparel-c.example reported a single
 * cookie, which is not credible for a site running a full ad stack.
 *
 * Two surfaces:
 *   document.cookie                         the setter, on the object that owns it
 *   cookieStore.set / cookieStore.delete    the newer async API, on the store itself
 *
 * WHERE THE WRAPPER SITS. On the object that owns the native property, found by walking
 * the chain from the document: Document.prototype on a real page. Not on
 * `Object.getPrototypeOf(document)`, HTMLDocument.prototype, which puts it in front of
 * every consent tool that wraps the property on Document.prototype (Osano, Transcend):
 * their blocking never runs for page writes, their own writes never reach us, and a cookie
 * the tool blocks is recorded as set. On Document.prototype, a tool that wraps later wraps
 * over us, as it would over the browser, and a write it blocks never reaches us. Ketch
 * defines the property on the document itself and delegates to the prototype; from
 * HTMLDocument.prototype we saw 0 of its 7 writes.
 *
 * ATTRIBUTION. A JS cookie has no responding domain, so the question "who set this" can
 * only be answered from the call stack. That attribution is best-effort and frequently
 * unavailable (bundled code, inline script, tag-manager containers), and where it fails we
 * record null rather than guessing. A cookie we cannot attribute is still a fact worth
 * recording; a cookie attributed to the wrong vendor is a false accusation. With a tool
 * wrapped over us its frames are on every stack, so attribution steps over them (skip A in
 * consent-api.ts) when the coverage flags say we are wrapped over.
 *
 * `cookieStore` is the exception, hooked in front on the store object itself. On the
 * prototype we would sit behind airline-a.example's own wrapper, a Proxy whose one frame renders
 * `Object.apply`, and there Google's `__gads`, `__gpi` and `__eoi` were charged to the
 * site. No consent tool in the 67-site corpus wraps `cookieStore`. In front, each call
 * still goes on to whatever the prototype holds at that moment, so a tool that wraps it
 * later still runs; a write it refuses by rejecting is not recorded, since writes are
 * reported on fulfillment. A tool that refused by resolving without writing would be
 * recorded as set; none was seen.
 *
 * WHAT THIS MUST NOT DO. It must not change what the page sees. We record and delegate.
 * The original setter runs with the original value, always, including when our recorder
 * throws.
 */

import { attributeCaller, leadingRun, parseStack, SKIP_INLINE_FRAMES, type AttributedCaller } from "./consent-api.js";

/**
 * Stack depth for a write, in two stages. The first capture holds V8's default 10 frames.
 * Only when we are wrapped over and the tool's frames fill every frame held is it taken
 * again at 32: Osano calls the original setter twice per allowed write, and the second call
 * has its accessor frame at index 10. The deepest writer frame measured was index 15.
 */
export const STACK_FRAMES = 10;
export const DEEP_STACK_FRAMES = 32;

/**
 * Whether something now sits in front of our `document.cookie` accessor, checked at each
 * write and on each re-scan. Latched: a flag that became true stays true for the page.
 */
export interface DocumentCookieCoverage {
  /**
   * Another accessor sits in front of ours: the owner's accessor is no longer ours, or an
   * object between the document and the owner defines its own (Osano, Transcend).
   */
  readonly wrappedOver: boolean;
  /** The document itself carries a `cookie` property of its own (Ketch). */
  readonly onInstance: boolean;
}

export interface DocumentCookieInterceptor {
  /** The flags as last checked. */
  readonly coverage: DocumentCookieCoverage;
  /** Check the flags again. Reports through `onCoverage` when one changed. */
  rescan(): void;
}

/**
 * Returns a raw stack holding `frames` frames beneath `below`, the wrapper the page called.
 * Injected so the tests can supply V8 stacks.
 */
export type StackCapture = (frames: number, below: (...a: never[]) => unknown) => string | undefined;

export interface DocumentCookieOptions {
  /** Called when a coverage flag becomes true. */
  readonly onCoverage?: (coverage: DocumentCookieCoverage) => void;
  readonly captureStack?: StackCapture;
}

// Taken while the page has not run yet, so a page that later replaces them changes
// nothing here.
const NativeError = Error as ErrorConstructor & {
  stackTraceLimit?: number;
  captureStackTrace?: (holder: object, below?: (...a: never[]) => unknown) => void;
};
const captureStackTrace = NativeError.captureStackTrace;
const getOwnDescriptor = Object.getOwnPropertyDescriptor;
const getProto = Object.getPrototypeOf;
const defineProp = Object.defineProperty;
const reflectGet = Reflect.get;
const hasOwnProperty = Object.prototype.hasOwnProperty;
const hasOwn = (o: object, key: string): boolean => hasOwnProperty.call(o, key);
const nativeThen = Promise.prototype.then;
const queue: (cb: () => void) => void =
  typeof queueMicrotask === "function" ? queueMicrotask : (cb) => void Promise.resolve().then(cb);

/**
 * A stack at the given depth, starting at the caller of `below`, the page's own limit
 * restored afterwards. Starting beneath our own frames leaves every frame held for the
 * page's: past a tool's cookie wrapper and a wrapped insertion method, the frame that names
 * the writer is several frames down.
 */
function captureStackAt(frames: number, below: (...a: never[]) => unknown): string | undefined {
  const prev = NativeError.stackTraceLimit;
  // Both are V8's. Where they are missing, setting the limit would leave a property the
  // page could see, so the stack is taken at whatever depth the engine gives, our own
  // frames included; attribution passes over extension frames.
  if (typeof prev !== "number" || typeof captureStackTrace !== "function") return new NativeError().stack ?? undefined;
  try {
    NativeError.stackTraceLimit = frames;
    const holder: { stack?: string } = {};
    captureStackTrace(holder, below);
    return holder.stack;
  } finally {
    try {
      NativeError.stackTraceLimit = prev;
    } catch {
      /* a page that froze Error keeps whatever limit it set */
    }
  }
}

/**
 * Whether a stack at `frames` depth may have been cut inside a wrapper: it holds every
 * frame it could, and the frames beneath ours are all one script.
 */
export function wrapperFillsStack(stack: string, frames: number): boolean {
  const parsed = parseStack(stack);
  if (parsed.length < frames) return false;
  const { start, runEnd } = leadingRun(parsed);
  return runEnd > start && runEnd === parsed.length;
}

/**
 * Whether two call chains agree as far as both reach. One stack can be the shorter only
 * because it was taken at fewer frames; with nothing to compare, only two empty chains agree.
 */
export function sameChain(a: readonly string[], b: readonly string[]): boolean {
  const n = Math.min(a.length, b.length);
  if (n === 0) return a.length === b.length;
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The first object on `obj`'s chain, itself included, that owns `key`, with its descriptor. */
function ownerOf(obj: object, key: string): { owner: object; descriptor: PropertyDescriptor } | null {
  for (let o: object | null = obj; o !== null; o = getProto(o) as object | null) {
    const descriptor = getOwnDescriptor(o, key);
    if (descriptor) return { owner: o, descriptor };
  }
  return null;
}

export interface JsCookieRecord {
  readonly name: string;
  readonly value: string;
  /** Domain attribute if the writer specified one, else the page's own host. */
  readonly domain: string;
  readonly path: string;
  readonly expiresMs: number | "session" | null;
  readonly sameSite: "Strict" | "Lax" | "None" | "unspecified";
  readonly secure: boolean;
  readonly partitioned: boolean;
  /** Script URL that wrote it, when the stack resolved one. */
  readonly writerScriptUrl: string | null;
  /** True when the stack resolved only into a tag-manager container. */
  readonly viaTagManager: boolean;
  /** The script of a cookie wrapper that was stepped over, a tool's or the site's, or null. */
  readonly wrapperScriptUrl: string | null;
  readonly via: "documentCookie" | "cookieStore";
  readonly timeMs: number;
  /**
   * The host of the frame that made the write. The browser accepts a Domain only if this
   * host is that domain or under it, and the worker checks it against that (see
   * cookieWriteAccepted): a script probing for the widest domain it may use writes
   * `domain=.com` first, Chrome rejects it, and it must not count as a cookie set.
   */
  readonly frameHost: string;
}

/**
 * Parse a `document.cookie` assignment string.
 *
 * The format matches Set-Cookie minus the response context, but the defaults differ: a
 * cookie written from script with no Domain belongs to the page's own host, whereas a
 * response cookie defaults to the responding host.
 */
export function parseDocumentCookie(
  assignment: string,
  pageHost: string,
): { name: string; value: string; attrs: Record<string, string | true> } | null {
  const parts = assignment.split(";");
  const first = parts[0];
  if (first === undefined) return null;

  const eq = first.indexOf("=");
  if (eq < 0) return null;
  const name = first.slice(0, eq).trim();
  if (name === "") return null;
  const value = first.slice(eq + 1).trim();

  const attrs: Record<string, string | true> = {};
  for (let i = 1; i < parts.length; i++) {
    const raw = parts[i];
    if (raw === undefined) continue;
    const trimmed = raw.trim();
    const aeq = trimmed.indexOf("=");
    if (aeq < 0) {
      attrs[trimmed.toLowerCase()] = true;
    } else {
      attrs[trimmed.slice(0, aeq).trim().toLowerCase()] = trimmed.slice(aeq + 1).trim();
    }
  }
  if (attrs["domain"] === undefined) attrs["domain"] = pageHost;
  return { name, value, attrs };
}

function toRecord(
  name: string,
  value: string,
  attrs: Record<string, string | true>,
  caller: AttributedCaller,
  via: JsCookieRecord["via"],
  frameHost: string,
): JsCookieRecord {
  const { url, viaTagManager, wrapperUrl } = caller;

  let expiresMs: number | "session" | null = "session";
  const maxAge = attrs["max-age"];
  if (typeof maxAge === "string") {
    const seconds = Number.parseInt(maxAge, 10);
    if (Number.isFinite(seconds)) expiresMs = seconds <= 0 ? 0 : Date.now() + seconds * 1000;
  } else if (typeof attrs["expires"] === "string") {
    const t = Date.parse(attrs["expires"]);
    if (Number.isFinite(t)) expiresMs = t;
  }

  const rawSameSite = attrs["samesite"];
  const ss = typeof rawSameSite === "string" ? rawSameSite.toLowerCase() : "";
  const sameSite =
    ss === "strict" ? "Strict" : ss === "lax" ? "Lax" : ss === "none" ? "None" : "unspecified";

  const domain = typeof attrs["domain"] === "string" ? attrs["domain"] : "";

  return {
    name,
    value,
    domain: domain.startsWith(".") || domain === "" ? domain : `.${domain}`,
    path: typeof attrs["path"] === "string" ? attrs["path"] : "/",
    expiresMs,
    sameSite,
    secure: attrs["secure"] === true,
    partitioned: attrs["partitioned"] === true,
    writerScriptUrl: url,
    viaTagManager,
    wrapperScriptUrl: wrapperUrl,
    via,
    timeMs: Date.now(),
    frameHost,
  };
}

/**
 * Install the document.cookie interceptor. Returns null when the property could not be
 * wrapped, which the caller reports as `capabilities.documentCookie: false`.
 *
 * The accessor goes on the first object in the document's chain that owns `cookie`, with
 * that object's descriptor delegated to: configurable, and with the recorder guarded so a
 * throw in our code can never prevent the page from setting its cookie. The original
 * setter runs first, with the original value, so a write the browser refuses by throwing
 * (a sandboxed frame) throws to the page exactly as it would unwrapped, and is never
 * recorded.
 */
export function interceptDocumentCookie(
  doc: Document,
  pageHost: string,
  onCookie: (c: JsCookieRecord) => void,
  opts: DocumentCookieOptions = {},
): DocumentCookieInterceptor | null {
  const found = ownerOf(doc, "cookie");
  if (!found) return null;
  const { owner, descriptor } = found;
  if (!descriptor.set || !descriptor.get || descriptor.configurable !== true) return null;

  const originalSet = descriptor.set;
  const originalGet = descriptor.get;
  const captureStack = opts.captureStack ?? captureStackAt;
  const coverage = { wrappedOver: false, onInstance: false };

  /** Re-check the flags; report when one became true. */
  function checkCoverage(): void {
    let changed = false;
    try {
      if (!coverage.onInstance && owner !== doc && hasOwn(doc, "cookie")) {
        coverage.onInstance = true;
        changed = true;
      }
      if (!coverage.wrappedOver) {
        let inFront = getOwnDescriptor(owner, "cookie")?.set !== ownSet;
        for (let o = getProto(doc) as object | null; !inFront && o !== null && o !== owner; o = getProto(o) as object | null) {
          if (hasOwn(o, "cookie")) inFront = true;
        }
        if (inFront) {
          coverage.wrappedOver = true;
          changed = true;
        }
      }
    } catch {
      /* an unreadable chain leaves the flags as they were */
    }
    if (changed) opts.onCoverage?.({ ...coverage });
  }

  // The previous write in this synchronous run: its assignment and the page's call chain
  // beneath the wrapper. A tool that calls the original setter twice for one page write
  // (Osano) produces the same pair twice, and the second is dropped. Only while wrapped
  // over, since only a wrapper makes such a call. The chains are compared as far as both
  // stacks reach, because the second call's stack is the deeper one; two page calls that
  // share a helper (Ketch's `setCookie`) differ beneath it and are both kept. Cleared in a
  // microtask, so the same write made again later is recorded again.
  let previousWrite: { readonly assignment: string; readonly below: readonly string[] } | null = null;
  let clearScheduled = false;

  function record(assignment: string): void {
    const parsed = parseDocumentCookie(assignment, pageHost);
    if (!parsed) return;
    checkCoverage();
    const wrapped = coverage.wrappedOver || coverage.onInstance;
    let stack: string | undefined;
    try {
      stack = captureStack(STACK_FRAMES, ownSet);
      if (wrapped && stack !== undefined && wrapperFillsStack(stack, STACK_FRAMES)) {
        stack = captureStack(DEEP_STACK_FRAMES, ownSet) ?? stack;
      }
    } catch {
      stack = undefined;
    }
    const caller = attributeCaller(stack, undefined, SKIP_INLINE_FRAMES, { cookieWrappedOver: wrapped });

    const echo =
      wrapped &&
      previousWrite !== null &&
      previousWrite.assignment === assignment &&
      sameChain(previousWrite.below, caller.below);
    previousWrite = { assignment, below: caller.below };
    if (!clearScheduled) {
      clearScheduled = true;
      queue(() => {
        previousWrite = null;
        clearScheduled = false;
      });
    }
    if (echo) return;

    onCookie(toRecord(parsed.name, parsed.value, parsed.attrs, caller, "documentCookie", pageHost));
  }

  const ownSet = function (this: Document, assignment: string): void {
    originalSet.call(this, assignment);
    try {
      // An object's own toString would run a second time if we converted it, which the page
      // could see. A primitive converts without running page code.
      if (typeof assignment !== "object" && typeof assignment !== "function") record(String(assignment));
    } catch {
      // Recording is best-effort. The page's write has already been made.
    }
  };

  try {
    defineProp(owner, "cookie", {
      configurable: true,
      enumerable: descriptor.enumerable ?? true,
      get(this: Document) {
        return originalGet.call(this);
      },
      set: ownSet,
    });
  } catch {
    return null;
  }

  return {
    coverage,
    rescan: checkCoverage,
  };
}

/**
 * Hook one method on the object itself, in front of its prototype. Each call goes on to
 * what the prototype holds at that moment, so a wrapper installed there later still runs,
 * beneath us. Where the object already owns the method (a tool that hooked it first, or a
 * test's fake), that method is wrapped in place. False when there is no method to hook.
 */
function hookInFront(
  target: object,
  key: string,
  wrap: (next: (...a: unknown[]) => unknown) => (this: unknown, ...a: unknown[]) => unknown,
): boolean {
  const found = ownerOf(target, key);
  if (!found || typeof found.descriptor.value !== "function") return false;
  let next: (...a: unknown[]) => unknown;
  if (found.owner === target) {
    next = found.descriptor.value as (...a: unknown[]) => unknown;
  } else {
    const proto = getProto(target) as object;
    next = function (this: unknown, ...a: unknown[]): unknown {
      return (reflectGet(proto, key, this) as (...a: unknown[]) => unknown).apply(this, a);
    };
  }
  try {
    // An own property, as an assignment would make one.
    defineProp(target, key, { configurable: true, enumerable: true, writable: true, value: wrap(next) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Report a cookieStore write once its promise fulfills. The promise rejects when the
 * browser refuses the write, and a refused write set nothing. Only the native `then` is
 * used, so a page that replaced Promise.prototype.then sees none of our calls.
 */
function onFulfilled(result: unknown, report: () => void): void {
  try {
    nativeThen.call(
      result as Promise<unknown>,
      () => {
        try {
          report();
        } catch {
          /* never break the page */
        }
      },
      () => {
        /* refused: nothing to record */
      },
    );
  } catch {
    // Not a promise, so there is no outcome to wait for, and nothing is recorded.
  }
}

/**
 * Install the cookieStore interceptor, where the API exists: `set` and `delete`, hooked on
 * the store itself, in front of the prototype and anyone who wraps it (see the header for
 * why this differs from `document.cookie`). Each is reported when its promise fulfills,
 * never before.
 *
 * True when the API is absent. cookieStore exists only in secure contexts, so an http://
 * page has none and its script can write cookies only through `document.cookie`: there is
 * nothing here to observe, which is not a failure to observe it. Reported false, every
 * http:// page would say "We could not observe cookies set by JavaScript" with
 * `document.cookie` wrapped (schema 1.35.0). False only when the store exists and `set`
 * could not be hooked.
 */
export function interceptCookieStore(
  win: Window & typeof globalThis,
  pageHost: string,
  onCookie: (c: JsCookieRecord) => void,
  captureStack: StackCapture = captureStackAt,
): boolean {
  const store = (win as unknown as Record<string, unknown>)["cookieStore"];
  if (store === undefined || store === null) return true;
  if (typeof store !== "object") return false;

  const callerBeneath = (below: (...a: never[]) => unknown): AttributedCaller => {
    let stack: string | undefined;
    try {
      stack = captureStack(STACK_FRAMES, below);
    } catch {
      stack = undefined;
    }
    return attributeCaller(stack);
  };

  /** cookieStore.set(name, value) or cookieStore.set({ name, value, ... }). */
  const setRecord = (args: unknown[], caller: AttributedCaller): JsCookieRecord | null => {
    const first = args[0];
    if (typeof first === "string") {
      return toRecord(first, String(args[1] ?? ""), { domain: pageHost }, caller, "cookieStore", pageHost);
    }
    if (!first || typeof first !== "object") return null;
    const o = first as Record<string, unknown>;
    const name = typeof o["name"] === "string" ? o["name"] : "";
    if (name === "") return null;
    const attrs: Record<string, string | true> = {
      domain: typeof o["domain"] === "string" ? o["domain"] : pageHost,
      path: typeof o["path"] === "string" ? o["path"] : "/",
    };
    if (typeof o["expires"] === "number") {
      attrs["expires"] = new Date(o["expires"]).toUTCString();
    }
    if (typeof o["sameSite"] === "string") attrs["samesite"] = o["sameSite"];
    if (o["partitioned"] === true) attrs["partitioned"] = true;
    return toRecord(name, String(o["value"] ?? ""), attrs, caller, "cookieStore", pageHost);
  };

  /** cookieStore.delete(name) or cookieStore.delete({ name, domain, path }): a deletion. */
  const deleteRecord = (args: unknown[], caller: AttributedCaller): JsCookieRecord | null => {
    const first = args[0];
    const o = first && typeof first === "object" ? (first as Record<string, unknown>) : null;
    const name = typeof first === "string" ? first : typeof o?.["name"] === "string" ? (o["name"] as string) : "";
    if (name === "") return null;
    const attrs: Record<string, string | true> = {
      domain: typeof o?.["domain"] === "string" ? (o["domain"] as string) : pageHost,
      path: typeof o?.["path"] === "string" ? (o["path"] as string) : "/",
      // Recorded the way a document.cookie deletion is: an expiry at the moment of writing.
      "max-age": "0",
    };
    if (o?.["partitioned"] === true) attrs["partitioned"] = true;
    return toRecord(name, "", attrs, caller, "cookieStore", pageHost);
  };

  const wrapReported =
    (build: (args: unknown[], caller: AttributedCaller) => JsCookieRecord | null) =>
    (next: (...a: unknown[]) => unknown) =>
      function wrapped(this: unknown, ...args: unknown[]): unknown {
        const result = next.apply(this, args);
        try {
          const record = build(args, callerBeneath(wrapped));
          if (record) onFulfilled(result, () => onCookie({ ...record, timeMs: Date.now() }));
        } catch {
          /* never break the page */
        }
        return result;
      };

  const set = hookInFront(store, "set", wrapReported(setRecord));
  hookInFront(store, "delete", wrapReported(deleteRecord));
  return set;
}
