// SPDX-License-Identifier: GPL-3.0-only
/**
 * Whether a module is the script node was started with, so a compile script runs as one and
 * the tests can still import its parts.
 *
 * Node resolves symlinks in a module's own URL and not in `process.argv[1]`, so comparing
 * the two as given fails for any path through a symlink: a scratch copy under /tmp (on
 * macOS a link to /private/tmp) would print nothing, exit 0 and leave the compiled file as
 * it was.
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Whether `moduleUrl`, a module's `import.meta.url`, is the entry script. */
export function isMain(moduleUrl) {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}
