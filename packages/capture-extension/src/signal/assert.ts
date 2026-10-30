// SPDX-License-Identifier: GPL-3.0-only
/**
 * Property assertion and the read counter (PRD FR-2, FR-4, FR-5, FR-10).
 *
 * Three jobs, in priority order:
 *
 *  1. ASSERT the signal while sending is on (FR-2). Instance-level accessor in MAIN world
 *     at document_start. Instance-level to match the ecosystem convention; accessor
 *     because the read counter needs a getter. Installed only once sending is known to be
 *     on: on a page nothing owns, no property is defined before that, so the page reads
 *     what the browser gives it (undefined in Chrome and Edge) and never a `false` this
 *     extension cannot stand behind. A page that loads in the moment after the extension
 *     loads can run the manifest script and not the registered one that carries the
 *     permission (the browser loads registered scripts on its own schedule), while the
 *     Sec-GPC header rule is already live: a `false` there would tell the site the user
 *     turned GPC off beside a header that says the opposite. Installed configurable; once
 *     sending is on, lockSignal makes it non-configurable, so an extension whose script
 *     runs later cannot replace the true the header agrees with. Content scripts of
 *     different extensions run in no promised order.
 *
 *  2. COUNT reads (FR-10). Every read of navigator.globalPrivacyControl is reported. This is the artifact behind the strongest finding in the product: "no script
 *     on this page read your signal." Verified against Firefox's shipping native
 *     implementation: the native property is a configurable accessor, so the counter
 *     survives Chrome's post-AB 566 native GPC.
 *
 *  3. WRAP when someone else owns it (FR-10). If a native or other-extension signal
 *     exists, we install a counting accessor over it. With sending on, the page reads
 *     `true`: the Sec-GPC header goes out on every request while sending is on, and a
 *     property that reads `false` beside it would send the site two answers. With sending
 *     off, the accessor returns `original.get.call(this)` untouched: turning sending off
 *     never disables a signal the browser or another extension set.
 *
 * When the existing descriptor is non-configurable, we do nothing and report read
 * tracking as unavailable (FR-5). Attempting defineProperty there would throw and break
 * whichever extension got there first.
 */

import {
  detectSignalSource,
  isOurs,
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
 * True while this module reads the property itself (ownerSince). A new owner may call
 * through to our getter, and that read is ours, not the page's.
 */
let lookingItself = false;

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
      if (!lookingItself) report();
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
 * Apply the send setting and install read counting where possible.
 *
 * @param enabled  whether the user has this extension's signal-sending turned on.
 *                 When false we still WRAP an existing signal for observation, but we
 *                 never assert one of our own or change its value.
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
 * On a page nothing owns, nothing is defined until the flag is on: the caller runs this
 * again when the permission arrives (main-world.ts, the "assert" join), and only then is
 * the accessor installed. Both scripts run at document_start and page scripts run after,
 * so the property exists by the time anything asks. Where someone else owns the property,
 * it is wrapped at once for counting, and the wrapper consults the flag on each read, so
 * toggling does not depend on injection order, which is not a guarantee the platform makes.
 */
export function assertSignal(
  enabled: boolean | (() => boolean),
  nav: Navigator = navigator,
  report: ReadReporter = noReadReporter,
): AssertionResult {
  const isEnabled = (): boolean => (typeof enabled === "function" ? enabled() : enabled);
  const detection = detectSignalSource(nav);

  // Someone else owns it: wrap for counting, and answer true while sending is on.
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
        // Sending is on: the page reads what the header says. Read lazily, like the
        // unowned case, because the permission arrives after this runs.
        if (isEnabled()) return true;
        // Sending is off: exactly what the original would have returned.
        if (owner.get) return owner.get.call(self);
        return owner.value;
      },
      report,
    );

    const overrides = ok && isEnabled() && detection.value !== true;
    return {
      detection,
      asserted: overrides,
      readTracking: ok ? "active" : "unavailable",
      // An owner that already reads true keeps the credit; one that reads false or nothing
      // is overridden, and the value the page reads is ours.
      effectiveSource: overrides ? "this-extension" : detection.source,
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

  // Nothing owns it. Until sending is known to be on, nothing is defined: the page reads
  // what the browser gives it, and no read is counted, since there is no property to read.
  // A `false` here would claim "supported, off" on the strength of a permission that has
  // not arrived, and on a load the registered script misses it would stand beside a
  // Sec-GPC header that says the opposite.
  if (!isEnabled()) {
    return { detection, asserted: false, readTracking: "unavailable", effectiveSource: "none" };
  }

  // Sending is on: the accessor answers whatever the setting says AT THE MOMENT OF THE
  // READ, so a setting turned off without a reload reads false, as the tri-state wants.
  const ok = installAccessor(nav, () => isEnabled(), report);
  return {
    detection,
    asserted: ok,
    readTracking: ok ? "active" : "unavailable",
    // We are the source now — this is what gets reported, not the pre-assertion detection.
    effectiveSource: ok ? "this-extension" : "none",
  };
}

/**
 * Who owns the property now, where another script replaced this extension's accessor after
 * it was installed; null while it is still ours, or where it never was.
 *
 * With the lock off (the default) our accessor is configurable on purpose, so an
 * extension's script that runs later can define its own on `navigator`. Page scripts then
 * read that one, and their reads no longer reach our counter. A definition on the
 * prototype changes nothing: our own property shadows it.
 *
 * The new owner's value is read once, to report what pages read. Where its getter calls
 * through to ours, that read is not counted.
 */
export function ownerSince(result: AssertionResult, nav: Navigator = navigator): SourceDetection | null {
  if (result.readTracking !== "active" || ownsSignal(nav)) return null;
  lookingItself = true;
  try {
    return detectSignalSource(nav);
  } finally {
    lookingItself = false;
  }
}

/** Whether the property on `nav` is this extension's accessor. Reads no value. */
export function ownsSignal(nav: Navigator = navigator): boolean {
  const d = Object.getOwnPropertyDescriptor(nav, "globalPrivacyControl");
  return d !== undefined && isOurs(d);
}

/**
 * Make this extension's accessor permanent for the page: called once sending is known to
 * be on. A later `defineProperty` of `globalPrivacyControl` on this navigator then throws,
 * so the page keeps reading true, the value the Sec-GPC header carries.
 *
 * The getter is kept as it is, so counting and the lazy setting read go on. Returns false
 * when the property is not ours (the caller takes it back first) or cannot be redefined.
 */
export function lockSignal(nav: Navigator = navigator): boolean {
  const d = Object.getOwnPropertyDescriptor(nav, "globalPrivacyControl");
  if (d === undefined || d.get === undefined || !isOurs(d)) return false;
  if (d.configurable === false) return true;
  try {
    Object.defineProperty(nav, "globalPrivacyControl", {
      get: d.get,
      configurable: false,
      enumerable: true,
    });
    return true;
  } catch {
    return false;
  }
}
