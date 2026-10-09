// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  sha256Canonical,
  sealBundle,
  verifyBundle,
  computeBundleHash,
} from "../src/hash.js";
import { canonicalize } from "../src/canonicalize.js";
import { SCHEMA_VERSION } from "../src/version.js";
import type { EvidenceBundle, Provenance } from "../src/evidence-bundle.js";
import type { ObservationSet } from "../src/observation-set.js";

describe("sha256Canonical", () => {
  it("agrees with an independent SHA-256 implementation (Node crypto)", async () => {
    // The schema hashes via Web Crypto (subtle.digest); Node's crypto is a separate
    // implementation. Agreement here is the actual guarantee we need: a bundle sealed
    // in the browser (subtle) verifies in a Node harness — the replayability contract.
    const inputs: unknown[] = [
      "abc",
      { x: 1, y: [true, null, "s"] },
      [1, 2, 3],
      { nested: { a: 1, b: { c: 2 } }, list: [{ z: 0 }] },
    ];
    for (const input of inputs) {
      const viaSubtle = await sha256Canonical(input);
      const viaNode = createHash("sha256")
        .update(canonicalize(input), "utf8")
        .digest("hex");
      expect(viaSubtle).toBe(viaNode);
    }
  });

  it("produces a known-answer hash for the canonical form of \"abc\"", async () => {
    // canonicalize("abc") is the 5-byte string \"abc\"; this is its SHA-256.
    expect(await sha256Canonical("abc")).toBe(
      "6cc43f858fbb763301637b5af970e2a46b46f461f27e5a0f41e009c59b827b25",
    );
  });

  it("is order-independent for object keys", async () => {
    const a = await sha256Canonical({ x: 1, y: 2 });
    const b = await sha256Canonical({ y: 2, x: 1 });
    expect(a).toBe(b);
  });

  it("differs when array order differs", async () => {
    const a = await sha256Canonical([1, 2]);
    const b = await sha256Canonical([2, 1]);
    expect(a).not.toBe(b);
  });
});

// Minimal valid-enough fixtures for bundle sealing. The engine/capture packages test
// realistic ObservationSets; here we only exercise the hashing contract.
function minimalObservations(): ObservationSet {
  return {
    schemaVersion: SCHEMA_VERSION,
    context: {
      finalUrl: "https://example.com/",
      topSite: "example.com",
      extensionVersion: "1.0.0",
      browserUserAgent: "test",
      os: "test",
      capturedAt: "2026-07-21T00:00:00.000Z",
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
      readAttribution: null,
    },
    network: [],
    consentApiCalls: [],
    gpp: null,
    usPrivacy: null,
    tcf: null,
    gtm: { present: false, containerIds: [], gtagIds: [], consentMode: null },
    confirmationNotice: "not-detected",
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
    capabilities: {
      documentCookie: true,
      cookieStore: true,
      gpp: true,
      uspapi: true,
      tcfapi: true,
      dataLayer: true,
    },
  };
}

function minimalProvenance(): Provenance {
  return {
    schemaVersion: SCHEMA_VERSION,
    ruleSetVersion: "2026-07-14",
    ruleSetHash: "0".repeat(64),
    listSource: "disconnect",
    listVersion: "2026-07-01",
    listHash: "1".repeat(64),
  };
}

function sealableBundle(): Omit<EvidenceBundle, "bundleHash"> {
  return {
    schemaVersion: SCHEMA_VERSION,
    scanId: "00000000-0000-0000-0000-000000000000",
    createdAt: "2026-07-21T00:00:00.000Z",
    provenance: minimalProvenance(),
    redacted: "redacted",
    observations: minimalObservations(),
    findings: [],
  };
}

describe("bundle sealing and verification", () => {
  it("seals then verifies as authentic", async () => {
    const bundle = await sealBundle(sealableBundle());
    expect(bundle.bundleHash).toMatch(/^[0-9a-f]{64}$/);
    await expect(verifyBundle(bundle)).resolves.toBe(true);
  });

  it("detects tampering with the observations", async () => {
    const bundle = await sealBundle(sealableBundle());
    const tampered: EvidenceBundle = {
      ...bundle,
      observations: {
        ...bundle.observations,
        signal: { ...bundle.observations.signal, readCount: 999 },
      },
    };
    await expect(verifyBundle(tampered)).resolves.toBe(false);
  });

  it("detects tampering with provenance (swapped rule-set hash)", async () => {
    const bundle = await sealBundle(sealableBundle());
    const tampered: EvidenceBundle = {
      ...bundle,
      provenance: { ...bundle.provenance, ruleSetHash: "f".repeat(64) },
    };
    await expect(verifyBundle(tampered)).resolves.toBe(false);
  });

  it("produces the same hash regardless of property insertion order in the sealable", async () => {
    const s1 = sealableBundle();
    // rebuild with keys inserted in a different order
    const s2: Omit<EvidenceBundle, "bundleHash"> = {
      findings: s1.findings,
      observations: s1.observations,
      redacted: s1.redacted,
      provenance: s1.provenance,
      createdAt: s1.createdAt,
      scanId: s1.scanId,
      schemaVersion: s1.schemaVersion,
    };
    expect(await computeBundleHash(s1)).toBe(await computeBundleHash(s2));
  });

  it("is reproducible: same input hashes identically across calls", async () => {
    const s = sealableBundle();
    const h1 = await computeBundleHash(s);
    const h2 = await computeBundleHash(s);
    expect(h1).toBe(h2);
  });
});
