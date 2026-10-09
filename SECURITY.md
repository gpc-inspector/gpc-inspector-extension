# Security policy

GPC Inspector reads every page you visit and adds a header to every request. A tool with
that reach has to be held to what it promises, and this file says how.

## What the extension promises

These are the claims a report can hold it to. Each is stated in the store listing, in
NON-GOALS.md, or in the popup itself.

- Nothing leaves the device. The extension makes exactly one network request of its own:
  reading a site's published `/.well-known/gpc.json`, sent to the site you are already on
  and controllable in Settings. Nothing is sent to us. There is no telemetry, no crash
  reporter, no update ping.
- While the signal is on, `Sec-GPC: 1` goes out on every request and
  `navigator.globalPrivacyControl` is `true` on every page.
- Exports marked redacted do not contain cookie values, credential headers or query
  strings.
- Nothing is blocked or modified beyond the signal itself.
- The extension reads the browser's cookie jar only for the cookies it saw a page set, by
  name and domain, to confirm they were stored. It never lists a site's cookies, and the
  value it reads is compared with the one the page wrote and dropped, never kept.

## What counts as a security issue

- Any way for data to leave the device other than the one request above.
- Any way for a page, a script on it, or a network response to change the extension's
  observations, its stored state, or what the popup shows about that page.
- The signal silently not being sent, or sent with a value other than `1`, while the
  popup says it is on.
- A report or an export that contains a value it is described as masking.
- Any path from the content scripts or the main-world scripts into the extension's own
  context.

Not security issues, and where they go instead:

- A site not honoring the signal is what the extension reports, not a fault in it. Use
  "Finding looks wrong" in the popup, or the issue templates.
- A domain classified under the wrong company or category comes from the bundled
  Disconnect list. Report it to Disconnect, or open a data-correction issue here.
- Anything listed in `docs/LIMITATIONS.md` is a known limit, not a vulnerability.

## How to report

Use GitHub's private vulnerability reporting on this repository: the Security tab, then
"Report a vulnerability". Do not open a public issue for something that could put users
at risk.

If you cannot use GitHub, write to the support address on the Chrome Web Store listing
and put "security" in the subject line.

Include the extension version, the Chrome version and operating system, the steps to
reproduce, and what you expected instead. A redacted export helps. Do not include real
cookie values, credentials, or anything from an account that is not yours.

## What to expect

- Acknowledgement within three working days.
- A fix released through the Chrome Web Store, whose review adds time we do not control.
  We will say when the fix is submitted and when it is live.
- Credit in the release notes if you want it. There is no bug bounty; this is a small
  project.
- We ask for a reasonable time to ship the fix before details are published.

## Supported versions

Only the current Chrome Web Store release is supported. Earlier versions receive no
fixes; update from the store.
