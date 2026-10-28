// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import {
  OpenShadowRoots,
  renderedText,
  MAX_SHADOW_ROOTS,
  type ElementLike,
  type NodeLike,
  type RootLike,
} from "../src/observe/page-text.js";
import { findConfirmationNotice } from "../src/observe/consent-data.js";

/**
 * A fake DOM with the members page-text.ts reads. Its innerText behaves as Chrome's does
 * (checked in Chrome 144): it walks the light tree only, so it holds neither a shadow root's
 * text nor a slot's assigned nodes, and on an element that is not rendered it returns the
 * whole text, as textContent would.
 */
interface FakeNode extends NodeLike {
  parentNode: FakeNode | null;
  childNodes: FakeNode[];
}
interface FakeElement extends FakeNode, ElementLike {
  parentNode: FakeNode | null;
  childNodes: FakeNode[];
  shadowRoot: FakeRoot | null;
  display: string;
  boxless: boolean;
}
interface FakeRoot extends FakeNode, RootLike {
  parentNode: FakeNode | null;
  childNodes: FakeNode[];
  host: FakeElement;
}

function text(data: string): FakeNode {
  return {
    nodeType: 3,
    parentNode: null,
    childNodes: [],
    get textContent() {
      return data;
    },
  };
}

function allText(node: FakeNode): string {
  return node.nodeType === 3 ? (node.textContent ?? "") : node.childNodes.map(allText).join("");
}

function lightDescendants(node: FakeNode): FakeElement[] {
  const out: FakeElement[] = [];
  for (const child of node.childNodes) {
    if (child.nodeType !== 1) continue;
    out.push(child as FakeElement, ...lightDescendants(child));
  }
  return out;
}

function rendered(node: FakeNode): string {
  if (node.nodeType === 3) return (node.textContent ?? "").replace(/\s+/g, " ");
  const el = node as FakeElement;
  if (el.display === "none" || el.boxless) return "";
  const inner = el.childNodes.map(rendered).join("");
  return el.display.startsWith("inline") ? inner : `\n${inner}\n`;
}

function el(
  localName: string,
  children: (FakeNode | string)[] = [],
  opts: { display?: string; boxless?: boolean } = {},
): FakeElement {
  const node: FakeElement = {
    nodeType: 1,
    localName,
    parentNode: null,
    childNodes: [],
    shadowRoot: null,
    display: opts.display ?? (localName === "slot" ? "contents" : localName === "span" || localName === "b" ? "inline" : "block"),
    boxless: opts.boxless ?? false,
    get textContent() {
      return allText(node);
    },
    get innerText() {
      if (node.display === "none" || node.boxless) return allText(node);
      return node.childNodes.map(rendered).join("").replace(/^\n+|\n+$/g, "");
    },
    getClientRects: () => ({ length: node.display === "none" || node.boxless || node.display === "contents" ? 0 : 1 }),
    querySelectorAll: (selector) => lightDescendants(node).filter((e) => selector === "*" || e.localName === selector),
  };
  for (const c of children) append(node, typeof c === "string" ? text(c) : c);
  if (localName === "slot") {
    node.assignedNodes = () => {
      // The default slot: the host's light children, or the slot's own as fallback.
      let n: FakeNode | null = node.parentNode;
      while (n && n.nodeType !== 11) n = n.parentNode;
      const assigned = n ? (n as FakeRoot).host.childNodes : [];
      return assigned.length > 0 ? assigned : node.childNodes;
    };
  }
  return node;
}

function append(parent: FakeNode, child: FakeNode): void {
  child.parentNode = parent;
  parent.childNodes.push(child);
}

function attach(host: FakeElement, children: (FakeNode | string)[]): FakeRoot {
  const root: FakeRoot = {
    nodeType: 11,
    host,
    parentNode: null,
    childNodes: [],
    get textContent() {
      return allText(root);
    },
    querySelectorAll: (selector) => lightDescendants(root).filter((e) => selector === "*" || e.localName === selector),
  };
  for (const c of children) append(root, typeof c === "string" ? text(c) : c);
  host.shadowRoot = root;
  return root;
}

function registry(body: FakeElement, defined: Set<string> = new Set()) {
  const pending = new Map<string, () => void>();
  const roots = new OpenShadowRoots({
    page: () => [body],
    isDefined: (name) => defined.has(name),
    whenDefined: (name) =>
      new Promise<void>((resolve) => {
        pending.set(name, resolve);
      }),
  });
  return {
    roots,
    define: async (name: string) => {
      defined.add(name);
      pending.get(name)?.();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

const display = (e: ElementLike): string => (e as FakeElement).display;

function pageText(body: FakeElement): string {
  const { roots } = registry(body);
  roots.discover();
  return renderedText(body, roots.roots, display);
}

describe("open shadow roots in the confirmation scan", () => {
  it("reads a page without roots as body.innerText alone", () => {
    const body = el("body", [el("p", ["Opt-Out Request Honored"]), el("p", ["Footer"])]);
    expect(pageText(body)).toBe(body.innerText);
  });

  it("finds a notice inside an open root, where the host stands", () => {
    const host = el("div");
    attach(host, [el("p", ["Opt-Out Preference Signal Honored"])]);
    const body = el("body", [el("p", ["Before"]), host, el("p", ["After"])]);
    expect(body.innerText).not.toContain("Honored");
    const t = pageText(body);
    expect(t.indexOf("Before")).toBeLessThan(t.indexOf("Honored"));
    expect(t.indexOf("Honored")).toBeLessThan(t.indexOf("After"));
    expect(findConfirmationNotice(t)?.patternIndex).toBe(0);
  });

  it("finds roots nested in roots", () => {
    const inner = el("div");
    attach(inner, [el("p", ["GPC signal detected"])]);
    const outer = el("div");
    attach(outer, [el("section", [el("p", ["Consent dialog"]), inner])]);
    const body = el("body", [outer]);
    const { roots } = registry(body);
    roots.discover();
    expect(roots.roots).toHaveLength(2);
    expect(findConfirmationNotice(renderedText(body, roots.roots, display))?.patternIndex).toBe(8);
  });

  it("reads slotted content where its slot stands, and not where the host's light children are", () => {
    const host = el("div", [el("span", ["slotted words"])]);
    attach(host, [el("div", ["before ", el("slot"), " after"])]);
    const body = el("body", [host]);
    expect(pageText(body).trim()).toBe("before slotted words after");
  });

  it("joins inline content inside and around a host into one line", () => {
    const host = el("span");
    attach(host, ["signal"]);
    const body = el("body", [el("p", ["GPC ", host, " detected"])]);
    expect(pageText(body).trim()).toBe("GPC signal detected");
  });

  it("leaves out what is not rendered: hidden, without a box, or not slotted", () => {
    const host = el("div", [el("b", ["Opt-Out Request Honored"])]); // a light child no slot takes
    attach(host, [
      el("p", ["Opt-Out Signal Honored"], { display: "none" }),
      el("p", ["GPC Honored"], { boxless: true }),
      el("p", ["Consent dialog"]),
    ]);
    const body = el("body", [host]);
    const t = pageText(body);
    expect(t).toContain("Consent dialog");
    expect(findConfirmationNotice(t)).toBeNull();
  });

  it("reads through display: contents", () => {
    const host = el("div", [], { display: "contents" });
    attach(host, [el("p", ["Opt-Out Request Honored"])]);
    const body = el("body", [host]);
    expect(findConfirmationNotice(pageText(body))?.patternIndex).toBe(0);
  });

  it("stops at MAX_SHADOW_ROOTS", () => {
    const hosts = Array.from({ length: MAX_SHADOW_ROOTS + 5 }, () => {
      const h = el("div");
      attach(h, ["x"]);
      return h;
    });
    const { roots } = registry(el("body", hosts));
    roots.discover();
    expect(roots.roots).toHaveLength(MAX_SHADOW_ROOTS);
  });

  it("finds a root under inserted nodes, and tells each subscriber once", () => {
    const body = el("body", [el("p", ["Page"])]);
    const { roots } = registry(body);
    roots.discover();
    const seen: string[] = [];
    roots.subscribe((r) => seen.push(r.textContent ?? ""));
    const host = el("div");
    attach(host, ["Opt-Out Signal Honored"]);
    append(body, host);
    roots.discover([host]);
    roots.discover();
    expect(seen).toEqual(["Opt-Out Signal Honored"]);
    expect(roots.textContent()).toContain("Opt-Out Signal Honored");
  });

  it("finds the root a custom element gets when its definition loads later", async () => {
    const host = el("cmp-dialog");
    const body = el("body", [host]);
    const r = registry(body);
    r.roots.discover();
    expect(r.roots.roots).toHaveLength(0);
    attach(host, ["Opt-Out Request Honored"]); // the upgrade, with no mutation to see
    await r.define("cmp-dialog");
    expect(r.roots.roots).toHaveLength(1);
  });

  it("does not wait on a custom element already defined", async () => {
    const host = el("cmp-dialog");
    const r = registry(el("body", [host]), new Set(["cmp-dialog"]));
    r.roots.discover();
    attach(host, ["Opt-Out Request Honored"]); // a closed root would stay unseen; this is the next search's
    await r.define("cmp-dialog");
    expect(r.roots.roots).toHaveLength(0);
  });
});
