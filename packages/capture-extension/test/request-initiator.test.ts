// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect } from "vitest";
import { installRequestInitiatorObserver, type ObservedRequest } from "../src/observe/request-initiator.js";
import type { ScriptInsertionCoverage } from "@gpc-inspector/schema";

/**
 * The request-initiator observer (provenance): pixels, fetch, XHR and beacons, which never
 * touch the DOM. Same guarantees as the insertion observer, proven the same way against
 * fakes.
 */

const PAGE = "https://www.example.com/article";
const GTM_A = "https://www.googletagmanager.com/gtm.js?id=GTM-A";
const frame = (url: string): string => `    at f (${url}:12:3)`;
const stackOf = (...urls: string[]): string => ["Error", ...urls.map(frame)].join("\n");

function harness(stack: () => string | undefined = () => stackOf(GTM_A)) {
  const calls: string[] = [];
  let imageSrc = "";
  class HTMLImageElement {}
  Object.defineProperty(HTMLImageElement.prototype, "src", {
    configurable: true,
    enumerable: true,
    get() {
      return imageSrc;
    },
    set(v: string) {
      calls.push("src");
      imageSrc = v;
    },
  });
  class XMLHttpRequest {
    open(_m: string, _u: string): string {
      calls.push("open");
      return "opened";
    }
  }
  class Navigator {
    sendBeacon(_u: string): boolean {
      calls.push("sendBeacon");
      return true;
    }
  }
  const win = {
    HTMLImageElement,
    XMLHttpRequest,
    Navigator,
    Error,
    location: { href: PAGE },
    fetch: (..._a: unknown[]) => {
      calls.push("fetch");
      return "fetched";
    },
  } as unknown as Window & typeof globalThis;
  const doc = { baseURI: PAGE } as Document;
  const requests: ObservedRequest[] = [];
  const coverages: ScriptInsertionCoverage[] = [];
  const observer = installRequestInitiatorObserver(
    win,
    doc,
    { initialUrl: PAGE, frameOrigin: "https://www.example.com", topFrame: true, captureStack: stack, now: () => 7 },
    { onRequest: (r) => requests.push(r), onCoverage: (c) => coverages.push(c) },
  );
  return { observer, requests, coverages, calls, win, HTMLImageElement, XMLHttpRequest, Navigator };
}

describe("installRequestInitiatorObserver", () => {
  it("records a pixel, a fetch, an XHR and a beacon with the container that made them, and delegates", () => {
    const h = harness();
    expect(h.observer).not.toBeNull();
    const img = new h.HTMLImageElement() as unknown as { src: string };
    img.src = "https://px.example/p.gif?cb=1";
    expect(img.src).toBe("https://px.example/p.gif?cb=1");
    expect((h.win as unknown as { fetch: (u: string) => unknown }).fetch("https://api.example/v1/sync")).toBe("fetched");
    expect(new h.XMLHttpRequest().open("GET", "/relative/x.json")).toBe("opened");
    expect(new h.Navigator().sendBeacon("https://b.example/beacon")).toBe(true);
    expect(h.calls).toEqual(["src", "fetch", "open", "sendBeacon"]);
    expect(h.requests.map((r) => [r.element, r.key, r.loader.via])).toEqual([
      ["image", "https://px.example/p.gif", "src"],
      ["fetch", "https://api.example/v1/sync", "fetch"],
      ["xhr", "https://www.example.com/relative/x.json", "open"],
      ["beacon", "https://b.example/beacon", "sendBeacon"],
    ]);
    for (const r of h.requests) expect(r.loader.containerUrls).toEqual([GTM_A]);
  });

  it("takes a Request or URL object's url for fetch, and ignores data: and empty", () => {
    const h = harness();
    const f = (h.win as unknown as { fetch: (u: unknown) => unknown }).fetch;
    f({ url: "https://api.example/req" });
    f({ href: "https://api.example/urlobj" });
    f("data:text/plain,hi");
    const img = new h.HTMLImageElement() as unknown as { src: string };
    img.src = "";
    expect(h.requests.map((r) => r.key)).toEqual(["https://api.example/req", "https://api.example/urlobj"]);
  });

  it("dedupes a repeated request from the same initiator and caps distinct initiators per key", () => {
    let n = 0;
    const h = harness(() => stackOf(`https://loader${n}.example/x.js`));
    const img = () => new h.HTMLImageElement() as unknown as { src: string };
    img().src = "https://px.example/p.gif?a";
    img().src = "https://px.example/p.gif?b";
    expect(h.requests).toHaveLength(1);
    expect(h.observer!.coverage.duplicates).toBe(1);
    for (n = 1; n <= 4; n++) img().src = "https://px.example/p.gif";
    expect(h.requests).toHaveLength(3);
  });

  it("rethrows the original's exception and never throws from the recorder; self-disables after repeats", () => {
    const h = harness(() => {
      throw new Error("no stack");
    });
    const img = new h.HTMLImageElement() as unknown as { src: string };
    img.src = "https://px.example/p.gif";
    expect(h.observer!.coverage.stackFailed).toBe(1);
    expect(h.requests).toHaveLength(1); // recorded, with an empty stack
    h.XMLHttpRequest.prototype.open = () => {
      throw new TypeError("bad");
    };
    expect(() => new h.XMLHttpRequest().open("GET", "https://x")).toThrow(TypeError);
    // A hostile fetch input makes the recorder throw; three of them stop recording.
    const hostile = {
      get url(): string {
        throw new Error("hostile");
      },
    };
    const f = (h.win as unknown as { fetch: (u: unknown) => unknown }).fetch;
    for (let i = 0; i < 3; i++) f(hostile);
    expect(h.observer!.coverage.selfDisabled).toBe(true);
    f("https://api.example/after");
    expect(h.requests.map((r) => r.key)).not.toContain("https://api.example/after");
    expect(h.calls.filter((c) => c === "fetch")).toHaveLength(4);
  });

  it("reports coverage on rescan, and returns null when nothing can be wrapped", () => {
    const h = harness();
    h.observer!.rescan();
    expect(h.coverages).toHaveLength(1);
    const none = installRequestInitiatorObserver(
      { Error } as unknown as Window & typeof globalThis,
      {} as Document,
      { initialUrl: PAGE, frameOrigin: "", topFrame: true },
      { onRequest: () => {}, onCoverage: () => {} },
    );
    expect(none).toBeNull();
  });
});
