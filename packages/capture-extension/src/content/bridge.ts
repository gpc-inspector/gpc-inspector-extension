// SPDX-License-Identifier: GPL-3.0-only
/**
 * ISOLATED-world content script — the bridge.
 *
 * MAIN world can touch the page but not chrome.*; this one can touch chrome.* but not the
 * page's globals. DOM CustomEvents are the only channel both reach.
 *
 * Read counts are BATCHED: a page that polls navigator.globalPrivacyControl in a loop
 * would otherwise cause a message storm — one real news page produced 2,040 reads. We
 * coalesce on a short timer and flush on pagehide so counts survive navigation.
 */

import {
  STATE_EVENT,
  STATE_REQUEST_EVENT,
  READ_EVENT,
  OBSERVE_EVENT,
  type SignalStateDetail,
  type ObserveDetail,
} from "./protocol.js";
import type { SampledRead } from "../observe/read-attribution.js";
import { uspCookieFrom } from "../observe/consent-data.js";
import { acceptChannel } from "./channel.js";
import { ConsentRelay } from "./consent-relay.js";
import type { ConsentApiCall } from "@gpc-inspector/schema";

let pendingReads = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Attribution for the sampled minority of reads, accumulated alongside the count.
 *
 * Batched on the same timer for the same reason the count is: these arrive on the same hot
 * path. Kept as its own tally rather than folded into the count, because the two answer
 * different questions and only one of them is complete — `pendingReads` is every read,
 * `sampled` is the few we captured a stack for.
 */
interface PendingAttribution {
  sampled: number;
  unattributed: number;
  viaTagManager: number;
  /** The container reads split by container frame URL; sums to viaTagManager. */
  byContainer: Record<string, number>;
  byScript: Record<string, number>;
}

function emptyAttribution(): PendingAttribution {
  return { sampled: 0, unattributed: 0, viaTagManager: 0, byContainer: {}, byScript: {} };
}

let pendingAttribution = emptyAttribution();

/**
 * Script insertions, batched like reads: an ad-heavy page inserts in bursts, and the
 * record is a set rather than a payload that must arrive before navigation.
 */
let pendingInsertions: unknown[] = [];
let pendingRequests: unknown[] = [];
let insertionTimer: ReturnType<typeof setTimeout> | null = null;

function flushInsertions(): void {
  if (pendingInsertions.length > 0) {
    const records = pendingInsertions;
    pendingInsertions = [];
    send({ type: "script-insertions", records });
  }
  if (pendingRequests.length > 0) {
    const records = pendingRequests;
    pendingRequests = [];
    send({ type: "request-initiations", records });
  }
}

function scheduleInsertionFlush(): void {
  if (insertionTimer !== null) return;
  insertionTimer = setTimeout(() => {
    insertionTimer = null;
    flushInsertions();
  }, 250);
}

/** Consent-API calls and payloads, merged before they are sent (see consent-relay.ts). */
const consentRelay = new ConsentRelay();
let consentTimer: ReturnType<typeof setTimeout> | null = null;

function flushConsentRepeats(): void {
  for (const call of consentRelay.take()) send({ type: "consent-call", call });
}

function scheduleConsentFlush(): void {
  if (consentTimer !== null) return;
  consentTimer = setTimeout(() => {
    consentTimer = null;
    flushConsentRepeats();
  }, 250);
}
/**
 * The `usprivacy` cookie, US Privacy's page-side surface next to `__uspapi` (FR-13).
 * Without it the comparison of the page's string with what requests carried would be the
 * API's alone.
 *
 * Read here rather than in MAIN: this world's `document.cookie` is the browser's own
 * accessor, never the page's wrapper or capture's. Top frame only, since the cookie is the
 * site's first-party one and a frame's `document.cookie` is the frame's site. Read once at
 * document_start, which holds what an earlier visit left, and again whenever it may have
 * changed; sent only when the value did.
 */
const topFrame = window === window.top;
let lastUspCookie: string | null = null;

function readUspCookie(): void {
  if (!topFrame) return;
  let value: string | null;
  try {
    value = uspCookieFrom(document.cookie);
  } catch {
    return; // a sandboxed document throws on access; there is no cookie to read
  }
  if (value === null || value === lastUspCookie) return;
  lastUspCookie = value;
  send({ type: "usp", surface: "cookie", value });
}

/**
 * The last state relayed, so an unchanged repeat is not re-sent.
 *
 * Not a boolean that suppresses every report after the first: the first is guaranteed to
 * be wrong. Statically declared content scripts run before dynamically registered ones, so
 * main-world.js announces at document_start while the permission flag is still unset and
 * reports "none". Discarding the corrected re-announce would leave the popup saying the
 * signal is not set while the property is set correctly on the page.
 *
 * Deduplicating by VALUE rather than by count keeps the message volume down without
 * blocking a correction.
 */
let lastState: string | null = null;

/**
 * Count of messages that could not be delivered.
 *
 * An invalidated extension context (reload, update) makes every subsequent send throw. The
 * page keeps running and the content scripts keep observing, but nothing reaches the
 * worker — so the popup would show a stale record as though it were current. Counting the
 * failures lets a later successful send report that the record has a hole in it.
 */
let undelivered = 0;

function send(message: unknown): void {
  try {
    chrome.runtime.sendMessage(message);
    // A send that succeeds after failures is the first chance to report the gap.
    if (undelivered > 0) {
      const lost = undelivered;
      undelivered = 0;
      try {
        chrome.runtime.sendMessage({ type: "delivery-gap", lost });
      } catch {
        undelivered = lost; // still down; try again on the next successful send
      }
    }
  } catch {
    undelivered++;
  }
}

function flush(): void {
  if (pendingReads === 0) return;
  const count = pendingReads;
  pendingReads = 0;
  const attribution = pendingAttribution;
  pendingAttribution = emptyAttribution();
  // Omitted entirely when nothing was sampled, so the message is the bare count for any
  // reader that only cares about the count.
  if (attribution.sampled === 0) {
    send({ type: "signal-read", count });
    return;
  }
  send({ type: "signal-read", count, attribution });
}

// --- Everything from the MAIN world arrives on the private node (see channel.ts). ---
//
// Never on `document`: a page script can dispatch there under any name, and what it sent
// would be relayed as an observation of the page.

function listen(channel: EventTarget): void {
  // --- state: listener FIRST, then request, so we cannot miss MAIN's reply ---

  channel.addEventListener(STATE_EVENT, (e) => {
    const detail = (e as CustomEvent<SignalStateDetail>).detail;
    if (!detail) return;
    // `value` is part of the signature, not just the payload: the property can flip between
    // true and false with no change of source (the user toggles sending, and our accessor
    // answers the setting on the next read). Signing only on source would treat that
    // correction as a repeat and never relay it.
    const signature = `${detail.source}|${detail.readTracking}|${String(detail.value)}`;
    if (signature === lastState) return;
    lastState = signature;
    send({
      type: "signal-state",
      source: detail.source,
      readTracking: detail.readTracking,
      value: detail.value,
      topFrame: detail.topFrame,
    });
  });

  channel.addEventListener(READ_EVENT, (e) => {
    pendingReads++;

    // Present only on the sampled minority. Three buckets, kept apart on purpose: a read we
    // could name, a read that resolved to a tag-manager container (which names the container,
    // not the vendor whose code it ran), and a read we could not attribute at all. Collapsing
    // the last two would either credit the container's tags to nobody or invent a vendor.
    const sample = (e as CustomEvent<SampledRead>).detail;
    if (sample) {
      pendingAttribution.sampled++;
      if (sample.viaTagManager) {
        pendingAttribution.viaTagManager++;
        // Which container, not just that it was one. The URL's query carries the id.
        const key = sample.containerUrl ?? sample.url;
        if (key !== null) {
          pendingAttribution.byContainer[key] = (pendingAttribution.byContainer[key] ?? 0) + 1;
        }
      } else if (sample.url === null) pendingAttribution.unattributed++;
      else {
        pendingAttribution.byScript[sample.url] = (pendingAttribution.byScript[sample.url] ?? 0) + 1;
      }
    }

    if (flushTimer === null) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flush();
      }, 250);
    }
  });

  /**
   * Relay consent observations to the worker.
   *
   * The first of each is forwarded at once: buffering would risk losing the GPP payload on
   * a fast navigation, and that payload carries the flagship finding. A page can also call
   * its consent API thousands of times a second, so repeats of a call are merged and sent
   * on a short timer, and a payload equal to the last one is not sent again.
   */
  channel.addEventListener(OBSERVE_EVENT, (e) => {
    const d = (e as CustomEvent<ObserveDetail>).detail;
    if (!d) return;
    switch (d.kind) {
      case "consent-call": {
        const now = consentRelay.call(d.call as ConsentApiCall);
        if (now !== null) send({ type: "consent-call", call: now });
        else scheduleConsentFlush();
        break;
      }
      case "gpp":
        if (consentRelay.changed("gpp", d.gpp)) send({ type: "gpp", gpp: d.gpp });
        break;
      case "usp":
        if (consentRelay.changed("usp", d.value)) send({ type: "usp", surface: "api", value: d.value });
        break;
      case "tcf":
        if (consentRelay.changed("tcf", d.tcf)) send({ type: "tcf", tcf: d.tcf });
        break;
      case "gtm":
        send({ type: "gtm", gtm: d.gtm });
        break;
      case "js-cookie":
        send({ type: "js-cookie", cookie: d.cookie });
        // Read on the next turn: the write is reported from inside the setter, before the
        // browser has stored it.
        if ((d.cookie as { name?: unknown } | null)?.name === "usprivacy") setTimeout(readUspCookie, 0);
        break;
      case "cookie-coverage":
        send({ type: "cookie-coverage", coverage: d.coverage, topFrame: d.topFrame });
        break;
      case "capabilities":
        send({ type: "capabilities", capabilities: d.capabilities });
        break;
      case "read-trace-cap":
        send({ type: "read-trace-cap" });
        break;
      case "script-insertion":
        pendingInsertions.push(d.insertion);
        scheduleInsertionFlush();
        break;
      case "request-initiation":
        pendingRequests.push(d.request);
        scheduleInsertionFlush();
        break;
      case "request-initiation-coverage":
        flushInsertions();
        send({ type: "request-initiation-coverage", coverage: d.coverage, topFrame: d.topFrame });
        break;
      case "script-insertion-coverage":
        // Low volume (a handful per page) and it should follow the records it describes.
        flushInsertions();
        send({ type: "script-insertion-coverage", coverage: d.coverage, topFrame: d.topFrame });
        break;
      case "confirmation":
        send({
          type: "confirmation-notice",
          state: d.state,
          evidence: d.evidence,
          phrase: d.phrase,
          patternIndex: d.patternIndex,
          final: d.final,
        });
        break;
    }
  });

  // Ask MAIN for its state. If MAIN already pushed before we attached the listener above,
  // this request prompts a resend; if MAIN has not run yet, its own push will reach us.
  channel.dispatchEvent(new CustomEvent(STATE_REQUEST_EVENT));

  // Ask again on the next turn of the event loop. The permission script is registered
  // dynamically and runs after the statically declared ones, so the state at document_start
  // is knowably premature. MAIN announces again when permission arrives; this is the
  // backstop.
  setTimeout(() => channel.dispatchEvent(new CustomEvent(STATE_REQUEST_EVENT)), 0);
}

acceptChannel(document, listen);

readUspCookie();
// A response's Set-Cookie changes it without any script write, where the browser reports
// changes. Elsewhere the load event is the last look.
const cookieStore = (window as { cookieStore?: EventTarget }).cookieStore;
if (topFrame && cookieStore !== undefined) {
  cookieStore.addEventListener("change", (e) => {
    const { changed = [] } = e as Event & { changed?: readonly { name?: string }[] };
    if (changed.some((c) => c.name === "usprivacy")) readUspCookie();
  });
} else if (topFrame) {
  window.addEventListener("load", readUspCookie, { once: true });
}

// Never lose counts on navigation.
window.addEventListener("pagehide", () => {
  flush();
  flushInsertions();
  flushConsentRepeats();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    flush();
    flushInsertions();
    flushConsentRepeats();
  }
});
window.addEventListener("pageshow", (e) => {
  if (e.persisted) consentRelay.reset();
});

export {};
