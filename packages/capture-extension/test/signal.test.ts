// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import { detectSignalSource, OWNER_MARK } from "../src/signal/detect.js";
import { assertSignal, lockSignal, ownsSignal, ownerSince, withdrawSignal } from "../src/signal/assert.js";
import {
  parseSetCookie,
  parseSetCookieHeaders,
  isRedirectStatus,
  hasSecGpc,
  findHeader,
} from "../src/observe/cookies.js";
import { buildGpcRule, GPC_RULE_ID } from "../src/signal/dnr.js";

// TS's bundled DOM lib has no knowledge of this non-standardized property. src/ avoids
// needing the augmentation by going through casts (see detect.ts/assert.ts); these tests
// read and write it directly, so the type is declared here instead.
declare global {
  interface Navigator {
    globalPrivacyControl?: boolean;
  }
}

/**
 * A fake Navigator we can put into each ecosystem state. These tests pin the LOGIC that
 * decides what to do in each state, not real browser behavior.
 */
function makeNav(): Navigator {
  const proto = {};
  return Object.create(proto) as Navigator;
}

/**
 * Simulate a native accessor.
 *
 * NOTE: overriding the getter's own `toString` does not fake nativeness, and that is a
 * security property we want: the detector uses `Function.prototype.toString.call(fn)`,
 * which ignores an overridden own toString. A hostile page therefore cannot forge a native
 * getter to convince the extension that Chrome owns the signal.
 *
 * To get a genuinely native getter we borrow one from a real built-in (Map.prototype
 * .size), then bind the value we want through a native-backed closure.
 */
function defineNative(nav: Navigator, value: boolean): void {
  const backing = new Map<string, boolean>();
  backing.set("v", value);
  // `Map.prototype.get` is native; .bind() of a native function is still reported as
  // native by Function.prototype.toString.
  const nativeGetter = Map.prototype.get.bind(backing, "v") as unknown as () => boolean;
  Object.defineProperty(Object.getPrototypeOf(nav) as object, "globalPrivacyControl", {
    get: nativeGetter,
    configurable: true,
    enumerable: true,
  });
}

/** Privacy Badger's pattern: an instance-level DATA property. */
function defineOtherExtensionInstance(nav: Navigator, value: boolean, configurable = true): void {
  Object.defineProperty(nav, "globalPrivacyControl", {
    value,
    configurable,
    enumerable: true,
    writable: false,
  });
}

/**
 * An accessor an earlier run of main-world.js left: marked as this extension's, answering
 * that run's value, and counting into `onRead`, a channel nothing listens on any more.
 */
function defineOurs(nav: Navigator, value: boolean, onRead: () => void = () => {}): void {
  const getter = (): boolean => {
    onRead();
    return value;
  };
  Object.defineProperty(getter, OWNER_MARK, { value: true });
  Object.defineProperty(nav, "globalPrivacyControl", { get: getter, configurable: true, enumerable: true });
}

describe("source detection (FR-3)", () => {
  it("reports none when nothing owns the property", () => {
    const d = detectSignalSource(makeNav());
    expect(d.source).toBe("none");
    expect(d.value).toBe("absent");
    expect(d.location).toBe("none");
  });

  it("detects a native implementation by its [native code] getter", () => {
    const nav = makeNav();
    defineNative(nav, true);
    const d = detectSignalSource(nav);
    expect(d.source).toBe("native");
    expect(d.value).toBe(true);
    expect(d.location).toBe("prototype");
    expect(d.configurable).toBe(true);
  });

  it("detects another extension's instance-level data property", () => {
    const nav = makeNav();
    defineOtherExtensionInstance(nav, true);
    const d = detectSignalSource(nav);
    expect(d.source).toBe("other-extension");
    expect(d.location).toBe("instance");
  });

  it("reports non-configurable ownership so we can degrade instead of throwing (FR-5)", () => {
    const nav = makeNav();
    defineOtherExtensionInstance(nav, true, false);
    const d = detectSignalSource(nav);
    expect(d.source).toBe("other-extension");
    expect(d.configurable).toBe(false);
  });

  it("recognizes our own accessor on a second pass", () => {
    const nav = makeNav();
    assertSignal(true, nav);
    const d = detectSignalSource(nav);
    expect(d.source).toBe("this-extension");
  });

  it("prefers the instance property over the prototype (shadowing is real)", () => {
    const nav = makeNav();
    defineNative(nav, false); // prototype says false
    defineOtherExtensionInstance(nav, true); // instance says true — this is what pages see
    const d = detectSignalSource(nav);
    expect(d.location).toBe("instance");
    expect(d.source).toBe("other-extension");
  });
});

describe("signal assertion (FR-2, FR-4, D10)", () => {
  it("asserts true when nothing else does and sending is enabled", () => {
    const nav = makeNav();
    const r = assertSignal(true, nav);
    expect(r.asserted).toBe(true);
    expect(r.readTracking).toBe("active");
    expect(nav.globalPrivacyControl).toBe(true);
  });

  it("defines nothing while sending is off and nothing else owns the property", () => {
    // The page reads what the browser gives it. A false here would claim "supported, off"
    // on the strength of a permission that has not arrived, and on a load the registered
    // script misses it would stand beside a Sec-GPC header that says the opposite.
    const nav = makeNav();
    const r = assertSignal(false, nav);
    expect(r.asserted).toBe(false);
    expect(r.readTracking).toBe("unavailable");
    expect(r.effectiveSource).toBe("none");
    expect("globalPrivacyControl" in nav).toBe(false);
    expect(nav.globalPrivacyControl).toBeUndefined();
  });

  it("defines true at once on an unowned navigator, and counts from the first read", () => {
    // main-world.ts passes a flag that stays on until the deny script joins (1.44.0): the
    // manifest script is the only one live from the moment the extension loads, so a page
    // that loads before the registered scripts reach it still reads true.
    const nav = makeNav();
    let denied = false;
    let reads = 0;
    const r = assertSignal(() => !denied, nav, () => reads++);
    expect(r.asserted).toBe(true);
    expect(r.readTracking).toBe("active");
    expect(r.effectiveSource).toBe("this-extension");
    expect(nav.globalPrivacyControl).toBe(true);
    expect(reads).toBe(1);
  });

  it("removes the property on deny, so the page reads what the browser gives it", () => {
    // main-world.ts at the "deny" join, or at the worker's policy with sending off.
    const nav = makeNav();
    let denied = false;
    let reads = 0;
    assertSignal(() => !denied, nav, () => reads++);
    denied = true;
    expect(withdrawSignal(nav)).toBe(true);
    expect("globalPrivacyControl" in nav).toBe(false);
    expect(nav.globalPrivacyControl).toBeUndefined();
    // Run again with the flag off, as main-world.ts does: nothing defined, nothing counted.
    const after = assertSignal(() => !denied, nav, () => reads++);
    expect(after.readTracking).toBe("unavailable");
    expect(after.effectiveSource).toBe("none");
    void nav.globalPrivacyControl;
    expect(reads).toBe(0);
  });

  it("answers nothing on deny where its locked property cannot be removed", () => {
    const nav = makeNav();
    let denied = false;
    assertSignal(() => !denied, nav, () => {});
    lockSignal(nav);
    denied = true;
    expect(withdrawSignal(nav)).toBe(false);
    expect(nav.globalPrivacyControl).toBeUndefined();
  });

  it("wraps an owner's property and leaves it at its value on deny", () => {
    // main-world.ts withdraws only where nothing else owned the property: over an owner's,
    // ours is the wrapper, which answers the owner's value once sending is off, and goes on
    // counting reads of it.
    const nav = makeNav();
    defineOtherExtensionInstance(nav, false);
    let denied = false;
    let reads = 0;
    const r = assertSignal(() => !denied, nav, () => reads++);
    expect(r.detection.source).toBe("other-extension");
    expect(nav.globalPrivacyControl).toBe(true);
    denied = true;
    expect(nav.globalPrivacyControl).toBe(false);
    expect(reads).toBe(2);
  });

  it("installs a CONFIGURABLE accessor so the next extension can redefine it", () => {
    const nav = makeNav();
    assertSignal(true, nav);
    const d = Object.getOwnPropertyDescriptor(nav, "globalPrivacyControl");
    expect(d?.configurable).toBe(true);
    // and a peer can in fact redefine it without throwing
    expect(() =>
      Object.defineProperty(nav, "globalPrivacyControl", {
        value: true,
        configurable: true,
      }),
    ).not.toThrow();
  });

  it("does NOT overwrite a native signal's value — it wraps and returns the original", () => {
    const nav = makeNav();
    defineNative(nav, true);
    const r = assertSignal(true, nav);
    expect(r.asserted).toBe(false); // we did not assert; native owns it
    expect(r.readTracking).toBe("active"); // but we are counting reads
    expect(nav.globalPrivacyControl).toBe(true); // native's value, untouched
  });

  it("reads true over a native FALSE while sending is on, matching the Sec-GPC header", () => {
    const nav = makeNav();
    defineNative(nav, false);
    const r = assertSignal(true, nav);
    expect(nav.globalPrivacyControl).toBe(true);
    expect(r.asserted).toBe(true);
    expect(r.effectiveSource).toBe("this-extension");
    expect(r.readTracking).toBe("active");
  });

  it("reads true over another extension's FALSE while sending is on", () => {
    const nav = makeNav();
    defineOtherExtensionInstance(nav, false);
    const r = assertSignal(true, nav);
    expect(nav.globalPrivacyControl).toBe(true);
    expect(r.asserted).toBe(true);
    expect(r.effectiveSource).toBe("this-extension");
  });

  it("leaves a native FALSE untouched while sending is off", () => {
    const nav = makeNav();
    defineNative(nav, false);
    const r = assertSignal(false, nav);
    expect(nav.globalPrivacyControl).toBe(false);
    expect(r.asserted).toBe(false);
    expect(r.effectiveSource).toBe("native");
  });

  it("cannot override a non-configurable FALSE, and says so", () => {
    const nav = makeNav();
    defineOtherExtensionInstance(nav, false, false);
    const r = assertSignal(true, nav);
    expect(nav.globalPrivacyControl).toBe(false);
    expect(r.asserted).toBe(false);
    expect(r.readTracking).toBe("unavailable");
    expect(r.effectiveSource).toBe("other-extension");
  });

  it("degrades honestly when another extension holds a non-configurable property (FR-5)", () => {
    const nav = makeNav();
    defineOtherExtensionInstance(nav, true, false);
    const r = assertSignal(true, nav);
    expect(r.asserted).toBe(false);
    expect(r.readTracking).toBe("unavailable");
    expect(nav.globalPrivacyControl).toBe(true); // theirs, untouched
  });

  it("counts every read (FR-10)", () => {
    const nav = makeNav();
    let reads = 0;
    assertSignal(true, nav, () => reads++);
    void nav.globalPrivacyControl;
    void nav.globalPrivacyControl;
    void nav.globalPrivacyControl;
    expect(reads).toBe(3);
  });

  it("counts reads while wrapping a native signal, without altering its value", () => {
    const nav = makeNav();
    defineNative(nav, true);
    let reads = 0;
    assertSignal(true, nav, () => reads++);
    expect(nav.globalPrivacyControl).toBe(true);
    expect(nav.globalPrivacyControl).toBe(true);
    expect(reads).toBe(2);
  });

  it("never lets a broken reporter break the value the page reads", () => {
    const nav = makeNav();
    assertSignal(true, nav, () => {
      throw new Error("reporter exploded");
    });
    // Counting is best-effort; the signal itself must survive a throwing reporter.
    expect(() => nav.globalPrivacyControl).not.toThrow();
    expect(nav.globalPrivacyControl).toBe(true);
  });

  it("marks its own getter so re-injection is idempotent", () => {
    const nav = makeNav();
    assertSignal(true, nav);
    const d = Object.getOwnPropertyDescriptor(nav, "globalPrivacyControl");
    expect((d?.get as unknown as Record<string, unknown>)[OWNER_MARK]).toBe(true);
  });
});

describe("Set-Cookie parsing (FR-8, FR-9)", () => {
  it("parses a real doubleclick IDE cookie", () => {
    const c = parseSetCookie(
      "IDE=AHWqTUm123; expires=Fri, 14 Aug 2028 00:00:00 GMT; path=/; domain=.doubleclick.net; Secure; HttpOnly; SameSite=none",
      ".fallback",
    );
    expect(c).not.toBeNull();
    expect(c!.name).toBe("IDE");
    expect(c!.domain).toBe(".doubleclick.net");
    expect(c!.sameSite).toBe("None");
    expect(c!.secure).toBe(true);
    expect(c!.httpOnly).toBe(true);
    expect(c!.partitioned).toBe(false);
    expect(typeof c!.expiresMs).toBe("number");
  });

  it("captures the Partitioned (CHIPS) attribute", () => {
    const c = parseSetCookie("id=x; Partitioned; Secure; SameSite=None", ".example");
    expect(c!.partitioned).toBe(true);
  });

  it("treats a cookie with no attributes as a session cookie", () => {
    const c = parseSetCookie("sid=abc", ".example");
    expect(c!.expiresMs).toBe("session");
  });

  it("lets Max-Age win over Expires, per RFC 6265", () => {
    const c = parseSetCookie(
      "a=b; Expires=Fri, 14 Aug 2020 00:00:00 GMT; Max-Age=3600",
      ".example",
    );
    expect(typeof c!.expiresMs).toBe("number");
    expect(c!.expiresMs as number).toBeGreaterThan(Date.now());
  });

  it("returns null for a header with no name", () => {
    expect(parseSetCookie("", ".example")).toBeNull();
    expect(parseSetCookie("novalue", ".example")).toBeNull();
    expect(parseSetCookie("=justvalue", ".example")).toBeNull();
  });

  it("extracts every Set-Cookie from a header list, including newline-joined", () => {
    const cookies = parseSetCookieHeaders(
      [
        { name: "Content-Type", value: "text/html" },
        { name: "Set-Cookie", value: "a=1; Path=/" },
        { name: "set-cookie", value: "b=2; Path=/\nc=3; Path=/" },
      ],
      ".example",
    );
    expect(cookies.map((c) => c.name)).toEqual(["a", "b", "c"]);
  });
});

describe("request helpers", () => {
  it("recognizes Sec-GPC: 1 and only that value", () => {
    expect(hasSecGpc([{ name: "Sec-GPC", value: "1" }])).toBe(true);
    expect(hasSecGpc([{ name: "sec-gpc", value: "1" }])).toBe(true);
    expect(hasSecGpc([{ name: "Sec-GPC", value: "0" }])).toBe(false);
    expect(hasSecGpc([{ name: "Sec-GPC", value: "true" }])).toBe(false);
    expect(hasSecGpc([])).toBe(false);
  });

  it("identifies redirect statuses", () => {
    expect(isRedirectStatus(302)).toBe(true);
    expect(isRedirectStatus(301)).toBe(true);
    expect(isRedirectStatus(307)).toBe(true);
    expect(isRedirectStatus(200)).toBe(false);
    expect(isRedirectStatus(204)).toBe(false);
  });

  it("finds headers case-insensitively", () => {
    expect(findHeader([{ name: "Content-Type", value: "x" }], "content-type")).toBe("x");
    expect(findHeader([], "anything")).toBeNull();
  });
});

describe("DNR rule (FR-1)", () => {
  it("uses operation 'set', never 'append'", () => {
    const rule = buildGpcRule();
    const header = rule.action.requestHeaders?.[0];
    expect(header?.header).toBe("Sec-GPC");
    expect(header?.operation).toBe("set");
    expect(header?.value).toBe("1");
  });

  it("is a single broad rule covering all resource types", () => {
    const rule = buildGpcRule();
    expect(rule.id).toBe(GPC_RULE_ID);
    expect(rule.condition.urlFilter).toBe("*");
    expect(rule.condition.resourceTypes).toContain("main_frame");
    expect(rule.condition.resourceTypes).toContain("xmlhttprequest");
    expect(rule.condition.resourceTypes).toContain("ping");
    expect(rule.condition.resourceTypes).toContain("image");
  });
});

describe("effectiveSource — who is asserting NOW, not who was before", () => {
  it("reports this-extension after we assert on an unowned property", () => {
    const nav = makeNav();
    const r = assertSignal(true, nav, () => {});
    // detection ran BEFORE we asserted, so it correctly says "none"...
    expect(r.detection.source).toBe("none");
    // But the reportable source is us. Conflating these would report `source: "none"`
    // alongside every read through our own accessor.
    expect(r.effectiveSource).toBe("this-extension");
    expect(r.asserted).toBe(true);
  });

  it("reports none when sending is off, and installs no accessor", () => {
    const nav = makeNav();
    const r = assertSignal(false, nav, () => {});
    expect(r.effectiveSource).toBe("none");
    expect(r.asserted).toBe(false);
    expect(nav.globalPrivacyControl).toBeUndefined();
  });

  it("reports native when the browser owns the signal", () => {
    const nav = makeNav();
    defineNative(nav, true);
    const r = assertSignal(true, nav, () => {});
    expect(r.effectiveSource).toBe("native");
    expect(r.asserted).toBe(false);
  });

  it("reports other-extension when a peer owns the signal", () => {
    const nav = makeNav();
    defineOtherExtensionInstance(nav, true);
    const r = assertSignal(true, nav, () => {});
    expect(r.effectiveSource).toBe("other-extension");
  });

  it("reports other-extension even when the peer's property is non-configurable", () => {
    const nav = makeNav();
    defineOtherExtensionInstance(nav, true, false);
    const r = assertSignal(true, nav, () => {});
    expect(r.effectiveSource).toBe("other-extension");
    expect(r.readTracking).toBe("unavailable");
  });

  it("takes the property over from an earlier run on re-injection", () => {
    // The worker's start-up pass injects main-world.js into a page whose scripts came from
    // the version before an update or a reload. That run's accessor answers its own setting
    // and counts into a channel nothing listens on, so the new run replaces it.
    const nav = makeNav();
    let oldReads = 0;
    let newReads = 0;
    defineOurs(nav, false, () => oldReads++);
    const again = assertSignal(true, nav, () => newReads++);
    expect(again.detection.source).toBe("this-extension");
    expect(again.effectiveSource).toBe("this-extension");
    expect(again.readTracking).toBe("active");
    const readsAtDetection = oldReads;
    expect(nav.globalPrivacyControl).toBe(true);
    expect(newReads).toBe(1);
    expect(oldReads).toBe(readsAtDetection);
  });

  it("removes an earlier run's property on re-injection with sending off", () => {
    const nav = makeNav();
    defineOurs(nav, true);
    const again = assertSignal(false, nav, () => {});
    expect(again.effectiveSource).toBe("none");
    expect("globalPrivacyControl" in nav).toBe(false);
  });

  it("leaves an earlier run's locked property, and counts none of its reads", () => {
    const nav = makeNav();
    let oldReads = 0;
    assertSignal(true, nav, () => oldReads++);
    lockSignal(nav);
    let newReads = 0;
    const again = assertSignal(true, nav, () => newReads++);
    expect(again.readTracking).toBe("unavailable");
    expect(nav.globalPrivacyControl).toBe(true);
    expect(newReads).toBe(0);
  });
});

describe("the send toggle actually gates assertion", () => {
  it("does not assert when sending is off", () => {
    // main-world.ts turns `enabled` off when main-world-deny.js joins, or the worker's
    // policy says sending is off. Called with it off, nothing is defined.
    const nav = makeNav();
    const r = assertSignal(false, nav, () => {});
    expect(r.asserted).toBe(false);
    expect(r.effectiveSource).toBe("none");
    // With sending off the page reads what the browser gives it (1.43.0): no property of
    // this extension's making, and never a false it cannot stand behind.
    expect(nav.globalPrivacyControl).toBeUndefined();
    expect("globalPrivacyControl" in nav).toBe(false);
  });

  it("counts no reads when sending is off and nothing else owns the property", () => {
    // There is no property to read (1.43.0), so there is nothing to count; the popup says
    // reads are not counted while sending is off. An owner's property is still wrapped and
    // its reads counted, below.
    const nav = makeNav();
    let reads = 0;
    const r = assertSignal(false, nav, () => reads++);
    void nav.globalPrivacyControl;
    void nav.globalPrivacyControl;
    expect(reads).toBe(0);
    expect(r.readTracking).toBe("unavailable");
  });

  it("still counts reads of an owner's property when sending is off", () => {
    // Turning off SENDING does not turn off observing where there is something to observe.
    const nav = makeNav();
    defineNative(nav, false);
    let reads = 0;
    assertSignal(false, nav, () => reads++);
    void nav.globalPrivacyControl;
    void nav.globalPrivacyControl;
    expect(reads).toBe(2);
  });

  it("never disables a signal owned by the browser or another extension", () => {
    // D10, and the settings copy promises it explicitly.
    const nav = makeNav();
    defineNative(nav, true);
    const r = assertSignal(false, nav, () => {});
    expect(nav.globalPrivacyControl).toBe(true);
    expect(r.effectiveSource).toBe("native");
  });
});

describe("the permission flag is read lazily", () => {
  it("reports the value the flag has at READ time, not at install time", () => {
    // Statically declared content scripts run before dynamically registered ones, so the
    // deny flag is set AFTER the script that consults it. Read once at startup, it would be
    // read before it exists, on every page including fresh loads, and the send setting
    // would appear to do nothing. The accessor consults the flag on each read, so a deny
    // whose property could not be removed reads nothing, never a false (1.44.0).
    const nav = makeNav();
    let denied = false;
    assertSignal(() => !denied, nav, () => {});
    expect(nav.globalPrivacyControl).toBe(true);
    denied = true;
    expect(nav.globalPrivacyControl).toBeUndefined();
  });

  it("reads the flag lazily over an owner's FALSE too", () => {
    // The permission arrives after detection, so the override must not be decided then.
    const nav = makeNav();
    defineNative(nav, false);
    let permitted = false;
    assertSignal(() => permitted, nav, () => {});

    expect(nav.globalPrivacyControl).toBe(false);
    permitted = true;
    expect(nav.globalPrivacyControl).toBe(true);
  });

  it("still accepts a plain boolean", () => {
    const nav = makeNav();
    assertSignal(true, nav, () => {});
    expect(nav.globalPrivacyControl).toBe(true);
  });

  it("defines nothing when the flag is never set", () => {
    // The registered script missed the load, or sending is off: the page reads what the
    // browser gives it, and a later false would have claimed "supported, off" for the
    // reader beside a Sec-GPC header that said the opposite.
    const nav = makeNav();
    assertSignal(() => false, nav, () => {});
    expect(nav.globalPrivacyControl).toBeUndefined();
    expect("globalPrivacyControl" in nav).toBe(false);
  });
});

describe("state reporting must not be one-shot", () => {
  it("reports a corrected state after the permission flag is set", () => {
    // The first report is guaranteed to be wrong: statically declared content scripts run
    // before dynamically registered ones, so the initial announce happens while the
    // permission flag is still unset. A bridge that suppressed every report after the
    // first would leave the popup saying the signal was not set while the property on the
    // page was correct.
    const relayed: string[] = [];
    let permitted = false;
    let last: string | null = null;

    const relay = (source: string): void => {
      if (source === last) return;
      last = source;
      relayed.push(source);
    };

    const announce = (): void => relay(permitted ? "this-extension" : "none");

    announce(); // document_start, before the permission script
    permitted = true;
    announce(); // after it

    expect(relayed).toEqual(["none", "this-extension"]);
  });

  it("does not re-send an unchanged state", () => {
    const relayed: string[] = [];
    let last: string | null = null;
    const relay = (source: string): void => {
      if (source === last) return;
      last = source;
      relayed.push(source);
    };
    relay("this-extension");
    relay("this-extension");
    relay("this-extension");
    expect(relayed).toEqual(["this-extension"]);
  });
});

describe("the lock once sending is on", () => {
  it("keeps true when a later extension tries to define the property", () => {
    const nav = makeNav();
    assertSignal(true, nav, () => {});
    expect(lockSignal(nav)).toBe(true);
    expect(() => defineOtherExtensionInstance(nav, false)).toThrow(TypeError);
    expect(nav.globalPrivacyControl).toBe(true);
    expect(Object.getOwnPropertyDescriptor(nav, "globalPrivacyControl")?.configurable).toBe(false);
  });

  it("keeps counting reads after the lock", () => {
    const nav = makeNav();
    let reads = 0;
    assertSignal(true, nav, () => reads++);
    lockSignal(nav);
    void nav.globalPrivacyControl;
    void nav.globalPrivacyControl;
    expect(reads).toBe(2);
  });

  it("locks the accessor over a native FALSE, which then reads true", () => {
    const nav = makeNav();
    defineNative(nav, false);
    assertSignal(true, nav, () => {});
    expect(lockSignal(nav)).toBe(true);
    expect(() => defineOtherExtensionInstance(nav, false)).toThrow(TypeError);
    expect(nav.globalPrivacyControl).toBe(true);
  });

  it("does not lock a property that is not ours, so the caller takes it back first", () => {
    const nav = makeNav();
    let permitted = false;
    assertSignal(() => permitted, nav, () => {});
    // Another extension's script replaces the accessor before permission arrives.
    defineOtherExtensionInstance(nav, false);
    expect(ownsSignal(nav)).toBe(false);
    expect(lockSignal(nav)).toBe(false);

    // What main-world.ts does when permission arrives.
    permitted = true;
    const again = assertSignal(() => permitted, nav, () => {});
    expect(again.effectiveSource).toBe("this-extension");
    expect(ownsSignal(nav)).toBe(true);
    expect(lockSignal(nav)).toBe(true);
    expect(nav.globalPrivacyControl).toBe(true);
  });

  it("cannot take back a non-configurable property another extension set first", () => {
    const nav = makeNav();
    defineOtherExtensionInstance(nav, false, false);
    assertSignal(true, nav, () => {});
    expect(lockSignal(nav)).toBe(false);
    expect(nav.globalPrivacyControl).toBe(false);
  });
});

describe("an owner that replaced our accessor after it was installed", () => {
  // With the lock off (the default) the accessor is configurable on purpose, and another
  // extension's script that runs later can define the property over it.
  const laterAccessor = (nav: Navigator, get: () => unknown) =>
    Object.defineProperty(nav, "globalPrivacyControl", { get, configurable: true, enumerable: true });

  it("reports nothing while the accessor is still ours", () => {
    const nav = makeNav();
    const result = assertSignal(true, nav, () => {});
    expect(ownerSince(result, nav)).toBeNull();
  });

  it("names the other owner and the value pages now read", () => {
    const nav = makeNav();
    let reads = 0;
    const result = assertSignal(true, nav, () => reads++);
    laterAccessor(nav, () => false);
    expect(ownsSignal(nav)).toBe(false);
    expect(nav.globalPrivacyControl).toBe(false);

    const now = ownerSince(result, nav);
    expect(now).toMatchObject({ source: "other-extension", value: false });
    // Reads go to the other accessor now: none reaches our counter.
    expect(reads).toBe(0);
  });

  it("does not count its own look as a read when the new owner calls through to ours", () => {
    const nav = makeNav();
    let reads = 0;
    const result = assertSignal(true, nav, () => reads++);
    const ours = Object.getOwnPropertyDescriptor(nav, "globalPrivacyControl")!.get!;
    laterAccessor(nav, function (this: Navigator) {
      return ours.call(this) === true ? false : true;
    });
    expect(ownerSince(result, nav)).toMatchObject({ source: "other-extension", value: false });
    expect(reads).toBe(0);
    // A page's read through the new owner still reaches ours, and is counted.
    void nav.globalPrivacyControl;
    expect(reads).toBe(1);
  });

  it("keeps ours where the later definition is on the prototype, which the own property shadows", () => {
    const nav = makeNav();
    const result = assertSignal(true, nav, () => {});
    Object.defineProperty(Object.getPrototypeOf(nav) as object, "globalPrivacyControl", {
      get: () => false,
      configurable: true,
    });
    expect(ownerSince(result, nav)).toBeNull();
    expect(nav.globalPrivacyControl).toBe(true);
  });

  it("says nothing new where our accessor could never be installed", () => {
    const nav = makeNav();
    defineOtherExtensionInstance(nav, false, false);
    const result = assertSignal(true, nav, () => {});
    expect(result.readTracking).toBe("unavailable");
    expect(ownerSince(result, nav)).toBeNull();
  });
});
