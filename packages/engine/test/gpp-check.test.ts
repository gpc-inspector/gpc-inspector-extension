// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import { gppCheckTest, pingReturnsString } from "../src/index.js";

describe("pingReturnsString", () => {
  it("is true from GPP 1.1, whose PingReturn carries gppString and parsedSections", () => {
    expect(pingReturnsString("1.1")).toBe(true);
    expect(pingReturnsString("1.1.0")).toBe(true);
    expect(pingReturnsString("1.2")).toBe(true);
    expect(pingReturnsString("2.0")).toBe(true);
  });

  it("is false for 1.0, and for a version that is missing or not a version", () => {
    expect(pingReturnsString("1.0")).toBe(false);
    expect(pingReturnsString("1")).toBe(false);
    expect(pingReturnsString(null)).toBe(false);
    expect(pingReturnsString(undefined)).toBe(false);
    expect(pingReturnsString("")).toBe(false);
    expect(pingReturnsString("v1.1")).toBe(false);
  });
});

describe("gppCheckTest", () => {
  const gpp = (gppVersion: string | null) => ({
    gpp: { rawString: "", applicableSections: [], gppVersion, sections: {}, unparseable: false, fromWire: null },
  });

  it("counts every __gpp command but ping whatever the version", () => {
    for (const v of ["1.0", "1.1", null]) {
      const test = gppCheckTest(gpp(v));
      expect(test({ api: "__gpp", command: "getGPPData" })).toBe(true);
      expect(test({ api: "__gpp", command: "addEventListener" })).toBe(true);
      expect(test({ api: "__gpp", command: null })).toBe(true);
    }
  });

  it("counts ping only under 1.1 and later", () => {
    expect(gppCheckTest(gpp("1.1"))({ api: "__gpp", command: "ping" })).toBe(true);
    expect(gppCheckTest(gpp("1.0"))({ api: "__gpp", command: "ping" })).toBe(false);
    expect(gppCheckTest(gpp(null))({ api: "__gpp", command: "ping" })).toBe(false);
    expect(gppCheckTest({ gpp: null })({ api: "__gpp", command: "ping" })).toBe(false);
  });

  it("counts no other consent API", () => {
    const test = gppCheckTest(gpp("1.1"));
    expect(test({ api: "__uspapi", command: "getUSPData" })).toBe(false);
    expect(test({ api: "__tcfapi", command: "ping" })).toBe(false);
  });
});
