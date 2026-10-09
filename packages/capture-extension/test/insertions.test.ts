// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import {
  mergeInsertion,
  internInsertions,
  expandInsertions,
  LOADERS_PER_KEY,
  RECORDS_PER_TAB,
} from "../src/background/insertions.js";
import type { ScriptInsertion, ScriptInsertionLoader } from "@gpc-inspector/schema";

const GTM = "https://www.googletagmanager.com/gtm.js?id=GTM-A";

function loader(over: Partial<ScriptInsertionLoader> = {}): ScriptInsertionLoader {
  return {
    insertedBy: [GTM],
    inlineFrames: false,
    currentScriptKey: null,
    containerUrls: [GTM],
    via: "appendChild",
    frameOrigin: "https://www.example.com",
    topFrame: true,
    count: 1,
    timeMs: 100,
    ...over,
  };
}

describe("mergeInsertion", () => {
  it("adds a new key, bumps a known loader's count, and adds a distinct loader in time order", () => {
    const records: ScriptInsertion[] = [];
    mergeInsertion(records, { key: "k", url: "k?1", element: "script", loader: loader({ timeMs: 200 }) });
    expect(records).toHaveLength(1);
    mergeInsertion(records, { key: "k", url: "k?2", element: "script", loader: loader({ timeMs: 200, count: 4 }) });
    expect(records[0]!.loaders).toHaveLength(1);
    expect(records[0]!.loaders[0]!.count).toBe(4);
    expect(records[0]!.url).toBe("k?1"); // first URL seen stays
    mergeInsertion(records, {
      key: "k",
      url: "k",
      element: "script",
      loader: loader({ via: "parser", insertedBy: [], containerUrls: [], timeMs: 50 }),
    });
    expect(records[0]!.loaders.map((l) => l.via)).toEqual(["parser", "appendChild"]);
  });

  it("never lowers a count and caps loaders per key and records per tab", () => {
    const records: ScriptInsertion[] = [];
    mergeInsertion(records, { key: "k", url: "k", element: "script", loader: loader({ count: 5 }) });
    mergeInsertion(records, { key: "k", url: "k", element: "script", loader: loader({ count: 2 }) });
    expect(records[0]!.loaders[0]!.count).toBe(5);
    for (let i = 0; i < LOADERS_PER_KEY + 2; i++) {
      mergeInsertion(records, { key: "k", url: "k", element: "script", loader: loader({ frameOrigin: `o${i}` }) });
    }
    expect(records[0]!.loaders).toHaveLength(LOADERS_PER_KEY);
    for (let i = 0; i < RECORDS_PER_TAB + 3; i++) {
      mergeInsertion(records, { key: `key${i}`, url: `key${i}`, element: "script", loader: loader() });
    }
    expect(records).toHaveLength(RECORDS_PER_TAB);
  });
});

describe("internInsertions / expandInsertions", () => {
  it("round-trips exactly, storing each URL once", () => {
    const records: ScriptInsertion[] = [
      {
        key: "https://v.example/a.js",
        url: "https://v.example/a.js?x=1",
        element: "script",
        loaders: [loader(), loader({ via: "insertBefore", wrapperFrames: ["https://cmp.example/w.js"], currentScriptKey: "inline:1", timeMs: 300 })],
      },
      { key: "inline:1", url: "inline:1", element: "script", loaders: [loader({ insertedBy: [], containerUrls: [] })] },
      { key: "https://ads.example/f.html", url: "https://ads.example/f.html", element: "iframe", loaders: [loader()] },
    ];
    const interned = internInsertions(records);
    // GTM appears in four loaders across the records and is stored once.
    expect(interned.urls.filter((u) => u === GTM)).toHaveLength(1);
    expect(expandInsertions(interned)).toEqual(records);
  });

  it("expands nothing for a state written before the field existed", () => {
    expect(expandInsertions(undefined)).toEqual([]);
  });
});
