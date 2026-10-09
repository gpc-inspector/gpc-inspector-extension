// SPDX-License-Identifier: GPL-3.0-only
/**
 * The side panel: what differs from the popup, as pure decisions.
 *
 * One page, two hosts. popup.html is the toolbar popup and, opened with ?host=panel, the
 * side panel (the manifest's side_panel.default_path). Both render the same view model
 * through the same renderers, so nothing here decides what anything means. What the panel
 * adds is that it stays open: across tab switches, across navigations and while a page
 * loads. It therefore has to know which tab it is showing and when that tab's record has
 * changed, which the popup does not need, because it is read once and closed.
 *
 * Those decisions are here, away from chrome.* and the DOM, where they can be tested.
 * popup.ts holds the listeners and calls these.
 */

import { tabKey } from "../background/tab-key.js";

export type Host = "popup" | "panel";

/** Which host this page was opened in, from its own query string. */
export function hostOf(search: string): Host {
  return new URLSearchParams(search).get("host") === "panel" ? "panel" : "popup";
}

/** The tab being shown, and the window this page belongs to. */
export interface Followed {
  readonly windowId: number | undefined;
  readonly tabId: number | undefined;
}

/**
 * tabs.onActivated: the tab to switch to, or null to stay.
 *
 * A panel belongs to one window and shows that window's active tab. A tab activated in
 * another window is that window's panel's business. With the panel's own window unknown,
 * the panel stays where it is: showing another window's page under this window's tab would
 * be a wrong answer, and a record that is merely not the newest is not.
 */
export function followOnActivated(
  followed: Followed,
  info: { readonly tabId: number; readonly windowId: number },
): number | null {
  if (followed.windowId === undefined || info.windowId !== followed.windowId) return null;
  return info.tabId === followed.tabId ? null : info.tabId;
}

/**
 * tabs.onUpdated: whether the followed tab started or finished a load, or changed address.
 *
 * Either means the worker has reset the tab's record for a new page or is about to, and
 * the signal status may differ on it, so the refresh this asks for reads both again.
 */
export function isNavigationOf(
  followed: Followed,
  tabId: number,
  change: { readonly url?: string | undefined; readonly status?: string | undefined },
): boolean {
  return tabId === followed.tabId && (change.url !== undefined || change.status !== undefined);
}

/** storage.session.onChanged: whether the followed tab's record is among the changed keys. */
export function touchesFollowed(followed: Followed, changedKeys: readonly string[]): boolean {
  return followed.tabId !== undefined && changedKeys.includes(tabKey(followed.tabId));
}

/**
 * What identifies the page on screen.
 *
 * Two renders of the same page keep what the reader had open and where they had scrolled;
 * a different page starts closed and at the top. The address is the page as the worker
 * recorded it, so a page that changes its own address without loading (history.pushState)
 * is still the same record and keeps its state.
 */
export function pageIdentity(
  tabId: number | undefined,
  observations: { readonly context: { readonly finalUrl: string } } | null,
): string {
  return `${tabId ?? ""}\n${observations?.context.finalUrl ?? ""}`;
}
