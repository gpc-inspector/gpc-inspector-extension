// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import manifest from "../public/manifest.json" with { type: "json" };
import messagesJson from "../public/_locales/en/messages.json" with { type: "json" };
import {
  hostOf,
  followOnActivated,
  isNavigationOf,
  touchesFollowed,
  pageIdentity,
  closesOnPageChange,
} from "../src/ui/panel.js";
import { tabKey, TAB_KEY_PREFIX } from "../src/background/tab-key.js";

/**
 * The side panel is the popup's page in a second host. These cover the decisions the panel
 * adds (which tab it shows, and when that tab's record changed) and the wiring that makes
 * the page a panel at all: the manifest entry, the permission and the button that opens it.
 */

describe("hostOf", () => {
  it("is the popup unless the page was opened as the panel", () => {
    expect(hostOf("")).toBe("popup");
    expect(hostOf("?fixture=heavy")).toBe("popup");
    expect(hostOf("?host=popup")).toBe("popup");
    expect(hostOf("?host=sidebar")).toBe("popup");
  });

  it("is the panel with host=panel, wherever it sits in the query", () => {
    expect(hostOf("?host=panel")).toBe("panel");
    expect(hostOf("?fixture=heavy&host=panel&screen=requests")).toBe("panel");
  });
});

describe("followOnActivated", () => {
  const followed = { windowId: 7, tabId: 10 };

  it("switches to a tab activated in the panel's own window", () => {
    expect(followOnActivated(followed, { windowId: 7, tabId: 11 })).toBe(11);
  });

  it("stays when another window's tab is activated", () => {
    expect(followOnActivated(followed, { windowId: 8, tabId: 11 })).toBeNull();
  });

  it("stays when the tab is the one already shown", () => {
    expect(followOnActivated(followed, { windowId: 7, tabId: 10 })).toBeNull();
  });

  it("stays when its own window is unknown, never showing another window's page", () => {
    expect(followOnActivated({ windowId: undefined, tabId: 10 }, { windowId: 7, tabId: 11 })).toBeNull();
  });

  it("takes the first tab when none was shown yet", () => {
    expect(followOnActivated({ windowId: 7, tabId: undefined }, { windowId: 7, tabId: 11 })).toBe(11);
  });
});

describe("isNavigationOf", () => {
  const followed = { windowId: 7, tabId: 10 };

  it("is true for a load starting or finishing in the followed tab", () => {
    expect(isNavigationOf(followed, 10, { status: "loading" })).toBe(true);
    expect(isNavigationOf(followed, 10, { status: "complete" })).toBe(true);
  });

  it("is true for a change of address in the followed tab", () => {
    expect(isNavigationOf(followed, 10, { url: "https://example.com/next" })).toBe(true);
  });

  it("is false for another tab, whatever changed", () => {
    expect(isNavigationOf(followed, 11, { status: "loading", url: "https://example.com/" })).toBe(false);
  });

  it("is false for a change that is neither, such as a title or an icon", () => {
    expect(isNavigationOf(followed, 10, {})).toBe(false);
  });
});

describe("touchesFollowed", () => {
  it("is true when the followed tab's record is among the changed keys", () => {
    expect(touchesFollowed({ windowId: 7, tabId: 10 }, ["wk:https://example.com", "tab:10"])).toBe(true);
  });

  it("is false for another tab's record, including one whose id starts the same", () => {
    expect(touchesFollowed({ windowId: 7, tabId: 10 }, ["tab:11", "tab:100", "tab:1"])).toBe(false);
  });

  it("is false when no tab is followed", () => {
    expect(touchesFollowed({ windowId: 7, tabId: undefined }, ["tab:10"])).toBe(false);
  });

  it("watches the key the worker writes", () => {
    // The worker's side of this is pinned in wiring.test.ts, which reads the record back
    // from session storage under the same key.
    expect(TAB_KEY_PREFIX).toBe("tab:");
    expect(tabKey(10)).toBe("tab:10");
  });
});

describe("pageIdentity", () => {
  const at = (finalUrl: string) => ({ context: { finalUrl } });

  it("is the same for two captures of one page in one tab", () => {
    expect(pageIdentity(10, at("https://example.com/a"))).toBe(pageIdentity(10, at("https://example.com/a")));
  });

  it("differs when the tab navigated", () => {
    expect(pageIdentity(10, at("https://example.com/a"))).not.toBe(pageIdentity(10, at("https://example.com/b")));
  });

  it("differs between two tabs on the same address", () => {
    expect(pageIdentity(10, at("https://example.com/a"))).not.toBe(pageIdentity(11, at("https://example.com/a")));
  });

  it("differs between a tab with no record and one with a record", () => {
    expect(pageIdentity(10, null)).not.toBe(pageIdentity(10, at("https://example.com/a")));
  });
});

describe("the panel's wiring", () => {
  it("declares the popup's own page as the panel, marked as the panel", () => {
    const path = manifest.side_panel.default_path;
    const [page, query] = path.split("?");
    expect(page).toBe(manifest.action.default_popup);
    expect(hostOf(`?${query ?? ""}`)).toBe("panel");
  });

  it("asks for the sidePanel permission", () => {
    expect(manifest.permissions).toContain("sidePanel");
  });

  it("requires a Chrome that has side panels", () => {
    // chrome.sidePanel arrived in Chrome 114. On an older Chrome the side_panel key is
    // unknown and the permission is unrecognized.
    expect(Number(manifest.minimum_chrome_version)).toBeGreaterThanOrEqual(114);
  });

  it("leaves the toolbar click on the popup", () => {
    // Rebinding the click to the panel would change what every installed copy does when
    // its icon is clicked.
    expect(manifest.action.default_popup).toBe("popup.html");
  });

  it("has a name for the button that opens the panel", () => {
    expect((messagesJson as Record<string, { message: string }>)["btnOpenPanel"]?.message).toBeTruthy();
  });
});

describe("closesOnPageChange", () => {
  it("closes the screens that hold a page's record", () => {
    expect(closesOnPageChange("export")).toBe(true);
    expect(closesOnPageChange("finding")).toBe(true);
  });

  it("keeps the reports that hold nothing about a page", () => {
    expect(closesOnPageChange("bug")).toBe(false);
    expect(closesOnPageChange("feature")).toBe(false);
  });
});
