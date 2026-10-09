// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import { canonicalize, CanonicalizationError } from "../src/canonicalize.js";

describe("canonicalize — determinism", () => {
  it("produces identical output regardless of key insertion order", () => {
    const a = { b: 1, a: 2, c: 3 };
    const b = { c: 3, a: 2, b: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it("sorts keys recursively, not just at the top level", () => {
    const a = { outer: { z: 1, a: 2 }, first: true };
    const b = { first: true, outer: { a: 2, z: 1 } };
    expect(canonicalize(a)).toBe(canonicalize(b));
    // and the nested keys are actually ordered
    expect(canonicalize(a)).toBe('{"first":true,"outer":{"a":2,"z":1}}');
  });

  it("preserves array order (order is meaningful — observation sequence)", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });

  it("is stable across repeated calls on the same structure", () => {
    const v = { a: [1, { x: "y", w: [true, null] }], b: "s" };
    const first = canonicalize(v);
    for (let i = 0; i < 50; i++) expect(canonicalize(v)).toBe(first);
  });
});

describe("canonicalize — JSON semantics", () => {
  it("keeps null but omits undefined object properties (matches JSON.stringify)", () => {
    expect(canonicalize({ a: null, b: undefined, c: 1 })).toBe('{"a":null,"c":1}');
  });

  it("serializes undefined array elements as null (matches JSON.stringify)", () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(canonicalize([1, undefined, 3])).toBe("[1,null,3]");
  });

  it("escapes strings via JSON rules", () => {
    expect(canonicalize('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(canonicalize("tab\there")).toBe('"tab\\there"');
  });

  it("matches JSON.stringify byte-for-byte when keys are already sorted", () => {
    const v = { a: 1, b: [true, false, null], c: "x" };
    expect(canonicalize(v)).toBe(JSON.stringify(v));
  });
});

describe("canonicalize — rejects non-JSON input", () => {
  it("rejects non-finite numbers rather than silently emitting null", () => {
    expect(() => canonicalize(NaN)).toThrow(CanonicalizationError);
    expect(() => canonicalize(Infinity)).toThrow(CanonicalizationError);
    expect(() => canonicalize({ x: -Infinity })).toThrow(CanonicalizationError);
  });

  it("rejects functions, symbols, and bigint", () => {
    expect(() => canonicalize(() => 1)).toThrow(CanonicalizationError);
    expect(() => canonicalize(Symbol("s"))).toThrow(CanonicalizationError);
    expect(() => canonicalize(10n)).toThrow(CanonicalizationError);
  });

  it("rejects non-plain objects that JSON would mangle (Date, Map, class instances)", () => {
    expect(() => canonicalize(new Date())).toThrow(CanonicalizationError);
    expect(() => canonicalize(new Map())).toThrow(CanonicalizationError);
    class Foo {
      x = 1;
    }
    expect(() => canonicalize(new Foo())).toThrow(CanonicalizationError);
  });

  it("accepts a null-prototype object as a plain record", () => {
    const o = Object.create(null) as Record<string, unknown>;
    o["b"] = 1;
    o["a"] = 2;
    expect(canonicalize(o)).toBe('{"a":2,"b":1}');
  });

  it("detects cycles instead of hanging", () => {
    const a: Record<string, unknown> = {};
    a["self"] = a;
    expect(() => canonicalize(a)).toThrow(CanonicalizationError);
  });

  it("allows the same object to appear twice non-cyclically", () => {
    const shared = { v: 1 };
    const container = { a: shared, b: shared };
    // not a cycle — should serialize fine, twice
    expect(canonicalize(container)).toBe('{"a":{"v":1},"b":{"v":1}}');
  });
});
