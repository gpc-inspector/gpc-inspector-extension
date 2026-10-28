// SPDX-License-Identifier: GPL-3.0-only
/**
 * Keep looking for a confirmation notice that renders between the timed scans or after them
 * (FR-14).
 *
 * The MAIN world scans the page's rendered text at DOMContentLoaded and four more times at
 * 1.5-second intervals, then stops. On the 2026-09-25 corpus run news-f.example's Osano
 * banner, "Opt-Out Signal Honored", was the first line of the page's text when the page was
 * read, and the timed scans alone said "no": the banner had rendered after the last scan.
 * So a MutationObserver watches for a minute from the first scan, beside the timed ones:
 * started after them, it would miss a toast shown and removed between two of them.
 *
 * Cheap by construction, because it runs on every page. The rendered-text read that decides
 * a match (innerText) forces layout, so it runs only once the notice's words exist somewhere
 * in the document (textContent, which does not), at most every two seconds, and never after
 * a match. Class and style changes are watched only from then on, for a notice inserted
 * hidden and shown later. The caller starts it only while the page reads the signal as set.
 *
 * An observer on the document does not see inside a shadow root, so each open root is
 * observed too, with the same options and the same cheap test: the roots known when the
 * watch starts, a root found under an inserted node, and one that a later custom element
 * definition attaches (observe/page-text.ts finds them).
 *
 * Dependencies are injected so the schedule is testable in Node with a fake observer.
 */

export const CONFIRMATION_WATCH_MS = 60_000;
export const CONFIRMATION_MIN_GAP_MS = 2000;

/** The part of MutationObserver this uses. */
export interface ObserverLike {
  observe(target: unknown, options: MutationObserverInit): void;
  disconnect(): void;
}

/** The part of a MutationRecord this uses. */
export interface RecordLike {
  readonly type: string;
  readonly target: unknown;
  readonly addedNodes: ArrayLike<{ readonly textContent: string | null }>;
}

/** The open shadow roots, found as the page changes (OpenShadowRoots). */
export interface ShadowRootSource {
  /** Calls `onRoot` for each root known now and for each one found later. */
  subscribe(onRoot: (root: { readonly textContent: string | null }) => void): void;
  /** Looks for roots in and under nodes just inserted. */
  discover(nodes: ArrayLike<unknown>): void;
}

export interface LateConfirmationDeps {
  /** Where to observe: document.documentElement. */
  readonly root: unknown;
  readonly shadowRoots: ShadowRootSource;
  /** The document's whole text, rendered or not, its open roots' included. */
  readonly documentText: () => string;
  /** The notice's words in some text: the cheap test (matchesConfirmationNotice). */
  readonly mightBeNotice: (text: string) => boolean;
  /** One rendered-text scan that reports a match; true when it found one. */
  readonly scan: () => boolean;
  /** True once any scan, this one's or the timed ones, has found the notice. */
  readonly found: () => boolean;
  readonly createObserver: (callback: (records: readonly RecordLike[]) => void) => ObserverLike;
  readonly setTimeout: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly now: () => number;
}

/** Start watching. Returns a function that stops it early. */
export function watchForLateConfirmation(deps: LateConfirmationDeps): () => void {
  let candidate = false;
  let stopped = false;
  let lastScanAt = 0;
  let timer: unknown;
  const targets: unknown[] = [deps.root];
  const options = (): MutationObserverInit =>
    candidate
      ? {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: ["class", "style", "hidden", "aria-hidden", "open"],
        }
      : { subtree: true, childList: true, characterData: true };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
    if (timer !== undefined) deps.clearTimeout(timer);
    timer = undefined;
  };

  const scanSoon = (): void => {
    if (stopped || timer !== undefined) return;
    timer = deps.setTimeout(() => {
      timer = undefined;
      lastScanAt = deps.now();
      if (deps.scan()) stop();
    }, Math.max(0, CONFIRMATION_MIN_GAP_MS - (deps.now() - lastScanAt)));
  };

  const becomeCandidate = (): void => {
    if (candidate) return;
    candidate = true;
    // From now on a class or style change can be the moment the notice becomes visible.
    for (const target of targets) observer.observe(target, options());
  };

  const observer = deps.createObserver((records) => {
    if (stopped) return;
    if (deps.found()) {
      stop();
      return;
    }
    for (const r of records) {
      if (r.type === "childList" && r.addedNodes.length > 0) deps.shadowRoots.discover(r.addedNodes);
    }
    if (!candidate) {
      for (const r of records) {
        let text = "";
        if (r.type === "characterData") {
          const data = (r.target as { data?: unknown } | null)?.data;
          text = typeof data === "string" ? data : "";
        } else if (r.type === "childList") {
          for (let i = 0; i < r.addedNodes.length; i++) text += ` ${r.addedNodes[i]?.textContent ?? ""}`;
        }
        if (text && deps.mightBeNotice(text)) {
          becomeCandidate();
          break;
        }
      }
    }
    if (candidate) scanSoon();
  });

  observer.observe(deps.root, options());
  deps.shadowRoots.subscribe((root) => {
    if (stopped) return;
    targets.push(root);
    observer.observe(root, options());
    // Even on a page already a candidate: a root a custom element attaches as it upgrades
    // brings its text with no mutation record, so nothing else would scan for it.
    if (deps.mightBeNotice(root.textContent ?? "")) {
      becomeCandidate();
      scanSoon();
    }
  });
  // Words already in the document, hidden until now, count too.
  if (deps.mightBeNotice(deps.documentText())) {
    becomeCandidate();
    scanSoon();
  }
  deps.setTimeout(stop, CONFIRMATION_WATCH_MS);
  return stop;
}
