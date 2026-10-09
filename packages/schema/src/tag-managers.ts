// SPDX-License-Identifier: GPL-3.0-only
/**
 * Tag-manager recognition and container identity, from a JavaScript stack frame's URL.
 *
 * WHY THIS LIVES IN THE SCHEMA PACKAGE
 *
 * Three consumers need the identical mapping from a frame URL to a displayed container
 * id: the capture layer (which decides at the moment of a consent call, a property read or
 * a script insertion whether the frame is a container), the engine (which counts checks
 * and loaders per container) and the popup (which prints the id). If the mapping lived in
 * capture, the engine would re-derive it and the two could drift; the schema package is
 * the one thing all three already depend on. It is pure and dependency-free, like
 * canonicalize and hash, which is the package's rule for runtime code.
 *
 * WHAT A CONTAINER IS, HERE
 *
 * A script whose URL matches a known tag-manager loader. The id is whatever that manager
 * puts in the loader URL: GTM and the Google tag carry it in the `id=` parameter and
 * nothing else in the query matters (`l=` names a dataLayer, `gtm_auth` and `gtm_preview`
 * select an environment; one container is one container whichever way it was loaded).
 * Tealium and Ensighten put account and profile in the path, Adobe Launch a property
 * build name, Segment a write key, Matomo and Piwik PRO a container id. Each is the
 * identifier a person who administers that manager would recognize.
 *
 * A manager frame that names no container is real and distinct from "not a manager":
 * Google serves helper scripts from the same host, and a self-hosted `utag.js` may be
 * served under a path that hides its account. Those return an identity with `id: null`,
 * which callers treat as "a container, unnamed" rather than as a vendor.
 *
 * Server-side GTM can serve its loader first-party under the default `/gtm.js` path, so
 * that path is recognized on ANY host. A loader renamed to a custom path is not recognized
 * by anything here; docs/LIMITATIONS.md describes that limit.
 */

import type { GtmObservation } from "./signal.js";

export type TagManagerKind =
  | "gtm" // Google Tag Manager container (GTM-XXXX)
  | "gtag" // the Google tag (G-, AW-, DC-, UA- ids), loaded directly or by a container
  | "google" // a googletagmanager.com script that names no container (a helper)
  | "tealium"
  | "adobe-launch"
  | "segment"
  | "matomo"
  | "piwik-pro"
  | "ensighten"
  | "commanders-act";

export interface ContainerIdentity {
  readonly manager: TagManagerKind;
  /**
   * The container's id as a person would recognize it (GTM-ABC, G-XYZ, account/profile,
   * launch-hash, a write key). null for a manager frame that names no container.
   */
  readonly id: string | null;
}

interface ParsedUrl {
  readonly host: string;
  readonly path: string;
  readonly params: URLSearchParams | null;
}

function parse(frameUrl: string): ParsedUrl | null {
  try {
    const u = new URL(frameUrl);
    return { host: u.hostname.toLowerCase(), path: u.pathname, params: u.searchParams };
  } catch {
    // Not a URL the platform will parse (a stack regex can hand us a truncated one).
    // Fall back to a best-effort split so a recognizable host still counts.
    const m = /^[a-z]+:\/\/([^/?#]+)([^?#]*)/i.exec(frameUrl);
    if (!m) return null;
    return { host: (m[1] ?? "").toLowerCase(), path: m[2] ?? "", params: null };
  }
}

function idParam(p: ParsedUrl): string | null {
  const raw = p.params?.get("id");
  if (!raw) return null;
  const id = raw.trim();
  return id === "" ? null : id;
}

function hostIs(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * Identify the container a frame URL belongs to, or null when the URL is not a
 * tag-manager loader at all.
 */
export function containerIdentity(frameUrl: string): ContainerIdentity | null {
  const p = parse(frameUrl);
  if (!p) return null;
  const { host, path } = p;

  // --- Google: GTM container, the Google tag, or a helper ---
  const googleHost = hostIs(host, "googletagmanager.com") || hostIs(host, "tagmanager.google.com");
  if (path.endsWith("/gtm.js")) {
    // Recognized on any host: server-side GTM serves the loader first-party.
    return { manager: "gtm", id: idParam(p) };
  }
  if (path.endsWith("/gtag/js") || path.endsWith("/gtag/destination")) {
    const id = idParam(p);
    // A GTM id handed to the gtag loader (it happens) is still a container.
    if (id !== null && /^GTM-/i.test(id)) return { manager: "gtm", id };
    return { manager: "gtag", id };
  }
  if (googleHost) return { manager: "google", id: null };

  // --- Tealium iQ: /utag/{account}/{profile}/{env}/utag(.sync|.NN)?.js ---
  const tealium = /\/utag\/([^/]+)\/([^/]+)\/[^/]+\/utag(?:\.[\w-]+)*\.js$/.exec(path);
  if (tealium) return { manager: "tealium", id: `${tealium[1]}/${tealium[2]}` };
  if (hostIs(host, "tags.tiqcdn.com")) return { manager: "tealium", id: null };

  // --- Adobe Launch (Experience Platform Tags) and legacy DTM ---
  const launch = /\/(launch-[A-Za-z0-9]+(?:-[a-z]+)?)(?:\.min)?\.js$/.exec(path);
  if (launch) return { manager: "adobe-launch", id: launch[1] ?? null };
  const dtm = /\/(satelliteLib-[A-Za-z0-9]+)\.js$/.exec(path);
  if (dtm) return { manager: "adobe-launch", id: dtm[1] ?? null };
  if (hostIs(host, "assets.adobedtm.com")) return { manager: "adobe-launch", id: null };

  // --- Segment: /analytics.js/v1/{writeKey}/analytics(.min)?.js ---
  const segment = /\/analytics\.js\/v1\/([^/]+)\/analytics(?:\.min)?\.js$/.exec(path);
  if (segment) return { manager: "segment", id: segment[1] ?? null };
  if (hostIs(host, "cdn.segment.com")) return { manager: "segment", id: null };

  // --- Matomo Tag Manager: /js/container_{ID}[_env].js, cloud or self-hosted ---
  const matomo = /\/container_([A-Za-z0-9]+)(?:_[a-z]+)?\.js$/.exec(path);
  if (matomo) return { manager: "matomo", id: matomo[1] ?? null };

  // --- Piwik PRO: {instance}.containers.piwik.pro/{uuid}.js ---
  if (hostIs(host, "containers.piwik.pro")) {
    const m = /^\/([0-9a-f-]{36})\.js$/i.exec(path);
    return { manager: "piwik-pro", id: m?.[1] ?? null };
  }

  // --- Ensighten: nexus.ensighten.com/{client}/{profile}/Bootstrap.js ---
  if (hostIs(host, "ensighten.com")) {
    const m = /^\/([^/]+)\/([^/]+)\/Bootstrap\.js$/.exec(path);
    return { manager: "ensighten", id: m ? `${m[1]}/${m[2]}` : null };
  }

  // --- Commanders Act (TagCommander): cdn.tagcommander.com/{site}/tc_{site}_{container}.js ---
  if (hostIs(host, "tagcommander.com")) {
    const m = /\/tc_(\d+)_(\d+)(?:_[a-z]+)?\.js$/.exec(path);
    return { manager: "commanders-act", id: m ? `${m[1]}/${m[2]}` : null };
  }

  return null;
}

/** True when the frame belongs to a tag manager, named or not. */
export function isTagManagerFrame(frameUrl: string): boolean {
  return containerIdentity(frameUrl) !== null;
}

/**
 * A stable map key for one container. Two frames of one container loaded two ways (a
 * second dataLayer name, a preview environment) produce the same key.
 */
export function containerKey(identity: ContainerIdentity): string {
  return `${identity.manager}:${identity.id ?? ""}`;
}

/**
 * Whether a request URL fetches a Google tag script: a Tag Manager container (gtm.js) or
 * gtag.js. The worker records it as the request is seen (GtmObservation.scriptFetched), and
 * a reader of an older bundle scans the request list with the same test.
 */
export function isGoogleTagScript(url: string): boolean {
  return /^https?:\/\/(www\.)?googletagmanager\.com\/(gtm|gtag)\b/.test(url);
}

/**
 * Whether a Google tag loaded on the page: a container or gtag id was seen, or the page
 * fetched Google's loader script (scriptFetched, 1.22.0; derived for an older bundle by the
 * engine's withPersistedShape).
 *
 * The one test for "is there Consent Mode to observe here". The capture uses it to decide
 * whether an unwatched dataLayer is a gap (CaptureCapabilities.dataLayer, 1.31.0) and the
 * popup uses it for the Consent Mode row and the capability notice; two copies of it would
 * let the bundle and the popup disagree about the same page. A page with no Google tag has
 * no Consent Mode, and a dataLayer nobody watched there is nothing, not a failure (seen on
 * 20 of 60 sites in the 2026-09-25 corpus run, marketplace-a.example and encyclopedia-a.example among them).
 */
export function googleTagObserved(
  gtm: Pick<GtmObservation, "present" | "containerIds" | "gtagIds" | "scriptFetched">,
): boolean {
  if (gtm.present || gtm.containerIds.length > 0 || gtm.gtagIds.length > 0) return true;
  return gtm.scriptFetched === true;
}

/**
 * Whether an unwatched dataLayer leaves Consent Mode unobserved: a Google tag loaded, and
 * Google's consent store was not read either. The Consent Mode row reads the store first,
 * so a page whose store was read had its Consent Mode observed, dataLayer or not (apparel-c.example,
 * 2026-09-25: a renamed dataLayer behind a first-party loader, every type denied in the
 * store). A store read empty ({} since 1.33.0) counts as read: Consent Mode was observed
 * and nothing was set, so only null leaves the dataLayer needed.
 *
 * The test for CaptureCapabilities.dataLayer, applied by the capture (1.31.0) and again by
 * the popup for older bundles, so the two cannot disagree about the same page.
 */
export function consentModeNeedsDataLayer(
  gtm: Pick<GtmObservation, "present" | "containerIds" | "gtagIds" | "scriptFetched" | "effectiveConsent">,
): boolean {
  return googleTagObserved(gtm) && (gtm.effectiveConsent ?? null) === null;
}
