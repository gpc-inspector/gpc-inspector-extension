// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import { unlistedDomainHasRow, type UnlistedDomainTally } from "../src/signal.js";
import { pageReadSignalOn, signalWasOn } from "../src/observation-set.js";

describe("unlistedDomainHasRow", () => {
  const quiet: UnlistedDomainTally = {
    domain: "pixelco.net",
    requests: 2,
    signedRequests: 1,
    hosts: ["px.pixelco.net"],
    resourceTypes: ["image"],
    cookieKeys: [],
    cookieKeysUnsigned: [],
    cookiesReturned: [],
    probeCookies: [],
    refusedWrites: [],
  };

  it("gives a domain that was only contacted no row", () => {
    expect(unlistedDomainHasRow(quiet, true)).toBe(false);
    expect(unlistedDomainHasRow(quiet, false)).toBe(false);
  });

  it("gives a row for a cookie with or without the signal while it is on", () => {
    expect(unlistedDomainHasRow({ ...quiet, cookieKeys: ["c\u0000.pixelco.net"] }, true)).toBe(true);
    expect(unlistedDomainHasRow({ ...quiet, cookieKeysUnsigned: ["c\u0000.pixelco.net"] }, true)).toBe(true);
  });

  it("with the signal off, counts only the cookies set without it", () => {
    // Set on a request sent before the signal was switched off: nothing a row would list.
    expect(unlistedDomainHasRow({ ...quiet, cookieKeys: ["c\u0000.pixelco.net"] }, false)).toBe(false);
    expect(unlistedDomainHasRow({ ...quiet, cookieKeysUnsigned: ["c\u0000.pixelco.net"] }, false)).toBe(true);
  });

  it("gives a row for a script that read GPC, though the domain set nothing", () => {
    expect(unlistedDomainHasRow(quiet, true, true)).toBe(true);
    expect(unlistedDomainHasRow(quiet, false, true)).toBe(true);
  });

  it("gives a row for a probe, a refused write or a lost request's cookie", () => {
    expect(unlistedDomainHasRow({ ...quiet, probeCookies: ["p"] }, false)).toBe(true);
    expect(unlistedDomainHasRow({ ...quiet, refusedWrites: ["wide (.com)"] }, true)).toBe(true);
    expect(unlistedDomainHasRow({ ...quiet, cookieKeysRequestLost: ["c\u0000.pixelco.net"] }, true)).toBe(true);
  });
});

describe("signalWasOn", () => {
  type Source = "native" | "this-extension" | "other-extension" | "none";
  const on = (source: Source, propertyValue: true | false | "absent", documentSigned: boolean | null | undefined, secGpcRequestCount = 0) =>
    signalWasOn({
      signal: { source, propertyValue, secGpcRequestCount },
      context: documentSigned === undefined ? {} : { documentSigned },
    });

  it("is on where the page read the signal as on, whatever the document request carried", () => {
    expect(on("this-extension", true, true)).toBe(true);
    expect(on("this-extension", true, false)).toBe(true);
    expect(on("native", true, null)).toBe(true);
    expect(on("other-extension", true, undefined)).toBe(true);
  });

  it("otherwise follows the request that fetched the page", () => {
    expect(on("none", "absent", true)).toBe(true);
    expect(on("native", false, true)).toBe(true);
    expect(on("native", false, false, 0)).toBe(false);
    expect(on("other-extension", false, false)).toBe(false);
    expect(on("none", "absent", false, 7)).toBe(false);
    expect(on("none", "absent", null, 7)).toBe(false);
  });

  it("reads a record from before documentSigned by its owner and its request count", () => {
    expect(on("native", false, undefined, 0)).toBe(false);
    expect(on("native", false, undefined, 3)).toBe(true);
    expect(on("none", "absent", undefined, 3)).toBe(false);
  });
});

describe("pageReadSignalOn", () => {
  it("is on only where something owned the property and it read true", () => {
    const on = (source: "native" | "this-extension" | "other-extension" | "none", propertyValue: true | false | "absent") =>
      pageReadSignalOn({ signal: { source, propertyValue } });
    expect(on("this-extension", true)).toBe(true);
    expect(on("native", true)).toBe(true);
    expect(on("other-extension", true)).toBe(true);
    expect(on("native", false)).toBe(false);
    expect(on("other-extension", false)).toBe(false);
    expect(on("none", "absent")).toBe(false);
    expect(on("none", false)).toBe(false);
  });
});
