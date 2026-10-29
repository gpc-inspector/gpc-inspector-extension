// SPDX-License-Identifier: GPL-3.0-only
/**
 * Consent-API observations, relayed without a message per call.
 *
 * A page can call its consent API in a tight loop: one page called `__uspapi` about
 * 230,000 times in fifteen seconds. Relayed one message a call, that kept the service
 * worker and the browser busy for seconds on every load of the page, and the page itself
 * loaded several times slower. The worker merges identical calls into one record with a
 * count anyway (consent-calls.ts), so the relay merges them first:
 *
 *   - The first call of each kind is sent at once, so a fast navigation cannot lose it.
 *   - Later calls of that kind are counted and sent as one merged record on the next flush.
 *   - A `usp`, `gpp` or `tcf` payload equal to the last one of its kind is not sent again.
 *     The worker's merge keeps nothing from an identical repeat, and a different payload
 *     in between is sent, so the order the worker sees is unchanged.
 */

import type { ConsentApiCall } from "@gpc-inspector/schema";
import { consentCallKey } from "../background/consent-calls.js";

interface HeldRepeats {
  readonly call: ConsentApiCall;
  count: number;
  lastTimeMs: number;
}

export class ConsentRelay {
  /** Kinds of call already sent once, by consentCallKey. */
  private readonly sent = new Set<string>();
  private held = new Map<string, HeldRepeats>();
  private readonly lastPayload = new Map<string, string>();

  /** The call to send now, or null when it was held as a repeat for the next flush. */
  call(call: ConsentApiCall): ConsentApiCall | null {
    const key = consentCallKey(call);
    if (!this.sent.has(key)) {
      this.sent.add(key);
      return call;
    }
    const at = call.lastTimeMs ?? call.timeMs;
    const n = call.count ?? 1;
    const held = this.held.get(key);
    if (held === undefined) this.held.set(key, { call, count: n, lastTimeMs: at });
    else {
      held.count += n;
      if (at > held.lastTimeMs) held.lastTimeMs = at;
    }
    return null;
  }

  /** Whether repeats are waiting for a flush. */
  get holding(): boolean {
    return this.held.size > 0;
  }

  /** The held repeats, one merged record per kind of call, and nothing held after. */
  take(): ConsentApiCall[] {
    const out = [...this.held.values()].map((h) => ({ ...h.call, count: h.count, lastTimeMs: h.lastTimeMs }));
    this.held = new Map();
    return out;
  }

  /**
   * Whether a payload differs from the last one of its kind, recording it when it does.
   * A payload that cannot be compared counts as changed, so it is sent.
   */
  changed(kind: "usp" | "gpp" | "tcf", payload: unknown): boolean {
    let signature: string;
    try {
      signature = JSON.stringify(payload) ?? "";
    } catch {
      return true;
    }
    if (this.lastPayload.get(kind) === signature) return false;
    this.lastPayload.set(kind, signature);
    return true;
  }

  /**
   * Forget what was sent. A page restored from the back-forward cache may face a worker
   * record that no longer holds what this page sent, so it sends again from the start.
   */
  reset(): void {
    this.sent.clear();
    this.lastPayload.clear();
  }
}
