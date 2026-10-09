// SPDX-License-Identifier: GPL-3.0-only
/**
 * Attribution for reads of `navigator.globalPrivacyControl` (PRD FR-10, FR-11).
 *
 * WHY THIS EXISTS
 *
 * The read counter says how many times the property was read and nothing about who read
 * it. Without attribution the engine's per-vendor check state would rest entirely on
 * `__gpp` calls, and a vendor that reads the property directly (the mechanism the GPC
 * specification itself defines for scripts) and never calls GPP would be reported as not
 * having checked. That is an absence we could not look for, reported as one we observed.
 *
 * WHY IT HAS A CAP
 *
 * The read counter is on a hot path in a way the consent APIs are not: `__gpp` is called a
 * handful of times per page, while one real news page read the property about 1,900 times
 * and a script can poll it in a loop. `new Error().stack` materializes and formats the
 * call stack, a few microseconds each (measured 2026-09-14: 2 to 9 µs against 0.02 for the
 * bare counter). Cheap enough to pay on every read of an ordinary page, not cheap enough to
 * pay without limit on a polling one.
 *
 * So stacks are captured for every one of the first `eager` reads, then every `every`-th,
 * and never more than `cap` in total. The sampler reports when a page went past `eager`
 * (`capReached`), so the popup can say a read may have gone untraced and point at the
 * setting that lifts the cap.
 *
 * WHY THE COUNTS STAY SEPARATE
 *
 * A traced count is not a share of the total once the cap is passed. `readCount` remains
 * exact and complete; attribution is a lower bound and must be labeled as one wherever it
 * is shown. They are carried as separate numbers rather than one being derived from the
 * other, because scaling a sample up to the total would invent reads we never attributed
 * to anyone.
 *
 * WHAT IT CANNOT DO
 *
 * Attribution fails for the same reasons it fails for consent calls: bundled code, inline
 * script, and vendor code executed inside a tag-manager container, which resolves to the
 * container rather than to the vendor. An unattributed read stays unattributed — it is
 * never assigned to the page, and never to a vendor we merely suspect.
 */

import { attributeCaller } from "./consent-api.js";

export interface ReadSamplePolicy {
  /** Capture a stack for each of the first N reads. */
  readonly eager: number;
  /** After that, capture one in every N. */
  readonly every: number;
  /** Never attempt more than this many captures on one page. */
  readonly cap: number;
}

/**
 * Every read is traced up to a cap, then one in sixteen, then none.
 *
 * Measured: a stack capture costs 2 to 9 microseconds in Chrome 152 depending on depth,
 * against 0.02 for the bare counter, so tracing all of the worst real page seen (~1,900
 * reads) costs 10 to 17 ms spread over the load. A small eager window (32, then one in 16,
 * cap 256) misses any vendor whose one or two reads fall between samples. The cap is what
 * bounds a script that polls the property in a loop; past it, tracing thins to one in
 * sixteen and stops at `cap`. The reader can remove the cap by turning "Limit GPC read
 * tracing" off in settings, which is `UNCAPPED_READ_SAMPLE_POLICY`.
 *
 * With the cookie accessor behind consent tools' wrappers, Osano reads the property once for
 * every page write it sees: 2,190 and 2,283 reads a load on its pages, so a cap of 2,000
 * would leave every vendor without a traced read showing "No (GPC reads exceeded cap)". No
 * other page of the 67 in the 2026-09-27 corpus passed 1,028. The thinned stage keeps its
 * 2,000 captures above the cap.
 */
export const DEFAULT_READ_SAMPLE_POLICY: ReadSamplePolicy = { eager: 5000, every: 16, cap: 7000 };

/** The settings override: trace every read, whatever the page costs. */
export const UNCAPPED_READ_SAMPLE_POLICY: ReadSamplePolicy = { eager: Infinity, every: 1, cap: Infinity };

/** One sampled read, attributed as far as the stack allows. */
export interface SampledRead {
  /** Caller script URL, or null when the stack resolved to nothing we can name. */
  readonly url: string | null;
  /** True when the stack resolved into a tag-manager container rather than a vendor. */
  readonly viaTagManager: boolean;
  /**
   * The innermost tag-manager frame on the stack, query kept, or null. Set whenever
   * `viaTagManager` is, and the URL is what tells one container's reads from another's.
   */
  readonly containerUrl: string | null;
}

export interface ReadSampler {
  /**
   * Record a read. Returns an attribution when this read was sampled, null otherwise.
   *
   * Never throws: this runs inside the property getter, and the value a page reads can
   * never be allowed to depend on our instrumentation succeeding.
   */
  onRead(): SampledRead | null;
  /**
   * Whether reads have gone past the policy's eager window, so some were not traced.
   * False for the life of the page under the uncapped policy.
   */
  capReached(): boolean;
}

/**
 * Build a sampler.
 *
 * @param captureStack returns a raw stack string. Injected rather than calling
 *                     `new Error().stack` directly so this module has no dependency on
 *                     host behavior and the whole suite keeps running in plain Node.
 */
export function createReadSampler(
  captureStack: () => string | undefined,
  policy: ReadSamplePolicy | (() => ReadSamplePolicy) = DEFAULT_READ_SAMPLE_POLICY,
): ReadSampler {
  let reads = 0;
  let attempts = 0;
  // Resolved per read, not once: in the page the policy depends on a marker that a
  // dynamically registered script sets, and that script runs AFTER this module (see the
  // note on `enabled` in main-world.ts). A policy frozen at construction would never see it.
  const current = (): ReadSamplePolicy => (typeof policy === "function" ? policy() : policy);

  return {
    capReached(): boolean {
      return reads > current().eager;
    },
    onRead(): SampledRead | null {
      reads++;
      const p = current();
      if (attempts >= p.cap) return null;
      if (reads > p.eager && reads % p.every !== 0) return null;

      // Counted BEFORE the capture, so a host where stack capture always throws still
      // exhausts the cap and stops paying for it, rather than retrying on every sampled
      // read for the life of the page.
      attempts++;

      let stack: string | undefined;
      try {
        stack = captureStack();
      } catch {
        return null;
      }

      const { url, viaTagManager, containerUrls } = attributeCaller(stack);
      return { url, viaTagManager, containerUrl: containerUrls[0] ?? null };
    },
  };
}
