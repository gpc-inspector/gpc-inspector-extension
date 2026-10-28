// SPDX-License-Identifier: GPL-3.0-only
/**
 * The summary, as Markdown: what the Overview shows, for pasting into a ticket.
 *
 * Built from the PopupView and from nothing else, so the file and the screen cannot
 * drift: a row the Overview does not show is not here, and a row it shows is here under
 * the same words (the rule `rowsToText` follows for the Requests tab). Every sentence is
 * a message, so the wording lint covers the file as it covers the screen. One line is the
 * exception: the Overview draws the confirmation row only when one was seen, and the file
 * says when none was, or that the scans were still running, so it records that the check
 * ran (PopupView.confirmationScan).
 *
 * It is a different thing from the log, not the same thing in another format.
 * It has no request, no header, no cookie attribute and never a cookie value, and it
 * cannot be replayed through the engine. The footer names the log it was made beside, by
 * scan id and hash, so the two can be matched.
 *
 * Pure: the caller passes the translator, so this runs in a test with no browser.
 */

import {
  LIST_MARK,
  categoryLabelKey,
  firstPartyMarkKey,
  firstPartyRowNames,
  shownName,
  type DecodedField,
  type HintPart,
  type KvLine,
  type KvRow,
  type Notice,
  type PopupView,
  type StringRow,
} from "./view-model.js";
import { STATEMENT_KEYS } from "./notices.js";

export type Translate = (key: string, substitution?: string | readonly string[]) => string;

export interface SummaryFooter {
  readonly extensionVersion: string;
  /** The classification list, as "source version". */
  readonly list: string;
  /** ISO 8601, as the capture recorded it. */
  readonly capturedAt: string;
  readonly scanId: string;
  /** The hash of the masked log sealed from the same capture. */
  readonly recordHash: string;
  readonly limitationsUrl: string;
}

/**
 * Text that came from a page (a cookie name, a domain, a raw string), as inline code, so
 * nothing in it is read as Markdown. A backtick cannot sit inside the span, so it becomes
 * an apostrophe.
 */
function code(text: string): string {
  return `\`${text.replace(/`/g, "'")}\``;
}

/**
 * Text that came from a page and is written in a sentence, where inline code would not
 * read: the characters Markdown acts on are escaped, and a line break becomes a space.
 * A GPP string is whatever the page's API returned, and a page that returned an image or
 * a link must not have it drawn in the ticket the summary is pasted into. A bare URL is
 * left as it is: it is visible as what it is.
 */
function safe(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ").replace(/[\\`*_[\]<>|~]/g, "\\$&");
}

/**
 * The translator with every substitution made safe. The messages themselves are ours; what
 * is put into them may have come from a page.
 */
function escaping(t: Translate): Translate {
  return (key, substitution) =>
    substitution === undefined
      ? t(key)
      : t(key, typeof substitution === "string" ? safe(substitution) : substitution.map(safe));
}

/** One line: a message may hold a line break the screen draws, and a list item cannot. */
function flat(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

function pieces(t: Translate, parts: readonly HintPart[], esc: (text: string) => string = safe): string {
  return parts
    .map((h, i) => {
      const text = "text" in h ? esc(h.text) : t(h.key, h.substitution);
      const glue = i === 0 ? "" : h.glue === "\n" ? " " : (h.glue ?? " ");
      return `${glue}${text}`;
    })
    .join("");
}

const MARK_NAME = "";
const MARK_QUALIFIER = "";

/**
 * One "What this site did" row as list items, nested by `indent`. `t` escapes for Markdown
 * and `translate` does not, for text that goes inside code. A group row's rows nest
 * under it as they do in the popup, and its lines, notes about the whole group, follow
 * them at their level.
 */
function kvRow(t: Translate, translate: Translate, row: KvRow, indent: string): string[] {
  const value = row.valueKey ? t(row.valueKey, row.valueSubstitution) : safe(row.value ?? "");
  // The tag the screen draws after the value, in words, since the file has no hover.
  const shown = row.tag === undefined ? value : translate("summaryValueWithTag", [value, translate(row.tag.key)]);
  const head = `${indent}- ${t(row.labelKey)}: ${shown}`.trimEnd();
  if (row.rows !== undefined) {
    return [head, ...row.rows.flatMap((r) => kvRow(t, translate, r, `${indent}  `)), ...(row.lines ?? []).map((l) => `${indent}  - ${flat(line(t, l))}`)];
  }
  return [
    head,
    ...(row.lines ?? []).map((l) => `${indent}  - ${flat(line(t, l))}`),
    ...(row.hintParts && row.hintParts.length > 0
      ? [
          `${indent}  - ${
            // Inside code nothing is read as Markdown, so nothing is escaped.
            row.hintMono ? code(flat(pieces(translate, row.hintParts, (x) => x))) : flat(pieces(t, row.hintParts))
          }`,
        ]
      : []),
  ];
}

function line(t: Translate, l: KvLine): string {
  if (l.list === undefined) return pieces(t, l.parts);
  const part = l.parts[0];
  const text = part === undefined ? LIST_MARK : "text" in part ? safe(part.text) : t(part.key, part.substitution);
  const [before = "", after = ""] = text.split(LIST_MARK);
  const items = l.list.map((item) => {
    if (item.domain) {
      return item.thisSite ? t("hintCheckedThisSite", MARK_NAME).replace(MARK_NAME, code(item.text)) : code(item.text);
    }
    if (item.categoryKey === undefined) return safe(item.text);
    return t("vendorInCategory", [MARK_NAME, MARK_QUALIFIER])
      .replace(MARK_NAME, safe(item.text))
      .replace(MARK_QUALIFIER, t(item.categoryKey));
  });
  return `${before}${items.join(", ")}${after}`;
}

function notice(t: Translate, n: Notice): string[] {
  const out = [
    `- ${flat(t(n.textKey, n.substitution))}${n.subText ? ` ${code(n.subText)}` : ""}${n.subTextKey ? ` ${flat(t(n.subTextKey))}` : ""}`,
  ];
  for (const pair of n.pairs ?? []) {
    out.push(`  - ${t(pair.labelKey)}: ${t(pair.valueKey, pair.valueSubstitution)}`);
  }
  return out;
}

function decodedField(t: Translate, f: DecodedField, indent: string): string {
  const name = f.labelKey ? t(f.labelKey) : f.labelMono ? code(f.label ?? "") : safe(f.label ?? "");
  const value = f.valueKey ? t(f.valueKey, f.valueSubstitution) : safe(f.value ?? "");
  // The raw value beside the decoded one, as on screen: IAB's integers reverse the
  // intuitive reading, so neither is shown alone.
  return `${indent}- ${name}: ${value}${f.raw ? ` (${code(f.raw)})` : ""}`;
}

function privacyString(t: Translate, row: StringRow): string[] {
  const label = row.qualifierKey ? `${t(row.labelKey)} ${t(row.qualifierKey)}` : t(row.labelKey);
  const out = [`- ${label}: ${row.summary.map((p) => t(p.key, p.substitution)).join(" · ")}`];
  for (const g of row.groups ?? []) {
    const head = [g.labelKey ? t(g.labelKey) : "", g.summaryKey ? t(g.summaryKey) : ""].filter((s) => s !== "");
    if (head.length > 0) out.push(`  - ${head.join(": ")}`);
    if (g.noteKey) out.push(`${head.length > 0 ? "    " : "  "}- ${flat(t(g.noteKey))}`);
    // Under the group's heading when it has one, and under the row when it has none.
    for (const f of g.fields) out.push(decodedField(t, f, head.length > 0 ? "    " : "  "));
  }
  if (row.raw) out.push(`  - ${code(row.raw)}`);
  for (const w of row.wireLines ?? []) {
    out.push(`  - ${flat(t(w.key, w.substitution))}${w.value ? ` ${code(w.value)}` : ""}`);
  }
  if (row.noteKey) out.push(`  - ${flat(t(row.noteKey))}`);
  return out;
}

function names(t: Translate, cookies: readonly string[], functional: readonly string[]): string {
  return cookies
    .map((name) => (functional.includes(name) ? `${code(name)} (${t("cookieListedFunctional")})` : code(name)))
    .join(", ");
}

function category(t: Translate, name: string): string {
  const translated = t(categoryLabelKey(name));
  return translated === "" ? name : translated;
}

function section(out: string[], heading: string, body: readonly string[]): void {
  if (body.length === 0) return;
  out.push("", `## ${heading}`, "", ...body);
}

export function summaryMarkdown(view: PopupView, translate: Translate, footer: SummaryFooter): string {
  // Every message below is filled through this, so no substitution is written unescaped.
  const t = escaping(translate);
  const out: string[] = [`# ${t("summaryTitle", view.site === "" ? t("summaryNoSite") : view.site)}`, ""];

  // An incomplete capture says so before anything it counted.
  const incomplete = view.notices.filter((n) => n.kind === "incomplete");
  for (const n of incomplete) out.push(...notice(t, n));
  if (incomplete.length > 0) out.push("");

  // A page the extension cannot inspect has no signal status, as on screen: its one
  // sentence is all there is.
  if (view.state !== "ineligible") {
    out.push(`${view.status.isSet ? t("signalSetBy") : t("signalNotSet")} (${t(view.status.sourceKey)})`);
  }

  const shown = view.state === "observed" || view.state === "no-ad-tech" || view.state === "signal-off";
  if (!shown) {
    const key =
      view.state === "pending"
        ? "statePending"
        : view.state === "no-data"
          ? "stateNoData"
          : view.state === "needs-reload"
            ? "stateNeedsReload"
            : view.state === "load-failed"
              ? "stateLoadFailed"
              : view.state === "site-access-limited"
                ? "stateSiteAccessLimited"
                : "stateIneligible";
    // needs-reload, load-failed, site-access-limited and ineligible carry their sentence as
    // the incomplete notice above. An ineligible page's sentence depends on the page (stateNewTab).
    const carried = view.state === "ineligible" ? incomplete.length > 0 : incomplete.some((n) => n.textKey === key);
    if (!carried) out.push("", t(key));
  } else {
    const top = view.notices.filter((n) => n.placement === "top" && n.kind !== "incomplete");
    if (top.length > 0) out.push("", ...top.flatMap((n) => notice(t, n)));

    if (view.countCaption !== undefined) {
      const caption = t(view.countCaption.key, view.countCaption.substitution);
      const body: string[] = [];
      if (view.state === "no-ad-tech") {
        body.push(caption);
      } else {
        const off = view.state === "signal-off";
        const count = off ? view.unsignedCookieCount : view.cookieCount;
        body.push(`**${count}** ${caption}`);
        if (!off && view.firstPartyVendorCookies > 0) {
          body.push(
            "",
            view.firstPartyVendorCookies === 1
              ? t("countFirstPartyVendorOne")
              : t("countFirstPartyVendor", String(view.firstPartyVendorCookies)),
          );
        }
        if (count > 0) {
          let group: string | undefined | null = null;
          for (const v of view.countNames) {
            if (v.category !== group) {
              group = v.category;
              body.push("", v.category === undefined ? "" : `${category(t, v.category)}:`, "");
            }
            body.push(`- ${safe(v.name)}: ${names(t, v.cookies, v.functionalCookies)}`);
          }
        }
      }
      section(out, t("summaryCount"), body.filter((l, i, all) => !(l === "" && all[i - 1] === "")));
    }

    // Where the confirmation row would stand, first, when the Overview draws none.
    const confirmation =
      view.confirmationScan === "not-seen"
        ? [`- ${t("summaryConfirmationNotSeen")}`]
        : view.confirmationScan === "checking"
          ? [`- ${t("summaryConfirmationChecking")}`]
          : [];
    section(out, t("sectionSiteDid"), [...confirmation, ...view.siteDid.flatMap((row) => kvRow(t, translate, row, ""))]);

    // The GPC read rows close the section, as on the Overview: under the strings they depend on.
    section(out, t("sectionPrivacyStrings"), [
      ...view.privacyStrings.flatMap((row) => privacyString(t, row)),
      ...view.gpcReads.flatMap((row) => kvRow(t, translate, row, "")),
    ]);

    const vendors: string[] = [];
    if (view.vendors.length === 0) vendors.push(t("vendorsNoneSeen"));
    // Grouped as the popup groups them: by category, and the domains the list names no
    // company for last, under their own heading (1.26.0).
    let group: string | undefined | null = null;
    for (const v of view.vendors) {
      const g = v.group ?? v.category;
      if (g !== group) {
        group = g;
        if (g !== undefined) vendors.push("", `${v.group === "unlisted" ? t("vendorsGroupUnlisted") : category(t, g)}:`, "");
      }
      vendors.push(`- ${safe(v.name)}: ${t("vendorsColumnCheck")}: ${t(v.checkKey)}`);
      vendors.push(
        `  - ${v.cookies.length === 0 ? t(v.emptyKey ?? "vendorNoCookies") : names(t, v.cookies, v.functionalCookies)}`,
      );
      // The panel's "sent back", for the cookies the line above lists: the panel also holds
      // the ones set without the signal and the ones known only from a lost request, which
      // the row does not list. Only what was seen, as in the panel: a cookie not seen going
      // back may simply have had no later request in this capture, so none is named.
      const listed = (c: { unsigned?: true; requestLost?: true }): boolean => c.unsigned !== true && c.requestLost !== true;
      // Each named as the panel names it: with its domain where two cookies share the name.
      const panel = v.detail.cookies ?? [];
      const sentBack = [...new Set(panel.filter((c) => c.sentBack && listed(c)).map((c) => shownName(c, panel)))].sort();
      if (sentBack.length > 0) vendors.push(`  - ${flat(t("summaryCookiesSentBack", MARK_NAME)).replace(MARK_NAME, names(t, sentBack, []))}`);
      // The panel's "removed", for the same cookies: set, counted above, and seen removed again.
      const removed = [...new Set(panel.filter((c) => c.removed !== undefined && listed(c)).map((c) => shownName(c, panel)))].sort();
      if (removed.length > 0) vendors.push(`  - ${flat(t("summaryCookiesRemoved", MARK_NAME)).replace(MARK_NAME, names(t, removed, []))}`);
      if (v.usp) vendors.push(`  - ${t("vendorUspChecked", t(v.usp.valueKey))}`);
      if (v.tcf) vendors.push(`  - ${t(v.tcf.key, v.tcf.substitution)}`);
      if (v.loadedVia) {
        vendors.push(`  - ${v.loadedVia.parts.map((p) => t(p.key, p.substitution)).join(", ")}`);
      }
    }
    section(out, t("sectionVendors"), vendors[0] === "" ? vendors.slice(1) : vendors);

    // One item per container row, as the section draws them: the product and its ids, the
    // state, every cookie written inside it with "(not counted)" after each the count
    // leaves out, and what it loaded (1.25.0). Never a tag's name.
    const containers: string[] = [];
    for (const c of view.containers) {
      const name = c.managerKey ? t(c.managerKey) : safe(c.manager);
      const ids = c.ids.length > 0 ? ` ${c.ids.map(code).join(", ")}` : "";
      containers.push(`- ${name}${ids}: ${t("vendorsColumnCheck")}: ${t(c.checkKey)}`);
      containers.push(
        `  - ${
          c.cookiesPredate
            ? t("containerCookiesPredate")
            : c.cookies.length === 0
              ? t("vendorNoCookies")
              : c.cookies.map((k) => (k.counted ? code(k.name) : `${code(k.name)} (${t("cookieNotCounted")})`)).join(", ")
        }`,
      );
      if (c.loadedVia) containers.push(`  - ${c.loadedVia.parts.map((p) => t(p.key, p.substitution)).join(", ")}`);
      const vendorsLoaded = c.detail.vendorsLoaded.map((v) => t("vendorInCategory", [v.entity, category(t, v.category)]));
      if (vendorsLoaded.length > 0) containers.push(`  - ${t("vdetailVendorsLoaded")}: ${vendorsLoaded.join(", ")}`);
      if (c.detail.domainsLoaded.length > 0) containers.push(`  - ${t("containerAlsoScriptsFrom", c.detail.domainsLoaded.join(", "))}`);
      const containersLoaded = (c.detail.containersLoaded ?? []).map((x) => t("containerLoadedItem", [x.nameKey ? t(x.nameKey) : x.name, x.ids.join(", ")]));
      if (containersLoaded.length > 0) containers.push(`  - ${t("vdetailContainersLoaded")}: ${containersLoaded.join(", ")}`);
    }
    if (view.containersQuiet.length > 0) containers.push(`- ${t("containerQuiet", view.containersQuiet.join(", "))}`);
    section(out, t("sectionTagContainers"), containers);

    // The site's own cookies, as the popup's last section writes them (1.26.0).
    const fp = view.firstParty;
    if (fp !== undefined) {
      const rowNames = firstPartyRowNames(fp);
      // Each list with its cap note after it, as the panel draws them.
      const list = (labelKey: string, shown: readonly string[], observable: boolean, capped: boolean): string[] => [
        `  - ${t(labelKey)}: ${
          shown.length === 0
            ? t(observable ? "valueNoneObserved" : "valueNotObservable")
            : shown
                .map((n) => {
                  const mark = firstPartyMarkKey(fp, n);
                  return mark === null ? code(n) : `${code(n)} (${t(mark)})`;
                })
                .join(", ")
        }`,
        ...(capped ? [`    - ${t("vdetailCookiesCapped")}`] : []),
      ];
      section(out, t("sectionFirstParty"), [
        // The row as a vendor's is written: the domain, then its names.
        `- ${safe(fp.domain)}`,
        `  - ${rowNames.length === 0 ? t("vendorCookiesSetAndRemoved") : names(t, rowNames, [])}`,
        ...list("firstPartyListVendor", fp.vendorWritten, fp.scriptWritesObserved, fp.vendorCapped),
        ...list("firstPartyListSite", fp.site, true, fp.siteCapped),
        ...(fp.probeCookies.length > 0 ? [`  - ${t("vdetailProbeCookies")}: ${fp.probeCookies.map(code).join(", ")}`] : []),
      ]);
    }
  }

  section(out, t("summaryAbout"), [
    `- ${t("summaryCaptured")}: ${safe(footer.capturedAt)}`,
    `- ${t("previewVersion")}: ${safe(footer.extensionVersion)}`,
    `- ${t("previewList")}: ${safe(footer.list)}`,
    `- ${t("summaryScanId")}: ${code(footer.scanId)}`,
    `- ${t("summaryRecordHash")}: ${code(footer.recordHash)}`,
    `- ${t("summaryLimitations")}: ${footer.limitationsUrl}`,
    // The statement that limits reliance, the same words as Settings (About) and the README.
    ...STATEMENT_KEYS.flatMap((key) => ["", t(key)]),
    "",
    t("summaryCompanyNames"),
  ]);

  return `${out.join("\n")}\n`;
}
