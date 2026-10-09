// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import { unlistedDomainHasRow, type UnlistedDomainTally } from "../src/signal.js";

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
