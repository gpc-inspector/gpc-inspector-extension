// SPDX-License-Identifier: GPL-3.0-only
/**
 * Signal-integrity findings (PRD FR-4, FR-10).
 *
 * These concern the browser's own signal: was it sent, is the property readable, and did
 * any page script read it. The last one — signal-not-read — is the strongest zero-
 * inference finding in the product (maps to Meta's "never checked" failure), but it is
 * ONLY emitted when read tracking was actually active. If read tracking was unavailable
 * (another extension owns a non-configurable property, or native non-configurable), the
 * absence of reads is unobservable and we say nothing. Absence of data is never a
 * finding (PRD §8 governing principle).
 */

import type { Finding, ObservationSet } from "@gpc-inspector/schema";
import { RANK } from "../ranks.js";

/**
 * Does the site's own GPP string record that it saw GPC?
 *
 * Every section is examined, with no us-state filter, because only a us-state section can
 * carry a `Gpc` field at all — a filter would be a no-op that could later drift out of step
 * with the identical condition in gpp-conflict.ts, which reads the field the same way.
 */
function gppRecordsGpc(obs: ObservationSet): boolean {
  const gpp = obs.gpp;
  if (!gpp || gpp.unparseable) return false;
  return Object.values(gpp.sections).some((fields) => fields.Gpc === 1);
}

export function signalIntegrity(obs: ObservationSet): Finding[] {
  const findings: Finding[] = [];
  const sig = obs.signal;

  // signal-sent: context, not an accusation. Present when we actually sent it.
  if (sig.secGpcRequestCount > 0) {
    findings.push({
      flag: "signal-sent",
      rank: RANK.SIGNAL_SENT,
      entity: null,
      artifact: { kind: "none" },
    });
  }

  // signal-property-absent: page scripts cannot read navigator.globalPrivacyControl while
  // the header goes out. "absent" with the header sent is the meaningful state: the
  // extension could not define the property, or its registered script missed the load
  // (schema 1.43.0). With no header sent, "absent" is the extension's own off state on a
  // page nothing else owns, and says nothing about the page.
  if (sig.propertyValue === "absent" && sig.secGpcRequestCount > 0) {
    findings.push({
      flag: "signal-property-absent",
      rank: RANK.SIGNAL_PROPERTY_ABSENT,
      entity: null,
      artifact: { kind: "none" },
    });
  }

  // signal-not-read: no script read the property. ONLY when read tracking was active,
  // AND the property was actually being asserted (value true). If the signal wasn't on,
  // "no reads" is meaningless.
  //
  // And NOT when the site's own GPP string records the GPC field as 1. That is the site's
  // consent tool saying it received the signal, which it can do without any script reading
  // the property: the Sec-GPC request header reaches the server, and a CMP can decide
  // server-side or from the header alone. "No script read the property" stays literally
  // true there, but the finding is read as "nothing on this page registered your signal",
  // and that second claim is contradicted by the site's own broadcast. Rendering both at
  // once puts two of the site's facts on one screen looking like a contradiction that is
  // ours, not theirs.
  if (
    sig.readTracking === "active" &&
    sig.propertyValue === true &&
    sig.readCount === 0 &&
    !gppRecordsGpc(obs)
  ) {
    findings.push({
      flag: "signal-not-read",
      rank: RANK.SIGNAL_NOT_READ,
      entity: null,
      artifact: { kind: "signal-read", readCount: 0 },
    });
  }

  return findings;
}
