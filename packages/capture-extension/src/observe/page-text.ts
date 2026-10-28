// SPDX-License-Identifier: GPL-3.0-only
/**
 * The page's rendered text with its open shadow roots, for the confirmation notice scan
 * (FR-14).
 *
 * document.body.innerText stops at a shadow root: a consent dialog that a web component draws
 * in its open shadow root is not in it, and a MutationObserver on the document does not see
 * changes inside one. So the open roots are found and the page is read in the flat tree, the
 * order the reader sees: a host's shadow content where the host stands, and slotted content
 * where its slot stands. A closed root cannot be read from the page and stays unread.
 *
 * Cost. A page with no open root reads as body.innerText alone. The search for roots reads
 * `shadowRoot` on every element (querySelectorAll("*")), work of the same order as the
 * textContent read the watcher already makes, and stops at MAX_SHADOW_ROOTS. With roots,
 * innerText still reads every part of the page that holds no host and no slot; only the
 * elements above a host or a slot are walked one by one.
 *
 * Written against the few DOM members it uses, so it is testable in Node with fake nodes.
 */

export const MAX_SHADOW_ROOTS = 1000;

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const FRAGMENT_NODE = 11;

export interface NodeLike {
  readonly nodeType: number;
  readonly parentNode: NodeLike | null;
  readonly childNodes: ArrayLike<NodeLike>;
  readonly textContent: string | null;
}

export interface ElementLike extends NodeLike {
  readonly localName: string;
  readonly shadowRoot: RootLike | null;
  readonly innerText?: string;
  getClientRects(): { readonly length: number };
  querySelectorAll(selector: string): ArrayLike<ElementLike>;
  assignedNodes?(options: { flatten: boolean }): ArrayLike<NodeLike>;
}

export interface RootLike extends NodeLike {
  readonly host: ElementLike;
  querySelectorAll(selector: string): ArrayLike<ElementLike>;
}

export interface OpenShadowRootsDeps {
  /** Where a whole-page search starts: [document.documentElement]. */
  readonly page: () => ArrayLike<NodeLike>;
  /** customElements.get(name) !== undefined. */
  readonly isDefined: (name: string) => boolean;
  /** customElements.whenDefined(name). */
  readonly whenDefined: (name: string) => Promise<unknown>;
  /**
   * el.localName as the browser defines it. A page can shadow the property on one element
   * with its own accessor (a bot check's iframe whose `localName` reads undefined), so the
   * page passes Element.prototype's getter. Unset, the element's own property is read.
   */
  readonly localName?: (el: ElementLike) => unknown;
}

/**
 * The open shadow roots found so far, in the order found.
 *
 * A root attached when its host is inserted is found from the insertion's mutation record.
 * A custom element whose definition loads later gets its root when it upgrades, with no
 * mutation to see, so an undefined custom element's name is waited on, and its definition
 * starts a whole-page search.
 */
export class OpenShadowRoots {
  private readonly known = new Set<RootLike>();
  private readonly found: RootLike[] = [];
  private readonly listeners: ((root: RootLike) => void)[] = [];
  private readonly waiting = new Set<string>();

  constructor(private readonly deps: OpenShadowRootsDeps) {}

  get roots(): readonly RootLike[] {
    return this.found;
  }

  /** The roots' own text, rendered or not, for the watcher's cheap test. */
  textContent(): string {
    let text = "";
    for (const root of this.found) text += `\n${root.textContent ?? ""}`;
    return text;
  }

  /** Calls `onRoot` for each root known now and for each one found later. */
  subscribe(onRoot: (root: RootLike) => void): void {
    this.listeners.push(onRoot);
    for (const root of [...this.found]) onRoot(root);
  }

  /** Finds the open roots in and under `nodes`, the whole page by default. */
  discover(nodes: ArrayLike<unknown> = this.deps.page()): void {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i] as NodeLike | undefined;
      if (node?.nodeType !== ELEMENT_NODE) continue;
      this.searchUnder(node as ElementLike);
    }
  }

  private searchUnder(scope: ElementLike | RootLike): void {
    if (scope.nodeType === ELEMENT_NODE) this.visit(scope as ElementLike);
    const all = scope.querySelectorAll("*");
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (el) this.visit(el);
    }
  }

  private visit(el: ElementLike): void {
    const root = el.shadowRoot;
    if (root) {
      if (!this.known.has(root)) {
        if (this.found.length >= MAX_SHADOW_ROOTS) return;
        this.known.add(root);
        this.found.push(root);
        for (const listener of this.listeners) listener(root);
      }
      // A whole-page search does not cross into roots, so a nested root is found from its
      // parent root, known or new.
      this.searchUnder(root);
      return;
    }
    const name = this.deps.localName ? this.deps.localName(el) : el.localName;
    if (typeof name !== "string") return;
    if (name.includes("-") && !this.waiting.has(name) && !this.deps.isDefined(name)) {
      this.waiting.add(name);
      void this.deps.whenDefined(name).then(
        () => this.discover(),
        () => undefined,
      );
    }
  }
}

/**
 * The rendered text of `body` with the given open roots read in place.
 *
 * Elements above a host or a slot are walked: a host's children are its shadow root's, and a
 * slot's are the nodes assigned to it. Every other element is read with innerText. An
 * element that is not rendered gives no text: display "none", or no box at all, as inside a
 * closed <details>. Its innerText would be its whole text, rendered or not.
 */
export function renderedText(
  body: ElementLike,
  roots: readonly RootLike[],
  display: (el: ElementLike) => string,
): string {
  if (roots.length === 0) return body.innerText ?? "";

  const walked = new Set<NodeLike>();
  const mark = (start: NodeLike | null): void => {
    let node = start;
    while (node && !walked.has(node)) {
      walked.add(node);
      node = node.nodeType === FRAGMENT_NODE ? (node as RootLike).host : node.parentNode;
    }
  };
  for (const root of roots) {
    mark(root.host);
    const slots = root.querySelectorAll("slot");
    for (let i = 0; i < slots.length; i++) mark(slots[i] ?? null);
  }

  const read = (node: NodeLike): string => {
    if (node.nodeType === TEXT_NODE) return (node.textContent ?? "").replace(/\s+/g, " ");
    if (node.nodeType !== ELEMENT_NODE) return "";
    const el = node as ElementLike;
    const shown = display(el);
    if (shown === "none") return "";
    // display: contents has no box of its own, and its children may still be rendered.
    if (shown !== "contents" && el.getClientRects().length === 0) return "";
    let text: string;
    if (shown !== "contents" && !walked.has(el)) {
      text = el.innerText ?? "";
    } else {
      const children = el.shadowRoot
        ? el.shadowRoot.childNodes
        : el.localName === "slot" && el.assignedNodes
          ? el.assignedNodes({ flatten: true })
          : el.childNodes;
      text = "";
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child) text += read(child);
      }
    }
    // A block starts and ends a line, as in innerText; inline content runs on.
    return shown.startsWith("inline") || shown === "contents" ? text : `\n${text}\n`;
  };
  return read(body);
}
