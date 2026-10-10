# Privacy policy

GPC Inspector is a browser extension that shows what a site did with your Global Privacy
Control (GPC) signal. This page says what it reads, where that stays, and what can leave
your device. It covers version 1.0.0 and was last changed on 2026-10-08.

## In short

Nothing the extension observes is sent to the developer or to anyone else. There is no
account, no analytics, no telemetry and no advertising. What it reads stays in your browser,
and the record of each page is removed when you close its tab. What a site's published GPC
file said is kept no longer than the browser is open.

## What it reads, and why

To show what a page did with the signal, the extension reads, on each page you visit:

- **The addresses of the page and of the requests it makes, and their headers**, including
  `Sec-GPC` and `Set-Cookie`, so it can show whether each request carried the signal and
  which cookies its response set. The Chrome Web Store's disclosure calls this "Web history" and
  "User activity".
- **Cookies**: their names, domains and attributes, from responses and from scripts that
  write them. A cookie's value is held in memory while the page is open. Each counted cookie
  is looked up once in the browser's cookie jar, by its name and domain, to confirm the
  browser stored it; the value read is compared with the one the page wrote and then
  discarded. When a script removes a cookie, the extension checks, inside the page, whether
  a cookie of that name was there, and keeps only the yes or no. The extension never lists
  a site's cookies. Because some cookies sign you in,
  the Chrome Web Store's disclosure calls this "Authentication information".
- **Page text**, scanned only for a notice confirming that the site processed the signal.
  The Chrome Web Store's disclosure calls this "Website content".
- **What the page reports about your choice**: its Global Privacy Platform (GPP), US Privacy
  and Transparency & Consent Framework (TCF) strings, Google Consent Mode's state, and which
  scripts read `navigator.globalPrivacyControl` or called the GPP consent API (`__gpp`).

It uses all of this for one purpose: to show you, on the page you are on, what the site did
with the signal.

## Where it is kept, and for how long

- **Your settings** are kept in the browser's local extension storage until you remove the
  extension. On an update from version 0.1.4, that version's settings are read once to
  carry them over.
- **What it observed on each tab** is kept in the browser's session storage. A tab's record
  is removed when you close the tab, and the browser clears session storage when it quits.
- **What each site's published GPC file said** is kept in the browser's session storage, by
  the site's address (`www.` and the bare domain are two addresses), so the file is not
  requested again on every page. It is not removed when you close a tab. About 500
  addresses are kept, the oldest reading removed first; all of them are removed when the
  extension runs short of session storage, and the browser clears them when it quits.

## What leaves your device

- **Nothing to the developer or to any third party.**
- **One request of the extension's own**: the current site's `/.well-known/gpc.json` file,
  which states whether the site supports GPC. It goes to the site you are already visiting,
  without cookies, and at most periodically for each site. You can turn it off in Settings,
  "Check each site's published GPC file".
- **The signal itself**: when the extension sends GPC for you, it adds the `Sec-GPC: 1`
  header to your requests and sets `navigator.globalPrivacyControl` on the pages you visit.
  It does this from install when nothing else sends the signal, and you can turn it off in
  Settings.

## What you can choose to share

- **Download findings** saves files on your device: a summary (Markdown) and a log (JSON),
  neither with cookie values. A third, separate button, "Save log with sensitive
  information (JSON)", saves the log with cookie values, `Cookie` and `Authorization`
  header values, and full addresses with their query strings. Where you keep or send those
  files is up to you.
- **Finding looks wrong** shows what a report includes, then opens a new-issue page on the
  project's public GitHub issue tracker. The address of that page carries the site's domain,
  a summary of what was observed, and your browser, operating system and list versions. If
  you choose to copy the log, it goes to your clipboard with cookie values, query strings
  and `Cookie` and `Authorization` header values masked, and reaches GitHub only if
  you paste it into the issue and submit it. **Report a bug** and **Suggest a feature** carry
  nothing about the pages you visit. GitHub's own privacy statement covers what you submit
  there.

## What it never does

It does not sell or transfer what it reads, use it for advertising, use it to determine
creditworthiness or for lending, or use it for anything other than showing you what a site
did with the signal.

## Changes

Changes to this policy are made in this repository, so each one is in its history, and the
date at the top says when it last changed.

## Contact

Open an issue on the project's GitHub issue tracker, or use the developer contact on the
store listing.
