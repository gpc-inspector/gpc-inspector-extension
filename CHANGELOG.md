# Changelog

All notable changes to GPC Inspector are recorded here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow the rules in
docs/MAINTAINING.md: `1.0.x` for fixes, `1.x.0` for features. Each version is a tag, and
its GitHub release carries the same notes.

## Unreleased

### Changed

- With "Send GPC" on, the page property `navigator.globalPrivacyControl` reads `true` even
  where the browser or another extension has it off, so the page property and the
  `Sec-GPC: 1` header always agree. Before, the extension set the property only when
  nothing else had, and a page could read `false` while every request carried the header.
  The property is then locked for the page, so an extension that loads later cannot
  replace it; that extension's attempt to set it fails with an error.
  Turning the setting off still never disables a signal the browser or another extension
  sets. The setting is now named "Send GPC".

### Fixed

- A cookie is labeled "removed" only when the browser no longer holds it. Before, the label
  could stay when the site set the cookie again, when the browser kept the cookie, or when
  the removal named another cookie of the same name. The cookie was always counted and
  listed; only the label was wrong.
  ([#24](https://github.com/gpc-inspector/gpc-inspector-extension/issues/24),
  [#29](https://github.com/gpc-inspector/gpc-inspector-extension/pull/29))

## 1.0.0 (2026-10-12)

1.0.0 replaces 0.1.4, rewritten from the ground up. It shows you what a page did with your
Global Privacy Control (GPC) signal. It runs in Chrome, Brave and Edge, and everything the
extension observes stays on your device.

### Added

- On each page: whether the GPC signal was set, and who set it (the browser, this extension,
  or another extension).
- Whether the page showed a GPC confirmation notice.
- Whether the site publishes `/.well-known/gpc.json` and declares GPC support there.
- What was communicated to vendors through the Global Privacy Platform (GPP), US Privacy
  (USP), the Transparency & Consent Framework (TCF) and Google Consent Mode.
- Which vendors' scripts read GPC from the page.
- Which vendors set third-party cookies while your GPC signal was on, and whether each cookie
  was sent back to the vendor.
- The page's HTTP requests, by company and category, from Disconnect's public list.
- The findings in the popup or in the side panel, which follows you as you browse.
- The summary saved as a Markdown file, and the full log as JSON.
- A "Finding looks wrong" report, opened from the popup.

### Changed

- By default the extension sends the GPC signal when nothing else does: the `Sec-GPC` header
  on requests and the `navigator.globalPrivacyControl` property on pages. It can be turned
  off in Settings. Your setting for sending the signal carries over from 0.1.4.

### Known limits

- A finding is an observation, not a legal conclusion. A page with no findings may still
  share data in ways an extension cannot see. The full list is in
  [docs/LIMITATIONS.md](docs/LIMITATIONS.md).
- A cookie can carry the label "removed" while the browser still holds it
  ([#24](https://github.com/gpc-inspector/gpc-inspector-extension/issues/24)). Fixed under
  "Unreleased".
