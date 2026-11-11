# Changelog

All notable changes to GPC Inspector are recorded here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow the rules in
docs/MAINTAINING.md: `1.0.x` for fixes, `1.x.0` for features. Each version is a tag, and
its GitHub release carries the same notes.

## Unreleased

### Changed

- The loaded-by line under a vendor reads "loaded by the site" in place of "loaded by the
  site itself", matching "also by the site". The "Cannot determine" help for a vendor the
  site loaded says "the site's first-party JavaScript" in place of "the site's own
  JavaScript", and the First party panel says "this site's responses" in place of "this
  site's own responses".
- The "beta" mark on the "GPC confirmation shown on page" row stands after the label, not
  after "yes", since it describes the check and not its answer. The saved summary writes it
  the same way: "GPC confirmation shown on page (beta): yes".
- The Google Consent Mode row in Privacy strings counts denied consent types: its closed
  value reads "N of 4 consent types denied" in place of the granted count. A consent type
  the site never set is shown as not set and counted on neither side, since Google
  documents no default for it and its tags run unrestricted for one; only a denied type
  restricts them. When some consent types are set and others are not, a note under Consent
  types says so. The record is unchanged.
- On a page where no Google tag ran, the Google Consent Mode row reads "not present", like
  the GPP, US Privacy and TCF rows, in place of "no Google tags". A Google tag here is Tag
  Manager or gtag.js. A page can run other Google scripts that have no Consent Mode, such as
  classic Google Analytics (ga.js), and the old value read as a contradiction there.

### Fixed

- A vendor's or a domain's panel marked a cookie "sent back" when another cookie of the same
  name went back to a different host of the vendor. The record now keeps the host each name
  went back to (`cookiesReturnedTo`, schema 1.45.0), and only a cookie whose domain covers
  that host is marked, in the popup, the side panel and the saved summary. A name carried on
  the request whose response set a cookie for that host was another cookie's, and marks
  neither. A record saved
  before this marks a name's cookie only where one cookie of the name could have gone.
  ([#37](https://github.com/gpc-inspector/gpc-inspector-extension/issues/37))
- Requests a page asked the browser to fetch ahead of a click, with speculation rules or
  `<link rel=prefetch>`, were recorded as the page's own: counted in its totals and its
  domains, and a speculation-rules prefetch could stand for the page's document. Since
  1.1.0, one made after the page loaded also started the record over, empty, under the
  prefetched address, and the popup asked for a reload. They are now listed in a group of
  their own on the Requests tab, "Fetched ahead of a click", and count nowhere. A cookie one
  set counts on the page opened from it in the same tab, where Chrome reports none. The
  observation set marks them (`prefetch`, schema 1.46.0).
  ([#63](https://github.com/gpc-inspector/gpc-inspector-extension/issues/63))
- A page that decorated `__tcfapi`, `__gpp` or `__uspapi` (read the function, then assigned
  one that calls it) sent every call of the API into endless recursion until the stack
  overflowed, since every read handed back one shared wrapper that called whatever was
  assigned last. Each assigned function now has a wrapper of its own, a function read before
  a reassignment keeps calling the one current when it was read, and a call through such
  layers is recorded once.
- Recording a consent API call or a dataLayer push could throw into the page's own call: a
  page whose `Error.prepareStackTrace` returned something other than a string made every
  consent API call throw, and a dataLayer push threw before the page's push ran. Every step
  of the recording is now guarded and the page's function is called regardless. A pushed
  object claiming a `length` is read only when that length is a small argument count, and a
  frozen or sealed dataLayer is left as it was and reported as not observable.
- The headline count, the cookies under each vendor and domain, the Tag containers rows and
  the Requests tab's counted names decided between the visit with the signal on and the one
  with it off by whether anything owned the page property, while the tallies sort cookies by
  whether their request carried `Sec-GPC`. Two loads read the wrong side and said no
  cookies were set: one where the browser or another extension owns the property, reads
  false and no header went out, and one where the header went out and the property was
  missed. All of them now read the visit by one rule, the one the toolbar icon states: the
  signal was on when the page property read true or the request that fetched the page
  carried `Sec-GPC`.

## 1.1.0 (2026-10-30)

### Changed

- The page property `navigator.globalPrivacyControl` reads true from the moment the
  extension loads, while "Send GPC" is on. With sending off, on a page nothing else owns the
  property, it is removed before the page's first script runs, so the page reads what the
  browser gives it (undefined in Chrome and Edge), and the extension counts no reads of it;
  the GPC read rows say so. In 1.0.3 the property read `false` with sending off. A browser's
  or another extension's property is wrapped and left at its value, as before, and the lock
  is still applied only while sending and the lock are both on. The observation set records
  the page's own value as "absent" with sending off (schema 1.43.0).
  ([#69](https://github.com/gpc-inspector/gpc-inspector-extension/pull/69), [#70](https://github.com/gpc-inspector/gpc-inspector-extension/pull/70))
- After an install, an update, a reload or a browser start, the extension brings every open
  `http` and `https` tab to the current setting without a reload: a page whose scripts run is
  sent the setting, and a page open before they could run is given them. Where that set the
  property after the page loaded, the popup says so in a line under the status, the GPC read
  rows say only later scripts are counted, and the `signal-not-read` finding is not made. The
  observation set records it (`propertySetLate`, schema 1.44.0). Frames with no address of
  their own, discarded tabs and browser pages are not reached; LIMITATIONS.md has the list.
  ([#70](https://github.com/gpc-inspector/gpc-inspector-extension/pull/70))

### Fixed

- A page that loaded in the moment after the extension was installed, updated, reloaded or
  started with the browser could read `navigator.globalPrivacyControl` as `false` while its
  requests carried `Sec-GPC: 1`, telling the site the reader had turned GPC off. Such a page
  now reads true with the header.
  ([#68](https://github.com/gpc-inspector/gpc-inspector-extension/issues/68), [#69](https://github.com/gpc-inspector/gpc-inspector-extension/pull/69), [#70](https://github.com/gpc-inspector/gpc-inspector-extension/pull/70))
- Where a load still gets one half of the signal and not the other, the popup names the half
  that was missing: "the header was sent, the page property was not set on this load", or
  the mirror at browser startup, each with the reload instruction, in place of "signal is not
  set". Each such load is counted, by the half it missed, and the two counts go on the bug
  report's settings line. The observation set records whether the request that fetched the
  page carried the header (`documentSigned`, schema 1.43.0).
  ([#69](https://github.com/gpc-inspector/gpc-inspector-extension/pull/69))
- The worker reads its script registration back after every change to the sending setting,
  as it reads the header rule back, and shows the `!` badge with a title saying the page
  property cannot be set when the browser did not keep it. Before, a dropped registration
  went unnoticed while the header kept going out.
  ([#69](https://github.com/gpc-inspector/gpc-inspector-extension/pull/69))
- With sending off, a page property another extension defined after this extension's
  scripts had run was reported as no signal: the popup said the signal was not set while the
  page read `true`. The page's report now names that owner and its value.
  ([#70](https://github.com/gpc-inspector/gpc-inspector-extension/pull/70))
- A page loaded in a newly opened tab, from a link that opens one, `window.open` or
  `chrome.tabs.create`, lost its own document request from the record: the browser sends that
  request before it reports the start of the navigation, and the record was reset at that
  report. The request is now on the Requests tab, the cookies its response set are counted,
  and whether it carried `Sec-GPC` is recorded.
  ([#71](https://github.com/gpc-inspector/gpc-inspector-extension/pull/71))

## 1.0.3 (2026-10-29)

### Changed

- The GPP row, the GPP conflict finding and the Read GPC lines read only the sections of a
  GPP string that apply: the one or two the site's consent tool names, or the string's only
  US section when it names none. When no section applies, when none is named and the string
  carries several, or when the one named is not in the string, the row says so and judges
  no section, and a vendor's GPP call is placed under "Cannot determine".
  ([#65](https://github.com/gpc-inspector/gpc-inspector-extension/pull/65))
- The "beta" mark, in Settings and on the confirmation row, is an outlined BETA chip, so it
  is not missed. Four settings have shorter lines under them, and the statement that the
  extension records observations and is not legal advice is now at the foot of Settings.
  ([#66](https://github.com/gpc-inspector/gpc-inspector-extension/pull/66))

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
- A page that calls its consent API many times a second no longer slows down, and the
  extension uses less of the browser's time on busy pages.

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
- A page that calls its consent API in a tight loop no longer slows down. Each call was
  sent to the service worker as its own message. The first call of each kind is still sent
  at once, and later ones are merged and sent four times a second. A US Privacy, GPP or TCF
  payload equal to the last one is not sent again. The counts in the record are unchanged.
  ([#60](https://github.com/gpc-inspector/gpc-inspector-extension/pull/60))
- The toolbar icon is set only when its state changes. It was set again on every badge
  update and on every frame's report, and each set made the browser reload the images.
  That was most of the service worker's time on a busy page.
  ([#60](https://github.com/gpc-inspector/gpc-inspector-extension/pull/60))

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
