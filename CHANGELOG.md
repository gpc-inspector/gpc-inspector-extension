# Changelog

All notable changes to GPC Inspector are recorded here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow the rules in
docs/MAINTAINING.md: `1.0.x` for fixes, `1.x.0` for features. Each version is a tag, and
its GitHub release carries the same notes.

## Unreleased

### Fixed

- A page that calls its consent API in a tight loop no longer slows down. Each call was
  sent to the service worker as its own message. The first call of each kind is still sent
  at once, and later ones are merged and sent four times a second. A US Privacy, GPP or TCF
  payload equal to the last one is not sent again. The counts in the record are unchanged.
- The toolbar icon is set only when its state changes. It was set again on every badge
  update and on every frame's report, and each set made the browser reload the images.
  That was most of the service worker's time on a busy page.

## 1.0.2 (2026-10-28)

1.0.2 needs Chrome 119 or later, or Brave or Edge on Chromium 119 or later. 1.0.1 needed
114. A browser before 119 keeps the version it has and receives no more updates.

What you will notice:

- "GPC confirmation shown on page" appears only when the page shows a confirmation, with
  the page's words quoted and a "beta" tag. It no longer says "checking" or "no". A new
  setting turns the scan off.
- More confirmation wordings are recognized, and a negated line, such as "not detected",
  never counts.
- A confirmation inside an open shadow root, where web components draw consent dialogs, is
  read.
- The page is watched for a confirmation for as long as it is open, not for the first minute
  only.
- On a site where the browser limits the extension's access, the popup says so instead of
  asking for a reload. Settings says when the signal is not sent in private windows.
- When another extension replaces `navigator.globalPrivacyControl` after the page loads,
  the popup says another extension owns it and gives the value pages read.
- Frames that inherit the page's origin (`about:blank`, `srcdoc`, `blob:`) get the page
  property, and what scripts do there is recorded.

### Added

- A setting, "Check page for messaging that the GPC or Opt-Out signal was honored", marked
  "beta", turns the confirmation notice scan on or off. On by default, as before. Off, the
  pages that load after it are not read for a confirmation, and the saved summary says the
  check was turned off. The observation set records such a page as `not-checked`
  (schema 1.42.0). The bug report's settings line carries it.
  ([#58](https://github.com/gpc-inspector/gpc-inspector-extension/pull/58))

### Changed

- "GPC confirmation shown on page" is drawn only when the page shows a confirmation, as
  "yes" with the page's words quoted under it and a "beta" tag. It is no longer drawn as
  "checking" or "no": a site may confirm in a dialog or on a settings page the extension
  cannot see. The hover text on "What this site did" says a confirmation is listed there
  when the page shows one. The saved summary says "not seen on this page", or "still
  checking when this file was saved". The observation set carries the matched words
  (`confirmationText`, schema 1.41.0).
  ([#50](https://github.com/gpc-inspector/gpc-inspector-extension/issues/50))
- The extension needs Chrome 119 or later (before, 114), the version from which the
  browser runs a registered script in frames that inherit the page's origin.
  ([#44](https://github.com/gpc-inspector/gpc-inspector-extension/issues/44))
- When a vendor shows "Cannot determine" because the site's own JavaScript read GPC and
  loaded the vendor, its hover text now says just that, and that whether the site passed
  the GPC value on to the vendor cannot be determined. Every "Cannot determine" hover text
  now says the vendor was not observed reading GPC "from the page", the words of the
  column's heading.
  ([#38](https://github.com/gpc-inspector/gpc-inspector-extension/pull/38))

### Fixed

- The confirmation state is no longer recorded as "not detected" after the first scan's miss
  while later scans and the watcher are still running. It stays undetermined until the
  timed scans end, so a summary saved during them no longer says none was seen.
  ([#50](https://github.com/gpc-inspector/gpc-inspector-extension/issues/50))
- The confirmation notice scan recognizes more wordings that name the signal and say it was
  detected or honored, among them "GPC signal detected", "GPC opt-out preference honored",
  "Opt-Out Preference Signal detected and honored" and the status text that consent tools
  document, and the lines "Your opt-out request has been honored." and "Your opt-out
  preference has been honored.". A negated line never counts: "Opt-Out Preference Signal
  not detected" under a "Global Privacy Control" heading counted as a confirmation before,
  and "No Opt-Out Preference Signal has been detected." did too.
  ([#48](https://github.com/gpc-inspector/gpc-inspector-extension/issues/48))
- The confirmation notice scan reads text inside open shadow roots, where web components
  draw consent dialogs, and watches them for changes like the rest of the page. Before, a
  notice inside a shadow root was never seen. Closed shadow roots stay unread. An element
  whose page script redefines its `localName`, as some bot checks' frames do, is read by the
  name the browser gives it and never stops the scan or the timer it runs on.
  ([#47](https://github.com/gpc-inspector/gpc-inspector-extension/issues/47),
  [#61](https://github.com/gpc-inspector/gpc-inspector-extension/pull/61))
- The confirmation notice scan watches the page for as long as it is open, not for the first
  minute only, so a notice that appears later, such as in a privacy settings dialog the
  reader opens, is seen. The watch stops once the page has been hidden for a minute and
  starts again when it is visible.
  ([#49](https://github.com/gpc-inspector/gpc-inspector-extension/issues/49))
- On a site the browser does not let the extension act on (its Site access setting is "On
  click" or "On specific sites", or a policy blocks the host), the popup says the extension
  was not allowed on the site when the page loaded and how to change that, and the toolbar
  icon is gray. Before, it said "reload the page to apply", which alone never helped there.
  Settings says when the signal is sent only on some sites, and when it is not sent in
  private windows because the extension is not allowed there.
  ([#45](https://github.com/gpc-inspector/gpc-inspector-extension/issues/45))
- When another extension's script replaces `navigator.globalPrivacyControl` after the page
  loads, the popup names another extension as the owner and the value pages read, and says
  reads could not be observed. Before, it kept saying the signal was set by this extension
  while pages read the other value, and their reads were no longer counted. A frame that
  loads later no longer overwrites what the top document reported.
  ([#46](https://github.com/gpc-inspector/gpc-inspector-extension/issues/46))
- With "Send GPC" on, `navigator.globalPrivacyControl` is set in frames with no address of
  their own: an `about:blank` frame filled by script, a `srcdoc` frame and a `blob:` frame.
  Before, scripts there read `undefined` while their requests carried `Sec-GPC: 1`, and
  their reads were not counted. Reads, cookie writes and consent calls there are now
  recorded like any other frame's, under the site the frame runs under.
  ([#44](https://github.com/gpc-inspector/gpc-inspector-extension/issues/44))
- On the HTTP Requests tab, a domain's row shows only whole cookie names and then "+N" for
  the rest, and the count is never cut off. Opening the domain lists every cookie name it
  set on one "Cookies set" line, above its requests. Before, long names could hide the
  count, and the names were spread across the requests that set them.
  ([#35](https://github.com/gpc-inspector/gpc-inspector-extension/issues/35))
- A page the reader comes back to, restored from the browser's back/forward cache, keeps
  the result of its confirmation notice scan. Before, the "GPC confirmation shown on page"
  row said "checking" for as long as the tab stayed on that page: the scan runs as a page
  loads, and a restored page is resumed, not loaded again.
  ([#41](https://github.com/gpc-inspector/gpc-inspector-extension/pull/41))
- The confirmation notice scan reads the whole of the page's text. Before, it stopped at
  200,000 characters, and a notice in the footer of a page with more text than that, such
  as a long feed, was reported as not shown.
  ([#41](https://github.com/gpc-inspector/gpc-inspector-extension/pull/41))
- When a vendor or a domain set two cookies of the same name for different domains, its
  panel now shows each cookie's domain after its name, as the row does, so you can tell
  which line is which. The saved summary names them the same way in its "sent back" and
  "removed" lines.
  ([#36](https://github.com/gpc-inspector/gpc-inspector-extension/issues/36))

## 1.0.1 (2026-10-18)

### Changed

- With "Send GPC" on, the page property `navigator.globalPrivacyControl` reads `true` even
  where the browser has it off, or another extension whose script ran first, so the page
  property agrees with the `Sec-GPC: 1` header. Before, the extension set the property only
  when nothing else had, and a page could read `false` while every request carried the
  header. Turning the setting off still never disables a signal the browser or another
  extension sets. The setting is now named "Send GPC".
  ([#31](https://github.com/gpc-inspector/gpc-inspector-extension/pull/31))

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
