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

export interface LateConfirmationDeps {
  /** Where to observe: document.documentElement. */
  readonly root: unknown;
  /** The document's whole text, rendered or not (document.body.textContent). */
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
    observer.observe(deps.root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "aria-hidden", "open"],
    });
  };

  const observer = deps.createObserver((records) => {
    if (stopped) return;
    if (deps.found()) {
      stop();
      return;
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

  observer.observe(deps.root, { subtree: true, childList: true, characterData: true });
  // Words already in the document, hidden until now, count too.
  if (deps.mightBeNotice(deps.documentText())) {
    becomeCandidate();
    scanSoon();
  }
  deps.setTimeout(stop, CONFIRMATION_WATCH_MS);
  return stop;
}
