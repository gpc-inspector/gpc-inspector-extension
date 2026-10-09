// SPDX-License-Identifier: GPL-3.0-only
/**
 * Set-Cookie parsing (PRD FR-8, FR-9).
 *
 * Pure: string in, CookieRecord out. No chrome.* — which means it is fully testable in
 * Node and shares the engine's determinism guarantees.
 *
 * Captures `Partitioned` (CHIPS) because a partitioned cookie cannot do cross-site
 * tracking, and presenting it identically to an unpartitioned `IDE` would overstate the
 * finding (PRD edge-case table).
 *
 * Deliberately lenient about malformed input: a cookie we can't fully parse still yields
 * a record with whatever we could read, because dropping it would understate what the
 * response did. What we never do is invent an attribute we didn't observe.
 */

import type { CookieRecord, SameSite, CaptureMethod } from "@gpc-inspector/schema";

/** Parse one Set-Cookie header value. Returns null only when there is no name at all. */
export function parseSetCookie(
  headerValue: string,
  fallbackDomain: string,
  via: CaptureMethod = "onHeadersReceived",
): CookieRecord | null {
  const parts = headerValue.split(";");
  const first = parts[0];
  if (first === undefined) return null;

  const eq = first.indexOf("=");
  // A cookie with no "=" has no name/value pair we can use.
  if (eq < 0) return null;

  const name = first.slice(0, eq).trim();
  if (name === "") return null;
  const value = first.slice(eq + 1).trim();

  let domain = fallbackDomain;
  let path = "/";
  let expiresMs: number | "session" | null = "session";
  let sameSite: SameSite = "unspecified";
  let httpOnly = false;
  let secure = false;
  let partitioned = false;

  let sawMaxAge = false;

  for (let i = 1; i < parts.length; i++) {
    const attr = parts[i];
    if (attr === undefined) continue;
    const trimmed = attr.trim();
    const aeq = trimmed.indexOf("=");
    const key = (aeq < 0 ? trimmed : trimmed.slice(0, aeq)).trim().toLowerCase();
    const av = aeq < 0 ? "" : trimmed.slice(aeq + 1).trim();

    switch (key) {
      case "domain":
        if (av) domain = av.startsWith(".") ? av : `.${av}`;
        break;
      case "path":
        if (av) path = av;
        break;
      case "max-age": {
        // Max-Age wins over Expires per RFC 6265.
        const seconds = Number.parseInt(av, 10);
        if (Number.isFinite(seconds)) {
          expiresMs = seconds <= 0 ? 0 : Date.now() + seconds * 1000;
          sawMaxAge = true;
        }
        break;
      }
      case "expires": {
        if (sawMaxAge) break;
        const t = Date.parse(av);
        if (Number.isFinite(t)) expiresMs = t;
        break;
      }
      case "samesite": {
        const v = av.toLowerCase();
        sameSite =
          v === "strict" ? "Strict" : v === "lax" ? "Lax" : v === "none" ? "None" : "unspecified";
        break;
      }
      case "httponly":
        httpOnly = true;
        break;
      case "secure":
        secure = true;
        break;
      case "partitioned":
        partitioned = true;
        break;
      default:
        break;
    }
  }

  return { name, value, domain, path, expiresMs, sameSite, httpOnly, secure, partitioned, via };
}

/**
 * Extract every cookie from a response's headers.
 * Chrome delivers multiple Set-Cookie headers as separate entries, and may also deliver
 * several newline-joined in one value — both shapes are handled.
 */
export function parseSetCookieHeaders(
  headers: readonly { name: string; value?: string | undefined }[],
  fallbackDomain: string,
  via: CaptureMethod = "onHeadersReceived",
): CookieRecord[] {
  const out: CookieRecord[] = [];
  for (const h of headers) {
    if (h.name.toLowerCase() !== "set-cookie") continue;
    const raw = h.value ?? "";
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = parseSetCookie(trimmed, fallbackDomain, via);
      if (parsed) out.push(parsed);
    }
  }
  return out;
}

/** Is this status code a redirect? Determines the redirect-hop distinction. */
export function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** Case-insensitive header lookup. */
export function findHeader(
  headers: readonly { name: string; value?: string | undefined }[],
  name: string,
): string | null {
  const target = name.toLowerCase();
  for (const h of headers) {
    if (h.name.toLowerCase() === target) return h.value ?? "";
  }
  return null;
}

/**
 * Names of the cookies an outgoing request carried back (PRD FR-9).
 *
 * The `Cookie` header is a flat list of `name=value` pairs, so the NAMES are directly
 * observable — which makes "was this identifier sent back to the vendor that set it" an
 * observation rather than an inference about how HTTP works.
 *
 * Values are parsed and discarded here and never returned. A cookie value is a session
 * identifier; storing one would put it in the evidence bundle, in an export, and in any
 * screenshot of the extension.
 *
 * Note what this does NOT do: it draws no distinction for partitioned cookies. A
 * `Partitioned` cookie is keyed to the top-level site and cannot build a cross-site
 * profile, which is a real difference — but whether that difference makes a disclosure
 * lawful is a legal conclusion, and no regulator has published one. Filtering them out
 * here would encode that conclusion in a `filter()`. The attribute is reported alongside
 * the fact and the reader decides (D4).
 */
export function cookieNamesSent(
  headers: readonly { name: string; value?: string | undefined }[],
): string[] {
  const raw = findHeader(headers, "cookie");
  if (raw === null || raw === "") return [];

  const names: string[] = [];
  for (const pair of raw.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    if (name !== "") names.push(name);
  }
  return names;
}

/** Did this request carry Sec-GPC: 1? The spec defines exactly one valid value. */
export function hasSecGpc(
  headers: readonly { name: string; value?: string | undefined }[],
): boolean {
  const v = findHeader(headers, "sec-gpc");
  return v !== null && v.trim() === "1";
}
