// SPDX-License-Identifier: GPL-3.0-only
/**
 * The origin a frame's document runs under, which is not always its address's.
 *
 * An `about:blank` frame filled by script and a `srcdoc` frame have an address with no host
 * and an opaque origin, yet run under the origin of the document that created them, and a
 * cookie written there goes to that origin's site. A `blob:` address carries its origin
 * inside it, so it has no host either. `self.origin` is the origin the document runs under
 * in every case; the address's own is kept wherever it names one, so an ordinary page reads
 * exactly what it did.
 */

/** The document's origin: the address's, or the inherited one where the address is opaque. */
export function documentOrigin(locationOrigin: string, selfOrigin: string | undefined): string {
  if (locationOrigin !== "null" && locationOrigin !== "") return locationOrigin;
  return typeof selfOrigin === "string" ? selfOrigin : locationOrigin;
}

/** The document's host: the address's, or the host of the origin it runs under. */
export function documentHost(locationHostname: string, selfOrigin: string | undefined): string {
  if (locationHostname !== "") return locationHostname;
  if (typeof selfOrigin !== "string" || selfOrigin === "null") return "";
  try {
    return new URL(selfOrigin).hostname;
  } catch {
    return "";
  }
}
