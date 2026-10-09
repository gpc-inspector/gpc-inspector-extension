// SPDX-License-Identifier: GPL-3.0-only
/**
 * The notices the extension shows about itself, in one place so each surface that carries
 * them uses the same ones.
 *
 * The statement that limits reliance closes Settings (About) and the saved summary, and
 * the README carries the same words. It is shown nowhere else in the popup: not in the
 * findings, not in the Overview. `statement.test.ts` holds both rules.
 */

/** The statement's three paragraphs, as message keys, in order. */
export const STATEMENT_KEYS = ["statementObserved", "statementFinding", "statementIndependent"] as const;

/** The license of this extension's own code, as its SPDX identifier. The data keeps its own. */
export const CODE_LICENSE = "GPL-3.0-only";
export const CODE_LICENSE_URL = "https://www.gnu.org/licenses/gpl-3.0.html";

/** The copyright line, as NOTICE and packages/lists/LICENSE give it. Never translated. */
export const COPYRIGHT = "Copyright 2026 GPC Inspector";
