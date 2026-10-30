// SPDX-License-Identifier: GPL-3.0-only
/**
 * The private channel between the MAIN-world scripts and the bridge.
 *
 * The two worlds share the DOM and nothing else, so DOM events are the only way across. Not
 * events on `document` under fixed names: the page shares `document`, so any script on it
 * could dispatch `__gpcInspectorObserve` with a made-up cookie write, a GPP payload or a
 * signal state, and the bridge would relay it as an observation. A site could hide what it
 * did, or a script could put a cookie on a vendor that never set it, and the record would
 * present either as what the page did. It could also listen for the names and learn the
 * extension was there.
 *
 * The events go over a detached element the MAIN world creates and the page never
 * holds. Both worlds can reach a DOM node, and a page script can only dispatch on a node
 * it has a reference to. The node is handed over once, through a handshake on `document`
 * that is over before any page script runs:
 *
 *   - Content scripts declared for document_start run before the page's first script, in
 *     both worlds, but in no guaranteed order between the two (see protocol.ts). So each
 *     side starts the handshake as well as answering it. The MAIN world offers the node at
 *     once and answers a hello; the bridge listens for the offer and then says hello.
 *     Whichever runs second completes the exchange, synchronously, inside its own run.
 *   - The node rides on a MouseEvent's `relatedTarget`. A CustomEvent's `detail` is copied
 *     between worlds and a node does not copy; `relatedTarget` is the node itself.
 *   - The bridge takes the first offer and no other, and acknowledges on the node. The
 *     MAIN world stops answering hellos at the acknowledgment, so a hello a page sends
 *     later goes unanswered.
 *
 * The MAIN-world scripts the worker registers by setting (the withdrawal of the property
 * while sending is off, the lock, the uncapped read tracing, the insertion observer) join
 * through `document` too, in the same realm as main-world.js, and before any page script.
 * Each slot is taken by its first claim, and the seal the worker registers after them
 * closes every slot, so a page cannot claim one its setting left empty. Without a seal (the
 * worker had not registered the scripts yet, after an install or an update, or the browser
 * refused the registration) the slots close before the first page script can run
 * (closeBeforePageScripts). The bridge stops taking offers at the same point, so a page
 * cannot offer a node of its own where main-world.js never offered one.
 *
 * The one exception is a page that was already open when the worker started, which the
 * worker brings up to date by injecting these scripts (sw.ts, the start-up pass). Its
 * scripts are running by then, so the handshake is not over before them: a page that
 * listens for the hello could offer a node of its own first. The record of such a page is
 * marked as a load the extension did not observe, and says to reload it.
 */

/** Bridge to MAIN, on `document`: I am listening; offer the channel. */
export const HELLO_EVENT = "__gpcInspectorHello";
/** MAIN to bridge, on `document`: a MouseEvent whose relatedTarget is the channel node. */
export const OFFER_EVENT = "__gpcInspectorOffer";
/** Bridge to MAIN, on the node: the offer was taken. */
export const ACK_EVENT = "__gpcInspectorAck";
/** A registered MAIN-world script to main-world.js, on `document`: a JoinDetail. */
export const JOIN_EVENT = "__gpcInspectorJoin";

/**
 * A claim from a script the worker registers by setting. `insertion` receives the function
 * its records go out through.
 */
export type JoinDetail =
  | { readonly slot: "deny" }
  | { readonly slot: "lock" }
  | { readonly slot: "trace-all" }
  | { readonly slot: "no-confirmation" }
  | { readonly slot: "insertion"; readonly receive: (send: (detail: unknown) => void) => void }
  | { readonly slot: "seal" };

export type JoinSlot = Exclude<JoinDetail["slot"], "seal">;

/** How an offer carries the node, and how the bridge reads it back. Injected for tests. */
export interface Carrier {
  offer(node: EventTarget): Event;
  nodeOf(event: Event): EventTarget | null;
}

/** Calls `close` once, at the point it is given. Injected for tests. */
export type Closer = (close: () => void) => void;

/** Elements that hold no code: added before a page script, by the parser or an extension. */
const INERT_TAGS = new Set(["HEAD", "STYLE", "LINK", "META", "TITLE"]);

/** The part of a DOM node closeBeforePageScripts reads. */
export interface AddedNode {
  readonly nodeType: number;
  readonly tagName?: string;
  readonly attributes?: ArrayLike<{ readonly name: string }>;
  readonly children?: ArrayLike<AddedNode>;
}

/**
 * Whether an added node can carry page code: anything but text, a comment, or an inert
 * element with no event handler attribute and nothing but the same inside it. Another
 * extension's style sheet at document_start is not the page.
 */
export function mayCarryPageCode(node: AddedNode): boolean {
  if (node.nodeType === 3 || node.nodeType === 8) return false;
  if (node.nodeType !== 1 || !INERT_TAGS.has((node.tagName ?? "").toUpperCase())) return true;
  for (const a of Array.from(node.attributes ?? [])) if (a.name.toLowerCase().startsWith("on")) return true;
  return Array.from(node.children ?? []).some(mayCarryPageCode);
}

/**
 * Calls `close` before the first page script can run: at the first node added to the
 * document that can carry page code (mayCarryPageCode). Every content script at
 * document_start, the ones the worker registers included, runs while the document holds
 * only its root element, and the parser performs a microtask checkpoint, where a
 * MutationObserver is told, before it runs a script it inserted. An event handler or a
 * timer of the page's comes later still. DOMContentLoaded is the backstop where no
 * MutationObserver can watch.
 */
export function closeBeforePageScripts(doc: EventTarget, close: () => void): void {
  let observer: MutationObserver | null = null;
  let closed = false;
  const once = (): void => {
    if (closed) return;
    closed = true;
    observer?.disconnect();
    doc.removeEventListener("DOMContentLoaded", once);
    close();
  };
  doc.addEventListener("DOMContentLoaded", once);
  try {
    if (typeof MutationObserver === "function" && typeof Node === "function" && doc instanceof Node) {
      observer = new MutationObserver((records) => {
        if (records.some((r) => Array.from(r.addedNodes).some((n) => mayCarryPageCode(n as unknown as AddedNode)))) once();
      });
      observer.observe(doc, { childList: true, subtree: true });
    }
  } catch {
    /* the DOMContentLoaded backstop stands */
  }
}

/** The real carrier: the node as a MouseEvent's relatedTarget. */
export const MOUSE_EVENT_CARRIER: Carrier = {
  offer: (node) => new MouseEvent(OFFER_EVENT, { relatedTarget: node }),
  nodeOf: (event) => (event as MouseEvent).relatedTarget ?? null,
};

/**
 * MAIN world: offer `node` to the bridge, now and on its hello, until it acknowledges.
 * Anything that listens on the node should be attached before this is called: the bridge
 * may take the offer, and ask for the signal state, inside this call.
 */
export function offerChannel(doc: EventTarget, node: EventTarget, carrier: Carrier = MOUSE_EVENT_CARRIER): void {
  const offer = (): void => {
    try {
      doc.dispatchEvent(carrier.offer(node));
    } catch {
      /* never break the page */
    }
  };
  doc.addEventListener(HELLO_EVENT, offer);
  node.addEventListener(ACK_EVENT, () => doc.removeEventListener(HELLO_EVENT, offer), { once: true });
  offer();
}

/**
 * Bridge: take the first offer, call `bound` with the node, and acknowledge. When the MAIN
 * world has already run, the offer is taken inside this call, on its answer to the hello.
 * No offer is taken once `closeWhen` closes (before page scripts): one after that is the
 * page's, as main-world.js offers at document_start or not at all.
 */
export function acceptChannel(
  doc: EventTarget,
  bound: (node: EventTarget) => void,
  carrier: Carrier = MOUSE_EVENT_CARRIER,
  closeWhen: Closer = (close) => closeBeforePageScripts(doc, close),
): void {
  let taken = false;
  const onOffer = (e: Event): void => {
    if (taken) return;
    const node = carrier.nodeOf(e);
    if (node === null || node === doc) return;
    taken = true;
    doc.removeEventListener(OFFER_EVENT, onOffer);
    bound(node);
    node.dispatchEvent(new Event(ACK_EVENT));
  };
  doc.addEventListener(OFFER_EVENT, onOffer);
  doc.dispatchEvent(new Event(HELLO_EVENT));
  if (!taken) closeWhen(() => doc.removeEventListener(OFFER_EVENT, onOffer));
}

/**
 * main-world.js: accept the registered scripts' claims, the first per slot, until the seal
 * or `closeWhen` (before page scripts), whichever comes first.
 */
export function acceptJoins(
  doc: EventTarget,
  onJoin: (detail: Exclude<JoinDetail, { slot: "seal" }>) => void,
  closeWhen: Closer = (close) => closeBeforePageScripts(doc, close),
): void {
  const taken = new Set<JoinSlot>();
  const close = (): void => {
    doc.removeEventListener(JOIN_EVENT, onClaim);
  };
  function onClaim(e: Event): void {
    const detail = (e as CustomEvent<unknown>).detail as JoinDetail | null | undefined;
    if (detail === null || typeof detail !== "object") return;
    if (detail.slot === "seal") {
      close();
      return;
    }
    if (
      detail.slot !== "deny" &&
      detail.slot !== "lock" &&
      detail.slot !== "trace-all" &&
      detail.slot !== "no-confirmation" &&
      detail.slot !== "insertion"
    ) return;
    if (taken.has(detail.slot)) return;
    taken.add(detail.slot);
    try {
      onJoin(detail);
    } catch {
      /* never break the page */
    }
  }
  doc.addEventListener(JOIN_EVENT, onClaim);
  closeWhen(close);
}

/** A registered script's claim, dispatched on `document`. */
export function join(doc: EventTarget, detail: JoinDetail): void {
  try {
    doc.dispatchEvent(new CustomEvent(JOIN_EVENT, { detail }));
  } catch {
    /* never break the page */
  }
}
