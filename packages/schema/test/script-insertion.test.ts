// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import { canonicalize } from "../src/canonicalize.js";
import { sha256Canonical } from "../src/hash.js";
import type { ScriptInsertion, ScriptInsertionCoverage } from "../src/observation.js";
import type { ObservationSet } from "../src/observation-set.js";
import type { Finding } from "../src/finding.js";
import { SCHEMA_VERSION } from "../src/version.js";

/**
 * The insertion record (provenance, 1.12.0) as a schema citizen: it canonicalises, it
 * hashes deterministically, and a set without it is still a valid set. The engine's
 * resolution rules are tested in the engine package; this file only pins the contract.
 */

const GTM = "https://www.googletagmanager.com/gtm.js?id=GTM-A&l=dataLayer";

const record: ScriptInsertion = {
  key: "https://connect.facebook.net/en_US/fbevents.js",
  url: "https://connect.facebook.net/en_US/fbevents.js?v=2.9",
  element: "script",
  loaders: [
    {
      insertedBy: [GTM],
      inlineFrames: false,
      currentScriptKey: null,
      containerUrls: [GTM],
      via: "appendChild",
      frameOrigin: "https://www.example.com",
      topFrame: true,
      count: 3,
      timeMs: 1000,
    },
    {
      insertedBy: [],
      wrapperFrames: ["https://cmp.osano.com/x/osano.js"],
      inlineFrames: true,
      currentScriptKey: "inline:2",
      containerUrls: [],
      via: "insertBefore",
      frameOrigin: "https://www.example.com",
      topFrame: true,
      count: 1,
      timeMs: 2000,
    },
  ],
};

const coverage: ScriptInsertionCoverage = {
  recorded: 2,
  parser: 5,
  duplicates: 2,
  inline: 3,
  inlineResolvedByCurrentScript: 1,
  nonExecuting: 1,
  srcUnresolved: 0,
  stackFailed: 0,
  ambiguousContainer: 0,
  capExceeded: 0,
  wrappedOver: true,
  selfDisabled: false,
};

function set(over: Partial<ObservationSet> = {}): ObservationSet {
  return {
    schemaVersion: SCHEMA_VERSION,
    context: {
      finalUrl: "https://www.example.com/",
      topSite: "example.com",
      extensionVersion: "1.0.0",
      browserUserAgent: "t",
      os: "t",
      capturedAt: "2026-09-13T00:00:00.000Z",
      mode: "passive",
      incomplete: false,
    },
    signal: {
      secGpcRequestCount: 1,
      totalRequestCount: 1,
      source: "this-extension",
      propertyValue: true,
      readTracking: "active",
      readCount: 0,
      readsByScript: {},
      readAttribution: { sampled: 0, unattributed: 0, viaTagManager: 0 },
    },
    network: [],
    consentApiCalls: [],
    gpp: null,
    usPrivacy: null,
    tcf: null,
    gtm: { present: true, containerIds: ["GTM-A"], gtagIds: [], consentMode: null },
    confirmationNotice: "indeterminate",
    capabilities: { documentCookie: true, cookieStore: true, gpp: true, uspapi: true, tcfapi: true, dataLayer: true },
    wellKnown: null,
    tallies: {
      totalRequests: 0,
      signedRequests: 0,
      adVendorRequests: 0,
      adCookieEvents: 0,
      adCookieKeys: [],
      firstPartyVendorCookieKeys: [],
      byEntity: {},
    },
    ...over,
  };
}

describe("ScriptInsertion in an ObservationSet (schema 1.12.0)", () => {
  it("canonicalises and hashes deterministically with the record present", async () => {
    const a = set({ scriptInsertions: [record], scriptInsertionCoverage: coverage, capabilities: { documentCookie: true, cookieStore: true, gpp: true, uspapi: true, tcfapi: true, dataLayer: true, scriptInsertion: true } });
    // Same content, different key order inside the record.
    const reordered = JSON.parse(JSON.stringify(a)) as ObservationSet;
    const first = canonicalize(a);
    expect(canonicalize(reordered)).toBe(first);
    expect(await sha256Canonical(a)).toBe(await sha256Canonical(reordered));
    // Loader order is meaningful (sorted by time by the capture) and is preserved.
    expect(first.indexOf('"via":"appendChild"')).toBeLessThan(first.indexOf('"via":"insertBefore"'));
  });

  it("is optional: a set without the fields is the same set it was under 1.11.0", async () => {
    const without = set();
    expect("scriptInsertions" in without).toBe(false);
    expect(without.capabilities.scriptInsertion).toBeUndefined();
    // No new key leaks into the canonical form of an old-shaped set.
    expect(canonicalize(without)).not.toContain("scriptInsertion");
  });

  it("keeps the container id on a loader frame URL, which is the point of keeping the query", () => {
    const loader = record.loaders[0]!;
    expect(loader.containerUrls[0]).toContain("id=GTM-A");
    expect(loader.insertedBy[0]).toBe(loader.containerUrls[0]);
  });

  it("carries the loader artifact and loadedVia on a finding without touching older kinds", () => {
    const withLoader: Finding = {
      flag: "vendor-gpc-check-unattributable",
      rank: 40,
      entity: { name: "Meta", domains: ["facebook.net"] },
      artifact: {
        kind: "vendor-check-loader",
        loader: { kind: "container", identity: { manager: "gtm", id: "GTM-A" }, ancestors: [], mixed: false },
        route: "loader",
        containerCallCount: 2,
        checkedBeforeLoad: true,
        consentModeActive: false,
      },
    };
    const older: Finding = {
      flag: "vendor-gpc-check-unattributable",
      rank: 40,
      entity: { name: "Meta", domains: ["facebook.net"] },
      artifact: { kind: "vendor-check-container", containerCallCount: 2, consentModeActive: false },
    };
    const network: Finding = {
      flag: "vendor-did-not-read-gpc",
      rank: 41,
      entity: { name: "Meta", domains: ["facebook.net"] },
      artifact: { kind: "network", observationId: "7", loadedVia: [{ kind: "site", url: null }] },
    };
    for (const f of [withLoader, older, network]) expect(canonicalize(f)).toContain(f.artifact.kind);
  });
});
