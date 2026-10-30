// SPDX-License-Identifier: GPL-3.0-only
/**
 * Popup renderer.
 *
 * Deliberately thin: it asks the service worker for observations, hands them to
 * buildPopupView (pure, tested), and writes the result into the DOM. Any logic that
 * decides WHAT to say belongs in the view model where it can be tested; this file only
 * decides where to put it.
 */

import { evaluate, resolveLoaders } from "@gpc-inspector/engine";
import type { EvidenceBundle, ObservationSet } from "@gpc-inspector/schema";
import { redact, sealBundle, isTallied } from "@gpc-inspector/schema";
import {
  buildPopupView,
  firstPartyMarkKey,
  firstPartyRowNames,
  shownName,
  LIST_MARK,
  nativeFirstRunKey,
  nativeSendSetting,
  type PopupView,
  type DecodedField,
  type LoadedViaLine,
  type HintPart,
  type KvLine,
  type KvListItem,
  type KvRow,
} from "./view-model.js";
import { classifiedInput } from "./view-input.js";
import { summaryMarkdown } from "./summary-markdown.js";
import {
  EXPORT_BUTTONS,
  exportFile,
  openPendingExport,
  type ExportFileKind,
  type ExportMakers,
  type PendingExport,
} from "./export-screen.js";
import { CODE_LICENSE, CODE_LICENSE_URL, COPYRIGHT } from "./notices.js";
import {
  buildReport,
  exportPreview,
  type PreviewLine,
  type Report,
  type ReportInput,
  type Environment,
} from "./feedback.js";
import {
  buildRequestsView,
  requestCount,
  categoryLabelKey,
  rowsToText,
  gpcAbsentKey,
  detailHead,
  scriptWriteNote,
  redirectKey,
  setCookieMark,
  rowCookieNames,
  type RequestFilter,
  type RequestsView,
} from "./requests-view.js";
import { getClassifier, getFunctionalCookies, getOwnerNames } from "../background/classifier.js";
import { PUBLIC_SUFFIX_LIST_VERSION } from "@gpc-inspector/lists";
import {
  accessPatternOf,
  hostOf,
  afterIssueOpened,
  tabAddress,
  followOnActivated,
  isNavigationOf,
  touchesFollowed,
  pageIdentity,
  closesOnPageChange,
  type Followed,
} from "./panel.js";

/**
 * Which host this page is in: the toolbar popup, or the side panel (panel.ts).
 *
 * Marked on the root element here, before any screen is shown, so the stylesheet's panel
 * rules hold from the first frame. Everything that differs by host is either one of those
 * rules or a branch on this constant; the view model and the renderers do not know.
 */
const HOST = hostOf(location.search);
document.documentElement.dataset["host"] = HOST;

const t = (key: string, sub?: string | readonly string[]): string =>
  sub === undefined
    ? chrome.i18n.getMessage(key)
    : chrome.i18n.getMessage(key, Array.isArray(sub) ? [...sub] : [sub as string]);

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element: ${id}`);
  return node as T;
}

/** Fill every [data-i18n] element, and the title attribute of every [data-i18n-title]
 * one. Keeps copy out of the markup and inside _locales. */
function applyStaticI18n(): void {
  // Array.from rather than for..of: the DOM lib target here does not expose an iterator
  // on NodeListOf under these compiler settings.
  for (const node of Array.from(document.querySelectorAll<HTMLElement>("[data-i18n]"))) {
    const key = node.dataset["i18n"];
    if (key) node.textContent = t(key);
  }
  for (const node of Array.from(document.querySelectorAll<HTMLElement>("[data-i18n-title]"))) {
    const key = node.dataset["i18nTitle"];
    if (key) node.title = t(key);
  }
  // The icon buttons' aria-labels are messages too, so a screen reader in any locale reads
  // them in the language of every visible string.
  for (const node of Array.from(document.querySelectorAll<HTMLElement>("[data-i18n-aria-label]"))) {
    const key = node.dataset["i18nAriaLabel"];
    if (key) node.setAttribute("aria-label", t(key));
  }
}

function show(screen: "firstrun" | "overview" | "settings" | "report"): void {
  for (const id of ["firstrun", "overview", "settings", "report"] as const) {
    el(id).hidden = id !== screen;
  }
}

// --- feedback ---

/** The report awaiting confirmation, if any. */
let pendingReport: Report | null = null;
/** Opens the finding report screen for the page. Assigned during load(). */
let reportFinding: () => void = () => {};

function environment(): Environment {
  const list = getClassifier().provenance;
  return {
    extensionVersion: chrome.runtime.getManifest().version,
    browser: navigator.userAgent,
    os: navigator.platform,
    listSource: list.source,
    listVersion: list.version,
    functionalList: `${getFunctionalCookies().provenance.source} ${getFunctionalCookies().provenance.commit.slice(0, 7)}`,
    publicSuffixList: `${PUBLIC_SUFFIX_LIST_VERSION.version} ${PUBLIC_SUFFIX_LIST_VERSION.commit.slice(0, 7)}`,
  };
}

/**
 * Show what a report will disclose, and wait for the person to decide.
 *
 * Nothing is copied and nothing is opened until they press through this screen. A privacy
 * tool that submitted a record of someone's browsing without showing it first would be
 * self-refuting, and the difference between the three report kinds — one carries page data,
 * two carry none — is exactly what this screen has to make legible.
 */
function confirmReport(input: ReportInput): void {
  const report = buildReport(REPO_URL, input);
  pendingReport = report;
  pendingExport = null;
  el("export-footer").hidden = true;
  el("report-footer").hidden = false;

  el("report-title").textContent = t(
    input.kind === "finding"
      ? "reportTitleFinding"
      : input.kind === "bug"
        ? "reportTitleBug"
        : "reportTitleFeature",
  );
  // Bug and feature each say what they carry: a feature request carries the version alone.
  el("report-intro").textContent = t(
    input.kind === "finding" ? "reportIntroFinding" : input.kind === "bug" ? "reportIntroBug" : "reportIntroFeature",
  );
  // Only the finding path has anything left to add here.
  //
  // The bug and feature paths do not repeat reportIntroBug's own closing sentence ("Nothing
  // about the pages you have visited is included"): the preview grid states the same fact
  // as "Page data / none included", and three assertions of one fact on one small screen
  // read as anxiety rather than assurance. The promise is load-bearing and belongs in the
  // intro, said once.
  // The body's note belongs to the download screen. A finding report says what its
  // findings hold in the intro, in the sentence that offers them.
  el("report-note").hidden = true;

  // The offer appears only where there are findings to copy. A bug report has nothing
  // to paste. A finding report is always masked (buildReport refuses a bundle that is
  // not), so the sentence has one wording.
  if (report.clipboard !== null) renderCopyStep();
  else clearCopyStep();

  // The file is offered only when the findings had to be trimmed. On a small page the
  // whole thing pastes and there is nothing to attach.
  const step3 = el("report-step3");
  const trim = report.bundleTrim;
  step3.hidden = !(trim?.trimmed ?? false);
  if (trim?.trimmed) {
    // Says what was left out: requests, the cookie details, or both. When neither was
    // and only the script loading record was cut, it says that and not something else.
    const requestsCut = trim.kept < trim.total;
    el("report-step3-text").textContent = t(
      requestsCut
        ? trim.detailsCut
          ? "reportStep3Both"
          : "reportStep3"
        : trim.detailsCut
          ? "reportStep3Details"
          : "reportStep3Scripts",
      requestsCut ? [String(trim.kept), String(trim.total)] : undefined,
    );
  }

  renderPreview(report.preview);

  show("report");
}

/**
 * Step one of a finding report: a sentence whose link copies the findings. The sentence is
 * one message with a mark where the link goes, so a translation can place it.
 */
function renderCopyStep(): void {
  const host = el("report-step1");
  host.textContent = "";
  const text = t("reportStep1", [MARK_LIST]);
  const at = text.indexOf(MARK_LIST);
  const link = document.createElement("button");
  link.id = "report-copy";
  link.type = "button";
  link.className = "link-btn";
  link.textContent = t("reportStep1Link");
  link.addEventListener("click", () => void copyBundle());
  host.append(at < 0 ? "" : text.slice(0, at), link, at < 0 ? ` ${text}` : text.slice(at + 1));
  el("report-copy-status").textContent = "";
}

function clearCopyStep(): void {
  el("report-step1").textContent = "";
  el("report-copy-status").textContent = "";
}

function renderPreview(lines: readonly PreviewLine[]): void {
  const dl = el("report-preview");
  dl.textContent = "";
  for (const line of lines) {
    const dt = document.createElement("dt");
    dt.textContent = t(line.label);
    const dd = document.createElement("dd");
    if (line.valueKey) {
      // Copy we wrote around the captured data: "none included", and the counts' sentences.
      if (line.absence) dd.className = "absence";
      dd.textContent = t(line.valueKey, line.valueSubstitution);
    } else {
      dd.textContent = line.value;
    }
    dl.append(dt, dd);
  }
}

/**
 * Seal the page's record as a bundle, masked unless the caller is the export screen's
 * button that saves the log with sensitive information.
 *
 * The bundle's findings come from the set the bundle carries, so a third party replaying
 * it gets these findings back (FR-23). Redaction changes nothing the engine reads, which
 * the engine's own tests assert, so they are also the findings on screen.
 */
async function sealEvidence(obs: ObservationSet, masked: boolean): Promise<EvidenceBundle> {
  const classifier = getClassifier();
  const exported = masked ? redact(obs) : obs;
  return sealBundle({
    schemaVersion: obs.schemaVersion,
    // The capture's own id, so every export of one capture names the same scan. A record
    // from a state stored before the id existed gets one here.
    scanId: obs.context.scanId ?? crypto.randomUUID(),
    createdAt: obs.context.capturedAt,
    provenance: {
      schemaVersion: obs.schemaVersion,
      ruleSetVersion: obs.context.extensionVersion,
      ruleSetHash: "",
      listSource: classifier.provenance.source,
      listVersion: classifier.provenance.version,
      listHash: classifier.provenance.hash,
      // Which list produced a "listed as functional" label, beside the list that
      // produced the categories.
      functionalList: getFunctionalCookies().provenance,
      // Which list decided registrable domains, and so party and the domain a finding names.
      publicSuffixList: PUBLIC_SUFFIX_LIST_VERSION,
    },
    redacted: masked ? "redacted" : "unmasked",
    observations: exported,
    findings: evaluate(exported, classifier, getOwnerNames()),
  });
}

/**
 * Hand a file to the browser to save.
 *
 * An object URL rather than chrome.downloads: it needs no additional permission, and this
 * extension should not request one it can avoid. A link cannot tell a saved file from a
 * cancelled save dialog, so the button that called this is never disabled and its label
 * never changes: the same file can always be saved again, and the browser's own download
 * list is what shows whether it was written.
 */
function saveFile(name: string, text: string, type = "application/json"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// --- export ---

/** The export awaiting a press (export-screen.ts). Null while no download screen is open. */
let pendingExport: PendingExport | null = null;

/**
 * Download findings: the same bundle a finding report carries, kept by the reader and
 * sent nowhere. Nothing is saved until a button on the screen is pressed. Three files, and
 * no copy: the summary, the log, and the log with sensitive information, each with its own
 * button so values leave only by a choice made for this export.
 */
function openExport(obs: ObservationSet): void {
  pendingReport = null;
  pendingExport = openPendingExport(obs);

  el("report-title").textContent = t("reportTitleExport");
  el("report-intro").textContent = t("reportIntroExport");
  // What each file holds is the hint under its button.
  el("report-note").hidden = true;
  clearCopyStep();
  el("report-step3").hidden = true;
  el("report-footer").hidden = true;
  el("export-footer").hidden = false;

  // The preview describes the record without values, as two of the three files hold it.
  renderPreview(exportPreview(environment(), pendingExport.obs));

  show("report");
}

/** The files are made from the record as the screen opened, never the one on screen now. */
const exportMakers: ExportMakers = {
  seal: sealEvidence,
  // What the Overview shows, made from the view the Overview is drawn from. Its footer
  // names the hash of the masked log of the same capture.
  summary: (obs, bundle) => {
    const list = getClassifier().provenance;
    return summaryMarkdown(viewOf(obs), t, {
      extensionVersion: chrome.runtime.getManifest().version,
      list: `${list.source} ${list.version}`,
      capturedAt: bundle.createdAt,
      scanId: bundle.scanId,
      recordHash: bundle.bundleHash,
      limitationsUrl: LIMITATIONS_URL,
    });
  },
};

/** The file a button names (EXPORT_BUTTONS): masked, but for the one that says otherwise. */
async function saveExportFile(file: ExportFileKind): Promise<void> {
  const pending = pendingExport;
  if (pending === null) return;
  const out = await exportFile(pending, file, exportMakers);
  saveFile(out.name, out.text, out.type);
}

/**
 * Copy the bundle, on an explicit press.
 *
 * Its own step, and both outcomes are visible. Copied silently as part of submitting, the
 * person would not know it had happened, and a clipboard write that did not succeed would
 * be invisible: they would arrive at an issue asking for a bundle with nothing to paste.
 *
 * The bundle goes to the clipboard rather than into the URL: GitHub's prefill caps out
 * around 8KB and a bundle from a heavy page is far past that, but the better reason is that
 * a URL ends up in browser history and server logs and a clipboard does not.
 */
async function copyBundle(): Promise<void> {
  const report = pendingReport;
  if (report === null || report.clipboard === null) return;

  // Beside the sentence, which stays as it is: the link can be pressed again.
  const status = el("report-copy-status");
  try {
    await navigator.clipboard.writeText(report.clipboard);
    status.textContent = t("reportCopied");
  } catch {
    status.textContent = t("reportCopyFailed");
  }
}

/**
 * Save the full bundle as a file, for attaching to the issue.
 *
 * GitHub caps an issue body at 65,536 characters, and a bundle from a 630-request page is
 * roughly 400,000 — so the pasted copy is trimmed to the observations behind the findings.
 * Attachments are not subject to that limit, so the complete artifact travels this way and
 * nothing is lost.
 *
 */
function downloadFullBundle(): void {
  const report = pendingReport;
  if (report === null || report.fullBundle === null || report.fileName === null) return;

  saveFile(report.fileName, report.fullBundle);
}

async function submitPendingReport(): Promise<void> {
  const report = pendingReport;
  if (report === null) return;
  await chrome.tabs.create({ url: report.url });
  pendingReport = null;
  if (afterIssueOpened(HOST) === "close") window.close();
  else show("overview");
}

/**
 * The one expand glyph, for all four expandable surfaces.
 *
 * One glyph on one side for every expandable row. Rotation lives in CSS, keyed off
 * `aria-expanded`, so the open state cannot be announced one way and drawn another.
 */
const CARET = "›";

const ICON_INFO = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/></svg>`;
const ICON_CHECK = `<svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>`;
/** A server, in outline: the mark after a cookie name that is listed as functional. */
const ICON_FUNCTIONAL = `<svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><path d="M6 7h.01M6 17h.01"/></svg>`;

/**
 * The mark after a counted cookie name that is on the list of functional cookie names
 * (load balancers, bot protection). One hover text wherever the label appears, the
 * browser's own tooltip as everywhere else in the popup, with no help cursor. It is the
 * icon's accessible name too, since a screen reader does not reliably read a title. The
 * name keeps its color: the cookie is still counted, and the label says why it may matter
 * less, never that it does not.
 */
function functionalMark(): HTMLElement {
  const mark = document.createElement("span");
  mark.className = "fmark";
  mark.innerHTML = ICON_FUNCTIONAL;
  const help = t("cookieListedFunctionalHelp");
  mark.setAttribute("role", "img");
  mark.setAttribute("aria-label", help);
  mark.title = help;
  return mark;
}

/** The words of the label, where there is room for them: a vendor row, and its panel. */
function functionalWords(): HTMLElement {
  const words = document.createElement("span");
  words.className = "fwords";
  words.textContent = t("cookieListedFunctional");
  words.title = t("cookieListedFunctionalHelp");
  return words;
}

/**
 * Cookie names, comma-separated, each listed one followed by its mark and, where `words`
 * says so, by the words of the label.
 */
function appendMarkedNames(host: HTMLElement, names: readonly string[], functional: readonly string[], words: boolean): void {
  names.forEach((name, i) => {
    if (i > 0) host.append(", ");
    const span = document.createElement("span");
    span.textContent = name;
    host.appendChild(span);
    if (!functional.includes(name)) return;
    host.appendChild(functionalMark());
    if (words) host.append(" ", functionalWords());
  });
}

function renderNotices(view: PopupView): void {
  const host = el("notices");
  host.textContent = "";
  for (const n of view.notices) {
    const div = document.createElement("div");
    div.className = `notice ${n.tone === "neutral" ? "" : n.tone}`.trim();
    const icon = n.kind === "confirmed" ? ICON_CHECK : ICON_INFO;
    const body = document.createElement("div");
    // A flex child that can shrink. Without min-width:0 a long unbroken substitution — a
    // raw privacy string in a disagree finding — pushes the notice past the popup width.
    body.className = "notice-body";
    body.textContent = t(n.textKey, n.substitution);
    if (n.subText) {
      const sub = document.createElement("span");
      sub.className = "notice-sub mono";
      sub.textContent = n.subText;
      body.appendChild(sub);
    }
    // A second sentence of its own, such as what to change to make the notice go away.
    if (n.subTextKey) {
      const sub = document.createElement("span");
      sub.className = "notice-sub";
      sub.textContent = t(n.subTextKey);
      body.appendChild(sub);
    }
    // Two named values side by side, for a notice whose point is that they differ.
    if (n.pairs) {
      const table = document.createElement("div");
      table.className = "notice-kv";
      for (const pair of n.pairs) {
        const k = document.createElement("span");
        k.textContent = t(pair.labelKey);
        const v = document.createElement("span");
        v.className = "mono";
        v.textContent = t(pair.valueKey, pair.valueSubstitution);
        table.append(k, v);
      }
      body.appendChild(table);
    }
    div.innerHTML = icon;
    div.appendChild(body);
    host.appendChild(div);
  }
}

/**
 * Append hint pieces to an element, each joined by its own glue: a space unless it says
 * otherwise, and "\n" starts a new line. See HintPart.
 */
function appendPieces(host: HTMLElement, parts: readonly HintPart[]): void {
  parts.forEach((h, i) => {
    if (i > 0) {
      const glue = h.glue ?? " ";
      if (glue === "\n") host.appendChild(document.createElement("br"));
      else if (glue !== "") host.appendChild(document.createTextNode(glue));
    }
    host.appendChild(document.createTextNode("text" in h ? h.text : t(h.key, h.substitution)));
  });
}

/** Marks that stand for a name and its qualifier inside the pattern that joins them. */
const MARK_NAME = "\uE003";
const MARK_QUALIFIER = "\uE004";

/**
 * One name on a list-shaped line, kept on one line: a company with its category in the
 * hint color after it, or a domain in the monospace face. The pattern that joins a name to
 * its category, and the one that marks the site's own domain, are messages, so a
 * translator can reorder either.
 */
function listItemNode(item: KvListItem): HTMLElement {
  const node = document.createElement("span");
  node.className = "kv-item";
  if (item.domain) {
    const domain = document.createElement("span");
    domain.className = "mono";
    domain.textContent = item.text;
    if (!item.thisSite) {
      node.appendChild(domain);
      return node;
    }
    const [before = "", after = ""] = t("hintCheckedThisSite", MARK_NAME).split(MARK_NAME);
    node.append(before, domain, after);
    return node;
  }
  if (item.categoryKey === undefined) {
    node.textContent = item.text;
    return node;
  }
  const category = t(item.categoryKey);
  const pattern = t("vendorInCategory", [MARK_NAME, MARK_QUALIFIER]);
  const n = pattern.indexOf(MARK_NAME);
  const q = pattern.indexOf(MARK_QUALIFIER);
  if (n === -1 || q < n) {
    // A translation that leads with the category: one run of text, in the line's color.
    node.textContent = pattern.replace(MARK_NAME, item.text).replace(MARK_QUALIFIER, category);
    return node;
  }
  // Everything after the name but the space before it is the qualifier, brackets included.
  const between = pattern.slice(n + 1, q);
  const space = between.length - between.trimStart().length;
  const qualifier = document.createElement("span");
  qualifier.className = "kv-item-category";
  qualifier.textContent = `${between.slice(space)}${category}${pattern.slice(q + 1)}`;
  node.append(`${pattern.slice(0, n)}${item.text}${between.slice(0, space)}`, qualifier);
  return node;
}

/** A line of a list-shaped row: its pieces, with its list drawn where the mark stands. */
function appendLine(host: HTMLElement, line: KvLine): void {
  if (line.list === undefined) {
    appendPieces(host, line.parts);
    return;
  }
  const part = line.parts[0];
  const text = part === undefined ? LIST_MARK : "text" in part ? part.text : t(part.key, part.substitution);
  const [before = "", after = ""] = text.split(LIST_MARK);
  host.append(before);
  line.list.forEach((item, i) => {
    if (i > 0) host.append(", ");
    host.appendChild(listItemNode(item));
  });
  host.append(after);
}

function renderSiteDid(view: PopupView): void {
  const dl = el("site-did");
  dl.textContent = "";
  appendKvRows(dl, view.siteDid);
}

/** The GPC read group, under the privacy strings it depends on. */
function renderGpcReads(view: PopupView): void {
  const dl = el("gpc-reads");
  dl.textContent = "";
  appendKvRows(dl, view.gpcReads);
}

function appendKvRows(dl: HTMLElement, rows: readonly KvRow[]): void {
  for (const row of rows) {
    const dt = document.createElement("dt");
    dt.textContent = t(row.labelKey);
    const dd = document.createElement("dd");

    dd.textContent = row.valueKey
      ? t(row.valueKey, row.valueSubstitution)
      : (row.value ?? "");
    if (row.tag !== undefined) {
      const tag = document.createElement("span");
      tag.className = "kv-tag";
      tag.textContent = t(row.tag.key);
      tag.title = t(row.tag.titleKey);
      dd.append(" ", tag);
    }

    dl.appendChild(dt);
    dl.appendChild(dd);

    // A group row: its rows nest under the label in a list of their own, indented behind a
    // rule, and its lines are notes about the whole group, at the bottom of it. See
    // KvRow.rows.
    if (row.rows !== undefined) {
      const group = document.createElement("dd");
      group.className = "kv-group";
      const inner = document.createElement("dl");
      inner.className = "kv";
      appendKvRows(inner, row.rows);
      for (const line of row.lines ?? []) {
        const note = document.createElement("dd");
        note.className = line.tone === "hint" ? "kv-line kv-group-note hint" : "kv-line kv-group-note";
        appendLine(note, line);
        inner.appendChild(note);
      }
      group.appendChild(inner);
      dl.appendChild(group);
      continue;
    }

    // A list-shaped row: its lines follow the label, left-aligned and indented, each
    // spanning the grid. See KvRow.lines.
    for (const line of row.lines ?? []) {
      const el = document.createElement("dd");
      el.className = line.tone === "hint" ? "kv-line hint" : "kv-line";
      appendLine(el, line);
      dl.appendChild(el);
    }

    // The hint is its own full-width grid row under the pair, not a line inside the value
    // cell. The value column is whatever the label column leaves (about 190px), which would
    // wrap a well-known URL mid-path and spread a two-sentence hint over four lines.
    if (row.hintParts && row.hintParts.length > 0) {
      const hint = document.createElement("dd");
      hint.className = row.hintMono ? "kv-hint mono" : "kv-hint";
      appendPieces(hint, row.hintParts);
      if (row.hintTitle !== undefined) hint.title = row.hintTitle;
      dl.appendChild(hint);
    }
  }
}

/**
 * Which privacy-string rows the reader has opened.
 *
 * Module-level, and load-bearing: the popup re-renders every time fresh observations
 * arrive, and a <details> rebuilt from scratch loses its open attribute — so a row snaps
 * shut under the reader's cursor mid-sentence. Same class of defect as a list reordering
 * while it is being read. Keyed by StringRow.id rather than by DOM position so it survives
 * rows changing order or count.
 */
const openStringRows = new Set<string>();

/** One decoded line: plain-language field, decoded meaning, raw encoded value. */
function renderDecodedField(host: HTMLElement, f: DecodedField): void {
  const name = document.createElement("span");
  // An identifier (`ad_storage`) keeps the monospace face and is never translated.
  name.className = f.labelMono ? "sr-fn mono" : "sr-fn";
  name.textContent = f.labelKey ? t(f.labelKey) : (f.label ?? "");

  const value = document.createElement("span");
  value.className = f.emphasis ? "sr-fv em" : f.absence ? "sr-fv absence" : "sr-fv";
  value.textContent = f.valueKey ? t(f.valueKey, f.valueSubstitution) : (f.value ?? "");

  const raw = document.createElement("span");
  raw.className = "sr-fr";
  raw.textContent = f.raw ?? "";

  host.append(name, value, raw);
}

function renderPrivacyStrings(view: PopupView): void {
  const host = el("privacy-strings");
  host.textContent = "";

  for (const row of view.privacyStrings) {
    const details = document.createElement("details");
    const expandable = row.groups !== undefined || row.raw !== undefined || row.sectionLine !== undefined || (row.wireLines?.length ?? 0) > 0;
    details.className = expandable ? "srow-string" : "srow-string static";
    // Restore what the reader had open, then keep the set in step with what they do next.
    if (expandable && openStringRows.has(row.id)) details.open = true;

    const summary = document.createElement("summary");
    summary.dataset["focusKey"] = `string:${row.id}`;
    const label = document.createElement("span");
    label.className = "sr-k";
    label.textContent = t(row.labelKey);
    if (row.qualifierKey) {
      const q = document.createElement("span");
      q.className = "sr-q";
      q.textContent = ` ${t(row.qualifierKey)}`;
      label.appendChild(q);
    }

    const value = document.createElement("span");
    value.className = row.flagged ? "sr-v flagged" : "sr-v";
    // Parts joined rather than one string: the GPP row is two independent facts (what the
    // GPC field says, and what the opt-out fields say) and each needs its own key so a
    // translator can order the sentence for their language.
    value.textContent = row.summary
      .map((p) => t(p.key, p.substitution))
      .join(" · ");

    const caret = document.createElement("span");
    caret.className = "sr-caret";
    caret.textContent = CARET;
    caret.setAttribute("aria-hidden", "true");

    summary.append(label, value, caret);
    details.appendChild(summary);

    if (expandable) {
      const body = document.createElement("div");
      body.className = "sr-exp";

      // Google Consent Mode has no API to name and opens on its first group (1.25.0).
      if (row.nameKey !== undefined) {
        const head = document.createElement("div");
        head.className = "sr-head";
        const name = document.createElement("span");
        name.textContent = t(row.nameKey);
        // "Global Privacy Platform" is prose and the heading is not monospace; `__gpp`
        // beside it genuinely is an identifier, so only that keeps mono (DESIGN.md §5).
        const api = document.createElement("span");
        api.className = "sr-api";
        api.textContent = row.api ?? "";
        head.append(name, api);
        body.appendChild(head);
      }

      // Which sections of the GPP string apply, before anything decoded from them.
      if (row.sectionLine) {
        const line = document.createElement("span");
        line.className = "sr-note";
        line.textContent = t(row.sectionLine.key, row.sectionLine.substitution);
        body.appendChild(line);
      }

      // TCF's scope line, immediately under the name: it is a GDPR mechanism with no
      // obligation relationship to GPC, and must never read as a response to it.
      if (row.noteKey) {
        const note = document.createElement("span");
        note.className = "sr-note";
        note.textContent = t(row.noteKey);
        body.appendChild(note);
      }

      for (const group of row.groups ?? []) {
        if (group.labelKey) {
          const gh = document.createElement("div");
          gh.className = "sr-head";
          const gl = document.createElement("span");
          gl.textContent = t(group.labelKey);
          const gs = document.createElement("span");
          // "none recorded" beside the Opt-out heading: answers "GPC went in, and then
          // what?" as a group summary rather than as another sentence.
          gs.textContent = group.summaryKey ? t(group.summaryKey) : "";
          gh.append(gl, gs);
          body.appendChild(gh);
        }
        if (group.noteKey) {
          const note = document.createElement("span");
          note.className = "sr-note";
          note.textContent = t(group.noteKey);
          body.appendChild(note);
        }
        const grid = document.createElement("div");
        grid.className = "sr-fields";
        for (const f of group.fields) renderDecodedField(grid, f);
        body.appendChild(grid);
      }

      if (row.raw !== undefined) {
        const rawRow = document.createElement("div");
        rawRow.className = "sr-raw";
        const rl = document.createElement("span");
        rl.className = "rl";
        rl.textContent = t("labelRawString");
        const rv = document.createElement("span");
        rv.className = "rv";
        rv.textContent = row.raw;
        rawRow.append(rl, rv);
        if (row.linkUrl && row.linkTextKey) {
          const link = document.createElement("a");
          link.className = "pop-link label-link";
          link.href = row.linkUrl;
          link.target = "_blank";
          link.rel = "noreferrer";
          link.textContent = t(row.linkTextKey);
          rawRow.appendChild(link);
        }
        body.appendChild(rawRow);
      }

      // What requests carried that is not the page's string: who sent it, and the value as
      // sent. textContent throughout: the value is whatever a vendor put in a URL.
      for (const line of row.wireLines ?? []) {
        const wire = document.createElement("div");
        wire.className = "sr-wire";
        wire.textContent = t(line.key, line.substitution);
        if (line.value !== undefined) {
          const v = document.createElement("span");
          v.className = "wv";
          v.textContent = line.value;
          wire.appendChild(v);
        }
        if (line.title) wire.title = line.title;
        body.appendChild(wire);
      }

      details.appendChild(body);
      details.addEventListener("toggle", () => {
        if (details.open) openStringRows.add(row.id);
        else openStringRows.delete(row.id);
      });
    }

    host.appendChild(details);
  }
}

function renderCount(view: PopupView): void {
  const block = el("count-block");
  const number = el("count-number");
  const caption = el("count-caption");
  const detail = el("count-detail");
  const names = el("count-names");
  names.textContent = "";

  // Which sentence is the view model's to say (countCaption); none means no count is shown.
  if (view.countCaption === undefined) {
    block.hidden = true;
    return;
  }
  block.hidden = false;
  caption.textContent = t(view.countCaption.key, view.countCaption.substitution);

  // A site with no ad tech is not "clean": there was nothing to observe a response to.
  // It shows a dash and is excluded from every total (5.6), never a reassuring zero.
  if (view.state === "no-ad-tech") {
    number.textContent = "\u2014";
    number.classList.remove("is-count");
    // No second line. "Excluded from totals" under the dash would be a subjectless fragment
    // the reader can do nothing with, and the dash plus one sentence already says there is
    // no number and why. The page still contributes to no total (5.6 row 1); it does not
    // say so twice.
    detail.textContent = "";
    return;
  }

  // With sending off the headline is the unsigned count: cookies set on requests that
  // did not carry the signal, which is the baseline a reader compares the signed count
  // against. Same block, same shape, its own caption, so the two visits line up.
  const off = view.state === "signal-off";
  const count = off ? view.unsignedCookieCount : view.cookieCount;

  number.textContent = String(count);
  // A counted zero takes the attention color too: no cookies with vendors present is a
  // result worth reading first. The no-ad-tech dash is not a count and stays neutral.
  number.classList.add("is-count");

  // No line splitting the cookies by kind, and none for cookies set on requests that did
  // not carry the signal. The caption and the labels beside the names say which kind. The
  // second would report on this extension's own sending, never on what the site did, and on
  // a normal load it would be empty; the Requests tab marks those requests "GPC not sent".
  const parts: string[] = [];
  // First-party cookies written by vendor scripts are a real fact and a DIFFERENT one:
  // the vendor's code ran, but nothing crossed a site boundary in that act. Supporting
  // detail, never folded into the headline number. Counted on signed requests only, so it
  // is not shown under the unsigned headline.
  // 0 where the First-party cookies section lists them by name (1.26.0).
  if (!off && view.firstPartyVendorCookies > 0) {
    parts.push(
      view.firstPartyVendorCookies === 1
        ? t("countFirstPartyVendorOne")
        : t("countFirstPartyVendor", String(view.firstPartyVendorCookies)),
    );
  }
  // No count of requests under a counted zero. The vendor list under it, with "no cookies
  // set" on each row, says who was contacted, so the zero does not read as an absence, and
  // a request count grows with time on the page.
  // One fact per line. Joined with a dot, three unrelated numbers read as one broken sum.
  detail.textContent = "";
  for (const part of parts) {
    const line = document.createElement("span");
    line.className = "count-detail-line";
    line.textContent = part;
    detail.appendChild(line);
  }

  // The names, in the headline itself: each vendor with the cookies it set, under the label
  // of its kind. The labels stand in a column of their own and each vendor starts a line:
  // run together, a wrapped line would begin wherever the last vendor ended, and the second
  // kind would be hard to find. Vendor in the body face and cookie names in mono, the same
  // pairing as a vendor row, so the two read as one fact at two sizes.
  if (count === 0) return;
  const labeled = view.countNames.some((v) => v.category !== undefined);
  names.classList.toggle("count-names-plain", !labeled);
  let rows: HTMLElement | null = null;
  let category: string | undefined | null = null;
  for (const v of view.countNames) {
    if (rows === null || v.category !== category) {
      category = v.category;
      if (labeled) {
        const label = document.createElement("div");
        label.className = "count-names-label";
        label.textContent = v.category === undefined ? "" : categoryLabel(v.category);
        names.appendChild(label);
      }
      rows = document.createElement("div");
      rows.className = "count-names-rows";
      names.appendChild(rows);
    }
    const row = document.createElement("div");
    row.className = "count-names-row";
    const cookies = document.createElement("span");
    cookies.className = "count-name-cookies";
    // The mark alone under the count: the words are on the vendor's row, below.
    appendMarkedNames(cookies, v.cookies, v.functionalCookies, false);
    row.append(`${v.name} `, cookies);
    rows.appendChild(row);
  }
}

/**
 * The classification list's credit, the last line of the Overview.
 *
 * CC BY-NC-SA 4.0 makes naming the list's source a condition of using it, and a credit
 * nobody can read does not meet that, so it is never hidden until hovered. This line stays
 * visible, names the list, its version and its license, and links the list and the
 * license. It comes after the findings and the tag-platform notes because provenance
 * follows the numbers it describes (DESIGN.md §2), and a link there does not pull the eye
 * before them. The full statement is in Settings under Credits.
 *
 * One translatable sentence, with the two links marked by placeholders so a translator can
 * reorder it. The markers are private-use characters, which no message contains.
 */
const MARK_LIST = "\uE000";
const MARK_LICENSE = "\uE001";
function renderListCredit(): void {
  const host = el("list-credit");
  host.textContent = "";
  const list = getClassifier().provenance;
  const text = t("listCredit", [MARK_LIST, list.version, MARK_LICENSE]);
  const marks = /[\uE000\uE001]/g;
  let last = 0;
  for (let m = marks.exec(text); m !== null; m = marks.exec(text)) {
    host.append(text.slice(last, m.index));
    const a = document.createElement("a");
    const isList = m[0] === MARK_LIST;
    a.href = isList ? LIST_SOURCE_URL : LIST_LICENSE_URL;
    a.textContent = t(isList ? "listCreditListName" : "listCreditLicenseName");
    a.target = "_blank";
    a.rel = "noreferrer";
    host.appendChild(a);
    last = m.index + 1;
  }
  host.append(text.slice(last));
  host.hidden = false;
}

function renderVendors(view: PopupView): void {
  const host = el("vendors");
  host.textContent = "";
  const headCheck = el("vendors-check-head");
  headCheck.textContent = "";

  if (view.vendors.length === 0) {
    const div = document.createElement("div");
    div.className = "empty absence";
    div.textContent = t("vendorsNoneSeen");
    host.appendChild(div);
    return;
  }

  // One heading, over the column that needs one, on the VENDORS line itself. In an
  // unlabeled column a reader would have to infer what "Not applicable" answers from the
  // phrase itself; naming it is what lets each value stay short.
  headCheck.textContent = t("vendorsColumnCheck");
  // The one place the Sec-GPC header fact is stated.
  headCheck.title = t("vendorsColumnCheckTitle");

  // A label over each category's rows, in Disconnect's name for it. The heading says
  // "Vendors" and the labels say which kind. No note and no rule before the categories the
  // headline does not count: the labels do the separating, and the color of the cookie
  // names says which are counted. Rows with no category, from a capture that cannot say,
  // come first and have no label. The domains the list names no company for come last,
  // under a heading of their own (1.26.0).
  let group: string | undefined | null = null;
  for (const v of view.vendors) {
    const g = v.group ?? v.category;
    if (g !== group) {
      group = g;
      if (g !== undefined) {
        const label = document.createElement("div");
        label.className = "vgroup-label";
        label.textContent = v.group === "unlisted" ? t("vendorsGroupUnlisted") : categoryLabel(g);
        host.appendChild(label);
      }
    }
    const row = document.createElement("div");
    // A row the headline does not count draws its cookie names in the secondary color: the
    // attention color is for what the number counts (DESIGN.md §2).
    row.className = v.counted ? "vrow" : "vrow vrow-other";

    // No avatar. It would hold the first letter of the word next to it, cost 36px of a
    // 420px panel on the row where the name and the cookie list already compete, and be the
    // most Disconnect-like element in a UI that consumes Disconnect's list and must not imply
    // their endorsement, nor that this tool blocks anything (DESIGN.md §9).

    // Two lines. On one line a four-cookie list squeezed the vendor name to "G…", "L…",
    // "M" — the single most important word in the row, truncated to nothing, while cookie
    // names nobody recognizes took the space.
    const body = document.createElement("div");
    body.className = "vbody";

    const top = document.createElement("div");
    top.className = "vtop";

    const name = document.createElement("span");
    // A domain wraps before it is cut, as a container's id does: it is the row's only name.
    name.className = v.group === "unlisted" ? "vname vname-wrap" : "vname";
    name.textContent = v.name;

    // Not a pill. .tag's background is --card, the color of the section behind it, so this
    // would render as a chip with no chip; and a chip reads as a status badge when what
    // this says is an observation (DESIGN.md §9).
    //
    // A plain title, with NO .has-hint marker. The dotted underline that advertises a hover
    // is an affordance cue, and this sits inside a row that is itself a button. Anything
    // that looks interactive inside a clickable row competes with the row's own affordance.
    //
    // Discoverability lives where it belongs instead: the column heading gives every value
    // its subject, and the expanded panel opens with the explanation in full.
    const check = document.createElement("span");
    check.className = "vcheck";
    check.textContent = t(v.checkKey);
    check.title = checkHelpText(v);

    top.append(name, check);

    const cookies = document.createElement("div");
    if (v.cookies.length === 0) {
      // "Contacted, set nothing" is a real observation and arguably the more interesting
      // one — it is what a vendor honoring the signal looks like. A blank line here reads
      // as missing data, which is the mistake this product exists to avoid making. A row
      // whose only cookies were set and removed says so (1.26.0): something was set.
      cookies.className = "vcookie absence";
      cookies.textContent = t(v.emptyKey ?? "vendorNoCookies");
    } else {
      cookies.className = "vcookie";
      // Every name, uncapped. The headline above says how many cookies and how many
      // vendors; this line is where a reader finds out which, and a "+3" makes them open
      // the row to finish counting.
      appendMarkedNames(cookies, v.cookies, v.functionalCookies, true);
    }

    body.append(top, cookies);

    // USP/TCF secondary lines: only when that specific API was called and attributed to
    // THIS vendor — never rendered as "not checked" when absent, just omitted (PRD).
    // Same decode vocabulary as the page-level rows, so a reader never has to learn a
    // second phrasing for the identical fact.
    if (v.usp) {
      const uspLine = document.createElement("div");
      uspLine.className = "vsecondary";
      uspLine.textContent = t("vendorUspChecked", t(v.usp.valueKey));
      body.appendChild(uspLine);
    }
    if (v.tcf) {
      const tcfLine = document.createElement("div");
      tcfLine.className = "vsecondary";
      tcfLine.textContent = t(v.tcf.key, v.tcf.substitution);
      // No decoder link. The TCF row under PRIVACY STRINGS carries it once for the page; here
      // it would be a second link to the same place, inside a row that is itself a button.
      body.appendChild(tcfLine);
    }
    // Who loaded this vendor's script, when the insertion records could tell. Same
    // treatment as the USP and TCF lines: a fact under the row, in the row's own voice.
    if (v.loadedVia) {
      const line = document.createElement("div");
      line.className = "vsecondary";
      line.textContent = loadedViaText(v.loadedVia);
      body.appendChild(line);
    }

    // A caret rather than a bare click target: an expandable row that looks identical to a
    // static one is a control nobody finds. One glyph on one side across all four
    // expandable surfaces; rotation is CSS off aria-expanded, so the state the assistive
    // tech reads and the state the eye reads cannot drift apart (DESIGN.md §8).
    const caret = document.createElement("span");
    caret.className = "caret";
    caret.textContent = CARET;
    caret.setAttribute("aria-hidden", "true");

    row.append(body, caret);
    // Announced as expandable, and reachable by keyboard: the row is a div, so without
    // these it is invisible to anything but a mouse.
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    row.dataset["focusKey"] = `vendor:${v.key}`;
    row.setAttribute("aria-expanded", String(expandedVendors.has(v.key)));
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        row.click();
      }
    });
    row.addEventListener("click", () => {
      if (expandedVendors.has(v.key)) expandedVendors.delete(v.key);
      else expandedVendors.add(v.key);
      renderVendors(view);
    });
    host.appendChild(row);

    if (expandedVendors.has(v.key)) host.appendChild(vendorDetailNode(v));
  }
}

/**
 * The expanded vendor panel.
 *
 * Everything here is an artifact the reader can check: which hostnames were seen, how many
 * requests carried the signal, each cookie with the attributes that change what it can do,
 * and where the entity rollup came from. That last line matters — most "your tool is wrong"
 * reports are really "your list is wrong", and naming a dated third-party source turns an
 * argument with us into an edit against it.
 */
function vendorDetailNode(v: PopupView["vendors"][number]): HTMLElement {
  const box = document.createElement("div");
  box.className = v.counted ? "vdetail" : "vdetail vdetail-other";

  const section = (labelKey: string, body: HTMLElement | string, hintKey?: string): void => {
    const label = document.createElement("div");
    label.className = "vdetail-label";
    label.textContent = t(labelKey);
    // An explanation on hover, with NO visual marker: "other" and "xmlhttprequest" are
    // Chrome's own category names, which the reader has no reason to know and we must not
    // rename (the schema records whatever Chrome emits, verbatim). A dotted underline here
    // would be the only underlined thing in the panel and read as a link, a false
    // affordance. A silent title is the lesser cost.
    if (hintKey) label.title = t(hintKey);
    box.appendChild(label);
    if (typeof body === "string") {
      const p = document.createElement("div");
      p.className = "vdetail-text mono";
      p.textContent = body;
      box.appendChild(p);
    } else {
      box.appendChild(body);
    }
  };

  const d = v.detail;

  // The check state, explained in full, as the panel's opening statement.
  //
  // The column can only afford three words, and three words cannot say why "No script ran"
  // is not an accusation or why a tag that asked cannot be named. A tooltip would need a
  // dotted underline to be findable, which puts a fake affordance inside a clickable row.
  // This is the honest home for it: the reader clicked to find out more, and this is more.
  const why = document.createElement("div");
  why.className = "vdetail-why";
  why.textContent = checkHelpText(v);
  box.appendChild(why);

  section("vdetailNetwork", `${d.signedRequestCount}/${d.requestCount} ${t("vdetailSigned")}`);

  // Resource types are what "Not applicable" (vendor-no-script-observed) is a claim
  // ABOUT — shown so a reader can check that claim against the same fact the engine used,
  // rather than take "no script executed" on faith.
  //
  // ALWAYS shown, including when empty. Shown only when non-empty, the panel that justifies
  // "Not applicable" would silently drop its own evidence on exactly the high-traffic pages
  // where the retained network sample has been evicted, and the reader would have no way to
  // tell an absent row from a vendor that made no requests. Empty means the retained sample
  // holds nothing for this vendor, which is unavailability, not absence.
  if (d.resourceTypes.length > 0) {
    section("vdetailResourceTypes", d.resourceTypes.join(", "), "hintResourceTypes");
  } else {
    const none = document.createElement("div");
    none.className = "vdetail-text absence";
    none.textContent = t("valueNotObservable");
    section("vdetailResourceTypes", none, "hintResourceTypes");
  }

  if (d.cookies.length > 0) {
    const table = document.createElement("div");
    table.className = "vdetail-cookies mono";
    for (const c of d.cookies) {
      const nameEl = document.createElement("span");
      // With its domain where another line has the same name, as the row writes it.
      nameEl.textContent = shownName(c, d.cookies);
      const attrs = document.createElement("span");
      attrs.className = "vdetail-attrs";
      // Sent back first: it is the fact that turns a cookie being set into an identifier
      // reaching the vendor, and it is what a reader is looking for. Shown only when seen,
      // never its absence: a cookie not seen going back may have had no later request, and
      // a script cookie on the site's own domain never goes to the vendor's as a cookie.
      // The heading's hover text says what the words mean, so a cookie without them is not
      // read as one the capture did not check. The container panel puts whom the count
      // includes the cookie under in this slot, and the attributes after it in this order.
      // SameSite is LABELED. Its values are "None", "Lax", "Strict" and "unspecified", and
      // a bare "None" in a row reading "sent back · 400 days · None" reads as "no value
      // here", the exact opposite of what SameSite=None means, which is that the cookie
      // travels on cross-site requests and is therefore the cross-site-capable case.
      // A cookie kept by name alone (past the cap on cookie details) shows only whether it
      // was sent back: its attributes were not kept, and are not guessed at.
      const bits: (string | { text: string; title: string })[] = c.sentBack ? [t("cookieSentBack")] : [];
      // Removed again after it was set: beside whether it went back, since both say what
      // became of the cookie, and before the attributes it was set with.
      if (c.removed !== undefined) bits.push(removedAttr(c.removed));
      if (c.expiry !== undefined) bits.push(t(c.expiry.key, c.expiry.substitution));
      if (c.sameSite !== undefined) bits.push(`${t("vdetailSameSite")}=${c.sameSite}`);
      // A partitioned cookie cannot be read across sites, so it is marked. How the cookie
      // was set is always shown, a Set-Cookie header or a page script, in the same words
      // and the same place as in a container's panel.
      if (c.partitioned) bits.push(t("vdetailPartitioned"));
      if (c.viaKey !== undefined) bits.push(t(c.viaKey));
      if (c.onRedirect) bits.push(t("reqRedirect"));
      // Why a name is here and not on the row: the row lists what was set while the request
      // carried the signal (1.26.0).
      if (c.unsigned) bits.push(t("vdetailCookieUnsigned"));
      // Only the response was seen: whether its request carried the signal was not (1.26.0).
      if (c.requestLost) bits.push(t("requestLost"));
      cookieAttrs(attrs, bits);
      // The cookie's last attribute, on a line of its own: plain text with the mark, and
      // not a link. No description from the list: the database's text for AWSALB ends
      // "cannot identify you as an individual", an assurance this popup never makes.
      if (c.functional) {
        const listed = document.createElement("span");
        listed.className = "fattr";
        listed.append(functionalMark(), " ", functionalWords());
        attrs.appendChild(listed);
      }
      table.append(nameEl, attrs);
    }
    section("vdetailCookies", table, "hintCookiesSentBack");
    // At the end of the list it qualifies (1.26.0).
    if (d.cookiesCapped) {
      const cap = document.createElement("div");
      cap.className = "vcap";
      cap.textContent = t("vdetailCookiesCapped");
      box.appendChild(cap);
    }
  }

  // What was left out of the count, and why (1.18.0). Only when there was any: an empty
  // section here would read as a finding about nothing.
  if (d.probeCookies.length > 0) section("vdetailProbeCookies", d.probeCookies.join(", "), "hintProbeCookies");
  if (d.refusedWrites.length > 0) section("vdetailRefusedWrites", d.refusedWrites.join("\n"), "hintRefusedWrites");

  // ALWAYS shown, for the same reason as Resource types above: this row is the evidence
  // behind the vendor's check state, and a reader comparing "Asked via GPP" against a row
  // that simply is not there cannot tell an empty result from a row that does not exist.
  if (d.consentCalls.length > 0) {
    section("vdetailConsentCalls", d.consentCalls.map((c) => `${c.api} ${c.count}×`).join("  "));
  } else {
    const none = document.createElement("div");
    none.className = "vdetail-text absence";
    // "None observed", not "not observable": consent-API calls are wrapped page-wide for
    // the whole session, so an empty result here is a real observation about this vendor —
    // unlike Resource types, which depends on the evictable request sample.
    none.textContent = t("valueNoneObserved");
    section("vdetailConsentCalls", none);
  }

  // No per-vendor read count: the number is a lower bound from a sample, the caveat it
  // needs is longer than the fact, and the fact a reader wants (this vendor read the GPC
  // property) is already the tag and the first line of this panel. The evidence stays in
  // the ObservationSet (readsByScript).

  // Every loader the records resolved, one per line, so a reader can see the whole set
  // when the row collapsed several into one line. Absent when nothing resolved: an empty
  // section would read as "nobody loaded it", which is never what an absence means here.
  if (d.loadedVia.length > 0) section("vdetailLoadedBy", d.loadedVia.map(loadedViaText).join("\n"));

  if (d.domains.length > 0) section("vdetailDomains", d.domains.join("\n"));

  // No list provenance line here. Once per expanded vendor it would repeat what the credit
  // at the foot of the Overview states once for the list it describes, and on a page with
  // several vendors open it would be the most repeated string on the screen. The heading's
  // link carries the same source, version and hash.

  // No report button here. Reporting is the one button at the foot of the popup, so an
  // expanded panel holds only what was observed.

  return box;
}

/** The check state's explanation, with the ordering sentence when the artifact has one. */
function checkHelpText(v: { checkHelp: { key: string; substitution?: readonly string[]; orderKey?: string } }): string {
  const base = t(v.checkHelp.key, v.checkHelp.substitution);
  return v.checkHelp.orderKey ? `${base} ${t(v.checkHelp.orderKey)}` : base;
}

/** Join a loaded-by line's translatable fragments. */
function loadedViaText(line: LoadedViaLine): string {
  return line.parts.map((p) => t(p.key, p.substitution)).join(", ");
}

/** Whether the First party row is open: the side panel's redraw keeps it so (1.26.0). */
let firstPartyOpen = false;

/**
 * The First party section (1.26.0): one row, the site's registrable domain and every cookie
 * name under it as a vendor row lists them, closed until opened. Open, the sentence that says which cookies are here,
 * the two lists (an empty one reads "none observed", or "not observable" for the script
 * writes when they could not be watched), each name kept whole on a line, and the cap note
 * after the list that was full. Hidden in the states that show no result, and when there is
 * nothing to list.
 */
function renderFirstParty(view: PopupView): void {
  const section = el("first-party-section");
  const host = el("first-party");
  host.textContent = "";
  const fp = view.firstParty;
  const shown = view.state === "observed" || view.state === "no-ad-tech" || view.state === "signal-off";
  section.hidden = !shown || fp === undefined;
  if (!shown || fp === undefined) return;

  // A vendor row's markup: the domain, and every name under it. Nothing here is counted, so
  // the names take the secondary color of a row the headline leaves out (.vrow-other).
  const row = document.createElement("div");
  row.className = "vrow vrow-other";
  const body = document.createElement("div");
  body.className = "vbody";
  const top = document.createElement("div");
  top.className = "vtop";
  const name = document.createElement("span");
  name.className = "vname vname-wrap";
  name.textContent = fp.domain;
  top.appendChild(name);
  const cookies = document.createElement("div");
  const names = firstPartyRowNames(fp);
  if (names.length === 0) {
    // Only probes: something was set, as an unlisted domain's row says.
    cookies.className = "vcookie absence";
    cookies.textContent = t("vendorCookiesSetAndRemoved");
  } else {
    cookies.className = "vcookie";
    appendMarkedNames(cookies, names, [], false);
  }
  body.append(top, cookies);
  const caret = document.createElement("span");
  caret.className = "caret";
  caret.textContent = CARET;
  caret.setAttribute("aria-hidden", "true");
  row.append(body, caret);
  row.setAttribute("role", "button");
  row.setAttribute("tabindex", "0");
  row.dataset["focusKey"] = "first-party";
  row.setAttribute("aria-expanded", String(firstPartyOpen));
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      row.click();
    }
  });
  row.addEventListener("click", () => {
    firstPartyOpen = !firstPartyOpen;
    renderFirstParty(view);
  });
  host.appendChild(row);
  if (!firstPartyOpen) return;

  const box = document.createElement("div");
  box.className = "vdetail";
  const why = document.createElement("div");
  why.className = "vdetail-why";
  why.textContent = t("firstPartyIntro");
  box.appendChild(why);
  for (const [labelKey, names, observable, capped] of [
    ["firstPartyListVendor", fp.vendorWritten, fp.scriptWritesObserved, fp.vendorCapped],
    ["firstPartyListSite", fp.site, true, fp.siteCapped],
  ] as const) {
    detailLabel(box, labelKey);
    if (names.length === 0) {
      detailAbsent(box, observable);
    } else {
      const list = document.createElement("div");
      list.className = "vdetail-text mono fp-names";
      // A name set only on a request without the signal says so, as a panel's cookie line does,
      // and one known only from a lost request (1.26.0).
      appendIds(list, names, (n) => {
        const mark = firstPartyMarkKey(fp, n);
        return mark === null ? "" : ` (${t(mark)})`;
      });
      box.appendChild(list);
    }
    // At the end of the list it qualifies.
    if (capped) {
      const cap = document.createElement("div");
      cap.className = "vcap";
      cap.textContent = t("vdetailCookiesCapped");
      box.appendChild(cap);
    }
  }
  // As in every panel: what was set and removed, left out of every list (1.26.0).
  if (fp.probeCookies.length > 0) {
    detailLabel(box, "vdetailProbeCookies", "hintProbeCookies");
    detailText(box, fp.probeCookies.join(", "), true);
  }
  host.appendChild(box);
}

/** Container panels open, by row key: the side panel's redraw keeps them open (1.25.0). */
const expandedContainers = new Set<string>();

/**
 * Container ids or cookie names, each kept whole with its comma: an inline block moves to the
 * next line intact rather than breaking at its hyphen (`AW-` on one line, `7130000` on the
 * next), and breaks inside only when the id alone is wider than the line. `suffix` adds text
 * to an id inside its block.
 */
function appendIds(host: HTMLElement, ids: readonly string[], suffix?: (id: string) => string): void {
  ids.forEach((id, i) => {
    if (i > 0) host.append(" ");
    const span = document.createElement("span");
    span.className = "idtok";
    span.textContent = `${id}${suffix?.(id) ?? ""}${i < ids.length - 1 ? "," : ""}`;
    host.appendChild(span);
  });
}

/**
 * A cookie's attributes on its line in a panel, " · " between them. Each is a box of its
 * own, so the line wraps between attributes and never inside one: "Set-Cookie" broken at
 * its hyphen reads as two words. Only an attribute wider than the column wraps inside,
 * such as whom the count includes the cookie under. The separator stays with the attribute
 * before it, so no line starts with one.
 */
function cookieAttrs(attrs: HTMLElement, bits: readonly (string | { readonly text: string; readonly title: string })[]): void {
  bits.forEach((bit, i) => {
    const last = i === bits.length - 1;
    const text = typeof bit === "string" ? bit : bit.text;
    const box = document.createElement("span");
    box.className = "vattr";
    box.textContent = last ? text : `${text} ·`;
    // An explanation on hover, with no visual marker, as a panel's headings have.
    if (typeof bit !== "string") box.title = bit.title;
    attrs.append(box);
    if (!last) attrs.append(" ");
  });
}

/**
 * The attribute for a cookie that was removed again after it was set, with what that means
 * on hover: the cookie is listed and counted all the same.
 */
function removedAttr(removed: { readonly key: string; readonly substitution?: readonly [string] }): { text: string; title: string } {
  return { text: t(removed.key, removed.substitution), title: t("cookieRemovedHelp") };
}

/** A panel section's label, with its hover text where there is one. */
function detailLabel(box: HTMLElement, key: string, hintKey?: string): void {
  const l = document.createElement("div");
  l.className = "vdetail-label";
  l.textContent = t(key);
  if (hintKey) l.title = t(hintKey);
  box.appendChild(l);
}

/** A panel section's text. */
function detailText(box: HTMLElement, value: string, mono = false): void {
  const p = document.createElement("div");
  p.className = mono ? "vdetail-text mono" : "vdetail-text";
  p.textContent = value;
  box.appendChild(p);
}

/** An empty panel section: "none observed", or "not observable" where it could not be watched. */
function detailAbsent(box: HTMLElement, observable: boolean): void {
  const p = document.createElement("div");
  p.className = "vdetail-text absence";
  p.textContent = t(observable ? "valueNoneObserved" : "valueNotObservable");
  box.appendChild(p);
}

/** A line of a message with the ids kept whole where the message puts `$IDS$`. */
const IDS_MARK = "\uE005";
function appendWithIds(host: HTMLElement, text: string, ids: readonly string[]): void {
  const [before = "", after = ""] = text.split(IDS_MARK);
  host.append(before);
  appendIds(host, ids);
  host.append(after);
}

/**
 * A loaded-by line whose substitutions (container ids, names, domains) are each kept whole,
 * joined as loadedViaText joins its parts.
 */
function appendLoadedVia(host: HTMLElement, line: LoadedViaLine): void {
  line.parts.forEach((part, i) => {
    if (i > 0) host.append(", ");
    const subs = part.substitution ?? [];
    const marks = subs.map((_, j) => String.fromCharCode(0xe010 + j));
    let text = t(part.key, marks);
    subs.forEach((sub, j) => {
      const [before = "", after = ""] = text.split(marks[j]!);
      host.append(before);
      appendIds(host, [sub]);
      text = after;
    });
    host.append(text);
  });
}

/** A cookie's name with the mark and color its row gives it: counted, or not. */
function containerName(name: string, counted: boolean): HTMLElement {
  const span = document.createElement("span");
  if (!counted) span.className = "ck-other";
  span.textContent = name;
  return span;
}

/**
 * The Tag containers section (1.25.0), after Vendors, in the vendor row's own markup: the
 * product and its id, the Read GPC state as a vendor's, every cookie written inside it
 * (amber where the count includes the name, secondary where it does not), and who loaded
 * it. Left out when the page ran no container. No line of text under the heading.
 */
function renderContainers(view: PopupView): void {
  const section = el("containers-section");
  const host = el("containers");
  host.textContent = "";
  section.hidden = view.containers.length === 0 && view.containersQuiet.length === 0;
  if (section.hidden) return;
  const head = el("containers-check-head");
  head.textContent = view.containers.length > 0 ? t("vendorsColumnCheck") : "";
  head.title = t("containersColumnCheckTitle");

  for (const c of view.containers) {
    const row = document.createElement("div");
    row.className = "vrow";
    const body = document.createElement("div");
    body.className = "vbody";

    const top = document.createElement("div");
    top.className = "vtop";
    // The product and its id wrap to a second line before either is cut: an id is what
    // the person who runs the container looks for.
    const name = document.createElement("span");
    name.className = "vname vname-wrap";
    name.textContent = c.managerKey ? t(c.managerKey) : c.manager;
    if (c.ids.length === 1 && c.managerKey === undefined) {
      const id = document.createElement("span");
      id.className = "vid mono idtok";
      id.textContent = c.ids[0]!;
      name.append(" ", id);
    }
    const check = document.createElement("span");
    check.className = "vcheck";
    check.textContent = t(c.checkKey);
    check.title = t(c.checkHelp.key);
    top.append(name, check);
    body.appendChild(top);

    // The Google tag's ids, on a line of their own: every one on the page shares the row.
    if (c.managerKey !== undefined && c.ids.length > 0) {
      const ids = document.createElement("div");
      ids.className = "vsecondary mono vids";
      appendIds(ids, c.ids);
      body.appendChild(ids);
    }

    const cookies = document.createElement("div");
    if (c.cookiesPredate) {
      cookies.className = "vcookie absence";
      cookies.textContent = t("containerCookiesPredate");
    } else if (c.cookies.length === 0) {
      cookies.className = "vcookie absence";
      cookies.textContent = t("vendorNoCookies");
    } else {
      cookies.className = "vcookie";
      c.cookies.forEach((k, i) => {
        if (i > 0) cookies.append(", ");
        cookies.appendChild(containerName(k.name, k.counted));
      });
    }
    body.appendChild(cookies);

    if (c.loadedVia) {
      const line = document.createElement("div");
      line.className = "vsecondary";
      appendLoadedVia(line, c.loadedVia);
      body.appendChild(line);
    }

    const caret = document.createElement("span");
    caret.className = "caret";
    caret.textContent = CARET;
    caret.setAttribute("aria-hidden", "true");
    row.append(body, caret);
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    row.dataset["focusKey"] = c.key;
    row.setAttribute("aria-expanded", String(expandedContainers.has(c.key)));
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        row.click();
      }
    });
    row.addEventListener("click", () => {
      if (expandedContainers.has(c.key)) expandedContainers.delete(c.key);
      else expandedContainers.add(c.key);
      renderContainers(view);
    });
    host.appendChild(row);
    if (expandedContainers.has(c.key)) host.appendChild(containerDetailNode(c));
  }

  // An id found on the page with nothing recorded under it: named once, with no row.
  if (view.containersQuiet.length > 0) {
    const quiet = document.createElement("div");
    quiet.className = "vquiet";
    quiet.textContent = t("containerQuiet", view.containersQuiet.join(", "));
    host.appendChild(quiet);
  }
}

/**
 * A container's panel. The same sections in the same order for every product, the Google
 * tag's leaving out the containers it loaded since it loads none. A section with nothing
 * in it says "none observed", or "not observable" where the records that would hold it
 * were not kept.
 */
function containerDetailNode(c: PopupView["containers"][number]): HTMLElement {
  const box = document.createElement("div");
  box.className = "vdetail";
  const d = c.detail;

  const why = document.createElement("div");
  why.className = "vdetail-why";
  why.textContent = t(c.checkHelp.key);
  box.appendChild(why);

  const label = (key: string, hintKey?: string): void => detailLabel(box, key, hintKey);
  const text = (value: string, mono = false): void => detailText(box, value, mono);
  const absent = (observable: boolean): void => detailAbsent(box, observable);

  // 2. Cookies set, each saying whom the count includes it under, or that it does not.
  label("vdetailCookies");
  if (d.cookies.length === 0) {
    absent(!c.cookiesPredate);
  } else {
    const table = document.createElement("div");
    table.className = "vdetail-cookies mono";
    for (const k of d.cookies) {
      const nameEl = containerName(shownName(k, d.cookies), k.countedUnder !== undefined);
      const attrs = document.createElement("span");
      attrs.className = "vdetail-attrs";
      const bits: (string | { text: string; title: string })[] = [
        k.countedUnder ? t("cookieCountedUnder", [k.countedUnder.entity, categoryLabel(k.countedUnder.category)]) : t("cookieNotCounted"),
      ];
      if (!k.countedUnder) attrs.title = t("cookieNotCountedHelp");
      // The rest in a vendor panel's order, with how it was set in the same words.
      if (k.removed !== undefined) bits.push(removedAttr(k.removed));
      if (k.expiry !== undefined) bits.push(t(k.expiry.key, k.expiry.substitution));
      if (k.sameSite !== undefined) bits.push(`${t("vdetailSameSite")}=${k.sameSite}`);
      if (k.partitioned) bits.push(t("vdetailPartitioned"));
      if (k.viaKey !== undefined) bits.push(t(k.viaKey));
      if (k.onRedirect) bits.push(t("reqRedirect"));
      cookieAttrs(attrs, bits);
      if (k.functional) {
        const listed = document.createElement("span");
        listed.className = "fattr";
        listed.append(functionalMark(), " ", functionalWords());
        attrs.appendChild(listed);
      }
      table.append(nameEl, attrs);
    }
    box.appendChild(table);
  }
  if (d.probeCookies.length > 0) {
    label("vdetailProbeCookies", "hintProbeCookies");
    text(d.probeCookies.join(", "), true);
  }
  if (d.refusedWrites.length > 0) {
    label("vdetailRefusedWrites", "hintRefusedWrites");
    text(d.refusedWrites.join("\n"), true);
  }

  // 3. Consent API calls, as in a vendor's panel. Wrapped page-wide, so an empty result is
  // an observation.
  label("vdetailConsentCalls");
  if (d.consentCalls.length > 0) text(d.consentCalls.map((x) => `${x.api} ${x.count}×`).join("  "), true);
  else absent(true);

  // 4. Loaded by: every loader, one per line.
  label("vdetailLoadedBy");
  if (d.loadedBy.length > 0) {
    const p = document.createElement("div");
    p.className = "vdetail-text";
    d.loadedBy.forEach((line, i) => {
      if (i > 0) p.appendChild(document.createElement("br"));
      appendLoadedVia(p, line);
    });
    box.appendChild(p);
  } else absent(d.insertionsObserved);

  // 5. Vendors loaded, then the domains no company is named for.
  label("vdetailVendorsLoaded");
  const vendorLines = d.vendorsLoaded.map((v) => t("vendorInCategory", [v.entity, categoryLabel(v.category)]));
  if (d.domainsLoaded.length > 0) vendorLines.push(t("containerAlsoScriptsFrom", d.domainsLoaded.join(", ")));
  if (vendorLines.length > 0) text(vendorLines.join("\n"));
  else absent(d.insertionsObserved);

  // 6. Tag containers loaded. Not on the Google tag's panel: a Google tag loads none.
  if (d.containersLoaded !== undefined) {
    label("vdetailContainersLoaded");
    if (d.containersLoaded.length > 0) {
      const p = document.createElement("div");
      p.className = "vdetail-text";
      d.containersLoaded.forEach((x, i) => {
        if (i > 0) p.appendChild(document.createElement("br"));
        appendWithIds(p, t("containerLoadedItem", [x.nameKey ? t(x.nameKey) : x.name, IDS_MARK]), x.ids);
      });
      box.appendChild(p);
    } else absent(d.insertionsObserved);
  }

  // 7. Requests sent to: companies and domains, never a count.
  label("vdetailRequestsSentTo");
  if (d.requestsTo.length > 0) {
    text(
      d.requestsTo
        .map((r) => t("containerRequestsTo", [r.entity !== null ? t("vendorInCategory", [r.entity, categoryLabel(r.category)]) : r.domain, r.hosts.join(", ")]))
        .join("\n"),
    );
  } else absent(d.requestsObserved);

  // 8. Script: the container's own address.
  label("vdetailScript");
  if (d.scripts.length > 0) {
    // The address breaks where it must; its id stays whole.
    const p = document.createElement("div");
    p.className = "vdetail-text mono vscripts";
    d.scripts.forEach((url, i) => {
      if (i > 0) p.appendChild(document.createElement("br"));
      const at = url.indexOf("?id=");
      if (at < 0) {
        p.append(url);
        return;
      }
      p.append(url.slice(0, at + 4));
      appendIds(p, [url.slice(at + 4)]);
    });
    box.appendChild(p);
  } else absent(d.insertionsObserved);

  return box;
}

function renderStatus(view: PopupView): void {
  el("status-dot").className = view.status.isSet ? "dot on" : "dot";
  el("status-text").textContent = view.status.isSet ? t("signalSetBy") : t("signalNotSet");
  const tag = el("status-source");
  tag.className = view.status.accent ? "tag accent" : "tag";
  tag.textContent = t(view.status.sourceKey);
}

function renderEmptyState(view: PopupView): void {
  const dl = el("site-did");
  const host = el("vendors");
  const key = view.state === "pending" ? "statePending" : "stateNoData";
  dl.textContent = "";
  host.textContent = "";
  el("vendors-check-head").textContent = "";
  const div = document.createElement("div");
  // Pending is a transition, not an absence: work is still in flight and something is
  // expected to replace this. Dimmed italic means "there is nothing here", which would be
  // the wrong claim for one frame and the wrong treatment for the rule (DESIGN.md §4).
  div.className = view.state === "pending" ? "empty" : "empty absence";
  div.textContent = t(key);
  // needs-reload, load-failed and ineligible say their piece in the notice at the top, and
  // the sections are hidden.
  if (!hidesSections(view.state)) host.appendChild(div);
}

/**
 * States whose one notice at the top says everything: the page's load was not observed, the
 * page did not load, or the extension cannot inspect the page at all. Headings over nothing
 * would read as results.
 */
function hidesSections(state: PopupView["state"]): boolean {
  return state === "needs-reload" || state === "load-failed" || state === "site-access-limited" || onlyTheNotice(state);
}

/**
 * A page the extension cannot inspect shows its notice and nothing else, on both tabs: no
 * signal status, which would describe a page the signal never reached, no request count or
 * list, and no footer, whose buttons would save or report a record of nothing.
 */
function onlyTheNotice(state: PopupView["state"]): boolean {
  return state === "ineligible";
}

function render(view: PopupView): void {
  el("site").textContent = view.site;
  // A page whose load was not observed has nothing to put under any heading, and three
  // empty headings under "reload the page" read as three results. Set on every render: the
  // popup refreshes in place, and the reload it asks for brings the sections back.
  document.querySelectorAll<HTMLElement>("#overview-body > .section").forEach((section) => {
    section.hidden = hidesSections(view.state);
  });
  el("status-row").hidden = onlyTheNotice(view.state);
  el("overview-footer").hidden = onlyTheNotice(view.state);
  renderStatus(view);
  renderNotices(view);
  renderCount(view);

  if (
    view.state === "pending" ||
    view.state === "no-data" ||
    view.state === "ineligible" ||
    hidesSections(view.state)
  ) {
    renderEmptyState(view);
    // Every section the full render fills is emptied here too. The panel redraws in place
    // when it follows the reader to another tab, and a section left alone would keep the
    // rows of the page before under this page's status.
    renderPrivacyStrings({ ...view, privacyStrings: [] });
    renderGpcReads({ ...view, gpcReads: [] });
    renderContainers({ ...view, containers: [], containersQuiet: [] });
    renderFirstParty(view);
    // Nothing was classified, so there is nothing to credit.
    el("list-credit").hidden = true;
    return;
  }

  // With sending off the page is still rendered in full. What the site published, whether
  // any script checked, and which vendors were on the page are all observations about the
  // page, and a reader turning the signal off to compare two visits needs the same panel
  // both times. The one thing that is not shown is a cookie count, which renderCount
  // explains: every counter is defined over signed requests. The status row is what says
  // the signal is off.
  renderSiteDid(view);
  renderPrivacyStrings(view);
  renderGpcReads(view);
  renderVendors(view);
  // The site's tag containers, after the vendors their tags are among, and the list's
  // credit after that.
  renderContainers(view);
  // The site's own cookies last, above the credit (1.26.0).
  renderFirstParty(view);
  renderListCredit();
}

// --- requests tab ---

/** The addresses the popup links to. */
const REPO_URL = "https://github.com/gpc-inspector/gpc-inspector-extension";
const LIST_SOURCE_URL = "https://github.com/disconnectme/disconnect-tracking-protection";
const LIST_LICENSE_URL = "https://creativecommons.org/licenses/by-nc-sa/4.0/";
const FUNCTIONAL_SOURCE_URL = "https://github.com/jkwakman/Open-Cookie-Database";
const FUNCTIONAL_LICENSE_URL = "https://www.apache.org/licenses/LICENSE-2.0";
const LIMITATIONS_URL = `${REPO_URL}/blob/main/docs/LIMITATIONS.md`;

const FILTERS: { id: RequestFilter; labelKey: string }[] = [
  { id: "all", labelKey: "reqFilterAll" },
  { id: "advertising", labelKey: "reqFilterAdvertising" },
  { id: "analytics", labelKey: "reqFilterAnalytics" },
  { id: "third-party", labelKey: "reqFilterThirdParty" },
  { id: "set-cookie", labelKey: "reqFilterSetCookie" },
  { id: "uncategorized", labelKey: "reqFilterUncategorized" },
];

/** Whether a cookie name is on the list of functional cookie names. By name alone. */
const isListedFunctional = (cookieName: string): boolean => getFunctionalCookies().lists(cookieName);

let activeFilter: RequestFilter = "all";
let latestObservations: ObservationSet | null = null;
/** The Overview's view as last drawn, which the Requests tab follows on a page with only a notice. */
let latestView: PopupView | null = null;
/** Which row's detail is expanded. Only one at a time; the popup is 360px wide. */
/** Domains whose request list is open. Several may be open at once. */
const expandedGroups = new Set<string>();
/**
 * Each drawn domain row's cookie names, fitted again when the list's width changes: a
 * side panel dragged narrower or wider holds a different number of whole names.
 */
let rowCookieFits: (() => void)[] = [];
let rowCookieWidth = -1;
const rowCookieObserver =
  typeof ResizeObserver === "undefined"
    ? null
    : new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect.width ?? -1;
        if (width === rowCookieWidth) return;
        rowCookieWidth = width;
        for (const fit of rowCookieFits) fit();
      });
/** Vendor rows expanded on the Overview, by row key: a company's rows open one at a time. */
const expandedVendors = new Set<string>();

function renderFilters(view: RequestsView): void {
  const host = el("req-filters");
  host.textContent = "";
  for (const f of FILTERS) {
    const count = view.counts[f.id];
    const btn = document.createElement("button");
    btn.className = f.id === view.activeFilter ? "req-filter active" : "req-filter";
    btn.dataset["focusKey"] = `filter:${f.id}`;
    // The label is prose and the count is a number: only the number is monospace, so the
    // chips do not read as identifiers off the wire (DESIGN.md §5).
    btn.textContent = t(f.labelKey);
    const n = document.createElement("span");
    n.className = "req-filter-count";
    n.textContent = String(count);
    btn.appendChild(n);
    // A filter that would select nothing is disabled rather than hidden: its zero is
    // information, and a chip that disappears makes the set of filters look inconsistent
    // between pages.
    // By the rows it lists, script writes included, so a filter with no request but a
    // script write can still show it.
    if (view.listed[f.id] === 0 && f.id !== "all") btn.disabled = true;
    btn.addEventListener("click", () => {
      activeFilter = f.id;
      renderRequests();
    });
    host.appendChild(btn);
  }
}

/**
 * Cookie names, the ones the Overview's count includes in the attention color, so a name
 * under the count can be found here. The rest stay at full text strength. Never the link
 * color: a name sits inside a row that is itself a button.
 */
function appendCookieNames(
  host: HTMLElement,
  names: readonly string[],
  counted: readonly string[],
  functional: readonly string[],
  /** The words after the mark, where there is room for them: a request's detail. */
  words = false,
  /** Whom a counted name is counted under, where the row does not say it (1.25.0). */
  under: RequestsView["rows"][number]["countedUnder"] = [],
): void {
  names.forEach((name, i) => {
    if (i > 0) host.append(", ");
    const span = document.createElement("span");
    if (counted.includes(name)) span.className = "ck-counted";
    span.textContent = name;
    host.appendChild(span);
    // An owner's name written inside its container sits under a row that names no company
    // (googletagmanager.com is Uncategorized), so the detail says whom the count charges.
    const owner = under.find((u) => u.name === name);
    if (owner !== undefined) {
      const who = document.createElement("span");
      who.className = "cwords";
      who.textContent = t("cookieCountedUnder", [owner.entity, categoryLabel(owner.category)]);
      host.append(" ", who);
    }
    // The same mark as on the Overview, on the same cookies: the counted ones. A domain's
    // row has the mark, as the names under the count do; a request's detail has the words
    // too, as a vendor's row does. The same hover text on both.
    if (!functional.includes(name)) return;
    host.appendChild(functionalMark());
    if (words) host.append(" ", functionalWords());
  });
}

/** Detail for one row: the facts behind it, without cookie values. */
/**
 * The expanded detail for one request, as labeled rows.
 *
 * Each fact has a label and its own line. Six facts of four different kinds strung
 * together with one separator ("GET · script · 200 party: third · Google · advertising
 * Sec-GPC: 1 Set-Cookie: test_cookie") cannot be found by scanning.
 */
/** Category as Disconnect names it, rather than as an identifier. */
function categoryLabel(category: string): string {
  const translated = chrome.i18n.getMessage(categoryLabelKey(category));
  return translated === "" ? category : translated;
}

function detailNode(row: RequestsView["rows"][number]): HTMLElement {
  const box = document.createElement("div");
  box.className = "req-detail";

  // The full URL appears only here. The row label drops the query string, because ad-tech
  // parameters carry identifiers and the row is the most screenshotted surface. A script
  // write's URL is its script's, which its "Written by" line gives.
  if (!row.scriptWrite) {
    const url = document.createElement("div");
    url.className = "req-detail-url mono";
    url.textContent = row.url;
    box.appendChild(url);
  }
  // Not the full URL, for a request listed from its kept record after a reclaim (1.27.0).
  if (row.kept) {
    const note = document.createElement("div");
    note.className = "req-detail-note";
    note.textContent = t("detailKeptAddress");
    box.appendChild(note);
  }

  const grid = document.createElement("div");
  grid.className = "req-detail-grid";

  const add = (labelKey: string, value: string, accent = false): void => {
    const k = document.createElement("span");
    k.className = "req-detail-key";
    k.textContent = t(labelKey);
    const v = document.createElement("span");
    v.className = accent ? "req-detail-val mono accent" : "req-detail-val mono";
    v.textContent = value;
    grid.append(k, v);
  };

  // Sec-GPC is the reason this tab exists, so it sits directly under the request and is
  // stated on every row — not only on the exceptions, the way the collapsed marker does.
  // The header name is the label and its value is the value, rather than repeating
  // "Sec-GPC:" inside a row already labeled something else. A script write says who wrote
  // the cookie and whether the property was set instead (detailHead).
  for (const line of detailHead(row)) add(line.labelKey, "value" in line ? line.value : t(line.valueKey));

  // One fact per row, each a plain phrase. Joined with "·" into "third party · Google ·
  // advertising", they would read as one compound thing rather than three separate facts
  // and give the reader nothing to scan for.
  add("detailPartyLabel", row.party === "first" ? t("detailFirstParty") : t("detailThirdParty"));
  if (row.entity) add("detailVendor", row.entity);
  if (row.category !== "unknown") add("detailCategory", categoryLabel(row.category));

  const redirect = redirectKey(row);
  if (redirect !== null) add("detailRedirect", t(redirect));

  if (row.cookieNames.length > 0) {
    // Names only. A cookie VALUE is a session identifier and must never be rendered where
    // it can be screenshotted or copied (FR-24).
    add("detailSetCookie", "", true);
    appendCookieNames(grid.lastElementChild as HTMLElement, row.cookieNames, row.countedCookieNames, row.functionalCookieNames, true, row.countedUnder);
  }
  // Set, and not in the browser's cookie jar when checked (1.30.0). Named again on a line of
  // their own, so the reason sits beside the names it is about.
  if (row.notStoredCookieNames.length > 0) add("detailNotStored", row.notStoredCookieNames.join(", "));

  box.appendChild(grid);
  return box;
}

/**
 * The one place a worker reclaim is reported (1.22.0): it loses this list and nothing the
 * Overview is built from. Same dashed "we could not look" box as the Overview's notices.
 */
function renderRequestsDropped(dropped: boolean, keptShown = 0, keptIncomplete = false): void {
  // What the list still holds (1.27.0): the requests that set a cookie are kept past the
  // reclaim, all of them or some.
  const key = keptShown === 0 ? "requestsDropped" : keptIncomplete ? "requestsDroppedSomeCookiesKept" : "requestsDroppedCookiesKept";
  renderRequestsNotice(dropped ? key : null);
}

/** The Requests tab's one notice, in the Overview's dashed box, or none. */
function renderRequestsNotice(key: string | null): void {
  const host = el("req-notice");
  host.textContent = "";
  host.hidden = key === null;
  if (key === null) return;
  const div = document.createElement("div");
  div.className = "notice unavailable";
  div.innerHTML = ICON_INFO;
  const body = document.createElement("div");
  body.className = "notice-body";
  body.textContent = t(key);
  div.appendChild(body);
  host.appendChild(div);
}

function renderRequests(): void {
  // A page the extension cannot inspect: the Overview's notice, and no filters and no list.
  // What the record holds there (requests the new tab page made) is not a page's.
  const only = latestView !== null && onlyTheNotice(latestView.state) ? latestView.notices[0] : undefined;
  el("req-bar").hidden = only !== undefined;
  if (only !== undefined) {
    renderRequestsNotice(only.textKey);
    el("req-script-note").hidden = true;
    el("req-list").textContent = "";
    el("req-empty").hidden = true;
    return;
  }

  const view = buildRequestsView(
    latestObservations,
    getClassifier(),
    activeFilter,
    latestObservations ? resolveLoaders(latestObservations, getClassifier()) : undefined,
    isListedFunctional,
    getOwnerNames(),
  );

  renderFilters(view);
  renderRequestsDropped(view.requestsDropped, view.keptShown, view.keptIncomplete);

  const list = el("req-list");
  const empty = el("req-empty");
  list.textContent = "";
  rowCookieFits = [];
  rowCookieObserver?.observe(list);

  // Script writes are listed and counted by no request number, so they are counted here,
  // once, above the list.
  const note = el("req-script-note");
  const noteText = scriptWriteNote(view);
  note.hidden = noteText === null;
  note.textContent = noteText === null ? "" : t(noteText.key, noteText.substitution);

  if (view.rows.length === 0) {
    // Empty is about the rows: a page whose only rows are script writes has a list, though
    // no request. "No requests captured yet" under a line saying they were dropped would
    // contradict it.
    empty.hidden = view.requestsDropped && view.listed.all === 0;
    empty.textContent = t(view.listed.all === 0 ? "reqNoneCaptured" : "reqNoneMatch");
    return;
  }
  empty.hidden = true;

  for (const group of view.groups) {
    const head = document.createElement("button");
    head.className = "grp-row";

    const caret = document.createElement("span");
    caret.className = "caret";
    caret.textContent = CARET;
    caret.setAttribute("aria-hidden", "true");

    // A customer's host under a provider's suffix can be long, and its end names the
    // provider: the name is cut at its start (popup.css, .grp-name), in an LTR run of its
    // own so it still reads left to right, and shown whole on hover.
    const name = document.createElement("span");
    name.className = "grp-name mono";
    name.title = group.domain;
    const nameText = document.createElement("span");
    nameText.dir = "ltr";
    nameText.textContent = group.domain;
    name.append(nameText);

    // The cookies and the vendor share a wrapper. At the popup's width it has no box of its
    // own and the row is one line; in a panel narrower than 400px it becomes the row's
    // second line, so the domain is never the part that gives way (popup.css, .grp-sub;
    // DESIGN.md §12).
    const sub = document.createElement("span");
    sub.className = "grp-sub";
    const cookies = document.createElement("span");
    cookies.className = "grp-cookies mono";
    // Names, not a count: "set-cookie 2" reads as an index or an ID. IDE is recognizable
    // in a way a number never will be. Whole names only, as many as fit, and "+N" for the
    // rest in a box of its own that is never cut, so the row never hides a name without
    // counting it. The opened domain lists them all (below).
    const shownNames = document.createElement("span");
    shownNames.className = "grp-cookie-names";
    const moreNames = document.createElement("span");
    moreNames.className = "grp-cookie-more";
    cookies.append(shownNames, moreNames);
    const drawNames = (k: number): void => {
      shownNames.textContent = "";
      appendCookieNames(shownNames, group.cookieNames.slice(0, k), group.countedCookieNames, group.functionalCookieNames);
      const more = group.cookieNames.length - k;
      moreNames.textContent = more > 0 ? `+${more}` : "";
      moreNames.hidden = more === 0;
    };
    const fitNames = (): void => {
      drawNames(rowCookieNames(group.cookieNames, (k) => {
        drawNames(k);
        return shownNames.scrollWidth <= shownNames.clientWidth;
      }).shown.length);
    };
    if (group.cookieNames.length > 0) rowCookieFits.push(fitNames);

    // The domain's requests. A domain whose rows are all script writes has no number.
    const meta = document.createElement("span");
    meta.className = "grp-meta mono";
    meta.textContent = group.requestCount > 0 ? String(group.requestCount) : "";

    // Caret last, matching the vendor and privacy-string rows. The left position is the
    // stronger convention for a grouped list; one affordance across every expandable
    // surface is worth more than that (DESIGN.md §8).
    head.append(name, sub, meta, caret);
    sub.appendChild(cookies);

    // Who the domain is, then what the list files it under, in Disconnect's name for the
    // category: "The Trade Desk · Advertising". "First party" for the site's own domain,
    // "Uncategorized" where the list gives none. The entity is shown per-group rather than
    // grouped ON, so the reader can still see that several hostnames belong to one company
    // without the tab being organized around a claim the classification list might get
    // wrong; and no sections by category, for the same reason: the list stays alphabetical
    // and the filters do the separating.
    const ent = document.createElement("span");
    ent.className = "grp-entity";
    const kind = group.party === "first" ? t("groupFirstParty") : categoryLabel(group.topCategory);
    ent.textContent = group.entity ? `${group.entity} · ${kind}` : kind;
    sub.appendChild(ent);

    head.dataset["focusKey"] = `group:${group.domain}`;
    head.setAttribute("aria-expanded", String(expandedGroups.has(group.domain)));
    head.addEventListener("click", () => {
      if (expandedGroups.has(group.domain)) expandedGroups.delete(group.domain);
      else expandedGroups.add(group.domain);
      renderRequests();
    });
    list.appendChild(head);
    // Measured once the row is in the list, where it has its width.
    if (group.cookieNames.length > 0) fitNames();

    if (!expandedGroups.has(group.domain)) continue;

    // Every name the domain set, in one place above its requests, each also on the
    // Set-Cookie line of the request that set it. Wrapped, never cut: this is where a name
    // the row could not hold is read (DESIGN.md §10). Names only, never values (FR-24).
    if (group.cookieNames.length > 0) {
      const all = document.createElement("div");
      all.className = "req-detail grp-all-cookies";
      const grid = document.createElement("div");
      grid.className = "req-detail-grid";
      const k = document.createElement("span");
      k.className = "req-detail-key";
      k.textContent = t("reqGroupCookies");
      const v = document.createElement("span");
      v.className = "req-detail-val mono accent";
      appendCookieNames(v, group.cookieNames, group.countedCookieNames, group.functionalCookieNames);
      grid.append(k, v);
      all.appendChild(grid);
      list.appendChild(all);
    }

    for (const row of group.rows) {
    const btn = document.createElement("div");
    btn.className = "req-row";

    const top = document.createElement("div");
    top.className = "req-row-top";

    const label = document.createElement("span");
    label.className = "req-label";
    label.textContent = row.label;

    const marks = document.createElement("span");
    marks.className = "req-marks";
    // Only the exceptions are marked. Nearly every request carries the signal, so marking
    // that would be noise on every row; its ABSENCE is what deserves attention.
    // A lost request's signal was not observed, which is not its absence (1.26.0).
    const absent = gpcAbsentKey(row, "mark");
    if (absent !== null) {
      const m = document.createElement("span");
      m.textContent = t(absent);
      marks.appendChild(m);
    }
    if (row.isRedirectHop) {
      const m = document.createElement("span");
      m.textContent = t("reqRedirect");
      marks.appendChild(m);
    }
    // Cookies set: a deletion or a refused write is named in the detail and not counted here.
    const cookieMark = setCookieMark(row);
    if (cookieMark !== null) {
      const m = document.createElement("span");
      m.className = "req-mark-cookie";
      m.textContent = t(cookieMark.key, cookieMark.substitution);
      marks.appendChild(m);
    }

    top.append(label, marks);
    btn.appendChild(top);

    // Status code and resource type come off the wire and stay monospace; the party
    // classification is our own vocabulary and does not (DESIGN.md §5).
    const meta = document.createElement("div");
    meta.className = "req-meta";
    // A script write has no status and no type on the wire; it says what it is, in words.
    const wire = document.createElement("span");
    if (row.scriptWrite) {
      wire.textContent = t("reqScriptWriteMeta");
    } else {
      wire.className = "mono";
      wire.textContent = `${row.statusCode ?? "—"} · ${row.resourceType}`;
    }
    meta.append(wire, document.createTextNode(" · "));
    if (row.loadedBy) {
      // Who inserted this script, when the records say. Ids and names are identifiers and
      // stay as they are; the surrounding words come from the same strings the vendor rows
      // use, so one fact has one phrasing across the two tabs.
      const by = document.createElement("span");
      by.textContent = loadedViaText(row.loadedBy);
      meta.append(by, document.createTextNode(" · "));
    }
    if (row.entity) {
      meta.appendChild(document.createTextNode(row.entity));
    } else {
      // From messages, as every visible string is, never hardcoded English. A domain the list
      // files under a category with no company shows the category, as its filter does.
      meta.appendChild(
        document.createTextNode(
          row.party === "first"
            ? t("detailFirstParty")
            : row.category === "unknown"
              ? t("reqFilterUncategorized")
              : categoryLabel(row.category),
        ),
      );
    }
    btn.appendChild(meta);

    list.appendChild(btn);

    // Expanded means expanded. Opening a domain and then having to click each request
    // inside it is two decisions for one intention — the reader already said "show me
    // this domain".
    list.appendChild(detailNode(row));
    }
  }
}

function showTab(which: "overview" | "requests"): void {
  const isRequests = which === "requests";
  el("overview-body").hidden = isRequests;
  el("requests-body").hidden = !isRequests;
  el("tab-overview").className = isRequests ? "tab" : "tab active";
  el("tab-requests").className = isRequests ? "tab active" : "tab";
  el("tab-overview").setAttribute("aria-selected", String(!isRequests));
  el("tab-requests").setAttribute("aria-selected", String(isRequests));
  // Drawn here, not by draw(): what draw() remembers of this tab is from when it was last
  // shown, and must not pass for what is on screen now.
  renderedRequests = "";
  if (isRequests) renderRequests();
}

// --- settings ---

interface Settings {
  sendSignal: boolean;
  lockSignal: boolean;
  observePassively: boolean;
  showBadge: boolean;
  checkWellKnown: boolean;
  observeScriptLoading: boolean;
  capReadTraces: boolean;
  checkConfirmation: boolean;
  firstRunComplete: boolean;
  returningUser: boolean;
}

const FALLBACK_SETTINGS: Settings = {
  sendSignal: true,
  lockSignal: false,
  observePassively: true,
  showBadge: true,
  checkWellKnown: true,
  observeScriptLoading: true,
  capReadTraces: true,
  checkConfirmation: true,
  firstRunComplete: false,
  returningUser: false,
};

/**
 * Read settings.
 *
 * Throws on storage failure rather than returning defaults. Returning them would render
 * the DEFAULTS as though they were the user's choices — showing "sending on" to someone
 * who turned it off, and re-showing the first-run screen to someone who has already
 * dismissed it. Callers decide what to do with not knowing; this function does not decide
 * it for them by guessing.
 */
async function getSettings(): Promise<Settings> {
  const got = await chrome.storage.local.get("settings");
  return { ...FALLBACK_SETTINGS, ...((got["settings"] ?? {}) as Partial<Settings>) };
}

/**
 * The worker's count of loads that got one half of the signal and not the other, read for
 * the bug report (SIGNAL_SPLIT_KEY and readSignalSplitCounts in background/state.ts; read
 * here the same way, so the popup bundle stays clear of the worker's module). Zero where
 * nothing was stored.
 */
async function getSignalSplitCounts(): Promise<{ headerWithoutProperty: number; propertyWithoutHeader: number }> {
  const got = await chrome.storage.local.get("signalSplit");
  const stored = (got["signalSplit"] ?? {}) as Record<string, unknown>;
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  return { headerWithoutProperty: n(stored["headerWithoutProperty"]), propertyWithoutHeader: n(stored["propertyWithoutHeader"]) };
}

/**
 * The setting writes, one at a time. Each reads the whole object, changes one key and writes
 * it back; two such writes running at once, from two switches pressed in quick succession,
 * would both read the old object, and the second would undo the first while its switch
 * still showed the change.
 */
let settingWrites: Promise<void> = Promise.resolve();

function setSetting(patch: Partial<Settings>): Promise<void> {
  const write = settingWrites.then(() => writeSetting(patch));
  settingWrites = write.catch(() => undefined);
  return write;
}

async function writeSetting(patch: Partial<Settings>): Promise<void> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  // Tell the worker directly. storage.onChanged is not a dependable wake-up for a
  // terminated MV3 worker, and a setting that only takes effect when the worker happens to
  // be awake is a setting that does not work.
  try {
    await chrome.runtime.sendMessage({ type: "settings-changed" });
  } catch {
    // Worker unreachable. The next popup open reconciles, since get-signal-status
    // re-applies the policy before answering.
  }
}

function bindSwitch(id: string, get: (s: Settings) => boolean, key: keyof Settings): void {
  const node = el<HTMLButtonElement>(id);
  node.addEventListener("click", async () => {
    if (node.disabled) return;
    const next = node.getAttribute("aria-checked") !== "true";
    node.setAttribute("aria-checked", String(next));
    await setSetting({ [key]: next } as Partial<Settings>);
  });
  void getSettings()
    .then((s) => node.setAttribute("aria-checked", String(get(s))))
    .catch(() => {
      // Unreadable: disable rather than showing a state we cannot vouch for. A toggle that
      // displays the wrong position invites the user to "fix" a setting that was never
      // wrong.
      node.disabled = true;
    });
}

async function renderSettings(native: ReturnType<typeof nativeSendSetting>): Promise<void> {
  try {
    const s = await getSettings();
    el("tg-send").setAttribute("aria-checked", String(s.sendSignal));
    el("tg-lock").setAttribute("aria-checked", String(s.lockSignal));
    el<HTMLButtonElement>("tg-lock").disabled = !s.sendSignal;
    el("tg-badge").setAttribute("aria-checked", String(s.showBadge));
    el("tg-wellknown").setAttribute("aria-checked", String(s.checkWellKnown));
    el("tg-scripts").setAttribute("aria-checked", String(s.observeScriptLoading));
    el("tg-trace").setAttribute("aria-checked", String(s.capReadTraces));
    el("tg-confirmation").setAttribute("aria-checked", String(s.checkConfirmation));
  } catch {
    // Rather than showing the toggles in positions we cannot vouch for, disable them.
    for (const id of ["tg-send", "tg-lock", "tg-badge", "tg-wellknown", "tg-scripts", "tg-trace", "tg-confirmation"]) {
      el<HTMLButtonElement>(id).disabled = true;
    }
  }

  // Post AB 566 Chrome sends the signal itself. The toggle goes INERT rather than
  // disappearing: a control that vanishes reads as a bug, and turning ours off never
  // disables a signal owned by Chrome or another extension. A browser that has the signal
  // off leaves the toggle usable: it still governs our own header.
  if (native) {
    if (native.inert) el<HTMLButtonElement>("tg-send").disabled = true;
    el("send-desc").textContent = t(native.descKey);
  }

  // Where our signal does not reach, by the reader's settings in the browser: sites the
  // site access setting leaves out, and private windows until the reader allows the
  // extension there. Only while we send: with sending off there is no signal to miss them.
  // Read again here, since either can change in the browser while the popup is open.
  const reach = await fetchSignalStatus();
  const sendingNow = reach?.sending === true && native?.inert !== true;
  el("send-access").hidden = !(sendingNow && reach?.allSites === false);
  el("send-incognito").hidden = !(sendingNow && reach?.incognito === false);

  const manifest = chrome.runtime.getManifest();
  el("version").textContent = t("aboutVersion", manifest.version);

  el<HTMLAnchorElement>("link-repo").href = REPO_URL;
  el("about-license-desc").textContent = t("aboutLicenseDesc", [CODE_LICENSE, COPYRIGHT]);
  el<HTMLAnchorElement>("link-code-license").href = CODE_LICENSE_URL;

  // The list's full credit: version and the fingerprint of the upstream file, so a disputed
  // category can be checked against the exact file that produced it.
  const list = getClassifier().provenance;
  el("about-list-desc").textContent = t("aboutListDesc", [list.version, list.hash.slice(0, 12)]);
  el<HTMLAnchorElement>("link-list").href = LIST_SOURCE_URL;
  el<HTMLAnchorElement>("link-list-license").href = LIST_LICENSE_URL;

  // The list of functional cookie names, credited where Disconnect's is: what it was
  // compiled from, at which commit, under which license, and that this extension changed it.
  const functional = getFunctionalCookies().provenance;
  el("about-functional-desc").textContent = t("aboutFunctionalListDesc", [functional.commit.slice(0, 7), functional.version]);
  el<HTMLAnchorElement>("link-functional").href = FUNCTIONAL_SOURCE_URL;
  el<HTMLAnchorElement>("link-functional-license").href = FUNCTIONAL_LICENSE_URL;
}

// --- boot ---

async function main(): Promise<void> {
  applyStaticI18n();
  el<HTMLAnchorElement>("link-limitations").href = LIMITATIONS_URL;

  let settings: Settings;
  try {
    settings = await getSettings();
  } catch {
    // Settings are unreadable. Show the overview rather than the first-run screen: the
    // user may well have dismissed it already, and re-showing it would assert they had
    // not. Toggles will read their fallback values, which the settings screen surfaces.
    show("overview");
    await load();
    return;
  }

  if (!settings.firstRunComplete) {
    show("firstrun");
    if (settings.returningUser) void showFirstRunSignalLine(settings);
    el("fr-accept").addEventListener("click", async () => {
      await setSetting({ firstRunComplete: true });
      show("overview");
      await load();
    });
    return;
  }

  show("overview");
  await load();
}

/**
 * The line under the first-run title, for a profile carried over from v0.1.4.
 *
 * Chosen from the live state, never from what the migration did. When the state cannot be
 * read, or the setting and the rule disagree, no line is shown: the status row says what
 * is set as soon as the screen is dismissed, and a guess here would be the first thing a
 * returning user reads.
 */
async function showFirstRunSignalLine(settings: Settings): Promise<void> {
  let key: string | null = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const observations = await fetchObservations(tab?.id);
    const native = nativeFirstRunKey(observations?.signal);
    if (native !== null) {
      key = native;
    } else {
      const sending = (await fetchSignalStatus())?.sending;
      if (sending === true) key = "firstRunSignalOn";
      else if (sending === false && !settings.sendSignal) key = "firstRunSignalOff";
    }
  } catch {
    key = null;
  }
  if (key === null) return;
  const line = el("fr-signal");
  line.textContent = t(key);
  line.hidden = false;
}

/**
 * Signal state that does not depend on observing the page.
 *
 * Returns null when the worker could not be reached. That is NOT the same as "sending is
 * off", and collapsing the two makes a real misstatement: with session storage exhausted,
 * the popup would tell the user "GPC signal is not set / sending off in settings" on a page
 * where the header was in fact being sent. An unreachable worker means we do not know, and
 * the UI says so.
 */
async function fetchSignalStatus(): Promise<OwnSignal | null> {
  try {
    const r = (await chrome.runtime.sendMessage({ type: "get-signal-status" })) as
      | {
          sendSignal: boolean;
          ruleInstalled: boolean;
          scriptsRegistered?: boolean;
          allSitesAccess?: boolean;
          incognitoAccess?: boolean;
        }
      | undefined;
    if (r === undefined) return null;
    return {
      // Both halves: the header rule and the registration of the script that sets the page
      // property. A worker that does not say (an older one) is taken to have the scripts.
      sending: r.sendSignal === true && r.ruleInstalled === true && r.scriptsRegistered !== false,
      // A worker that does not say is taken to have both, so no line claims a limit.
      allSites: r.allSitesAccess !== false,
      incognito: r.incognitoAccess !== false,
    };
  } catch {
    return null;
  }
}

/** What fetchSignalStatus reads: whether we send, and where the browser lets it reach. */
interface OwnSignal {
  readonly sending: boolean;
  /** The browser grants this extension every site (its site access setting is "On all sites"). */
  readonly allSites: boolean;
  /** The reader allowed this extension in private windows. */
  readonly incognito: boolean;
}

/**
 * Whether the browser grants this extension the page's site, or undefined where that is not
 * asked (not a web page) or the browser cannot say.
 *
 * The site's grant only. With site access "On click", clicking this extension's icon also
 * allows it on the site in that one tab, which chrome.permissions.contains does not report,
 * and nothing asks the tab without side effects: a script injected there is held, not
 * refused, until the reader grants access. The strings for a withheld site therefore speak
 * of the page as it loaded, and say to reload after a click.
 */
async function fetchPageAccess(address: string | undefined): Promise<boolean | undefined> {
  const pattern = accessPatternOf(address);
  if (pattern === null) return undefined;
  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    return undefined;
  }
}

async function fetchObservations(tabId: number | undefined): Promise<ObservationSet | null> {
  if (tabId === undefined) return null;
  try {
    return (await chrome.runtime.sendMessage({
      type: "get-observations",
      tabId,
    })) as ObservationSet | null;
  } catch {
    return null;
  }
}

/**
 * The followed tab's address (panel.ts, tabAddress), read on every refresh: the panel's tab
 * changes page under it. Undefined for a tab that has closed or cannot be read, and the
 * record then decides whether the page can be inspected.
 */
async function fetchTabAddress(tabId: number | undefined): Promise<string | undefined> {
  if (tabId === undefined) return undefined;
  try {
    return tabAddress(await chrome.tabs.get(tabId));
  } catch {
    return undefined;
  }
}

/**
 * Is there enough to describe the page yet?
 *
 * Gates only the PENDING state, not rendering. A page with a topSite but no requests has
 * genuinely nothing to say yet, and calling that "no advertising domains" would assert an
 * absence we have not established. Once anything has arrived we render it and let the
 * refresh fill in the rest.
 *
 * Not asked of a null record. The worker answers every tab it can reach with a record, so
 * null means it could not be reached or there was no tab, and waiting changes neither:
 * counted as "nothing yet", it would hold "Checking this page" for as long as the popup
 * stayed open, and stateNoData would never be shown.
 */
function hasSomethingToShow(obs: ObservationSet): boolean {
  if (obs.context.topSite === "") return true; // ineligible page: nothing more is coming
  // Nor here: the load was not observed, and waiting will not observe it. Without this the
  // popup would sit on "checking" for as long as the tab stayed open.
  if (obs.context.loadObserved === false) return true;
  // Nor for a page that did not load: its error page reports nothing, and a load another
  // extension blocked made no request at all, so there may be neither a list nor counts.
  if (obs.context.loadError) return true;
  // The counts survive a worker reclaim that empties the list, and are enough to show.
  return obs.network.length > 0 || isTallied(obs.tallies);
}

// --- what is on screen, and keeping it current ---

/** The tab whose page is shown, and the window this page belongs to (panel.ts). */
let followed: Followed = { windowId: undefined, tabId: undefined };
/**
 * Our own state, which the Overview shows beside the page's: whether the signal is being
 * sent, and whether the published-file check is on. Null until first read.
 */
let ownState: { sending: boolean | null; checkWellKnown: boolean } | null = null;
/**
 * The page and the views last drawn. A refresh that would draw the same thing draws
 * nothing: the panel is told about every write to the tab's record, and most of them
 * change no word on screen.
 */
let renderedPage = "";
let renderedOverview = "";
let renderedRequests = "";

async function readOwnState(): Promise<void> {
  const own = await fetchSignalStatus();
  // Settings failure falls back to the documented default (checkWellKnown: true) via
  // FALLBACK_SETTINGS rather than throwing here — the row can afford to guess "on" for one
  // frame; getSettings() already logs/throws where that guess matters more (see its doc).
  const settings = await getSettings().catch(() => FALLBACK_SETTINGS);
  ownState = { sending: own === null ? null : own.sending, checkWellKnown: settings.checkWellKnown };
}

/**
 * The view of a record. `address` is the tab's, for whether the page can be inspected at all;
 * the download screen leaves it out, since it opens only on a page that can be.
 */
function viewOf(observations: ObservationSet | null, address?: string, pageAccess?: boolean): PopupView {
  const sending = ownState?.sending ?? null;
  return buildPopupView({
    // Findings, counts and the classification closures, from one place shared with the
    // corpus replay test (view-input.ts).
    ...classifiedInput(observations, { classifier: getClassifier(), owners: getOwnerNames(), isListedFunctional }),
    // Only ever called with the worker's answer, so a null here is no-data, not pending.
    pending: observations !== null && !hasSomethingToShow(observations),
    checkWellKnownEnabled: ownState?.checkWellKnown ?? FALLBACK_SETTINGS.checkWellKnown,
    sendingSignal: sending ?? false,
    signalKnown: sending !== null,
    ...(address !== undefined ? { tabAddress: address } : {}),
    ...(pageAccess !== undefined ? { pageAccess } : {}),
  });
}

/** Whichever element scrolls: the two tab bodies in the panel, the document in the popup. */
function scrollers(): Element[] {
  const list: Element[] = [el("overview-body"), el("requests-body")];
  if (document.scrollingElement) list.push(document.scrollingElement);
  return list;
}

/** The row holding keyboard focus, by what it is rather than by which node it is. */
function focusedKey(): string | null {
  const active = document.activeElement;
  return active instanceof HTMLElement ? (active.dataset["focusKey"] ?? null) : null;
}

function restoreFocus(key: string | null): void {
  if (key === null) return;
  for (const node of Array.from(document.querySelectorAll<HTMLElement>("[data-focus-key]"))) {
    if (node.dataset["focusKey"] === key) {
      node.focus({ preventScroll: true });
      return;
    }
  }
}

/**
 * Draw a view, keeping the reader's place when it is the page they were already reading.
 *
 * The renderers rebuild their lists, so a refresh would otherwise send the scroll to the
 * top and drop keyboard focus, several times over while a page loads. On the same page both
 * are put back, and the open rows are kept by the sets the renderers already consult. On a
 * different page nothing is kept: what was open belonged to the page before, and so does a
 * download screen or finding report open over the Overview (closeForPageChange).
 */
function draw(view: PopupView, page: string): void {
  const samePage = page === renderedPage;
  if (!samePage) {
    expandedGroups.clear();
    expandedVendors.clear();
    openStringRows.clear();
    firstPartyOpen = false;
    activeFilter = "all";
  }

  latestView = view;
  const requestsShown = !el("requests-body").hidden;
  const overview = JSON.stringify(view);
  const requestsView = requestsShown
    ? buildRequestsView(latestObservations, getClassifier(), activeFilter, undefined, isListedFunctional, getOwnerNames())
    : null;
  const requests = requestsView === null ? "" : JSON.stringify(requestsView);
  // Before anything can return early: the count is on the tab's label, which is on screen
  // whichever tab is open, and it changes while the Overview does not. The list's own count
  // when it was just built, so the requests are not walked twice.
  const count = requestsView?.counts.all ?? requestCount(latestObservations);
  el("tab-requests-count").textContent = count > 0 ? String(count) : "";
  const overviewChanged = !samePage || overview !== renderedOverview;
  const requestsChanged = requestsShown && (!samePage || requests !== renderedRequests);
  renderedPage = page;
  renderedOverview = overview;
  if (requestsShown) renderedRequests = requests;
  if (!overviewChanged && !requestsChanged) return;

  const focused = focusedKey();
  const places = scrollers().map((node) => (samePage ? node.scrollTop : 0));
  if (overviewChanged) render(view);
  if (requestsChanged) renderRequests();
  scrollers().forEach((node, i) => {
    node.scrollTop = places[i] ?? 0;
  });
  restoreFocus(focused);
  if (!samePage) closeForPageChange();
}

/**
 * A screen open over the Overview when the page shown changes under it, which only the
 * panel sees: the download screen and a finding report close to the new page's Overview
 * (closesOnPageChange).
 */
function closeForPageChange(): void {
  const open = pendingExport !== null ? "export" : pendingReport?.kind;
  if (open === undefined || !closesOnPageChange(open)) return;
  pendingExport = null;
  pendingReport = null;
  show("overview");
}

/**
 * Ask the worker for the followed tab's record and draw it.
 *
 * `own` also reads our own state again: whether the signal is being sent, and the settings
 * the Overview shows. That read makes the worker reconcile its rule with the setting, so it
 * is asked for when something could have changed it (a different tab, a navigation, a
 * setting) and not on every write to the tab's record.
 */
async function refresh(own: boolean): Promise<void> {
  const tabId = followed.tabId;
  if (own || ownState === null) await readOwnState();

  // Render whatever has arrived, immediately.
  //
  // No polling for a complete answer first, with "Checking this page" on screen the whole
  // time: on a heavy page (news-g produced 479 requests) that withholds data the popup
  // already has. Holding back a partial answer to wait for a complete one is the wrong
  // trade: in the panel the next refresh fills in what arrives late, and in the popup a
  // partial answer is still the better one.
  const [observations, address] = await Promise.all([fetchObservations(tabId), fetchTabAddress(tabId)]);
  const pageAccess = await fetchPageAccess(address);
  // The reader moved to another tab while the worker was answering. This answer is for a
  // page no longer shown; the refresh the switch asked for draws the right one.
  if (tabId !== followed.tabId) return;

  const view = viewOf(observations, address, pageAccess);
  // A page the extension cannot inspect has no record to show anywhere: not as a count on
  // the Requests tab, not in a download, not in a report.
  latestObservations = view.state === "ineligible" ? null : observations;
  draw(view, pageIdentity(tabId, observations));
}

// --- the panel: following the active tab ---

/**
 * At most one refresh per this many milliseconds while a page loads. The worker writes a
 * tab's record every 120ms under load (state.ts, FLUSH_MS); drawing at that rate would move
 * the list under the reader four times as often as they could read it.
 */
const REFRESH_MS = 500;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let refreshing = false;
/** What has been asked for and not yet drawn: nothing, the page's record, or our own state too. */
let owed: "none" | "page" | "all" = "none";

/**
 * Ask for a refresh. `own` as in refresh(); `now` skips the wait, for a change the reader
 * made themselves (another tab, a navigation) and is waiting to see.
 */
function requestRefresh(own: boolean, now: boolean): void {
  if (own) owed = "all";
  else if (owed === "none") owed = "page";
  // A panel the reader cannot see draws nothing. What is owed is drawn when it is shown.
  if (document.hidden) return;
  if (now) {
    if (refreshTimer !== undefined) clearTimeout(refreshTimer);
    refreshTimer = undefined;
    void runOwed();
    return;
  }
  if (refreshTimer !== undefined) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    void runOwed();
  }, REFRESH_MS);
}

/** One refresh at a time. Whatever is asked for while it runs is drawn after it. */
async function runOwed(): Promise<void> {
  if (refreshing || owed === "none" || document.hidden) return;
  const own = owed === "all";
  owed = "none";
  refreshing = true;
  try {
    await refresh(own);
  } finally {
    refreshing = false;
  }
  // Read through a function: the listeners set `owed` while the refresh was awaited, which
  // the compiler cannot see from here.
  const since = owedNow();
  if (since === "all") void runOwed();
  else if (since === "page") requestRefresh(false, false);
}

function owedNow(): typeof owed {
  return owed;
}

/**
 * Keep the panel on its window's active tab, and current with that tab's record.
 *
 * Panel only. The popup is read once and closed; it cannot outlive a tab switch.
 *
 * No timer polls the worker. The worker writes each tab's record to session storage as it
 * changes, and that write is what the panel listens for, so a page that has gone quiet
 * costs nothing and the worker is not kept awake by a panel left open.
 */
function follow(): void {
  chrome.tabs.onActivated.addListener((info) => {
    const next = followOnActivated(followed, info);
    if (next === null) return;
    followed = { ...followed, tabId: next };
    requestRefresh(true, true);
  });

  // A discarded tab that is restored, or a prerendered page that is shown, keeps its place
  // in the window under a new id.
  chrome.tabs.onReplaced.addListener((added, removed) => {
    if (removed !== followed.tabId) return;
    followed = { ...followed, tabId: added };
    requestRefresh(true, true);
  });

  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (isNavigationOf(followed, tabId, change)) requestRefresh(true, true);
  });

  chrome.storage.session.onChanged.addListener((changes) => {
    if (touchesFollowed(followed, Object.keys(changes))) requestRefresh(false, false);
  });

  // A setting changed, here or in the popup while the panel was open.
  chrome.storage.local.onChanged.addListener((changes) => {
    if ("settings" in changes) requestRefresh(true, false);
  });

  // The browser's site access setting changed: the page shown may have become reachable or
  // stopped being so.
  chrome.permissions.onAdded.addListener(() => requestRefresh(true, false));
  chrome.permissions.onRemoved.addListener(() => requestRefresh(true, false));

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void runOwed();
  });
}

// --- controls ---

/**
 * The button that opens the side panel, in the popup's header.
 *
 * chrome.sidePanel.open arrived in Chrome 116, two versions after the panel itself. Where it
 * is missing the panel is still there, opened from the browser's own side panel menu; a
 * button that cannot open it is not shown, because a dead control is worse than a missing one.
 */
function bindOpenPanel(): void {
  const windowId = followed.windowId;
  if (HOST !== "popup" || windowId === undefined) return;
  if (typeof chrome.sidePanel?.open !== "function") return;
  const btn = el("to-panel");
  btn.hidden = false;
  btn.addEventListener("click", () => {
    // Nothing is awaited before this call. Chrome allows open() only while it can still
    // see the click that asked for it, which is also why the window id was read at load.
    chrome.sidePanel.open({ windowId }).then(
      () => window.close(),
      () => {
        btn.hidden = true;
      },
    );
  });
}

/** Bound once. Every handler reads the latest record, since the panel outlives the first. */
function bindControls(): void {
  el("tab-overview").addEventListener("click", () => showTab("overview"));
  el("tab-requests").addEventListener("click", () => showTab("requests"));

  el("req-copy").addEventListener("click", () => {
    const view = buildRequestsView(latestObservations, getClassifier(), activeFilter, undefined, isListedFunctional, getOwnerNames());
    void navigator.clipboard.writeText(rowsToText(view)).then(() => {
      const btn = el("req-copy");
      const original = btn.textContent;
      btn.textContent = t("reqCopied");
      setTimeout(() => {
        btn.textContent = original;
      }, 1200);
    });
  });

  el("report-back").addEventListener("click", () => {
    pendingReport = null;
    pendingExport = null;
    show("overview");
  });
  el("report-cancel").addEventListener("click", () => {
    pendingReport = null;
    show("overview");
  });
  el("report-download").addEventListener("click", () => downloadFullBundle());
  el("report-open").addEventListener("click", () => void submitPendingReport());

  reportFinding = () => {
    if (!latestObservations) return;
    // The record as it stands at the press. In the panel a later refresh may replace it
    // while the report is being built.
    const obsNow = latestObservations;
    void (async () => {
      // A report goes to a public issue tracker, so it is masked and no setting is
      // consulted: a session cookie pasted into a GitHub issue cannot be taken back, and
      // nothing the engine concludes depends on a value.
      const bundle = await sealEvidence(obsNow, true);
      confirmReport({
        kind: "finding",
        environment: environment(),
        observations: bundle.observations,
        bundle,
      });
    })();
  };

  el("btn-wrong").addEventListener("click", () => reportFinding());

  el("btn-export").addEventListener("click", () => {
    if (latestObservations) openExport(latestObservations);
  });
  for (const b of EXPORT_BUTTONS) {
    el(b.id).addEventListener("click", () => void saveExportFile(b.file));
  }

  // Every setting, the hidden observe switch's included, and nothing about the current tab.
  // With them, how often a page load got one half of the signal and not the other
  // (SIGNAL_SPLIT_KEY in background/state.ts): a count over the profile, naming no page.
  el("btn-report-bug").addEventListener("click", () => {
    void Promise.all([getSettings(), getSignalSplitCounts()])
      .then(([s2, split]) =>
        confirmReport({
          kind: "bug",
          environment: environment(),
          settingsSummary:
            `send=${s2.sendSignal} lock=${s2.lockSignal} observe=${s2.observePassively} badge=${s2.showBadge} wellknown=${s2.checkWellKnown}` +
            ` observeScriptLoading=${s2.observeScriptLoading} capReadTraces=${s2.capReadTraces}` +
            ` checkConfirmation=${s2.checkConfirmation}` +
            ` headerWithoutProperty=${split.headerWithoutProperty} propertyWithoutHeader=${split.propertyWithoutHeader}`,
        }),
      )
      .catch(() =>
        confirmReport({
          kind: "bug",
          environment: environment(),
          settingsSummary: "unreadable",
        }),
      );
  });

  el("btn-report-feature").addEventListener("click", () => {
    confirmReport({ kind: "feature", environment: environment() });
  });

  el("to-settings").addEventListener("click", async () => {
    show("settings");
    await renderSettings(nativeSendSetting(latestObservations?.signal));
  });
  el("to-overview").addEventListener("click", () => show("overview"));

  bindSwitch("tg-send", (s) => s.sendSignal, "sendSignal");
  bindSwitch("tg-lock", (s) => s.lockSignal, "lockSignal");
  // The lock only acts on our own signal, so it is inert while sending is off.
  el("tg-send").addEventListener("click", () => {
    el<HTMLButtonElement>("tg-lock").disabled = el("tg-send").getAttribute("aria-checked") !== "true";
  });
  bindSwitch("tg-badge", (s) => s.showBadge, "showBadge");
  bindSwitch("tg-wellknown", (s) => s.checkWellKnown, "checkWellKnown");
  bindSwitch("tg-scripts", (s) => s.observeScriptLoading, "observeScriptLoading");
  bindSwitch("tg-trace", (s) => s.capReadTraces, "capReadTraces");
  bindSwitch("tg-confirmation", (s) => s.checkConfirmation, "checkConfirmation");
}

async function load(): Promise<void> {
  // The same query in both hosts: for the popup and for the panel, the current window is
  // the browser window the page is attached to.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const windowId =
    tab?.windowId ??
    (await chrome.windows.getCurrent().then(
      (w) => w.id,
      () => undefined,
    ));
  followed = { windowId, tabId: tab?.id };
  const firstAddress = tab === undefined ? undefined : tabAddress(tab);

  // Render what is already known before asking about the page at all: whether we are
  // sending is our own state. A blank frame while a page loads tells the user nothing and
  // looks broken.
  await readOwnState();
  render(
    buildPopupView({
      observations: null,
      findings: [],
      distinctCookies: 0,
      adTechRequests: 0,
      pending: true,
      sendingSignal: ownState?.sending ?? false,
      signalKnown: ownState !== null && ownState.sending !== null,
      checkWellKnownEnabled: ownState?.checkWellKnown ?? FALLBACK_SETTINGS.checkWellKnown,
      // The first frame already knows a page that cannot be inspected: no record changes that.
      ...(firstAddress !== undefined ? { tabAddress: firstAddress } : {}),
    }),
  );

  await refresh(false);

  bindControls();
  bindOpenPanel();
  if (HOST === "panel") follow();
}

void main();
