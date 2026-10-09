// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import {
  frameUrlOf,
  dedupeKey,
  distillStack,
  isExecutingScriptType,
  scanWriteForSrc,
  installScriptInsertionObserver,
  FRAME_CAP,
  KEY_CAP,
  SELF_DISABLE_AFTER,
  type ObservedInsertion,
} from "../src/observe/script-insertion.js";
import type { ScriptInsertionCoverage } from "@gpc-inspector/schema";

/**
 * The script-insertion observer (provenance).
 *
 * The pure helpers carry the resolution rules; the installer is tested against fake
 * prototypes the way interceptDocumentCookie is, proving it delegates, returns the
 * original's value, rethrows the original's exception, and never throws from the recorder.
 * Real stacks, real currentScript and real parser enumeration are the fixture page's job
 * (fixtures/provenance).
 */

const PAGE = "https://www.example.com/article";
const GTM_A = "https://www.googletagmanager.com/gtm.js?id=GTM-A";
const GTAG = "https://www.googletagmanager.com/gtag/js?id=G-1";
const frame = (url: string, fn = "f"): string => `    at ${fn} (${url}:12:3)`;
const stackOf = (...urls: string[]): string => ["Error", ...urls.map((u) => frame(u))].join("\n");

describe("frameUrlOf", () => {
  it("keeps a port and drops the trailing line and column, unlike attributeCaller's regex", () => {
    expect(frameUrlOf("    at f (https://host:8443/x.js:12:3)")).toBe("https://host:8443/x.js");
    expect(frameUrlOf("    at https://host/x.js:12:3")).toBe("https://host/x.js");
    expect(frameUrlOf("    at f (https://host/x.js?id=GTM-A&l=dl:1:1)")).toBe("https://host/x.js?id=GTM-A&l=dl");
  });

  it("returns null for anonymous and eval frames", () => {
    expect(frameUrlOf("    at <anonymous>:1:1")).toBeNull();
    expect(frameUrlOf("    at eval (eval at f)")).toBeNull();
  });
});

describe("dedupeKey", () => {
  it("strips query and hash so a cache-busted loader is one key", () => {
    expect(dedupeKey("https://v.example/tag.js?cb=123#x")).toBe("https://v.example/tag.js");
    expect(dedupeKey("https://v.example/tag.js#x?y")).toBe("https://v.example/tag.js");
  });

  it("caps the length", () => {
    expect(dedupeKey("https://v.example/" + "a".repeat(600)).length).toBe(256);
  });

  it("keeps the container id for a tag-manager loader, so three containers are three keys", () => {
    expect(dedupeKey("https://www.googletagmanager.com/gtm.js?id=GTM-A&l=NF2DL")).toBe("https://www.googletagmanager.com/gtm.js?id=GTM-A");
    expect(dedupeKey("https://www.googletagmanager.com/gtm.js?id=GTM-B")).toBe("https://www.googletagmanager.com/gtm.js?id=GTM-B");
    expect(dedupeKey("https://www.googletagmanager.com/debug/x.js?v=1")).toBe("https://www.googletagmanager.com/debug/x.js");
  });
});

describe("distillStack", () => {
  it("keeps named frames innermost first, drops our own, and flags inline frames", () => {
    const d = distillStack(
      stackOf("chrome-extension://abc/main-world-insertion.js", PAGE, "https://v.example/loader.js", GTM_A),
      PAGE,
      PAGE,
    );
    expect(d.insertedBy).toEqual(["https://v.example/loader.js", GTM_A]);
    expect(d.inlineFrames).toBe(true);
    expect(d.containerUrls).toEqual([GTM_A]);
    expect(d.ambiguousContainer).toBe(false);
  });

  it("recognizes an inline frame by the initial URL after a pushState", () => {
    // Inline scripts keep the URL they were parsed under; the document has moved on.
    const d = distillStack(stackOf(PAGE), PAGE, "https://www.example.com/after-pushstate");
    expect(d.inlineFrames).toBe(true);
    expect(d.insertedBy).toEqual([]);
  });

  it("treats an anonymous frame with a position as inline code, and a native one as nothing", () => {
    // A Custom HTML tag's inline script has no URL; a native callback frame has no position.
    const custom = ["Error", "    at <anonymous>:1:83", frame(GTM_A)].join("\n");
    const d = distillStack(custom, PAGE, PAGE);
    expect(d.inlineFrames).toBe(true);
    expect(d.insertedBy).toEqual([GTM_A]);
    const native = ["Error", frame("https://v.example/a.js"), "    at Array.forEach (<anonymous>)"].join("\n");
    expect(distillStack(native, PAGE, PAGE).inlineFrames).toBe(false);
  });

  it("collects every container frame and marks two distinct ids as ambiguous", () => {
    const d = distillStack(stackOf(GTAG, GTAG, GTM_A), PAGE, PAGE);
    expect(d.containerUrls).toEqual([GTAG, GTM_A]);
    expect(d.ambiguousContainer).toBe(true);
    // One container loaded against two dataLayer names is one id.
    const same = distillStack(stackOf(GTM_A, GTM_A + "&l=NF2DL"), PAGE, PAGE);
    expect(same.ambiguousContainer).toBe(false);
  });

  it("deduplicates and caps frames", () => {
    const many = Array.from({ length: 12 }, (_, i) => `https://v.example/${i}.js`);
    const d = distillStack(stackOf(...many, ...many), PAGE, PAGE);
    expect(d.insertedBy.length).toBe(FRAME_CAP);
    expect(d.insertedBy[0]).toBe("https://v.example/0.js");
  });

  it("is empty for no stack", () => {
    expect(distillStack(undefined, PAGE, PAGE).insertedBy).toEqual([]);
  });
});

describe("isExecutingScriptType", () => {
  it("runs empty, JavaScript MIME types and module; nothing else", () => {
    for (const t of [null, "", "  ", "text/javascript", "application/javascript; charset=utf-8", "module", "MODULE"]) {
      expect(isExecutingScriptType(t), String(t)).toBe(true);
    }
    for (const t of ["text/plain", "application/json", "application/ld+json", "text/template", "importmap", "speculationrules"]) {
      expect(isExecutingScriptType(t), t).toBe(false);
    }
  });
});

describe("scanWriteForSrc", () => {
  it("finds every script src in written HTML, resolved against the document", () => {
    const html = `<div></div><script src="/a.js"></script><SCRIPT type="text/javascript" SRC='https://v.example/b.js'></SCRIPT><script src=c.js></script><script>inline()</script>`;
    expect(scanWriteForSrc(html, "https://www.example.com/dir/page")).toEqual([
      "https://www.example.com/a.js",
      "https://v.example/b.js",
      "https://www.example.com/dir/c.js",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The installer, against fakes.
// ---------------------------------------------------------------------------

interface FakeEl {
  localName: string;
  src: string;
  textContent: string;
  nodeType: number;
  attrs: Record<string, string>;
  getAttribute(name: string): string | null;
}

function el(localName: string, over: Partial<FakeEl> = {}): FakeEl {
  const attrs = over.attrs ?? {};
  return {
    localName,
    src: "",
    textContent: "",
    nodeType: 1,
    attrs,
    getAttribute: (n) => attrs[n] ?? null,
    ...over,
  };
}

function harness(stack: () => string | undefined = () => stackOf(GTM_A)) {
  const calls: string[] = [];
  class Node {
    children: unknown[] = [];
    appendChild(n: unknown): unknown {
      calls.push("appendChild");
      this.children.push(n);
      return n;
    }
    insertBefore(n: unknown): unknown {
      calls.push("insertBefore");
      return n;
    }
    replaceChild(n: unknown): unknown {
      calls.push("replaceChild");
      return n;
    }
  }
  class Element extends Node {
    append(..._nodes: unknown[]): void {
      calls.push("append");
    }
    prepend(..._nodes: unknown[]): void {
      calls.push("prepend");
    }
    before(..._nodes: unknown[]): void {
      calls.push("before");
    }
    after(..._nodes: unknown[]): void {
      calls.push("after");
    }
    replaceWith(..._nodes: unknown[]): void {
      calls.push("replaceWith");
    }
    insertAdjacentElement(_w: string, n: unknown): unknown {
      calls.push("insertAdjacentElement");
      return n;
    }
  }
  class Range {
    insertNode(_n: unknown): void {
      calls.push("insertNode");
    }
  }
  class Document {
    write(..._html: unknown[]): void {
      calls.push("write");
    }
    writeln(..._html: unknown[]): void {
      calls.push("writeln");
    }
  }
  const scripts: FakeEl[] = [];
  const iframes: FakeEl[] = [];
  const doc = Object.assign(new Document(), {
    currentScript: null as FakeEl | null,
    scripts,
    getElementsByTagName: () => iframes,
    baseURI: PAGE,
  });
  const win = {
    Node,
    Element,
    Range,
    Document,
    Error,
    location: { href: PAGE },
  } as unknown as Window & typeof globalThis;
  const insertions: ObservedInsertion[] = [];
  const coverages: ScriptInsertionCoverage[] = [];
  const observer = installScriptInsertionObserver(
    win,
    doc as unknown as globalThis.Document,
    { initialUrl: PAGE, frameOrigin: "https://www.example.com", topFrame: true, captureStack: stack, now: () => 5 },
    { onInsertion: (i) => insertions.push(i), onCoverage: (c) => coverages.push(c) },
  );
  return { observer, insertions, coverages, calls, Node, Element, Range, Document, doc, scripts, iframes, win };
}

describe("installScriptInsertionObserver", () => {
  it("records a script insertion with the container that inserted it and delegates", () => {
    const h = harness();
    expect(h.observer).not.toBeNull();
    const head = new h.Element();
    const s = el("script", { src: "https://v.example/tag.js?cb=1" });
    const returned = head.appendChild(s);
    expect(returned).toBe(s);
    expect(h.calls).toEqual(["appendChild"]);
    expect(h.insertions).toHaveLength(1);
    const rec = h.insertions[0]!;
    expect(rec.key).toBe("https://v.example/tag.js");
    expect(rec.url).toBe("https://v.example/tag.js?cb=1");
    expect(rec.element).toBe("script");
    expect(rec.loader.via).toBe("appendChild");
    expect(rec.loader.containerUrls).toEqual([GTM_A]);
    expect(rec.loader.insertedBy).toEqual([GTM_A]);
    expect(rec.loader.frameOrigin).toBe("https://www.example.com");
    expect(rec.loader.topFrame).toBe(true);
  });

  it("does nothing for a non-script node beyond delegating", () => {
    const h = harness();
    const head = new h.Element();
    head.appendChild(el("div"));
    head.appendChild({ nodeType: 3 });
    expect(h.calls).toEqual(["appendChild", "appendChild"]);
    expect(h.insertions).toHaveLength(0);
  });

  it("covers every wrapped method with its own via", () => {
    const h = harness();
    const e = new h.Element();
    const r = new h.Range();
    const mk = (n: string) => el("script", { src: `https://v.example/${n}.js` });
    e.insertBefore(mk("insertBefore"));
    e.replaceChild(mk("replaceChild"));
    e.append(mk("append"));
    e.prepend(mk("prepend"));
    e.before(mk("before"));
    e.after(mk("after"));
    e.replaceWith(mk("replaceWith"));
    e.insertAdjacentElement("beforeend", mk("insertAdjacentElement"));
    r.insertNode(mk("insertNode"));
    expect(h.insertions.map((i) => i.loader.via)).toEqual([
      "insertBefore", "replaceChild", "append", "prepend", "before", "after", "replaceWith", "insertAdjacentElement", "insertNode",
    ]);
  });

  it("sees scripts inside a DocumentFragment", () => {
    const h = harness();
    const frag = { nodeType: 11, querySelectorAll: () => [el("script", { src: "https://v.example/f.js" })] };
    new h.Element().appendChild(frag);
    expect(h.insertions.map((i) => i.key)).toEqual(["https://v.example/f.js"]);
  });

  it("records a src set after insertion, on the microtask", async () => {
    const h = harness();
    const s = el("script");
    new h.Element().appendChild(s);
    expect(h.insertions).toHaveLength(0);
    s.src = "https://v.example/late.js";
    await Promise.resolve();
    expect(h.insertions.map((i) => i.key)).toEqual(["https://v.example/late.js"]);
    expect(h.observer!.coverage.srcUnresolved).toBe(0);
  });

  it("records an inline element by a synthetic key, and resolves a later inline-only stack to it", () => {
    let current: FakeEl | null = null;
    const h = harness(() => (current ? stackOf(PAGE) : stackOf(GTM_A)));
    const inline = el("script", { textContent: "insertVendor()" });
    new h.Element().appendChild(inline);
    const inlineKey = h.insertions[0]!.key;
    expect(inlineKey).toMatch(/^inline:[a-z0-9]+:1$/);
    expect(h.insertions[0]!.loader.containerUrls).toEqual([GTM_A]);
    expect(h.observer!.coverage.inline).toBe(1);

    // Now the inline snippet runs and inserts the vendor: its stack is inline-only, and
    // document.currentScript is the element we just saw.
    current = inline;
    h.doc.currentScript = inline;
    new h.Element().appendChild(el("script", { src: "https://v.example/from-inline.js" }));
    const rec = h.insertions[1]!;
    expect(rec.loader.inlineFrames).toBe(true);
    expect(rec.loader.insertedBy).toEqual([]);
    expect(rec.loader.currentScriptKey).toBe(inlineKey);
    expect(h.observer!.coverage.inlineResolvedByCurrentScript).toBe(1);
  });

  it("names a parser-inserted inline snippet on the spot when it is the current script", () => {
    // The site's own snippet executes before the DOMContentLoaded enumeration reaches it.
    const h = harness(() => stackOf(PAGE));
    const snippet = el("script", { textContent: "(function(){ insertVendor() })()" });
    h.doc.currentScript = snippet;
    new h.Element().appendChild(el("script", { src: "https://v.example/from-snippet.js" }));
    const [inlineRec, vendorRec] = h.insertions;
    expect(inlineRec!.loader.via).toBe("parser");
    expect(vendorRec!.loader.currentScriptKey).toBe(inlineRec!.key);
    // The enumeration later finds the same element and does not record it twice.
    h.scripts.push(snippet);
    h.observer!.rescan();
    expect(h.insertions.filter((i) => i.key === inlineRec!.key)).toHaveLength(1);
  });

  it("leaves currentScriptKey null for an inline-only stack with no current script (a deferred callback)", () => {
    const h = harness(() => stackOf(PAGE));
    h.doc.currentScript = null;
    new h.Element().appendChild(el("script", { src: "https://v.example/deferred.js" }));
    expect(h.insertions[0]!.loader.currentScriptKey).toBeNull();
    expect(h.insertions[0]!.loader.inlineFrames).toBe(true);
  });

  it("counts a non-executing script type instead of recording it", () => {
    const h = harness();
    new h.Element().appendChild(el("script", { src: "https://v.example/gated.js", attrs: { type: "text/plain" } }));
    expect(h.insertions).toHaveLength(0);
    expect(h.observer!.coverage.nonExecuting).toBe(1);
  });

  it("records an iframe, and a friendly iframe under about:blank", () => {
    const h = harness();
    const e = new h.Element();
    e.appendChild(el("iframe", { src: "https://ads.example/frame.html" }));
    e.appendChild(el("iframe"));
    expect(h.insertions.map((i) => [i.element, i.key])).toEqual([
      ["iframe", "https://ads.example/frame.html"],
      ["iframe", "about:blank"],
    ]);
  });

  it("re-reports a repeat as a count, and a fourth loader of one key is counted only", () => {
    let n = 0;
    const h = harness(() => stackOf(`https://loader${n}.example/x.js`));
    const e = new h.Element();
    const same = () => el("script", { src: "https://v.example/tag.js" });
    e.appendChild(same());
    e.appendChild(same()); // same loader: a duplicate
    expect(h.insertions).toHaveLength(1);
    expect(h.observer!.coverage.duplicates).toBe(1);
    for (n = 1; n <= 4; n++) e.appendChild(same()); // four more distinct loaders
    // three loaders recorded (0, 1, 2); the fourth and fifth counted, not recorded.
    expect(h.insertions.filter((i) => i.key === "https://v.example/tag.js")).toHaveLength(3);
    expect(h.observer!.coverage.duplicates).toBe(3);
  });

  it("stops recording past the key cap, and counts", () => {
    const h = harness();
    const e = new h.Element();
    for (let i = 0; i < KEY_CAP + 5; i++) e.appendChild(el("script", { src: `https://v.example/${i}.js` }));
    expect(h.insertions).toHaveLength(KEY_CAP);
    expect(h.observer!.coverage.capExceeded).toBe(5);
    expect(h.calls).toHaveLength(KEY_CAP + 5); // every call still delegated
  });

  it("records a document.write script source with the writer's stack", () => {
    const h = harness(() => stackOf("https://v.example/writer.js"));
    h.doc.write('<script src="/written.js"></script>');
    expect(h.calls).toEqual(["write"]);
    const rec = h.insertions[0]!;
    expect(rec.key).toBe("https://www.example.com/written.js");
    expect(rec.loader.via).toBe("write");
    expect(rec.loader.insertedBy).toEqual(["https://v.example/writer.js"]);
  });

  it("rethrows the original's exception and never throws from the recorder", () => {
    const h = harness(() => {
      throw new Error("stack capture broke");
    });
    const e = new h.Element();
    // The recorder's failure is counted; the insertion still delegates and returns.
    const s = el("script", { src: "https://v.example/a.js" });
    expect(e.appendChild(s)).toBe(s);
    expect(h.observer!.coverage.stackFailed).toBe(1);
    // The original throwing is the page's exception, passed through untouched.
    h.Node.prototype.insertBefore = () => {
      throw new TypeError("not a child");
    };
    expect(() => e.insertBefore(el("script", { src: "https://v.example/b.js" }))).toThrow(TypeError);
  });

  it("self-disables recording after repeated recorder exceptions, delegation intact", () => {
    const h = harness();
    // A node whose localName getter throws makes the recorder throw.
    const hostile = {
      get localName(): string {
        throw new Error("hostile");
      },
    };
    const e = new h.Element();
    for (let i = 0; i < SELF_DISABLE_AFTER; i++) e.appendChild(hostile);
    expect(h.observer!.coverage.selfDisabled).toBe(true);
    e.appendChild(el("script", { src: "https://v.example/after.js" }));
    expect(h.insertions).toHaveLength(0);
    expect(h.calls).toHaveLength(SELF_DISABLE_AFTER + 1);
  });

  it("rescan records parser-inserted elements positively and reports coverage", () => {
    const h = harness();
    const seenLater = el("script", { src: "https://v.example/dyn.js" });
    new h.Element().appendChild(seenLater);
    h.scripts.push(seenLater, el("script", { src: "https://v.example/in-html.js" }), el("script", { textContent: "x()" }));
    h.iframes.push(el("iframe", { src: "https://ads.example/i.html" }));
    h.observer!.rescan();
    const parser = h.insertions.filter((i) => i.loader.via === "parser");
    expect(parser.map((i) => i.key.replace(/^inline:[a-z0-9]+:/, "inline:"))).toEqual([
      "https://v.example/in-html.js",
      "inline:1",
      "https://ads.example/i.html",
    ]);
    expect(h.observer!.coverage.parser).toBe(3);
    expect(h.coverages).toHaveLength(1);
    // Idempotent: a second scan adds nothing.
    h.observer!.rescan();
    expect(h.insertions.filter((i) => i.loader.via === "parser")).toHaveLength(3);
  });

  it("notices when another wrapper replaced appendChild after us", () => {
    const h = harness();
    h.observer!.rescan();
    expect(h.observer!.coverage.wrappedOver).toBe(false);
    const ours = h.Node.prototype.appendChild;
    h.Node.prototype.appendChild = function (n: unknown) {
      return ours.call(this, n);
    };
    h.observer!.rescan();
    expect(h.observer!.coverage.wrappedOver).toBe(true);
  });

  it("returns null when the prototypes cannot be wrapped", () => {
    const win = { Node: undefined, Element: undefined } as unknown as Window & typeof globalThis;
    const r = installScriptInsertionObserver(
      win,
      {} as Document,
      { initialUrl: PAGE, frameOrigin: "", topFrame: true },
      { onInsertion: () => {}, onCoverage: () => {} },
    );
    expect(r).toBeNull();
  });
});
