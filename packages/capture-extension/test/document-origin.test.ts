// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import { documentHost, documentOrigin } from "../src/content/document-origin.js";

describe("the origin a frame's document runs under", () => {
  it("is the address's own on an ordinary page", () => {
    expect(documentOrigin("https://shop.example", "https://shop.example")).toBe("https://shop.example");
    expect(documentHost("shop.example", "https://shop.example")).toBe("shop.example");
  });

  it("is the inherited origin in an about:blank or srcdoc frame", () => {
    // The address has no host and an opaque origin; the document runs under its creator's.
    expect(documentOrigin("null", "https://shop.example")).toBe("https://shop.example");
    expect(documentHost("", "https://shop.example")).toBe("shop.example");
  });

  it("is the origin inside a blob: address", () => {
    expect(documentOrigin("https://shop.example", "https://shop.example")).toBe("https://shop.example");
    expect(documentHost("", "https://shop.example:8443")).toBe("shop.example");
  });

  it("stays empty where the document has no origin to name", () => {
    // A sandboxed frame runs under an opaque origin of its own.
    expect(documentOrigin("null", "null")).toBe("null");
    expect(documentHost("", "null")).toBe("");
    expect(documentHost("", undefined)).toBe("");
    expect(documentOrigin("null", undefined)).toBe("null");
  });
});
