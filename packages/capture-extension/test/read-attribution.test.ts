// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import { createReadSampler, DEFAULT_READ_SAMPLE_POLICY, UNCAPPED_READ_SAMPLE_POLICY } from "../src/observe/read-attribution.js";

/**
 * The read sampler.
 *
 * Two properties matter and they pull against each other: the sample has to be BOUNDED,
 * because this runs on a path that executes thousands of times per page, and it has to be
 * REPRESENTATIVE enough that a script which reads the property is actually seen. The tests
 * below pin both, plus the rule that an unattributable read is never guessed at.
 */

const frame = (url: string): string => `    at f (${url}:1:1)`;
const stackOf = (...urls: string[]): string => ["Error", ...urls.map(frame)].join("\n");

describe("read sampling is bounded", () => {
  it("captures every one of the first `eager` reads, then thins out", () => {
    // A script's first check is the one that identifies it, and those cluster early.
    let captures = 0;
    const sampler = createReadSampler(
      () => {
        captures++;
        return stackOf("https://ads.example.com/tag.js");
      },
      { eager: 4, every: 10, cap: 100 },
    );

    for (let i = 0; i < 4; i++) expect(sampler.onRead()).not.toBeNull();
    expect(captures).toBe(4);

    // Reads 5..9 are skipped; read 10 lands on the stride.
    for (let i = 5; i <= 9; i++) expect(sampler.onRead()).toBeNull();
    expect(sampler.onRead()).not.toBeNull();
    expect(captures).toBe(5);
  });

  it("never captures more than the cap, however many reads arrive", () => {
    let captures = 0;
    const sampler = createReadSampler(
      () => {
        captures++;
        return stackOf("https://ads.example.com/tag.js");
      },
      { eager: 5, every: 2, cap: 8 },
    );

    for (let i = 0; i < 5000; i++) sampler.onRead();
    expect(captures).toBe(8);
  });

  it("traces every read on the worst page seen so far, and says the cap was not reached", () => {
    // news-f.example produced roughly 1,900 reads on one page load. A capture costs single
    // microseconds (measured 2026-09-14), so the default policy traces all of them; the cap
    // exists for a script that polls the property in a loop.
    let captures = 0;
    const sampler = createReadSampler(() => {
      captures++;
      return stackOf("https://ads.example.com/tag.js");
    });

    for (let i = 0; i < 1900; i++) sampler.onRead();
    expect(captures).toBe(1900);
    expect(sampler.capReached()).toBe(false);
  });

  it("past the cap it thins to one in sixteen and says so, and the override lifts it", () => {
    let captures = 0;
    const capture = () => {
      captures++;
      return stackOf("https://ads.example.com/tag.js");
    };
    const sampler = createReadSampler(capture);
    for (let i = 0; i < DEFAULT_READ_SAMPLE_POLICY.eager + 160; i++) sampler.onRead();
    expect(sampler.capReached()).toBe(true);
    expect(captures).toBe(DEFAULT_READ_SAMPLE_POLICY.eager + 10);

    // The policy is read per call, because in the page the override is a marker set by a
    // script that runs after the sampler is built.
    captures = 0;
    let all = false;
    const lazy = createReadSampler(capture, () => (all ? UNCAPPED_READ_SAMPLE_POLICY : DEFAULT_READ_SAMPLE_POLICY));
    all = true;
    for (let i = 0; i < DEFAULT_READ_SAMPLE_POLICY.cap + 500; i++) lazy.onRead();
    expect(captures).toBe(DEFAULT_READ_SAMPLE_POLICY.cap + 500);
    expect(lazy.capReached()).toBe(false);
  });
});

describe("attribution of a sampled read", () => {
  it("names the calling script", () => {
    const sampler = createReadSampler(() => stackOf("https://ads.example.com/tag.js"));
    expect(sampler.onRead()).toEqual({
      url: "https://ads.example.com/tag.js",
      viaTagManager: false,
      containerUrl: null,
    });
  });

  it("skips our own frames, so the extension is never the caller", () => {
    // The getter, the reporter and the sampler are all extension frames and sit ABOVE the
    // page script on the stack. Attributing to the topmost frame would name us every time.
    const sampler = createReadSampler(() =>
      stackOf(
        "chrome-extension://abcdef/main-world.js",
        "chrome-extension://abcdef/read-attribution.js",
        "https://ads.example.com/tag.js",
      ),
    );
    expect(sampler.onRead()?.url).toBe("https://ads.example.com/tag.js");
  });

  it("reports a container read as the container's, not as some vendor's", () => {
    // GTM runs vendor tags in its own context, so the stack names the container and the
    // vendor has no frame. This is the fact the engine's container states rest on.
    const sampler = createReadSampler(() =>
      stackOf("https://www.googletagmanager.com/gtm.js?id=GTM-X"),
    );
    expect(sampler.onRead()).toEqual({
      url: "https://www.googletagmanager.com/gtm.js?id=GTM-X",
      viaTagManager: true,
      containerUrl: "https://www.googletagmanager.com/gtm.js?id=GTM-X",
    });
  });

  it("returns a null url rather than guessing when the stack names no script", () => {
    // Inline and eval'd code. A read we cannot attribute stays unattributed — it is never
    // assigned to the page, and never to a vendor we merely suspect.
    const sampler = createReadSampler(() => "Error\n    at <anonymous>:1:1");
    expect(sampler.onRead()).toEqual({ url: null, viaTagManager: false, containerUrl: null });
  });

  it("survives a host with no stacks at all", () => {
    const sampler = createReadSampler(() => undefined);
    expect(sampler.onRead()).toEqual({ url: null, viaTagManager: false, containerUrl: null });
  });
});

describe("instrumentation never breaks the read", () => {
  it("swallows a throwing stack capture and reports no attribution", () => {
    const sampler = createReadSampler(() => {
      throw new Error("stack capture exploded");
    });
    expect(() => sampler.onRead()).not.toThrow();
    expect(sampler.onRead()).toBeNull();
  });

  it("stops paying for a stack capture that always throws", () => {
    // The cap counts ATTEMPTS, not successes. Without that, a host where capture always
    // throws would retry on every sampled read for the life of the page — the exact hot
    // path cost sampling exists to avoid.
    let attempts = 0;
    const sampler = createReadSampler(
      () => {
        attempts++;
        throw new Error("nope");
      },
      { eager: 3, every: 2, cap: 3 },
    );

    for (let i = 0; i < 500; i++) sampler.onRead();
    expect(attempts).toBe(3);
  });
});

describe("a sampled read carries its container", () => {
  it("names the innermost container frame, query kept, and null when there is none", () => {
    const sampler = createReadSampler(
      () =>
        [
          "Error",
          frame("https://www.googletagmanager.com/gtag/js?id=G-1"),
          frame("https://www.googletagmanager.com/gtm.js?id=GTM-A&l=dl2"),
        ].join("\n"),
      { eager: 2, every: 1, cap: 10 },
    );
    const read = sampler.onRead();
    expect(read).toEqual({
      url: "https://www.googletagmanager.com/gtag/js?id=G-1",
      viaTagManager: true,
      containerUrl: "https://www.googletagmanager.com/gtag/js?id=G-1",
    });

    const direct = createReadSampler(() => stackOf("https://ads.example.com/tag.js"), {
      eager: 1,
      every: 1,
      cap: 1,
    }).onRead();
    expect(direct?.containerUrl).toBeNull();
  });
});
