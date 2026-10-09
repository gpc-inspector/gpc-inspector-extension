// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Finding, ObservationSet } from "@gpc-inspector/schema";
import { getClassifier, getFunctionalCookies, getOwnerNames } from "../src/background/classifier.js";
import { classifiedInput } from "../src/ui/view-input.js";
import { buildPopupView, LIST_MARK, type KvLine, type KvRow, type SummaryPart } from "../src/ui/view-model.js";
import { buildRequestsView, requestCount } from "../src/ui/requests-view.js";

/**
 * Real captures from the integration corpus, replayed through the engine and the popup's
 * view model on every run (CONTRIBUTING, "Corrections become fixtures").
 *
 * The unit tests build their inputs by hand, and real pages come in shapes nobody writes
 * down: a dataLayer renamed behind a first-party loader, a page that navigated twice while
 * loading, an error page. These captures are such shapes as they were recorded. Each has an
 * .expected.json beside it: what the engine found, what the counts were and what the popup
 * would show, written by `npx vitest run corpus-replay -u` and reviewed like code. A change
 * to the engine, the list or the view model that moves any of it fails here and shows up as
 * a diff, which is either a bug or a decision.
 *
 * The list version is recorded, so a Disconnect update shows up as that kind of diff too.
 * To add a capture: fixtures/corpus/add-fixture.mjs, then this test with -u.
 *
 * The captures are read from the folder CORPUS_CAPTURES names, an absolute path or one
 * relative to the repository root, and from fixtures/corpus/captures when it names none.
 * They are not part of every checkout: without that variable and without the default
 * folder, the replay is skipped and says so. A folder the variable names must hold
 * captures, so a wrong path fails instead of passing empty.
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
const named = process.env["CORPUS_CAPTURES"];
const dir = resolve(root, named || "fixtures/corpus/captures");
const shown = relative(root, dir) || dir;
const captures = existsSync(dir)
  ? readdirSync(dir)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".expected.json"))
      .sort()
  : [];

/** One line per distinct finding, with how many times it occurred: a page's 40 cookie
 * findings for one vendor are one line to review, not forty. Order is the engine's. */
function findingLines(findings: readonly Finding[]): string[] {
  const counts = new Map<string, number>();
  for (const f of findings) {
    const line = [f.flag, f.entity?.name, f.artifact.kind].filter(Boolean).join(" · ");
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return [...counts].map(([line, n]) => (n > 1 ? `${line} × ${n}` : line));
}

/**
 * A line's parts as text: message keys with their substitutions, and the line's list, which
 * the popup draws where a substitution holds LIST_MARK, in its place, or alone where the
 * line has no parts.
 */
function lineText(line: KvLine): string {
  const list = (line.list ?? []).map((i) => (i.categoryKey ? `${i.text} [${i.categoryKey}]` : i.text)).join(", ");
  // A line of names alone, under a label that says which list it is.
  if (line.parts.length === 0) return list;
  return line.parts
    .map((p) => {
      if (!("key" in p)) return p.text;
      const subs = (p.substitution ?? []).map((v) => (v === LIST_MARK ? list : v));
      return `${p.key}${subs.length ? `(${subs.join(" | ")})` : ""}`;
    })
    .join(" ");
}

/**
 * A "What this site did" row as text, one entry per row: label, value and lines. A group
 * row's rows follow it, each prefixed with the group's label.
 */
function kvText(row: KvRow, prefix = ""): string[] {
  return [
    [`${prefix}${row.labelKey}`, row.valueKey ?? row.value, ...(row.lines ?? []).map(lineText)].filter(Boolean).join(" · "),
    ...(row.rows ?? []).flatMap((r) => kvText(r, `${prefix}${row.labelKey} > `)),
  ];
}

/** A collapsed Privacy strings value as text: message keys with their substitutions. */
function summaryText(parts: readonly SummaryPart[]): string {
  return parts.map((p) => `${p.key}${p.substitution?.length ? `(${p.substitution.join(" | ")})` : ""}`).join(" ");
}

describe("corpus captures replayed through the engine and the popup's view model", () => {
  it("has captures to replay", (ctx) => {
    if (captures.length === 0 && !named) {
      ctx.skip(`no captures in ${shown}; set CORPUS_CAPTURES to the folder that holds them`);
    }
    expect(captures.length, `no captures in ${shown}`).toBeGreaterThan(0);
  });

  it.each(captures)("%s", async (name) => {
    const path = join(dir, name);
    const obs = JSON.parse(readFileSync(path, "utf8")) as ObservationSet;
    const classifier = getClassifier();
    const functional = getFunctionalCookies();
    const input = classifiedInput(obs, {
      classifier,
      owners: getOwnerNames(),
      isListedFunctional: (name) => functional.lists(name),
    });
    // As the popup opens on a finished page, with this extension sending.
    const view = buildPopupView({ ...input, pending: false, sendingSignal: true, signalKnown: true, checkWellKnownEnabled: true });
    const requests = buildRequestsView(obs, classifier, "all", undefined, (name) => functional.lists(name), getOwnerNames());

    const summary = {
      capture: { site: obs.context.topSite, capturedAt: obs.context.capturedAt, schemaVersion: obs.schemaVersion },
      listVersion: classifier.provenance.version,
      counts: {
        cookiesWithSignal: input.distinctCookies,
        cookiesWithoutSignal: input.distinctCookiesUnsigned,
        adOrAnalyticsRequests: input.adTechRequests,
        firstPartyVendorCookies: input.firstPartyVendorCookies,
      },
      findings: findingLines(input.findings),
      popup: {
        state: view.state,
        status: view.status.sourceKey,
        notices: view.notices.map((n) => n.textKey),
        privacyStrings: view.privacyStrings.map((r) => `${r.id}: ${summaryText(r.summary)}${r.flagged ? " (flagged)" : ""}`),
        siteDid: view.siteDid.flatMap((r) => kvText(r)),
        cookieCount: view.cookieCount,
        vendors: view.vendors.map((v) => `${v.name}: ${v.cookies.length} cookies`),
      },
      // The Requests tab's numbers: HTTP requests only, and the script writes it lists apart.
      requestsTab: {
        requests: requests.counts,
        scriptWrites: requests.scriptWriteCount,
      },
    };

    // The tab's number is the worker's count of requests on a page whose list is whole. Not
    // on a failed load, whose one request the worker holds and never counts.
    expect(requestCount(obs)).toBe(requests.counts.all);
    if (!obs.context.loadError && !obs.context.incompleteReasons?.includes("worker-restarted")) {
      expect(requests.counts.all).toBe(obs.signal.totalRequestCount);
    }

    // Beside the capture, in whichever folder it was read from.
    await expect(JSON.stringify(summary, null, 2) + "\n").toMatchFileSnapshot(path.replace(/\.json$/, ".expected.json"));
  });
});
