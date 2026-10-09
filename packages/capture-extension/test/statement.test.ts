// SPDX-License-Identifier: GPL-3.0-only
/**
 * The notices in notices.ts. The statement that limits reliance: the same words in the
 * README, Settings (About) and the saved summary, and nowhere else in the popup. The
 * summary's footer is held by summary-markdown.test.ts. The license and the
 * copyright line About shows are the ones the license files give.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import messagesJson from "../public/_locales/en/messages.json" with { type: "json" };
import rootPackage from "../../../package.json" with { type: "json" };
import extensionPackage from "../package.json" with { type: "json" };
import { STATEMENT_KEYS, CODE_LICENSE, COPYRIGHT } from "../src/ui/notices.js";

const messages = messagesJson as Record<string, { message: string }>;
const path = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const read = (relative: string): string => readFileSync(path(relative), "utf8");

/** Every .ts file under src, as [path relative to src, contents]. */
function sources(): [string, string][] {
  const root = path("../src");
  return (readdirSync(root, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".ts"))
    .map((f) => [f.split("\\").join("/"), readFileSync(join(root, f), "utf8")]);
}

describe("the statement", () => {
  it("is in Settings once, and in no other screen of popup.html", () => {
    const html = read("../public/popup.html");
    const start = html.indexOf('<section id="settings"');
    const settings = html.slice(start, html.indexOf("</section>", start));
    for (const key of STATEMENT_KEYS) {
      expect(html.split(`data-i18n="${key}"`).length - 1).toBe(1);
      expect(settings).toContain(`data-i18n="${key}"`);
    }
  });

  it("is rendered from code only by the summary", () => {
    for (const [file, text] of sources()) {
      if (file === "ui/notices.ts") continue;
      const uses = text.includes("STATEMENT_KEYS") || STATEMENT_KEYS.some((key) => text.includes(key));
      expect(uses ? file : "").toBe(file === "ui/summary-markdown.ts" ? file : "");
    }
  });

  it("is in the README word for word", () => {
    const readme = read("../../../README.md").replace(/\s*\n\s*/g, " ");
    for (const key of STATEMENT_KEYS) expect(readme).toContain(messages[key]!.message);
  });
});

describe("the license About names", () => {
  it("is the license every package.json of our code gives", () => {
    expect(rootPackage.license).toBe(CODE_LICENSE);
    expect(extensionPackage.license).toBe(CODE_LICENSE);
  });

  it("has the copyright line of NOTICE and packages/lists/LICENSE", () => {
    expect(read("../../../NOTICE")).toContain(`\n${COPYRIGHT}\n`);
    expect(read("../../lists/LICENSE")).toContain(`${COPYRIGHT}\n`);
  });
});
