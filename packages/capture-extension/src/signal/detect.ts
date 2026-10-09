// SPDX-License-Identifier: GPL-3.0-only
/**
 * Signal source detection (PRD FR-3, D10).
 *
 * Runs in the MAIN world at document_start, BEFORE this extension asserts anything.
 * Classifies who — if anyone — already owns `navigator.globalPrivacyControl`, so we can
 * honor the set-if-unset rule: never double-set, never break Privacy Badger or
 * DuckDuckGo, never claim credit for a signal we didn't send.
 *
 * Four outcomes:
 *   native          — the browser's own implementation (post-AB 566 Chrome, Firefox).
 *                     Detected because the getter's toString() reports [native code].
 *   this-extension  — our own accessor, tagged with a non-enumerable marker.
 *   other-extension — an accessor or data property exists, isn't native, isn't ours.
 *                     We deliberately do NOT try to name which extension: we can't, and
 *                     guessing would be a claim we can't support.
 *   none            — nothing owns it. Only in this case do we assert.
 *
 * Two ecosystem realities this encodes, learned from Privacy Badger's implementation:
 *   1. Peers set an INSTANCE-level data property on `navigator`, not a prototype
 *      accessor. An instance property shadows the prototype, so we must check the
 *      instance first or we'll mis-detect.
 *   2. A non-configurable descriptor cannot be wrapped. When we hit one, read tracking
 *      is unavailable and we say so rather than pretending (FR-5).
 */

/** Marker attached to our own accessor so we can recognize it on a later pass. */
export const OWNER_MARK = "__gpcInspectorOwned";

export type SignalSource = "native" | "this-extension" | "other-extension" | "none";

export interface SourceDetection {
  readonly source: SignalSource;
  /** The current value the page would read, or "absent" if the property doesn't exist. */
  readonly value: true | false | "absent";
  /** Whether the existing descriptor can be redefined (and therefore wrapped). */
  readonly configurable: boolean;
  /** Where the property lives, when it exists. */
  readonly location: "instance" | "prototype" | "none";
}

function isNativeGetter(fn: unknown): boolean {
  if (typeof fn !== "function") return false;
  try {
    return Function.prototype.toString.call(fn).includes("[native code]");
  } catch {
    return false;
  }
}

function isOurs(descriptor: PropertyDescriptor): boolean {
  const target = descriptor.get ?? descriptor.value;
  return (
    typeof target === "function" &&
    (target as unknown as Record<string, unknown>)[OWNER_MARK] === true
  );
}

/**
 * Inspect the current state of navigator.globalPrivacyControl.
 * Pure observation — asserts nothing, mutates nothing.
 */
export function detectSignalSource(nav: Navigator = navigator): SourceDetection {
  // Instance first: an own property shadows the prototype (the Privacy Badger pattern).
  const instance = Object.getOwnPropertyDescriptor(nav, "globalPrivacyControl");
  const proto = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(nav) as object,
    "globalPrivacyControl",
  );

  const descriptor = instance ?? proto;
  const location: SourceDetection["location"] = instance
    ? "instance"
    : proto
      ? "prototype"
      : "none";

  if (!descriptor) {
    return { source: "none", value: "absent", configurable: true, location: "none" };
  }

  // Read the current value without triggering side effects we care about.
  let value: true | false | "absent";
  try {
    const raw = (nav as unknown as Record<string, unknown>)["globalPrivacyControl"];
    value = raw === true ? true : raw === false ? false : "absent";
  } catch {
    value = "absent";
  }

  const configurable = descriptor.configurable === true;

  if (isOurs(descriptor)) {
    return { source: "this-extension", value, configurable, location };
  }

  // Native implementations expose an accessor whose getter is native code. A data
  // property is never native for this attribute: WebIDL materializes it as an accessor.
  if (descriptor.get && isNativeGetter(descriptor.get)) {
    return { source: "native", value, configurable, location };
  }

  return { source: "other-extension", value, configurable, location };
}
