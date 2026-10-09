// SPDX-License-Identifier: GPL-3.0-only
/**
 * @gpc-inspector/capture-extension — the browser-facing package.
 *
 * The only package permitted to touch chrome.*, the DOM, or the network. Its single
 * responsibility is to emit a valid ObservationSet; every judgment about what those
 * observations MEAN belongs to @gpc-inspector/engine.
 */

export { detectSignalSource, OWNER_MARK } from "./signal/detect.js";
export type { SignalSource, SourceDetection } from "./signal/detect.js";

export { assertSignal, noReadReporter } from "./signal/assert.js";
export type { AssertionResult, ReadTracking } from "./signal/assert.js";

export {
  buildGpcRule,
  enableGpcHeader,
  disableGpcHeader,
  isGpcHeaderEnabled,
  verifyGpcRuleInstalled,
  GPC_RULE_ID,
} from "./signal/dnr.js";

export {
  parseSetCookie,
  parseSetCookieHeaders,
  isRedirectStatus,
  findHeader,
  hasSecGpc,
} from "./observe/cookies.js";
