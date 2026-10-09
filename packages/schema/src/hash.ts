// SPDX-License-Identifier: GPL-3.0-only
/**
 * Hashing and bundle sealing (PRD FR-23).
 *
 * SHA-256 over the canonical serialization. We use the Web Crypto API (globalThis.crypto
 * .subtle), which is present in both the extension service worker AND Node 20+. That
 * keeps the schema package free of any dependency and lets the SAME code seal a bundle
 * in the browser and verify it in the Node test harness — which is the whole point of a
 * replayable bundle.
 *
 * subtle.digest is async, so sealing and verifying are async. Callers await.
 */

import { canonicalize } from "./canonicalize.js";
import type { EvidenceBundle } from "./evidence-bundle.js";

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

/** SHA-256 of the canonical form of any JSON-compatible value, as lowercase hex. */
export async function sha256Canonical(value: unknown): Promise<string> {
  const canonical = canonicalize(value);
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(canonical));
  return toHex(digest);
}

/**
 * The exact shape that gets hashed for a bundle: everything except bundleHash itself.
 * Extracted so seal and verify hash identical bytes.
 */
type Sealable = Omit<EvidenceBundle, "bundleHash">;

/**
 * Compute the bundle hash over everything but the hash field. A caller building a
 * bundle constructs the Sealable part, calls this, and attaches the result.
 */
export async function computeBundleHash(sealable: Sealable): Promise<string> {
  return sha256Canonical(sealable);
}

/** Attach a freshly-computed hash, producing a sealed EvidenceBundle. */
export async function sealBundle(sealable: Sealable): Promise<EvidenceBundle> {
  const bundleHash = await computeBundleHash(sealable);
  return { ...sealable, bundleHash };
}

/**
 * Verify a bundle's seal. Returns true iff recomputing the hash over the bundle's
 * contents (minus bundleHash) matches the stored bundleHash. This is what a third
 * party runs offline to confirm the artifact wasn't altered.
 */
export async function verifyBundle(bundle: EvidenceBundle): Promise<boolean> {
  const { bundleHash, ...sealable } = bundle;
  const recomputed = await computeBundleHash(sealable);
  return timingSafeEqualHex(recomputed, bundleHash);
}

/** Constant-time-ish hex compare. Not security-critical here, but avoids early-exit habits. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
