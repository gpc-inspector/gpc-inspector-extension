// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import messagesJson from "../public/_locales/en/messages.json" with { type: "json" };
import { redact, sealBundle, SCHEMA_VERSION } from "@gpc-inspector/schema";
import type { EvidenceBundle, ObservationSet } from "@gpc-inspector/schema";
import {
  EXPORT_BUTTONS,
  exportFile,
  markSaved,
  openPendingExport,
  type ExportMakers,
} from "../src/ui/export-screen.js";
import { summaryMarkdown, type Translate } from "../src/ui/summary-markdown.js";
import { getClassifier, getFunctionalCookies, getOwnerNames } from "../src/background/classifier.js";
import { classifiedInput } from "../src/ui/view-input.js";
import { buildPopupView } from "../src/ui/view-model.js";
import { FIXTURES } from "../harness/fixtures.mjs";

/**
 * The download screen's three buttons. Cookie values reach a file only from the button that
 * says so, and each opening of the screen starts from nothing.
 */

// The harness's ad-dense page (harness/fixtures.mjs), with a secret in every cookie value
// and one more query parameter on a request address, so a leak is a substring and not a
// guess.
const SECRET = "sess_9f8e7d6c5b4a";
const QUERY = "uid=tok_31415926";

function capture(): ObservationSet {
  const page = FIXTURES["heavy"]?.();
  if (!page) throw new Error("no heavy fixture");
  const obs = JSON.parse(JSON.stringify(page).replaceAll('"REDACTED"', JSON.stringify(SECRET))) as ObservationSet;
  const [first, ...rest] = obs.network;
  const url = `${first!.url}${first!.url.includes("?") ? "&" : "?"}${QUERY}`;
  return { ...obs, network: [{ ...first!, url }, ...rest] };
}

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

/** As popup.ts makes the files: its sealer's masking, and the summary of the Overview's view. */
const makers: ExportMakers = {
  seal: (obs, masked): Promise<EvidenceBundle> => {
    const observations = masked ? redact(obs) : obs;
    return sealBundle({
      schemaVersion: SCHEMA_VERSION,
      scanId: obs.context.scanId ?? "none",
      createdAt: obs.context.capturedAt,
      provenance: {
        schemaVersion: SCHEMA_VERSION, ruleSetVersion: "1.0.0", ruleSetHash: "",
        listSource: "disconnect", listVersion: "test", listHash: "",
      },
      redacted: masked ? "redacted" : "unmasked",
      observations,
      findings: [],
    });
  },
  summary: (obs, bundle) => {
    const functional = getFunctionalCookies();
    const input = classifiedInput(obs, {
      classifier: getClassifier(),
      owners: getOwnerNames(),
      isListedFunctional: (name) => functional.lists(name),
    });
    const view = buildPopupView({ ...input, pending: false, sendingSignal: true, signalKnown: true, checkWellKnownEnabled: true });
    return summaryMarkdown(view, t, {
      extensionVersion: "1.0.0",
      list: "disconnect test",
      capturedAt: bundle.createdAt,
      scanId: bundle.scanId,
      recordHash: bundle.bundleHash,
      limitationsUrl: "https://example.org/limitations",
    });
  },
};

const button = (id: string) => {
  const b = EXPORT_BUTTONS.find((x) => x.id === id);
  if (b === undefined) throw new Error(`no button ${id}`);
  return b;
};

describe("each button saves its own file", () => {
  it("the summary button saves the Markdown summary", async () => {
    const out = await exportFile(openPendingExport(capture()), button("export-summary").file, makers);
    expect(out.type).toBe("text/markdown");
    expect(out.name).toMatch(/^gpc-inspector-summary-example-news\.com-\d{4}-\d{2}-\d{2}\.md$/);
    expect(out.text).toContain("# GPC Inspector findings for");
  });

  it("the log button saves the record without values", async () => {
    const out = await exportFile(openPendingExport(capture()), button("export-save").file, makers);
    expect(out.type).toBe("application/json");
    expect(out.name).not.toContain("unmasked");
    const bundle = JSON.parse(out.text) as EvidenceBundle;
    expect(bundle.redacted).toBe("redacted");
    expect(out.text).not.toContain(SECRET);
    expect(out.text).not.toContain(QUERY);
  });

  it("only the values button saves the record with values, and says so in its name", async () => {
    const out = await exportFile(openPendingExport(capture()), button("export-save-values").file, makers);
    expect(out.type).toBe("application/json");
    expect(out.name).toMatch(/-unmasked\.json$/);
    const bundle = JSON.parse(out.text) as EvidenceBundle;
    expect(bundle.redacted).toBe("unmasked");
    expect(out.text).toContain(SECRET);
    expect(out.text).toContain(QUERY);
  });

  it("names one scan in all three files", async () => {
    const obs = capture();
    const { scanId: _dropped, ...context } = obs.context;
    const pending = openPendingExport({ ...obs, context }, () => "scan-1");
    for (const b of EXPORT_BUTTONS) {
      const out = await exportFile(pending, b.file, makers);
      expect(out.text).toContain("scan-1");
    }
  });

  it("has the values button last, and the summary first", () => {
    expect(EXPORT_BUTTONS.map((b) => b.id)).toEqual(["export-summary", "export-save", "export-save-values"]);
  });

  it("has a label and a hint in the messages for every button", () => {
    for (const b of EXPORT_BUTTONS) {
      expect(messages[b.labelKey]?.message).toBeTruthy();
      expect(messages[b.hintKey]?.message).toBeTruthy();
    }
  });
});

describe("cookie values never reach the summary", () => {
  it("holds no value and no query string, from a record that has both", async () => {
    const obs = capture();
    // Not vacuous: the record holds the secret, and the summary names cookies.
    expect(JSON.stringify(obs)).toContain(SECRET);
    const out = await exportFile(openPendingExport(obs), "summary", makers);
    expect(out.text).toContain("`IDE`");
    expect(out.text).not.toContain(SECRET);
    expect(out.text).not.toContain(QUERY);
  });

  it("names the hash of the masked record in its footer", async () => {
    const pending = openPendingExport(capture());
    const summary = await exportFile(pending, "summary", makers);
    const masked = JSON.parse((await exportFile(pending, "record", makers)).text) as EvidenceBundle;
    expect(summary.text).toContain(masked.bundleHash);
  });
});

describe("a fresh opening carries nothing over", () => {
  it("starts with nothing saved, after every file was saved from the last opening", () => {
    let first = openPendingExport(capture());
    for (const b of EXPORT_BUTTONS) first = markSaved(first, b.file);
    expect(first.saved.size).toBe(3);

    const second = openPendingExport(capture());
    expect(second.saved.size).toBe(0);
    for (const b of EXPORT_BUTTONS) expect(second.saved.has(b.file)).toBe(false);
  });

  it("saves the record it was opened with, not one from an earlier opening", async () => {
    const earlier = openPendingExport({ ...capture(), context: { ...capture().context, topSite: "earlier.example" } });
    markSaved(earlier, "record-with-values");
    const now = openPendingExport(capture());
    const out = await exportFile(now, "record", makers);
    expect(out.name).toContain("example-news.com");
    expect(JSON.parse(out.text).redacted).toBe("redacted");
  });

  it("marks only the file that was saved", () => {
    const pending = markSaved(openPendingExport(capture()), "record");
    expect([...pending.saved]).toEqual(["record"]);
  });
});
