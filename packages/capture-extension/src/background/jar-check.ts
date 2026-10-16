// SPDX-License-Identifier: GPL-3.0-only
/**
 * Whether a cookie the capture recorded ended up in the browser's cookie jar (1.30.0).
 *
 * A write is recorded when it is made, and the browser can still decline to store it. Measured
 * 2026-09-30 (automation profile, six sites, 190 counted cookies): ten were never in the jar.
 * Eight broke a rule the browser applies to the cookie's attributes (a third-party cookie with
 * no SameSite, SameSite=None without Secure, a Lax cookie written in a cross-site frame), one
 * came on a response to a request sent without cookies (Google's `test_cookie` on an XHR),
 * and one named a domain its response's host could not set. The jar is the browser's own
 * record, so it answers all of them; it has no author, so the stack still names the writer.
 *
 * What it reads, and nothing more: the cookies of the name and domain a recorded write
 * named, in the store of the tab that made it. It never lists a site's jar. The value it
 * reads is compared with the values the page wrote and dropped.
 *
 * One check per cookie key and page: a key found in the jar is not checked again, and writes
 * of a key waiting for its check join that check. A check runs CHECK_DELAY_MS after the last
 * write joined it, so a response's cookies are stored by then.
 *
 * A removal of a cookie that was in the browser is checked the same way, on its own: the
 * browser can decline a removal as it can a set (a removal written from a cross-site frame
 * without the cookie's SameSite=None), and a removal can name another cookie of the same key
 * (a domain cookie of the host a host-only cookie was written on). The cookie is said to be
 * removed only when the jar no longer holds one of that name and domain.
 *
 * A cookie is not shown anywhere until its key's first check answers (see sw.ts, the keys
 * waiting in the cookie ledger), so every check ends by telling the worker: with the jar's
 * answer, or as a key that could not be checked.
 */

import { registrableDomain } from "@gpc-inspector/lists";
import type { JarState } from "@gpc-inspector/schema";

/** How long after a write its cookie is looked up. */
export const CHECK_DELAY_MS = 1_000;

/** A cookie as the jar lists it, the fields read. */
export interface JarCookie {
  readonly domain: string;
  readonly value: string;
}

/**
 * The jar's answer for a key, from the cookies it holds of that name: landed when one of the
 * key's domain holds a value the page wrote, not-stored when none of that domain is there,
 * unknown when one is there with another value (an older write's, or a later one the check
 * did not wait for).
 */
export function jarStateOf(found: readonly JarCookie[], domain: string, values: ReadonlySet<string>): JarState {
  const bare = bareDomain(domain);
  const same = found.filter((c) => bareDomain(c.domain) === bare);
  if (same.length === 0) return "not-stored";
  return same.some((c) => values.has(c.value)) ? "landed" : "unknown";
}

/**
 * One answer for a key looked up under several domains: landed when any holds a value the
 * page wrote, since one stored write is enough for the key to count; not-stored only when
 * none holds the name; unknown otherwise.
 */
export function combinedState(states: readonly JarState[]): JarState {
  if (states.includes("landed")) return "landed";
  if (states.includes("unknown")) return "unknown";
  return "not-stored";
}

/** A domain without its leading dot, lowercased: a host-only cookie and a domain one compare equal. */
export function bareDomain(domain: string): string {
  return domain.replace(/^\./, "").toLowerCase();
}

/** The page a write was made on: a partitioned cookie's partition is its site. */
export interface CheckedPage {
  /** The page's host. */
  readonly topSite: string;
  /** The page's scheme, "http" or "https": a partition key keeps it. */
  readonly scheme: string;
}

/** A recorded write, as a check reads it. */
export interface CheckedWrite {
  readonly name: string;
  /**
   * The domain to look it up under. A host-only script write is recorded with no domain, and
   * the caller gives the host of the frame that wrote it: looked up under "", no cookie in
   * the jar would match and every one would read as not stored.
   */
  readonly domain: string;
  readonly value: string;
  readonly partitioned: boolean;
}

/** The writes of a key under one domain, looked up there and answered for there. */
export interface DomainWrites {
  /** Whether a write here was partitioned: its lookup is then in the page's partition. */
  partitioned: boolean;
  /** The values written here, compared with the jar's and dropped with the check. */
  readonly values: Set<string>;
  /** The observations whose record of this key the domain's answer is written on. */
  readonly observationIds: Set<string>;
}

/** A key's check, waiting to run. */
export interface PendingCheck {
  readonly tabId: number;
  readonly key: string;
  readonly name: string;
  /** A removal's check: whether the jar still holds any cookie of the key, whatever its value. */
  readonly removal: boolean;
  /**
   * The key's writes by the domain they are looked up under. One for a domain cookie, whose
   * key names it. A host-only script write's key has no domain, so frames on different hosts
   * that write the same name share a key, and each host is looked up and answered for on its
   * own: looked up under the first host only, a refused write there would take a stored one
   * elsewhere out of the count, and answered once for all, a stored one elsewhere would mark
   * the refused one stored.
   */
  readonly domains: Map<string, DomainWrites>;
  readonly page: CheckedPage;
  /** The key's write count on the tab when the last write joined the check. */
  seq: number;
  dueAt: number;
}

/** One domain's answer, for the records written under it. */
export interface JarMark {
  readonly state: JarState;
  readonly observationIds: readonly string[];
}

/** A check's answer, as the worker applies it to the tab. */
export interface JarAnswer {
  readonly key: string;
  readonly name: string;
  /** A removal's answer: not-stored when the jar no longer holds the cookie, unknown when it does. */
  readonly removal: boolean;
  /** The key's own: what the count and the summaries go by (see combinedState). */
  readonly state: JarState;
  /** Each domain's answer, written on that domain's records. */
  readonly marks: readonly JarMark[];
  /**
   * The key's write count on the tab when the last write joined the check. A write of the
   * key after it, counted while the check ran, is not the answer's (see `isLatest`).
   */
  readonly seq: number;
}

/** The chrome.cookies calls a check makes: the tab's store, and one lookup by name and domain. */
export interface JarReader {
  storeOf(tabId: number): Promise<string | null>;
  lookup(query: { name: string; domain: string; storeId: string; topLevelSite?: string }): Promise<JarCookie[]>;
}

/**
 * The reader over chrome.cookies, as the worker found it when it started. Absent (the
 * permission missing), no store holds any tab and nothing is checked.
 */
export function chromeJar(api: typeof chrome.cookies | undefined = globalThis.chrome?.cookies): JarReader {
  return {
    async storeOf(tabId) {
      if (api === undefined) return null;
      const stores = await api.getAllCookieStores();
      return stores.find((s) => s.tabIds.includes(tabId))?.id ?? null;
    },
    async lookup({ name, domain, storeId, topLevelSite }) {
      if (api === undefined) return [];
      const details: chrome.cookies.GetAllDetails & { partitionKey?: { topLevelSite: string } } = { name, domain, storeId };
      if (topLevelSite !== undefined) details.partitionKey = { topLevelSite };
      const found = await api.getAll(details);
      return found.map((c) => ({ domain: c.domain, value: c.value }));
    },
  };
}

/**
 * The queue of checks, per tab and key. `apply` receives each tab's answers, and the keys
 * whose check could not be made: no cookie store holds the tab, or the lookup threw. Those
 * records stay unchecked.
 */
export class JarChecks {
  private readonly pending = new Map<string, PendingCheck>();
  /** Per tab and key, how many writes have been queued: what `isLatest` compares with. */
  private readonly writes = new Map<string, number>();
  /** Per tab, how many pages it has been forgotten for: a check in flight is one page's. */
  private readonly pages = new Map<number, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly reader: JarReader,
    private readonly apply: (tabId: number, answers: readonly JarAnswer[], unchecked: readonly string[]) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Queue a check of one recorded write, or join the key's check already waiting. A removal
   * (`removal`) joins the key's removal check, never its set's.
   */
  add(tabId: number, page: CheckedPage, key: string, observationId: string, cookie: CheckedWrite, removal = false): void {
    const id = checkId(tabId, key, removal);
    const dueAt = this.now() + CHECK_DELAY_MS;
    const seq = (this.writes.get(id) ?? 0) + 1;
    this.writes.set(id, seq);
    const held = this.pending.get(id) ?? { tabId, key, name: cookie.name, removal, domains: new Map<string, DomainWrites>(), page, seq, dueAt };
    // A removal compares no value: any cookie of the key the jar holds is one it did not remove.
    const values: string[] = removal ? [] : [cookie.value];
    const writes = held.domains.get(cookie.domain);
    if (writes !== undefined) {
      for (const v of values) writes.values.add(v);
      writes.observationIds.add(observationId);
      writes.partitioned ||= cookie.partitioned;
    } else {
      held.domains.set(cookie.domain, {
        partitioned: cookie.partitioned,
        values: new Set(values),
        observationIds: new Set([observationId]),
      });
    }
    held.seq = seq;
    held.dueAt = dueAt;
    this.pending.set(id, held);
    this.schedule();
  }

  /**
   * Drop a tab's waiting checks: a new page, or the tab closed. A check already reading the
   * jar is dropped when it answers, so nothing of the page before reaches the next one.
   */
  forgetTab(tabId: number): void {
    this.pages.set(tabId, (this.pages.get(tabId) ?? 0) + 1);
    for (const [id, p] of this.pending) if (p.tabId === tabId) this.pending.delete(id);
    const prefix = `${tabId}\u0000`;
    for (const id of this.writes.keys()) if (id.startsWith(prefix)) this.writes.delete(id);
  }

  /**
   * Whether an answer covers the key's last write on the tab. A write queued after its check
   * started was counted after the writes checked, and a not-stored answer taking the key out
   * of the count would take that write's count too; that write's own check answers for it.
   */
  isLatest(tabId: number, answer: JarAnswer): boolean {
    return (this.writes.get(checkId(tabId, answer.key, answer.removal)) ?? 0) <= answer.seq;
  }

  /** How many checks wait, for tests and the debug snapshot. */
  get size(): number {
    return this.pending.size;
  }

  private schedule(): void {
    if (this.timer !== null || this.pending.size === 0) return;
    const next = Math.min(...[...this.pending.values()].map((p) => p.dueAt));
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, Math.max(0, next - this.now()));
  }

  /** Run every check that is due, and apply the answers per tab. */
  async run(): Promise<void> {
    const at = this.now();
    const due = [...this.pending.entries()].filter(([, p]) => p.dueAt <= at);
    for (const [id] of due) this.pending.delete(id);
    this.schedule();
    const byTab = new Map<number, PendingCheck[]>();
    for (const [, p] of due) byTab.set(p.tabId, [...(byTab.get(p.tabId) ?? []), p]);
    await Promise.all(
      [...byTab].map(async ([tabId, checks]) => {
        const page = this.pages.get(tabId) ?? 0;
        const storeId = await this.reader.storeOf(tabId).catch(() => null);
        const answers = storeId === null ? checks.map(() => null) : await Promise.all(checks.map((p) => this.check(p, storeId)));
        const found = answers.filter((a): a is JarAnswer => a !== null);
        // A key written again meanwhile has a check of its own waiting, which reports for it.
        // A removal that could not be checked is not reported: nothing then says it is removed.
        const unchecked = checks
          .filter((p, i) => answers[i] === null && !p.removal && !this.pending.has(checkId(p.tabId, p.key, false)))
          .map((p) => p.key);
        if ((this.pages.get(tabId) ?? 0) !== page) return;
        if (found.length > 0 || unchecked.length > 0) this.apply(tabId, found, unchecked);
      }),
    );
  }

  private async check(p: PendingCheck, storeId: string): Promise<JarAnswer | null> {
    try {
      // A partitioned cookie is stored under the top-level site it was set on, scheme and all.
      const site = registrableDomain(p.page.topSite) || p.page.topSite;
      const marks = await Promise.all(
        [...p.domains].map(async ([domain, writes]): Promise<JarMark> => {
          const query = { name: p.name, domain: bareDomain(domain), storeId };
          const found = await this.reader.lookup(writes.partitioned ? { ...query, topLevelSite: `${p.page.scheme}://${site}` } : query);
          return { state: jarStateOf(found, domain, writes.values), observationIds: [...writes.observationIds] };
        }),
      );
      return { key: p.key, name: p.name, removal: p.removal, state: combinedState(marks.map((m) => m.state)), marks, seq: p.seq };
    } catch {
      return null;
    }
  }
}

/** A check's place in the queue: a key's removal is checked apart from its set. */
function checkId(tabId: number, key: string, removal: boolean): string {
  return removal ? `${tabId}\u0000${key}\u0000removal` : `${tabId}\u0000${key}`;
}
