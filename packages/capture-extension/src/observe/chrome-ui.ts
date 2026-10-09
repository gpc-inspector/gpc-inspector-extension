// SPDX-License-Identifier: GPL-3.0-only
/**
 * Frames Chrome embeds inside its own pages.
 *
 * The new-tab page is `chrome://new-tab-page`, and Chrome never runs content scripts in
 * it. But for a signed-in user it embeds https frames of its own (Google's account bar and
 * modules), and those do get content scripts. Their widgets build sandboxed frames, Chrome
 * logs the blocked script with our insertion wrapper as the nearest frame, and the Errors
 * panel files a message from Chrome's own UI under this extension with "chrome://newtab/"
 * as the context.
 *
 * Nothing a reader audits lives in those frames, so the observers stay out of them. The
 * test is the ancestor chain rather than a URL pattern: the frames' own URLs vary by
 * account and by Chrome version, but their ancestors are always one of Chrome's schemes.
 * `location.ancestorOrigins` is Chrome-only, which is fine for a Chrome extension; where
 * it is missing the answer is "not inside", and the observers install.
 */

const CHROME_SCHEME = /^(?:chrome|chrome-untrusted|chrome-extension|devtools):/;

export function isInsideChromeUi(ancestorOrigins: ArrayLike<string> | undefined): boolean {
  if (!ancestorOrigins) return false;
  for (let i = 0; i < ancestorOrigins.length; i++) {
    if (CHROME_SCHEME.test(ancestorOrigins[i] ?? "")) return true;
  }
  return false;
}
