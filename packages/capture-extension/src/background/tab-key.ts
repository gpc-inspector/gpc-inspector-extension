// SPDX-License-Identifier: GPL-3.0-only
/**
 * The session-storage key a tab's record is written under.
 *
 * In a file of its own because two contexts need it. The worker writes the record
 * (state.ts), and the side panel watches the same key to learn that the page it is showing
 * has something new (ui/panel.ts). Importing it from state.ts would pull the worker's
 * working state into the panel's bundle, and a second copy of the prefix in the UI would be
 * one rename away from a panel that never refreshes.
 */

export const TAB_KEY_PREFIX = "tab:";

export function tabKey(tabId: number): string {
  return `${TAB_KEY_PREFIX}${tabId}`;
}
