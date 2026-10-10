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
 * WRITE TESTS. A script that tests whether it can write cookies sets one and removes it
 * again in the same task: one turn of the event loop, the script and the promise callbacks
 * it queues, with no timer, network callback or other script able to run in between. Such
 * a pair is not a cookie set. It is decided here, where the task is known, and by the task
 * alone, never by how much time passed: the `document.cookie` writes of a task are reported
 * together once it has ended, and a removal that follows a write of the same name and
 * domain in it is reported as a write test, without the writes it removed. The end of the
 * task is a task of our own, queued at the first write, so whatever the page schedules
 * after that write runs after it. `cookieStore` writes complete in a later task and are
 * never folded.
 *
 * WAS IT THERE. A removal says nothing of whether the cookie it names was in the browser.
 * Before a `document.cookie` removal is made, the document's cookies are read through the
 * native getter and the record says whether one of that name was among them, so the worker
 * can tell a cookie that was stored and then removed from one the browser never kept.
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
const NativeMessageChannel = typeof MessageChannel === "function" ? MessageChannel : undefined;
const portOf = typeof MessagePort === "function" ? MessagePort.prototype : undefined;
const setPortHandler = portOf === undefined ? undefined : getOwnDescriptor(portOf, "onmessage")?.set;
const portPost = portOf?.postMessage;
const portClose = portOf?.close;

/**
 * Run `cb` in a task of its own: after the task that is running and every microtask it
 * queues. A message on a private channel is that task. The page cannot see it, and unlike a
 * timer it is not something pages wrap. Where there is no channel to open, `cb` runs as a
 * microtask, which ends the run at the script's own end instead.
 */
function afterTask(cb: () => void): void {
  if (NativeMessageChannel === undefined || setPortHandler === undefined || portPost === undefined || portClose === undefined) {
    queue(cb);
    return;
  }
  try {
    const { port1, port2 } = new NativeMessageChannel();
    setPortHandler.call(port1, () => {
      portClose.call(port1);
      cb();
    });
    portPost.call(port2, null);
  } catch {
    queue(cb);
  }
}

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
  /**
   * On a removal: it removed a cookie written earlier in the same task, a write test. The
   * task's writes of that cookie are not reported (see foldRun).
   */
  readonly writeTest?: true;
  /**
   * On a `document.cookie` removal: whether a cookie of that name was readable in the
   * document just before the removal was made. Absent where it was not read: a
   * `cookieStore` removal, and a document whose cookies cannot be read.
   */
  readonly present?: boolean;
}

/** A cookie's identity as the worker keys it: name and the domain it was written for. */
function recordKey(r: Pick<JsCookieRecord, "name" | "domain">): string {
  return `${r.name}\u0000${r.domain}`;
}

/** Whether a record removes a cookie: an expiry at or before the moment it was written. */
export function isRemoval(r: Pick<JsCookieRecord, "expiresMs" | "timeMs">): boolean {
  return typeof r.expiresMs === "number" && r.expiresMs <= r.timeMs;
}

/**
 * The records of one task, as they are reported: a removal that follows writes of the same
 * name and domain in the task is marked a write test, and those writes are left out.
 * Everything else is kept, in order. A cookie written again after its removal is a write
 * like any other.
 */
export function foldRun(run: readonly JsCookieRecord[]): JsCookieRecord[] {
  const out: (JsCookieRecord | null)[] = [];
  // Per key, where in `out` the task's writes not yet removed are.
  const written = new Map<string, number[]>();
  for (const r of run) {
    const key = recordKey(r);
    if (!isRemoval(r)) {
      const at = written.get(key);
      if (at) at.push(out.length);
      else written.set(key, [out.length]);
      out.push(r);
      continue;
    }
    const at = written.get(key);
    if (at === undefined) {
      out.push(r);
      continue;
    }
    for (const i of at) out[i] = null;
    written.delete(key);
    out.push({ ...r, writeTest: true });
  }
  return out.filter((r): r is JsCookieRecord => r !== null);
}

/**
 * Whether a cookie named `name` is among a `document.cookie` string's pairs. A pair with no
 * "=" is a cookie with an empty name.
 */
export function cookieStringHolds(cookies: string, name: string): boolean {
  for (const pair of cookies.split(";")) {
    const eq = pair.indexOf("=");
    if ((eq < 0 ? "" : pair.slice(0, eq).trim()) === name) return true;
  }
  return false;
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

/**
 * When a write's cookie expires, from its attributes: Max-Age where it is given, else
 * Expires, else the session. Max-Age of zero or less is recorded as 0, a removal.
 */
function expiresMsOf(attrs: Record<string, string | true>, now: number): number | "session" {
  const maxAge = attrs["max-age"];
  if (typeof maxAge === "string") {
    const seconds = Number.parseInt(maxAge, 10);
    if (!Number.isFinite(seconds)) return "session";
    return seconds <= 0 ? 0 : now + seconds * 1000;
  }
  if (typeof attrs["expires"] === "string") {
    const t = Date.parse(attrs["expires"]);
    if (Number.isFinite(t)) return t;
  }
  return "session";
}

/** An assignment can only be a removal when it names one of the attributes that expire it. */
const EXPIRY_ATTRIBUTE = /max-age|expires/i;

function toRecord(
  name: string,
  value: string,
  attrs: Record<string, string | true>,
  caller: AttributedCaller,
  via: JsCookieRecord["via"],
  frameHost: string,
): JsCookieRecord {
  const { url, viaTagManager, wrapperUrl } = caller;

  const now = Date.now();
  const expiresMs: number | "session" | null = expiresMsOf(attrs, now);

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
    timeMs: now,
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
 * setter runs before anything is recorded, with the original value, so a write the browser
 * refuses by throwing (a sandboxed frame) throws to the page exactly as it would unwrapped,
 * and is never recorded.
 *
 * `onCookie` is called once the task that made a write has ended, with the task's records
 * folded (foldRun), not from inside the setter.
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
  // This task's records, in the order they were written, reported once it has ended.
  let run: JsCookieRecord[] = [];
  let endScheduled = false;

  function endRun(): void {
    endScheduled = false;
    const records = run;
    run = [];
    for (const r of foldRun(records)) {
      try {
        onCookie(r);
      } catch {
        /* never break the page */
      }
    }
  }

  /**
   * For a removal, whether a cookie of its name is in the document now, before the write
   * is made; undefined for any other assignment. Read through the native getter, which the
   * page cannot see being called.
   */
  function presentBeforeRemoval(target: Document, assignment: string): boolean | undefined {
    if (!EXPIRY_ATTRIBUTE.test(assignment)) return undefined;
    const parsed = parseDocumentCookie(assignment, pageHost);
    if (!parsed) return undefined;
    const now = Date.now();
    const expiresMs = expiresMsOf(parsed.attrs, now);
    if (typeof expiresMs !== "number" || expiresMs > now) return undefined;
    return cookieStringHolds(String(originalGet.call(target)), parsed.name);
  }

  function record(assignment: string, present: boolean | undefined): void {
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
    if (!endScheduled) {
      endScheduled = true;
      afterTask(endRun);
    }

    const made = toRecord(parsed.name, parsed.value, parsed.attrs, caller, "documentCookie", pageHost);
    run.push(present !== undefined && isRemoval(made) ? { ...made, present } : made);
  }

  const ownSet = function (this: Document, assignment: string): void {
    // An object's own toString would run a second time if we converted it, which the page
    // could see. A primitive converts without running page code.
    const text = typeof assignment !== "object" && typeof assignment !== "function" ? String(assignment) : null;
    let present: boolean | undefined;
    if (text !== null) {
      try {
        present = presentBeforeRemoval(this, text);
      } catch {
        // A document whose cookies cannot be read: the removal is recorded without it.
        present = undefined;
      }
    }
    originalSet.call(this, assignment);
    try {
      if (text !== null) record(text, present);
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
