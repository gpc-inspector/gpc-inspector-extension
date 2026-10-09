#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only
/**
 * Build summary.md for a corpus run from the per-site summaries sweep.mjs wrote.
 *
 *   node fixtures/corpus/report.mjs fixtures/corpus/runs/<name>     # rewrites summary.md there
 *
 * Every column is a fact the extension records; the table draws no conclusion. "Blocked"
 * means the page served a bot challenge to this automated Chrome, so its row describes the
 * challenge page. The popup column is the headline the user would have seen.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const yesNo = (v) => (v ? "yes" : "no");

function gppCell(s) {
  if (!s.gpp) return "none";
  const parts = [];
  for (const [name, f] of Object.entries(s.gpp.sections)) {
    const bits = [];
    if (f.Gpc !== undefined) bits.push(`Gpc=${f.Gpc}`);
    if (f.SaleOptOut !== undefined) bits.push(`Sale=${f.SaleOptOut}`);
    if (f.SharingOptOut !== undefined) bits.push(`Share=${f.SharingOptOut}`);
    if (f.TargetedAdvertisingOptOut !== undefined) bits.push(`TargetedAd=${f.TargetedAdvertisingOptOut}`);
    parts.push(`${name}${bits.length ? ` (${bits.join(" ")})` : ""}`);
  }
  if (!parts.length) parts.push(`sections ${s.gpp.applicableSections.join(",") || "none"}`);
  if (s.gpp.unparseable) parts.push("unparseable");
  return parts.join("; ");
}

function uspCell(s) {
  const u = s.usPrivacy;
  if (!u) return "none";
  const v = u.fromApi ?? u.fromCookie ?? u.fromWire;
  const src = u.fromApi ? "api" : u.fromCookie ? "cookie" : "wire";
  return v ? `${v} (${src})` : "none";
}

function gtmCell(s) {
  if (!s.gtm || s.gtm.present === false) return "none";
  const ids = [...(s.gtm.containerIds ?? []), ...(s.gtm.gtagIds ?? [])];
  if (!ids.length) return "dataLayer only, no container id";
  const cm = s.gtm.consentMode;
  let consent = "";
  if (cm && typeof cm === "object") {
    const keys = ["ad_storage", "analytics_storage", "ad_user_data", "ad_personalization"];
    const vals = keys.filter((k) => cm[k] !== undefined).map((k) => `${k.replace("_storage", "").replace("_", " ")}=${String(cm[k]).slice(0, 7)}`);
    if (vals.length) consent = `; consent mode ${vals.join(" ")}`;
  }
  return `${ids.length} (${ids.slice(0, 3).join(", ")}${ids.length > 3 ? ", …" : ""})${consent}`;
}

function wellKnownCell(s) {
  if (!s.wellKnown) return "not checked";
  if (!s.wellKnown.present) return `none${s.wellKnown.reason ? ` (${s.wellKnown.reason})` : ""}`;
  return `gpc: ${String(s.wellKnown.gpc)}`;
}

function vendorsCell(s) {
  const setters = Object.entries(s.findings.vendors)
    .filter(([, v]) => v.cookies.length)
    .map(([name, v]) => `${name} (${v.cookies.length})`);
  return setters.length ? setters.join(", ") : "none";
}

function readsCell(s) {
  const r = s.signal;
  if (r.readTracking !== "active") return `n/a (${r.readTracking})`;
  return `${r.readCount ?? 0} by ${r.scriptsReading}`;
}

function popupCell(s) {
  if (!s.popup) return "not rendered";
  const f = s.popup.fields;
  const head = [f["count-number"], f["count-caption"]].filter(Boolean).join(" ");
  return (head || f["status-text"] || "(empty)").replace(/\s+/g, " ").slice(0, 120);
}

function flagsCell(s) {
  const f = s.findings.flags;
  const keep = ["cookie-set-with-signal", "cookie-set-on-redirect", "gpp-conflict", "gpc-sent-gpp-field-no", "property-tampered", "signal-not-read", "declared-honor-cookie-set", "usp-surfaces-disagree", "gpp-surfaces-disagree", "vendor-read-gpc", "vendor-did-not-read-gpc", "vendor-gpc-unread-via-container", "vendor-gpc-check-unattributable", "vendor-no-script-observed"];
  return keep.filter((k) => f[k]).map((k) => `${k} ${f[k]}`).join(", ") || "none";
}

export async function buildReport(dir) {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json") && !f.endsWith(".obs.json") && f !== "run.json").sort();
  const run = JSON.parse(await readFile(join(dir, "run.json"), "utf8").catch(() => "{}"));
  const rows = [];
  for (const f of files) {
    const row = JSON.parse(await readFile(join(dir, f), "utf8"));
    // Script cookie writes are recorded alongside requests (captureMethod documentCookie)
    // and carry no header by nature; the unsigned count below is of real requests only.
    if (!row.error) {
      try {
        const obs = JSON.parse(await readFile(join(dir, `${row.host}.obs.json`), "utf8"));
        const real = obs.network.filter((n) => n.captureMethod !== "documentCookie" && n.captureMethod !== "cookieStore");
        row.signal.realRequests = real.length;
        row.signal.realUnsigned = real.filter((n) => !n.secGpcPresent).length;
        row.signal.realUnsignedSample = real.filter((n) => !n.secGpcPresent).slice(0, 3).map((n) => `${n.resourceType} ${n.url.slice(0, 60)}`);
      } catch {}
    }
    rows.push(row);
  }
  // Groups in the order the site list first gives them; ad-hoc pages come after the list.
  const groupOfHost = new Map(rows.map((r) => [r.host, r.group]));
  const rank = new Map();
  for (const host of run.sites ?? []) {
    const group = groupOfHost.get(host);
    if (group !== undefined && !rank.has(group)) rank.set(group, rank.size);
  }
  const rankOf = (group) => rank.get(group) ?? rank.size;
  rows.sort((a, b) => rankOf(a.group) - rankOf(b.group) || a.host.localeCompare(b.host));

  const lines = [];
  lines.push(`# Corpus run ${run.startedAt ?? ""}`.trim());
  lines.push("");
  lines.push(`Extension ${run.extensionVersion ?? "?"}, ${run.chrome ?? "Chrome ?"}, list ${run.listVersion ?? "?"}, settle ${run.settleMs ?? "?"} ms after load. ${rows.length} sites. Automated profile: a site marked blocked served a challenge page, and its row describes that page.`);
  lines.push("");
  // Cross-checks first: the rows a reader has to look at before trusting the table.
  const ok = rows.filter((s) => !s.error);
  const failed = rows.filter((s) => s.error);
  const blocked = ok.filter((s) => s.page.blocked);
  const errorPage = ok.filter((s) => /showing error page/.test(s.page.textSample ?? ""));
  const incomplete = ok.filter((s) => s.context.incomplete || s.context.loadObserved === false);
  const disagree = ok.filter(
    (s) =>
      (s.counts.workerBadgeCount !== null && s.counts.workerBadgeCount !== s.counts.distinctCookiesSigned) ||
      (s.counts.workerFindings !== null && s.counts.workerFindings !== s.findings.total),
  );
  const popupTrouble = ok.filter((s) => !s.popup || s.popup.firstRunShown || (s.popup.fields["count-number"] === "" && !s.popup.fields["status-text"]));
  // The popup reads the tab once, as it opens, so it is judged against the worker's badge
  // read just before it opened and just after it was read: a page still setting cookies at
  // the settle moves the count between the popup and the capture dumped after it (retailer-k.example,
  // 2026-09-30: 59 in the popup, 64 a few seconds later, five cookie syncs in between).
  // Outside that range is a real disagreement. A run from before the badge was read there has
  // only the capture, and one either way of it is timing.
  const popupNumber = (s) => (s.popup && /^\d+$/.test(s.popup.fields["count-number"]) ? Number(s.popup.fields["count-number"]) : null);
  const popupRange = (s) => {
    const { workerBadgeBefore: a, workerBadgeAfter: b } = s.popup ?? {};
    if (typeof a === "number" && typeof b === "number") return [Math.min(a, b), Math.max(a, b), 0];
    return [s.counts.distinctCookiesSigned, s.counts.distinctCookiesSigned, 1];
  };
  const popupOff = ok.filter((s) => {
    const n = popupNumber(s);
    if (n === null) return false;
    const [lo, hi, slack] = popupRange(s);
    return n < lo - slack || n > hi + slack;
  });
  const lateCookies = ok.filter((s) => typeof s.popup?.workerBadgeAfter === "number" && s.counts.distinctCookiesSigned > s.popup.workerBadgeAfter);
  const unsigned = ok.filter((s) => !s.page.blocked && s.signal.totalRequestCount > 0 && s.signal.secGpcRequestCount === 0);
  const partlyUnsigned = ok.filter((s) => s.signal.realUnsigned !== undefined ? s.signal.realUnsigned > 0 && s.signal.secGpcRequestCount > 0 : s.signal.secGpcRequestCount > 0 && s.signal.secGpcRequestCount < s.signal.totalRequestCount);
  const tampered = ok.filter((s) => s.findings.flags["property-tampered"]);
  const caps = {};
  for (const s of ok) for (const c of s.context.capabilitiesFailed) (caps[c] ??= []).push(s.host);
  const declared = ok.filter((s) => s.wellKnown?.present);
  const notice = ok.filter((s) => s.confirmationNotice === "detected");
  const honorFinding = ok.filter((s) => s.findings.flags["declared-honor-cookie-set"]);
  const gpp = ok.filter((s) => s.gpp);
  const usp = ok.filter((s) => s.usPrivacy && (s.usPrivacy.fromApi || s.usPrivacy.fromCookie || s.usPrivacy.fromWire));
  const hosts = (list) => (list.length ? list.map((s) => s.host).join(", ") : "none");
  lines.push("## Cross-checks");
  lines.push("");
  lines.push(`- Failed to run: ${hosts(failed)}.`);
  lines.push(`- Blocked by a challenge page: ${hosts(blocked)}.`);
  lines.push(`- Did not load (Chrome error page, no content script ran): ${hosts(errorPage)}.`);
  lines.push(`- Capture incomplete or load not observed: ${hosts(incomplete)}.`);
  lines.push(`- Worker and Node disagree on the badge count or the number of findings: ${hosts(disagree)}.`);
  lines.push(`- Popup not rendered, still pending, or showing the first-run screen: ${hosts(popupTrouble)}.`);
  lines.push(
    `- Popup headline outside the worker's count while it was open: ${popupOff
      .map((s) => {
        const [lo, hi] = popupRange(s);
        return `${s.host} (popup ${s.popup.fields["count-number"]}, worker ${lo === hi ? lo : `${lo} to ${hi}`})`;
      })
      .join(", ") || "none"}.`,
  );
  lines.push(
    `- Cookies counted after the popup was read, still in the capture: ${lateCookies.map((s) => `${s.host} (${s.counts.distinctCookiesSigned - s.popup.workerBadgeAfter})`).join(", ") || "none"}.`,
  );
  lines.push(`- No request carried Sec-GPC: ${hosts(unsigned)}.`);
  lines.push(`- Some requests did not carry Sec-GPC (script cookie writes excluded): ${partlyUnsigned.map((s) => (s.signal.realUnsigned !== undefined ? `${s.host} (${s.signal.realUnsigned} of ${s.signal.realRequests}: ${s.signal.realUnsignedSample.join("; ")})` : `${s.host} (${s.signal.totalRequestCount - s.signal.secGpcRequestCount} of ${s.signal.totalRequestCount})`)).join(", ") || "none"}.`);
  lines.push(`- Property tampered: ${hosts(tampered)}.`);
  lines.push(`- Capabilities that failed: ${Object.entries(caps).map(([c, h]) => `${c} on ${h.length} (${h.join(", ")})`).join("; ") || "none"}.`);
  lines.push(`- Publishes gpc.json: ${declared.map((s) => `${s.host} (gpc: ${String(s.wellKnown.gpc)}${s.wellKnown.fresh ? "" : ", cached"})`).join(", ") || "none"}.`);
  lines.push(`- Declared-honor finding fired: ${hosts(honorFinding)}.`);
  lines.push(`- Confirmation notice detected: ${hosts(notice)}.`);
  lines.push(`- GPP present: ${hosts(gpp)}.`);
  lines.push(`- US Privacy present: ${hosts(usp)}.`);
  lines.push("");
  lines.push("## Every site");
  lines.push("");
  lines.push("| Site | Group | Page | Sec-GPC sent | GPC reads | Ad or analytics requests | Cookies with signal | Set by | GPP | US Privacy | Tag manager | Notice | gpc.json | Popup headline |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of rows) {
    if (s.error) {
      lines.push(`| ${s.host} | ${s.group} | failed: ${s.error.replace(/\|/g, "/").slice(0, 80)} | | | | | | | | | | | |`);
      continue;
    }
    const page = s.page.blocked ? "blocked" : /showing error page/.test(s.page.textSample ?? "") ? "error page" : s.context.incomplete ? "incomplete" : s.context.loadObserved === false ? "load not observed" : "ok";
    lines.push(
      `| ${s.host} | ${s.group} | ${page} | ${s.signal.secGpcRequestCount}/${s.signal.totalRequestCount} | ${readsCell(s)} | ${s.counts.adTechRequests} | ${s.counts.distinctCookiesSigned} (badge ${s.counts.workerBadgeCount ?? "?"}) | ${vendorsCell(s)} | ${gppCell(s)} | ${uspCell(s)} | ${gtmCell(s)} | ${s.confirmationNotice} | ${wellKnownCell(s)} | ${popupCell(s)} |`.replace(/\n/g, " "),
    );
  }
  lines.push("");
  lines.push("## Findings per site");
  lines.push("");
  for (const s of rows) {
    if (s.error) continue;
    lines.push(`### ${s.host}`);
    lines.push("");
    lines.push(`Final URL ${s.page.finalUrl}. Title: ${s.page.title.replace(/\s+/g, " ").slice(0, 100) || "(none)"}.${s.page.blocked ? " Challenge page." : ""}${/showing error page/.test(s.page.textSample ?? "") ? " Chrome error page: the site did not answer." : ""}${s.context.capabilitiesFailed.length ? ` Capabilities failed: ${s.context.capabilitiesFailed.join(", ")}.` : ""}`);
    lines.push("");
    lines.push(`- Signal: source ${s.signal.source}, property ${String(s.signal.propertyValue)}, ${s.signal.secGpcRequestCount} of ${s.signal.totalRequestCount} requests carried Sec-GPC, ${readsCell(s)} scripts read it.`);
    lines.push(`- Counts: ${s.counts.requests} requests${s.counts.scriptCookieWrites === undefined ? "" : ` and ${s.counts.scriptCookieWrites} script cookie writes`}, ${s.counts.adTechRequests} to third-party ad or analytics domains, ${s.counts.distinctCookiesSigned} distinct cookies set on signed requests (${s.counts.distinctCookiesUnsigned} on unsigned), ${s.counts.firstPartyVendorCookies} first-party vendor cookies, ${s.counts.consentApiCalls} consent API calls, ${s.counts.scriptInsertions ?? "n/a"} script insertions.`);
    lines.push(`- Flags: ${flagsCell(s)}.`);
    lines.push(`- Strings: GPP ${gppCell(s)}; USP ${uspCell(s)}; TCF ${s.tcf ? "present" : "none"}; tag manager ${gtmCell(s)}; notice ${s.confirmationNotice}; gpc.json ${wellKnownCell(s)}.`);
    const setters = Object.entries(s.findings.vendors).filter(([, v]) => v.cookies.length);
    if (setters.length) lines.push(`- Cookies with signal: ${setters.map(([n, v]) => `${n}: ${v.cookies.join(", ")}`).join("; ")}.`);
    if (s.page.noticeTextHits?.length) {
      lines.push(`- Signal-related text on the page: ${s.page.noticeTextHits.map((h) => JSON.stringify(h)).join("; ")}.`);
    }
    if (s.diagnostics?.retiredDocuments?.length) {
      lines.push(`- Documents retired during the capture: ${s.diagnostics.retiredDocuments.length}.`);
    }
    if (s.diagnostics?.confirmationEvidence) {
      lines.push(`- Notice evidence: ${JSON.stringify(s.diagnostics.confirmationEvidence).slice(0, 300)}.`);
    }
    if (s.popup) {
      const f = s.popup.fields;
      lines.push(`- Popup: ${[f["status-text"], f["status-source"]].filter(Boolean).join(" ")}. Headline: ${popupCell(s)}. Names: ${(f["count-names"] || "(none)").replace(/\s+/g, " ").slice(0, 200)}.${f["notices"] ? ` Notices: ${f["notices"].replace(/\s+/g, " ").slice(0, 300)}.` : ""}${s.popup.firstRunShown ? " FIRST-RUN SCREEN WAS SHOWING." : ""}`);
    }
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

const invoked = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invoked) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node fixtures/corpus/report.mjs <run directory>");
    process.exit(1);
  }
  await writeFile(join(dir, "summary.md"), await buildReport(dir));
  console.log(`wrote ${join(dir, "summary.md")}`);
}
