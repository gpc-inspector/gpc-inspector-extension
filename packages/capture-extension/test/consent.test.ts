// SPDX-License-Identifier: GPL-3.0-only
import { describe, it, expect, vi } from "vitest";
import {
  attributeCaller,
  interceptConsentApi,
  SKIP_INLINE_FRAMES,
  SKIP_COOKIE_WRAPPER_FRAMES,
  SKIP_DOM_METHOD_FRAMES,
} from "../src/observe/consent-api.js";
import {
  parseDocumentCookie,
  interceptDocumentCookie,
  interceptCookieStore,
  wrapperFillsStack,
  sameChain,
  STACK_FRAMES,
  DEEP_STACK_FRAMES,
  foldRun,
  cookieStringHolds,
  isRemoval,
  type JsCookieRecord,
} from "../src/observe/js-cookies.js";
import { createReadSampler } from "../src/observe/read-attribution.js";
import {
  toGppObservation,
  mergeGpp,
  gtmLoadersFromDocument,
  uspStringFrom,
  mergeUsPrivacy,
  uspCookieFrom,
  usPrivacyFromUrl,
  gppFromUrl,
  mergeGppWire,
  consentFromDataLayerPush,
  dataLayerPushArgs,
  detectGtmContainers,
  toGtmObservation,
  consentCommandOf,
  readEffectiveConsent,
  withFrameSeenContainers,
  matchesConfirmationNotice,
  findConfirmationNotice,
  toTcfObservation,
  checkUspWire,
  checkGppWire,
  withInvalidGppWire,
  withInvalidUspWire,
  MAX_WIRE_VALUES,
  dataLayerNamesFromGtmGlobal,
} from "../src/observe/consent-data.js";

describe("attributeCaller (FR-11)", () => {
  it("attributes a call to the vendor's own script", () => {
    const stack = `Error
    at Object.check (https://connect.facebook.net/en_US/fbevents.js:12:34)
    at https://example.com/page:1:1`;
    const r = attributeCaller(stack);
    expect(r.url).toContain("connect.facebook.net");
    expect(r.viaTagManager).toBe(false);
  });

  it("marks a tag-manager frame as unattributable rather than crediting Google", () => {
    // GTM executes vendor tags inside its own context, so the vendor has no frame.
    // Reporting gtm.js as "the caller" would credit or blame Google for every vendor.
    const stack = `Error
    at https://www.googletagmanager.com/gtm.js?id=GTM-ABC:99:1`;
    const r = attributeCaller(stack);
    expect(r.viaTagManager).toBe(true);
  });

  it("recognizes other tag managers (Tealium, Adobe, Segment)", () => {
    for (const host of [
      "https://tags.tiqcdn.com/utag/x/prod/utag.js:1:1",
      "https://assets.adobedtm.com/launch-abc.min.js:1:1",
      "https://cdn.segment.com/analytics.js/v1/x/analytics.min.js:1:1",
    ]) {
      expect(attributeCaller(`Error\n    at ${host}`).viaTagManager).toBe(true);
    }
  });

  it("returns null rather than guessing when there is no usable frame", () => {
    expect(attributeCaller(undefined).url).toBeNull();
    expect(attributeCaller("Error\n    at <anonymous>:1:1").url).toBeNull();
    expect(attributeCaller("Error\n    at eval (eval at foo)").url).toBeNull();
  });

  it("ignores our own extension frames", () => {
    const stack = `Error
    at chrome-extension://abcdef/main-world.js:5:5
    at https://vendor.example/tag.js:9:9`;
    expect(attributeCaller(stack).url).toContain("vendor.example");
  });
});

describe("attributeCaller — container URLs", () => {
  it("collects every container frame on the stack, innermost first, deduplicated", () => {
    // A Custom HTML snippet's frame is the page URL and the container is beneath it; the
    // Google tag inside a container puts two ids on one stack.
    const stack = `Error
    at chrome-extension://abcdef/main-world.js:5:5
    at https://www.example.com/article:12:3
    at https://www.googletagmanager.com/gtag/js?id=AW-123:1:1
    at https://www.googletagmanager.com/gtag/js?id=AW-123:2:2
    at https://www.googletagmanager.com/gtm.js?id=GTM-ABC:9:9`;
    const r = attributeCaller(stack);
    expect(r.containerUrls).toEqual([
      "https://www.googletagmanager.com/gtag/js?id=AW-123",
      "https://www.googletagmanager.com/gtm.js?id=GTM-ABC",
    ]);
  });

  it("keeps the container beneath a vendor's own frame, without changing who called", () => {
    // The vendor checked, AND a container tag is what invoked it. Both facts are kept; the
    // call stays the vendor's.
    const stack = `Error
    at https://connect.facebook.net/en_US/fbevents.js:12:34
    at https://www.googletagmanager.com/gtm.js?id=GTM-ABC:9:9`;
    const r = attributeCaller(stack);
    expect(r.url).toContain("connect.facebook.net");
    expect(r.viaTagManager).toBe(false);
    expect(r.containerUrls).toEqual(["https://www.googletagmanager.com/gtm.js?id=GTM-ABC"]);
  });

  it("is empty when no container is on the stack", () => {
    expect(attributeCaller("Error\n    at https://vendor.example/tag.js:1:1").containerUrls).toEqual([]);
    expect(attributeCaller(undefined).containerUrls).toEqual([]);
  });

  it("ships with the inline-frame skip ON; with it off, a snippet's call attributes to the page", () => {
    expect(SKIP_INLINE_FRAMES).toBe(true);
    const page = "https://www.example.com/article";
    const stack = `Error
    at ${page}:12:3
    at https://www.googletagmanager.com/gtm.js?id=GTM-ABC:9:9`;
    const r = attributeCaller(stack, page, false);
    expect(r.url).toBe(page);
    expect(r.viaTagManager).toBe(false);
    // The container is still recorded even though the call attributes to the page.
    expect(r.containerUrls).toEqual(["https://www.googletagmanager.com/gtm.js?id=GTM-ABC"]);
  });

  it("with the skip on, a snippet's call under a container becomes the container's", () => {
    const page = "https://www.example.com/article";
    const stack = `Error
    at ${page}:12:3
    at https://www.googletagmanager.com/gtm.js?id=GTM-ABC:9:9`;
    const r = attributeCaller(stack, page, true);
    expect(r.url).toBe("https://www.googletagmanager.com/gtm.js?id=GTM-ABC");
    expect(r.viaTagManager).toBe(true);
  });

  it("with the skip on, an inline-only stack still attributes to the page", () => {
    // The site's own inline snippet reading the property is a real fact and stays one.
    const page = "https://www.example.com/article";
    const stack = `Error
    at ${page}:12:3
    at ${page}:40:1`;
    const r = attributeCaller(stack, page, true);
    expect(r.url).toBe(page);
    expect(r.viaTagManager).toBe(false);
  });

  it("with the skip on, an inline frame above a named vendor frame yields the vendor", () => {
    const page = "https://www.example.com/article#section";
    const stack = `Error
    at https://www.example.com/article:12:3
    at https://vendor.example/loader.js:9:9`;
    expect(attributeCaller(stack, page, true).url).toBe("https://vendor.example/loader.js");
  });
});

/**
 * Stacks of cookie writes as V8 renders them beneath our setter: `captureStackTrace` starts
 * the capture at the setter's caller, so our own frame is not on them. Captured live on
 * 2026-09-27 through the Chrome DevTools MCP (automation profile) with the extension
 * installed, from a stand-in setter beneath ours; names and stacks only, never values.
 * Trimmed to the frames that matter.
 */
const OSANO = "https://cmp.osano.com/2sUBzx7wRdAfu6J2kkS/8e547744-886f-4a9b-a90f-7e96a47aa604/osano.js";
const OSANO_NWF = "https://cmp.osano.com/NWFexample0000001/00000000-0000-4000-8000-0000000000f1/osano.js";
const AIRGAP = "https://transcend-cdn.com/cm/e0d8c73f-0369-4ab4-b9ee-fa9922f76842/airgap.js";
const KETCH_BLOCK = "https://global.ketchcdn.com/web/v3/config/switchbitcorp/switchbit/block_script.js";
const KETCH_SDK = "https://cdn.ketchjs.com/ketchtag/stable/v2.12/ketch-sdk.js";
const GTM_NF = "https://www.googletagmanager.com/gtm.js?id=GTM-XNWF100&l=NF2DL";
const ARRAY_JS = "https://compass.osano.com/static/array.js";
const SITE_CHUNK = "https://transcend.io/_next/static/chunks/780c4844e7300f6b.js?dpl=dpl_4GTXfwVccQCDJT76NhwT8JwozX9t";
const ML_JS = "https://js.matheranalytics.com/s/ma00070/100000070/wp/ml.js?cb=1727";
const AIRLINE_A_WRAPPER = "https://www.airline-a.example/public/00000000000000000000000000000000000000000afb";
const DYNATRACE = "https://js-cdn.dynatrace.com/jstag/000000000a1/airlinea01/00000000000000a1_complete.js";
const MPULSE = "https://s.go-mpulse.net/boomerang/XALAX-EXAMP-LEKEY-00000-00001";
const RETAILER_A_WRAPPER = "https://www.retailer-a.example/resources/000000000000000000000000000000000000000000afb";
const BRAZE = "https://js.appboycdn.com/web-sdk/4.7/braze.min.js";
const FC_PATH =
  "/_/mss/boq-content-ads-contributor/_/js/k=boq-content-ads-contributor.ContributorServingResponseClientJs.en_US.2wSWc8lws08.es5.O/d=1/rs=AJlcJMwQ3kSZ_EVqug9VobPREUEo2nIkIw/m=kernel_loader,loader_js_executable";

const STACKS = {
  // osano.com, PostHog's write through Osano's accessor.
  osanoPageWrite: `Error
    at Et (${OSANO}:1:113993)
    at ${OSANO}:1:142161
    at HTMLDocument.set [as cookie] (${OSANO}:1:142245)
    at Object.At (${ARRAY_JS}:1:57608)
    at Object.Lt (${ARRAY_JS}:1:57695)
    at Object.Lt (${ARRAY_JS}:1:88743)
    at hl.remove (${ARRAY_JS}:1:93539)`,
  // osano.com, osano_consentmanager.
  osanoOwnWrite: `Error
    at Et (${OSANO}:1:113934)
    at be (${OSANO}:1:124354)
    at ${OSANO}:1:128653
    at Ce.setup (${OSANO}:1:129014)
    at xe.setup (${OSANO}:1:140292)
    at ${OSANO}:1:157111`,
  // transcend.io, __tld__ from the site's chunk.
  transcendPageWrite: `Error
    at r (${AIRGAP}:10:2993)
    at i (${AIRGAP}:10:3063)
    at HTMLDocument.set [as cookie] (${AIRGAP}:10:3168)
    at Object.i [as set] (${SITE_CHUNK}:37:187638)
    at W (${SITE_CHUNK}:37:188849)
    at e.get (${SITE_CHUNK}:37:189114)`,
  // ketch.com, _swb.
  ketchOwnWrite: `Error
    at HTMLDocument.n (${KETCH_BLOCK}:1:27822)
    at t.setCookie (${KETCH_SDK}:2:1653886)
    at ${KETCH_SDK}:2:1879634
    at Generator.next (<anonymous>)
    at ${KETCH_SDK}:2:1930910`,
  // news-f.example, nwf_byline: a Tag Manager Custom HTML snippet inserted through Osano's
  // insertBefore wrapper and our insertion observer.
  gtmSnippetViaInsertBefore: `Error
    at at (${OSANO_NWF}:2:126392)
    at ${OSANO_NWF}:2:154573
    at HTMLDocument.set [as cookie] (${OSANO_NWF}:2:154657)
    at <anonymous>:1:244
    at <anonymous>:1:341
    at HTMLBodyElement.wrapper (chrome-extension://flmbkameaidppjbcfacmglfcdelannij/main-world-insertion.js:397:21)
    at HTMLBodyElement.value [as insertBefore] (${OSANO_NWF}:2:55844)
    at ${GTM_NF}:1016:429
    at OS (${GTM_NF}:1018:31)
    at Md.NS (${GTM_NF}:1015:92)`,
  // news-f.example, FCCDCF: Funding Choices, whose frames carry a path and no URL.
  fundingChoices: `Error
    at at (${OSANO_NWF}:2:126392)
    at ${OSANO_NWF}:2:154573
    at HTMLDocument.set [as cookie] (${OSANO_NWF}:2:154657)
    at _.n.set (${FC_PATH}:170:1430)
    at _.n.remove (${FC_PATH}:171:243)
    at Pg (${FC_PATH}:168:57)`,
  // airline-a.example, dtCookie: the site's own wrapper, one frame, renders with the label and no
  // HTMLDocument receiver. Script URLs from a capture of the same page.
  airlineADynatrace: `Error
    at c.set [as cookie] (${AIRLINE_A_WRAPPER}:28:115)
    at vc (${DYNATRACE}:35:437)
    at pb (${DYNATRACE}:34:259)
    at uc (${DYNATRACE}:35:468)`,
  // airline-a.example, RT, through the same wrapper.
  airlineAMpulse: `Error
    at c.set [as cookie] (${AIRLINE_A_WRAPPER}:28:115)
    at Object.setCookie (${MPULSE}:10:7172)
    at Object.updateCookie (${MPULSE}:10:123529)`,
  // retailer-a.example, ab._gd: the site's own wrapper, the same shape.
  retailerABraze: `Error
    at Rk.c.set [as cookie] (${RETAILER_A_WRAPPER}:22:487)
    at new ec (${BRAZE}:87:193)
    at new lc (${BRAZE}:93:105)
    at gd (${BRAZE}:121:977)`,
  // news-f.example, _ml_id, the frames beneath Osano's accessor: Mather calls the setter
  // from its own `cookie` helper.
  matherMl: `Error
    at Object.cookie (${ML_JS}:2:117141)
    at Xe (${ML_JS}:2:64427)
    at nt (${ML_JS}:2:66775)`,
} as const;

describe("attributeCaller: the cookie-writes stacks (skips A and B)", () => {
  const page = "https://www.example.com/";
  type Case = {
    stack: string;
    wrappedOver: boolean;
    /** Both skips on, as shipped. */
    both: string | null;
    /** Skip A off, skip B on. */
    noA: string | null;
    /** Skip A on, skip B off. */
    noB: string | null;
    tagManager?: boolean;
  };
  const cases: Record<keyof typeof STACKS, Case> = {
    // The accessor is the deepest HTMLDocument frame of the run; the writer is beneath it.
    osanoPageWrite: { stack: STACKS.osanoPageWrite, wrappedOver: true, both: ARRAY_JS, noA: OSANO, noB: ARRAY_JS },
    // No HTMLDocument frame in the run: Osano called us from its own code, and wrote it.
    osanoOwnWrite: { stack: STACKS.osanoOwnWrite, wrappedOver: true, both: OSANO, noA: OSANO, noB: OSANO },
    transcendPageWrite: { stack: STACKS.transcendPageWrite, wrappedOver: true, both: SITE_CHUNK, noA: AIRGAP, noB: SITE_CHUNK },
    // Ketch's accessor is on the document itself and carries no [as cookie] label.
    ketchOwnWrite: { stack: STACKS.ketchOwnWrite, wrappedOver: true, both: KETCH_SDK, noA: KETCH_BLOCK, noB: KETCH_SDK },
    // Skip A leaves the inline snippet's unnamed frames, our insertion wrapper and Osano's
    // insertBefore wrapper; skip B steps over the last to the container that inserted it.
    gtmSnippetViaInsertBefore: {
      stack: STACKS.gtmSnippetViaInsertBefore,
      wrappedOver: true,
      both: GTM_NF,
      noA: OSANO_NWF,
      noB: OSANO_NWF,
      tagManager: true,
    },
    // Beneath the accessor only frames with a path and no URL: null.
    fundingChoices: { stack: STACKS.fundingChoices, wrappedOver: true, both: null, noA: OSANO_NWF, noB: null },
    // Not wrapped over: nothing is skipped, and the frame beneath ours is the writer.
    matherMl: { stack: STACKS.matherMl, wrappedOver: false, both: ML_JS, noA: ML_JS, noB: ML_JS },
    // A site's own wrapper, recognized by its label alone.
    airlineADynatrace: { stack: STACKS.airlineADynatrace, wrappedOver: true, both: DYNATRACE, noA: AIRLINE_A_WRAPPER, noB: DYNATRACE },
    airlineAMpulse: { stack: STACKS.airlineAMpulse, wrappedOver: true, both: MPULSE, noA: AIRLINE_A_WRAPPER, noB: MPULSE },
    retailerABraze: { stack: STACKS.retailerABraze, wrappedOver: true, both: BRAZE, noA: RETAILER_A_WRAPPER, noB: BRAZE },
  };

  for (const [name, c] of Object.entries(cases)) {
    it(`${name}: both skips on`, () => {
      const r = attributeCaller(c.stack, page, true, { cookieWrappedOver: c.wrappedOver });
      expect(r.url).toBe(c.both);
      expect(r.viaTagManager).toBe(c.tagManager === true);
    });
    it(`${name}: skip A off`, () => {
      const r = attributeCaller(c.stack, page, true, { cookieWrappedOver: c.wrappedOver, skipCookieWrapper: false });
      expect(r.url).toBe(c.noA);
      expect(r.wrapperUrl).toBeNull();
    });
    it(`${name}: skip B off`, () => {
      const r = attributeCaller(c.stack, page, true, { cookieWrappedOver: c.wrappedOver, skipDomMethod: false });
      expect(r.url).toBe(c.noB);
    });
  }

  it("ships with both skips on", () => {
    expect(SKIP_COOKIE_WRAPPER_FRAMES).toBe(true);
    expect(SKIP_DOM_METHOD_FRAMES).toBe(true);
  });

  it("records the wrapper it stepped over, and only then", () => {
    expect(attributeCaller(STACKS.osanoPageWrite, page, true, { cookieWrappedOver: true }).wrapperUrl).toBe(OSANO);
    expect(attributeCaller(STACKS.ketchOwnWrite, page, true, { cookieWrappedOver: true }).wrapperUrl).toBe(KETCH_BLOCK);
    expect(attributeCaller(STACKS.osanoOwnWrite, page, true, { cookieWrappedOver: true }).wrapperUrl).toBeNull();
    expect(attributeCaller(STACKS.matherMl, page, true, { cookieWrappedOver: true }).wrapperUrl).toBeNull();
  });

  it("never runs skip A unless the capture says it is wrapped over", () => {
    // GPC reads and consent calls pass no flag, so a tool's accessor frame on their stacks
    // (none is expected there) is not stepped over.
    expect(attributeCaller(STACKS.osanoPageWrite, page).url).toBe(OSANO);
    expect(attributeCaller(STACKS.ketchOwnWrite, page).url).toBe(KETCH_BLOCK);
  });

  it("recognizes a wrapper by its HTMLDocument receiver or by its [as cookie] label", () => {
    // Ketch's carries the receiver and no label; airline-a.example's and retailer-a.example's the label
    // and no receiver. Mather's `Object.cookie` carries neither and is the writer.
    expect(attributeCaller(STACKS.ketchOwnWrite, page, true, { cookieWrappedOver: true }).wrapperUrl).toBe(KETCH_BLOCK);
    expect(attributeCaller(STACKS.airlineADynatrace, page, true, { cookieWrappedOver: true }).wrapperUrl).toBe(AIRLINE_A_WRAPPER);
    expect(attributeCaller(STACKS.retailerABraze, page, true, { cookieWrappedOver: true }).wrapperUrl).toBe(RETAILER_A_WRAPPER);
    expect(attributeCaller(STACKS.matherMl, page, true, { cookieWrappedOver: true }).wrapperUrl).toBeNull();
  });

  it("takes the wrapper's own script when nothing at all lies beneath its accessor", () => {
    const stack = `Error
    at Et (${OSANO}:1:40233)
    at HTMLDocument.set [as cookie] (${OSANO}:1:41342)`;
    const r = attributeCaller(stack, page, true, { cookieWrappedOver: true });
    expect(r.url).toBe(OSANO);
    expect(r.wrapperUrl).toBe(OSANO);
  });

  it("passes over our own frames before the leading run, as in a stack taken without captureStackTrace", () => {
    const stack = `Error
    at HTMLDocument.ownSet (chrome-extension://abcdefghijklmnop/main-world.js:1:900)
    ${STACKS.osanoPageWrite.split("\n").slice(1).join("\n")}`;
    expect(attributeCaller(stack, page, true, { cookieWrappedOver: true }).url).toBe(ARRAY_JS);
  });

  it("returns the call chain beneath the wrapper, which is what makes a repeated call an echo", () => {
    const r = attributeCaller(STACKS.osanoPageWrite, page, true, { cookieWrappedOver: true });
    expect(r.below[0]).toBe(`Object.At (${ARRAY_JS}:1:57608)`);
    expect(r.below).toHaveLength(4);
    // Nothing stepped over: the chain is every frame beneath ours.
    expect(attributeCaller(STACKS.matherMl, page, true, { cookieWrappedOver: false }).below).toHaveLength(3);
    expect(attributeCaller(undefined).below).toEqual([]);
  });
});

describe("attributeCaller: skip B on GPC reads and consent calls", () => {
  const page = "https://www.example.com/";

  it("steps over a wrapped insertion method with another script beneath it", () => {
    // nwf_byline's write less the cookie accessor's frames: the shape a read or a consent
    // call from an inline snippet takes on the same page. Without skip B the answer is
    // Osano's insertBefore wrapper.
    const stack = `Error
    at <anonymous>:1:244
    at <anonymous>:1:341
    at HTMLBodyElement.wrapper (chrome-extension://abcdefghijklmnop/main-world-insertion.js:1:5120)
    at HTMLBodyElement.value [as insertBefore] (${OSANO}:2:55844)
    at ${GTM_NF}:1016:429`;
    const on = attributeCaller(stack, page);
    expect(on.url).toBe(GTM_NF);
    expect(on.viaTagManager).toBe(true);
    expect(attributeCaller(stack, page, true, { skipDomMethod: false }).url).toBe(OSANO);
  });

  for (const label of ["insertBefore", "appendChild", "append", "prepend", "replaceChild", "insertAdjacentElement"]) {
    it(`recognizes [as ${label}]`, () => {
      const stack = `Error
    at HTMLHeadElement.value [as ${label}] (${OSANO}:2:100)
    at https://vendor.example/loader.js:9:9`;
      expect(attributeCaller(stack, page).url).toBe("https://vendor.example/loader.js");
    });
  }

  it("keeps a wrapper frame when only its own script lies beneath it", () => {
    // Osano inserting its own script through its own wrapper: the call is Osano's.
    const stack = `Error
    at HTMLHeadElement.value [as appendChild] (${OSANO}:2:100)
    at Ce.load (${OSANO}:1:500)`;
    expect(attributeCaller(stack, page).url).toBe(OSANO);
  });

  it("keeps a wrapper frame with nothing beneath it", () => {
    const stack = `Error
    at HTMLHeadElement.value [as appendChild] (${OSANO}:2:100)`;
    expect(attributeCaller(stack, page).url).toBe(OSANO);
  });

  it("gives null, not the wrapper, when only an unnamed script lies beneath it", () => {
    const stack = `Error
    at HTMLHeadElement.value [as appendChild] (${OSANO}:2:100)
    at <anonymous>:3:17`;
    expect(attributeCaller(stack, page).url).toBeNull();
  });

  it("does not count a builtin frame as another script", () => {
    const stack = `Error
    at HTMLHeadElement.value [as appendChild] (${OSANO}:2:100)
    at Array.forEach (<anonymous>)`;
    expect(attributeCaller(stack, page).url).toBe(OSANO);
  });

  it("leaves a genuine loader's call alone: it is not rendered with the label", () => {
    const stack = `Error
    at HTMLHeadElement.appendChild (${OSANO}:2:100)
    at https://vendor.example/loader.js:9:9`;
    expect(attributeCaller(stack, page).url).toBe(OSANO);
  });

  it("applies to the read sampler and the consent-API wrapper, which call it with no options", () => {
    const stack = `Error
    at HTMLBodyElement.value [as insertBefore] (${OSANO}:2:55844)
    at ${GTM_NF}:1019:429`;
    const sampler = createReadSampler(() => stack);
    expect(sampler.onRead()?.url).toBe(GTM_NF);
  });
});

describe("consentCommandOf", () => {
  it("names default and update, and nothing else", () => {
    expect(consentCommandOf(["consent", "default", { ad_storage: "denied" }])).toBe("default");
    expect(consentCommandOf(["consent", "update", { ad_storage: "granted" }])).toBe("update");
    expect(consentCommandOf(["consent", "declare", {}])).toBeNull();
    expect(consentCommandOf(["config", "G-1"])).toBeNull();
    expect(consentCommandOf(["consent", "update"])).toBeNull();
  });
});

describe("readEffectiveConsent (the shared page-level store)", () => {
  it("reads the entries as they stand, keeping only the boolean fields the store had", () => {
    // Shape as observed live 2026-09-12: Google's types beside a site's own.
    const win = {
      google_tag_data: {
        ics: {
          entries: {
            ad_storage: { implicit: true, quiet: false },
            analytics_storage: { implicit: true, update: false },
            apc_performance: { default: false, quiet: false, update: true },
            junk: { note: "not a boolean" },
          },
          listeners: [],
        },
      },
    };
    expect(readEffectiveConsent(win)).toEqual({
      ad_storage: { implicit: true },
      analytics_storage: { implicit: true, update: false },
      apc_performance: { default: false, update: true },
    });
  });

  it("returns null when the store is absent or not of the expected shape", () => {
    // null means "could not read", never "no consent mode".
    expect(readEffectiveConsent({})).toBeNull();
    expect(readEffectiveConsent({ google_tag_data: {} })).toBeNull();
    expect(readEffectiveConsent({ google_tag_data: { ics: { entries: "nope" } } })).toBeNull();
    expect(readEffectiveConsent({ google_tag_data: { ics: { entries: [{ default: true }] } } })).toBeNull();
    expect(readEffectiveConsent(null)).toBeNull();
  });

  it("returns {} for a store read with no usable entry: read, and nothing set", () => {
    expect(readEffectiveConsent({ google_tag_data: { ics: { entries: {} } } })).toEqual({});
    expect(readEffectiveConsent({ google_tag_data: { ics: { entries: { x: { note: 1 } } } } })).toEqual({});
  });

  it("never throws, whatever the page put there", () => {
    const hostile = {
      get google_tag_data(): never {
        throw new Error("no");
      },
    };
    expect(readEffectiveConsent(hostile)).toBeNull();
  });
});

describe("withFrameSeenContainers", () => {
  const base = toGtmObservation(["GTM-A"], [], null, true);

  it("adds container and Google-tag ids seen on check stacks, and marks the page present", () => {
    const out = withFrameSeenContainers(toGtmObservation([], [], null, false), [
      "https://www.googletagmanager.com/gtm.js?id=GTM-B&l=NF2DL",
      "https://www.googletagmanager.com/gtag/js?id=G-XYZ",
      "https://www.googletagmanager.com/gtm.js?id=GTM-B",
    ]);
    expect(out.present).toBe(true);
    expect(out.containerIds).toEqual(["GTM-B"]);
    expect(out.gtagIds).toEqual(["G-XYZ"]);
  });

  it("returns the same object when nothing is new, so a report is not churned", () => {
    expect(withFrameSeenContainers(base, ["https://www.googletagmanager.com/gtm.js?id=GTM-A"])).toBe(base);
  });

  it("ignores unnamed manager frames and non-Google managers", () => {
    const out = withFrameSeenContainers(base, [
      "https://www.googletagmanager.com/debug/bootstrap",
      "https://tags.tiqcdn.com/utag/acme/main/prod/utag.js",
      "https://vendor.example/tag.js",
    ]);
    expect(out).toBe(base);
  });
});

describe("interceptConsentApi — late definition (the CMP loads after us)", () => {
  function fakeWindow(): Window & typeof globalThis {
    return {} as Window & typeof globalThis;
  }

  it("returns undefined before the CMP defines the API, so feature-detection is unaffected", () => {
    const win = fakeWindow();
    interceptConsentApi(win, "__gpp", () => {}, () => {});
    expect((win as unknown as Record<string, unknown>)["__gpp"]).toBeUndefined();
  });

  it("intercepts the CMP's later assignment and records calls", () => {
    const win = fakeWindow();
    const calls: unknown[] = [];
    interceptConsentApi(win, "__gpp", (c) => calls.push(c), () => {});

    // CMP script loads and defines its API.
    const real = vi.fn(() => "real-result");
    (win as unknown as Record<string, unknown>)["__gpp"] = real;

    const api = (win as unknown as Record<string, () => unknown>)["__gpp"];
    expect(typeof api).toBe("function");

    const result = (api as (...a: unknown[]) => unknown)("getGPPData");
    expect(result).toBe("real-result"); // value passes through untouched
    expect(real).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(1);
    expect((calls[0] as { command: string }).command).toBe("getGPPData");
  });

  it("observes callback results without altering them", () => {
    const win = fakeWindow();
    const results: unknown[] = [];
    interceptConsentApi(win, "__gpp", () => {}, (_api, _cmd, data) => results.push(data));

    (win as unknown as Record<string, unknown>)["__gpp"] = (
      _cmd: string,
      cb: (d: unknown) => void,
    ) => cb({ gppString: "DBABz~x" });

    let received: unknown = null;
    const api = (win as unknown as Record<string, (...a: unknown[]) => unknown>)["__gpp"];
    api?.("getGPPData", (d: unknown) => {
      received = d;
    });

    expect(results).toHaveLength(1);
    expect(received).toEqual({ gppString: "DBABz~x" }); // page still gets the real data
  });

  it("does not break the page when the recorder throws", () => {
    const win = fakeWindow();
    interceptConsentApi(
      win,
      "__uspapi",
      () => {
        throw new Error("recorder exploded");
      },
      () => {},
    );
    (win as unknown as Record<string, unknown>)["__uspapi"] = () => "ok";
    const api = (win as unknown as Record<string, (...a: unknown[]) => unknown>)["__uspapi"];
    expect(() => api?.("getUSPData")).not.toThrow();
    expect(api?.("getUSPData")).toBe("ok");
  });
});

describe("toGppObservation (FR-12) — the flagship finding's input", () => {
  it("extracts the fields behind the Gpc/SaleOptOut conflict", () => {
    const gpp = toGppObservation({
      gppString: "DBABBg~xlgWxdSA",
      gppVersion: "1.1",
      applicableSections: [8],
      parsedSections: {
        usca: { Gpc: 1, SaleOptOut: 2, SharingOptOut: 2, MspaServiceProviderMode: 0 },
      },
    });
    expect(gpp).not.toBeNull();
    expect(gpp!.applicableSections).toEqual([8]);
    expect(gpp!.sections["usca"]?.Gpc).toBe(1);
    expect(gpp!.sections["usca"]?.SaleOptOut).toBe(2);
    expect(gpp!.unparseable).toBe(false);
  });

  it("keeps all three MSPA fields under their IAB names", () => {
    // The IAB names are MspaCoveredTransaction (singular) and MspaOptOutOptionMode. A field
    // under any other name leaves its MSPA row in the popup with no value to show.
    const gpp = toGppObservation({
      gppString: "DBABLA~BVQVAAAAAAFY.YA",
      applicableSections: [7],
      parsedSections: {
        usnat: { SaleOptOut: 1, MspaCoveredTransaction: 1, MspaServiceProviderMode: 2, MspaOptOutOptionMode: 1 },
      },
    });
    expect(gpp!.sections["usnat"]).toEqual({
      SaleOptOut: 1,
      MspaCoveredTransaction: 1,
      MspaServiceProviderMode: 2,
      MspaOptOutOptionMode: 1,
    });
  });

  it("preserves the raw string so a skeptic can re-decode it", () => {
    const gpp = toGppObservation({ gppString: "DBABBg~xlgWxdSA", parsedSections: {} });
    expect(gpp!.rawString).toBe("DBABBg~xlgWxdSA");
  });

  it("flags unparseable rather than guessing at sections", () => {
    const gpp = toGppObservation({ gppString: "garbage" });
    expect(gpp!.unparseable).toBe(true);
    expect(gpp!.sections).toEqual({});
  });

  it("reads a boolean Gpc as the flag it is (OneTrust on sports-a.example, 2026-09-17)", () => {
    // The exact usnat section OneTrust's __gpp ping returned, with Gpc as a boolean.
    const sportsA = {
      gppVersion: "1.1",
      applicableSections: [7],
      gppString: "DBABLA~BVQVAAAAAAFY.YA",
      parsedSections: {
        usnat: { Version: 1, SaleOptOut: 1, SharingOptOut: 1, TargetedAdvertisingOptOut: 1, MspaServiceProviderMode: 2, GpcSegmentType: 1, Gpc: true },
      },
    };
    const gpp = toGppObservation(sportsA);
    expect(gpp!.sections["usnat"]?.Gpc).toBe(1);
    expect(gpp!.sections["usnat"]?.SaleOptOut).toBe(1);
    expect(toGppObservation({ ...sportsA, parsedSections: { usnat: { ...sportsA.parsedSections.usnat, Gpc: false } } })!.sections["usnat"]?.Gpc).toBe(0);
  });

  it("reads every segment when a section arrives as an array of segment objects", () => {
    // The IAB reference decoder's shape: a core segment and a GPC sub-segment.
    const gpp = toGppObservation({
      gppString: "DBABLA~BVQVAAAAAAFY.YA",
      applicableSections: [7],
      parsedSections: { usnat: [{ Version: 1, SaleOptOut: 1, SharingOptOut: 2 }, { SubsectionType: 1, Gpc: true }] },
    });
    expect(gpp!.sections["usnat"]).toEqual({ SaleOptOut: 1, SharingOptOut: 2, Gpc: 1 });
  });

  it("ignores string field values instead of coercing them (booleans are read only for Gpc)", () => {
    const gpp = toGppObservation({
      gppString: "x",
      applicableSections: [7],
      parsedSections: { usnat: { Gpc: "1", SaleOptOut: true } },
    });
    expect(gpp!.sections["usnat"]?.Gpc).toBeUndefined();
    expect(gpp!.sections["usnat"]?.SaleOptOut).toBeUndefined();
  });

  it("returns null for a non-object payload", () => {
    expect(toGppObservation(null)).toBeNull();
    expect(toGppObservation("nope")).toBeNull();
  });
});

describe("US Privacy, three surfaces (FR-13)", () => {
  it("reads the string from the API payload", () => {
    expect(uspStringFrom({ uspString: "1YNN" })).toBe("1YNN");
    expect(uspStringFrom({})).toBeNull();
  });

  it("extracts us_privacy from a request URL (the wire surface)", () => {
    expect(usPrivacyFromUrl("https://ads.example/x?us_privacy=1YNN&z=1")).toBe("1YNN");
    expect(usPrivacyFromUrl("https://ads.example/x")).toBeNull();
    expect(usPrivacyFromUrl("garbage")).toBeNull();
  });

  it("merges surfaces without clobbering the others", () => {
    let usp = mergeUsPrivacy(null, "api", "1YYN");
    usp = mergeUsPrivacy(usp, "wire", "1YNN");
    expect(usp.fromApi).toBe("1YYN");
    expect(usp.fromWire).toBe("1YNN"); // disagreement preserved — that IS the finding
    expect(usp.fromCookie).toBeNull();
  });

  it("ignores a null value rather than erasing a known surface", () => {
    const usp = mergeUsPrivacy({ fromApi: "1YNN", fromCookie: null, fromWire: null }, "api", null);
    expect(usp.fromApi).toBe("1YNN");
  });

  // news-h.example, 2026-09-30: requests alternated between 1--- and 1YYN. With only the last
  // one kept, the disagreement notice would come and go.
  it("keeps every distinct string requests carried, with its hosts, first seen first", () => {
    let usp = mergeUsPrivacy(null, "api", "1YYN");
    usp = mergeUsPrivacy(usp, "wire", "1---", "pixel.rubiconproject.com");
    usp = mergeUsPrivacy(usp, "wire", "1YYN", "securepubads.g.doubleclick.net");
    usp = mergeUsPrivacy(usp, "wire", "1---", "gum.criteo.com");
    usp = mergeUsPrivacy(usp, "wire", "1---", "pixel.rubiconproject.com");
    expect(usp.fromWire).toBe("1---");
    expect(usp.fromWireHost).toBe("pixel.rubiconproject.com");
    expect(usp.wireValues).toEqual([
      { value: "1---", hosts: ["pixel.rubiconproject.com", "gum.criteo.com"] },
      { value: "1YYN", hosts: ["securepubads.g.doubleclick.net"] },
    ]);
  });

  it("caps the distinct strings and the hosts per string", () => {
    let usp = mergeUsPrivacy(null, "wire", "1YYN", "h0.example");
    for (let i = 1; i < 8; i++) usp = mergeUsPrivacy(usp, "wire", "1YYN", `h${i}.example`);
    for (const v of ["1NNN", "1NNY", "1NYN", "1NYY", "1YNN", "1YNY"]) usp = mergeUsPrivacy(usp, "wire", v, "x.example");
    expect(usp.wireValues).toHaveLength(MAX_WIRE_VALUES);
    expect(usp.wireValues![0]!.hosts).toHaveLength(5);
  });

  it("starts the list over when the page's own string changes, and only then", () => {
    let usp = mergeUsPrivacy(null, "wire", "1---", "early.example"); // before the API answered
    usp = mergeUsPrivacy(usp, "api", "1YNN");
    expect(usp.wireValues).toHaveLength(1); // null to a value is not a change
    usp = mergeUsPrivacy(usp, "wire", "1YNN", "bid.example");
    usp = mergeUsPrivacy(usp, "api", "1YNN");
    expect(usp.wireValues).toHaveLength(2); // the same value again is not a change
    usp = mergeUsPrivacy(usp, "api", "1YYN"); // the visitor opted out
    expect(usp.wireValues).toEqual([]);
    expect(usp.fromWire).toBe("1YNN"); // still the most recent request's
    usp = mergeUsPrivacy(usp, "cookie", "1YNN");
    usp = mergeUsPrivacy(usp, "wire", "1YNN", "stale.example");
    // The cookie catching up with an API that did not change is not a change of the page's
    // string, which is the API's.
    usp = mergeUsPrivacy(usp, "cookie", "1YYN");
    expect(usp.wireValues).toEqual([{ value: "1YNN", hosts: ["stale.example"] }]);
  });

  it("starts over on a cookie change when the cookie is the page's only string", () => {
    let usp = mergeUsPrivacy(null, "cookie", "1YNN");
    usp = mergeUsPrivacy(usp, "wire", "1YNN", "bid.example");
    usp = mergeUsPrivacy(usp, "cookie", "1YYN");
    expect(usp.wireValues).toEqual([]);
  });

  it("keeps the list when the API first answers after the cookie was read", () => {
    let usp = mergeUsPrivacy(null, "cookie", "1YNN"); // document_start, a stale cookie
    usp = mergeUsPrivacy(usp, "wire", "1---", "early.example"); // before the CMP answered
    usp = mergeUsPrivacy(usp, "api", "1YYN");
    expect(usp.wireValues).toEqual([{ value: "1---", hosts: ["early.example"] }]);
  });

  it("reads the usprivacy cookie from document.cookie", () => {
    expect(uspCookieFrom("a=1; usprivacy=1YNN; b=2")).toBe("1YNN");
    expect(uspCookieFrom("usprivacy=1YYN")).toBe("1YYN");
    // The most specific path comes first in document.cookie, and is what the page reads.
    expect(uspCookieFrom("usprivacy=1YYN; usprivacy=1YNN")).toBe("1YYN");
    expect(uspCookieFrom("x_usprivacy=1YNN; usprivacy_old=1YNN")).toBeNull();
    expect(uspCookieFrom("usprivacy=; a=1")).toBeNull();
    expect(uspCookieFrom("")).toBeNull();
  });
});

describe("GPP wire surface — same failure mode as USP, no cookie surface", () => {
  it("extracts gpp from a request URL", () => {
    expect(gppFromUrl("https://ads.example/x?gpp=DBABBg~x&gpp_sid=8")).toBe("DBABBg~x");
    expect(gppFromUrl("https://ads.example/x")).toBeNull();
    expect(gppFromUrl("garbage")).toBeNull();
  });

  it("builds a wire-only observation when nothing existed yet", () => {
    const gpp = mergeGppWire(null, "DBABBg~x");
    expect(gpp!.fromWire).toBe("DBABBg~x");
    expect(gpp!.rawString).toBe(""); // no API surface observed
  });

  it("sets fromWire without disturbing an existing API-sourced observation", () => {
    const api = toGppObservation({ gppString: "DBABBg~x", parsedSections: { usca: { Gpc: 1 } } });
    const merged = mergeGppWire(api, "DBABBg~different");
    expect(merged!.rawString).toBe("DBABBg~x"); // untouched
    expect(merged!.sections["usca"]?.Gpc).toBe(1); // untouched
    expect(merged!.fromWire).toBe("DBABBg~different"); // disagreement preserved
  });

  it("ignores a null wire value rather than erasing a known one", () => {
    const gpp = mergeGppWire(mergeGppWire(null, "DBABBg~x"), null);
    expect(gpp!.fromWire).toBe("DBABBg~x");
  });

  it("survives a later __gpp payload merging in (mergeGpp must not erase fromWire)", () => {
    const withWire = mergeGppWire(
      toGppObservation({ gppString: "DBABBg~x", parsedSections: { usca: { Gpc: 1 } } }),
      "DBABBg~different",
    );
    const laterApiPayload = toGppObservation({ gppVersion: "1.1" }); // sparse ping, no wire data
    const merged = mergeGpp(withWire, laterApiPayload);
    expect(merged!.fromWire).toBe("DBABBg~different");
  });

  it("keeps the host, every string and the invalid values through a later __gpp payload", () => {
    let gpp = mergeGppWire(null, "DBABBg~a", "fastlane.rubiconproject.com");
    gpp = mergeGppWire(gpp, "DBABBg~b", "securepubads.g.doubleclick.net");
    gpp = withInvalidGppWire(gpp, { kind: "invalid", value: "[GPP]", placeholder: true }, "sync.example");
    const merged = mergeGpp(gpp, toGppObservation({ gppString: "DBABBg~b", parsedSections: { usca: { Gpc: 1 } } }))!;
    expect(merged.fromWireHost).toBe("securepubads.g.doubleclick.net");
    expect(merged.wireValues).toEqual([
      { value: "DBABBg~a", hosts: ["fastlane.rubiconproject.com"] },
      { value: "DBABBg~b", hosts: ["securepubads.g.doubleclick.net"] },
    ]);
    expect(merged.invalidWire).toHaveLength(1);
  });

  it("starts the list over when the page's own string changes", () => {
    const api = (s: string) => toGppObservation({ gppString: s, parsedSections: { usca: { Gpc: 1 } } });
    let gpp = mergeGppWire(null, "DBABBg~early", "early.example");
    gpp = mergeGpp(gpp, api("DBABBg~x")); // no string before: not a change
    expect(gpp!.wireValues).toHaveLength(1);
    gpp = mergeGpp(gpp, api("DBABBg~x"));
    expect(gpp!.wireValues).toHaveLength(1);
    gpp = mergeGpp(gpp, api("DBABBg~y"));
    expect(gpp!.wireValues).toEqual([]);
  });
});

describe("dataLayerPushArgs — gtag()'s arguments object vs a real push array (FR-15)", () => {
  // gtag() is implemented as `function gtag(){ dataLayer.push(arguments); }` — an
  // `arguments` object is array-LIKE (has a numeric length) but fails Array.isArray, so a
  // check that only accepts real arrays silently drops every gtag() call.
  function asArguments(...args: unknown[]): IArguments {
    // The inner function needs a rest param for TS to accept a spread of a non-tuple
    // array here; `arguments` reflects the real call regardless of the declared params.
    return (function (..._rest: unknown[]) {
      return arguments;
    })(...args);
  }

  it("passes a real array through unchanged", () => {
    const arr = ["consent", "default", { ad_storage: "denied" }];
    expect(dataLayerPushArgs(arr)).toBe(arr);
  });

  it("converts an arguments-like object to a real array", () => {
    const args = asArguments("consent", "default", { ad_storage: "denied" });
    expect(dataLayerPushArgs(args)).toEqual(["consent", "default", { ad_storage: "denied" }]);
  });

  it("returns null for values with no length, rather than coercing garbage", () => {
    expect(dataLayerPushArgs(null)).toBeNull();
    expect(dataLayerPushArgs(undefined)).toBeNull();
    expect(dataLayerPushArgs("consent")).toBeNull();
    expect(dataLayerPushArgs(42)).toBeNull();
    expect(dataLayerPushArgs({ ad_storage: "denied" })).toBeNull();
  });

  it("feeds consentFromDataLayerPush correctly through the arguments-object path", () => {
    // The end-to-end case this exists for: a consent call made via gtag(), read back as
    // consent state, exactly as a raw dataLayer.push() call is.
    const args = dataLayerPushArgs(asArguments("consent", "default", { ad_user_data: "denied" }));
    const state = args ? consentFromDataLayerPush(args, null) : null;
    expect(state?.ad_user_data).toBe("denied");
  });
});

describe("GTM Consent Mode (FR-15)", () => {
  it("reads a consent default push", () => {
    const state = consentFromDataLayerPush(
      ["consent", "default", { ad_user_data: "denied", ad_storage: "denied" }],
      null,
    );
    expect(state?.ad_user_data).toBe("denied");
    expect(state?.ad_storage).toBe("denied");
    expect(state?.ad_personalization).toBe("unspecified");
  });

  it("lets a later update override an earlier default, matching Google's semantics", () => {
    const first = consentFromDataLayerPush(
      ["consent", "default", { ad_user_data: "denied" }],
      null,
    );
    const second = consentFromDataLayerPush(
      ["consent", "update", { ad_user_data: "granted" }],
      first,
    );
    expect(second?.ad_user_data).toBe("granted");
  });

  it("leaves unmentioned keys alone on a partial update", () => {
    const first = consentFromDataLayerPush(
      ["consent", "default", { ad_user_data: "denied", ad_storage: "denied" }],
      null,
    );
    const second = consentFromDataLayerPush(["consent", "update", { ad_storage: "granted" }], first);
    expect(second?.ad_user_data).toBe("denied");
    expect(second?.ad_storage).toBe("granted");
  });

  it("ignores non-consent dataLayer pushes", () => {
    expect(consentFromDataLayerPush(["event", "pageview"], null)).toBeNull();
    expect(consentFromDataLayerPush(["consent"], null)).toBeNull();
    expect(consentFromDataLayerPush([], null)).toBeNull();
  });

  it("treats unknown consent values as unspecified rather than guessing", () => {
    const state = consentFromDataLayerPush(["consent", "default", { ad_storage: "maybe" }], null);
    expect(state?.ad_storage).toBe("unspecified");
  });

  it("detects GTM container ids", () => {
    const win = {
      google_tag_manager: { "GTM-WKX4": {}, "GTM-ZZZ9": {}, dataLayer: {} },
    } as unknown as Window & typeof globalThis;
    expect(detectGtmContainers(win).sort()).toEqual(["GTM-WKX4", "GTM-ZZZ9"]);
  });

  it("reports present when a dataLayer exists even without a container id", () => {
    expect(toGtmObservation([], [], null, true).present).toBe(true);
    expect(toGtmObservation([], [], null, false).present).toBe(false);
  });

  it("reports present for gtag.js with no container at all", () => {
    // Consent Mode is a tag-platform feature reached through the global gtag() function,
    // which pushes to the dataLayer. A site can deploy it with gtag.js and no Tag Manager,
    // and reporting that as "Tag Manager (unknown)" would mislabel the site.
    const o = toGtmObservation([], ["G-ABC123"], null, false);
    expect(o.present).toBe(true);
    expect(o.containerIds).toEqual([]);
    expect(o.gtagIds).toEqual(["G-ABC123"]);
  });
});

describe("Google tag loaders: container vs gtag.js", () => {
  function docWith(srcs: string[]): Document {
    return {
      baseURI: "https://example.com/",
      querySelectorAll: () =>
        srcs.map((src) => ({ getAttribute: () => src })) as unknown as NodeListOf<HTMLScriptElement>,
    } as unknown as Document;
  }

  it("separates gtag.js measurement IDs from Tag Manager container IDs", () => {
    // Both load from googletagmanager.com; only the path and the ID prefix distinguish
    // them. Observed on news-f.example: gtag/js?id=AW-70100000000 alongside real
    // GTM- containers.
    const r = gtmLoadersFromDocument(
      docWith([
        "https://www.googletagmanager.com/gtm.js?id=GTM-XNWF20",
        "https://www.googletagmanager.com/gtag/js?id=AW-70100000000",
        "https://www.googletagmanager.com/gtag/js?id=G-XNWF200000&cx=c",
      ]),
    );
    expect(r.containerIds).toEqual(["GTM-XNWF20"]);
    expect(r.gtagIds.sort()).toEqual(["AW-70100000000", "G-XNWF200000"]);
  });

  it("finds gtag.js on a site with no container", () => {
    const r = gtmLoadersFromDocument(
      docWith(["https://www.googletagmanager.com/gtag/js?id=G-ABC123"]),
    );
    expect(r.containerIds).toEqual([]);
    expect(r.gtagIds).toEqual(["G-ABC123"]);
  });

  it("ignores unrelated scripts from the same host path space", () => {
    const r = gtmLoadersFromDocument(docWith(["https://cdn.example.com/app.js"]));
    expect(r.containerIds).toEqual([]);
    expect(r.gtagIds).toEqual([]);
  });
});

describe("confirmation notice scan (FR-14)", () => {
  it("matches the regulator's example phrasing and common variants", () => {
    for (const text of [
      "Opt-out request honored",
      "Your opt-out preference has been received",
      "We have processed your opt-out",
      "Global Privacy Control detected",
      "opt-out preference signal was applied",
    ]) {
      expect(matchesConfirmationNotice(text)).toBe(true);
    }
  });

  it("does not match unrelated privacy boilerplate", () => {
    for (const text of [
      "We value your privacy and use cookies",
      "Do Not Sell My Personal Information",
      "Privacy Policy",
      "Manage cookie preferences",
      "",
    ]) {
      expect(matchesConfirmationNotice(text)).toBe(false);
    }
  });

  it("does not treat a toggle's state as a confirmation of processing", () => {
    // §7025(c)(6) requires the business to display that it PROCESSED the signal. A
    // control showing its current state is not that statement, and a pattern that
    // matches it produces a false positive from inside a CMP iframe.
    for (const text of [
      "Do Not Sell or Share My Personal Information: On",
      "Do Not Sell or Share My Personal Information  Enabled",
      "Your privacy choices — active",
    ]) {
      expect(matchesConfirmationNotice(text)).toBe(false);
    }
  });

  it("still matches genuine confirmations of processing", () => {
    expect(matchesConfirmationNotice("Opt-out preference signal honored")).toBe(true);
    expect(
      matchesConfirmationNotice("Global Privacy Control detected and applied to this browser"),
    ).toBe(true);
  });

  it("matches the request-signal, browser and preference-choices notices", () => {
    // Each shown on its live page only with the signal on.
    for (const [text, patternIndex] of [
      ["Opt-Out Request Signal Honored", 0], // streaming-c.example
      ["Browser Opt-Out Honored", 4], // retailer-i.example
      ["Your Opt-Out Preference Choices Are Honored", 5], // www.automaker-a.example
    ] as const) {
      expect(findConfirmationNotice(text)?.patternIndex).toBe(patternIndex);
    }
  });

  it("matches the common notices on the first pattern", () => {
    for (const [text, patternIndex] of [
      ["Opt-Out Request Honored", 0], // retailer-b.example, retailer-f.example, automaker-e.example, automaker-g.example
      ["Opt-Out Signal Honored", 0], // news-f.example
      ["Your Opt-Out Preference Signal Has Been Honored", 0], // retailer-j.example
    ] as const) {
      expect(findConfirmationNotice(text)?.patternIndex).toBe(patternIndex);
    }
  });

  it("matches a notice that reports the signal as detected", () => {
    // Shown only with the signal on, next to a consent tool that switched targeting off.
    const text =
      "Your browser's opt out signal was detected; your choice to opt out of targeted online advertising has been honored.";
    expect(findConfirmationNotice(text)?.patternIndex).toBe(6);
    expect(findConfirmationNotice("Opt-out preference signal has been detected")?.patternIndex).toBe(6);
  });

  it("matches a notice that names the signal as GPC", () => {
    for (const text of ["GPC Honored", "GPC signal honored", "GPC has been honored"]) {
      expect(findConfirmationNotice(text)?.patternIndex).toBe(7);
    }
  });

  it("does not match policy copy that mentions GPC", () => {
    for (const text of [
      "We honor GPC",
      "GPC signals are honored",
      "If GPC is detected, we will honor it",
      "GPC: On",
      "This site honors GPC",
      "GPC-enabled browsers are supported",
      "We've received your Global Privacy Control (GPC) signal",
    ]) {
      expect(matchesConfirmationNotice(text)).toBe(false);
    }
  });

  it("does not take policy copy about a detected signal as a notice", () => {
    for (const text of [
      "If an opt-out signal is detected, we will treat it as a request to opt out of sale.",
      "When an opt-out preference signal is detected, we stop sharing.",
      "Your request was detected",
      "Opt-out signal detection",
    ]) {
      expect(matchesConfirmationNotice(text)).toBe(false);
    }
  });

  it("does not match policy copy close to a notice's phrasing", () => {
    for (const text of [
      "Opt-out honored",
      "Browser opt-out choices",
      "How to set a browser opt-out signal",
      "Browser opt-out will be honored where required by law",
      "Your opt-out choices are honored",
      "Your opt-out preference choices will be honored",
      "Your opt-out preference choices",
      "Opt-out requests are processed within 15 business days",
      "Opt-out request signal",
      "Do Not Sell or Share: On",
    ]) {
      expect(matchesConfirmationNotice(text)).toBe(false);
    }
  });

  it("caps the scanned length so an enormous page cannot stall the scan", () => {
    const huge = "x".repeat(500_000) + "Opt-out request honored";
    // The match is beyond the cap, so it is not detected — and "not detected on this
    // page" is the only claim this ever produces, which stays true.
    expect(matchesConfirmationNotice(huge)).toBe(false);
  });
});

describe("GPP payload shapes (observed: 8 __gpp calls yielded nothing)", () => {
  it("unwraps an addEventListener event with nested pingData", () => {
    const gpp = toGppObservation({
      eventName: "listenerRegistered",
      listenerId: 1,
      pingData: {
        gppVersion: "1.1",
        applicableSections: [8],
        parsedSections: { usca: { Gpc: 1, SaleOptOut: 2 } },
      },
    });
    expect(gpp!.applicableSections).toEqual([8]);
    expect(gpp!.sections["usca"]?.Gpc).toBe(1);
  });

  it("unwraps a nested `data` payload", () => {
    const gpp = toGppObservation({
      eventName: "sectionChange",
      data: { gppString: "DBABBg~x", applicableSections: [7] },
    });
    expect(gpp!.rawString).toBe("DBABBg~x");
    expect(gpp!.applicableSections).toEqual([7]);
  });

  it("handles a bare ping response with no gppString", () => {
    const gpp = toGppObservation({ gppVersion: "1.1", applicableSections: [8] });
    expect(gpp!.gppVersion).toBe("1.1");
    expect(gpp!.rawString).toBe("");
    expect(gpp!.unparseable).toBe(false); // no string, so nothing failed to parse
  });
});

describe("mergeGpp — later payloads must not erase earlier ones", () => {
  it("keeps the string from an earlier payload when a later one lacks it", () => {
    const first = toGppObservation({
      gppString: "DBABBg~x",
      applicableSections: [8],
      parsedSections: { usca: { Gpc: 1, SaleOptOut: 2 } },
    });
    const later = toGppObservation({ gppVersion: "1.1" }); // sparse ping
    const merged = mergeGpp(first, later);
    expect(merged!.rawString).toBe("DBABBg~x");
    expect(merged!.sections["usca"]?.Gpc).toBe(1);
    expect(merged!.gppVersion).toBe("1.1");
  });

  it("merges section fields rather than replacing the section", () => {
    const a = toGppObservation({ gppString: "x", parsedSections: { usca: { Gpc: 1 } } });
    const b = toGppObservation({ gppString: "x", parsedSections: { usca: { SaleOptOut: 2 } } });
    const merged = mergeGpp(a, b);
    expect(merged!.sections["usca"]?.Gpc).toBe(1);
    expect(merged!.sections["usca"]?.SaleOptOut).toBe(2);
  });

  it("returns the existing observation when the incoming one is null", () => {
    const a = toGppObservation({ gppString: "x", applicableSections: [8] });
    expect(mergeGpp(a, null)).toBe(a);
  });
});

describe("gtmLoadersFromDocument — renamed dataLayer (observed: l=NF2DL)", () => {
  function docWith(srcs: string[]): Document {
    return {
      baseURI: "https://example.com/",
      querySelectorAll: () =>
        srcs.map((src) => ({ getAttribute: () => src })) as unknown as NodeListOf<HTMLScriptElement>,
    } as unknown as Document;
  }

  it("extracts container ids from loader URLs", () => {
    const r = gtmLoadersFromDocument(
      docWith([
        "https://www.googletagmanager.com/gtm.js?id=GTM-XNWF20",
        "https://www.googletagmanager.com/gtm.js?id=GTM-XNWF100&l=NF2DL",
      ]),
    );
    expect(r.containerIds.sort()).toEqual(["GTM-XNWF100", "GTM-XNWF20"]);
  });

  it("picks up a renamed dataLayer, which window.dataLayer would miss entirely", () => {
    const r = gtmLoadersFromDocument(
      docWith(["https://www.googletagmanager.com/gtm.js?id=GTM-XNWF100&l=NF2DL"]),
    );
    expect(r.dataLayerNames).toContain("NF2DL");
    expect(r.dataLayerNames).toContain("dataLayer"); // default stays a candidate
  });

  it("ignores non-GTM scripts", () => {
    const r = gtmLoadersFromDocument(
      docWith(["https://cdn.example.com/app.js", "https://secure.quantserve.com/quant.js"]),
    );
    expect(r.containerIds).toEqual([]);
  });

  it("skips malformed srcs rather than throwing", () => {
    const r = gtmLoadersFromDocument(docWith(["://////bad", ""]));
    expect(r.containerIds).toEqual([]);
  });
});

describe("dataLayerNamesFromGtmGlobal — a loader served from a first-party path (apparel-c.example)", () => {
  // apparel-c.example, 2026-09-25: Tag Manager loads from /fpx7k2/<token> with no query string, so no
  // loader URL names the dataLayer, and the array is storeClientDataLayer. The running
  // container reports the name on window.google_tag_manager.
  const apparelC = {
    google_tag_manager: {
      "GTM-XAPC100": { dataLayer: { name: "storeClientDataLayer" }, callback: () => undefined },
      "G-XAPC100000": { dataLayer: { name: "storeClientDataLayer" } },
      storeClientDataLayer: { gtmDom: true, gtmLoad: true },
      e: 3,
      rm: () => undefined,
    },
  };

  it("reads the name each running container reports, once", () => {
    expect(dataLayerNamesFromGtmGlobal(apparelC)).toEqual(["storeClientDataLayer"]);
  });

  it("returns nothing when no Google tag has run", () => {
    expect(dataLayerNamesFromGtmGlobal({})).toEqual([]);
    expect(dataLayerNamesFromGtmGlobal(null)).toEqual([]);
    expect(dataLayerNamesFromGtmGlobal({ google_tag_manager: 5 })).toEqual([]);
  });

  it("takes only names that can be globals, and survives entries that throw", () => {
    const hostile = {
      google_tag_manager: {
        "GTM-A": { dataLayer: { name: "not a name; alert(1)" } },
        "GTM-B": {
          get dataLayer(): never {
            throw new Error("getter");
          },
        },
        "GTM-C": { dataLayer: { name: "dl_2" } },
      },
    };
    expect(dataLayerNamesFromGtmGlobal(hostile)).toEqual(["dl_2"]);
  });
});

describe("findConfirmationNotice — evidence, not just a boolean", () => {
  it("returns the matched text with surrounding context", () => {
    const page =
      "Some header text here. We have processed your opt-out request for this browser. More footer text.";
    const m = findConfirmationNotice(page);
    expect(m).not.toBeNull();
    expect(m!.snippet).toContain("processed your opt-out");
    expect(typeof m!.patternIndex).toBe("number");
  });

  it("returns null when nothing matches", () => {
    expect(findConfirmationNotice("We value your privacy")).toBeNull();
    expect(findConfirmationNotice("")).toBeNull();
  });

  it("normalizes whitespace so the snippet is readable in a report", () => {
    const m = findConfirmationNotice("a\n\n   Opt-out request honored\t\tb");
    expect(m!.snippet).not.toMatch(/\s{2,}/);
  });

  it("agrees with the boolean helper", () => {
    for (const text of ["Opt-out request honored", "nothing here", ""]) {
      expect(matchesConfirmationNotice(text)).toBe(findConfirmationNotice(text) !== null);
    }
  });
});

describe("document.cookie parsing (FR-9)", () => {
  it("parses a typical analytics assignment", () => {
    const r = parseDocumentCookie("_ga=GA1.2.123; path=/; max-age=63072000", "example.com");
    expect(r?.name).toBe("_ga");
    expect(r?.value).toBe("GA1.2.123");
    expect(r?.attrs["path"]).toBe("/");
  });

  it("defaults the domain to the PAGE host, not a responding host", () => {
    // A script-written cookie with no Domain belongs to the page. A response cookie
    // defaults to the responder. Conflating them would misattribute the recipient.
    const r = parseDocumentCookie("x=1", "shop.example.com");
    expect(r?.attrs["domain"]).toBe("shop.example.com");
  });

  it("keeps an explicit domain over the page host", () => {
    const r = parseDocumentCookie("x=1; domain=.example.com", "shop.example.com");
    expect(r?.attrs["domain"]).toBe(".example.com");
  });

  it("records valueless attributes as present", () => {
    const r = parseDocumentCookie("x=1; Secure; Partitioned", "example.com");
    expect(r?.attrs["secure"]).toBe(true);
    expect(r?.attrs["partitioned"]).toBe(true);
  });

  it("returns null for assignments with no name", () => {
    expect(parseDocumentCookie("", "example.com")).toBeNull();
    expect(parseDocumentCookie("novalue", "example.com")).toBeNull();
    expect(parseDocumentCookie("=orphan", "example.com")).toBeNull();
  });

  it("handles a value containing '='", () => {
    const r = parseDocumentCookie("t=a=b=c; path=/", "example.com");
    expect(r?.value).toBe("a=b=c");
  });
});

/**
 * interceptDocumentCookie / interceptCookieStore (FR-9).
 *
 * These fakes stand in for a real Document/Window without pulling in jsdom. The document
 * fake is a three-level chain like a real page's: the instance, a middle prototype with no
 * `cookie` of its own (HTMLDocument.prototype) and the owner of the native accessor
 * (Document.prototype). `Document` does not exist in this project's Node test environment,
 * so the fake supplies its own configurable descriptor.
 */
function fakeDocument(initial = ""): {
  doc: Document;
  owner: Record<string, unknown>;
  middle: Record<string, unknown>;
  rawValue: () => string;
  nativeWrites: () => number;
} {
  let value = initial;
  let writes = 0;
  const owner: Record<string, unknown> = {};
  Object.defineProperty(owner, "cookie", {
    configurable: true,
    enumerable: true,
    get(): string {
      return value;
    },
    set(v: string): void {
      writes++;
      value = v;
    },
  });
  const middle = Object.create(owner) as Record<string, unknown>;
  return {
    doc: Object.create(middle) as Document,
    owner,
    middle,
    rawValue: () => value,
    nativeWrites: () => writes,
  };
}

/** A consent tool wrapping the property where it is owned, after we did (Osano, Transcend). */
function wrapLikeATool(owner: object, block: (v: string) => boolean = () => false, callsPerWrite = 1): string[] {
  const calls: string[] = [];
  const inner = Object.getOwnPropertyDescriptor(owner, "cookie")!;
  Object.defineProperty(owner, "cookie", {
    configurable: true,
    enumerable: true,
    get(this: Document): string {
      return inner.get!.call(this) as string;
    },
    set(this: Document, v: string): void {
      calls.push(v);
      if (block(v)) return;
      for (let i = 0; i < callsPerWrite; i++) inner.set!.call(this, v);
    },
  });
  return calls;
}

const microtask = (): Promise<void> => new Promise((r) => queueMicrotask(r));
/** Long enough for the task that made a write to have ended: its records are reported then. */
const taskEnded = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe("interceptDocumentCookie (FR-9)", () => {
  it("installs on the object that owns the property, not on the document's own prototype", () => {
    const { doc, owner, middle } = fakeDocument();
    const before = Object.getOwnPropertyDescriptor(owner, "cookie")!.set;
    expect(interceptDocumentCookie(doc, "example.com", () => {})).not.toBeNull();
    expect(Object.getOwnPropertyDescriptor(owner, "cookie")!.set).not.toBe(before);
    expect(Object.getOwnPropertyDescriptor(middle, "cookie")).toBeUndefined();
  });

  it("returns null, and touches nothing, when the property is not configurable", () => {
    const proto: Record<string, unknown> = {};
    Object.defineProperty(proto, "cookie", {
      configurable: false,
      enumerable: true,
      get: () => "",
      set: () => {},
    });
    const doc = Object.create(proto) as Document;
    expect(interceptDocumentCookie(doc, "example.com", () => {})).toBeNull();
  });

  it("returns null when nothing on the chain owns the property", () => {
    expect(interceptDocumentCookie(Object.create(null) as Document, "example.com", () => {})).toBeNull();
  });

  it("delegates to the original setter, so the page's write actually happens", () => {
    const { doc, rawValue } = fakeDocument();
    interceptDocumentCookie(doc, "example.com", () => {});
    doc.cookie = "a=1; path=/";
    expect(rawValue()).toBe("a=1; path=/");
    expect(doc.cookie).toBe("a=1; path=/");
  });

  it("reports a parsed record for each write", async () => {
    const { doc } = fakeDocument();
    const seen: JsCookieRecord[] = [];
    interceptDocumentCookie(doc, "shop.example.com", (c) => seen.push(c));
    doc.cookie = "_ga=GA1.2.1; path=/; max-age=63072000";
    await taskEnded();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.name).toBe("_ga");
    expect(seen[0]?.domain).toBe(".shop.example.com");
    expect(seen[0]?.via).toBe("documentCookie");
    expect(seen[0]?.wrapperScriptUrl).toBeNull();
  });

  it("records writerScriptUrl: null rather than guessing, when the stack resolves no URL", async () => {
    // A Node test stack has no http(s) frame at all, which is exactly the "attribution
    // unavailable" case the module's own comment describes (bundled code, inline script,
    // container-executed code). attributeCaller's own resolution logic is covered
    // separately; this confirms the cookie is still recorded rather than dropped.
    const { doc } = fakeDocument();
    let captured: { writerScriptUrl: string | null; viaTagManager: boolean } | undefined;
    interceptDocumentCookie(doc, "example.com", (c) => (captured = c));
    doc.cookie = "IDE=1";
    await taskEnded();
    expect(captured?.writerScriptUrl).toBeNull();
    expect(captured?.viaTagManager).toBe(false);
  });

  it("never blocks the write when the recorder throws", async () => {
    const { doc, rawValue } = fakeDocument();
    interceptDocumentCookie(doc, "example.com", () => {
      throw new Error("recorder exploded");
    });
    expect(() => (doc.cookie = "a=1")).not.toThrow();
    // The recorder runs when the run ends, and its throw goes nowhere.
    await taskEnded();
    expect(rawValue()).toBe("a=1");
  });

  it("never blocks the write when the stack capture throws", async () => {
    const { doc, rawValue } = fakeDocument();
    const seen: JsCookieRecord[] = [];
    interceptDocumentCookie(doc, "example.com", (c) => seen.push(c), {
      captureStack: () => {
        throw new Error("no stacks here");
      },
    });
    doc.cookie = "a=1";
    await taskEnded();
    expect(rawValue()).toBe("a=1");
    expect(seen[0]?.writerScriptUrl).toBeNull();
  });

  it("ignores a nameless assignment without calling the recorder", async () => {
    const { doc } = fakeDocument();
    const seen: unknown[] = [];
    interceptDocumentCookie(doc, "example.com", (c) => seen.push(c));
    doc.cookie = "";
    await taskEnded();
    expect(seen).toHaveLength(0);
  });

  it("records nothing when the browser refuses the write by throwing, and the page sees the throw", async () => {
    // A sandboxed frame's document.cookie setter throws SecurityError. Nothing was set.
    const owner: Record<string, unknown> = {};
    Object.defineProperty(owner, "cookie", {
      configurable: true,
      get: () => "",
      set: () => {
        throw new Error("SecurityError");
      },
    });
    const doc = Object.create(owner) as Document;
    const seen: unknown[] = [];
    interceptDocumentCookie(doc, "example.com", (c) => seen.push(c));
    expect(() => (doc.cookie = "a=1")).toThrow("SecurityError");
    await taskEnded();
    expect(seen).toHaveLength(0);
  });
});

describe("interceptDocumentCookie: behind a consent tool's wrapper", () => {
  it("a wrapper defined later on the owner is called first and calls ours once", async () => {
    const { doc, owner, rawValue, nativeWrites } = fakeDocument();
    const seen: JsCookieRecord[] = [];
    const interceptor = interceptDocumentCookie(doc, "example.com", (c) => seen.push(c))!;
    const toolCalls = wrapLikeATool(owner);
    doc.cookie = "a=1";
    await taskEnded();
    expect(toolCalls).toEqual(["a=1"]);
    expect(seen).toHaveLength(1);
    expect(nativeWrites()).toBe(1);
    expect(rawValue()).toBe("a=1");
    expect(interceptor.coverage).toEqual({ wrappedOver: true, onInstance: false });
  });

  it("a write the tool blocks never reaches us, and nothing is recorded", async () => {
    const { doc, owner, nativeWrites } = fakeDocument();
    const seen: JsCookieRecord[] = [];
    interceptDocumentCookie(doc, "example.com", (c) => seen.push(c));
    wrapLikeATool(owner, (v) => v.startsWith("__gpcdiag="));
    doc.cookie = "__gpcdiag=1; path=/; max-age=60";
    await taskEnded();
    expect(seen).toHaveLength(0);
    expect(nativeWrites()).toBe(0);
  });

  it("the page's write still lands through the tool when our recorder throws", async () => {
    const { doc, owner, rawValue } = fakeDocument();
    interceptDocumentCookie(doc, "example.com", () => {
      throw new Error("recorder exploded");
    });
    wrapLikeATool(owner);
    expect(() => (doc.cookie = "a=1")).not.toThrow();
    await taskEnded();
    expect(rawValue()).toBe("a=1");
  });

  it("sees a tool's own write made through the setter it saved, which a wrapper in front of the tool misses", async () => {
    const { doc, owner } = fakeDocument();
    const seen: JsCookieRecord[] = [];
    interceptDocumentCookie(doc, "example.com", (c) => seen.push(c));
    const saved = Object.getOwnPropertyDescriptor(owner, "cookie")!.set!;
    wrapLikeATool(owner);
    saved.call(doc, "osano_consentmanager=x");
    await taskEnded();
    expect(seen.map((c) => c.name)).toEqual(["osano_consentmanager"]);
  });

  it("flags a tool that defines the property on the document itself (Ketch)", async () => {
    const { doc, owner } = fakeDocument();
    const seen: JsCookieRecord[] = [];
    const interceptor = interceptDocumentCookie(doc, "example.com", (c) => seen.push(c))!;
    const ours = Object.getOwnPropertyDescriptor(owner, "cookie")!;
    Object.defineProperty(doc, "cookie", {
      configurable: true,
      get: () => ours.get!.call(doc),
      set: (v: string) => ours.set!.call(doc, v),
    });
    doc.cookie = "_swb=1";
    await taskEnded();
    expect(seen).toHaveLength(1);
    expect(interceptor.coverage).toEqual({ wrappedOver: false, onInstance: true });
  });

  it("flags a wrapper on a prototype between the document and the owner", () => {
    const { doc, middle } = fakeDocument();
    const interceptor = interceptDocumentCookie(doc, "example.com", () => {})!;
    Object.defineProperty(middle, "cookie", { configurable: true, get: () => "", set: () => {} });
    interceptor.rescan();
    expect(interceptor.coverage.wrappedOver).toBe(true);
  });

  it("reports a flag once, when it becomes true, and a re-scan with nothing new reports nothing", () => {
    const { doc, owner } = fakeDocument();
    const reports: unknown[] = [];
    const interceptor = interceptDocumentCookie(doc, "example.com", () => {}, { onCoverage: (c) => reports.push(c) })!;
    interceptor.rescan();
    expect(reports).toEqual([]);
    wrapLikeATool(owner);
    interceptor.rescan();
    interceptor.rescan();
    doc.cookie = "a=1";
    expect(reports).toEqual([{ wrappedOver: true, onInstance: false }]);
  });

  it("attributes through the tool's accessor to the writer beneath it, and records the tool", async () => {
    const { doc, owner } = fakeDocument();
    const seen: JsCookieRecord[] = [];
    interceptDocumentCookie(doc, "www.news-f.example", (c) => seen.push(c), {
      captureStack: () => STACKS.gtmSnippetViaInsertBefore,
    });
    wrapLikeATool(owner);
    doc.cookie = "nwf_byline=x; path=/";
    await taskEnded();
    expect(seen[0]?.writerScriptUrl).toBe(GTM_NF);
    expect(seen[0]?.viaTagManager).toBe(true);
    expect(seen[0]?.wrapperScriptUrl).toBe(OSANO_NWF);
  });

  it("does not step over anything while nothing is in front of us", async () => {
    const { doc } = fakeDocument();
    const seen: JsCookieRecord[] = [];
    interceptDocumentCookie(doc, "www.news-f.example", (c) => seen.push(c), {
      captureStack: () => STACKS.osanoPageWrite,
    });
    doc.cookie = "a=1";
    await taskEnded();
    expect(seen[0]?.writerScriptUrl).toBe(OSANO);
    expect(seen[0]?.wrapperScriptUrl).toBeNull();
  });
});

describe("interceptDocumentCookie: two-stage stack capture", () => {
  /** Osano's second call of the setter: ten of its own frames before the accessor. */
  const deepOsano = (held: number): string => {
    const frames = [
      ...Array.from({ length: 10 }, (_, i) => `    at f${i} (${OSANO}:1:${1000 + i})`),
      `    at HTMLDocument.set [as cookie] (${OSANO}:1:142245)`,
      `    at Object.At (${ARRAY_JS}:1:57608)`,
      `    at ${ARRAY_JS}:1:7534`,
    ];
    return ["Error", ...frames.slice(0, held)].join("\n");
  };

  it("takes the stack again at 32 frames when wrapped over and the tool's frames fill the first", async () => {
    const { doc, owner } = fakeDocument();
    const depths: number[] = [];
    const seen: JsCookieRecord[] = [];
    interceptDocumentCookie(doc, "example.com", (c) => seen.push(c), {
      captureStack: (frames) => {
        depths.push(frames);
        return deepOsano(frames);
      },
    });
    wrapLikeATool(owner);
    doc.cookie = "a=1";
    await taskEnded();
    expect(depths).toEqual([STACK_FRAMES, DEEP_STACK_FRAMES]);
    expect(seen[0]?.writerScriptUrl).toBe(ARRAY_JS);
  });

  it("does not take it again when not wrapped over, or when the first stack reaches past the tool", () => {
    const depths: number[] = [];
    const a = fakeDocument();
    interceptDocumentCookie(a.doc, "example.com", () => {}, {
      captureStack: (frames) => {
        depths.push(frames);
        return deepOsano(frames);
      },
    });
    a.doc.cookie = "a=1";
    const b = fakeDocument();
    interceptDocumentCookie(b.doc, "example.com", () => {}, {
      captureStack: (frames) => {
        depths.push(frames);
        return STACKS.osanoPageWrite;
      },
    });
    wrapLikeATool(b.owner);
    b.doc.cookie = "a=1";
    expect(depths).toEqual([STACK_FRAMES, STACK_FRAMES]);
  });

  it("wrapperFillsStack: every held frame one script, and as many as were asked for", () => {
    expect(wrapperFillsStack(deepOsano(10), 10)).toBe(true);
    expect(wrapperFillsStack(deepOsano(9), 10)).toBe(false);
    expect(wrapperFillsStack(deepOsano(12), 12)).toBe(false);
    expect(wrapperFillsStack(STACKS.osanoPageWrite, 5)).toBe(false);
  });
});

describe("interceptDocumentCookie: echo collapse", () => {
  /**
   * news-f.example, nwf_byline, Osano's second call of the setter for the same page write:
   * ten of its frames, its accessor at index 10, then the same chain as the first call.
   */
  const nwfBylineSecondCall = `Error
    at at (${OSANO_NWF}:2:126392)
    at vn.permitCookie (${OSANO_NWF}:2:151179)
    at ${OSANO_NWF}:2:148754
    at ${OSANO_NWF}:2:188776
    at ${OSANO_NWF}:2:172375
    at ${OSANO_NWF}:2:172375
    at ${OSANO_NWF}:2:111276
    at ${OSANO_NWF}:2:190310
    at ${OSANO_NWF}:2:1950
    at ${OSANO_NWF}:2:154579
    at HTMLDocument.set [as cookie] (${OSANO_NWF}:2:154657)
    at <anonymous>:1:244
    at <anonymous>:1:341
    at HTMLBodyElement.wrapper (chrome-extension://flmbkameaidppjbcfacmglfcdelannij/main-world-insertion.js:397:21)
    at HTMLBodyElement.value [as insertBefore] (${OSANO_NWF}:2:55844)
    at ${GTM_NF}:1016:429
    at OS (${GTM_NF}:1018:31)
    at Md.NS (${GTM_NF}:1015:92)
    at Md.<anonymous> (${GTM_NF}:393:187)`;
  /** ketch.com, the two __kla_off writes: one helper, two call sites beneath it. */
  const ketchKlaOff = [
    `Error
    at HTMLDocument.n (${KETCH_BLOCK}:1:27822)
    at t.setCookie (${KETCH_SDK}:2:1653886)
    at ${KETCH_SDK}:2:1686442
    at Generator.next (<anonymous>)
    at a (${KETCH_SDK}:2:1930714)`,
    `Error
    at HTMLDocument.n (${KETCH_BLOCK}:1:27822)
    at t.setCookie (${KETCH_SDK}:2:1653886)
    at ${KETCH_SDK}:2:1686700
    at ${KETCH_SDK}:2:1686730
    at a.trigger (${KETCH_SDK}:2:1650015)`,
  ];
  /** Frames held at the depth asked for, as V8 would cut them. */
  const cut = (stack: string, frames: number): string => stack.split("\n").slice(0, frames + 1).join("\n");

  it("drops Osano's second call of the setter: the chains agree as far as the first stack reaches", async () => {
    const { doc, owner, nativeWrites } = fakeDocument();
    const seen: JsCookieRecord[] = [];
    const depths: number[] = [];
    interceptDocumentCookie(doc, "www.news-f.example", (c) => seen.push(c), {
      captureStack: (frames) => {
        depths.push(frames);
        // The first call's stack, then the second call's: cut at 10, taken again at 32.
        return cut(depths.length === 1 ? STACKS.gtmSnippetViaInsertBefore : nwfBylineSecondCall, frames);
      },
    });
    wrapLikeATool(owner, () => false, 2);
    doc.cookie = "nwf_byline=x; path=/";
    await taskEnded();
    expect(nativeWrites()).toBe(2);
    expect(depths).toEqual([STACK_FRAMES, STACK_FRAMES, DEEP_STACK_FRAMES]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.writerScriptUrl).toBe(GTM_NF);
  });

  it("keeps two writes of the same cookie through one helper from two call sites (ketch.com)", async () => {
    const { doc, owner } = fakeDocument();
    const seen: JsCookieRecord[] = [];
    let i = 0;
    interceptDocumentCookie(doc, "www.ketch.com", (c) => seen.push(c), { captureStack: () => ketchKlaOff[i++ % 2] });
    const ours = Object.getOwnPropertyDescriptor(owner, "cookie")!;
    Object.defineProperty(doc, "cookie", {
      configurable: true,
      get: () => ours.get!.call(doc),
      set: (v: string) => ours.set!.call(doc, v),
    });
    doc.cookie = "__kla_off=true; path=/";
    doc.cookie = "__kla_off=true; path=/";
    await taskEnded();
    expect(seen.map((c) => c.writerScriptUrl)).toEqual([KETCH_SDK, KETCH_SDK]);
  });

  it("never drops a write while nothing is in front of us", async () => {
    const { doc } = fakeDocument();
    const seen: JsCookieRecord[] = [];
    interceptDocumentCookie(doc, "example.com", (c) => seen.push(c), { captureStack: () => STACKS.matherMl });
    doc.cookie = "a=1";
    doc.cookie = "a=1";
    await taskEnded();
    expect(seen).toHaveLength(2);
  });

  it("reports the same write again after the synchronous run ends", async () => {
    const { doc, owner } = fakeDocument();
    const seen: JsCookieRecord[] = [];
    interceptDocumentCookie(doc, "example.com", (c) => seen.push(c), {
      captureStack: () => STACKS.osanoPageWrite,
    });
    wrapLikeATool(owner);
    doc.cookie = "a=1";
    await microtask();
    doc.cookie = "a=1";
    await taskEnded();
    expect(seen).toHaveLength(2);
  });

  it("keeps two writes that differ in the assignment", async () => {
    const { doc, owner } = fakeDocument();
    const seen: JsCookieRecord[] = [];
    interceptDocumentCookie(doc, "example.com", (c) => seen.push(c), { captureStack: () => STACKS.osanoPageWrite });
    wrapLikeATool(owner, () => false, 2);
    doc.cookie = "a=1";
    doc.cookie = "a=2";
    await taskEnded();
    expect(seen.map((c) => c.value)).toEqual(["1", "2"]);
  });

  it("sameChain: agrees as far as both reach, and two empty chains agree", () => {
    expect(sameChain(["a", "b"], ["a", "b", "c"])).toBe(true);
    expect(sameChain(["a", "x"], ["a", "b", "c"])).toBe(false);
    expect(sameChain([], [])).toBe(true);
    expect(sameChain([], ["a"])).toBe(false);
  });
});

describe("interceptDocumentCookie: write tests and removals", () => {
  const GONE = "expires=Thu, 01 Jan 1970 00:00:00 GMT";
  const shape = (c: JsCookieRecord) => [c.name, c.domain, isRemoval(c), c.writeTest ?? false, c.present];
  const watch = (host = "www.example.com") => {
    const fake = fakeDocument();
    const seen: JsCookieRecord[] = [];
    interceptDocumentCookie(fake.doc, host, (c) => seen.push(c));
    return { ...fake, seen };
  };

  it("reports a cookie written and removed in one task as a write test, without the write", async () => {
    // A script testing the widest domain it may write to: set, read back, remove, before it
    // does anything else. Nothing can run in between, and no cookie is left.
    const { doc, seen } = watch();
    doc.cookie = "cto_tld_test=1; domain=.example.com; path=/";
    doc.cookie = `cto_tld_test=; domain=.example.com; path=/; ${GONE}`;
    expect(seen).toEqual([]);
    await taskEnded();
    expect(seen.map(shape)).toEqual([["cto_tld_test", ".example.com", true, true, true]]);
  });

  it("goes by the task and not by the time: a cookie removed in a later task is a write and a removal", async () => {
    // However soon the later task comes. A cookie that outlives the task that wrote it was
    // set.
    const { doc, seen } = watch();
    doc.cookie = "KCCH=YES; domain=.example.com; path=/";
    await taskEnded();
    doc.cookie = `KCCH=; domain=.example.com; path=/; ${GONE}`;
    await taskEnded();
    expect(seen.map(shape)).toEqual([
      ["KCCH", ".example.com", false, false, undefined],
      ["KCCH", ".example.com", true, false, true],
    ]);
  });

  it("is still one write test across an await: the promise callbacks of a task are the task", async () => {
    // A storage helper written with async functions sets, reads back and removes with an
    // await between each. Nothing but its own callbacks runs in between.
    const { doc, seen } = watch();
    doc.cookie = "AMP_TEST=1; domain=.example.com; path=/";
    await microtask();
    await microtask();
    doc.cookie = `AMP_TEST=; domain=.example.com; path=/; ${GONE}`;
    await taskEnded();
    expect(seen.map(shape)).toEqual([["AMP_TEST", ".example.com", true, true, true]]);
  });

  it("leaves out every write of the cookie the task made before removing it, and keeps one made after", async () => {
    const { doc, seen } = watch();
    doc.cookie = "t=1; path=/";
    doc.cookie = "t=2; path=/";
    doc.cookie = "t=; path=/; max-age=0";
    doc.cookie = "t=3; path=/";
    await taskEnded();
    expect(seen.map((c) => [c.value, isRemoval(c), c.writeTest ?? false])).toEqual([
      ["", true, true],
      ["3", false, false],
    ]);
  });

  it("matches by name and domain: a domain walk leaves the write it did not remove", async () => {
    const { doc, seen } = watch("shop.example.com");
    doc.cookie = "probe=1; domain=.example.com; path=/";
    doc.cookie = "probe=1; domain=.shop.example.com; path=/";
    doc.cookie = `probe=; domain=.example.com; path=/; ${GONE}`;
    await taskEnded();
    expect(seen.map(shape)).toEqual([
      ["probe", ".shop.example.com", false, false, undefined],
      ["probe", ".example.com", true, true, true],
    ]);
  });

  it("says a removal found no cookie of that name in the document", async () => {
    const { doc, seen } = watch();
    doc.cookie = `never_set=; path=/; ${GONE}`;
    await taskEnded();
    expect(seen.map(shape)).toEqual([["never_set", ".www.example.com", true, false, false]]);
  });

  it("reads the document's cookies before a removal only, and through the native getter", async () => {
    let reads = 0;
    let value = "";
    const owner: Record<string, unknown> = {};
    Object.defineProperty(owner, "cookie", {
      configurable: true,
      enumerable: true,
      get(): string {
        reads++;
        return value;
      },
      set(v: string): void {
        value = v;
      },
    });
    const doc = Object.create(owner) as Document;
    const seen: JsCookieRecord[] = [];
    interceptDocumentCookie(doc, "www.example.com", (c) => seen.push(c));
    doc.cookie = "a=1; path=/";
    doc.cookie = "b=2; path=/; max-age=3600";
    doc.cookie = "c=3; path=/; expires=Fri, 01 Jan 2100 00:00:00 GMT";
    expect(reads).toBe(0);
    await taskEnded();
    doc.cookie = "c=; path=/; max-age=0";
    expect(reads).toBe(1);
    await taskEnded();
    expect(seen.at(-1)?.present).toBe(true);
  });

  it("records a removal without it where the document's cookies cannot be read", async () => {
    const owner: Record<string, unknown> = {};
    Object.defineProperty(owner, "cookie", {
      configurable: true,
      get: () => {
        throw new Error("SecurityError");
      },
      set: () => {},
    });
    const doc = Object.create(owner) as Document;
    const seen: JsCookieRecord[] = [];
    interceptDocumentCookie(doc, "www.example.com", (c) => seen.push(c));
    expect(() => (doc.cookie = "a=; max-age=0")).not.toThrow();
    await taskEnded();
    expect(seen.map(shape)).toEqual([["a", ".www.example.com", true, false, undefined]]);
  });

  it("foldRun keeps the order of everything it keeps, and a removal with no write before it", () => {
    const rec = (name: string, expiresMs: number | "session", domain = ".example.com"): JsCookieRecord => ({
      name, value: "v", domain, path: "/", expiresMs, sameSite: "unspecified", secure: false, partitioned: false,
      writerScriptUrl: null, viaTagManager: false, wrapperScriptUrl: null, via: "documentCookie", timeMs: 1_000, frameHost: "www.example.com",
    });
    const run = [rec("a", "session"), rec("old", 0), rec("b", 2_000), rec("a", 0), rec("b", 0, ".other.example")];
    expect(foldRun(run).map((c) => [c.name, c.domain, c.writeTest ?? false])).toEqual([
      ["old", ".example.com", false],
      ["b", ".example.com", false],
      ["a", ".example.com", true],
      ["b", ".other.example", false],
    ]);
    expect(foldRun([])).toEqual([]);
  });

  it("cookieStringHolds matches a whole name, not a prefix of one", () => {
    expect(cookieStringHolds("_ga=GA1.2; _ga_ABC=GS1; uid=7", "_ga")).toBe(true);
    expect(cookieStringHolds("_ga_ABC=GS1; uid=7", "_ga")).toBe(false);
    expect(cookieStringHolds("", "uid")).toBe(false);
  });
});

describe("interceptCookieStore (FR-9)", () => {
  interface FakeCookieStore {
    set(...a: unknown[]): unknown;
    delete(...a: unknown[]): unknown;
  }

  function fakeWindowWithStore(impl: (op: string, ...a: unknown[]) => unknown): {
    win: Window & typeof globalThis;
    store: FakeCookieStore;
    proto: FakeCookieStore;
  } {
    // A class per test, so wrapping one test's prototype leaves the next test's alone.
    class Store {
      set(...a: unknown[]): unknown {
        return impl("set", ...a);
      }
      delete(...a: unknown[]): unknown {
        return impl("delete", ...a);
      }
    }
    const store = new Store();
    return { win: { cookieStore: store } as unknown as Window & typeof globalThis, store, proto: Store.prototype };
  }

  it("reports true when cookieStore does not exist on window: nothing to observe, not a failure", () => {
    // cookieStore exists only in secure contexts. Reporting false there would have the
    // popup say on every http:// page that JavaScript cookies could not be observed, with
    // document.cookie wrapped and reporting.
    const win = {} as Window & typeof globalThis;
    expect(interceptCookieStore(win, "example.com", () => {})).toBe(true);
  });

  it("reports false when cookieStore exists and set cannot be hooked", () => {
    const win = { cookieStore: {} } as unknown as Window & typeof globalThis;
    expect(interceptCookieStore(win, "example.com", () => {})).toBe(false);
  });

  it("hooks set and delete on the store itself, in front of the prototype, which it leaves alone", () => {
    const { win, store, proto } = fakeWindowWithStore(() => Promise.resolve());
    const before = { set: proto.set, delete: proto.delete };
    expect(interceptCookieStore(win, "example.com", () => {})).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(store, "set")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(store, "delete")).toBe(true);
    expect(proto.set).toBe(before.set);
    expect(proto.delete).toBe(before.delete);
  });

  it("still runs a wrapper put on the prototype after us, beneath us (airline-a.example's)", async () => {
    const native = vi.fn(() => Promise.resolve());
    const { win, store, proto } = fakeWindowWithStore(native);
    const seen: JsCookieRecord[] = [];
    interceptCookieStore(win, "example.com", (c) => seen.push(c));
    const inner = proto.set;
    const monitored: unknown[] = [];
    proto.set = function (this: unknown, ...a: unknown[]): unknown {
      monitored.push(a[0]);
      return inner.apply(this, a);
    };
    await store.set("__gads", "1");
    expect(monitored).toEqual(["__gads"]);
    expect(native).toHaveBeenCalledWith("set", "__gads", "1");
    expect(seen.map((c) => c.name)).toEqual(["__gads"]);
  });

  it("records nothing when a wrapper beneath us refuses the write by rejecting", async () => {
    const { win, store, proto } = fakeWindowWithStore(() => Promise.resolve());
    const seen: JsCookieRecord[] = [];
    interceptCookieStore(win, "example.com", (c) => seen.push(c));
    const inner = proto.set;
    proto.set = function (this: unknown, ...a: unknown[]): unknown {
      return a[0] === "blocked" ? Promise.reject(new TypeError("blocked")) : inner.apply(this, a);
    };
    await expect(store.set("blocked", "1") as Promise<void>).rejects.toThrow("blocked");
    await store.set("allowed", "1");
    await microtask();
    expect(seen.map((c) => c.name)).toEqual(["allowed"]);
  });

  it("wraps a method the store already owns in place", async () => {
    const own = vi.fn(() => Promise.resolve());
    const win = { cookieStore: { set: own } } as unknown as Window & typeof globalThis;
    const seen: JsCookieRecord[] = [];
    expect(interceptCookieStore(win, "example.com", (c) => seen.push(c))).toBe(true);
    await (win as unknown as { cookieStore: { set: (...a: unknown[]) => Promise<void> } }).cookieStore.set("sid", "1");
    expect(own).toHaveBeenCalledWith("sid", "1");
    expect(seen).toHaveLength(1);
  });

  it("delegates to the original set() with the (name, value) call form", async () => {
    const original = vi.fn(() => Promise.resolve());
    const { win, store } = fakeWindowWithStore(original);
    const seen: JsCookieRecord[] = [];
    interceptCookieStore(win, "example.com", (c) => seen.push(c));

    await store.set("sid", "abc");

    expect(original).toHaveBeenCalledWith("set", "sid", "abc");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.name).toBe("sid");
    expect(seen[0]?.value).toBe("abc");
    expect(seen[0]?.via).toBe("cookieStore");
  });

  it("delegates to the original set() with the options-object call form", async () => {
    const original = vi.fn(() => Promise.resolve());
    const { win, store } = fakeWindowWithStore(original);
    const seen: JsCookieRecord[] = [];
    interceptCookieStore(win, "example.com", (c) => seen.push(c));

    const opts = {
      name: "sid",
      value: "abc",
      domain: "shop.example.com",
      path: "/",
      sameSite: "Lax",
      partitioned: true,
    };
    await store.set(opts);

    expect(original).toHaveBeenCalledWith("set", opts);
    expect(seen[0]?.domain).toBe(".shop.example.com");
    expect(seen[0]?.sameSite).toBe("Lax");
    expect(seen[0]?.partitioned).toBe(true);
  });

  it("reports a set when its promise fulfills, not when it is called", async () => {
    let resolve!: () => void;
    const { win, store } = fakeWindowWithStore(() => new Promise<void>((r) => (resolve = r)));
    const seen: JsCookieRecord[] = [];
    interceptCookieStore(win, "example.com", (c) => seen.push(c));
    const p = store.set("sid", "abc") as Promise<void>;
    await microtask();
    expect(seen).toHaveLength(0);
    resolve();
    await p;
    expect(seen).toHaveLength(1);
  });

  it("reports nothing when the promise rejects: the browser refused the write", async () => {
    const { win, store } = fakeWindowWithStore(() => Promise.reject(new TypeError("refused")));
    const seen: JsCookieRecord[] = [];
    interceptCookieStore(win, "example.com", (c) => seen.push(c));
    await expect(store.set("sid", "abc") as Promise<void>).rejects.toThrow("refused");
    await microtask();
    expect(seen).toHaveLength(0);
  });

  it("returns the page's own promise, untouched", () => {
    const promise = Promise.resolve();
    const { win, store } = fakeWindowWithStore(() => promise);
    interceptCookieStore(win, "example.com", () => {});
    expect(store.set("a", "b")).toBe(promise);
  });

  it("records a delete as a deletion, in both call forms", async () => {
    const { win, store } = fakeWindowWithStore(() => Promise.resolve());
    const seen: JsCookieRecord[] = [];
    interceptCookieStore(win, "shop.example.com", (c) => seen.push(c));
    await store.delete("sid");
    await store.delete({ name: "_ga", domain: "example.com", path: "/" });
    expect(seen.map((c) => [c.name, c.domain, c.expiresMs, c.via])).toEqual([
      ["sid", ".shop.example.com", 0, "cookieStore"],
      ["_ga", ".example.com", 0, "cookieStore"],
    ]);
  });

  it("never blocks the call when the recorder throws", async () => {
    const { win, store } = fakeWindowWithStore(() => Promise.resolve("ok"));
    interceptCookieStore(win, "example.com", () => {
      throw new Error("boom");
    });
    await expect(store.set("a", "b") as Promise<string>).resolves.toBe("ok");
  });
});

describe("privacy strings taken from requests are checked first", () => {
  it("accepts well-formed strings", () => {
    expect(checkUspWire("1YNN")).toEqual({ kind: "valid", value: "1YNN" });
    expect(checkUspWire("1---")).toEqual({ kind: "valid", value: "1---" });
    expect(checkGppWire("DBABBg~BUUAAAGA.YA")).toEqual({ kind: "valid", value: "DBABBg~BUUAAAGA.YA" });
    expect(checkGppWire("DBABMA~CO5VTlWO5VTlWH1AAAENAwCwAIAAAAAAAIAAAAoAAAAA.YAAAAAAAAAA")?.kind).toBe("valid");
  });

  it("ignores an empty parameter", () => {
    // marketplace-c.example, 2026-09-22: `us_privacy=` showed as "string not readable".
    expect(checkUspWire("")).toBeNull();
    expect(checkGppWire("")).toBeNull();
    expect(checkGppWire(null)).toBeNull();
  });

  it("recognizes an unfilled template placeholder", () => {
    // news-b.example, 2026-09-22: gpp=[GPP] on cookie-sync URLs.
    for (const v of ["[GPP]", "{gpp}", "${GPP_STRING}", "%%GPP%%"]) {
      expect(checkGppWire(v)).toEqual({ kind: "invalid", value: v, placeholder: true });
    }
    expect(checkUspWire("[US_PRIVACY]")).toEqual({ kind: "invalid", value: "[US_PRIVACY]", placeholder: true });
  });

  it("marks anything else as invalid, not as a placeholder", () => {
    expect(checkUspWire("1YN")).toEqual({ kind: "invalid", value: "1YN", placeholder: false });
    expect(checkGppWire("hello")).toEqual({ kind: "invalid", value: "hello", placeholder: false });
  });

  it("keeps invalid values apart from the wire string, one record per value", () => {
    const bad = { kind: "invalid" as const, value: "[GPP]", placeholder: true };
    let gpp = withInvalidGppWire(null, bad, "s.seedtag.com");
    gpp = withInvalidGppWire(gpp, bad, "ssp.disqus.com");
    gpp = withInvalidGppWire(gpp, bad, "s.seedtag.com");
    expect(gpp.fromWire).toBeNull();
    expect(gpp.invalidWire).toEqual([{ value: "[GPP]", hosts: ["s.seedtag.com", "ssp.disqus.com"], placeholder: true }]);
  });

  it("caps the record: five values, five hosts each, 1,024 characters", () => {
    let usp: ReturnType<typeof withInvalidUspWire> | null = null;
    for (let i = 0; i < 8; i++) usp = withInvalidUspWire(usp, { kind: "invalid", value: `x${i}`, placeholder: false }, "a.example");
    expect(usp?.invalidWire).toHaveLength(5);
    let one: ReturnType<typeof withInvalidUspWire> | null = null;
    for (let i = 0; i < 8; i++) one = withInvalidUspWire(one, { kind: "invalid", value: "x", placeholder: false }, `h${i}.example`);
    expect(one?.invalidWire?.[0]?.hosts).toHaveLength(5);
    const long = withInvalidUspWire(null, { kind: "invalid", value: "x".repeat(5000), placeholder: false }, "a.example");
    expect(long.invalidWire?.[0]?.value).toHaveLength(1024);
  });

  it("records which host carried a valid wire string", () => {
    expect(mergeUsPrivacy(null, "wire", "1NNN", "sync.1rx.io")).toMatchObject({ fromWire: "1NNN", fromWireHost: "sync.1rx.io" });
    expect(mergeGppWire(null, "DBABBg~BUUAAACA.YA", "trc.taboola.com")).toMatchObject({ fromWireHost: "trc.taboola.com" });
  });
});

describe("TCF when GDPR does not apply", () => {
  it("records an answer of gdprApplies: false with no string", () => {
    // news-l.example, news-m.example and portal-a.example outside the EU. Not recorded, the row would say
    // "not present".
    expect(toTcfObservation({ tcString: "", gdprApplies: false })).toEqual({ tcString: "", gdprApplies: false, purposeConsents: {} });
  });

  it("still records nothing for a ping or a tool that has not answered", () => {
    expect(toTcfObservation({ tcString: "" })).toBeNull();
    expect(toTcfObservation({ gdprApplies: true })).toBeNull();
  });
});
