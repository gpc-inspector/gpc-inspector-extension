// SPDX-License-Identifier: GPL-3.0-only
/**
 * Canonicalization — deterministic serialization so a bundle hash is reproducible on
 * any machine, in any process, months apart (PRD FR-23).
 *
 * The rule is simple and strict: JSON with object keys sorted recursively, arrays left
 * in order (order is meaningful — it's observation sequence), no insignificant
 * whitespace. Two structurally-equal values MUST produce byte-identical output.
 *
 * We deliberately do NOT use JSON.stringify's replacer for sorting, because it does not
 * recurse into nested objects predictably across engines. We walk the value ourselves.
 *
 * Constraints (must hold for the hash to mean anything):
 *   - Input must be JSON-serializable: no functions, no undefined, no symbols, no cycles.
 *     ObservationSet and EvidenceBundle satisfy this by construction.
 *   - `undefined` object properties are omitted (matches JSON.stringify). `null` is kept.
 *   - Numbers are emitted via JSON number formatting; non-finite numbers are rejected,
 *     because JSON has no representation for them and they'd silently become null.
 */

/** Thrown when a value cannot be canonicalized deterministically. */
export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/**
 * Produce the canonical string form of a JSON-compatible value.
 * Keys sorted recursively; arrays preserved; strict about non-JSON inputs.
 */
export function canonicalize(value: unknown): string {
  const seen = new WeakSet<object>();

  const walk = (v: unknown): string => {
    if (v === null) return "null";

    const t = typeof v;

    if (t === "boolean") return v ? "true" : "false";

    if (t === "number") {
      if (!Number.isFinite(v as number)) {
        throw new CanonicalizationError(
          `Non-finite number cannot be canonicalized: ${String(v)}`,
        );
      }
      return JSON.stringify(v);
    }

    if (t === "string") return JSON.stringify(v);

    if (t === "bigint") {
      throw new CanonicalizationError("BigInt cannot be canonicalized (not JSON).");
    }
    if (t === "function" || t === "symbol" || t === "undefined") {
      throw new CanonicalizationError(
        `Value of type ${t} cannot be canonicalized (not JSON).`,
      );
    }

    // object or array
    const obj = v as object;
    if (seen.has(obj)) {
      throw new CanonicalizationError("Cycle detected; cannot canonicalize.");
    }
    seen.add(obj);

    try {
      if (Array.isArray(v)) {
        const items = v.map((item) => {
          // Arrays serialize undefined as null (matches JSON.stringify).
          if (item === undefined) return "null";
          return walk(item);
        });
        return `[${items.join(",")}]`;
      }

      // Plain object. Reject exotic objects that JSON would mangle.
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) {
        // Dates, Maps, Sets, class instances, etc. The schema uses only plain objects,
        // so anything else is a bug we want surfaced, not silently coerced.
        throw new CanonicalizationError(
          `Non-plain object cannot be canonicalized: ${proto?.constructor?.name ?? "unknown"}`,
        );
      }

      const record = v as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const parts: string[] = [];
      for (const key of keys) {
        const val = record[key];
        if (val === undefined) continue; // omit undefined props, like JSON.stringify
        parts.push(`${JSON.stringify(key)}:${walk(val)}`);
      }
      return `{${parts.join(",")}}`;
    } finally {
      seen.delete(obj);
    }
  };

  return walk(value);
}

/** Narrowing helper: asserts a value round-trips as JSON without loss. */
export function assertJson(value: unknown): asserts value is Json {
  // canonicalize throws on anything non-JSON; reuse it as the gate.
  canonicalize(value);
}
