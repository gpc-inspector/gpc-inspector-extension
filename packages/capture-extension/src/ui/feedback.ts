// SPDX-License-Identifier: GPL-3.0-only
/**
 * Feedback to GitHub (PRD D7, FR-24).
 *
 * Three report kinds sharing one mechanism, differing in what they carry — and that
 * difference is the point. A finding report is page-scoped and needs evidence; a bug report
 * is about the extension and must carry no page data at all. A "report a bug" button that
 * quietly uploaded a record of someone's browsing would be worse than having no bug
 * reporting, and this is a privacy tool.
 *
 * WHAT NEVER HAPPENS HERE. Nothing is transmitted. This module assembles text and a URL;
 * the user reads the payload, decides, and submits to a public tracker themselves. There is
 * no endpoint on our side to receive anything (D7: no email intake of bundles).
 *
 * THE SIZE CONSTRAINT shapes the design. GitHub's prefill is carried in the URL and caps
 * out around 8KB in practice, while an evidence bundle from a 630-request page is far
 * past that. So the issue body carries a SUMMARY and the full bundle goes to the clipboard
 * for the user to paste. That also happens to be the safer arrangement: a bundle in a URL
 * ends up in browser history and server logs, and a bundle on the clipboard does not.
 */

import type { EvidenceBundle, KeptCookieResponse, NetworkObservation, ObservationSet } from "@gpc-inspector/schema";
import { lostKeptRecords } from "@gpc-inspector/schema";
import { gotNoAnswer } from "../observe/well-known.js";

export type ReportKind = "finding" | "bug" | "feature";

/**
 * Character budget for the bundle pasted into a GitHub issue.
 *
 * GitHub rejects an issue body over 65,536 characters, and a bundle from a 630-request page
 * is 402,761 pretty-printed — six times over. Compacting saves 30% and is not close to
 * enough.
 *
 * So the pasted bundle is TRIMMED and the full one is offered as a file attachment. The
 * budget leaves room for the summary and the surrounding issue template.
 */
export const MAX_BUNDLE_CHARS = 55_000;

/**
 * Trim a bundle to what triage needs.
 *
 * Keeps every observation a finding refers to, then cookie-setting observations, then the
 * kept records of cookie-setting requests a worker reclaim took from the list (1.27.0), then
 * ordinary ones until the budget runs out. That ordering follows what triage needs: a
 * report about a wrong finding needs the evidence for that finding, and a report about a
 * missed one needs the cookies.
 *
 * The COUNTS are unaffected — tallies travel whole, so a trimmed bundle still reproduces
 * every number the extension displayed. Only the enumeration is partial, and the bundle
 * says so rather than appearing complete.
 *
 * Except the cookie details (1.22.0), which grow with distinct cookies and can alone pass
 * the budget on a heavy page. When the tallies do not fit with no requests at all, the
 * details go too, in two steps: first those of cookies the headline does not count, then
 * the rest. The findings already name each counted cookie and the request that set it, and
 * the bundle says `cookieDetailsTruncated`.
 *
 * And the two provenance lists, `requestInitiators` and `scriptInsertions`, which grow
 * with the page's scripts: on a news front page they alone came to 93,000 characters
 * (2026-09-28), so the copy could not be pasted at all. Over budget they are cut to a
 * share of it, insertions first since the loader rows are resolved from them, and the
 * bundle says `provenanceTruncated`. The saved file carries both whole.
 */
export function trimBundleForIssue(
  bundle: EvidenceBundle,
  budget: number = MAX_BUNDLE_CHARS,
): { json: string; trimmed: boolean; kept: number; total: number; detailsCut: boolean; provenanceCut: boolean } {
  const full = JSON.stringify(bundle);
  const net = bundle.observations.network;
  // The kept cookie records (1.27.0) of requests the list lost with a worker reclaim. They
  // are requests as the Requests tab lists them, and are counted and trimmed as requests.
  // The other kept records repeat an observation in `network`, and a trimmed bundle leaves
  // them out: on a heavy page they alone passed the budget, and nothing else fit. So does a
  // record whose sets were all probes, which the Requests tab does not list either.
  const lost = lostKeptRecords(bundle.observations);
  const total = net.length + lost.length;
  if (full.length <= budget) return { json: full, trimmed: false, kept: total, total, detailsCut: false, provenanceCut: false };

  const hasKept = bundle.observations.keptCookieResponses !== undefined;
  const bare: EvidenceBundle = hasKept ? { ...bundle, observations: { ...bundle.observations, keptCookieResponses: [] } } : bundle;
  const capped = cappedProvenance(bare, Math.floor(budget * PROVENANCE_SHARE));
  // The smallest form of the tallies whose bundle, with no requests, fits.
  const base = fittingTallies(capped, budget);
  // Trimmed if anything was left out: the requests, the cookie details, the provenance
  // lists, or any of them together. Details cut with every request kept is still a bundle
  // the person should attach in full.
  const detailsCut = base !== capped;
  const provenanceCut = capped !== bare;

  const referenced = new Set<string>();
  for (const f of bundle.findings) {
    if (f.artifact.kind === "cookie") referenced.add(f.artifact.observationId);
  }

  // The lost cookie-setting requests after the ones still in the list, and before the
  // requests that set nothing.
  type Entry = { readonly obs: NetworkObservation } | { readonly lost: KeptCookieResponse };
  const tiers: Entry[][] = [
    net.filter((o) => referenced.has(o.id)).map((obs) => ({ obs })),
    net.filter((o) => !referenced.has(o.id) && o.setCookies.length > 0).map((obs) => ({ obs })),
    lost.map((k) => ({ lost: k })),
    net.filter((o) => !referenced.has(o.id) && o.setCookies.length === 0).map((obs) => ({ obs })),
  ];

  const keptNet: NetworkObservation[] = [];
  const keptLost: KeptCookieResponse[] = [];
  const withRequests = (network: readonly NetworkObservation[], keptCookieResponses: readonly KeptCookieResponse[]): string =>
    JSON.stringify({
      ...base,
      observations: { ...base.observations, network, ...(hasKept ? { keptCookieResponses } : {}) },
      ...(network.length < net.length ? { networkTruncated: true } : {}),
      ...(keptCookieResponses.length < lost.length ? { keptCookieResponsesTruncated: true } : {}),
    });
  const result = (): ReturnType<typeof trimBundleForIssue> => {
    const kept = keptNet.length + keptLost.length;
    return { json: withRequests(keptNet, keptLost), trimmed: kept < total || detailsCut || provenanceCut, kept, total, detailsCut, provenanceCut };
  };

  for (const tier of tiers) {
    for (const e of tier) {
      const network = "obs" in e ? [...keptNet, e.obs] : keptNet;
      const keptCookieResponses = "lost" in e ? [...keptLost, e.lost] : keptLost;
      if (withRequests(network, keptCookieResponses).length > budget) return result();
      if ("obs" in e) keptNet.push(e.obs);
      else keptLost.push(e.lost);
    }
  }
  return result();
}

/** The part of the budget the two provenance lists may take when the bundle is over it. */
const PROVENANCE_SHARE = 0.4;

/**
 * The bundle with its provenance lists cut to `allowance` characters between them: each
 * keeps the entries from its start that fit, insertions served first. Returned as it came
 * when both already fit.
 */
function cappedProvenance(
  bundle: EvidenceBundle,
  allowance: number,
): EvidenceBundle & { provenanceTruncated?: true } {
  const obs = bundle.observations;
  let left = allowance;
  let cut = false;
  const fit = <T>(list: readonly T[] | undefined): readonly T[] | undefined => {
    if (list === undefined) return undefined;
    const out: T[] = [];
    for (const item of list) {
      const size = JSON.stringify(item).length + 1;
      if (size > left) break;
      left -= size;
      out.push(item);
    }
    if (out.length < list.length) cut = true;
    return out;
  };
  const scriptInsertions = fit(obs.scriptInsertions);
  const requestInitiators = fit(obs.requestInitiators);
  if (!cut) return bundle;
  return {
    ...bundle,
    observations: {
      ...obs,
      ...(scriptInsertions === undefined ? {} : { scriptInsertions }),
      ...(requestInitiators === undefined ? {} : { requestInitiators }),
    },
    provenanceTruncated: true,
  };
}

/**
 * The bundle with its cookie details cut back until it fits with no requests: whole, then
 * only the counted keys', then none. The last is returned even if it does not fit.
 */
function fittingTallies(bundle: EvidenceBundle, budget: number): EvidenceBundle & { cookieDetailsTruncated?: true } {
  const t = bundle.observations.tallies;
  const details = t.cookieDetails;
  const bare = (tallies: typeof t, truncated: boolean) => ({
    ...bundle,
    observations: { ...bundle.observations, tallies, network: [] },
    ...(truncated ? { cookieDetailsTruncated: true as const } : {}),
  });
  if (details === undefined || JSON.stringify(bare(t, false)).length <= budget) return bundle;
  const counted = new Set([...t.adCookieKeys, ...(t.adCookieKeysUnsigned ?? [])]);
  const countedOnly = { ...t, cookieDetails: Object.fromEntries(Object.entries(details).filter(([k]) => counted.has(k))) };
  const chosen = JSON.stringify(bare(countedOnly, true)).length <= budget ? countedOnly : (({ cookieDetails: _all, ...rest }) => rest)(t);
  return { ...bundle, observations: { ...bundle.observations, tallies: chosen }, cookieDetailsTruncated: true };
}

/** Practical ceiling for a prefilled GitHub issue URL. */
export const MAX_URL_LENGTH = 7000;

export interface Environment {
  readonly extensionVersion: string;
  readonly browser: string;
  readonly os: string;
  readonly listSource: string;
  readonly listVersion: string;
  /** The list of functional cookie names, as "source commit". Absent in older callers. */
  readonly functionalList?: string;
  /**
   * The Public Suffix List, as "version commit": it decides first or third party and the
   * domain a finding names, so a new one can move either. Absent in older callers.
   */
  readonly publicSuffixList?: string;
}

export interface FindingReportInput {
  readonly kind: "finding";
  readonly environment: Environment;
  /** The observation set behind the disputed finding, already redacted. */
  readonly observations: ObservationSet;
  /**
   * The full bundle, offered via clipboard rather than URL. Must be sealed as "redacted":
   * a report goes to a public tracker and `buildReport` refuses any other state.
   */
  readonly bundle: EvidenceBundle;
}

export interface BugReportInput {
  readonly kind: "bug";
  readonly environment: Environment;
  /**
   * Every setting and its value. Values only, never browsing data.
   *
   * Nothing about the current tab, not even which capture mechanisms failed on it: the
   * report says nothing about the pages visited, and that tab is one.
   */
  readonly settingsSummary: string;
}

export interface FeatureReportInput {
  readonly kind: "feature";
  readonly environment: Environment;
}

export type ReportInput = FindingReportInput | BugReportInput | FeatureReportInput;

export interface Report {
  readonly kind: ReportKind;
  readonly title: string;
  /** The issue body, as it will appear in the URL. */
  readonly body: string;
  /** The URL to open. Guaranteed under MAX_URL_LENGTH. */
  readonly url: string;
  /**
   * Full bundle JSON for the clipboard, when the report carries one. The body asks the
   * user to paste it; it is deliberately not in the URL.
   */
  readonly clipboard: string | null;
  /** The complete bundle, offered as a file when the pasted one had to be trimmed. */
  readonly fullBundle: string | null;
  /** The name the full bundle is saved under. */
  readonly fileName: string | null;
  /** How much of the network list the pasted bundle carries. */
  readonly bundleTrim: { readonly trimmed: boolean; readonly kept: number; readonly total: number; readonly detailsCut: boolean; readonly provenanceCut: boolean } | null;
  /** Everything the report will disclose, for the confirmation screen. */
  readonly preview: readonly PreviewLine[];
}

export interface PreviewLine {
  readonly label: string;
  readonly value: string;
  /**
   * A locale key for the value, when the value is copy rather than captured data: "none
   * included", and the sentences the counts sit in. `value` stays empty for these. A
   * version or a hostname comes straight off the capture and must not be translated.
   */
  readonly valueKey?: string;
  /** Substitutions for `valueKey`: the counts. */
  readonly valueSubstitution?: readonly string[];
  /** The value states that something is not included, and is set apart as an absence. */
  readonly absence?: true;
}

function environmentBlock(env: Environment): string {
  return [
    `- Extension: ${env.extensionVersion}`,
    `- Browser: ${env.browser}`,
    `- OS: ${env.os}`,
    `- Vendor list: ${env.listSource} ${env.listVersion}`,
    ...(env.functionalList === undefined ? [] : [`- Functional cookie list: ${env.functionalList}`]),
    ...(env.publicSuffixList === undefined ? [] : [`- Public Suffix List: ${env.publicSuffixList}`]),
  ].join("\n");
}

/**
 * A compact summary of what was observed.
 *
 * Counts come from the tallies, which are complete; the request list is a sample and is not
 * enumerated here. The top-level site appears because a report about a finding is
 * meaningless without it, and the person sees it on the confirmation screen before deciding.
 */
/** "yes", or "no" and why (1.22.0 records the reasons; an older bundle gives none). */
function captureComplete(obs: ObservationSet): string {
  if (!obs.context.incomplete) return "yes";
  const reasons = obs.context.incompleteReasons ?? [];
  return reasons.length > 0 ? `no (${reasons.join(", ")})` : "no (reason not recorded)";
}

/** The published file as the popup reports it: a read that got no answer is not an absence. */
function publishedFile(obs: ObservationSet): string {
  const wk = obs.wellKnown;
  if (wk?.present) return `gpc: ${String(wk.gpc)}`;
  if (wk !== null && gotNoAnswer(wk)) return `could not be checked (${wk.reason ?? "no response"})`;
  return "none";
}

function observationSummary(obs: ObservationSet): string {
  const t = obs.tallies;
  const vendors = Object.keys(t.byEntity).sort();
  return [
    `- Site: ${obs.context.topSite}`,
    `- Signal: ${obs.signal.source}, ${t.signedRequests}/${t.totalRequests} requests carried it`,
    `- Advertising/analytics requests: ${t.adVendorRequests}`,
    `- Distinct advertising cookies: ${t.adCookieKeys.length} (${t.adCookieEvents} set events)`,
    `- Distinct advertising cookies on requests without the signal: ${(t.adCookieKeysUnsigned ?? []).length} (${t.adCookieEventsUnsigned ?? 0} set events)`,
    `- Vendors: ${vendors.length > 0 ? vendors.join(", ") : "none"}`,
    `- Published GPC file: ${publishedFile(obs)}`,
    `- Confirmation notice: ${obs.confirmationNotice}`,
    `- Capture complete: ${captureComplete(obs)}`,
  ].join("\n");
}

/**
 * Issue form templates, and the field ids each report fills.
 *
 * GitHub issue FORMS are prefilled by field id, not by a single `body` parameter — passing
 * `?body=` bypasses the template and opens a blank issue. Routing through the template
 * means a report arrives inside the structure a maintainer expects, with labels applied by
 * the template rather than asserted by us.
 */
const TEMPLATES: Record<ReportKind, string> = {
  finding: "looks-wrong.yml",
  bug: "bug.yml",
  feature: "feature.yml",
};

interface Composed {
  readonly title: string;
  readonly fields: Record<string, string>;
}

function findingReport(input: FindingReportInput): Composed {
  const whatWrong = [
    "**What was observed**",
    "",
    observationSummary(input.observations),
    "",
    "**Environment**",
    "",
    environmentBlock(input.environment),
  ]
    .filter((line, i, all) => !(line === "" && all[i - 1] === ""))
    .join("\n");

  return {
    title: `Looks wrong: ${input.observations.context.topSite}`,
    fields: { "what-wrong": whatWrong, site: input.observations.context.topSite },
  };
}

function bugReport(input: BugReportInput): Composed {
  const environment = [environmentBlock(input.environment), `- Settings: ${input.settingsSummary}`].join("\n");

  return { title: "Bug: ", fields: { environment } };
}

function featureReport(input: FeatureReportInput): Composed {
  return {
    title: "Feature: ",
    fields: { what: "", why: `\n\n<!-- Extension ${input.environment.extensionVersion} -->` },
  };
}

function issueUrl(repoUrl: string, kind: ReportKind, title: string, fields: Record<string, string>): string {
  const base = `${repoUrl.replace(/\/$/, "")}/issues/new`;
  const params = new URLSearchParams({ template: TEMPLATES[kind], title });
  for (const [id, value] of Object.entries(fields)) {
    if (value !== "") params.set(id, value);
  }
  return `${base}?${params.toString()}`;
}

/**
 * Build a report.
 *
 * When the assembled URL exceeds the practical prefill limit, the summary is shortened.
 * Shortening never removes the environment block: a report we cannot reproduce is worth
 * less than one with a shorter description.
 */
export function buildReport(repoUrl: string, input: ReportInput): Report {
  // Checked here rather than trusted from the caller: this is the last point before the
  // bundle reaches a clipboard and a public issue.
  if (input.kind === "finding" && input.bundle.redacted !== "redacted") {
    throw new Error("A finding report carries a redacted bundle only");
  }

  const composed =
    input.kind === "finding"
      ? findingReport(input)
      : input.kind === "bug"
        ? bugReport(input)
        : featureReport(input);

  // Compact, not pretty-printed: pretty costs 30% for readability GitHub's code block
  // provides anyway.
  const trimmedBundle = input.kind === "finding" ? trimBundleForIssue(input.bundle) : null;
  const clipboard = trimmedBundle?.json ?? null;
  // The complete bundle, for the file attachment. GitHub accepts attachments far larger
  // than an issue body, so nothing is lost — it simply is not pasted.
  const fullBundle = input.kind === "finding" ? JSON.stringify(input.bundle, null, 2) : null;

  let fields = composed.fields;
  let url = issueUrl(repoUrl, input.kind, composed.title, fields);

  if (url.length > MAX_URL_LENGTH) {
    const primary = input.kind === "finding" ? "what-wrong" : "environment";
    const room = Math.max(
      0,
      (fields[primary]?.length ?? 0) - (url.length - MAX_URL_LENGTH) - 200,
    );
    fields = {
      ...fields,
      [primary]: `${(fields[primary] ?? "").slice(0, room)}\n\n<!-- Summary shortened to fit the URL length limit. -->`,
    };
    url = issueUrl(repoUrl, input.kind, composed.title, fields);
  }

  return {
    kind: input.kind,
    title: composed.title,
    body: Object.values(fields).join("\n\n"),
    url,
    clipboard,
    fullBundle,
    fileName: input.kind === "finding" ? evidenceFileName(input.bundle) : null,
    bundleTrim: trimmedBundle
      ? { trimmed: trimmedBundle.trimmed, kept: trimmedBundle.kept, total: trimmedBundle.total, detailsCut: trimmedBundle.detailsCut, provenanceCut: trimmedBundle.provenanceCut }
      : null,
    preview: previewFor(input),
  };
}

/**
 * Everything the report discloses, for the confirmation screen.
 *
 * Shown BEFORE anything opens. A privacy tool that submitted a record of someone's browsing
 * without showing it first would be self-refuting, and the difference between the three
 * report kinds is exactly what this screen has to make legible.
 */
/**
 * The rows for anything that carries the page's record: a finding report or an export.
 * Both describe the record without values: a report is always masked, and two of the
 * export's three files are. The third says what it adds in the hint under its button.
 */
function pagePreview(env: Environment, obs: ObservationSet): PreviewLine[] {
  const t = obs.tallies;
  return [
    { label: "previewSite", value: obs.context.topSite },
    { label: "previewVersion", value: env.extensionVersion },
    { label: "previewBrowser", value: `${env.browser} · ${env.os}` },
    { label: "previewList", value: `${env.listSource} ${env.listVersion}` },
    {
      label: "previewRequests",
      value: "",
      valueKey: "previewRequestsValue",
      valueSubstitution: [String(t.totalRequests), String(Object.keys(t.byEntity).length)],
    },
    {
      label: "previewCookies",
      value: "",
      valueKey: "previewCookieNames",
      valueSubstitution: [String(cookieNamesCarried(obs).size)],
    },
  ];
}

/**
 * Every distinct cookie name the record carries, wherever it sits: the requests' set and
 * sent cookies, the kept records, and each summary's lists. Not only the advertising and
 * analytics keys: the record holds the first-party, unlisted-domain and container cookies
 * too, and the request list.
 *
 * Names, not name and domain: the row tells the reader which names travel, and `_ga` set
 * for two domains is one name. A key is "name\u0000domain" (tally.ts cookieKey); a refused
 * write is "name (domain)"; probes and returned cookies are names.
 */
export function cookieNamesCarried(obs: ObservationSet): Set<string> {
  const names = new Set<string>();
  const add = (list: readonly string[] | undefined, toName: (s: string) => string): void => {
    for (const item of list ?? []) names.add(toName(item));
  };
  const name = (s: string): string => s;
  const fromKey = (key: string): string => key.split("\u0000")[0] ?? key;
  const fromRefused = (write: string): string => /^(.*) \([^()]*\)$/.exec(write)?.[1] ?? write;

  for (const o of obs.network) {
    add(o.setCookies.map((c) => c.name), name);
    add(o.cookiesSent, name);
  }
  for (const k of obs.keptCookieResponses ?? []) add(k.setCookies.map((c) => c.name), name);

  const t = obs.tallies;
  add(t.adCookieKeys, fromKey);
  add(t.adCookieKeysUnsigned, fromKey);
  add(t.firstPartyVendorCookieKeys, fromKey);
  add(Object.keys(t.cookieDetails ?? {}), fromKey);
  for (const list of Object.values(t.probeCookies ?? {})) add(list, name);
  for (const list of Object.values(t.refusedCookieWrites ?? {})) add(list, fromRefused);
  for (const e of Object.values(t.byEntity)) {
    add(e.cookieNames, name);
    add(e.cookieNamesUnsigned, name);
    add(e.cookiesReturned, name);
  }
  for (const s of [...Object.values(t.byEntityCategory ?? {}), ...Object.values(t.byUnlistedDomain ?? {})]) {
    add(s.cookieKeys, fromKey);
    add(s.cookieKeysUnsigned, fromKey);
    add(s.cookieKeysRequestLost, fromKey);
    add(s.cookiesReturned, name);
    add(s.probeCookies, name);
    add(s.refusedWrites, fromRefused);
  }
  for (const c of Object.values(t.byContainer ?? {})) {
    add(c.cookieKeys, fromKey);
    add(c.cookieKeysUnsigned, fromKey);
    add(c.probeCookies, name);
    add(c.refusedWrites, fromRefused);
  }
  if (t.firstParty) {
    add(t.firstParty.cookieKeys, fromKey);
    add(t.firstParty.cookieKeysUnsigned, fromKey);
    add(t.firstParty.vendorCookieKeysUnsigned, fromKey);
    add(t.firstParty.cookieKeysRequestLost, fromKey);
    add(t.firstParty.probeCookies, name);
  }
  return names;
}

/** What an export discloses, for the export screen. */
export function exportPreview(
  env: Environment,
  obs: ObservationSet,
): readonly PreviewLine[] {
  return pagePreview(env, obs);
}

/**
 * The name of a saved bundle. It is a log, as the buttons that save it call it, named with
 * the site and the capture date so a folder of records can be told apart. A file that
 * holds what masking removes has `sensitive` in its name, as its button does, so it can be
 * recognized before it is opened or attached anywhere. The file a finding report offers is
 * the same masked bundle, so it has the same name as the masked log.
 *
 * The site is reduced to the characters a hostname can hold. It came from a page, and a
 * file name is not a place for anything else.
 */
export function evidenceFileName(bundle: EvidenceBundle, kind: "record" | "summary" = "record"): string {
  const site = bundle.observations.context.topSite
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "")
    .replace(/^[.-]+/, "");
  const date = /^\d{4}-\d{2}-\d{2}/.exec(bundle.createdAt)?.[0] ?? "";
  // The summary is named for what it is, so the two files of one capture sit together
  // and are told apart before either is opened. It never holds values.
  if (kind === "summary") {
    return `${["gpc-inspector-summary", site, date].filter((p) => p !== "").join("-")}.md`;
  }
  const parts = ["gpc-inspector-log", site, date].filter((p) => p !== "");
  if (bundle.redacted !== "redacted") parts.push("sensitive");
  return `${parts.join("-")}.json`;
}

function previewFor(input: ReportInput): PreviewLine[] {
  if (input.kind === "finding") {
    return pagePreview(input.environment, input.observations);
  }
  const env = input.environment;
  // A feature request carries the version alone (featureReport), so it shows no browser.
  const lines: PreviewLine[] = [
    { label: "previewVersion", value: env.extensionVersion },
    ...(input.kind === "bug" ? [{ label: "previewBrowser", value: `${env.browser} · ${env.os}` }] : []),
  ];

  {
    // Stated positively rather than left to inference: the absence of page data is the
    // property a reader most needs to be sure of.
    //
    // A real subject-and-value row. A label with an empty value cell would be the one row
    // in the grid with nothing on its right-hand side, which reads as missing data on the
    // screen whose whole job is to account for what travels with the report.
    lines.push({ label: "previewPageData", valueKey: "previewPageDataNone", value: "", absence: true });
  }

  return lines;
}
