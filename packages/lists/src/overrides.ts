// SPDX-License-Identifier: GPL-3.0-only
/**
 * Local override layer (PRD FR-17).
 *
 * Disconnect does not accept pull requests — their repository states that PRs are not
 * reviewed and will be closed. So a misclassification found in the wild has no upstream
 * fix path. This file is that fix path: a small, reviewable delta applied on top of the
 * upstream index at load time.
 *
 * Rules for entries here:
 *   - Every entry needs a `reason`. An unexplained override is unreviewable, and this
 *     file is the thing a skeptic reads when they dispute a classification.
 *   - Prefer the narrowest domain that fixes the problem.
 *   - An override that suppresses a finding deserves more scrutiny than one that adds a
 *     classification, because the former can hide something real.
 *
 * This file ships empty, and stays empty: Disconnect is the source of truth for a domain's
 * company and category, and the extension adds no mapping of its own. An entry here is our
 * own claim of ownership, and it moves a company's count and its Read GPC state. A domain
 * Disconnect does not carry is shown by its domain. Cookie names are not evidence of who
 * operates a host: they show which library ran, and a library can be served from anywhere.
 * See docs/LIMITATIONS.md, "Every company is Disconnect's too".
 */

import type { Override } from "./classifier.js";

export const LOCAL_OVERRIDES: readonly Override[] = [];
