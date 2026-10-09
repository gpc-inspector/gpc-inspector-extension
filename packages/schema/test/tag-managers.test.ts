// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import { containerIdentity, isTagManagerFrame, containerKey, consentModeNeedsDataLayer } from "../src/tag-managers.js";

describe("containerIdentity — Google", () => {
  it("names a GTM container from the id parameter", () => {
    expect(containerIdentity("https://www.googletagmanager.com/gtm.js?id=GTM-XNWF20")).toEqual({
      manager: "gtm",
      id: "GTM-XNWF20",
    });
  });

  it("ignores everything in the query except the id", () => {
    // One container loaded against a second dataLayer name, and again in a preview
    // environment, is one container.
    const a = containerIdentity("https://www.googletagmanager.com/gtm.js?id=GTM-XNWF100&l=NF2DL");
    const b = containerIdentity(
      "https://www.googletagmanager.com/gtm.js?id=GTM-XNWF100&gtm_auth=abc&gtm_preview=env-3&gtm_cookies_win=x",
    );
    expect(a).toEqual({ manager: "gtm", id: "GTM-XNWF100" });
    expect(containerKey(a!)).toBe(containerKey(b!));
  });

  it("names the Google tag from gtag/js and gtag/destination", () => {
    expect(containerIdentity("https://www.googletagmanager.com/gtag/js?id=G-XNWF100000&l=NF2DL&cx=c")).toEqual(
      { manager: "gtag", id: "G-XNWF100000" },
    );
    expect(containerIdentity("https://www.googletagmanager.com/gtag/js?id=AW-70100000000")).toEqual({
      manager: "gtag",
      id: "AW-70100000000",
    });
    expect(containerIdentity("https://www.googletagmanager.com/gtag/destination?id=DC-70100000&l=dataLayer")).toEqual(
      { manager: "gtag", id: "DC-70100000" },
    );
  });

  it("treats a GTM id handed to the gtag loader as the container it is", () => {
    expect(containerIdentity("https://www.googletagmanager.com/gtag/js?id=GTM-ABC123")).toEqual({
      manager: "gtm",
      id: "GTM-ABC123",
    });
  });

  it("is a manager frame with no id for a Google helper script", () => {
    // Real and distinct from "not a manager": it is treated as a container that names
    // nothing, never as a vendor.
    expect(containerIdentity("https://www.googletagmanager.com/debug/bootstrap")).toEqual({
      manager: "google",
      id: null,
    });
    expect(containerIdentity("https://www.googletagmanager.com/gtm.js")).toEqual({ manager: "gtm", id: null });
  });

  it("recognizes a server-side GTM loader served first-party under the default path", () => {
    expect(containerIdentity("https://metrics.example.com/gtm.js?id=GTM-SSABC")).toEqual({
      manager: "gtm",
      id: "GTM-SSABC",
    });
  });

  it("does not recognize a loader renamed to a custom path (recorded limit)", () => {
    expect(containerIdentity("https://metrics.example.com/x.js?id=GTM-SSABC")).toBeNull();
  });
});

describe("containerIdentity — other managers", () => {
  it("Tealium: account/profile from the utag path, on the CDN or self-hosted", () => {
    expect(containerIdentity("https://tags.tiqcdn.com/utag/acme/main/prod/utag.js")).toEqual({
      manager: "tealium",
      id: "acme/main",
    });
    expect(containerIdentity("https://tags.tiqcdn.com/utag/acme/main/prod/utag.sync.js")).toEqual({
      manager: "tealium",
      id: "acme/main",
    });
    expect(containerIdentity("https://tags.tiqcdn.com/utag/acme/main/prod/utag.12.js")).toEqual({
      manager: "tealium",
      id: "acme/main",
    });
    expect(containerIdentity("https://tags.example.com/utag/acme/main/prod/utag.js")).toEqual({
      manager: "tealium",
      id: "acme/main",
    });
    // The CDN host with an unexpected path is still Tealium, unnamed.
    expect(containerIdentity("https://tags.tiqcdn.com/utag/x/prod/utag.js")).toEqual({
      manager: "tealium",
      id: null,
    });
  });

  it("Adobe Launch: the property build name, on the CDN or self-hosted, plus legacy DTM", () => {
    expect(containerIdentity("https://assets.adobedtm.com/1234abcd/5678efgh/launch-9a8b7c6d.min.js")).toEqual({
      manager: "adobe-launch",
      id: "launch-9a8b7c6d",
    });
    expect(containerIdentity("https://assets.adobedtm.com/x/y/launch-9a8b7c6d-development.min.js")).toEqual({
      manager: "adobe-launch",
      id: "launch-9a8b7c6d-development",
    });
    expect(containerIdentity("https://www.example.com/tags/launch-9a8b7c6d.js")).toEqual({
      manager: "adobe-launch",
      id: "launch-9a8b7c6d",
    });
    expect(containerIdentity("https://assets.adobedtm.com/satelliteLib-0123abcd.js")).toEqual({
      manager: "adobe-launch",
      id: "satelliteLib-0123abcd",
    });
    expect(containerIdentity("https://assets.adobedtm.com/extensions/EPabc/AppMeasurement.min.js")).toEqual({
      manager: "adobe-launch",
      id: null,
    });
  });

  it("Segment: the write key", () => {
    expect(containerIdentity("https://cdn.segment.com/analytics.js/v1/wk123ABC/analytics.min.js")).toEqual({
      manager: "segment",
      id: "wk123ABC",
    });
    expect(containerIdentity("https://cdn.segment.com/next-integrations/x.js")).toEqual({
      manager: "segment",
      id: null,
    });
  });

  it("Matomo Tag Manager: the container id, cloud or self-hosted, with or without an environment", () => {
    expect(containerIdentity("https://cdn.matomo.cloud/acme.matomo.cloud/container_AbCdEf12.js")).toEqual({
      manager: "matomo",
      id: "AbCdEf12",
    });
    expect(containerIdentity("https://analytics.example.com/js/container_AbCdEf12_staging.js")).toEqual({
      manager: "matomo",
      id: "AbCdEf12",
    });
  });

  it("Piwik PRO: the container uuid", () => {
    expect(
      containerIdentity("https://acme.containers.piwik.pro/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b.js"),
    ).toEqual({ manager: "piwik-pro", id: "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b" });
  });

  it("Ensighten: client/profile from the Bootstrap path", () => {
    expect(containerIdentity("https://nexus.ensighten.com/acme/prod/Bootstrap.js")).toEqual({
      manager: "ensighten",
      id: "acme/prod",
    });
  });

  it("Commanders Act: site/container from the tc_ file name", () => {
    expect(containerIdentity("https://cdn.tagcommander.com/1234/tc_1234_56.js")).toEqual({
      manager: "commanders-act",
      id: "1234/56",
    });
  });
});

describe("containerIdentity — not a manager", () => {
  it("returns null for vendor scripts, the page, and extension frames", () => {
    for (const url of [
      "https://connect.facebook.net/en_US/fbevents.js",
      "https://www.example.com/article/123",
      "https://www.example.com/assets/app.bundle.js",
      "chrome-extension://abcdef/main-world.js",
      "https://cdn.jsdelivr.net/npm/web-vitals@3/dist/web-vitals.attribution.iife.js",
    ]) {
      expect(containerIdentity(url), url).toBeNull();
      expect(isTagManagerFrame(url), url).toBe(false);
    }
  });

  it("does not match a substring that merely contains a loader's name", () => {
    expect(containerIdentity("https://www.example.com/gtm.js.map")).toBeNull();
    expect(containerIdentity("https://www.example.com/utag/notes.js")).toBeNull();
  });

  it("copes with a URL the platform will not parse, by host", () => {
    // A stack regex can hand over something URL-shaped but not parseable.
    expect(isTagManagerFrame("https://www.googletagmanager.com/gtm.js?id=GTM-ABC%")).toBe(true);
    expect(containerIdentity("not a url at all")).toBeNull();
  });
});

describe("containerKey", () => {
  it("is manager plus id, and empty id for an unnamed manager frame", () => {
    expect(containerKey({ manager: "gtm", id: "GTM-ABC" })).toBe("gtm:GTM-ABC");
    expect(containerKey({ manager: "google", id: null })).toBe("google:");
  });
});

describe("consentModeNeedsDataLayer", () => {
  const none = { present: false, containerIds: [], gtagIds: [], scriptFetched: false };
  const loaded = { ...none, present: true, containerIds: ["GTM-XAPC100"] };

  it("is false on a page with no Google tag", () => {
    expect(consentModeNeedsDataLayer(none)).toBe(false);
  });

  it("is true for a Google tag whose consent store was not read", () => {
    expect(consentModeNeedsDataLayer(loaded)).toBe(true);
    expect(consentModeNeedsDataLayer({ ...loaded, effectiveConsent: null })).toBe(true);
  });

  it("is false once the store was read (apparel-c.example)", () => {
    expect(consentModeNeedsDataLayer({ ...loaded, effectiveConsent: { ad_storage: { default: false } } })).toBe(false);
  });

  it("is false for a store read empty: Consent Mode was observed, nothing set (1.33.0)", () => {
    expect(consentModeNeedsDataLayer({ ...loaded, effectiveConsent: {} })).toBe(false);
  });
});
