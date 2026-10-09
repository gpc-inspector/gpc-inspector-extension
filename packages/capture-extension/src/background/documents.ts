// SPDX-License-Identifier: GPL-3.0-only
/**
 * Which documents belong to the page a tab's state describes.
 *
 * A tab's state is reset when the next navigation starts (onBeforeNavigate), but the old
 * page keeps running until the new one commits, and its unload handlers run after that.
 * Their cookie writes and beacons reach the worker with nothing to say which page they came
 * from, and would count on the next one: Parse.ly's cookies from news-j.example on news-k.example,
 * mPulse's RT from retailer-g.example as retailer-n.example's only cookie (seen 2026-09-23, four of twenty
 * sites). Logged on news-j.example to news-k.example, the old page's writes arrived after
 * the new commit from the old top document, with a new frameId, and one beacon from it
 * arrived between onBeforeNavigate and the commit.
 *
 * Nothing before the commit can simply be dropped: the new page's content scripts can
 * report before onCommitted reaches the worker (see sw.ts on why the reset is not at
 * commit). Nor can a document being unloaded: an ad frame on this page that loads its
 * next ad unloads too, and what it did is this page's. So the old page is recognized by
 * its documents. Every document that commits in the tab is recorded against the page (the
 * top one, and each frame whose parent is on the page); when the next navigation starts
 * they are retired, and anything from a retired document, or a frame of one, is not this
 * page's.
 */

/** What a message or a request says about the document it came from. */
export interface SourceDocument {
  readonly documentId?: string | undefined;
  readonly parentDocumentId?: string | undefined;
}

/**
 * The document fields of a webRequest details object or a message sender. Chrome sends them
 * on both (since 106); the bundled types omit them on some details shapes, so they are read
 * here rather than assumed.
 */
export function sourceOf(d: object): SourceDocument {
  const o = d as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  return { documentId: str(o.documentId), parentDocumentId: str(o.parentDocumentId) };
}

export interface PageDocuments {
  /** Documents committed in this page: the top document and its frames. */
  pageDocuments: string[];
  /** The previous page's documents, retired when this page's navigation started. */
  retiredDocuments: string[];
}

/** Frames on a page are bounded in practice; the cap keeps a pathological page from growing the state. */
const MAX_DOCUMENTS = 500;

/** Record a commit. A top-level commit starts the page; a frame joins it through its parent. */
export function noteCommit(
  s: PageDocuments,
  commit: { readonly frameId: number; readonly documentId?: string | undefined; readonly parentDocumentId?: string | undefined },
): void {
  const id = commit.documentId;
  if (!id) return;
  if (commit.frameId === 0) {
    s.pageDocuments = [id];
    return;
  }
  const parent = commit.parentDocumentId;
  // A frame of a retired page commits into that page, not this one.
  if (parent && (s.retiredDocuments ?? []).includes(parent)) return;
  const page = s.pageDocuments ?? [];
  if (page.includes(id) || page.length >= MAX_DOCUMENTS) return;
  s.pageDocuments = [...page, id];
}

/**
 * Whether a message or a request came from the previous page: one of its documents, or a
 * frame of one. A document not seen commit (a new page reporting before its commit reached
 * the worker, an about:blank frame, a tab open before install) is this page's.
 */
export function fromOtherPage(s: PageDocuments, from: SourceDocument): boolean {
  const retired = s.retiredDocuments ?? [];
  if (from.documentId && retired.includes(from.documentId)) return true;
  if (from.parentDocumentId && retired.includes(from.parentDocumentId)) return true;
  return false;
}
