// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import { CHECK_DELAY_MS, JarChecks, jarStateOf, type JarAnswer, type JarCookie, type JarReader } from "../src/background/jar-check.js";

describe("jarStateOf", () => {
  const values = new Set(["v1", "v2"]);

  it("is landed when a cookie of the key's domain holds a value the page wrote", () => {
    expect(jarStateOf([{ domain: ".doubleclick.net", value: "v2" }], ".doubleclick.net", values)).toBe("landed");
    // A host-only cookie is listed without the dot the record gives it.
    expect(jarStateOf([{ domain: "www.example.com", value: "v1" }], ".www.example.com", values)).toBe("landed");
  });

  it("is not-stored when no cookie of that domain is there, a subdomain's included", () => {
    expect(jarStateOf([], ".doubleclick.net", values)).toBe("not-stored");
    expect(jarStateOf([{ domain: "cm.g.doubleclick.net", value: "v1" }], ".doubleclick.net", values)).toBe("not-stored");
  });

  it("is unknown when one is there with another value", () => {
    expect(jarStateOf([{ domain: ".doubleclick.net", value: "older" }], ".doubleclick.net", values)).toBe("unknown");
  });
});

/** A reader over a fixed jar, recording each lookup. */
function reader(jar: (JarCookie & { name: string; topLevelSite?: string })[], opts: { store?: string | null; fail?: boolean } = {}) {
  const lookups: { name: string; domain: string; storeId: string; topLevelSite?: string }[] = [];
  const r: JarReader = {
    async storeOf() {
      return opts.store === undefined ? "0" : opts.store;
    },
    async lookup(q) {
      lookups.push(q);
      if (opts.fail) throw new Error("no access");
      return jar.filter((c) => c.name === q.name && c.topLevelSite === q.topLevelSite);
    },
  };
  return { r, lookups };
}

function checks(r: JarReader) {
  let now = 1_000;
  const answers: { tabId: number; answers: readonly JarAnswer[] }[] = [];
  const unchecked: { tabId: number; keys: readonly string[] }[] = [];
  const q = new JarChecks(
    r,
    (tabId, a, u) => {
      if (a.length > 0) answers.push({ tabId, answers: a });
      if (u.length > 0) unchecked.push({ tabId, keys: u });
    },
    () => now,
  );
  return { q, answers, unchecked, advance: (ms: number) => (now += ms) };
}

const cookie = (value: string, partitioned = false) => ({ name: "IDE", domain: ".doubleclick.net", value, partitioned });
const page = { topSite: "www.example.com", scheme: "https" };

describe("JarChecks", () => {
  it("checks a key once for all its writes, CHECK_DELAY_MS after the last", async () => {
    const { r, lookups } = reader([{ name: "IDE", domain: ".doubleclick.net", value: "b" }]);
    const { q, answers, advance } = checks(r);
    q.add(7, page, "IDE\u0000.doubleclick.net", "o1", cookie("a"));
    advance(CHECK_DELAY_MS - 10);
    q.add(7, page, "IDE\u0000.doubleclick.net", "o2", cookie("b"));
    advance(20);
    await q.run();
    expect(answers).toEqual([]);
    advance(CHECK_DELAY_MS);
    await q.run();
    expect(lookups).toEqual([{ name: "IDE", domain: "doubleclick.net", storeId: "0" }]);
    expect(answers).toEqual([{ tabId: 7, answers: [{ key: "IDE\u0000.doubleclick.net", name: "IDE", removal: false, state: "landed", marks: [{ state: "landed", observationIds: ["o1", "o2"] }], seq: 2 }] }]);
    expect(q.size).toBe(0);
  });

  it("checks a removal apart from the key's set, and finds any cookie of the key, whatever its value", async () => {
    const { r } = reader([{ name: "IDE", domain: ".doubleclick.net", value: "b" }]);
    const { q, answers, advance } = checks(r);
    q.add(7, page, "IDE\u0000.doubleclick.net", "o1", cookie("a"));
    q.add(7, page, "IDE\u0000.doubleclick.net", "o2", cookie(""), true);
    expect(q.size).toBe(2);
    advance(CHECK_DELAY_MS);
    await q.run();
    const got = answers.flatMap((a) => a.answers).map((a) => [a.removal, a.state]);
    expect(got).toEqual([[false, "unknown"], [true, "unknown"]]);
  });

  it("answers a removal not-stored when the jar holds no cookie of the key, and never reports it unchecked", async () => {
    const { r } = reader([]);
    const { q, answers, advance } = checks(r);
    q.add(7, page, "IDE\u0000.doubleclick.net", "o2", cookie(""), true);
    advance(CHECK_DELAY_MS);
    await q.run();
    expect(answers.flatMap((a) => a.answers).map((a) => [a.removal, a.state])).toEqual([[true, "not-stored"]]);

    const second = checks(reader([], { store: null }).r);
    second.q.add(7, page, "IDE\u0000.doubleclick.net", "o3", cookie(""), true);
    second.advance(CHECK_DELAY_MS);
    await second.q.run();
    expect(second.answers).toEqual([]);
    expect(second.unchecked).toEqual([]);
  });

  it("looks a partitioned cookie up in the page's site's partition", async () => {
    const { r, lookups } = reader([{ name: "IDE", domain: ".doubleclick.net", value: "a", topLevelSite: "https://example.co.uk" }]);
    const { q, answers, advance } = checks(r);
    q.add(7, { topSite: "www.example.co.uk", scheme: "https" }, "IDE\u0000.doubleclick.net", "o1", cookie("a", true));
    advance(CHECK_DELAY_MS);
    await q.run();
    expect(lookups[0]?.topLevelSite).toBe("https://example.co.uk");
    expect(answers[0]?.answers[0]?.state).toBe("landed");
  });

  it("keeps an http page's scheme in the partition key", async () => {
    const { r, lookups } = reader([{ name: "IDE", domain: ".doubleclick.net", value: "a", topLevelSite: "http://example.com" }]);
    const { q, answers, advance } = checks(r);
    q.add(7, { topSite: "www.example.com", scheme: "http" }, "IDE\u0000.doubleclick.net", "o1", cookie("a", true));
    advance(CHECK_DELAY_MS);
    await q.run();
    expect(lookups[0]?.topLevelSite).toBe("http://example.com");
    expect(answers[0]?.answers[0]?.state).toBe("landed");
  });

  it("looks a host-only key up under every host that wrote it, and counts one stored write", async () => {
    // The key has no domain, so a refused write in a third-party frame and a stored one in
    // the top frame share it.
    const { r, lookups } = reader([{ name: "uid", domain: "www.example.com", value: "top" }]);
    const { q, answers, advance } = checks(r);
    const hostOnly = (domain: string, value: string) => ({ name: "uid", domain, value, partitioned: false });
    q.add(7, page, "uid\u0000", "o1", hostOnly("widget.example-chat.com", "frame"));
    q.add(7, page, "uid\u0000", "o2", hostOnly("www.example.com", "top"));
    advance(CHECK_DELAY_MS);
    await q.run();
    expect(lookups.map((l) => l.domain).sort()).toEqual(["widget.example-chat.com", "www.example.com"]);
    expect(answers[0]?.answers[0]?.state).toBe("landed");
    // Each record takes its own host's answer: the frame's write was not stored.
    expect(answers[0]?.answers[0]?.marks).toEqual([
      { state: "not-stored", observationIds: ["o1"] },
      { state: "landed", observationIds: ["o2"] },
    ]);
  });

  it("looks each host up in a partition only when its own write was partitioned", async () => {
    const { r, lookups } = reader([
      { name: "sid", domain: "widget.example-chat.com", value: "frame", topLevelSite: "https://example.com" },
      { name: "sid", domain: "www.example.com", value: "top" },
    ]);
    const { q, answers, advance } = checks(r);
    q.add(7, page, "sid\u0000", "o1", { name: "sid", domain: "widget.example-chat.com", value: "frame", partitioned: true });
    q.add(7, page, "sid\u0000", "o2", { name: "sid", domain: "www.example.com", value: "top", partitioned: false });
    advance(CHECK_DELAY_MS);
    await q.run();
    expect(Object.fromEntries(lookups.map((l) => [l.domain, l.topLevelSite ?? null]))).toEqual({
      "widget.example-chat.com": "https://example.com",
      "www.example.com": null,
    });
    expect(answers[0]?.answers[0]?.marks.map((m) => m.state)).toEqual(["landed", "landed"]);
  });

  it("says an answer is stale once a write of its key was queued after its check ran", async () => {
    const { r } = reader([]);
    const { q, answers, advance } = checks(r);
    q.add(7, page, "IDE\u0000.doubleclick.net", "o1", cookie("a"));
    advance(CHECK_DELAY_MS);
    await q.run();
    const answer = answers[0]!.answers[0]!;
    expect(answer.state).toBe("not-stored");
    expect(q.isLatest(7, answer)).toBe(true);
    q.add(7, page, "IDE\u0000.doubleclick.net", "o2", cookie("b"));
    expect(q.isLatest(7, answer)).toBe(false);
    q.forgetTab(7);
    expect(q.isLatest(7, answer)).toBe(true);
  });

  it("says a key could not be checked for a tab no store holds, or a lookup that fails", async () => {
    // Not an answer: the jar was not asked. The worker has to hear of it all the same, or
    // a key waiting on this check would wait for ever.
    for (const opts of [{ store: null }, { fail: true }]) {
      const { r } = reader([], opts);
      const { q, answers, unchecked, advance } = checks(r);
      q.add(7, page, "IDE\u0000.doubleclick.net", "o1", cookie("a"));
      advance(CHECK_DELAY_MS);
      await q.run();
      expect(answers).toEqual([]);
      expect(unchecked).toEqual([{ tabId: 7, keys: ["IDE\u0000.doubleclick.net"] }]);
    }
  });

  it("leaves a key written again during a failed check to the check that write queued", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const r: JarReader = {
      async storeOf() {
        await gate;
        return null;
      },
      async lookup() {
        return [];
      },
    };
    const { q, unchecked, advance } = checks(r);
    q.add(7, page, "IDE\u0000.doubleclick.net", "o1", cookie("a"));
    advance(CHECK_DELAY_MS);
    const running = q.run();
    q.add(7, page, "IDE\u0000.doubleclick.net", "o2", cookie("b"));
    release();
    await running;
    expect(unchecked).toEqual([]);
    expect(q.size).toBe(1);
  });

  it("drops a check that was reading the jar when its tab moved to another page", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const r: JarReader = {
      async storeOf() {
        await gate;
        return "0";
      },
      async lookup() {
        return [];
      },
    };
    const { q, answers, unchecked, advance } = checks(r);
    q.add(7, page, "IDE\u0000.doubleclick.net", "o1", cookie("a"));
    advance(CHECK_DELAY_MS);
    const running = q.run();
    q.forgetTab(7);
    release();
    await running;
    expect(answers).toEqual([]);
    expect(unchecked).toEqual([]);
  });

  it("drops a tab's waiting checks", async () => {
    const { r, lookups } = reader([]);
    const { q, advance } = checks(r);
    q.add(7, page, "IDE\u0000.doubleclick.net", "o1", cookie("a"));
    q.add(8, page, "IDE\u0000.doubleclick.net", "o1", cookie("a"));
    q.forgetTab(7);
    advance(CHECK_DELAY_MS);
    await q.run();
    expect(lookups).toHaveLength(1);
  });
});
