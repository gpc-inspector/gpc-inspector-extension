// SPDX-License-Identifier: GPL-3.0-only
/**
 * Script-insertion observation: who loaded each script (provenance).
 *
 * WHY THIS EXISTS
 *
 * The network side cannot say who loaded a script: Chrome reports the initiator of a
 * request as the document's origin whether the site's HTML loaded the script or a tag
 * manager inserted it. The one moment the loader is visible is the insertion itself: a
 * container creates a <script> element and inserts it from its own frames. Wrapping the
 * element-insertion methods in the MAIN world puts us on the stack at that moment, the
 * same way the cookie and consent-API wrappers put us on the stack of a write or a call.
 *
 * WHAT IS RECORDED
 *
 * Per inserted script or iframe: the distilled stack (frame URLs, innermost first, our own
 * frames removed, inline frames removed and flagged), every tag-manager frame on it, the
 * method used, and which inline element was executing when the stack was inline-only.
 * Records are raw; the engine resolves them into "loaded by X". Parser-inserted elements
 * are recorded POSITIVELY by enumerating document.scripts against what we saw inserted, so
 * an absence means "not an element at all" (a dynamic import), never "the site's HTML".
 *
 * WHAT THIS MUST NOT DO
 *
 * It must not change what the page does. Every wrapper delegates to the original with the
 * original `this` and arguments and returns its result or rethrows its exception; the
 * recording sits in its own try above the delegation. A different risk class from the
 * cookie wrapper, and treated as one: `appendChild` is the hottest DOM method a framework
 * calls, so the type test is the first line and nothing allocates for a non-script node,
 * and after three recorder exceptions on one page the recording stops for that page
 * (`selfDisabled`) while the delegation keeps working. The setting that installs this at
 * all is a separate, dynamically registered script (see main-world-insertion.ts), so off
 * means the prototypes are never touched.
 *
 * Measured on five real pages: about 0.01 ms per wrapped call including captures, and
 * never a recorder exception.
 */

import { isTagManagerFrame, containerIdentity, containerKey } from "@gpc-inspector/schema";
import type { ScriptInsertionLoader, ScriptInsertionVia, ScriptInsertionCoverage } from "@gpc-inspector/schema";

/** Bounds: URLs, frames per stack, keys per frame. */
export const URL_CAP = 256;
export const FRAME_CAP = 6;
export const KEY_CAP = 300;
/** Chrome's default is 10; container frames have been seen at index 18 and stacks of 50. */
export const STACK_LIMIT = 64;
/** Recorder exceptions on one page before recording stops (delegation never does). */
export const SELF_DISABLE_AFTER = 3;

/** One insertion as reported: a record with exactly one loader entry. */
export interface ObservedInsertion {
  readonly key: string;
  readonly url: string;
  readonly element: "script" | "iframe";
  readonly loader: ScriptInsertionLoader;
}

export interface DistilledStack {
  /** Non-extension, non-inline frame URLs, innermost first, deduplicated, capped. */
  readonly insertedBy: readonly string[];
  readonly inlineFrames: boolean;
  /** Every tag-manager frame, innermost first, deduplicated. */
  readonly containerUrls: readonly string[];
  /** True when the container frames name more than one distinct container id. */
  readonly ambiguousContainer: boolean;
}

/** Cap a URL's length; the tail is the least identifying part. */
export function capUrl(url: string): string {
  return url.length > URL_CAP ? url.slice(0, URL_CAP) : url;
}

/**
 * The record key: URL without query or hash, capped, so a cache-busted loader is one key.
 *
 * With one exception: a tag-manager loader keeps its container id, because for those the
 * query IS the identity. Three containers load from one `gtm.js` path, and the container
 * graph (which container inserted which) is built from these records, so collapsing them
 * would make the graph unbuildable.
 */
export function dedupeKey(url: string): string {
  let end = url.length;
  const q = url.indexOf("?");
  if (q >= 0) end = q;
  const h = url.indexOf("#");
  if (h >= 0 && h < end) end = h;
  const base = url.slice(0, end);
  const id = containerIdentity(url);
  if (id !== null && id.id !== null) return capUrl(`${base}?id=${id.id}`);
  return capUrl(base);
}

function stripHash(url: string): string {
  const h = url.indexOf("#");
  return h < 0 ? url : url.slice(0, h);
}

/**
 * The URL in one stack line, or null.
 *
 * Kept distinct from attributeCaller's regex on purpose: that one stops at the first colon
 * after the scheme and so turns "https://host:8443/x.js:12:3" into "https://host". Here the
 * URL is taken to the closing paren or end of line and the trailing ":line:col" is removed,
 * so a port survives. `blob:` scripts carry their origin after the scheme and are kept as
 * named frames; `eval` and anonymous frames have no URL and are skipped.
 */
export function frameUrlOf(line: string): string | null {
  const m = /((?:https?|blob):\/\/[^\s)]+)/.exec(line);
  if (!m || m[1] === undefined) return null;
  return m[1].replace(/(?::\d+){1,2}$/, "");
}

/**
 * A frame of inline code with no URL at all: "<anonymous>:line:col". V8 gives a
 * parser-inserted inline script the document's URL, but an inline script inserted as an
 * element (a GTM Custom HTML tag) has no URL and shows as anonymous WITH a position
 * (measured on the fixture, 2026-09-13). A native frame ("Array.forEach (<anonymous>)")
 * is anonymous without a position, which is what keeps it out of this test.
 */
const ANONYMOUS_CODE_FRAME = /<anonymous>:\d+:\d+/;

/**
 * Distil a raw stack into what the record keeps.
 *
 * Inline frames are recognized two ways: by URL equal to the document's URL as it was at
 * document_start OR as it is now (parser-inserted inline scripts keep the URL they were
 * parsed under, and after a pushState the current URL no longer matches), and by an
 * anonymous frame with a position (an inline script inserted as an element).
 */
export function distillStack(
  stack: string | undefined,
  initialUrl: string,
  currentUrl: string,
): DistilledStack {
  if (!stack) return { insertedBy: [], inlineFrames: false, containerUrls: [], ambiguousContainer: false };
  const initial = stripHash(initialUrl);
  const current = stripHash(currentUrl);
  const insertedBy: string[] = [];
  const containerUrls: string[] = [];
  const ids = new Set<string>();
  let inlineFrames = false;

  for (const line of stack.split("\n")) {
    const url = frameUrlOf(line);
    if (url === null) {
      if (ANONYMOUS_CODE_FRAME.test(line)) inlineFrames = true;
      continue;
    }
    if (url.startsWith("chrome-extension://")) continue;
    const bare = stripHash(url);
    if (bare === initial || bare === current) {
      inlineFrames = true;
      continue;
    }
    const capped = capUrl(url);
    if (isTagManagerFrame(url)) {
      if (!containerUrls.includes(capped)) containerUrls.push(capped);
      const id = containerIdentity(url);
      if (id && id.id !== null) ids.add(containerKey(id));
    }
    if (insertedBy.length < FRAME_CAP && !insertedBy.includes(capped)) insertedBy.push(capped);
  }
  return { insertedBy, inlineFrames, containerUrls, ambiguousContainer: ids.size > 1 };
}

/**
 * Whether a <script type> executes. Per the HTML spec: empty, a JavaScript MIME type, or
 * "module". Anything else (text/plain, application/json, ld+json, a template, an import
 * map, speculation rules) is data the browser never runs, which is how consent tools
 * gate a script until the reader agrees.
 */
export function isExecutingScriptType(type: string | null): boolean {
  if (type === null) return true;
  const t = type.trim().toLowerCase();
  if (t === "" || t === "module") return true;
  const mime = t.split(";")[0]?.trim() ?? "";
  return JS_MIME_TYPES.has(mime);
}

const JS_MIME_TYPES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);

/**
 * The script sources named in a `document.write` string, resolved against the document.
 * A written <script src> is parser-inserted and never passes through an insertion method,
 * so this is the only chance to record who wrote it.
 */
export function scanWriteForSrc(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const re = /<script\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (raw === "") continue;
    try {
      out.push(new URL(raw, baseUrl).href);
    } catch {
      /* an unresolvable src loads nothing */
    }
  }
  return out;
}

export interface ObserverOptions {
  /** The document's URL at document_start, for inline-frame recognition after pushState. */
  readonly initialUrl: string;
  readonly frameOrigin: string;
  readonly topFrame: boolean;
  readonly captureStack?: () => string | undefined;
  readonly now?: () => number;
}

export interface ObserverReport {
  /** A new insertion, or a known one whose count changed. */
  onInsertion(insertion: ObservedInsertion): void;
  onCoverage(coverage: ScriptInsertionCoverage): void;
}

export interface InsertionObserver {
  /**
   * Enumerate parser-inserted elements and re-report coverage. Called at DOMContentLoaded
   * and on the page's later re-scans; idempotent.
   */
  rescan(): void;
  readonly coverage: ScriptInsertionCoverage;
}

/** What the observer remembers about an element it has seen: its key and loader. */
interface Seen {
  readonly key: string;
  readonly loader: ScriptInsertionLoader | null;
}

type Insertable = Node & { readonly localName?: string; readonly nodeType?: number };

/**
 * Install the observer. Returns false when the prototypes could not be wrapped, which the
 * caller reports as `capabilities.scriptInsertion: false`.
 *
 * `win` and `doc` are the page's; the prototypes are read off them so a test can pass
 * fakes. Nothing here is called on the page's behalf except the originals.
 */
export function installScriptInsertionObserver(
  win: Window & typeof globalThis,
  doc: Document,
  opts: ObserverOptions,
  report: ObserverReport,
): InsertionObserver | null {
  const captureStack =
    opts.captureStack ??
    ((): string | undefined => {
      // stackTraceLimit is V8's, not the language's, so the lib types do not carry it.
      const ErrorCtor = win.Error as ErrorConstructor & { stackTraceLimit: number };
      const prev = ErrorCtor.stackTraceLimit;
      try {
        ErrorCtor.stackTraceLimit = STACK_LIMIT;
        return new ErrorCtor().stack ?? undefined;
      } finally {
        try {
          ErrorCtor.stackTraceLimit = prev;
        } catch {
          /* a page that froze Error keeps whatever limit it set */
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

  const seen = new WeakMap<object, Seen>();
  // Inline keys must be unique across the frames of one tab, and each frame has its own
  // observer: a short random prefix per instance keeps a sub-frame's "inline:1" apart.
  const inlinePrefix = `inline:${Math.random().toString(36).slice(2, 8)}:`;
  /** key -> loader signature -> the entry, so a repeat bumps a count instead of a record. */
  const table = new Map<string, Map<string, { loader: ScriptInsertionLoader; url: string; element: "script" | "iframe" }>>();
  let inlineSeq = 0;
  let recorderThrows = 0;

  const loaderSignature = (l: ScriptInsertionLoader): string =>
    `${l.via}|${l.frameOrigin}|${l.topFrame ? 1 : 0}|${l.insertedBy.join(" ")}|${l.currentScriptKey ?? ""}`;

  function currentScriptKey(): string | null {
    let cs: Element | null;
    try {
      cs = doc.currentScript as Element | null;
    } catch {
      return null;
    }
    if (!cs) return null;
    const s = seen.get(cs);
    if (s) return s.key === "" ? null : s.key;
    // An executing script we never saw inserted is parser-inserted: everything inserted
    // dynamically is recorded before it executes (the recorder runs before the original
    // insertion). The site's own inline snippet, then, executing before the DOMContentLoaded
    // enumeration reaches it. Record it now under a parser loader so the key exists.
    if ((cs as HTMLScriptElement).localName !== "script") return null;
    if (typeof (cs as HTMLScriptElement).src === "string" && (cs as HTMLScriptElement).src !== "") return null;
    return recordInlineWith(cs, parserLoader());
  }

  function buildLoader(via: ScriptInsertionVia, stack: string | undefined): ScriptInsertionLoader {
    let currentUrl = opts.initialUrl;
    try {
      currentUrl = win.location.href;
    } catch {
      /* keep the initial URL */
    }
    const d = distillStack(stack, opts.initialUrl, currentUrl);
    if (d.ambiguousContainer) coverage.ambiguousContainer++;
    let csKey: string | null = null;
    if (d.insertedBy.length === 0 && d.inlineFrames) {
      csKey = currentScriptKey();
      if (csKey !== null) coverage.inlineResolvedByCurrentScript++;
    }
    return {
      insertedBy: d.insertedBy,
      inlineFrames: d.inlineFrames,
      currentScriptKey: csKey,
      containerUrls: d.containerUrls,
      via,
      frameOrigin: opts.frameOrigin,
      topFrame: opts.topFrame,
      count: 1,
      timeMs: now(),
    };
  }

  function record(url: string, element: "script" | "iframe", loader: ScriptInsertionLoader, el: object | null): void {
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
    const sig = loaderSignature(loader);
    const existing = byLoader.get(sig);
    if (existing) {
      coverage.duplicates++;
      existing.loader = { ...existing.loader, count: existing.loader.count + 1 };
      if (el) seen.set(el, { key, loader: existing.loader });
      return;
    }
    if (byLoader.size >= 3) {
      // A fourth distinct way of inserting the same URL is counted, not recorded.
      coverage.duplicates++;
      return;
    }
    const entry = { loader, url: capUrl(url), element };
    byLoader.set(sig, entry);
    coverage.recorded++;
    if (el) seen.set(el, { key, loader });
    report.onInsertion({ key, url: entry.url, element, loader });
  }

  function considerElement(el: Element, via: ScriptInsertionVia): void {
    const name = el.localName;
    if (name !== "script" && name !== "iframe") return;
    if (seen.has(el)) return;
    let stack: string | undefined;
    try {
      stack = captureStack();
    } catch {
      coverage.stackFailed++;
      stack = undefined;
    }
    if (name === "iframe") {
      const src = (el as HTMLIFrameElement).src;
      if (typeof src === "string" && src !== "" && src !== "about:blank") {
        record(src, "iframe", buildLoader(via, stack), el);
      } else {
        // A friendly iframe: real, recorded under "about:blank" so a container that builds
        // one is still seen to have built one; the inserting frame's origin is on the entry.
        record("about:blank", "iframe", buildLoader(via, stack), el);
      }
      return;
    }
    const script = el as HTMLScriptElement;
    if (!isExecutingScriptType(script.getAttribute("type"))) {
      coverage.nonExecuting++;
      seen.set(el, { key: "", loader: null });
      return;
    }
    const src = script.src;
    if (typeof src === "string" && src !== "") {
      record(src, "script", buildLoader(via, stack), el);
      return;
    }
    // No src yet. Either inline, or a loader that sets src on the next line. Decide after a
    // microtask, which is where the second case lands; the stack is what it was NOW.
    const loaderNow = buildLoader(via, stack);
    const textNow = (script.textContent ?? "").length > 0;
    if (textNow) {
      recordInlineWith(script, loaderNow);
      return;
    }
    Promise.resolve().then(() => {
      try {
        const late = script.src;
        if (typeof late === "string" && late !== "") record(late, "script", loaderNow, script);
        else if ((script.textContent ?? "").length > 0) recordInlineWith(script, loaderNow);
        else coverage.srcUnresolved++;
      } catch {
        /* the page's element is its own business */
      }
    });
  }

  function recordInlineWith(el: Element, loader: ScriptInsertionLoader): string {
    coverage.inline++;
    const key = `${inlinePrefix}${++inlineSeq}`;
    seen.set(el, { key, loader });
    report.onInsertion({ key, url: key, element: "script", loader });
    return key;
  }

  const parserLoader = (): ScriptInsertionLoader => ({
    insertedBy: [],
    inlineFrames: false,
    currentScriptKey: null,
    containerUrls: [],
    via: "parser",
    frameOrigin: opts.frameOrigin,
    topFrame: opts.topFrame,
    count: 1,
    timeMs: now(),
  });

  function consider(node: unknown, via: ScriptInsertionVia): void {
    if (!node || typeof node !== "object") return;
    const n = node as Insertable;
    if (n.localName === "script" || n.localName === "iframe") {
      considerElement(n as unknown as Element, via);
      return;
    }
    if (n.nodeType === 11) {
      // A DocumentFragment: rare enough that the query is affordable and the only way to
      // see the scripts it carries. The live collection needs no allocation when empty.
      const frag = n as unknown as DocumentFragment;
      const scripts = frag.querySelectorAll?.("script,iframe");
      if (!scripts) return;
      for (let i = 0; i < scripts.length; i++) considerElement(scripts[i] as Element, via);
    }
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

  // --- wrap the prototypes ---
  const nodeProto = win.Node?.prototype as unknown as Record<string, unknown> | undefined;
  const elementProto = win.Element?.prototype as unknown as Record<string, unknown> | undefined;
  const rangeProto = win.Range?.prototype as unknown as Record<string, unknown> | undefined;
  const docProto = win.Document?.prototype as unknown as Record<string, unknown> | undefined;
  if (!nodeProto || !elementProto) return null;

  let ownAppendChild: unknown = null;
  function wrap(
    proto: Record<string, unknown> | undefined,
    name: string,
    via: ScriptInsertionVia,
    pick: (args: IArguments) => unknown[],
  ): boolean {
    if (!proto) return false;
    const original = proto[name];
    if (typeof original !== "function") return false;
    const orig = original as (...a: unknown[]) => unknown;
    const wrapper = function (this: unknown): unknown {
      // The type test is the whole performance argument: nothing below runs for a text
      // node or a div, which is what a framework inserts thousands of times.
      const args = arguments;
      guarded(() => {
        const nodes = pick(args);
        for (let i = 0; i < nodes.length; i++) consider(nodes[i], via);
      });
      return orig.apply(this, args as unknown as unknown[]);
      /*! GPC Inspector: if chrome://extensions lists a page error with this line as its stack
       *  frame, the source of the error is from the page rather than the extension. This wrapper
       *  records who inserted a node then hands the call back to the browser which logs errors such
       *  as blocked sandbox scripts, CSP refusals, and ignored speculation rules against the nearest
       *  script frame (which is this one!). To stop the extension from displaying the errors, the
       *  feature that attributes a script to a GPC call must be disabled. Open the extension
       *  settings and turn off "Observe how scripts are loaded". */
    };
    try {
      Object.defineProperty(proto, name, { value: wrapper, configurable: true, writable: true });
    } catch {
      return false;
    }
    if (name === "appendChild") ownAppendChild = wrapper;
    return true;
  }
  const first = (a: IArguments): unknown[] => [a[0]];
  const second = (a: IArguments): unknown[] => [a[1]];
  const all = (a: IArguments): unknown[] => Array.prototype.slice.call(a) as unknown[];

  const ok =
    wrap(nodeProto, "appendChild", "appendChild", first) &&
    wrap(nodeProto, "insertBefore", "insertBefore", first);
  if (!ok) return null;
  wrap(nodeProto, "replaceChild", "replaceChild", first);
  wrap(elementProto, "append", "append", all);
  wrap(elementProto, "prepend", "prepend", all);
  wrap(elementProto, "before", "before", all);
  wrap(elementProto, "after", "after", all);
  wrap(elementProto, "replaceWith", "replaceWith", all);
  wrap(elementProto, "insertAdjacentElement", "insertAdjacentElement", second);
  wrap(rangeProto, "insertNode", "insertNode", first);

  // document.write: a written <script src> is parser-inserted; scan the text for sources.
  for (const name of ["write", "writeln"] as const) {
    const original = docProto?.[name];
    if (typeof original !== "function" || !docProto) continue;
    const orig = original as (...a: unknown[]) => unknown;
    const wrapper = function (this: unknown): unknown {
      const args = arguments;
      guarded(() => {
        let html = "";
        for (let i = 0; i < args.length; i++) html += String(args[i]);
        if (html.indexOf("<script") < 0 && html.indexOf("<SCRIPT") < 0) return;
        let base = opts.initialUrl;
        try {
          base = doc.baseURI || base;
        } catch {
          /* keep */
        }
        const srcs = scanWriteForSrc(html, base);
        if (srcs.length === 0) return;
        let stack: string | undefined;
        try {
          stack = captureStack();
        } catch {
          coverage.stackFailed++;
        }
        for (const src of srcs) record(src, "script", buildLoader("write", stack), null);
      });
      return orig.apply(this, args as unknown as unknown[]);
      /*! GPC Inspector: if chrome://extensions lists a page error with this line as its stack
       *  frame, the source of the error is from the page rather than the extension. This wrapper
       *  records who inserted a node then hands the call back to the browser which logs errors such
       *  as blocked sandbox scripts, CSP refusals, and ignored speculation rules against the nearest
       *  script frame (which is this one!). To stop the extension from displaying the errors, the
       *  feature that attributes a script to a GPC call must be disabled. Open the extension
       *  settings and turn off "Observe how scripts are loaded". */
    };
    try {
      Object.defineProperty(docProto, name, { value: wrapper, configurable: true, writable: true });
    } catch {
      /* write stays unobserved; everything else still is */
    }
  }

  /** Parser-inserted elements: everything in the document we did not see inserted. */
  function enumerateParser(): void {
    let scripts: ArrayLike<Element>;
    let iframes: ArrayLike<Element>;
    try {
      scripts = doc.scripts;
      iframes = doc.getElementsByTagName("iframe");
    } catch {
      return;
    }
    for (let i = 0; i < scripts.length; i++) {
      const s = scripts[i] as HTMLScriptElement;
      if (seen.has(s)) continue;
      if (!isExecutingScriptType(s.getAttribute("type"))) {
        coverage.nonExecuting++;
        seen.set(s, { key: "", loader: null });
        continue;
      }
      coverage.parser++;
      if (typeof s.src === "string" && s.src !== "") record(s.src, "script", parserLoader(), s);
      else recordInlineWith(s, parserLoader());
    }
    for (let i = 0; i < iframes.length; i++) {
      const f = iframes[i] as HTMLIFrameElement;
      if (seen.has(f)) continue;
      coverage.parser++;
      const src = f.src;
      record(
        typeof src === "string" && src !== "" && src !== "about:blank" ? src : "about:blank",
        "iframe",
        parserLoader(),
        f,
      );
    }
  }

  const observer: InsertionObserver = {
    coverage,
    rescan(): void {
      guarded(() => {
        enumerateParser();
        // Another wrapper (a script-blocking CMP, an APM agent) replaced the method after
        // us. Its frame now sits beneath ours on every stack; the engine removes it by
        // frequency, and this flag says the removal is expected on this page.
        try {
          if (ownAppendChild !== null && nodeProto["appendChild"] !== ownAppendChild) coverage.wrappedOver = true;
        } catch {
          /* unreadable prototype; leave the flag */
        }
      });
      report.onCoverage({ ...coverage });
    },
  };
  return observer;
}
