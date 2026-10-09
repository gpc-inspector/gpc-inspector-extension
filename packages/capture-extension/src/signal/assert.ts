// SPDX-License-Identifier: GPL-3.0-only
/**
 * Property assertion and the read counter (PRD FR-2, FR-4, FR-5, FR-10).
 *
 * Three jobs, in priority order:
 *
 *  1. ASSERT the signal when nothing else does (FR-2, D10). Instance-level accessor,
 *     `configurable: true`, in MAIN world at document_start. Instance-level to match the
 *     ecosystem convention; accessor because the read counter needs a getter;
 *     configurable so this extension never crashes the next one.
 *
 *  2. COUNT reads (FR-10). Every read of navigator.globalPrivacyControl is reported. This is the artifact behind the strongest finding in the product: "no script
 *     on this page read your signal." Verified against Firefox's shipping native
 *     implementation: the native property is a configurable accessor, so the counter
 *     survives Chrome's post-AB 566 native GPC.
 *
 *  3. WRAP, NEVER SHADOW, when someone else owns it (FR-10). If a native or other-
 *     extension signal exists, we do not replace its value — we install a counting
 *     accessor that returns `original.get.call(this)` untouched. We observe; we do not
 *     alter what the page sees.
 *
 * When the existing descriptor is non-configurable, we do nothing and report read
 * tracking as unavailable (FR-5). Attempting defineProperty there would throw and break
 * whichever extension got there first.
 */

import {
  detectSignalSource,
  OWNER_MARK,
  type SourceDetection,
  type SignalSource,
} from "./detect.js";

export type ReadTracking = "active" | "unavailable";

export interface AssertionResult {
  /** What owned the property BEFORE we touched it. Historical; not the reportable source. */
  readonly detection: SourceDetection;
  /** True when this extension is the one asserting the value. */
  readonly asserted: boolean;
  readonly readTracking: ReadTracking;
  /**
   * Who is asserting the signal NOW — the value to report and store.
   *
   * Distinct from `detection.source`, which describes the world before we ran. Detection
   * happens first, so on a page where nothing owned the property it returns "none"; if we
   * then assert, the effective source is "this-extension". Reporting the detection value
   * instead would produce a capture that reads `source: "none"` while simultaneously
   * counting reads through our own accessor (~1,800 on one page), describing a state that
   * has already ceased to exist by the time the report is sent.
   */
  readonly effectiveSource: SignalSource;
}

/**
 * How a read is reported. Injectable so this module has no hard DOM dependency: the
 * extension passes the real DOM dispatcher, tests pass a counter. Keeping the DOM out of
 * the module's contract is also what lets the whole test suite run in plain Node, without
 * a jsdom environment, which costs minutes per run on some machines.
 */
export type ReadReporter = () => void;

/**
 * Default reporter: counts nothing. main-world.ts passes the real one, which sends over the
 * private channel (content/channel.ts). Never `document`, where the page could send reads
 * of its own.
 */
export function noReadReporter(): void {
  /* nothing to report to */
}

/**
 * Install the counting accessor.
 *
 * @param nav       the Navigator to define on
 * @param produce   returns the value the page should see for each read
 * @returns true when the property was successfully defined
 */
function installAccessor(
  nav: Navigator,
  produce: (self: Navigator) => unknown,
  report: ReadReporter,
): boolean {
  const getter = function (this: Navigator): unknown {
    // Counting is strictly best-effort. A throwing reporter must never propagate into
    // the page's read of navigator.globalPrivacyControl — the signal's correctness can
    // never depend on our instrumentation succeeding.
    try {
      report();
    } catch {
      /* swallowed by design */
    }
    return produce(this);
  };
  // Tag it so a later detection pass recognizes this as ours (FR-3).
  Object.defineProperty(getter, OWNER_MARK, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  try {
    Object.defineProperty(nav, "globalPrivacyControl", {
      get: getter,
      configurable: true, // never crash the next extension
      enumerable: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Apply the set-if-unset policy and install read counting where possible.
 *
 * @param enabled  whether the user has this extension's signal-sending turned on.
 *                 When false we still WRAP an existing signal for observation, but we
 *                 never assert one of our own.
 */
/**
 * Assert the signal, honoring the send setting.
 *
 * `enabled` is a FUNCTION, not a boolean, and that is load-bearing. The permission to
 * assert arrives from a separately-registered MAIN-world script, and statically declared
 * content scripts run before dynamically registered ones, so reading the flag once at
 * startup would read it before it is set, every time, and the setting would appear to do
 * nothing.
 *
 * The accessor is lazy, so it can consult the flag on each read instead. Both scripts run
 * at document_start and page scripts run after, so the answer is correct by the time
 * anything asks. It also means toggling does not depend on injection order, which is not
 * a guarantee the platform makes.
 */
export function assertSignal(
  enabled: boolean | (() => boolean),
  nav: Navigator = navigator,
  report: ReadReporter = noReadReporter,
): AssertionResult {
  const isEnabled = (): boolean => (typeof enabled === "function" ? enabled() : enabled);
  const detection = detectSignalSource(nav);

  // Someone else owns it: wrap for counting, never change the value.
  if (detection.source === "native" || detection.source === "other-extension") {
    if (!detection.configurable) {
      // FR-5: degrade honestly. No defineProperty attempt — it would throw.
      return {
        detection,
        asserted: false,
        readTracking: "unavailable",
        effectiveSource: detection.source,
      };
    }

    const owner =
      Object.getOwnPropertyDescriptor(nav, "globalPrivacyControl") ??
      Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(nav) as object,
        "globalPrivacyControl",
      );

    if (!owner) {
      return {
        detection,
        asserted: false,
        readTracking: "unavailable",
        effectiveSource: detection.source,
      };
    }

    const ok = installAccessor(
      nav,
      (self) => {
        // Return exactly what the original would have returned.
        if (owner.get) return owner.get.call(self);
        return owner.value;
      },
      report,
    );

    return {
      detection,
      asserted: false,
      readTracking: ok ? "active" : "unavailable",
      // Someone else owns the value; we only wrapped it to count reads.
      effectiveSource: detection.source,
    };
  }

  // Already ours (re-injection): leave it alone, counting is already active.
  if (detection.source === "this-extension") {
    return {
      detection,
      asserted: isEnabled(),
      readTracking: "active",
      effectiveSource: "this-extension",
    };
  }

  // Nothing owns it. One accessor covers both states: it answers whatever the setting says
  // AT THE MOMENT OF THE READ.
  //
  // FR-4 tri-state: with sending off the property reads `false` — supported but not
  // enabled — never `undefined`, which would mean unsupported.
  const ok = installAccessor(nav, () => isEnabled(), report);
  const on = isEnabled();
  return {
    detection,
    asserted: ok && on,
    readTracking: ok ? "active" : "unavailable",
    // We are the source now — this is what gets reported, not the pre-assertion detection.
    effectiveSource: ok && on ? "this-extension" : "none",
  };
}
