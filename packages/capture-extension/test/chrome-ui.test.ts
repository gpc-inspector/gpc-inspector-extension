// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import { isInsideChromeUi } from "../src/observe/chrome-ui.js";

/**
 * The insertion and request observers stay out of frames Chrome embeds in its own pages.
 * The decision reads the ancestor chain, so it needs no knowledge of which https page the
 * new-tab page happens to embed this year.
 */

describe("isInsideChromeUi", () => {
  it("is false for a top-level page, which has no ancestors", () => {
    expect(isInsideChromeUi([])).toBe(false);
  });

  it("is false for a frame inside an ordinary site", () => {
    expect(isInsideChromeUi(["https://www.example.com"])).toBe(false);
    expect(isInsideChromeUi(["https://ads.example.net", "https://www.example.com"])).toBe(false);
  });

  it("is true for a frame the new-tab page embeds, at any depth", () => {
    expect(isInsideChromeUi(["chrome://new-tab-page"])).toBe(true);
    expect(isInsideChromeUi(["chrome-untrusted://new-tab-page", "chrome://new-tab-page"])).toBe(true);
    expect(isInsideChromeUi(["https://ogs.google.com", "chrome-untrusted://new-tab-page", "chrome://new-tab-page"])).toBe(true);
  });

  it("is true inside another extension's page or DevTools", () => {
    expect(isInsideChromeUi(["chrome-extension://abcdefghijklmnopabcdefghijklmnop"])).toBe(true);
    expect(isInsideChromeUi(["devtools://devtools"])).toBe(true);
  });

  it("treats a missing ancestorOrigins as outside, so the observers still install", () => {
    expect(isInsideChromeUi(undefined)).toBe(false);
  });
});
