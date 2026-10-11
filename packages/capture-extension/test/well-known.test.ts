// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  interpretResponse,
  isCacheable,
  fetchWellKnown,
  MAX_BODY_BYTES,
  isFresh,
  asCached,
  originOf,
  wellKnownUrl,
  MAX_AGE_MS,
  CURRENT_READ_MS,
  FAILED_MAX_AGE_MS,
  MAX_REDIRECTS,
  REDIRECT_OFF_SITE,
  REDIRECT_UNSEEN,
  sameSiteRedirect,
  gotNoAnswer,
  retryReading,
  RetryAfterLoad,
  type WatchRedirect,
} from "../src/observe/well-known.js";

const JSON_CT = "application/json";

describe("wellKnownUrl", () => {
  it("appends the well-known path to an origin", () => {
    expect(wellKnownUrl("https://example.com")).toBe("https://example.com/.well-known/gpc.json");
  });

  it("does not double a trailing slash", () => {
    expect(wellKnownUrl("https://example.com/")).toBe("https://example.com/.well-known/gpc.json");
  });
});

describe("originOf", () => {
  it("strips the path", () => {
    expect(originOf("https://www.example.com/news/story?x=1")).toBe("https://www.example.com");
  });

  it("treats a subdomain as its own origin", () => {
    // The spec expects each subdomain handling personal data to publish its own file, so
    // origin — not registrable domain — is the right cache key.
    expect(originOf("https://shop.example.com/")).toBe("https://shop.example.com");
  });

  it("refuses non-http schemes", () => {
    expect(originOf("chrome://settings")).toBeNull();
    expect(originOf("file:///tmp/x.html")).toBeNull();
    expect(originOf("not a url")).toBeNull();
  });

  it("refuses hosts Chrome keeps extensions out of", () => {
    // A Web Store probe fails with a CORS error that Chrome logs against the extension.
    expect(originOf("https://chromewebstore.google.com/detail/x/abcdef")).toBeNull();
    expect(originOf("https://chrome.google.com/webstore/detail/x/abcdef")).toBeNull();
    expect(originOf("https://www.google.com/")).toBe("https://www.google.com");
  });
});

describe("interpretResponse", () => {
  const url = "https://example.com/.well-known/gpc.json";

  it("reads a valid declaration of support", () => {
    const r = interpretResponse(url, 200, JSON_CT, '{"gpc":true,"lastUpdate":"2026-01-15"}');
    expect(r.present).toBe(true);
    expect(r.gpc).toBe(true);
    expect(r.lastUpdate).toBe("2026-01-15");
    expect(r.fresh).toBe(true);
  });

  it("reads an explicit declaration of NON-support", () => {
    // gpc: false is a real statement, not an omission. A site saying it does not honor the
    // signal is being honest, and that is worth reporting differently from silence.
    const r = interpretResponse(url, 200, JSON_CT, '{"gpc":false}');
    expect(r.present).toBe(true);
    expect(r.gpc).toBe(false);
  });

  it("treats a 404 as no file, with the reason recorded", () => {
    const r = interpretResponse(url, 404, "text/html", "Not Found");
    expect(r.present).toBe(false);
    expect(r.reason).toContain("404");
  });

  it("treats 403, 406, 429 and 500 as no file rather than as errors worth surfacing", () => {
    for (const status of [403, 406, 429, 500]) {
      const r = interpretResponse(url, status, null, "");
      expect(r.present).toBe(false);
      expect(r.gpc).toBeNull();
    }
  });

  it("treats a soft 404 — HTML with status 200 — as no file", () => {
    // The awkward real case: a server returns its generic error page with a 200. Calling
    // that "unparseable" would manufacture a diagnostic out of a misconfiguration when the
    // honest reading is that nothing is published there.
    const r = interpretResponse(url, 200, "text/html; charset=utf-8", "<!DOCTYPE html><html>…");
    expect(r.present).toBe(false);
    expect(r.reason).toBe("html response");
  });

  it("treats a non-JSON body as no file", () => {
    expect(interpretResponse(url, 200, JSON_CT, "nonsense").present).toBe(false);
  });

  it("treats a JSON array or scalar as no file", () => {
    expect(interpretResponse(url, 200, JSON_CT, "[]").present).toBe(false);
    expect(interpretResponse(url, 200, JSON_CT, '"yes"').present).toBe(false);
    expect(interpretResponse(url, 200, JSON_CT, "null").present).toBe(false);
  });

  it("requires gpc to be a boolean, not a truthy string", () => {
    // A file without a boolean gpc field is not a GPC resource, whatever else it contains.
    expect(interpretResponse(url, 200, JSON_CT, '{"gpc":"true"}').present).toBe(false);
    expect(interpretResponse(url, 200, JSON_CT, '{"gpc":1}').present).toBe(false);
    expect(interpretResponse(url, 200, JSON_CT, '{"other":true}').present).toBe(false);
  });

  it("accepts a missing content-type when the body parses", () => {
    // Servers that omit the header are common; the body is the better evidence.
    expect(interpretResponse(url, 200, null, '{"gpc":true}').present).toBe(true);
  });

  it("tolerates a missing lastUpdate", () => {
    const r = interpretResponse(url, 200, JSON_CT, '{"gpc":true}');
    expect(r.present).toBe(true);
    expect(r.lastUpdate).toBeNull();
  });
});

describe("cache freshness", () => {
  const entry = interpretResponse("https://x/.well-known/gpc.json", 200, JSON_CT, '{"gpc":true}', 1000);

  it("is fresh within the max age", () => {
    expect(isFresh(entry, 1000 + MAX_AGE_MS - 1)).toBe(true);
  });

  it("is stale at the max age", () => {
    expect(isFresh(entry, 1000 + MAX_AGE_MS)).toBe(false);
  });

  it("keeps a failed read for minutes, not a day", () => {
    // Never cached, a failed read would request the file of a site answering 503 on every
    // navigation. Kept a day, one blip would hide a published file.
    for (const reason of ["request failed: TypeError", "status 503", "status 429", REDIRECT_UNSEEN]) {
      const failed = { ...entry, present: false, gpc: null, reason };
      expect(isFresh(failed, 1000 + FAILED_MAX_AGE_MS - 1)).toBe(true);
      expect(isFresh(failed, 1000 + FAILED_MAX_AGE_MS)).toBe(false);
    }
  });

  it("marks an old cached entry as not fresh while preserving what it said", () => {
    // fresh gates the accusation, not the report: a site can retract the file at any time,
    // so an old declaration is still worth showing and not worth accusing on.
    const cached = asCached(entry, 1000 + CURRENT_READ_MS);
    expect(cached.fresh).toBe(false);
    expect(cached.gpc).toBe(true);
    expect(cached.observedAtMs).toBe(entry.observedAtMs);
  });

  it("keeps a recent cached entry fresh", () => {
    // retailer-a.example, 2026-09-25: the page navigated twice while loading, the second commit
    // found the entry the first had cached seconds earlier, and the declared-honor finding
    // became unreachable on a first visit. Seconds or minutes old is a current reading.
    expect(asCached(entry, 1000 + 3000).fresh).toBe(true);
    expect(asCached(entry, 1000 + CURRENT_READ_MS - 1).fresh).toBe(true);
  });

  it("measures the window from the reading, not from when it was cached", () => {
    // A cached entry that was itself stale stays stale when served again.
    const old = asCached({ ...entry, fresh: false }, 1000 + 60_000);
    expect(old.fresh).toBe(true);
    expect(asCached(old, 1000 + CURRENT_READ_MS + 60_000).fresh).toBe(false);
  });
});

describe("isCacheable", () => {
  const at = (reason: string) => ({ ...interpretResponse("u", 404, JSON_CT, "", 0), reason });

  it("caches a reading that says something about the file", () => {
    expect(isCacheable(interpretResponse("u", 200, JSON_CT, JSON.stringify({ gpc: true }), 0))).toBe(true);
    expect(isCacheable(at("status 404"))).toBe(true);
    expect(isCacheable(at("html response"))).toBe(true);
  });

  it("caches a redirect off the site for a day: it is what the site serves", () => {
    expect(isCacheable(at(REDIRECT_OFF_SITE))).toBe(true);
    expect(isCacheable(at(REDIRECT_UNSEEN))).toBe(false);
  });

  it("does not cache a failed request, a server error or a rate limit", () => {
    expect(isCacheable(at("request failed: TypeError: Failed to fetch"))).toBe(false);
    expect(isCacheable(at("status 503"))).toBe(false);
    expect(isCacheable(at("status 429"))).toBe(false);
    expect(isCacheable(at("status 408"))).toBe(false);
  });
});

describe("fetchWellKnown", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads no more of a large body than the cap", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(16 * 1024).fill(0x61);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": JSON_CT } })));

    const got = await fetchWellKnown("https://example.com");

    expect(got.present).toBe(false);
    expect(got.reason).toBe("not json");
    expect(pulled).toBeLessThan(MAX_BODY_BYTES * 2);
  });

  it("gives up on a server that never answers, and the reading is not cached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      ),
    );

    const got = await fetchWellKnown("https://example.com", 20);

    expect(got.present).toBe(false);
    expect(got.reason).toMatch(/^request failed/);
    expect(isCacheable(got)).toBe(false);
  });
});

describe("sameSiteRedirect", () => {
  it("allows http to https and moves within the registrable domain", () => {
    expect(sameSiteRedirect("http://example.com/.well-known/gpc.json", "https://example.com/.well-known/gpc.json")).toBe(true);
    expect(sameSiteRedirect("https://example.com/.well-known/gpc.json", "https://www.example.com/.well-known/gpc.json")).toBe(true);
    expect(sameSiteRedirect("https://www.example.co.uk/a", "https://shop.example.co.uk/b")).toBe(true);
  });

  it("refuses another site, a public-suffix neighbor and a non-web scheme", () => {
    expect(sameSiteRedirect("https://example.com/a", "https://cdn.example.net/a")).toBe(false);
    expect(sameSiteRedirect("https://a.github.io/a", "https://b.github.io/a")).toBe(false);
    expect(sameSiteRedirect("https://example.com/a", "ftp://example.com/a")).toBe(false);
    expect(sameSiteRedirect("https://example.com/a", "not a url")).toBe(false);
  });
});

describe("fetchWellKnown redirects", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A redirect as a manual fetch sees it: opaque, no status, no Location. */
  const opaque = () => ({ type: "opaqueredirect", status: 0, headers: new Headers() }) as unknown as Response;
  const json = (body: object) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": JSON_CT } });

  /** Fetch answers by URL; the watcher reports each redirect's target from the same table. */
  function serve(routes: Record<string, string | Response>): { fetched: string[]; watch: WatchRedirect } {
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(init?.redirect).toBe("manual");
        fetched.push(url);
        const r = routes[url];
        if (r === undefined) return new Response("", { status: 404 });
        return typeof r === "string" ? opaque() : r;
      }),
    );
    const watch: WatchRedirect = (url) => ({
      target: async () => {
        const r = routes[url];
        return typeof r === "string" ? r : null;
      },
      stop: () => undefined,
    });
    return { fetched, watch };
  }

  it("follows a redirect within the site and reads the file where it landed", async () => {
    const { fetched, watch } = serve({
      "http://example.com/.well-known/gpc.json": "https://example.com/.well-known/gpc.json",
      "https://example.com/.well-known/gpc.json": "https://www.example.com/.well-known/gpc.json",
      "https://www.example.com/.well-known/gpc.json": json({ gpc: true }),
    });

    const got = await fetchWellKnown("http://example.com", 1000, watch);

    expect(got.present).toBe(true);
    expect(got.gpc).toBe(true);
    expect(got.url).toBe("https://www.example.com/.well-known/gpc.json");
    expect(fetched).toHaveLength(3);
  });

  it("reports the address that was asked when a redirect lands on a page that is not the file", async () => {
    // A subdomain that sends every unknown path to a section's front page: the page's
    // address under "not found" would name nothing the check was looking for.
    const { fetched, watch } = serve({
      "https://sub.example.com/.well-known/gpc.json": "https://www.example.com/section/",
      "https://www.example.com/section/": new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
    });

    const got = await fetchWellKnown("https://sub.example.com", 1000, watch);

    expect(got.present).toBe(false);
    expect(got.reason).toBe("html response");
    expect(got.url).toBe("https://sub.example.com/.well-known/gpc.json");
    expect(fetched).toEqual(["https://sub.example.com/.well-known/gpc.json", "https://www.example.com/section/"]);
  });

  it("reports the address that was asked when the redirect's target answers with an error", async () => {
    const { watch } = serve({ "https://example.com/.well-known/gpc.json": "https://www.example.com/.well-known/gpc.json" });

    const got = await fetchWellKnown("https://example.com", 1000, watch);

    expect(got.reason).toBe("status 404");
    expect(got.url).toBe("https://example.com/.well-known/gpc.json");
  });

  it("never requests another site, and reads as not found", async () => {
    // Both the settings and the first-run screen say the request goes to the site being
    // visited. A followed redirect would send it to whatever host the site named.
    const { fetched, watch } = serve({
      "https://example.com/.well-known/gpc.json": "https://tracker.example.net/.well-known/gpc.json",
      "https://tracker.example.net/.well-known/gpc.json": json({ gpc: true }),
    });

    const got = await fetchWellKnown("https://example.com", 1000, watch);

    expect(got.present).toBe(false);
    expect(got.reason).toBe(REDIRECT_OFF_SITE);
    expect(got.url).toBe("https://example.com/.well-known/gpc.json");
    expect(fetched).toEqual(["https://example.com/.well-known/gpc.json"]);
  });

  it("follows nothing when the target was never reported", async () => {
    const { fetched } = serve({ "https://example.com/.well-known/gpc.json": "https://www.example.com/.well-known/gpc.json" });

    const got = await fetchWellKnown("https://example.com", 1000);

    expect(got.reason).toBe(REDIRECT_UNSEEN);
    expect(fetched).toHaveLength(1);
  });

  it("gives up on a redirect loop within the site", async () => {
    const { fetched, watch } = serve({
      "https://example.com/.well-known/gpc.json": "https://www.example.com/.well-known/gpc.json",
      "https://www.example.com/.well-known/gpc.json": "https://example.com/.well-known/gpc.json",
    });

    const got = await fetchWellKnown("https://example.com", 1000, watch);

    expect(got.present).toBe(false);
    expect(got.reason).toBe("too many redirects");
    expect(got.url).toBe("https://example.com/.well-known/gpc.json");
    expect(fetched).toHaveLength(MAX_REDIRECTS + 1);
  });
});

describe("gotNoAnswer", () => {
  const at = (reason: string) => ({ ...interpretResponse("u", 404, JSON_CT, "", 0), reason });

  it("is true only when the server never answered", () => {
    expect(gotNoAnswer(at("request failed: TimeoutError: signal timed out"))).toBe(true);
    expect(gotNoAnswer(at("request failed: TypeError: Failed to fetch"))).toBe(true);
    expect(gotNoAnswer(at(REDIRECT_UNSEEN))).toBe(true);
  });

  it("is false for any answer, an error status included", () => {
    for (const reason of ["status 404", "status 403", "status 400", "status 503", "html response", REDIRECT_OFF_SITE]) {
      expect(gotNoAnswer(at(reason)), reason).toBe(false);
    }
    expect(gotNoAnswer(interpretResponse("u", 200, JSON_CT, '{"gpc":true}', 0))).toBe(false);
  });
});

describe("RetryAfterLoad", () => {
  const A = "https://a.example";

  it("owes a retry for a read that failed during the load, paid when the load completes", () => {
    const r = new RetryAfterLoad();
    expect(r.noAnswer(1, A)).toBe(false);
    expect(r.loaded(1, A)).toBe(true);
    // Once: a second completion, or the retry's own failure, earns nothing further.
    expect(r.loaded(1, A)).toBe(false);
    expect(r.noAnswer(1, A)).toBe(false);
  });

  it("retries at once when the read fails after the load completed", () => {
    const r = new RetryAfterLoad();
    expect(r.loaded(1, A)).toBe(false);
    expect(r.noAnswer(1, A)).toBe(true);
    expect(r.noAnswer(1, A)).toBe(false);
  });

  it("owes nothing to a page whose read did not fail", () => {
    const r = new RetryAfterLoad();
    expect(r.loaded(1, A)).toBe(false);
  });

  it("forgets what the last page was owed when the tab navigates", () => {
    const r = new RetryAfterLoad();
    r.noAnswer(1, A);
    r.navigated(1);
    expect(r.loaded(1, A)).toBe(false);
  });

  it("does not pay one site's retry on another site's load", () => {
    const r = new RetryAfterLoad();
    r.noAnswer(1, A);
    expect(r.loaded(1, "https://b.example")).toBe(false);
    expect(r.loaded(2, A)).toBe(false);
  });
});

describe("retryReading", () => {
  const ORIGIN = "https://shop.example";
  const failed = { ...interpretResponse(`${ORIGIN}/.well-known/gpc.json`, 404, JSON_CT, "", 1000), reason: "request failed: TimeoutError: signal timed out" };
  const published = interpretResponse(`${ORIGIN}/.well-known/gpc.json`, 200, JSON_CT, '{"gpc":true}', 5000);

  const cacheWith = (entry: ReturnType<typeof interpretResponse> | null) => {
    const store = new Map<string, ReturnType<typeof interpretResponse>>();
    if (entry !== null) store.set(ORIGIN, entry);
    return {
      store,
      getCached: async (o: string) => store.get(o) ?? null,
      putCached: async (o: string, e: ReturnType<typeof interpretResponse>) => void store.set(o, e),
    };
  };

  it("replaces the cached failure with the answer, fresh enough to rest the finding on", async () => {
    const cache = cacheWith(failed);
    const read = vi.fn(async () => published);

    const got = await retryReading(ORIGIN, { read, ...cache }, () => 6000);

    expect(read).toHaveBeenCalledTimes(1);
    expect(got?.present).toBe(true);
    expect(got?.fresh).toBe(true);
    expect(cache.store.get(ORIGIN)).toBe(published);
  });

  it("replaces it with a 'not found' answer too: any answer is a reading", async () => {
    const cache = cacheWith(failed);
    const notFound = interpretResponse(`${ORIGIN}/.well-known/gpc.json`, 404, "text/html", "", 5000);

    const got = await retryReading(ORIGIN, { read: async () => notFound, ...cache }, () => 6000);

    expect(got).toBe(notFound);
    expect(cache.store.get(ORIGIN)).toBe(notFound);
  });

  it("leaves the cached failure and the row alone when the retry gets no answer either", async () => {
    const cache = cacheWith(failed);
    const again = { ...failed, observedAtMs: 5000 };

    const got = await retryReading(ORIGIN, { read: async () => again, ...cache }, () => 6000);

    expect(got).toBeNull();
    // The first failure keeps its time, so the site is not held off longer for the retry.
    expect(cache.store.get(ORIGIN)).toBe(failed);
  });

  it("uses an answer another tab cached meanwhile, without a request", async () => {
    const cache = cacheWith(published);
    const read = vi.fn(async () => published);

    const got = await retryReading(ORIGIN, { read, ...cache }, () => 5000 + CURRENT_READ_MS);

    expect(read).not.toHaveBeenCalled();
    expect(got?.present).toBe(true);
    // Served from the cache, so freshness is measured from that reading.
    expect(got?.fresh).toBe(false);
  });
});
