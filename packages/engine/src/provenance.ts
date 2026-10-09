// SPDX-License-Identifier: GPL-3.0-only
/**
 * Provenance helpers: per-container facts derived from an ObservationSet.
 *
 * Two questions: "how many GPC checks did each container make", answered from evidence the
 * capture layer already records, and "which loaders inserted each script" (resolveLoaders).
 *
 * Nothing here decides a vendor's state; vendor-signal-check.ts does, from these answers.
 */

import type { ObservationSet, ScriptInsertion, ScriptInsertionLoader, LoaderIdentity } from "@gpc-inspector/schema";
import { callCount, containerIdentity, containerKey, entityCategoryKey, isTagManagerFrame, type ContainerIdentity } from "@gpc-inspector/schema";
import type { Classifier } from "./classifier.js";
import { gppCheckTest } from "./gpp-check.js";

export interface ContainerChecks {
  readonly identity: ContainerIdentity;
  /** The container frame URLs that resolved to this identity (one container, several loads). */
  readonly frameUrls: readonly string[];
  /** GPC checks counted under this container: __gpp checks (gppCheckTest) plus sampled reads. */
  readonly checks: number;
}

/**
 * The container of a list of container frames, innermost first: the innermost that names
 * an id, else the innermost. The rule `resolveLoaders` applies to an insertion's stack, and
 * the one every per-container count uses: a helper script's frame (which names no id)
 * inside a named container does not take the check away from it.
 */
export function innermostNamed(frameUrls: readonly string[]): string | undefined {
  for (const u of frameUrls) {
    const id = containerIdentity(u);
    if (id !== null && id.id !== null) return u;
  }
  return frameUrls[0];
}

/**
 * GPC checks per container, keyed by `containerKey`.
 *
 * A check is counted under the innermost container frame on its stack that names an id
 * (innermostNamed), which was the right container on every multi-container stack measured.
 * Only checks that resolved INTO a container count (`viaTagManager`), exactly the set the
 * page-wide `containerCallCount` is built from, so the per-container numbers sum to it. A
 * vendor's own call made from inside a container tag is that vendor's check, not the
 * container's, and stays with the vendor.
 *
 * Reads are a sample (schema ReadAttribution), so a count here is a lower bound and is
 * only ever tested against zero.
 *
 * A bundle recorded before 1.12.0 has container checks and no frame URLs to key them by,
 * and a frame can name a manager without naming a container (a Google helper script);
 * both land in one unnamed entry so the total is never silently lost.
 */
export function checksByContainer(obs: ObservationSet): ReadonlyMap<string, ContainerChecks> {
  const out = new Map<string, { identity: ContainerIdentity; frameUrls: Set<string>; checks: number }>();
  let unkeyed = 0;

  const add = (frameUrl: string | undefined, n: number): void => {
    const identity = frameUrl === undefined ? null : containerIdentity(frameUrl);
    // A manager frame that names no container (a Google helper, a loader with no id) is
    // real evidence of a container check and evidence of no container in particular; it
    // joins the unnamed entry rather than becoming a container of its own.
    if (frameUrl === undefined || identity === null || identity.id === null) {
      unkeyed += n;
      return;
    }
    const key = containerKey(identity);
    const entry = out.get(key) ?? { identity, frameUrls: new Set<string>(), checks: 0 };
    entry.frameUrls.add(frameUrl);
    entry.checks += n;
    out.set(key, entry);
  };

  const isGppCheck = gppCheckTest(obs);
  for (const call of obs.consentApiCalls) {
    if (!isGppCheck(call) || !call.viaTagManager) continue;
    add(innermostNamed(call.containerUrls ?? []) ?? call.callerScriptUrl ?? undefined, callCount(call));
  }

  const attribution = obs.signal.readAttribution;
  if (attribution) {
    const split = attribution.viaTagManagerByContainer;
    if (split) {
      for (const [url, n] of Object.entries(split)) add(url, n);
    } else {
      unkeyed += attribution.viaTagManager;
    }
  }

  const result = new Map<string, ContainerChecks>();
  for (const [key, e] of out) {
    result.set(key, { identity: e.identity, frameUrls: [...e.frameUrls].sort(), checks: e.checks });
  }
  if (unkeyed > 0) {
    const identity: ContainerIdentity = { manager: "google", id: null };
    result.set(containerKey(identity), { identity, frameUrls: [], checks: unkeyed });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Loader resolution
// ---------------------------------------------------------------------------

/** How many times a frame must lead a stack before it can be called a wrapper. */
const WRAPPER_MIN_RECORDS = 5;
/** Of all stacks with a named frame, the share one frame must lead. */
const WRAPPER_MIN_SHARE = 0.5;
/** Of the stacks it leads, the share that have another named frame beneath it. */
const WRAPPER_MIN_FOLLOWED = 0.6;
/** Transitive inheritance depth through other records. */
const INHERIT_DEPTH = 4;
/** Ancestor walk depth in the container graph. */
const ANCESTOR_DEPTH = 8;

export interface ProvenanceResolution {
  /**
   * Frames removed from every stack before resolution because they belong to another
   * wrapper of the insertion methods (a script-blocking CMP, an APM agent). Empty unless
   * the observer reported `wrappedOver`. Kept so a bundle reader can see what was skipped.
   */
  readonly wrapperFrames: readonly string[];
  /** Container graph: a container's parent, by `containerKey`. Roots are absent. */
  readonly parents: ReadonlyMap<string, ContainerIdentity>;
  /** Per record key, the loaders resolved; an empty array means undetermined. */
  readonly byKey: ReadonlyMap<string, readonly LoaderIdentity[]>;
  /**
   * Per company and category (`entityCategoryKey`), the loaders of every script that
   * classified to it, with `mixed` set on container entries when a non-container loader is
   * also present, and ancestors filled from the graph. A pair whose every record was
   * undetermined is absent; `undeterminedPairs` names it.
   */
  readonly byPair: ReadonlyMap<string, readonly LoaderIdentity[]>;
  /**
   * Pairs with at least one script record that resolved to nothing, whether or not
   * others resolved. The decision treats such a pair as undetermined: a loader we
   * could not see may be the one that mattered.
   */
  readonly undeterminedPairs: ReadonlySet<string>;
  /** Earliest insertion time per pair, for `checkedBeforeLoad`. */
  readonly firstInsertionByPair: ReadonlyMap<string, number>;
  /**
   * The same three, per registrable domain, for the scripts of third-party domains the list
   * names no company for (1.26.0): vendor-signal-check judges each such domain as it judges
   * a company in a category, and names who loaded it the same way.
   */
  readonly byDomain: ReadonlyMap<string, readonly LoaderIdentity[]>;
  readonly undeterminedDomains: ReadonlySet<string>;
  readonly firstInsertionByDomain: ReadonlyMap<string, number>;
  readonly checks: ReadonlyMap<string, ContainerChecks>;
}

/** The record key the capture would give a URL: query and hash off, container id kept. */
export function recordKeyOf(url: string): string {
  let end = url.length;
  const q = url.indexOf("?");
  if (q >= 0) end = q;
  const h = url.indexOf("#");
  if (h >= 0 && h < end) end = h;
  const base = url.slice(0, end);
  const id = containerIdentity(url);
  const key = id !== null && id.id !== null ? `${base}?id=${id.id}` : base;
  return key.length > 256 ? key.slice(0, 256) : key;
}

function identityKey(l: LoaderIdentity): string {
  switch (l.kind) {
    case "container":
      return `container:${containerKey(l.identity)}`;
    case "entity":
      return `entity:${l.name}:${l.category ?? ""}`;
    case "host":
      return `host:${l.domain}`;
    case "site":
      return `site:${l.url ?? ""}`;
  }
}

/**
 * Frames that belong to another wrapper of the insertion methods.
 *
 * Measured on real pages: a script-blocking CMP (Osano) and an APM agent (New Relic,
 * served first-party) replace appendChild after we do, so their frame sits directly
 * beneath ours on nearly every stack and would be credited with every insertion. Such a
 * frame leads most stacks AND is followed by a different named frame on most of them (the
 * real caller); a genuine loader that inserts many scripts leads its stacks alone. Only
 * looked for when the observer saw its own function replaced (`wrappedOver`), and never a
 * container frame, which is a loader by definition. Up to two rounds, for a CMP and an
 * agent on one page.
 */
function detectWrapperFrames(records: readonly ScriptInsertion[], wrappedOver: boolean): string[] {
  if (!wrappedOver) return [];
  const wrappers: string[] = [];
  for (let round = 0; round < 2; round++) {
    let total = 0;
    const leads = new Map<string, { count: number; followed: number }>();
    for (const r of records) {
      for (const l of r.loaders) {
        const frames = l.insertedBy.filter((f) => !wrappers.includes(f));
        if (frames.length === 0) continue;
        total++;
        const inner = frames[0]!;
        if (isTagManagerFrame(inner)) continue;
        const e = leads.get(inner) ?? { count: 0, followed: 0 };
        e.count++;
        if (frames.length > 1) e.followed++;
        leads.set(inner, e);
      }
    }
    let found: string | null = null;
    for (const [frame, e] of leads) {
      if (e.count >= WRAPPER_MIN_RECORDS && e.count / total >= WRAPPER_MIN_SHARE && e.followed / e.count >= WRAPPER_MIN_FOLLOWED) {
        found = frame;
        break;
      }
    }
    if (found === null) break;
    wrappers.push(found);
  }
  return wrappers;
}

/**
 * Resolve every insertion record to the loaders that inserted it, and roll the answers up
 * per entity. Pure over the ObservationSet; the classifier is the only outside input.
 *
 * Per loader entry, in order:
 *   1. a container frame on the stack: the innermost container that names an id;
 *   2. an inline-only stack resolved through currentScript: inherit that element's record;
 *   3. the innermost named frame: inherit its own record when it has one, else classify
 *      it (an entity of any category, a bare host, or the site's own file);
 *   4. a parser-inserted element: the site in the top frame, the frame's owner below it;
 *   5. otherwise undetermined.
 * Inheritance is transitive and depth-limited, which is what carries a container fact
 * from a loader to the scripts it inserts later from its own frames.
 */
export function resolveLoaders(obs: ObservationSet, classifier: Classifier): ProvenanceResolution {
  // Request initiators resolve by the same rules and roll up to the same entities,
  // so a pixel-only vendor gets a loader line. A request record whose key collides with
  // an insertion record's is the same URL fetched two ways; the insertion wins the key.
  const insertions = obs.scriptInsertions ?? [];
  const insertionKeys = new Set(insertions.map((r) => r.key));
  const records = [...insertions, ...(obs.requestInitiators ?? []).filter((r) => !insertionKeys.has(r.key))];
  const topSite = obs.context.topSite;
  const wrapperFrames = detectWrapperFrames(records, obs.scriptInsertionCoverage?.wrappedOver === true);
  const byKeyRecord = new Map<string, ScriptInsertion>();
  for (const r of records) byKeyRecord.set(r.key, r);

  const memo = new Map<string, LoaderIdentity[]>();
  const inProgress = new Set<string>();

  function classifyUrl(url: string): LoaderIdentity | null {
    let cls;
    try {
      cls = classifier.classify(url, topSite);
    } catch {
      return null;
    }
    if (cls.party === "first") return { kind: "site", url };
    if (cls.entity) return { kind: "entity", name: cls.entity.name, category: cls.category };
    return { kind: "host", domain: cls.registrableDomain };
  }

  function resolveEntry(record: ScriptInsertion, l: ScriptInsertionLoader, depth: number): LoaderIdentity[] {
    // 1. A container on the stack.
    if (l.containerUrls.length > 0) {
      let identity: ContainerIdentity | null = null;
      for (const u of l.containerUrls) {
        const id = containerIdentity(u);
        if (id !== null && id.id !== null) {
          identity = id;
          break;
        }
      }
      if (identity === null) {
        const first = containerIdentity(l.containerUrls[0]!);
        identity = first ?? { manager: "google", id: null };
      }
      return [{ kind: "container", identity, ancestors: [], mixed: false }];
    }
    // 2. Inline-only, resolved through currentScript.
    if (l.currentScriptKey !== null && l.currentScriptKey !== record.key) {
      const inherited = resolveRecord(l.currentScriptKey, depth + 1);
      if (inherited.length > 0) return inherited;
    }
    const frames = l.insertedBy.filter((f) => !wrapperFrames.includes(f));
    // 3. The innermost named frame: its own record, else its classification.
    if (frames.length > 0) {
      const inner = frames[0]!;
      const innerKey = recordKeyOf(inner);
      if (innerKey !== record.key && byKeyRecord.has(innerKey)) {
        const inherited = resolveRecord(innerKey, depth + 1);
        if (inherited.length > 0) return inherited;
      }
      const cls = classifyUrl(inner);
      return cls ? [cls] : [];
    }
    // 4. Parser-inserted: the site, or the sub-frame's owner.
    if (l.via === "parser") {
      if (l.topFrame) return [{ kind: "site", url: null }];
      const owner = l.frameOrigin ? classifyUrl(l.frameOrigin) : null;
      return owner ? [owner.kind === "site" ? { kind: "site", url: null } : owner] : [{ kind: "site", url: null }];
    }
    // 5. Undetermined.
    return [];
  }

  function resolveRecord(key: string, depth: number): LoaderIdentity[] {
    const known = memo.get(key);
    if (known) return known;
    if (depth > INHERIT_DEPTH || inProgress.has(key)) return [];
    const record = byKeyRecord.get(key);
    if (!record) return [];
    inProgress.add(key);
    const out: LoaderIdentity[] = [];
    const seen = new Set<string>();
    for (const l of record.loaders) {
      for (const id of resolveEntry(record, l, depth)) {
        const k = identityKey(id);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(id);
      }
    }
    inProgress.delete(key);
    memo.set(key, out);
    return out;
  }

  const byKey = new Map<string, LoaderIdentity[]>();
  for (const r of records) byKey.set(r.key, resolveRecord(r.key, 0));

  // The container graph: a container loader's record resolves to the container that
  // inserted it. Roots (inserted by the site, or parser-inserted) have no parent.
  const parents = new Map<string, ContainerIdentity>();
  for (const r of records) {
    const self = containerIdentity(r.key);
    if (self === null || self.id === null) continue;
    const selfKey = containerKey(self);
    for (const id of byKey.get(r.key) ?? []) {
      if (id.kind === "container" && id.identity.id !== null && containerKey(id.identity) !== selfKey) {
        parents.set(selfKey, id.identity);
        break;
      }
    }
  }
  function ancestorsOf(identity: ContainerIdentity): ContainerIdentity[] {
    const out: ContainerIdentity[] = [];
    const visited = new Set<string>([containerKey(identity)]);
    let cur = parents.get(containerKey(identity));
    while (cur && out.length < ANCESTOR_DEPTH) {
      const k = containerKey(cur);
      if (visited.has(k)) break;
      visited.add(k);
      out.push(cur);
      cur = parents.get(k);
    }
    return out;
  }
  const withAncestors = (id: LoaderIdentity, mixed: boolean): LoaderIdentity =>
    id.kind === "container" ? { ...id, ancestors: ancestorsOf(id.identity), mixed } : id;

  // Per company and category: every record whose URL classifies to it. Per registrable
  // domain, apart, every third-party record whose URL the list names no company for.
  const pairs = rollUp();
  const domains = rollUp();
  for (const r of records) {
    if (r.key.startsWith("inline:")) continue;
    let cls;
    try {
      cls = classifier.classify(r.url, topSite);
    } catch {
      continue;
    }
    if (cls.entity) pairs.add(entityCategoryKey(cls.entity.name, cls.category), r);
    else if (cls.party === "third") domains.add(cls.registrableDomain, r);
  }

  function rollUp() {
    const raw = new Map<string, Map<string, LoaderIdentity>>();
    const undetermined = new Set<string>();
    const firstInsertion = new Map<string, number>();
    return {
      undetermined,
      firstInsertion,
      add(unit: string, r: ScriptInsertion): void {
        for (const l of r.loaders) {
          const t = firstInsertion.get(unit);
          if (t === undefined || l.timeMs < t) firstInsertion.set(unit, l.timeMs);
        }
        const ids = byKey.get(r.key) ?? [];
        if (ids.length === 0) {
          undetermined.add(unit);
          return;
        }
        const set = raw.get(unit) ?? new Map<string, LoaderIdentity>();
        for (const id of ids) set.set(identityKey(id), id);
        raw.set(unit, set);
      },
      resolved(): Map<string, LoaderIdentity[]> {
        const out = new Map<string, LoaderIdentity[]>();
        for (const [unit, set] of raw) {
          const ids = [...set.values()];
          const mixed = ids.some((i) => i.kind === "container") && ids.some((i) => i.kind !== "container");
          out.set(unit, ids.map((i) => withAncestors(i, mixed)));
        }
        return out;
      },
    };
  }
  const finalByKey = new Map<string, LoaderIdentity[]>();
  for (const [k, ids] of byKey) finalByKey.set(k, ids.map((i) => withAncestors(i, false)));

  return {
    wrapperFrames,
    parents,
    byKey: finalByKey,
    byPair: pairs.resolved(),
    undeterminedPairs: pairs.undetermined,
    firstInsertionByPair: pairs.firstInsertion,
    byDomain: domains.resolved(),
    undeterminedDomains: domains.undetermined,
    firstInsertionByDomain: domains.firstInsertion,
    checks: checksByContainer(obs),
  };
}
