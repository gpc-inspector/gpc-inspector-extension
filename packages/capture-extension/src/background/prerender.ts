// SPDX-License-Identifier: GPL-3.0-only
/**
 * A prerendered page's capture, held until the page is shown.
 *
 * Chrome can load a page before the reader goes to it: a prerender, started by the address
 * bar for an address it expects the reader to open, or by a page's speculation rules. The
 * prerendered page loads in the tab of the page on screen, in a frame of its own, and
 * everything it does reaches the worker with that tab's id, a frameId other than 0, and
 * `documentLifecycle: "prerender"`. When the reader goes to it, Chrome activates it: a
 * top-level navigation starts and commits the document that was prerendered. No request is
 * made and no content script runs again, because the page has already loaded.
 *
 * Counted as they arrive, the prerender's requests and reports would land on the page on
 * screen, and the page shown afterwards would start empty. Worse, its document would be
 * recorded as one of the page on screen's documents, so the reset at the start of the
 * activation would retire it, and everything it did after it was shown would be dropped as
 * another page's (documents.ts). So a prerender's changes are held here, one queue per
 * prerender, and handed to the tab when its document is activated, in the order they
 * arrived, as the start of the page.
 *
 * In memory. A worker that stops while a prerender waits takes the queue with it, and the
 * tab's record keeps the prerendered document's id (TabState.prerenderDocuments) so that
 * the activation is still known for one and the capture is marked incomplete.
 */

/** A change to a tab's state, as the worker queues it. */
export type HeldChange<S> = (state: S) => void;

/** What an event says about the frame it came from. Chrome sends these on webRequest and webNavigation details and on a message's sender. */
export interface EventFrame {
  readonly frameId?: number | undefined;
  readonly parentFrameId?: number | undefined;
  readonly documentLifecycle?: string | undefined;
}

/** The fields of a details object or a sender that say which frame an event came from. */
export function frameOf(d: object): EventFrame {
  const o = d as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  return {
    frameId: num(o.frameId),
    parentFrameId: num(o.parentFrameId),
    documentLifecycle: typeof o.documentLifecycle === "string" ? o.documentLifecycle : undefined,
  };
}

/**
 * Whether a navigation event's frame is the top of its page: a page's top frame, or a
 * prerender's, which has no parent either. For webNavigation details, which always name the
 * parent; a message's sender does not.
 */
export function isTopFrame(from: EventFrame): boolean {
  return from.parentFrameId === undefined || from.parentFrameId < 0;
}

/** Whether an event came from a document that is being prerendered. */
export function isPrerendering(from: EventFrame): boolean {
  return from.documentLifecycle === "prerender";
}

/**
 * Changes held per prerender, and for all of a tab's prerenders together. A request is two
 * changes, its headers and its response. A heavy page made over 6,000 requests while it
 * was prerendered, far more than the same page made in an ordinary load,
 * and a prerender left waiting keeps making them. Past either cap the rest are dropped,
 * and the capture is marked incomplete when the page is shown.
 */
export const HELD_CHANGES_CAP = 50_000;
export const HELD_CHANGES_TAB_CAP = 100_000;

/**
 * Prerenders held per tab, the oldest dropped first. For a page's speculation rules Chrome
 * runs at most ten that start at once and two that start on a pointer, and one for the
 * address bar; it cancels a page's when the page is left, but does not say so to the
 * worker, so a few of the page before may still be held.
 */
export const HELD_PRERENDERS_CAP = 16;

/** One prerender: its top frame's document once committed, and what it did meanwhile. */
interface Held<S> {
  documentId: string | undefined;
  changes: HeldChange<S>[];
  /** A change was dropped: past the cap, or from a frame that could not be placed. */
  lost: boolean;
}

/** What a prerender left for the page it became. */
export interface Activation<S> {
  readonly changes: readonly HeldChange<S>[];
  /** False when a change was dropped while it waited. */
  readonly complete: boolean;
}

export class HeldPrerenders<S> {
  /** Per tab, each prerender by its top frame's id, in the order they started. */
  private readonly byTab = new Map<number, Map<number, Held<S>>>();
  /** A prerender's frames, by tab and frame id, to the id of its top frame. */
  private readonly topFrames = new Map<string, number>();

  /**
   * A navigation started in a prerendered frame (webNavigation.onBeforeNavigate). A top
   * frame starts a prerender, or starts it over when the prerendered page navigates again,
   * as resetTab starts a tab's page over; a frame below one joins it.
   */
  started(tabId: number, from: EventFrame): void {
    const frameId = from.frameId;
    if (frameId === undefined) return;
    if (isTopFrame(from)) {
      this.drop(tabId, frameId);
      const prerenders = this.prerendersOf(tabId);
      prerenders.set(frameId, { documentId: undefined, changes: [], lost: false });
      this.topFrames.set(frameKey(tabId, frameId), frameId);
      for (const oldest of prerenders.keys()) {
        if (prerenders.size <= HELD_PRERENDERS_CAP) break;
        this.drop(tabId, oldest);
      }
      return;
    }
    const parent = from.parentFrameId;
    const top = parent === undefined ? undefined : this.topFrames.get(frameKey(tabId, parent));
    if (top !== undefined) this.topFrames.set(frameKey(tabId, frameId), top);
  }

  /** A prerender's top frame committed its document (webNavigation.onCommitted). */
  committed(tabId: number, frameId: number, documentId: string): void {
    const held = this.byTab.get(tabId)?.get(frameId);
    if (held !== undefined) held.documentId = documentId;
  }

  /**
   * Hold a change from a prerendered document. True when the event was a prerender's, held
   * or dropped: either way it is not the page on screen's. False for any other event.
   */
  hold(tabId: number, from: EventFrame, change: HeldChange<S>): boolean {
    if (!isPrerendering(from)) return false;
    const held = this.find(tabId, from);
    if (held === undefined) return true;
    if (held.changes.length >= HELD_CHANGES_CAP || this.heldIn(tabId) >= HELD_CHANGES_TAB_CAP) held.lost = true;
    else held.changes.push(change);
    return true;
  }

  /**
   * A top-level document committed in the tab: what the prerender of that document held,
   * which is then forgotten, or null when this worker held no prerender of it. The tab's
   * other prerenders are kept: Chrome may still activate one.
   */
  activate(tabId: number, documentId: string | undefined): Activation<S> | null {
    const prerenders = this.byTab.get(tabId);
    if (prerenders === undefined || documentId === undefined) return null;
    for (const [frameId, held] of prerenders) {
      if (held.documentId !== documentId) continue;
      this.drop(tabId, frameId);
      return { changes: held.changes, complete: !held.lost };
    }
    return null;
  }

  /** How many changes a tab's prerenders hold together. */
  private heldIn(tabId: number): number {
    let n = 0;
    for (const held of this.byTab.get(tabId)?.values() ?? []) n += held.changes.length;
    return n;
  }

  /** Forget a tab's prerenders: it closed. */
  forgetTab(tabId: number): void {
    this.byTab.delete(tabId);
    const prefix = `${tabId}:`;
    for (const key of this.topFrames.keys()) if (key.startsWith(prefix)) this.topFrames.delete(key);
  }

  /** Forget one prerender and its frames. */
  private drop(tabId: number, top: number): void {
    const prerenders = this.byTab.get(tabId);
    if (prerenders === undefined) return;
    prerenders.delete(top);
    if (prerenders.size === 0) this.byTab.delete(tabId);
    const prefix = `${tabId}:`;
    for (const [key, frameTop] of this.topFrames) if (frameTop === top && key.startsWith(prefix)) this.topFrames.delete(key);
  }

  private prerendersOf(tabId: number): Map<number, Held<S>> {
    let prerenders = this.byTab.get(tabId);
    if (prerenders === undefined) {
      prerenders = new Map();
      this.byTab.set(tabId, prerenders);
    }
    return prerenders;
  }
  /**
   * The prerender an event belongs to: by its frame, or its parent frame, which a frame's
   * own navigation request names before the frame has started. A frame that started
   * nowhere this worker saw (an about:blank frame fires no navigation) belongs to the tab's
   * one prerender when there is only one. With several, it cannot be placed: it is dropped,
   * and each of them is marked as having lost something, since any of them may have.
   */
  private find(tabId: number, from: EventFrame): Held<S> | undefined {
    const prerenders = this.byTab.get(tabId);
    if (prerenders === undefined) return undefined;
    for (const frameId of [from.frameId, from.parentFrameId]) {
      if (frameId === undefined || frameId < 0) continue;
      const top = this.topFrames.get(frameKey(tabId, frameId));
      const held = top === undefined ? undefined : prerenders.get(top);
      if (held !== undefined) return held;
    }
    if (prerenders.size === 1) return prerenders.values().next().value;
    for (const held of prerenders.values()) held.lost = true;
    return undefined;
  }
}

function frameKey(tabId: number, frameId: number): string {
  return `${tabId}:${frameId}`;
}
