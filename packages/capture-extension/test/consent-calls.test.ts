// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import type { ConsentApiCall } from "@gpc-inspector/schema";
import { callCount } from "@gpc-inspector/schema";
import { mergeConsentCall } from "../src/background/consent-calls.js";

const call = (over: Partial<ConsentApiCall> = {}): ConsentApiCall => ({
  api: "__uspapi",
  command: "getUSPData",
  callerScriptUrl: "https://www.news-i.example/static/desktop.js",
  viaTagManager: false,
  timeMs: 1000,
  ...over,
});

describe("merging consent-API calls", () => {
  it("folds a polling page's calls into one record per caller", () => {
    // news-i.example, 2026-09-22: 20,096 calls from one bundle, four distinct commands.
    const calls: ConsentApiCall[] = [];
    const commands = ["getUSPData", "onUpdate", "onReadyAndUIFinished", "hasConsentedToAll"];
    for (let i = 0; i < 20_096; i++) {
      mergeConsentCall(calls, call({ command: commands[i % 4] as string, timeMs: 1000 + i }));
    }
    expect(calls).toHaveLength(4);
    expect(calls.reduce((n, c) => n + callCount(c), 0)).toBe(20_096);
  });

  it("keeps the first call's time and records the last", () => {
    const calls: ConsentApiCall[] = [];
    mergeConsentCall(calls, call({ timeMs: 500 }));
    mergeConsentCall(calls, call({ timeMs: 900 }));
    mergeConsentCall(calls, call({ timeMs: 700 }));
    expect(calls).toEqual([call({ timeMs: 500, count: 3, lastTimeMs: 900 })]);
  });

  it("keeps calls apart when anything but the time differs", () => {
    const calls: ConsentApiCall[] = [];
    mergeConsentCall(calls, call());
    mergeConsentCall(calls, call({ api: "__gpp", command: "getGPPData" }));
    mergeConsentCall(calls, call({ callerScriptUrl: null }));
    mergeConsentCall(calls, call({ viaTagManager: true }));
    mergeConsentCall(calls, call({ viaTagManager: true, containerUrls: ["https://www.googletagmanager.com/gtm.js?id=GTM-A"] }));
    mergeConsentCall(calls, call({ viaTagManager: true, containerUrls: ["https://www.googletagmanager.com/gtm.js?id=GTM-B"] }));
    expect(calls).toHaveLength(6);
  });

  it("drops a new caller once the list is full, and still counts known ones", () => {
    const calls: ConsentApiCall[] = [];
    expect(mergeConsentCall(calls, call({ callerScriptUrl: "https://a.example/x.js" }), 2)).toBe("added");
    expect(mergeConsentCall(calls, call({ callerScriptUrl: "https://b.example/x.js" }), 2)).toBe("added");
    expect(mergeConsentCall(calls, call({ callerScriptUrl: "https://c.example/x.js" }), 2)).toBe("dropped");
    expect(mergeConsentCall(calls, call({ callerScriptUrl: "https://a.example/x.js" }), 2)).toBe("merged");
    expect(calls.map(callCount)).toEqual([2, 1]);
  });

  it("reads a record from before 1.15.0 as one call", () => {
    expect(callCount(call())).toBe(1);
  });
});
