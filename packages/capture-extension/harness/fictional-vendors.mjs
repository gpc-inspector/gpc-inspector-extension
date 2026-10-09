// SPDX-License-Identifier: GPL-3.0-only
/**
 * Fictional vendors for the store screenshots, harness only.
 *
 * The store images name no real company, so no shot can be read as an observation of one.
 * Each entry gives a host on the reserved .example TLD a made-up company and one of Disconnect's categories, through the classifier's override
 * layer, and the harness's popup classifies with the real list plus these
 * (harness/classifier.mjs). The shipped extension never sees them: `overrides.ts` stays
 * empty (Disconnect is the source of truth for every real domain), and nothing under src/
 * imports this file.
 *
 * Names are invented. A real company with the same name would be a coincidence; the
 * .example hosts and the "Illustrative data" label on every frame say so.
 */

const REASON = "Harness only: a fictional vendor. Never shipped.";

const vendor = (domain, entityName, category) => ({ domain, entityName, category, reason: REASON });

/** @type {readonly import("@gpc-inspector/lists").Override[]} */
export const FICTIONAL_VENDORS = [
  vendor("adlark.example", "Adlark", "advertising"),
  vendor("bidmoor.example", "Bidmoor", "advertising"),
  vendor("crestline.example", "Crestline Ads", "advertising"),
  vendor("dunmore.example", "Dunmore Exchange", "advertising"),
  vendor("fernbid.example", "Fernbid", "advertising"),
  vendor("glimmer.example", "Glimmer Media", "advertising"),
  vendor("inkwell.example", "Inkwell Retarget", "advertising"),
  vendor("pixelmoss.example", "Pixelmoss", "advertising"),
  vendor("tallyhall.example", "Tallyhall", "analytics"),
  vendor("quillstat.example", "Quillstat", "analytics"),
  vendor("ridgeway.example", "Ridgeway Insights", "analytics"),
  vendor("harborline.example", "Harborline", "consent-managers"),
];
