// SPDX-License-Identifier: GPL-3.0-only
/**
 * Confirmation-notice and US-Privacy-surface findings (PRD FR-13, FR-14).
 *
 * confirmation-not-detected: emitted only on the "not-detected" state. Never "the site
 * didn't show one" — §7025(c)(6) says "for example", so a settings-page placement
 * satisfies it and we cannot see that. The UI copy carries the caveat. "indeterminate"
 * and "detected" produce nothing.
 *
 * usp-surfaces-disagree: the three US Privacy surfaces (API, cookie, wire) are supposed
 * to match. When two present surfaces disagree, that mismatch is itself the finding
 * (FR-13). Absent surfaces (null) are not disagreements — only present-vs-present
 * mismatches count. "1---" (not applicable) is not a failure and does not trigger this
 * on its own; it only matters if another surface says something different.
 *
 * The wire surface is every distinct value requests carried (1.29.0), not the last one:
 * judged from the last one, the finding came and went as requests arrived (news-h.example,
 * 2026-09-30: Google's requests carried the page's 1YYN, Rubicon's and others' 1---). At
 * least one page surface must be present; requests differing only among themselves are
 * not a disagreement with the page.
 *
 * usp-requests-disagree / gpp-requests-disagree: that other case. The page reported no
 * string, and requests carried different ones. A claim about what the partners were sent,
 * not about the page, so it has its own flag and its own sentence.
 *
 * gpp-surfaces-disagree: same failure mode, one surface fewer. GPP has no IAB-standardized
 * cookie name the way USP has `usprivacy` (CMPs persist it in vendor-specific localStorage
 * keys instead), so there are only two surfaces to compare: the live __gpp string and the
 * gpp= values actually seen on outbound requests. The page's string present and any
 * request carrying another is the finding; either one absent is not — we cannot tell a
 * genuine mismatch from "the wire observation hasn't arrived yet" without both.
 */

import type { Finding, ObservationSet, WireValue } from "@gpc-inspector/schema";
import { wireValuesOf } from "@gpc-inspector/schema";
import { RANK } from "../ranks.js";

export function confirmationNotice(obs: ObservationSet): Finding[] {
  if (obs.confirmationNotice !== "not-detected") return [];
  return [
    {
      flag: "confirmation-not-detected",
      rank: RANK.CONFIRMATION_NOT_DETECTED,
      entity: null,
      artifact: { kind: "none" },
    },
  ];
}

/** The value and first host an artifact shows: the first that differs, else the first. */
function shownWire(
  wire: readonly WireValue[],
  page: string | null,
): { fromWire: string | null; fromWireHost?: string } {
  const w = wire.find((v) => v.value !== page) ?? wire[0];
  if (w === undefined) return { fromWire: null };
  const host = w.hosts[0];
  return { fromWire: w.value, ...(host !== undefined ? { fromWireHost: host } : {}) };
}

export function uspSurfacesDisagree(obs: ObservationSet): Finding[] {
  const usp = obs.usPrivacy;
  if (!usp) return [];

  // Requests disagreeing only among themselves, with no page value to compare against,
  // are not the page disagreeing with anything. The row says whose string it shows.
  const page = [usp.fromApi, usp.fromCookie].filter((v): v is string => v !== null);
  if (page.length === 0) return [];
  const wire = wireValuesOf(usp);

  // Disagreement iff not every present surface carries the same value.
  const values = new Set([...page, ...wire.map((w) => w.value)]);
  if (values.size < 2) return [];

  return [
    {
      flag: "usp-surfaces-disagree",
      rank: RANK.USP_SURFACES_DISAGREE,
      entity: null,
      artifact: {
        kind: "usp",
        fromApi: usp.fromApi,
        fromCookie: usp.fromCookie,
        // Compared against what the notice shows as the page's value: the API's, else the
        // cookie's.
        ...shownWire(wire, usp.fromApi ?? usp.fromCookie),
      },
    },
  ];
}

export function gppSurfacesDisagree(obs: ObservationSet): Finding[] {
  const gpp = obs.gpp;
  if (!gpp || gpp.rawString === "") return [];
  const differing = wireValuesOf(gpp).find((w) => w.value !== gpp.rawString);
  if (differing === undefined) return [];
  const host = differing.hosts[0];

  return [
    {
      flag: "gpp-surfaces-disagree",
      rank: RANK.GPP_SURFACES_DISAGREE,
      entity: null,
      artifact: {
        kind: "gpp-wire",
        fromApi: gpp.rawString,
        fromWire: differing.value,
        ...(host !== undefined ? { fromWireHost: host } : {}),
      },
    },
  ];
}

/** Requests carried different strings and the page reported none: the values, or nothing. */
function requestsDisagree(pageReported: boolean, wire: readonly WireValue[]): WireValue[] | null {
  if (pageReported || wire.length < 2) return null;
  return [...wire];
}

export function uspRequestsDisagree(obs: ObservationSet): Finding[] {
  const usp = obs.usPrivacy;
  if (!usp) return [];
  const values = requestsDisagree(usp.fromApi !== null || usp.fromCookie !== null, wireValuesOf(usp));
  if (values === null) return [];
  return [
    {
      flag: "usp-requests-disagree",
      rank: RANK.USP_REQUESTS_DISAGREE,
      entity: null,
      artifact: { kind: "wire-values", values },
    },
  ];
}

export function gppRequestsDisagree(obs: ObservationSet): Finding[] {
  const gpp = obs.gpp;
  if (!gpp) return [];
  const values = requestsDisagree(gpp.rawString !== "", wireValuesOf(gpp));
  if (values === null) return [];
  return [
    {
      flag: "gpp-requests-disagree",
      rank: RANK.GPP_REQUESTS_DISAGREE,
      entity: null,
      artifact: { kind: "wire-values", values },
    },
  ];
}
