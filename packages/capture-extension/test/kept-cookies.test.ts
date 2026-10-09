// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import { KEPT_COOKIE_RESPONSE_CAP } from "@gpc-inspector/schema";
import type { KeptCookieResponse, NetworkObservation } from "@gpc-inspector/schema";
import { KEPT_CHUNK, KEPT_MAX_CHUNKS, chunkWrites, chunksPresent, keepNew, keptKey, keptKeys, keptTabOf, readChunks, remakeKept, sourcesOf, toKept } from "../src/background/kept-cookies.js";

const SECRET = "sess_4b1d";

function obs(id: string, cookies: number, url = `https://ads.vendor.example/px?uid=${SECRET}`): NetworkObservation {
  return {
    id,
    url,
    method: "GET",
    resourceType: "image",
    initiator: "https://www.example.com/",
    secGpcPresent: true,
    requestHeaders: [{ name: "Cookie", nameLower: "cookie", value: `sid=${SECRET}` }],
    cookiesSent: ["sid"],
    statusCode: 200,
    responseHeaders: [{ name: "Set-Cookie", nameLower: "set-cookie", value: `uid=${SECRET}` }],
    isRedirectHop: false,
    setCookies: Array.from({ length: cookies }, (_, n) => ({
      name: `c${n}`,
      value: SECRET,
      domain: ".vendor.example",
      path: "/",
      expiresMs: null,
      sameSite: "None" as const,
      httpOnly: false,
      secure: true,
      partitioned: false,
      via: "documentCookie" as const,
      writerScriptUrl: `https://cdn.vendor.example/tag.js?k=${SECRET}`,
    })),
    captureMethod: "onHeadersReceived",
    timeMs: 5,
  };
}

const records = (n: number, from = 0): KeptCookieResponse[] => Array.from({ length: n }, (_, i) => toKept(obs(`r${from + i}`, 1)));

describe("toKept", () => {
  it("keeps what the Requests tab draws and no value, query or header", () => {
    const k = toKept(obs("a", 2));
    expect(JSON.stringify(k)).not.toContain(SECRET);
    expect(k.url).toBe("https://ads.vendor.example/px");
    expect(k.setCookies.map((c) => c.name)).toEqual(["c0", "c1"]);
    expect(k.setCookies[0]!.writerScriptUrl).toBe("https://cdn.vendor.example/tag.js");
    expect("value" in k.setCookies[0]!).toBe(false);
    expect("requestHeaders" in k).toBe(false);
    expect("requestLost" in k).toBe(false);
  });

  it("keeps a container's id and the request-lost mark", () => {
    const k = toKept({ ...obs("g", 1, "https://www.googletagmanager.com/gtm.js?id=GTM-ABC&gtm_auth=x"), requestLost: true });
    expect(k.url).toBe("https://www.googletagmanager.com/gtm.js?id=GTM-ABC");
    expect(k.requestLost).toBe(true);
  });
});

describe("keepNew", () => {
  it("adds each cookie-setting observation once and skips the rest", () => {
    const kept: KeptCookieResponse[] = [];
    const sources = sourcesOf(kept);
    const a = obs("a", 1);
    const c = obs("c", 2);
    expect(keepNew([a, obs("b", 0), c], kept, sources)).toBe(false);
    expect(keepNew([a, c, obs("d", 1)], kept, sources)).toBe(false);
    expect(kept.map((k) => k.id)).toEqual(["a", "c", "d"]);
  });

  it("stops at the cap and says one was left out", () => {
    const kept = records(KEPT_COOKIE_RESPONSE_CAP);
    expect(keepNew([obs("over", 1)], kept, sourcesOf(kept))).toBe(true);
    expect(kept).toHaveLength(KEPT_COOKIE_RESPONSE_CAP);
  });

  it("does not add again a record read back from storage", () => {
    const kept = records(2);
    const before = structuredClone(kept);
    expect(keepNew([obs("r0", 3)], kept, sourcesOf(kept))).toBe(false);
    expect(kept).toEqual(before);
  });
});

describe("remakeKept", () => {
  it("remakes a record from its replaced observation, in place, down to no cookie", () => {
    // A probe's set taken back out replaces the observation (forgetProbeSet, sw.ts).
    const kept: KeptCookieResponse[] = [];
    const sources = sourcesOf(kept);
    const first = obs("a", 2);
    keepNew([first, obs("b", 1), obs("c", 1)], kept, sources);
    const probed = { ...first, setCookies: first.setCookies.slice(1) };
    expect(remakeKept(probed, kept, sources)).toBe(0);
    expect(kept.map((k) => [k.id, k.setCookies.map((s) => s.name)])).toEqual([["a", ["c1"]], ["b", ["c0"]], ["c", ["c0"]]]);
    expect(remakeKept({ ...probed, setCookies: [] }, kept, sources)).toBe(0);
    expect(kept.map((k) => k.id)).toEqual(["a", "b", "c"]);
    expect(kept[0]!.setCookies).toEqual([]);
  });

  it("makes nothing for an observation that was never kept", () => {
    const kept = records(2);
    const before = structuredClone(kept);
    expect(remakeKept(obs("never", 1), kept, sourcesOf(kept))).toBeNull();
    expect(kept).toEqual(before);
  });
});

describe("chunkWrites and readChunks", () => {
  it("writes strings of KEPT_CHUNK records and reads them back in order", () => {
    const kept = records(KEPT_CHUNK + 10);
    const w = chunkWrites(4, kept, 0, 0);
    expect(w.chunks).toBe(2);
    expect(Object.keys(w.set)).toEqual([keptKey(4, 0), keptKey(4, 1)]);
    expect(Object.values(w.set).every((v) => typeof v === "string")).toBe(true);
    expect(readChunks(w.set, 4, 2)).toEqual({ records: kept, complete: true });
  });

  it("rewrites only the last chunk as records are added", () => {
    const kept = records(KEPT_CHUNK + 10);
    expect(Object.keys(chunkWrites(4, [...kept, ...records(1, 900)], kept.length, 2).set)).toEqual([keptKey(4, 1)]);
    // Filling a chunk exactly starts the next one on the following write.
    const full = records(KEPT_CHUNK);
    expect(Object.keys(chunkWrites(4, [...full, ...records(1, 900)], KEPT_CHUNK, 1).set)).toEqual([keptKey(4, 1)]);
    expect(chunkWrites(4, kept, kept.length, 2).set).toEqual({});
  });

  it("rewrites from the start for a new page and removes the chunks it left behind", () => {
    const w = chunkWrites(4, records(3), KEPT_CHUNK * 2 + 1, 3);
    expect(Object.keys(w.set)).toEqual([keptKey(4, 0)]);
    expect(w.remove).toEqual([keptKey(4, 1), keptKey(4, 2)]);
    const empty = chunkWrites(4, [], 3, 1);
    expect(empty).toEqual({ set: {}, remove: [keptKey(4, 0)], chunks: 0 });
    // A new page's list the length of the last one's, passed as none written.
    expect(Object.keys(chunkWrites(4, records(KEPT_CHUNK + 10, 500), 0, 2).set)).toEqual([keptKey(4, 0), keptKey(4, 1)]);
  });

  it("rewrites from the chunk of a remade record", () => {
    const kept = records(KEPT_CHUNK * 2 + 5);
    expect(Object.keys(chunkWrites(4, kept, KEPT_CHUNK + 3, 3).set)).toEqual([keptKey(4, 1), keptKey(4, 2)]);
  });

  it("reads a missing or unreadable chunk as incomplete, keeping the rest", () => {
    const kept = records(KEPT_CHUNK + 1);
    const { set } = chunkWrites(4, kept, 0, 0);
    expect(readChunks({ [keptKey(4, 0)]: set[keptKey(4, 0)] }, 4, 2)).toEqual({ records: kept.slice(0, KEPT_CHUNK), complete: false });
    expect(readChunks({ ...set, [keptKey(4, 1)]: "{not json" }, 4, 2).complete).toBe(false);
    expect(readChunks({ ...set, [keptKey(4, 1)]: [] }, 4, 2).complete).toBe(false);
  });
});

describe("keptTabOf", () => {
  it("names the tab of a kept-record key and nothing else", () => {
    expect(keptTabOf(keptKey(12, 3))).toBe(12);
    expect(keptTabOf("tab:12")).toBeNull();
    expect(keptTabOf("cookies:x:0")).toBeNull();
  });
});

describe("keptKeys and chunksPresent", () => {
  it("names every key a tab at the cap can use", () => {
    expect(KEPT_MAX_CHUNKS).toBe(Math.ceil(KEPT_COOKIE_RESPONSE_CAP / KEPT_CHUNK));
    expect(keptKeys(4)).toEqual(Array.from({ length: KEPT_MAX_CHUNKS }, (_, n) => keptKey(4, n)));
  });

  it("counts to one past the last chunk present, a gap or another tab's aside", () => {
    expect(chunksPresent({}, 4)).toBe(0);
    expect(chunksPresent({ [keptKey(4, 0)]: "[]", [keptKey(4, 3)]: "[]", [keptKey(5, 7)]: "[]" }, 4)).toBe(4);
  });
});
