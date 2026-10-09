// SPDX-License-Identifier: GPL-3.0-only
/**
 * A minimal fake of the chrome extension APIs, for testing WIRING.
 *
 * A unit test calls functions directly, which leaves one whole class of defect invisible:
 * whether the pieces reach each other. Defects of that kind include
 *
 *   - a message guard that requires `sender.tab` and silently drops every popup message,
 *   - a one-shot flag in the bridge that discards the corrected signal state,
 *   - a permission flag read once at startup, before the script that sets it has run,
 *   - a policy that re-applies only at install and startup, never on change.
 *
 * Each is visible in the source and passes every unit test, because a unit test asks
 * whether a function behaves when called and never asks whether it is called.
 *
 * This fake is deliberately small. It models message passing, storage, and the handful of
 * APIs the worker touches, enough to assert "the popup asks and the worker answers".
 */

export interface FakeSender {
  tab?: { id: number };
  frameId?: number;
  documentId?: string;
  documentLifecycle?: string;
}

/** The document a content-script message came from, as Chrome reports it on the sender. */
export type FakeDocument = Pick<FakeSender, "frameId" | "documentId" | "documentLifecycle">;

/**
 * Where a navigation or request event says it came from. A prerendered page's events carry
 * its own frame ids and `documentLifecycle: "prerender"`.
 */
export interface FakeFrame {
  parentFrameId?: number;
  documentLifecycle?: string;
}

/** A webNavigation.onBeforeNavigate event. */
export interface FakeNavigation extends FakeFrame {
  tabId: number;
  frameId: number;
  url: string;
}

/** A webNavigation.onCommitted event. */
export interface FakeCommit extends FakeNavigation {
  documentId?: string;
  parentDocumentId?: string;
}

type MessageListener = (
  message: unknown,
  sender: FakeSender,
  sendResponse: (response?: unknown) => void,
) => boolean | undefined;

export interface FakeChrome {
  /** Deliver a message as the POPUP would: no sender.tab. */
  sendFromPopup(message: unknown): Promise<unknown>;
  /** Deliver a message as a CONTENT SCRIPT would: sender.tab present. */
  sendFromTab(tabId: number, message: unknown, from?: FakeDocument): Promise<unknown>;
  /**
   * Everything currently in session storage, for assertions, with each tab's record parsed:
   * the worker writes it as a JSON string, and assertions read its fields.
   */
  sessionStore(): Record<string, unknown>;
  /** Session storage as stored, each tab's record the string the worker wrote. */
  rawSessionStore(): Record<string, unknown>;
  /** What session storage holds against the quota, counted as setSessionQuota counts it. */
  sessionBytes(): number;
  localStore(): Record<string, unknown>;
  /** Dynamic rules currently installed. */
  dynamicRules(): { id: number }[];
  /** Content scripts currently registered. */
  registeredScripts(): { id: string }[];
  /** Every chrome.action.setIcon call, in order: the per-tab icon state as the worker set it. */
  iconCalls(): { tabId?: number; state: "on" | "off" }[];
  /** Every chrome.action.setTitle call, in order. getMessage returns the key, so a title is its key. */
  titleCalls(): { tabId?: number; title: string }[];
  /** Make updateDynamicRules drop every rule it is asked to add, as a browser refusing it would. */
  refuseRules(refuse: boolean): void;
  /** Fire runtime.onInstalled as Chrome would, and wait for the worker's handler to settle. */
  fireInstalled(details: { reason: "install" | "update"; previousVersion?: string }): Promise<void>;
  /** Fire webNavigation.onBeforeNavigate, as a top-level navigation would. */
  fireBeforeNavigate(details: FakeNavigation): Promise<void>;
  /** Fire webNavigation.onCommitted, for a top-level document or a frame. */
  fireCommitted(details: FakeCommit): Promise<void>;
  /** Fire webNavigation.onCompleted, as a document that finished loading would. */
  fireCompleted(details: { tabId: number; frameId: number; url: string }): Promise<void>;
  /** Fire webNavigation.onErrorOccurred, as a navigation that failed (or stopped) would. */
  fireNavigationError(details: { tabId: number; frameId: number; url: string; error: string }): Promise<void>;
  /** Put state in place as an earlier version left it: sync storage and dynamic rules. */
  seedSync(items: Record<string, unknown>): void;
  seedDynamicRules(seeded: { id: number }[]): void;
  syncStore(): Record<string, unknown>;
  /**
   * Cap session storage at this many bytes of JSON, as Chrome's QUOTA_BYTES does; a set()
   * that would exceed it rejects and leaves the store unchanged. null lifts the cap.
   */
  setSessionQuota(bytes: number | null): void;
  /** Reject every session set() with this message, as an unavailable store would. null stops. */
  failSessionWrites(message: string | null): void;
  /** Delay every session set() by this long, so a write can still be in flight. */
  setSessionWriteDelay(ms: number): void;
  /** How many session set() calls the worker has made. */
  sessionSetCount(): number;
  /** How many session get() calls read the whole store (get(null)). */
  sessionFullReadCount(): number;
  /** Put a key in session storage directly, as an earlier write would have left it. */
  seedSession(items: Record<string, unknown>): void;
  /** The tab ids chrome.tabs.query({}) reports as open. */
  setOpenTabs(ids: number[]): void;
  /** The URL chrome.tabs.get reports for a tab; a tab never set reports none. Every tab reports its load complete. */
  setTabUrl(tabId: number, url: string): void;
  /** How many times the worker has called chrome.tabs.get. */
  tabGetCount(): number;
  /** Fire tabs.onRemoved, and wait for the worker's handler to settle. */
  fireTabRemoved(tabId: number): Promise<void>;
  /** Fire webRequest.onSendHeaders, as a request leaving the page would. */
  fireSendHeaders(details: FakeRequest): Promise<void>;
  /** Fire webRequest.onHeadersReceived, as its response arriving would. */
  fireHeadersReceived(details: FakeResponse): Promise<void>;
  /**
   * Drop every listener the loaded worker registered and cancel its timers, keeping the
   * stores: what Chrome does when it reclaims an idle worker. Import the worker again to
   * start the next instance.
   */
  reclaimWorker(): void;
  /**
   * The cookie jar chrome.cookies reads, one store holding every tab (1.30.0). null, the
   * default, is a browser whose jar the worker cannot read: no store holds the tab, so no
   * check answers, and a check left from another test's worker answers nothing either.
   */
  setJar(cookies: FakeJarCookie[] | null): void;
  /** Every chrome.cookies.getAll call the worker made, in order. */
  jarLookups(): Record<string, unknown>[];
  /** Reset everything, as a fresh worker would see it. */
  reset(): void;
}

export interface FakeJarCookie {
  name: string;
  domain: string;
  value: string;
  /** The partition's top-level site, for a partitioned cookie. */
  topLevelSite?: string;
}

export interface FakeRequest extends FakeFrame {
  frameId?: number;
  documentId?: string;
  tabId: number;
  requestId: string;
  url: string;
  type: string;
  method?: string;
  timeStamp?: number;
  requestHeaders?: { name: string; value?: string }[];
}

export interface FakeResponse extends FakeFrame {
  frameId?: number;
  documentId?: string;
  tabId: number;
  requestId: string;
  url: string;
  statusCode: number;
  responseHeaders?: { name: string; value?: string }[];
  /** As Chrome sends with every response; defaulted when a test does not care. */
  type?: string;
  method?: string;
  timeStamp?: number;
}

export function installFakeChrome(): FakeChrome {
  // Every setTimeout scheduled through THIS fake's message delivery, so reset() can cancel
  // them outright. Without this, a pending timer from one test's worker instance can fire
  // after the next test has installed a fresh fake and loaded a fresh worker module —
  // observed as an intermittent 10-second timeout on a test that is solid in isolation.
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  const icons: { tabId?: number; state: "on" | "off" }[] = [];
  const titles: { tabId?: number; title: string }[] = [];
  let rulesRefused = false;
  const scheduledTimeout = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const id = setTimeout(() => {
      pendingTimers.delete(id);
      fn();
    }, ms);
    pendingTimers.add(id);
    return id;
  };

  const messageListeners: MessageListener[] = [];
  const storageChangeListeners: ((
    changes: Record<string, { newValue?: unknown }>,
    area: string,
  ) => void)[] = [];
  let session: Record<string, unknown> = {};
  let jar: FakeJarCookie[] | null = null;
  const lookups: Record<string, unknown>[] = [];
  let local: Record<string, unknown> = {};
  let sync: Record<string, unknown> = {};
  const installedListeners: ((details: { reason: string; previousVersion?: string }) => void)[] =
    [];
  const committedListeners: ((d: FakeCommit) => void)[] = [];
  const completedListeners: ((d: { tabId: number; frameId: number; url: string }) => void)[] = [];
  const navigationErrorListeners: ((d: { tabId: number; frameId: number; url: string; error: string }) => void)[] =
    [];
  const beforeNavigateListeners: ((d: FakeNavigation) => void)[] =
    [];
  let rules: { id: number }[] = [];
  let scripts: { id: string }[] = [];
  let sessionQuota: number | null = null;
  let sessionFailure: string | null = null;
  let sessionWriteDelay = 0;
  let sessionSets = 0;
  let sessionFullReads = 0;
  let openTabs: number[] = [];
  const tabUrls = new Map<number, string>();
  let tabGets = 0;
  const removedListeners: ((tabId: number) => void)[] = [];
  const sendHeadersListeners: ((d: FakeRequest & { method: string; timeStamp: number }) => void)[] = [];
  const headersReceivedListeners: ((d: FakeResponse) => void)[] = [];
  const beforeRedirectListeners: unknown[] = [];
  // As Chrome counts toward the quota: each key, and each value's JSON length, a string at
  // its own length (measured 2026-09-30). Chrome counts a nested object at three to four
  // times its JSON length; this counts it at one, so a test here under-counts objects.
  const bytesOf = (store: Record<string, unknown>): number =>
    Object.entries(store).reduce((n, [k, v]) => n + k.length + (typeof v === "string" ? v.length : JSON.stringify(v).length), 0);

  const area = (get: () => Record<string, unknown>, set: (v: Record<string, unknown>) => void,
                name: string) => ({
    // Copies in and out, as Chrome serializes: the worker keeps a working copy of each tab's
    // state, and a store holding references to it would show changes that were never written.
    async get(key?: string | string[] | null) {
      const store = get();
      if (key === null || key === undefined) {
        if (name === "session") sessionFullReads += 1;
        return structuredClone(store);
      }
      const out: Record<string, unknown> = {};
      for (const k of Array.isArray(key) ? key : [key]) if (k in store) out[k] = store[k];
      return structuredClone(out);
    },
    async set(given: Record<string, unknown>) {
      if (name === "session") sessionSets += 1;
      const items = structuredClone(given);
      if (name === "session" && sessionWriteDelay > 0) {
        await new Promise((r) => scheduledTimeout(() => r(undefined), sessionWriteDelay));
      }
      if (name === "session" && sessionFailure !== null) throw new Error(sessionFailure);
      const next = { ...get(), ...items };
      if (name === "session" && sessionQuota !== null && bytesOf(next) > sessionQuota) {
        throw new Error("Session storage quota bytes exceeded. Values were not stored.");
      }
      set(next);
      const changes: Record<string, { newValue?: unknown }> = {};
      for (const [k, v] of Object.entries(items)) changes[k] = { newValue: v };
      for (const l of storageChangeListeners) l(changes, name);
    },
    async remove(keys: string | string[]) {
      const store = { ...get() };
      for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
      set(store);
    },
    async clear() {
      set({});
    },
    async getBytesInUse() {
      return bytesOf(get());
    },
    QUOTA_BYTES: 10 * 1024 * 1024,
  });

  const fake = {
    runtime: {
      id: "fake-extension",
      getManifest: () => ({ version: "1.0.0" }),
      onMessage: {
        addListener: (l: MessageListener) => void messageListeners.push(l),
      },
      onInstalled: {
        addListener: (l: (details: { reason: string; previousVersion?: string }) => void) =>
          void installedListeners.push(l),
      },
      onStartup: { addListener: () => undefined },
      sendMessage: async () => undefined,
    },
    storage: {
      session: area(() => session, (v) => (session = v), "session"),
      local: area(() => local, (v) => (local = v), "local"),
      sync: area(() => sync, (v) => (sync = v), "sync"),
      onChanged: {
        addListener: (l: (c: Record<string, { newValue?: unknown }>, a: string) => void) =>
          void storageChangeListeners.push(l),
      },
    },
    declarativeNetRequest: {
      async updateDynamicRules(opts: { removeRuleIds?: number[]; addRules?: { id: number }[] }) {
        if (opts.removeRuleIds) rules = rules.filter((r) => !opts.removeRuleIds?.includes(r.id));
        if (opts.addRules && !rulesRefused) rules = [...rules, ...opts.addRules];
      },
      async getDynamicRules() {
        return rules;
      },
    },
    scripting: {
      async getRegisteredContentScripts(filter?: { ids?: string[] }) {
        return filter?.ids ? scripts.filter((s) => filter.ids?.includes(s.id)) : scripts;
      },
      async registerContentScripts(items: { id: string }[]) {
        scripts = [...scripts, ...items];
      },
      async unregisterContentScripts(filter: { ids: string[] }) {
        scripts = scripts.filter((s) => !filter.ids.includes(s.id));
      },
      async updateContentScripts(items: { id: string }[]) {
        scripts = scripts.map((s) => ({ ...s, ...items.find((i) => i.id === s.id) }));
      },
    },
    webRequest: {
      onSendHeaders: {
        addListener: (l: (d: FakeRequest & { method: string; timeStamp: number }) => void) => void sendHeadersListeners.push(l),
      },
      onHeadersReceived: { addListener: (l: (d: FakeResponse) => void) => void headersReceivedListeners.push(l) },
      // Registered by the published-file check around each of its own requests, and never
      // fired: a stubbed fetch does not redirect. well-known.test.ts covers the redirects.
      onBeforeRedirect: {
        addListener: (l: unknown) => void beforeRedirectListeners.push(l),
        removeListener: (l: unknown) => {
          const at = beforeRedirectListeners.indexOf(l);
          if (at >= 0) beforeRedirectListeners.splice(at, 1);
        },
      },
    },
    webNavigation: {
      onBeforeNavigate: {
        addListener: (l: (d: { tabId: number; frameId: number; url: string }) => void) =>
          void beforeNavigateListeners.push(l),
      },
      onCommitted: { addListener: (l: (d: FakeCommit) => void) => void committedListeners.push(l) },
      onCompleted: {
        addListener: (l: (d: { tabId: number; frameId: number; url: string }) => void) =>
          void completedListeners.push(l),
      },
      onErrorOccurred: {
        addListener: (l: (d: { tabId: number; frameId: number; url: string; error: string }) => void) =>
          void navigationErrorListeners.push(l),
      },
    },
    tabs: {
      onRemoved: { addListener: (l: (tabId: number) => void) => void removedListeners.push(l) },
      async query() {
        return openTabs.map((id) => ({ id }));
      },
      async get(tabId: number) {
        tabGets++;
        return { url: tabUrls.get(tabId) ?? "", status: "complete" };
      },
    },
    action: {
      async setBadgeText() {
        /* no-op */
      },
      async setBadgeBackgroundColor() {
        /* no-op */
      },
      async setTitle(details: { tabId?: number; title: string }) {
        titles.push(details.tabId === undefined ? { title: details.title } : { tabId: details.tabId, title: details.title });
      },
      async setIcon(details: { tabId?: number; path: Record<string, string> }) {
        // Reduce the path map to its state so tests assert on meaning, not file names.
        const state = /gpc-(on|off)-/.exec(details.path["16"] ?? "")?.[1] as "on" | "off";
        icons.push(details.tabId === undefined ? { state } : { tabId: details.tabId, state });
      },
    },
    i18n: { getMessage: (k: string) => k },
    cookies: {
      async getAllCookieStores() {
        // One store, and every tab in it: no test here opens an incognito window.
        return jar === null ? [] : [{ id: "0", tabIds: Object.assign([] as number[], { includes: () => true }) }];
      },
      // As Chrome filters: the name exactly, the domain or any subdomain of it, and the
      // partition when one is given (unpartitioned cookies only when none is).
      async getAll(details: { name?: string; domain?: string; storeId?: string; partitionKey?: { topLevelSite?: string } }) {
        lookups.push({ ...details });
        const bare = (d: string) => d.replace(/^\./, "").toLowerCase();
        return (jar ?? [])
          .filter((c) => details.name === undefined || c.name === details.name)
          .filter((c) => details.domain === undefined || bare(c.domain) === bare(details.domain) || bare(c.domain).endsWith(`.${bare(details.domain)}`))
          .filter((c) => (details.partitionKey === undefined ? c.topLevelSite === undefined : c.topLevelSite === details.partitionKey.topLevelSite))
          .map((c) => ({ name: c.name, domain: c.domain, value: c.value, path: "/" }));
      },
    },
  };

  (globalThis as { chrome?: unknown }).chrome = fake;
  // No network. The worker fetches a site's published GPC file when a tab is inspected, and
  // a real fetch resolving after its test ended let that test's worker instance write its
  // state into the next test's store. A check stays in flight unless a test stubs fetch.
  (globalThis as { fetch?: unknown }).fetch = () => new Promise<never>(() => undefined);

  /** Deliver a message and resolve with whatever a listener sends back. */
  const deliver = (message: unknown, sender: FakeSender): Promise<unknown> =>
    new Promise((resolve) => {
      let answered = false;
      let anyAsync = false;
      for (const listener of messageListeners) {
        const keepOpen = listener(message, sender, (response) => {
          if (answered) return;
          answered = true;
          resolve(response);
        });
        if (keepOpen === true) anyAsync = true;
      }
      // A listener that returns false and never calls sendResponse leaves the caller with
      // undefined, which is how a message a guard dropped looks to the popup, so the fake
      // must reproduce it rather than hang.
      if (!anyAsync && !answered) resolve(undefined);
      else if (anyAsync) scheduledTimeout(() => !answered && resolve(undefined), 50);
    });

  return {
    sendFromPopup: (message) => deliver(message, {}),
    sendFromTab: (tabId, message, from) => deliver(message, { tab: { id: tabId }, ...from }),
    sessionStore: () =>
      Object.fromEntries(Object.entries(session).map(([k, v]) => [k, k.startsWith("tab:") && typeof v === "string" ? JSON.parse(v) : v])),
    rawSessionStore: () => ({ ...session }),
    setJar: (cookies) => {
      jar = cookies === null ? null : [...cookies];
    },
    jarLookups: () => [...lookups],
    sessionBytes: () => bytesOf(session),
    localStore: () => ({ ...local }),
    dynamicRules: () => [...rules],
    registeredScripts: () => [...scripts],
    iconCalls: () => [...icons],
    titleCalls: () => [...titles],
    refuseRules: (refuse) => {
      rulesRefused = refuse;
    },
    fireInstalled: async (details) => {
      for (const l of installedListeners) l(details);
      // The handler is fire-and-forget (`void (async () => ...)()`), as it must be for
      // Chrome. Its awaits are all on this fake, so they settle within a macrotask.
      await new Promise((r) => setTimeout(r, 0));
    },
    fireBeforeNavigate: async (details) => {
      for (const l of beforeNavigateListeners) l(details);
      await new Promise((r) => setTimeout(r, 0));
    },
    fireCommitted: async (details) => {
      for (const l of committedListeners) l(details);
      await new Promise((r) => setTimeout(r, 0));
    },
    fireCompleted: async (details) => {
      for (const l of completedListeners) l(details);
      await new Promise((r) => setTimeout(r, 0));
    },
    fireNavigationError: async (details) => {
      for (const l of navigationErrorListeners) l(details);
      await new Promise((r) => setTimeout(r, 0));
    },
    seedSync: (items) => {
      sync = { ...sync, ...items };
    },
    seedDynamicRules: (seeded) => {
      rules = [...rules, ...seeded];
    },
    syncStore: () => ({ ...sync }),
    setSessionQuota: (bytes) => {
      sessionQuota = bytes;
    },
    failSessionWrites: (message) => {
      sessionFailure = message;
    },
    setSessionWriteDelay: (ms) => {
      sessionWriteDelay = ms;
    },
    sessionSetCount: () => sessionSets,
    sessionFullReadCount: () => sessionFullReads,
    seedSession: (items) => {
      session = { ...session, ...items };
    },
    setOpenTabs: (ids) => {
      openTabs = [...ids];
    },
    setTabUrl: (tabId, url) => {
      tabUrls.set(tabId, url);
    },
    tabGetCount: () => tabGets,
    fireTabRemoved: async (tabId) => {
      for (const l of removedListeners) l(tabId);
      await new Promise((r) => setTimeout(r, 0));
    },
    fireSendHeaders: async (details) => {
      const full = { method: "GET", timeStamp: Date.now(), ...details };
      for (const l of sendHeadersListeners) l(full);
      await new Promise((r) => setTimeout(r, 0));
    },
    fireHeadersReceived: async (details) => {
      const full = { method: "GET", type: "other", timeStamp: Date.now(), ...details };
      for (const l of headersReceivedListeners) l(full);
      await new Promise((r) => setTimeout(r, 0));
    },
    reclaimWorker: () => {
      for (const id of pendingTimers) clearTimeout(id);
      pendingTimers.clear();
      for (const list of [
        messageListeners, storageChangeListeners, installedListeners, committedListeners, completedListeners,
        beforeNavigateListeners, removedListeners, sendHeadersListeners, headersReceivedListeners,
        beforeRedirectListeners,
      ] as unknown[][]) {
        list.length = 0;
      }
    },
    reset: () => {
      icons.length = 0;
      titles.length = 0;
      rulesRefused = false;
      for (const id of pendingTimers) clearTimeout(id);
      pendingTimers.clear();
      session = {};
      local = {};
      sync = {};
      rules = [];
      scripts = [];
      sessionQuota = null;
      sessionFailure = null;
      sessionWriteDelay = 0;
      sessionSets = 0;
      sessionFullReads = 0;
      openTabs = [];
      tabUrls.clear();
      tabGets = 0;
      jar = null;
      lookups.length = 0;
    },
  };
}
