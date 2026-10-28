// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import messagesJson from "../public/_locales/en/messages.json" with { type: "json" };
import { summaryMarkdown, type SummaryFooter, type Translate } from "../src/ui/summary-markdown.js";
import type { PopupView } from "../src/ui/view-model.js";
import { STATEMENT_KEYS } from "../src/ui/notices.js";

/** The shipped English messages, substituted the way chrome.i18n does. */
const messages = messagesJson as unknown as Record<string, { message: string; placeholders?: Record<string, { content: string }> }>;

const t: Translate = (key, substitution) => {
  const entry = messages[key];
  if (entry === undefined) return "";
  const subs = substitution === undefined ? [] : typeof substitution === "string" ? [substitution] : substitution;
  let out = entry.message;
  for (const [name, def] of Object.entries(entry.placeholders ?? {})) {
    const index = Number(def.content.replace("$", "")) - 1;
    out = out.replaceAll(`$${name.toUpperCase()}$`, subs[index] ?? "");
  }
  return out;
};

const footer: SummaryFooter = {
  extensionVersion: "1.0.0",
  list: "disconnect 2026-08-14",
  capturedAt: "2026-09-28T10:00:00.000Z",
  scanId: "11111111-2222-3333-4444-555555555555",
  recordHash: "abc123",
  limitationsUrl: "https://example.org/limitations",
};

function view(over: Partial<PopupView> = {}): PopupView {
  return {
    state: "observed",
    site: "example-news.com",
    status: { isSet: true, sourceKey: "sourceThisExtension", accent: true },
    notices: [],
    siteDid: [{ labelKey: "sectionSiteDid", value: "yes" }],
    privacyStrings: [],
    gpcReads: [],
    cookieCount: 2,
    unsignedCookieCount: 0,
    adTechRequests: 12,
    firstPartyVendorCookies: 0,
    countCaption: { key: "summaryCount" },
    vendors: [
      {
        name: "Criteo",
        key: "criteo:advertising",
        cookies: ["cto_bundle", "uid"],
        functionalCookies: ["uid"],
        category: "advertising",
        counted: true,
        checkKey: "vendorGpcNotRead",
        checkHelp: { key: "vendorGpcNotRead" },
        detail: {} as never,
      },
    ],
    countNames: [
      { name: "Criteo", category: "advertising", cookies: ["cto_bundle", "uid"], functionalCookies: ["uid"] },
    ],
    containers: [],
    containersQuiet: [],
    ...over,
  } as PopupView;
}

describe("the saved summary", () => {
  it("names the site, the signal, the count and the vendors under the screen's own words", () => {
    const text = summaryMarkdown(view(), t, footer);
    expect(text).toContain("# GPC Inspector findings for example-news.com");
    expect(text).toContain(messages["signalSetBy"]!.message);
    expect(text).toContain("**2**");
    expect(text).toContain(`## ${messages["sectionVendors"]!.message}`);
    expect(text).toContain(`- Criteo: ${messages["vendorsColumnCheck"]!.message}: ${messages["vendorGpcNotRead"]!.message}`);
  });

  it("writes a name from the page as code, and marks a functional cookie in words", () => {
    const text = summaryMarkdown(view(), t, footer);
    expect(text).toContain("`cto_bundle`");
    expect(text).toContain(`\`uid\` (${messages["cookieListedFunctional"]!.message})`);
  });

  it("names the cookies seen going back, and says nothing of the others", () => {
    const cookie = (name: string, sentBack: boolean) => ({ name, domain: ".criteo.com", sentBack });
    const base = view().vendors[0]!;
    const sent = view({ vendors: [{ ...base, detail: { cookies: [cookie("uid", true), cookie("cto_bundle", false)] } as never }] });
    expect(summaryMarkdown(sent, t, footer)).toContain(`  - ${t("summaryCookiesSentBack", "`uid`")}\n`);
    const none = summaryMarkdown(view({ vendors: [{ ...base, detail: { cookies: [cookie("uid", false)] } as never }] }), t, footer);
    expect(none).not.toContain(t("summaryCookiesSentBack", "").trim());
    // The panel's cookies the row does not list: set without the signal, or known only from
    // a lost request. Not named under a line that never listed them.
    const unlisted = summaryMarkdown(
      view({
        vendors: [{ ...base, detail: { cookies: [{ ...cookie("cto_bundle", true), unsigned: true }, { ...cookie("lost_uid", true), requestLost: true }] } as never }],
      }),
      t,
      footer,
    );
    expect(unlisted).not.toContain(t("summaryCookiesSentBack", "").trim());
  });

  it("names two cookies of one name by their domains, as the panel lists them (#36)", () => {
    // Set for two hosts, and host-only against the whole domain: four cookies, two names.
    const cookie = (name: string, domain: string, sentBack: boolean, removed = false) => ({
      name, domain, sentBack, ...(removed ? { removed: { key: "cookieRemovedAfterSeconds", substitution: ["3"] } } : {}),
    });
    const base = view().vendors[0]!;
    const text = summaryMarkdown(
      view({
        vendors: [{
          ...base,
          cookies: ["sid (.vendor.example)", "sid (b.vendor.example)", "uid (.a.vendor.example)", "uid (.b.vendor.example)"],
          functionalCookies: [],
          detail: { cookies: [
            cookie("sid", ".vendor.example", false, true),
            cookie("sid", "b.vendor.example", true),
            cookie("uid", ".a.vendor.example", true),
            cookie("uid", ".b.vendor.example", true, true),
          ] } as never,
        }],
      }),
      t,
      footer,
    );
    expect(text).toContain(`  - ${t("summaryCookiesSentBack", "`sid (b.vendor.example)`, `uid (.a.vendor.example)`, `uid (.b.vendor.example)`")}\n`);
    expect(text).toContain(`  - ${t("summaryCookiesRemoved", "`sid (.vendor.example)`, `uid (.b.vendor.example)`")}\n`);
  });

  it("names the cookies that were removed again, under the cookies that count them", () => {
    const cookie = (name: string, removed: boolean) => ({ name, domain: ".criteo.com", sentBack: false, ...(removed ? { removed: { key: "cookieRemovedAfterSeconds", substitution: ["3"] } } : {}) });
    const base = view().vendors[0]!;
    const text = summaryMarkdown(view({ vendors: [{ ...base, detail: { cookies: [cookie("KCCH", true), cookie("uid", false)] } as never }] }), t, footer);
    expect(text).toContain(`  - ${t("summaryCookiesRemoved", "`KCCH`")}\n`);
    const none = summaryMarkdown(view({ vendors: [{ ...base, detail: { cookies: [cookie("uid", false)] } as never }] }), t, footer);
    expect(none).not.toContain(t("summaryCookiesRemoved", "").trim());
  });

  it("cannot be broken out of by a cookie name", () => {
    const hostile = view({
      countNames: [{ name: "Criteo", category: "advertising", cookies: ["a`](http://x) **b"], functionalCookies: [] }],
    });
    expect(summaryMarkdown(hostile, t, footer)).toContain("`a'](http://x) **b`");
  });

  it("cannot be made to draw an image or a link by a string the page supplied", () => {
    // A GPP string is whatever the page's API returned. The disagreement notice quotes it.
    const hostile = view({
      notices: [
        {
          kind: "finding",
          placement: "top",
          tone: "finding",
          textKey: "summaryTitle",
          substitution: ["![x](https://evil.example/t.png) [y](https://evil.example)\n# z"],
        },
      ],
      siteDid: [{ labelKey: "sectionSiteDid", value: "<img src=x> *bold* `code`" }],
    });
    const text = summaryMarkdown(hostile, t, footer);
    expect(text).not.toContain("![x](");
    expect(text).not.toContain(" [y](");
    expect(text).toContain("\\[y\\](https://evil.example)");
    // Every one that remains has its backslash before it.
    expect(text).not.toMatch(/(^|[^\\])<img/);
    expect(text).toContain("\\<img src=x\\> \\*bold\\* \\`code\\`");
    // A line break in it cannot start a heading.
    expect(text).not.toMatch(/^# z/m);
  });

  it("nests the GPC read rows under their heading, with the group's notes after them, in the privacy strings section", () => {
    const text = summaryMarkdown(
      view({
        gpcReads: [
          {
            labelKey: "labelCheckedForGpc",
            value: null,
            rows: [
              { labelKey: "labelReadObserved", value: null, lines: [{ parts: [{ text: "Criteo" }] }] },
              { labelKey: "labelReadNotObserved", value: null, valueKey: "valueReadNone" },
            ],
            lines: [{ parts: [{ key: "hintGppStringSilent" }], tone: "hint" }],
          },
        ],
      }),
      t,
      footer,
    );
    expect(text).toContain(
      [
        `## ${messages.sectionPrivacyStrings!.message}`,
        "",
        "- Did vendors read GPC from the page:",
        "  - GPC read:",
        "    - Criteo",
        "  - No read observed: none",
        `  - ${messages.hintGppStringSilent!.message}`,
      ].join("\n"),
    );
  });

  it("ends with the scan id, the log's hash and the statement", () => {
    const text = summaryMarkdown(view(), t, footer);
    expect(text).toContain("`11111111-2222-3333-4444-555555555555`");
    expect(text).toContain("`abc123`");
    const ending = [...STATEMENT_KEYS, "summaryCompanyNames"]
      .map((key) => messages[key]!.message)
      .join("\n\n");
    expect(text.trimEnd().endsWith(ending)).toBe(true);
  });

  it("says an incomplete capture is incomplete before anything it counted", () => {
    const text = summaryMarkdown(
      view({
        notices: [
          { kind: "incomplete", placement: "top", tone: "unavailable", textKey: "stateNoData" },
        ],
      }),
      t,
      footer,
    );
    expect(text.indexOf(messages["stateNoData"]!.message)).toBeLessThan(text.indexOf("**2**"));
    expect(text.indexOf(messages["stateNoData"]!.message)).toBeLessThan(text.indexOf(messages["signalSetBy"]!.message));
  });

  it("gives the state's own sentence, and no sections, for a page with nothing to show", () => {
    const text = summaryMarkdown(view({ state: "ineligible", site: "" }), t, footer);
    expect(text).toContain(messages["stateIneligible"]!.message);
    expect(text).not.toContain(`## ${messages["sectionVendors"]!.message}`);
    expect(text).toContain(`## ${messages["summaryAbout"]!.message}`);
  });

  it("gives a page the extension cannot inspect its one sentence, once, and no signal status", () => {
    for (const key of ["stateNewTab", "stateIneligible"]) {
      const text = summaryMarkdown(
        view({ state: "ineligible", site: "", notices: [{ kind: "incomplete", tone: "unavailable", placement: "top", textKey: key }] }),
        t,
        footer,
      );
      expect(text.split(messages[key]!.message)).toHaveLength(2);
      expect(text).not.toContain(messages["signalSetBy"]!.message);
      expect(text).not.toContain(messages["sourceThisExtension"]!.message);
      // Neither sentence is the other's.
      if (key === "stateNewTab") expect(text).not.toContain(messages["stateIneligible"]!.message);
    }
  });

  it("says a page's load-failed or needs-reload sentence once", () => {
    for (const [state, key] of [["load-failed", "stateLoadFailed"], ["needs-reload", "stateNeedsReload"]] as const) {
      const text = summaryMarkdown(
        view({ state, notices: [{ kind: "incomplete", tone: "unavailable", placement: "top", textKey: key }] }),
        t,
        footer,
      );
      expect(text.split(messages[key]!.message).length - 1).toBe(1);
    }
  });

  it("says once that the browser kept the extension off the site, with how to change it", () => {
    // Site access left the site out: the saved file says why nothing is in it, as the popup
    // does, and never that a reload would fill it in.
    const text = summaryMarkdown(
      view({
        state: "site-access-limited",
        status: { isSet: false, sourceKey: "sourceSiteAccessLimited", accent: false },
        notices: [
          {
            kind: "incomplete",
            tone: "unavailable",
            placement: "top",
            textKey: "stateSiteAccessLimited",
            subTextKey: "stateSiteAccessLimitedHint",
          },
        ],
      }),
      t,
      footer,
    );
    expect(text.split(messages["stateSiteAccessLimited"]!.message).length - 1).toBe(1);
    expect(text).toContain(messages["stateSiteAccessLimitedHint"]!.message);
    expect(text).toContain(messages["sourceSiteAccessLimited"]!.message);
    expect(text).not.toContain(messages["sourceNeedsReload"]!.message);
  });

  it("writes the Tag containers section, one item per row, with what the count leaves out marked", () => {
    const detail = {
      cookies: [], probeCookies: [], refusedWrites: [], consentCalls: [], loadedBy: [],
      vendorsLoaded: [{ entity: "Criteo", category: "advertising" }], domainsLoaded: ["example-cdn.net"],
      containersLoaded: [{ name: "Google tag", nameKey: "containerNameGoogleTag", ids: ["G-8QZ1MK"] }],
      requestsTo: [], scripts: [], insertionsObserved: true, requestsObserved: true,
    };
    const text = summaryMarkdown(
      view({
        containers: [
          {
            key: "container:gtm:GTM-WKX4T9", manager: "Google Tag Manager", ids: ["GTM-WKX4T9"],
            checkKey: "containerTagRead", checkHelp: { key: "containerTagReadHelp" },
            cookies: [{ name: "_gcl_au", counted: true }, { name: "site_author", counted: false }],
            loadedVia: { parts: [{ key: "vendorLoadedBySite" }] },
            detail,
          },
          {
            key: "container:gtag:*", manager: "Google tag", managerKey: "containerNameGoogleTag", ids: ["AW-449201", "G-8QZ1MK"],
            checkKey: "containerNoRead", checkHelp: { key: "containerNoReadHelp" }, cookies: [],
            detail: (({ containersLoaded: _none, ...rest }) => ({ ...rest, vendorsLoaded: [], domainsLoaded: [] }))(detail),
          },
        ],
        containersQuiet: ["GTM-QUIET"],
      }),
      t,
      footer,
    );
    const section = text.slice(text.indexOf(`## ${messages["sectionTagContainers"]!.message}`));
    expect(section).toContain(`- Google Tag Manager \`GTM-WKX4T9\`: Read GPC: ${messages["containerTagRead"]!.message}`);
    expect(section).toContain(`  - \`_gcl_au\`, \`site_author\` (${messages["cookieNotCounted"]!.message})`);
    expect(section).toContain(`  - ${messages["vendorLoadedBySite"]!.message}`);
    expect(section).toContain("  - Vendors loaded: Criteo (Advertising)");
    expect(section).toContain("  - Also scripts from example-cdn.net");
    expect(section).toContain("  - Tag containers loaded: Google tag (G-8QZ1MK)");
    expect(section).toContain(`- Google tag \`AW-449201\`, \`G-8QZ1MK\`: Read GPC: ${messages["containerNoRead"]!.message}`);
    expect(section).toContain(`  - ${messages["vendorNoCookies"]!.message}`);
    expect(section).toContain("- Also on the page, nothing recorded: GTM-QUIET");
    // No "Tag platform" block beside it.
    expect(text).not.toContain("Tag platform");
  });

  it("groups the vendors as the popup does, the domains with no company last under their heading", () => {
    const row = (name: string, over: Record<string, unknown>) => ({
      name, key: name, cookies: [], functionalCookies: [], counted: false, checkKey: "vendorGpcNotRead",
      checkHelp: { key: "vendorGpcNotReadHelp" }, detail: {} as never, ...over,
    });
    const text = summaryMarkdown(
      view({
        vendors: [
          ...view().vendors,
          row("Yahoo!", { category: "unknown", checkKey: "vendorGpcNotApplicable" }),
          row("retailer-d-static.example", { category: "unknown", group: "unlisted", cookies: ["RTD_SESSION"], checkKey: "vendorGpcReadProperty" }),
          row("example-chat.com", { category: "unknown", group: "unlisted", emptyKey: "vendorCookiesSetAndRemoved" }),
          row("example-survey.net", { category: "unknown", group: "unlisted" }),
        ] as never,
      }),
      t,
      footer,
    );
    const section = text.slice(text.indexOf(`## ${messages["sectionVendors"]!.message}`), text.indexOf("## ", text.indexOf(`## ${messages["sectionVendors"]!.message}`) + 3));
    const uncategorized = section.indexOf(`${messages["categoryUncategorized"]!.message}:`);
    const unlisted = section.indexOf(`${messages["vendorsGroupUnlisted"]!.message}:`);
    expect(uncategorized).toBeGreaterThan(0);
    expect(unlisted).toBeGreaterThan(uncategorized);
    expect(section.indexOf("- Yahoo!")).toBeLessThan(unlisted);
    expect(section.slice(unlisted)).toContain(`- retailer-d-static.example: Read GPC: ${messages["vendorGpcReadProperty"]!.message}\n  - \`RTD_SESSION\``);
    expect(section.slice(unlisted)).toContain(`- example-chat.com: Read GPC: ${messages["vendorGpcNotRead"]!.message}\n  - ${messages["vendorCookiesSetAndRemoved"]!.message}`);
    expect(section.slice(unlisted)).toContain(`- example-survey.net: Read GPC: ${messages["vendorGpcNotRead"]!.message}\n  - ${messages["vendorNoCookies"]!.message}`);
    // One heading for the group, however many rows.
    expect(section.split(`${messages["vendorsGroupUnlisted"]!.message}:`)).toHaveLength(2);
  });

  it("writes the wording for a loader, empty rows and a domain-only count", () => {
    const base = view().vendors[0]!;
    const text = summaryMarkdown(
      view({
        vendors: [
          { ...base, loadedVia: { parts: [{ key: "vendorLoadedBySiteScriptOne" }] } },
          { ...base, name: "Kargo", key: "kargo:advertising", cookies: [], functionalCookies: [], emptyKey: "vendorCookiesWithoutGpc" },
          { ...base, name: "example-chat.com", key: "example-chat.com", cookies: [], functionalCookies: [], category: "unknown", counted: false, group: "unlisted", emptyKey: "vendorCookiesSetAndRemoved" },
        ] as never,
        cookieCount: 1,
        countCaption: { key: "countCookiesOne" },
        countNames: [{ name: "tracker.example", category: "advertising", unlisted: true, cookies: ["ts"], functionalCookies: [] }],
      }),
      t,
      footer,
    );
    expect(text).toContain("  - loaded by a site script that also loads 1 other vendor");
    expect(text).toContain("- Kargo: Read GPC: " + messages["vendorGpcNotRead"]!.message + "\n  - cookies set, request without GPC");
    expect(text).toContain("  - cookies written and removed");
    // A count of a domain's cookies alone names no vendors, and keeps "set" and the signal.
    expect(messages["countCookiesOne"]!.message).toMatch(/^third-party cookie set by an advertising or analytics domain while your GPC signal was on$/);
    expect(text).toContain(messages["countCookiesOne"]!.message);
    expect(text).toContain("- tracker.example: `ts`");
  });

  it("writes the First party section, each cap note after its list", () => {
    const firstParty = {
      domain: "example-news.com", vendorWritten: ["RT", "_ga"], site: [], unsigned: ["_ga"], requestLost: [] as string[], scriptWritesObserved: true,
      probeCookies: ["test_cookie"], vendorCapped: true, siteCapped: false,
    };
    const line = messages["countFirstPartyVendor"]!.message.replace("$COUNT$", "2");
    const without = summaryMarkdown(view({ firstPartyVendorCookies: 2 }), t, footer);
    expect(without).toContain(line);
    expect(without).not.toContain(`## ${messages["sectionFirstParty"]!.message}`);

    // The view model gives the headline's line a count of 0 where the section is drawn.
    const text = summaryMarkdown(view({ firstPartyVendorCookies: 0, firstParty }), t, footer);
    expect(text).not.toContain(line);
    const section = text.slice(text.indexOf(`## ${messages["sectionFirstParty"]!.message}`));
    expect(section).toContain("- example-news.com\n  - `RT`, `_ga`\n");
    expect(section).toContain(
      `  - ${messages["firstPartyListVendor"]!.message}: \`RT\`, \`_ga\` (${messages["vdetailCookieUnsigned"]!.message})\n    - ${messages["vdetailCookiesCapped"]!.message}\n  - ${messages["firstPartyListSite"]!.message}: ${messages["valueNoneObserved"]!.message}\n  - ${messages["vdetailProbeCookies"]!.message}: \`test_cookie\``,
    );
    // After Tag containers, before the page's footer.
    expect(text.indexOf(`## ${messages["sectionFirstParty"]!.message}`)).toBeLessThan(text.indexOf(`## ${messages["summaryAbout"]!.message}`));

    // A name known only from a lost request says so (1.26.0).
    const lost = summaryMarkdown(view({ firstParty: { ...firstParty, site: ["late"], requestLost: ["late"] } }), t, footer);
    expect(lost).toContain(`  - ${messages["firstPartyListSite"]!.message}: \`late\` (${messages["requestLost"]!.message})`);

    // Script writes that could not be watched: the empty first list is not an observation.
    const unwatched = summaryMarkdown(view({ firstParty: { ...firstParty, vendorWritten: [], scriptWritesObserved: false } }), t, footer);
    expect(unwatched).toContain(`  - ${messages["firstPartyListVendor"]!.message}: ${messages["valueNotObservable"]!.message}`);
  });

  it("writes Google Consent Mode under Privacy strings, the identifiers as code", () => {
    const text = summaryMarkdown(
      view({
        privacyStrings: [
          {
            id: "gcm", labelKey: "rowConsentMode", flagged: false,
            summary: [{ key: "valueConsentNotSet" }],
            groups: [{ labelKey: "consentGroupTypes", noteKey: "consentNoneSetNote", fields: [{ label: "ad_storage", labelMono: true, valueKey: "valueConsentTypeNotSet", absence: true }] }],
          },
        ],
      }),
      t,
      footer,
    );
    const section = text.slice(text.indexOf(`## ${messages["sectionPrivacyStrings"]!.message}`));
    expect(section).toContain("- Google Consent Mode: not set");
    expect(section).toContain("  - Consent types");
    expect(section).toContain(`    - ${messages["consentNoneSetNote"]!.message}`);
    expect(section).toContain("    - `ad_storage`: not set");
  });

  describe("the confirmation line", () => {
    const siteDid = (text: string): string => {
      const start = text.indexOf(`## ${messages["sectionSiteDid"]!.message}`);
      return text.slice(start, text.indexOf("\n## ", start + 1));
    };

    it("says none was seen when the scans found none, though the Overview draws no row", () => {
      const text = siteDid(summaryMarkdown(view({ siteDid: [], confirmationScan: "not-seen" }), t, footer));
      expect(text).toContain(`- ${messages["summaryConfirmationNotSeen"]!.message}\n`);
    });

    it("says the scans were still running when the file was saved", () => {
      const text = siteDid(summaryMarkdown(view({ siteDid: [], confirmationScan: "checking" }), t, footer));
      expect(text).toContain(`- ${messages["summaryConfirmationChecking"]!.message}\n`);
      expect(text).not.toContain(messages["summaryConfirmationNotSeen"]!.message);
    });

    it("says the check was turned off, and claims nothing about the page", () => {
      const text = siteDid(summaryMarkdown(view({ siteDid: [], confirmationScan: "off" }), t, footer));
      expect(text).toContain(`- ${messages["summaryConfirmationOff"]!.message}\n`);
      expect(text).not.toContain(messages["summaryConfirmationNotSeen"]!.message);
      expect(text).not.toContain(messages["summaryConfirmationChecking"]!.message);
    });

    it("writes a seen confirmation as the row, with the beta tag and the page's words", () => {
      const row = {
        labelKey: "labelConfirmation",
        value: null,
        valueKey: "valueYes",
        tag: { key: "tagBeta", titleKey: "tagBetaHelp" },
        hintParts: [{ key: "hintConfirmationQuote", substitution: ["Opt-Out *Signal* Honored"] }],
      };
      const text = siteDid(summaryMarkdown(view({ siteDid: [row], confirmationScan: "seen" }), t, footer));
      const tagged = t("summaryValueWithTag", [messages["valueYes"]!.message, messages["tagBeta"]!.message]);
      expect(text).toContain(`- ${messages["labelConfirmation"]!.message}: ${tagged}\n`);
      // The page's words, escaped: a page cannot draw Markdown into the file.
      expect(text).toContain(`  - ${t("hintConfirmationQuote", "Opt-Out \\*Signal\\* Honored")}`);
      expect(text).not.toContain(messages["summaryConfirmationNotSeen"]!.message);
      expect(text).not.toContain(messages["summaryConfirmationChecking"]!.message);
    });
  });

  it("leaves no message unresolved", () => {
    // An empty string from the translator is a key that does not exist.
    const seen: string[] = [];
    const strict: Translate = (key, sub) => {
      const out = t(key, sub);
      if (out === "" && !key.startsWith("category_")) seen.push(key);
      return out;
    };
    summaryMarkdown(view(), strict, footer);
    expect(seen).toEqual([]);
  });
});
