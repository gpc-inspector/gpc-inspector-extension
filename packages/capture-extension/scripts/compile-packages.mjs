// SPDX-License-Identifier: GPL-3.0-only
/**
 * Compiles the workspace packages the extension bundles: schema, engine and lists.
 *
 * esbuild resolves `@gpc-inspector/*` imports to each package's compiled `dist/`, not its
 * source, so a bundle built after a pull without this step inlines whatever `dist/` last
 * held. That can pair a newly compiled list with an older category validator: every
 * category name the older validator does not know loads as "unknown", so the Requests tab
 * shows no category for those domains and files them under "unclassified". The counts stay
 * right while Advertising and Analytics keep their names, so a glance at the popup's
 * headline does not catch the mismatch.
 *
 * `tsc --build` is incremental: when `dist/` is current it checks timestamps and returns.
 * Shared by build-extension.mjs and the harness so the two bundles cannot differ in this.
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");

export function compilePackages() {
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  execFileSync(
    process.execPath,
    [tsc, "--build", "packages/schema", "packages/engine", "packages/lists"],
    { cwd: root, stdio: "inherit" },
  );
}
