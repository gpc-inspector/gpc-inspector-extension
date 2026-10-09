// SPDX-License-Identifier: GPL-3.0-only
/**
 * EvidenceBundle — the exportable artifact (PRD FR-23, FR-24, D7, D8).
 *
 * It wraps the ObservationSet the engine ran on, the Findings the engine produced, and
 * the full provenance needed to reproduce the result: schema version, rule-set version
 * + hash, list version + hash, plus a hash over the canonicalized bundle itself.
 *
 * Three properties this type must guarantee:
 *   - Replayable: a third party with the file alone can re-run the engine on
 *     `observations` and get `findings` back (FR-23).
 *   - Re-verifiable: they can recompute `bundleHash` from the canonical form and match.
 *   - Publication-ready: the provenance is complete, so a bundle needs nothing added
 *     before it is published (D8).
 *
 * Redaction (FR-24) is applied to a COPY before export. The in-memory ObservationSet
 * keeps real values; the exported bundle has Cookie/Authorization values and query
 * strings masked. A bundle in a report to the public tracker is always masked. An
 * unmasked bundle exists only as a file the reader chose to save for their own record.
 * `redacted` records which.
 */

import type { SchemaVersion } from "./version.js";
import type { ObservationSet } from "./observation-set.js";
import type { Finding } from "./finding.js";

/** Versions and hashes that make a finding reproducible (PRD FR-23). */
export interface Provenance {
  readonly schemaVersion: SchemaVersion;
  /** Engine rule-set version, e.g. "2026-07-14". Matches the About screen + every bundle. */
  readonly ruleSetVersion: string;
  /** SHA-256 of the engine's rule set. */
  readonly ruleSetHash: string;
  /** Classification list identity (e.g. "disconnect"), version/date, and hash. */
  readonly listSource: string;
  readonly listVersion: string;
  readonly listHash: string;
  /**
   * The list of functional cookie names that produced any "listed as functional" label
   * (1.21.0): what it was compiled from, at which commit, and the hash of the file read.
   * The label is computed in the popup and changes no finding and no count; this is here
   * so a report shows which list said so. Absent in a bundle recorded before 1.21.0.
   */
  readonly functionalList?: {
    readonly source: string;
    readonly version: string;
    readonly commit: string;
    readonly hash: string;
  };
  /**
   * The Public Suffix List that decided each host's registrable domain, and with it first
   * or third party and the domain a finding names (1.28.0): where it was published, its
   * version and its commit. Absent in a bundle recorded before 1.28.0.
   */
  readonly publicSuffixList?: {
    readonly source: string;
    readonly version: string;
    readonly commit: string;
  };
}

export type RedactionState = "redacted" | "unmasked";

export interface EvidenceBundle {
  readonly schemaVersion: SchemaVersion;
  /** UUID for this scan. The capture's own id (`observations.context.scanId`) when it has one. */
  readonly scanId: string;
  /** ISO 8601 UTC — copied from the observation context for top-level convenience. */
  readonly createdAt: string;
  readonly provenance: Provenance;
  /** Whether cookie/credential values in `observations` are masked. */
  readonly redacted: RedactionState;
  /** The exact input the engine ran on (redacted per `redacted`). */
  readonly observations: ObservationSet;
  /** What the engine produced from `observations`. */
  readonly findings: readonly Finding[];
  /**
   * SHA-256 over the canonical serialization of everything above (excluding this field).
   * Recomputable offline; see canonicalize.ts. This is the tamper-evidence seal.
   */
  readonly bundleHash: string;
}
