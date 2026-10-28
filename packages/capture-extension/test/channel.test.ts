// SPDX-License-Identifier: GPL-3.0-only
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  acceptChannel,
  acceptJoins,
  closeBeforePageScripts,
  join,
  mayCarryPageCode,
  offerChannel,
  HELLO_EVENT,
  OFFER_EVENT,
  JOIN_EVENT,
  type AddedNode,
  type Carrier,
  type JoinDetail,
} from "../src/content/channel.js";

/**
 * In Node there is one realm and no MouseEvent, so the node rides on a CustomEvent's detail.
 * What the tests ask is the same: who gets the node, and when the handshake closes.
 */
const CARRIER: Carrier = {
  offer: (node) => new CustomEvent(OFFER_EVENT, { detail: node }),
  nodeOf: (event) => ((event as CustomEvent<unknown>).detail as EventTarget | null) ?? null,
};

/** A count of the offers made on `doc`, from a listener the page would have added later. */
function offersSeen(doc: EventTarget): () => number {
  let n = 0;
  doc.addEventListener(OFFER_EVENT, () => n++);
  return () => n;
}

describe("the channel handshake", () => {
  it("hands the node over when the MAIN world runs first", () => {
    const doc = new EventTarget();
    const node = new EventTarget();
    offerChannel(doc, node, CARRIER);
    const got: EventTarget[] = [];
    acceptChannel(doc, (n) => got.push(n), CARRIER);
    expect(got).toEqual([node]);
  });

  it("hands the node over when the bridge runs first", () => {
    const doc = new EventTarget();
    const node = new EventTarget();
    const got: EventTarget[] = [];
    acceptChannel(doc, (n) => got.push(n), CARRIER);
    offerChannel(doc, node, CARRIER);
    expect(got).toEqual([node]);
  });

  it("stops answering hellos once the bridge has the node, in either order", () => {
    for (const mainFirst of [true, false]) {
      const doc = new EventTarget();
      const node = new EventTarget();
      if (mainFirst) offerChannel(doc, node, CARRIER);
      acceptChannel(doc, () => undefined, CARRIER);
      if (!mainFirst) offerChannel(doc, node, CARRIER);
      // A page script, later, says hello to fish for the node.
      const seen = offersSeen(doc);
      doc.dispatchEvent(new Event(HELLO_EVENT));
      expect(seen()).toBe(0);
    }
  });

  it("ignores a later offer: the page cannot swap in a node of its own", () => {
    const doc = new EventTarget();
    const node = new EventTarget();
    offerChannel(doc, node, CARRIER);
    const got: EventTarget[] = [];
    acceptChannel(doc, (n) => got.push(n), CARRIER);
    doc.dispatchEvent(CARRIER.offer(new EventTarget()));
    expect(got).toEqual([node]);
  });

  it("takes no offer once it closes before page scripts: MAIN never offered, the page cannot", () => {
    const doc = new EventTarget();
    const got: EventTarget[] = [];
    acceptChannel(doc, (n) => got.push(n), CARRIER, (close) => doc.addEventListener("done", close));
    doc.dispatchEvent(new Event("done"));
    doc.dispatchEvent(CARRIER.offer(new EventTarget()));
    expect(got).toEqual([]);
  });

  it("closes at DOMContentLoaded where no MutationObserver can watch", () => {
    const doc = new EventTarget();
    const got: EventTarget[] = [];
    acceptChannel(doc, (n) => got.push(n), CARRIER);
    doc.dispatchEvent(new Event("DOMContentLoaded"));
    doc.dispatchEvent(CARRIER.offer(new EventTarget()));
    expect(got).toEqual([]);
  });

  it("delivers what MAIN sends on the node, and nothing the page sends on the document", () => {
    const doc = new EventTarget();
    const node = new EventTarget();
    offerChannel(doc, node, CARRIER);
    const heard: string[] = [];
    acceptChannel(doc, (n) => n.addEventListener("__gpcInspectorObserve", (e) => heard.push(String((e as CustomEvent).detail))), CARRIER);
    doc.dispatchEvent(new CustomEvent("__gpcInspectorObserve", { detail: "forged" }));
    node.dispatchEvent(new CustomEvent("__gpcInspectorObserve", { detail: "ours" }));
    expect(heard).toEqual(["ours"]);
  });
});

describe("the registered scripts' joins", () => {
  const collect = (doc: EventTarget): string[] => {
    const slots: string[] = [];
    acceptJoins(doc, (d) => slots.push(d.slot), (close) => doc.addEventListener("done", close));
    return slots;
  };

  it("takes the first claim of each slot", () => {
    const doc = new EventTarget();
    const slots = collect(doc);
    join(doc, { slot: "assert" });
    join(doc, { slot: "assert" });
    join(doc, { slot: "trace-all" });
    expect(slots).toEqual(["assert", "trace-all"]);
  });

  it("takes the claim that turns the confirmation scan off, once", () => {
    const doc = new EventTarget();
    const slots = collect(doc);
    join(doc, { slot: "no-confirmation" });
    join(doc, { slot: "no-confirmation" });
    expect(slots).toEqual(["no-confirmation"]);
  });

  it("takes the lock claim, once", () => {
    const doc = new EventTarget();
    const slots = collect(doc);
    join(doc, { slot: "assert" });
    join(doc, { slot: "lock" });
    join(doc, { slot: "lock" });
    expect(slots).toEqual(["assert", "lock"]);
  });

  it("takes nothing after the seal, so a slot left empty by its setting stays empty", () => {
    const doc = new EventTarget();
    const slots = collect(doc);
    join(doc, { slot: "trace-all" });
    join(doc, { slot: "seal" });
    // A page script, later, claiming permission to assert or to lock.
    join(doc, { slot: "assert" });
    join(doc, { slot: "lock" });
    expect(slots).toEqual(["trace-all"]);
  });

  it("closes before page scripts when no seal came", () => {
    const doc = new EventTarget();
    const slots = collect(doc);
    doc.dispatchEvent(new Event("done"));
    join(doc, { slot: "assert" });
    expect(slots).toEqual([]);
  });

  it("gives the insertion observer its way out, and ignores a claim that is not one", () => {
    const doc = new EventTarget();
    const sent: unknown[] = [];
    acceptJoins(doc, (d) => {
      if (d.slot === "insertion") d.receive((x) => sent.push(x));
    }, (close) => doc.addEventListener("done", close));
    let send: ((x: unknown) => void) | null = null;
    join(doc, { slot: "insertion", receive: (s) => (send = s) });
    doc.dispatchEvent(new CustomEvent(JOIN_EVENT, { detail: { slot: "something-else" } as unknown as JoinDetail }));
    doc.dispatchEvent(new CustomEvent(JOIN_EVENT, { detail: null }));
    (send as ((x: unknown) => void) | null)?.("record");
    expect(sent).toEqual(["record"]);
  });
});

describe("closing before page scripts", () => {
  const el = (tagName: string, attrs: string[] = [], children: AddedNode[] = []): AddedNode => ({
    nodeType: 1,
    tagName,
    attributes: attrs.map((name) => ({ name })),
    children,
  });

  it("treats text, comments and inert elements as no page code, and anything else as page code", () => {
    expect(mayCarryPageCode({ nodeType: 3 })).toBe(false);
    expect(mayCarryPageCode({ nodeType: 8 })).toBe(false);
    expect(mayCarryPageCode(el("STYLE", ["class"]))).toBe(false);
    expect(mayCarryPageCode(el("HEAD", [], [el("META"), el("LINK")]))).toBe(false);
    expect(mayCarryPageCode(el("SCRIPT"))).toBe(true);
    expect(mayCarryPageCode(el("IMG"))).toBe(true);
    expect(mayCarryPageCode(el("LINK", ["onload"]))).toBe(true);
    expect(mayCarryPageCode(el("HEAD", [], [el("SCRIPT")]))).toBe(true);
  });

  // Node has no DOM: a fake Node and MutationObserver stand in for the page's.
  class FakeNode extends EventTarget {}
  let observers: { callback: (records: { addedNodes: AddedNode[] }[]) => void; options: unknown; disconnected: boolean }[] = [];
  class FakeObserver {
    readonly entry: (typeof observers)[number];
    constructor(callback: (records: { addedNodes: AddedNode[] }[]) => void) {
      this.entry = { callback, options: null, disconnected: false };
      observers.push(this.entry);
    }
    observe(_target: unknown, options: unknown): void {
      this.entry.options = options;
    }
    disconnect(): void {
      this.entry.disconnected = true;
    }
  }
  afterEach(() => {
    vi.unstubAllGlobals();
    observers = [];
  });

  it("watches the whole document, stays open for another extension's style, and closes at a script", () => {
    vi.stubGlobal("Node", FakeNode);
    vi.stubGlobal("MutationObserver", FakeObserver);
    const doc = new FakeNode();
    let closed = 0;
    closeBeforePageScripts(doc, () => closed++);
    const [o] = observers;
    expect(o?.options).toEqual({ childList: true, subtree: true });
    o?.callback([{ addedNodes: [el("STYLE")] }]);
    expect(closed).toBe(0);
    o?.callback([{ addedNodes: [el("HEAD")] }, { addedNodes: [el("SCRIPT")] }]);
    expect(closed).toBe(1);
    expect(o?.disconnected).toBe(true);
    doc.dispatchEvent(new Event("DOMContentLoaded"));
    expect(closed).toBe(1);
  });
});
