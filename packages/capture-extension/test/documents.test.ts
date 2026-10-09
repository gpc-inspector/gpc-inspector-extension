// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import { fromOtherPage, noteCommit, sourceOf, type PageDocuments } from "../src/background/documents.js";

const empty = (): PageDocuments => ({ pageDocuments: [], retiredDocuments: [] });

describe("which documents belong to the page", () => {
  it("starts a page at a top-level commit and adds its frames", () => {
    const s = empty();
    noteCommit(s, { frameId: 0, documentId: "TOP" });
    noteCommit(s, { frameId: 3, documentId: "FRAME", parentDocumentId: "TOP" });
    noteCommit(s, { frameId: 3, documentId: "FRAME", parentDocumentId: "TOP" });
    expect(s.pageDocuments).toEqual(["TOP", "FRAME"]);
  });

  it("does not add a frame that commits into the retired page", () => {
    const s: PageDocuments = { pageDocuments: ["NEW"], retiredDocuments: ["OLD"] };
    noteCommit(s, { frameId: 4, documentId: "LATE", parentDocumentId: "OLD" });
    expect(s.pageDocuments).toEqual(["NEW"]);
  });

  it("ignores a commit without a document id", () => {
    const s = empty();
    noteCommit(s, { frameId: 0 });
    expect(s.pageDocuments).toEqual([]);
  });
});

describe("what comes from another page", () => {
  const s: PageDocuments = { pageDocuments: ["NEW"], retiredDocuments: ["OLD", "OLD-FRAME"] };

  it("is a retired document or a frame of one", () => {
    expect(fromOtherPage(s, { documentId: "OLD" })).toBe(true);
    expect(fromOtherPage(s, { documentId: "X", parentDocumentId: "OLD-FRAME" })).toBe(true);
  });

  it("is not the current page, a document not seen commit, or one with no fields", () => {
    // An ad frame on this page unloading to load its next ad is this page's too.
    expect(fromOtherPage(s, { documentId: "NEW" })).toBe(false);
    expect(fromOtherPage(s, { documentId: "UNSEEN" })).toBe(false);
    expect(fromOtherPage(s, {})).toBe(false);
  });

  it("reads a state stored before the fields existed", () => {
    expect(fromOtherPage({} as PageDocuments, { documentId: "OLD" })).toBe(false);
  });
});

describe("reading the document fields", () => {
  it("takes strings and nothing else", () => {
    expect(sourceOf({ documentId: "D", parentDocumentId: 5, url: "u" })).toEqual({ documentId: "D", parentDocumentId: undefined });
  });
});
