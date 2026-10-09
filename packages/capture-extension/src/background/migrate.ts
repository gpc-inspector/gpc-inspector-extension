// SPDX-License-Identifier: GPL-3.0-only
/**
 * Update from v0.1.4.
 *
 * The store item ID is retained, so v0.1.4's installs receive this version as an update and
 * Chrome keeps two pieces of the old extension's state alive underneath it. Neither is
 * visible to the new code unless it goes looking:
 *
 *   - Settings. v0.1.4 kept `{ gpc_setting, badge_setting }` under `options` in
 *     chrome.storage.SYNC. This version reads `settings` from chrome.storage.LOCAL, finds
 *     nothing, and would write defaults with sending ON. Someone who turned the signal off
 *     would have it turned back on by an update, silently.
 *
 *   - The header rule. Dynamic declarativeNetRequest rules persist across updates, and
 *     v0.1.4 installed its Sec-GPC rule under id 290. dnr.ts only ever adds and removes
 *     GPC_RULE_ID, so the old rule would keep sending the header after the user turned
 *     sending off here, and verifyGpcRuleInstalled would not notice.
 *
 * A caveat on the first: v0.1.4 rewrote both options to `true` at service-worker top level,
 * so a stored `true` may be the user's choice or the stomp. A stored `false` can only be
 * the user's, and recent. That is the value this exists to carry over.
 */

import { DEFAULT_SETTINGS, type Settings } from "./state.js";
import { GPC_RULE_ID } from "../signal/dnr.js";

/** The shape v0.1.4 stored under `options` in chrome.storage.sync. */
interface LegacyOptions {
  gpc_setting?: unknown;
  badge_setting?: unknown;
}

/**
 * What v0.1.4's options mean in this version's settings. Only an explicit `false` turns
 * anything off: v0.1.4 read both with Boolean(), but an absent or malformed value is not a
 * choice, and the default stands.
 */
export function settingsFromLegacy(options: LegacyOptions): Settings {
  return {
    ...DEFAULT_SETTINGS,
    sendSignal: options.gpc_setting !== false,
    showBadge: options.badge_setting !== false,
    returningUser: true,
  };
}

/**
 * Carry v0.1.4's options over, once. Must run BEFORE initSettingsIfAbsent, which would
 * otherwise write the defaults this is here to prevent.
 *
 * Gated on `settings` being absent, so it cannot overwrite a choice made in this version.
 * The sync key is left in place: sync storage is shared across the user's devices, and one
 * still running v0.1.4 reads it. firstRunComplete stays false, because passive observation
 * is new and the first-run disclosure has not been shown to anyone coming from v0.1.4.
 */
export async function migrateLegacySettings(): Promise<boolean> {
  const got = await chrome.storage.local.get("settings");
  if (got["settings"] !== undefined) return false;

  let options: unknown;
  try {
    options = (await chrome.storage.sync.get("options"))["options"];
  } catch {
    return false; // sync unreadable: nothing to carry over, and defaults are the fallback
  }
  if (typeof options !== "object" || options === null) return false;

  await chrome.storage.local.set({ settings: settingsFromLegacy(options as LegacyOptions) });
  return true;
}

/**
 * Remove every dynamic rule that is not ours.
 *
 * Every rule rather than id 290 by name: this extension installs exactly one dynamic rule,
 * so anything else in its rule set is left over from a version that no longer exists, and
 * a rule nothing removes is a header nothing can turn off.
 */
export async function removeLegacyRules(): Promise<void> {
  const rules = await chrome.declarativeNetRequest.getDynamicRules();
  const stale = rules.map((r) => r.id).filter((id) => id !== GPC_RULE_ID);
  if (stale.length === 0) return;
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: stale });
}
