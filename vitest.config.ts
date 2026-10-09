// SPDX-License-Identifier: GPL-3.0-only
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    // Large JSON classification data are fixtures, never test sources.
    exclude: ["**/node_modules/**", "**/dist/**", "**/dist-ext/**", "**/data/**"],
    environment: "node",

    // Threads, not forks, and only one.
    //
    // Vitest defaults to the `forks` pool, which spawns an OS process per test file. On
    // machines where process creation is slow — macOS with endpoint security scanning
    // each spawned binary is the common case — workers exceed the startup timeout and the
    // run fails before a single test executes. Worker threads are far cheaper, and one is
    // plenty: the suite is pure and finishes in ~2 seconds. Parallelism buys nothing here
    // and costs reliability.
    pool: "threads",
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,

    // No hookTimeout override. wiring.test.ts pays its one expensive import in a
    // `beforeAll` with its own budget; see the comment there. Per-test hooks keep the
    // default so a genuine hang still fails in seconds.
  },
});
