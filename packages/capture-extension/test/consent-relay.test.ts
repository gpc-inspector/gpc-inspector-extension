// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import type { ConsentApiCall } from "@gpc-inspector/schema";
import { callCount } from "@gpc-inspector/schema";
import { ConsentRelay } from "../src/content/consent-relay.js";
import { mergeConsentCall } from "../src/background/consent-calls.js";

const call = (over: Partial<ConsentApiCall> = {}): ConsentApiCall => ({
  api: "__uspapi",
  command: "getUSPData",
  callerScriptUrl: "https://www.news-i.example/static/desktop.js",
  viaTagManager: false,
  containerUrls: [],
  timeMs: 1000,
  ...over,
});

describe("relaying consent-API calls", () => {
  it("sends the first call of each kind at once and holds the repeats", () => {
    const relay = new ConsentRelay();
    expect(relay.call(call())).toEqual(call());
    expect(relay.call(call({ timeMs: 1001 }))).toBeNull();
    expect(relay.call(call({ command: "registerDeletion", timeMs: 1002 }))).not.toBeNull();
    expect(relay.holding).toBe(true);
  });

  it("merges the repeats into one record per kind, with the count and both times", () => {
    const relay = new ConsentRelay();
    relay.call(call());
    for (let i = 1; i <= 5; i++) relay.call(call({ timeMs: 1000 + i }));
    expect(relay.take()).toEqual([{ ...call({ timeMs: 1001 }), count: 5, lastTimeMs: 1005 }]);
    expect(relay.holding).toBe(false);
    expect(relay.take()).toEqual([]);
  });

  it("keeps calls from different callers apart", () => {
    const relay = new ConsentRelay();
    const other = { callerScriptUrl: "https://cdn.vendor.example/tag.js" };
    for (let i = 0; i < 3; i++) {
      relay.call(call());
      relay.call(call(other));
    }
    expect(relay.take().map((c) => [c.callerScriptUrl, c.count])).toEqual([
      ["https://www.news-i.example/static/desktop.js", 2],
      ["https://cdn.vendor.example/tag.js", 2],
    ]);
  });

  it("leaves the worker with the same record as relaying every call would", () => {
    // A polling page: the worker's merged list must not depend on the relay.
    const relay = new ConsentRelay();
    const direct: ConsentApiCall[] = [];
    const relayed: ConsentApiCall[] = [];
    const commands = ["getUSPData", "registerDeletion"];
    for (let i = 0; i < 10_000; i++) {
      const c = call({ command: commands[i % 2] as string, timeMs: 1000 + i });
      mergeConsentCall(direct, c);
      const now = relay.call(c);
      if (now !== null) mergeConsentCall(relayed, now);
      if (i % 997 === 0) for (const held of relay.take()) mergeConsentCall(relayed, held);
    }
    for (const held of relay.take()) mergeConsentCall(relayed, held);
    expect(relayed).toEqual(direct);
    expect(relayed.reduce((n, c) => n + callCount(c), 0)).toBe(10_000);
  });

  it("sends a payload only when it differs from the last of its kind", () => {
    const relay = new ConsentRelay();
    expect(relay.changed("usp", "1YNN")).toBe(true);
    expect(relay.changed("usp", "1YNN")).toBe(false);
    expect(relay.changed("gpp", { rawString: "DBAA" })).toBe(true);
    expect(relay.changed("gpp", { rawString: "DBAA" })).toBe(false);
    // A change and back: both are sent, so the worker sees the same order.
    expect(relay.changed("usp", "1YYN")).toBe(true);
    expect(relay.changed("usp", "1YNN")).toBe(true);
  });

  it("starts over after a reset", () => {
    const relay = new ConsentRelay();
    relay.call(call());
    relay.changed("usp", "1YNN");
    relay.reset();
    expect(relay.call(call())).not.toBeNull();
    expect(relay.changed("usp", "1YNN")).toBe(true);
  });
});
