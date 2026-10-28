# Known limitations

What this extension cannot see. Every entry here is a boundary of the capture, not a bug,
and each one is a place where a reader could take an absence for a finding.

---

## Requests we do not observe

### Requests not attributable to a tab

`onSendHeaders` skips anything with `tabId < 0`. That covers service worker fetches,
prefetches, speculative navigations, and requests made by other extensions.

This is not a rare edge. A modern publisher's service worker makes hundreds of requests, and
on one news site several hundred requests carried no `Sec-GPC` header precisely because
they came from that context rather than from the page.

**What it affects.** Request counts are understated. A cookie sent back on a service worker
request is not marked `sent back`. A vendor contacted only from a service worker does not
appear in the vendor list at all.

**Why it is skipped.** Without a tab there is no top-level site, so party classification —
first versus third — is undefined, and every downstream count depends on it. Attributing
such requests to the wrong site would be worse than omitting them.

### Requests from other tabs

State is per tab. A cookie set by `doubleclick.net` on one site and sent back to
`doubleclick.net` from a different tab on a different site is never joined up.

**This is the most consequential gap in the product**, because that pattern is exactly the
cross-site tracking the signal exists to opt out of. We observe one site at a time and can
say nothing about the join.

**What it affects.** No `sent back` on a cookie that is, in fact, being returned
constantly, just not from the tab being inspected. The panel never says a cookie was not
sent, for this reason.

### Requests after the capture window

Observations live in service worker memory, and MV3 reclaims an idle worker after roughly
thirty seconds. Ad slots refresh minutes later; those returns are real and outside what we
saw. A worker restart loses the request list, and the Requests tab says so. Since
2026-09-30 (schema 1.27.0) the requests that set a cookie are kept past it, at most 2,000 a
tab, and the tab lists them again with the note that the rest were dropped. What is kept
of each: the URL without its query, the method, type, status, whether it carried Sec-GPC,
and each cookie's name and attributes. Not its headers, and no cookie value. These records
are the first thing dropped when session storage runs short: another tab's before the
page's own, and the page's own before any count. The note then says only some, or none, are
listed, as it does when the extension stopped before it could save the last of them. A
request that set no cookie is not kept. Since
2026-09-27 (schema 1.22.0) nothing else is lost with an idle reclaim: the counts, the
findings, the vendor judgments and the cookies in each vendor's panel are all kept in
session storage as requests arrive, so the Overview is the same before and after one and
shows no notice for it. A worker that ends while it still has changes to write (a crash,
not an idle reclaim) can lose up to a fraction of a second of events. A small marker in
session storage records that it was mid-batch, and the next worker reports that capture as
a failed save, which the Overview does say.

**A response that reaches the next worker.** A request can go out before a reclaim or a
restart and its response arrive after, at a worker that never saw the request. Until
2026-09-29 its Set-Cookie was dropped unread. Now the response is kept, and each cookie it
set is listed by name, marked "request lost", under whoever set it: in the vendor's panel,
the domain's row in "No company found for this domain", or the First-party cookies section.
It is counted nowhere. Whether the request carried the signal was not observed, and a
cookie count that guessed would be a claim about a visit nobody saw. The request itself was
counted by the worker that saw it go out. The Requests tab lists the response with "request
lost" in place of the signal mark. A row whose only cookies came this way reads "cookies
set, request lost". Reproduced on 2026-09-29 by crashing the worker during a 45-second
response (automation profile); an idle reclaim loses the same list and was not observed
directly.

---

## Behavior we cannot attribute

### Which vendor made a consent check, inside a container

A Tag Manager container runs vendor code inside its own context, so the JavaScript stack
resolves to `gtm.js` (or `gtag.js`) and the vendor has no frame of its own. We can see that
a check happened and cannot say whose it was.

**Resolved into five states, not left as one collapsed bucket.** This used to render as a
single `no attributable check`, spanning three different situations — the vendor never
looked, the vendor looked through a container we cannot see past, and the vendor was never
meant to look because Consent Mode already decided for it — presented identically, which
was accurate and close to useless. `vendor-signal-check` (engine/rules/) now distinguishes:
a vendor whose own script ran directly and made no call (`GPC Not Read`), one whose script
ran on a page with a container that itself made zero GPC-bearing calls page-wide (`GPC Not
Read (via tag manager)`), one on a page whose container(s) made calls attributable to no one
in particular (`Cannot determine (via tag manager)`), and one that never ran a script the
question could apply to at all (`Not applicable`).

**Two mechanisms, since 2026-09-04.** A vendor can check for GPC either by calling the GPP
consent API or by reading `navigator.globalPrivacyControl` directly, and both now count.
Until then only GPP calls did, so a vendor using the mechanism the GPC specification itself
defines for scripts was reported as not having read GPC.

**Read attribution is traced up to a cap.** Identifying who read the property means
capturing a JavaScript stack, which costs a few microseconds per read; some pages read it
thousands of times (one produced about 1,900 reads on a single load) and a script can poll
it in a loop. Every read is traced up to a cap of 5,000, then one in 16, then none at 7,000
captures (since 2026-09-28; the cap was 2,000 from 2026-09-14, and Osano's pages passed it
once Osano saw every page write). The page-level read COUNT is exact and complete whatever the
cap. On a page that stays under it, every read was traced and a vendor's "no read
observed" means exactly that, subject to the attribution failures below. On a page that
went past it, the popup says so under the read count and under each no-read vendor, and
turning "Limit GPC read tracing" off in settings removes the cap for the pages that follow.

**Which container, and which loader, since 2026-09-13.** A read's stack names the
container it resolved into (`gtm.js?id=GTM-ABC`), so reads are counted per container, and
the page's insertion stacks say which container or script inserted each vendor's script.
A vendor whose loaders all resolved is judged by its own loader chain rather than by the
page as a whole: the container that inserted it, the wrapper or site script that
inserted it, and, for Consent Mode, any container on the page (Consent Mode is one
page-wide store shared by every container, verified live). A container above the one
that inserted it is not a loader of it: a tag manager passes no value from a parent
container to a child, so a child container is judged like any container and a parent's
read is shown as context under the vendor, not as a read on its behalf. The help text
under each vendor says which loader and by which route. Since 1.25.0 the Tag containers
section says per container whether a tag in it read GPC, what was written inside it, who
loaded it, and which containers it loaded. A read made by a vendor's script running inside
a container is traced through 10 stack frames, where insertions use 64, so a read deep in a
container can keep its vendor and lose its container.

**Requests that never touch the DOM, since 2026-09-13.** Pixels, `fetch`, XHR and beacons
are recorded with the stack that made them, by the same rules, so a pixel-only vendor
gets a loader line. A request made from the site's own inline snippet carries no frame we
can name and stays undetermined. Whether an XHR to a vendor's domain counts as that
vendor's own execution is still decided the way it was: every XHR counts. The records can
say who made it, but a vendor's script served under the site's own hostname (New Relic's
agent, on two of five measured pages) looks like the site, and excluding it would call the
vendor's own execution a stranger's.

**Vendors judged from the counts, since 2026-09-14.** The list of individual requests is
held in the extension's background process, which Chrome reclaims after about 30 seconds
idle; the counts persist. So a vendor can be in the counts with no request left to point
at. The counts now carry a small per-vendor summary, the resource types seen and whether
the vendor's own code ran, maintained as requests arrive, so such a vendor is still judged
and its panel still lists its resource types. Since 2026-09-27 (schema 1.22.0) the
summary also records the first request and the first proof the vendor's code ran, and the
counts keep each cookie's attributes (expiry, SameSite, partitioned), so a vendor's finding
names the same request and its panel lists the same cookies after a restart. Only the
request-level detail on the Requests tab is lost, and that tab says so; since 1.27.0 the
requests that set a cookie stay listed, without their headers. Attributes are kept
for every cookie the headline counts, signed or not; past 1,000 cookies per tab, other
cookies keep their counts and show by name alone. A bundle recorded before these fields has
them derived from its requests when it is read. A bundle recorded before the summary
existed shows "Not captured" for such a vendor, as before.

**With REQUIRE_XHR_FROM_OWN_FRAMES on (it is off), a reclaim can soften a vendor's state.**
Whether an XHR was the vendor's own is decided per request from the initiator records, and
the summary cannot keep that. With the flag on, a vendor whose only evidence of running was
an XHR reads "no script observed" after a reclaim: the state that accuses nobody.

**One cookie finding per cookie, since 2026-09-27.** A cookie set on a request that carried
the signal is one finding, however often it was set: an ad slot refreshing every 30 seconds
re-sets the same cookie, and a finding per Set-Cookie event measured dwell time. The
findings now number what the headline counts. The finding names the first signed request
that set the cookie, and is the redirect variant when any signed set of it came on a
redirect hop.

**What still does not resolve.** Within one container, which TAG made a read: every tag
in a container runs from the container's single script, and no tag id appears on the
stack. Whether any given tag acts on Consent Mode. A consent tool in one container gating
tags in another purely by dataLayer trigger events, which is invisible. A value one
script read and pushed into the dataLayer for another container's tag to consume as a
variable, which is the one way a parent container's read can reach a child's tag, and
which is not observed. A tag manager
served under a renamed path, which reads as a first-party script. A script that defers its
insertion into a callback from an inline snippet, which carries no frame we can name and
stays undetermined, never "loaded by the site".

### A vendor's check made before our interception installs

`interceptConsentApi` (observe/consent-api.ts) installs an accessor on `window.__gpp` /
`__uspapi` / `__tcfapi` at `document_start`, which solves a CMP defining the API LATER (the
file's own "late-definition problem"). It does not solve the opposite: a script that calls
an ALREADY-DEFINED api in the brief window before our own script has run. Two content
scripts declared for the same run time have no guaranteed order (see content/protocol.ts),
so another extension, or an inline script the browser happens to execute unusually early,
could in principle call a consent API before we have wrapped it.

**What it affects.** A vendor's check made in that window is invisible to us and reads as
`vendor-did-not-read-gpc` rather than as a check we know we missed — unlike the read-counter
race that motivated the STATE_EVENT request/response protocol, there is no equivalent fix
here: a consent-API call cannot be replayed without re-invoking the page's own callback a
second time, which the "never alter what the page sees" rule in consent-api.ts forecloses.

### Checks made from a Web Worker or Service Worker

`interceptConsentApi` wraps a property on `window`, in the page's document context.
`__gpp`/`__uspapi`/`__tcfapi` are conventionally exposed there, but nothing prevents a
vendor's script from running its own consent-check logic inside a Worker or Service Worker
and reporting the result back via `postMessage`, without the wrapped property ever being
called.

**What it affects.** Such a check would be invisible to us entirely — not misattributed,
simply never observed, the same category as the "no tab" and "other tab" request gaps
above. We are not aware of a live CMP that does this today; it is documented because the
interception model makes it structurally possible, not because it has been observed.

### Google Consent Mode is read from an undocumented store

A container template can set consent through `setDefaultConsentState` and
`updateConsentState`, which never touch the `dataLayer`. So the Google Consent Mode row in
Privacy strings reads Google's own consent store, which holds the state by every route, a
template's included: on 9 of 35 corpus pages with a Google tag and no consent command, the
store held values the commands never showed (2026-09-28). The store is an undocumented
internal of Google's tags, read behind a check of its shape. When it cannot be read, the
row falls back to the commands seen on the `dataLayer`, and a template's consent is then
missing; when neither can be read, the row says "could not be read", never "not set".

The row does not say who set a consent type, or whether a value came from a default or an
update. A sender is known only for a command seen on the `dataLayer` with a stack, which is
most often not the case for the default (10 of 12 corpus pages), and a line naming one
sender would read as the sender of every value. A consent type a site adds to the store of
its own is kept in the record and not shown.

The store also covers a `dataLayer` the capture did not find: a renamed `dataLayer`, on a
site that serves Tag Manager from its own path with no query string. The capture also takes
`dataLayer` names from `window.google_tag_manager`, where each running container reports
its own, and looks for them for a minute after the page loads.

### Server-side tagging

Entirely invisible. A site can forward everything from its own server and the browser sees a
single first-party request.

---

## Cookies

### Values are never part of a report

By design (FR-24). Findings rest on names, domains, paths, and attributes, never on a value,
so we cannot tell a persistent identifier from an empty or deleted cookie beyond what the
attributes say. The value is held in memory while the page is open. The bundle in a "Finding looks
wrong" report masks it, together with `Cookie` and `Authorization` header values and the
query string of every request, frame, and script URL (a tag manager's `id=` is kept). No
setting turns that off. The path of a URL is kept.

"Download findings" opens a screen with three buttons. Each saves one file on your device,
and a line under each says what the file holds. Nothing is saved until a button is pressed.
"Save summary (Markdown)", the primary button, saves what the Overview shows and never holds
a value. "Save log (JSON)" saves the record a report carries, masked the same way: every
request, cookie names and attributes, and addresses without query strings (a tag
container's id is kept). Its `redacted` field says `redacted`. Only the third button, "Save
log with sensitive information (JSON)", saves values: the same record with nothing masked,
so cookie values, `Cookie` and `Authorization` header values, and full addresses with their
query strings. Its file's name ends in `-sensitive.json` and its `redacted` field says
`unmasked`. The button pressed decides which file holds values; no setting does. Each file
is handed to the browser, which does not tell the extension whether it was saved or its
save dialog was cancelled, so the buttons say nothing afterward and can be pressed again.
The browser's own list of downloads shows what was saved.

### Which cookie in a returned `Cookie` header belongs to whom

The header is a flat list. We match returned names against names we saw that entity set, so
a cookie set before the capture began — on an earlier visit — is not counted as returned even
when it is.

The header also carries names only, never the domain each cookie was set for. A vendor's
panel marks a cookie `sent back` when its name went back to the vendor and its domain covers
one of the vendor's hosts, the rule the browser sends cookies by. A cookie of the same name on
the page's own site, which a vendor's script can write, is never sent to the vendor's domains
as a cookie and is not marked. Two cookies of one name on two of the vendor's own domains are
both marked once the name went back, if each covers one of the vendor's hosts: which host the
name went back to is not kept.

### Cookie writes that set nothing

Three kinds of write are not counted as cookies set, because the browser keeps nothing
from them:

- **A write the browser refuses.** A script looking for the widest domain it may use writes
  `domain=.com` before `domain=.site.com`, and Chrome refuses the first. A script write
  counts only when its Domain is the writing frame's host or a parent of it, and is not a
  public suffix by the Public Suffix List, its private section included (`myshopify.com`,
  `github.io`), as Chrome's own check is. Until 2026-09-29 the check used a short table of
  the extension's own, which let a company's suffix through. `Set-Cookie` response headers
  are not checked this way: the request host alone does not settle it.
- **A cookie the browser did not store (1.30.0).** A moment after each counted cookie is
  written, the extension looks it up in the browser's cookie jar by its name and domain. When
  the jar holds no cookie of that name and domain, the cookie is never counted. Measured
  2026-09-30 (automation profile): 10 of 190 counted cookies on six sites
  were never stored. Most broke a rule the browser applies to a
  cookie's attributes: a third-party cookie with no SameSite (taken as Lax), SameSite=None
  without Secure, a Lax cookie written in a cross-site frame. One came on a response to a
  request sent without cookies, which nothing on the request shows. What the check does not
  settle: a jar holding the name with another value (an older write's, or a later one's) is
  counted as before; a check that could not be made, or that the extension's background
  process did not live to make, leaves the cookie counted; and a cookie removed between the
  write and the check reads as not stored unless the removal itself showed the cookie was
  there (see "A cookie that is removed again still counts"). Once a cookie is found in the
  jar on a page, later writes of it are not checked again.
- **A deletion.** A cookie record whose expiry is at or before the moment it was written
  (`max-age=0` included) removes a cookie. It is kept as evidence and never counted.
- **A write test.** A cookie a script writes through `document.cookie` and removes again
  in the same task was a test of whether writing works (`cto_tld_test`,
  `criteo_write_test`, `lotame_domain_check`, `__cheq_tld_<time>`). A task is one turn of
  the browser's event loop: the script and the promise callbacks it queues, with no timer,
  network callback or other script able to run in between, so no cookie is left. The page
  reports the pair as a test, and the write is never counted. It goes by the task and never by the time between the two: a cookie removed in a
  later task, however soon, was set. The end of a task is marked by a task the extension
  queues at the first write, so a removal made by a task the page had queued before that
  write can fall on either side. A test made through the
  `cookieStore` API completes in a later task and is not recognized as one: its cookie is
  counted when the jar check finds it, and listed as not in the jar when it does not.

Both are shown, as not counted, in the vendor's panel: "Written and removed (not counted)"
for write tests and "Not in the browser's cookie jar (not counted)" for refused writes and the cookies the
jar did not hold, against the vendor
whose request or script made them, or against the domain in "No company found for this
domain" where the list names no company for it (1.26.0). A refused write whose script
resolves to neither is counted per tab as a diagnostic only.

### A cookie that is removed again still counts

A cookie the browser stored counts from then on, whatever removes it afterwards: a script
on a timer, a response that clears what an earlier response set (a server testing whether
cookies are kept does this with `test_cookie`), or a consent tool clearing up. The count is
of what was set while the signal was on, and the extension does not judge what a cookie was
for, so some counted cookies carry no identifier. No span of time turns a removal into "not
set": responses clear cookies from tens of milliseconds to seconds after another set them,
so any span chosen would make a count depend on how fast a page loaded.

Such a cookie's line in a panel says it was removed, and how long after its last set
("removed after 3s"). That is recorded only where the removal was seen with the cookie
present:

- a script's removal through `document.cookie`, when a cookie of that name was readable in
  the document just before it. An HttpOnly cookie is not readable, and a cookie of the same
  name on another domain or path of the site reads as present.
- a response's removal, when the request it answers carried a cookie of that name.

A removal seen with neither (a response that clears a name its request did not carry, or a
`cookieStore.delete`) is not recorded as one. For a cookie still waiting for its jar check
this means the check decides: the jar no longer holds it, so it reads as not stored and is
not counted. The time of a response is its request's, so for cookies set and removed by
responses "how long after" is measured between the two requests.

### A count only rises, about a second behind the page

A cookie is shown nowhere until the first jar check of its name and domain answers: not in
a count, not in a vendor's panel, and not on its request in the Requests tab. The check runs
about a second after the last write of that cookie, so the numbers trail the page by that
much while it loads. In exchange no number shown is ever taken back: a cookie the browser
did not store is never shown, and a cookie that was counted stays counted. A check that
cannot be made shows the cookie unchecked. If the extension's background process is
replaced while cookies wait, they are shown unchecked too, and the capture is already marked
incomplete for that reason.

### The first-party section lists the site's cookies by who set them

The Overview's First-party cookies section (1.26.0) holds the cookies charged to the site:
set by its own responses, or written by scripts it serves from its own domain. A cookie on
the site's domain written by a third party's script is that third party's, and is listed
under it, not here, even when the site's own responses set it too. The keys set on requests
that did not carry GPC are listed with the others, and marked while the signal was on. What
the section cannot do:

- **Advertising or analytics is the list's word for the host.** The first list holds the
  cookies written by a script the site serves from a host of its own that Disconnect puts in
  advertising or analytics. A site's own analytics bundle on a host the list does not carry
  is in the second list.
- **Cookies written inside a tag container are not here.** A container the site serves from
  its own domain is still a container: what is written inside it is listed under Tag
  containers only.
- **Script writes need the cookie interceptors.** When cookies written by JavaScript could
  not be observed on the page, an empty first list reads "not observable", and the second
  list holds only what the site's responses set.
- **Limits.** Each list keeps up to 200 names on signed requests and 200 on unsigned ones; the
  names the site's advertising or analytics scripts wrote on signed requests are the
  headline line's own keys and are not capped. A full list is noted after it.
- **Older captures show no section**, and keep the line under the headline that counts the
  cookies written by the site's advertising or analytics scripts. Nothing in the section is
  counted, and the headline does not move with it.

### A script write with no writer found is charged to its frame

A cookie written by a script is charged to the script that wrote it, found from the
JavaScript stack. When the stack names no script with a web address, the cookie is charged
to the frame that wrote it: in the top frame or a frame on the site's own domain that is
the page, and the cookie is first party; in a cross-site frame it is the frame's host,
since a script there can only write its frame's own domain. The usual cause is script text
another script inserted, run from a callback with nothing named beneath it: its frames
carry no address, and stepping over a wrapped insertion method leaves nothing named either.
Code run through `eval` is not a cause, since its frames name the script that called it.
In the top frame this can charge a vendor's inserted snippet to the site. On the Requests
tab, such a write's "Written by" line gives the page's or the frame's address, not a
script's.

Until 2026-09-29 a cross-site frame's write was charged to the page as well. That case was
not seen: in 87 saved captures from the 2026-09-25 corpus runs (10,327 script-written
cookies, 135 with no writer found) and 11 pages loaded live, no cookie written with no
writer found was on a domain other than the site's, so the change moved no count there.
All of it was on automation profiles, and the captures predate the 2026-09-28 change to
how the writer is found. The frame's host comes with each write from the content script;
the saved capture does not keep it, so the check used the cookie's domain.

An `about:blank` frame filled by script, a `srcdoc` frame and a `blob:` frame run under the
origin of the document that made them, and a write there is charged as one in that
document's frame.

### A cookie listed as functional is still counted

Vendors run their endpoints behind load balancers and bot protection, and those services
add cookies of their own on the vendor's hostname: Akamai's `akaalb_` on `apps.rokt.com`,
Cloudflare's `__cf_bm` on `t.co`, AWS's `AWSALB` on several. To the extension that is the
vendor setting a cookie, and it is counted. On the 2026-09-25 run of 60 sites, 21 of 733
counted cookies were of this kind, on 11 sites, and one site's whole count was one of them.

A counted cookie whose name is on a list of such names is labeled "listed as functional",
with a small server icon: under the count, in the vendor's row and panel, and on the
Requests tab. What the label does and does not say:

- **It never removes a cookie from the count.** The extension judges no cookie by its
  value, so a name is all it has to go on, and a name is a string any vendor can reuse. A list that
  removed cookies by name would let an identifier named `AWSALB` leave the count.
- **It is by name alone**, case-sensitive, exact or by prefix. No test of the domain, the
  value or the attributes. A bot-protection cookie's purpose is to tell clients apart, and
  the label does not say otherwise.
- **It says "listed as", never "is".** The list is the Open Cookie Database, compiled into
  the extension at a recorded commit and changed by this project: only the entries of
  infrastructure providers are kept (its Functional category also holds cookies of
  advertising platforms), `SERVERID` is dropped because operators choose their own name
  for it, and seven names it lacks are added from the providers' own pages. Settings,
  Credits names the list, the commit and the license.
- **Counted cookies only.** A site behind Cloudflare sets its own `__cf_bm`, which is
  listed too and is no part of the count; the label's "still included in the count" would
  be false of it, so it carries none. The same for a vendor in a category that does not
  count.
- **Some deployments show no label.** An operator can rename a load balancer's cookie
  (`BIGipServer`, `INGRESSCOOKIE`, Akamai's), and a renamed one matches nothing. Akamai's
  `bm_sz` is not listed: no page of Akamai's was found that states its purpose.
- **Nothing is downloaded.** The list is compiled at a release and ships inside the
  extension. An exported report records which list produced a label.

### A cookie written inside a tag container counts only when its name is the owner's own

A tag container runs other companies' code inside itself, so a cookie written by a tag in
Google Tag Manager, the Google tag, Tealium, Adobe Launch or another manager resolves to
the container's script, not to the company whose tag wrote it. Since 1.25.0 such a cookie
counts only when its name is on a list of the container owner's own names (Google's `_ga`
and `_gcl_au` inside a Google container, Tealium's `utag_main` inside Tealium's), under
the owner, in the category the list gives the name. Any other is recorded with the
container as its writer, shown on the container's row in the secondary color, and counted
nowhere. What that means:

- **An undercount, on purpose.** `AMCV_*` written inside a Tealium container really is
  Adobe's identifier, and it is not counted. A name is never used to charge a cookie to a
  company other than the container's owner: a name is a string any vendor can reuse, and
  charging by it would put a site's own cookie of the same name on a vendor. The same
  cookie written by Adobe's own script, loaded by the container or not, counts under Adobe
  as before.
- **A name is charged only inside its owner's container.** `_ga` written by a Tealium tag
  is not Google's by this rule.
- **The owners.** Google owns Google Tag Manager and the Google tag, and Adobe owns Adobe
  Launch; the classification list names nobody for their hosts. Every other manager's owner
  is the company the list names for its host. The list of names is compiled from the Open
  Cookie Database and the providers' own pages (Tealium's and Segment's names, which the
  database lacks); Ensighten publishes no page naming its cookies, so only CHEQ's two names
  are listed for it. Settings, Credits names the list.
- **A container served from the site's own domain counts nothing**, the owner's names
  included: the party is the writer's host against the site, as for every cookie.
- **No tag is named.** Which tag inside a container wrote a cookie, read GPC or sent a
  request is not observable: a container's tags are not named in its file, and reading the
  file would take a request of the extension's own.
- **The count moved with this rule.** On 67 corpus pages (2026-09-28, automation profile)
  33 keys left the count on 6 sites and 84 entered on 26.

### Partitioned cookies are counted like any other

Deliberate, and recorded in NON-GOALS terms rather than as a gap. A `Partitioned` cookie is
keyed to the top-level site and cannot build a cross-site profile, which is a real
difference — but whether that difference makes a disclosure lawful is a legal conclusion no
regulator has published. Excluding them would encode that conclusion in a `filter()`. The
attribute is reported and the reader decides.

---

## Who counts as a third party

### A site is its registrable domain, by the Public Suffix List

First party means the same registrable domain as the page, and a row with no company is
keyed by its registrable domain. Both come from the Public Suffix List
(https://publicsuffix.org), bundled whole since 2026-09-29, its private section included:
two stores under `myshopify.com`, or two customers of `akamaihd.net`, are two sites, as
they are to Chrome's own cookie rules. Until then a short table of the extension's own
grouped such customers under the provider's name, and a site hosted under a suffix it
lacked had every other customer's host counted as first party. What remains:

- **The list is bundled, not fetched.** It is the version the extension was built with, and
  a suffix added to the list since then is not known until the next release.
- **The list says nothing about ownership.** A company's own domains on different
  registrable domains (a site and its content domain) are still two sites; the vendor list
  shows the second under "No company found for this domain".
- **The Requests tab's groups follow the same list,** so a provider's customers are
  grouped per customer, sometimes under hostnames that are only a hash.

### A top-level redirect is judged against the site it lands on

Whether a cookie is first or third party depends on the site of the page. A navigation that
redirects (a link shortener, an email or ad click tracker, a sign-in flow) does not know
that site until it commits, and until 2026-09-29 each hop was judged against the
navigation's first URL. Reproduced on an automation profile: a tracker on one site
redirecting to another, setting a cookie on the redirect, had its cookie filed as the
landed site's own, and the landed site's own cookie filed as a third party's. Now the
main frame's requests and responses wait for the commit and are counted against the site it
reports, the redirect hops' cookies included. A redirect within one site (to https, or to
www.) was never affected.

What this cannot do:

- **A navigation that never commits** (a download, a response with no content, a network
  error) counts nothing of its main frame: there is no site to judge it against.
- **More than 20 redirect hops.** The hold is bounded; hops past it are counted as they
  arrive, against the first URL's site, as before.
- **A worker that crashes mid-navigation** loses what was held with the request list. An
  idle reclaim cannot happen then: the navigation's own events keep the worker running.

None of the 87 saved corpus captures (2026-09-25) redirected across sites at the top level:
the sweep loads each site's own address. So the corpus shows no count movement; the case is
how people arrive at a page, not what the sweep does.

### A site's own company can count as a third-party ad or analytics vendor

"Third-party" in this extension means a **different registrable domain** from the page, the
same meaning a browser gives it. It does not mean a different company. When a company serves
ads, consent tools or analytics from a domain other than its site's, those domains count
as third-party ad or analytics vendors on its own site, and their cookies go into the headline.

Seen on 2026-09-22:

| Site | Counted as a third-party ad or analytics vendor | From |
|---|---|---|
| yahoo.com | Yahoo!, including its consent cookies `EuConsent`, `gpp`, `gpp_sid`, `cmp` | `consent.cmp.oath.com` |
| amazon.com | Amazon | `amazon-adsystem.com` |
| ebay.com | eBay | eBay's advertising domains |
| tiktok.com | Bytedance | `tiktokv.us`, `tiktokcdn-us.com` |
| reddit.com | reddit | `redditstatic.com` |
| aliexpress.us | AlibabaGroup, until 2026-09-25 (see below) | `alicdn.com` |

**What the extension does about it.** The counts are unchanged. When the company that
Disconnect gives as the owner of the current site is also one of the page's advertising or
analytics vendors, the popup shows a neutral notice above the count. A row for the owner in
another category, such as Content, does not raise it: the notice explains a count, and those
rows are not counted. It names that company and what Disconnect
categorizes its request domains as: an advertising vendor or an analytics vendor when they
are all one, an advertising and analytics vendor when they are some of each (Bytedance on
tiktok.com), and says its
other domains will continue to be categorized that way. The owner comes from
Disconnect's entity list (the `properties` each company owns), not from the site's own
category: Disconnect files yahoo.com, amazon.com and reddit.com as Content, so a category
test would miss them.

**How the Requests tab shows these domains.** The same classifier, with no special case.
The site's own domain is first-party, listed first, and labeled with the owning company
(for example "Yahoo!"). The company's other domains are third-party with Disconnect's
category: advertising for `consent.cmp.oath.com`, `amazon-adsystem.com`, `tiktokv.us` and
`redditstatic.com`. They carry the same company name and appear under the "advertising"
and "third-party" filters.

The aliexpress.us row no longer occurs. Disconnect files the `alicdn.com` hosts under
FingerprintingInvasive and nothing else, and until 2026-09-25 the list compiler mapped that
category onto analytics, which is why AlibabaGroup was counted there. Those hosts now carry
no category (see Categories below): shown under "third-party" and "uncategorized", not
counted, and a vendor row under "Uncategorized", outside the count. AlibabaGroup is counted
only where one of its advertising or analytics domains, such as `cnzz.com`, is contacted.

**Why the extension does not decide this.** Under the CCPA as amended by the CPRA, opting
out with GPC covers selling and sharing (Cal. Code Regs. tit. 11, §7025), and both are
defined as making personal information available "by the business to a **third party**"
(Cal. Civ. Code §1798.140(ad), (ah)). Whether one company's domain is a third party on its
own site turns on facts this extension cannot see:

- **Common branding.** The "business" includes an entity it controls or is controlled by
  **and** shares common branding with: "a shared name, servicemark, or trademark" that the
  average consumer would understand as common ownership (§1798.140(d)(2)). Disconnect groups
  by ownership alone. Its "Yahoo!" entity includes techcrunch.com and engadget.com, and
  "Google" includes youtube.com. Whether those share common branding is exactly the question
  the statute asks, and a domain list cannot answer it.
- **Distinctly branded sites.** Cross-context behavioral advertising is defined by activity
  across "distinctly branded internet websites, applications, or services" (§1798.140(k)),
  so ownership alone does not settle whether a use across one company's sites is covered.
- **Contracts.** A service provider or contractor is not a third party (§1798.140(ai)).
  Whether any vendor, same-company or not, acts under such a contract is invisible on the
  wire.

So the headline's "third-party" is a statement about domains, and the notice says so rather
than drawing a legal conclusion in either direction. This is not legal advice.

---

## Categories

### Every category is Disconnect's, under Disconnect's name

A request's category in the Requests tab is the one Disconnect's list gives its domain,
under Disconnect's own name: Advertising, Analytics, Social, Content, Email, Email
Aggressive, Consent Managers or Anti-fraud. A domain Disconnect gives no category shows none
and is listed under "uncategorized" (the word was "unclassified" until 2026-09-29). That
includes a domain Disconnect names an owner for and nothing else: techcrunch.com shows the
vendor Yahoo! and no category.

Three rules are this extension's own, because a request shows one category and Disconnect
gives some domains several:

- **Which category wins.** Advertising, then Analytics, then Social, Email, Email
  Aggressive, Consent Managers, Anti-fraud and Content.
- **A technique is not shown.** Disconnect has three categories that describe a technique
  rather than a recipient: FingerprintingInvasive, FingerprintingGeneral and Cryptomining.
  The extension leaves them out. A domain Disconnect also gives a purpose shows the
  purpose, and a domain it lists only under a technique shows no category (next section).
- **A listed parent's category reaches the hosts under it.** Disconnect matches by suffix.
  A host listed only under a technique category takes the purpose of a listed parent
  (`edge.fullstory.com` under `fullstory.com`, Analytics), and a host listed only as a
  company's property takes its nearest listed parent's category (`apps.fbsbx.com` under
  `fbsbx.com`, Social).

Which categories count is the product's line, not Disconnect's: only Advertising and
Analytics drive the cookie count, and each has a filter on the Requests tab. The others are shown
and never counted.

### Every company is Disconnect's too

The extension names a company for a domain only where Disconnect's list does, and it adds
no mapping of its own. The override file (`packages/lists/src/overrides.ts`) ships empty.
A domain Disconnect does not carry is shown by its domain, with no
company and no category, whoever operates it.

That includes domains whose operator looks plain from what they serve. A script that writes
cookies under a vendor's documented names shows that the vendor's library ran. It does not
show who operates the host: the library can be served from a site's own domain or another
company's. Naming a company changes that company's count and its Read GPC state, so the
extension leaves the naming to the list.

### A domain with no company is shown by its domain, and claims no owner

A third-party cookie from a domain Disconnect names no company for is listed in the vendor
list's last group, "No company found for this domain" (1.26.0), one row per registrable
domain. Until then no summary kept such a cookie and it had no place on the Overview: about
16% of the third-party cookie keys on the 2026-09-28 corpus. What the row does and does not
say:

- **No owner.** The domain may be the site's own content domain under another name
  (`retailer-d-static.example` on retailer-d.example), a vendor the list does not carry, or a known company's
  domain the list does not name. The heading and the row say none of these, and nothing in
  the group is counted.
- **Charged by who set it.** A cookie belongs to the host that set it: the responding host,
  or the host of the script that wrote it, never the cookie's own Domain attribute. A
  script from such a domain writing on the site's domain puts the cookie under the domain.
  A script write whose writer was not found is charged to the page, and is first party.
- **Read GPC per domain.** The row's state is judged per registrable domain as a company's
  is per category: its GPP calls, its sampled reads, whether its code ran, and who loaded
  it. It is not a statement about any company that may operate the domain.
- **Limits.** The worker keeps up to 200 such domains that only made requests (a domain
  that set a cookie, set and removed one, or wrote one the browser did not store is always
  kept), up to 200 cookie keys per domain on signed requests and 200 on unsigned ones, 20
  hostnames and 20 names each of write tests and refused writes. A panel whose domain held more
  keys than that says so at the end of its cookie list.
- **Older captures show no group.** Which domain is third party with no company is the
  list's answer, and a capture from before 1.26.0 did not keep the domains' summaries, so
  the group is not rebuilt for it. The engine judges no domain in such a capture either.

A domain whose only cookies were set on requests without the signal, while it was on, has a
row, as a company does (since 2026-09-30; until then it had none, and those cookies no place
on the Overview). The row lists the cookies set on requests that carried the signal, so it
reads "cookies set, request without GPC" in their place, a company's row too; the panel
lists them, each marked.

Known gap: **a domain whose scripts read GPC and set nothing.** It
has no row, and is named on the Read GPC row's "Also scripts from" line, as a domain with no
company always was.

### A vendor is a company in one category

Since 2026-09-26 the vendor list has a row for each company in each category it has
third-party domains in on the page, in every category, and the engine judges whether its
script read GPC once for each row. Microsoft with `bat.bing.com`, `clarity.ms` and
`www.bing.com` on a page is three rows: Advertising, Analytics and Content, each with the
requests, the cookies and the Read GPC state of that category's domains. A company
Disconnect names as the owner of a domain and gives no category has a row under
"Uncategorized". A domain with no company has a row of its own in the last group, "No
company found for this domain" (see the section on those domains, above).

Until then a row was a company, judged once from its advertising and analytics domains
together, and no other category had rows. Judged as one company, a script from a company's
Content domain that ran and read nothing would have put that company's advertising pixel
under "No read observed": a statement about one product made on the strength of another.
Google documents its own handling of the signal product by product, and every endpoint
receives `Sec-GPC` on its own requests, so a read by one product is no evidence about
another.

What this cannot do:

- **The category is the domain's, so it stands in for the product, and not always well.**
  `googletagmanager.com` is in neither Disconnect file and serves analytics and advertising
  code alike: a read from it stays with the container, under no company. Meta's pixel hosts
  are Social in Disconnect's list, so a read by the pixel is "Meta (Social)", on a row the
  headline does not count.
- **A row outside Advertising and Analytics lists cookies that are not counted.** They are
  drawn in the secondary color, and the names under the headline leave them out.
- **A script-written cookie is attributed to the script on the stack.** A consent tool that
  wraps `document.cookie` can be credited with a write that passed through it, and its row
  then lists cookies that read as the site's own. The same can happen to a counted vendor.
- **A capture recorded before this** has one tally for each company. Its rows are the
  categories its cookies and hostnames give it, each with the company's one state and the
  company's one count of requests.

The "Read GPC" row names each vendor with its category, "Microsoft (Analytics)", and lists
every one. A domain Disconnect names no company for that has a row is named by its domain on
the same lines. Scripts that read GPC and belong to no row are named by their domain on a
line under it, "Also scripts from": the site's own scripts, whether or not Disconnect names
an owner for the site, and scripts from domains Disconnect names no company for that have
no row, which are often the site's consent tool.

Until 2026-09-25 the extension merged and renamed several of these. Content was labeled
"Content delivery", with a translator note saying it was not tracking. Email, Email
Aggressive, Consent Managers and Anti-fraud were one "Functional", and both fingerprinting
categories were counted as analytics (next section).
None of those words was Disconnect's. Content in particular says nothing about serving
files: it is the part of Disconnect's list for domains Disconnect considers trackers but does
not block by default, for compatibility or because the company made a public commitment
about its data use. amazon.com, instagram.com, youtube.com and 192 google.* domains are in it.

### A domain Disconnect files only under a technique shows no category

Disconnect's two fingerprinting categories describe a technique, not a recipient. Their
definition of a fingerprinter is one that identifies a browser or device from its
properties "without using client-side storage of cookies or other data", and the list
applies the categories beside a purpose category (Advertising, Analytics, Social) where it
has one. Cryptomining is a technique in the same sense. For 228 hosts a technique is all
the list says, 195 of them fingerprinting and 33 cryptomining: hosts Disconnect lists under
CHEQ, under Amazon (`*.awswaf.com`) and under AlibabaGroup (`*.alicdn.com`), and
single-domain entries.

Those hosts show no category, which counts nothing, and the extension does not say that
Disconnect lists them as fingerprinting or cryptomining. A cookie one of them sets on a
signed request is not in the headline, and the Requests tab shows the host under
"third-party" and "uncategorized" with the company Disconnect names. The company has a
vendor row under "Uncategorized", with the cookie in the secondary color, outside the count.

From 2026-09-25 to 2026-09-27 these hosts carried Disconnect's name for the technique
(Invasive fingerprinting, General fingerprinting, Cryptomining) as their category.

Until 2026-09-25 the list compiler mapped both categories onto analytics, so these hosts'
cookies were counted and the vendor list called them analytics domains, a classification
Disconnect never gave them. The same mapping ranked fingerprinting above Social, which
turned Meta's pixel hosts (`facebook.com`, `facebook.net`, Social and FingerprintingGeneral
in Disconnect) into analytics domains too. They are Social now, which the headline does not
count, so Meta is under the headline only where one of its advertising domains is
contacted, and has a row under Social wherever its pixel is.

---

## The published GPC file

### Subdomains

We request the file from the origin of the top-level document. A site that publishes at
`shop.example.com` while the user browses `example.com` shows nothing, and the spec expects
each subdomain handling personal data to host its own.

### A cached reading may be stale

Cached per site and read again periodically. A site can retract the file at any time, so
a cached reading carries its observation date, and the `declared-honor-cookie-set` finding
requires a current reading: one fetched during this navigation, or a recent cached one. An
older reading is still shown and the finding does not fire, so on a long visit the finding
can disappear from a site's later pages. The file is not fetched again to prevent that: a
request on every page would let a site recognize the extension.

---

## The signal itself

### The toolbar icon on pages we cannot observe

The icon is blue when a GPC signal was set as the page loaded — the page property reads
`true` or the request that fetched the page carried `Sec-GPC` — whoever set it: Chrome,
this extension, or another one. It is gray when nothing did. It holds that state until
the page is reloaded: changing the sending setting changes what later requests carry, but
not what this page's scripts and cookies already ran under, so the icon waits for a load
it can describe — the same rule the status row states as "reload the page to apply". That reading comes from the content scripts,
and there are pages Chrome never runs them on: `chrome://` pages, the Web Store, the
built-in PDF viewer, the new-tab page. On those the icon shows the extension's own
setting instead. Once Chrome sends the signal natively, a user who has turned this
extension's sending off will see a gray icon on those pages while Chrome is in fact
sending. Every ordinary page reports for itself and is unaffected.

### Another extension that replaces the page property later

With "Lock the GPC page property" off, the default, this extension's
`navigator.globalPrivacyControl` stays redefinable, so another extension never breaks on
it. An extension whose script runs later on the page can replace it, and page scripts then
read that extension's value while this extension's `Sec-GPC` header still goes out. The top
document looks again at `DOMContentLoaded`, when the page has loaded, and four times in the
six seconds after: from the first look that finds it replaced, the popup names another
extension as the owner with the value pages read, and says reads could not be observed,
since they no longer reach this extension's counter. Reads counted before the replacement
stay counted. A replacement after those looks is not noticed. A definition on
`Navigator.prototype` changes nothing: this extension's property is on `navigator` itself
and shadows it.

### Sites the browser keeps the extension off, and private windows

The browser decides where an extension may act, and this extension cannot change that.

- **Site access.** In the extension's details on the browser's extensions page, Site access
  can be "On click" or "On specific sites" instead of "On all sites", and an administrator
  can block hosts by policy. On a site left out, the browser applies no header rule and
  runs no content script, so no `Sec-GPC` header goes out and the page property is not set.
  The browser also reports none of that page's requests to the extension. The popup says
  the extension was not allowed on the site when the page loaded, and shows nothing else for
  it. With "On click", clicking the extension's icon allows it on the site in that tab, and
  a reload then sends the signal. The popup cannot tell that a click allowed it: the
  browser's answer covers the site's setting, not the tab. While Site access is limited, the toolbar icon is gray on a tab that has not
  reported, and Settings says the signal is sent only on some sites.
- **Private windows.** The browser runs an extension in private windows (Incognito in
  Chrome, InPrivate in Edge) only once the reader allows it there, in the same details
  page. Until then nothing is sent in private windows, and the extension has no popup there
  to say so. Settings says it instead.

### Pages that did not load

When the top document fails to load (no network, a name that does not resolve, a
certificate error, a page another extension blocked) Chrome shows its own error page, and
no content script runs there. Since 1.31.0 the popup says the page did not load and shows
only what this extension was sending; the few requests made before the failure are kept on
the Requests tab and are not a description of the site. Chrome retries a failed load on its
own shortly after, and a retry that fails again ends as an abort; the popup keeps saying the
page did not load until a page commits.

### We cannot see whether a vendor acted on it

We observe that `Sec-GPC: 1` was sent and that a cookie came back. Whether the recipient
processed the signal, ignored it, or honored it through a mechanism we cannot see is
outside what a browser can observe.

### A confirmation notice may exist where we cannot look

Since 2026-01-01, California's 11 CCR §7025(c)(6) says a business "must display whether it
has processed" the opt-out preference signal "on its website" (it said "may" before). A
second rule, §7026(g), adds a means to confirm the opt-out in the consumer's privacy
settings, such as a toggle or radio button; that one can sit behind a sign-in or a settings
page this scan never visits. The scan is top-frame text on the current page only, which is
why the only claim it makes is "not found on this page".

The top frame's text includes what web components draw in open shadow roots: each open root
is read where its host stands, in the order the reader sees, and watched like the rest of the
page. A closed shadow root cannot be read from the page, so a notice inside one is not seen;
nor is one inside a frame. At most 1,000 open roots are read on one page; a page with more
has the rest unread. A root is found when its host is inserted, when a custom element's
definition loads, and at each scan; a root attached later to an element already on the page,
with neither, is found at the next scan, if one runs.

The page is scanned as it loads and then watched for changes for as long as it stays open,
so a notice that appears later, in a privacy settings dialog the reader opens for example,
is seen. The watch ends at a match. It also stops once the page has been hidden for a
minute, as in a background tab, and starts again when the page is visible: a notice still
on the page then is seen, and one shown and removed while the watch was stopped is not.

A single-page app that changes its route without loading a new page keeps the same visit:
the extension's record of the tab is not reset. A notice that appears on a later route
counts for that visit, and a notice seen on an earlier route stays listed after the route
changes, whether or not the new route shows it.

Since 1.31.0 a detected notice is also one of the two statements the
`declared-honor-cookie-set` finding rests on, beside the published file: a page that showed
it while ad or analytics cookies were set on signed requests carries the finding, whenever
the cookies came relative to the notice. The detector matches text, so a false match puts a
wrong "yes" on the row and rests the finding on a notice the page never showed; its
false-positive rate is a release gate.

### The notice is matched by its wording, and no regulator fixes the wording

No regulator prescribes what the notice says. California's "Opt-Out Request Honored"
follows "For example", and the Agency's statement of reasons for the 2026 amendments calls
the subsection an example that "does not reflect all factual scenarios". Colorado allows the
same display without requiring it (4 CCR 904-3 Rule 5.08(E), "may"), with "Opt-Out
Preference Signal Honored" as its example. No other state privacy law we checked asks for a
display at all (checked 2026-10-01: Connecticut, Oregon, Texas, Minnesota, and New Jersey's
proposed rules). So each site writes its own phrase, and the detector recognizes only the
phrases seen on real pages or documented by a consent tool as the text it shows. A notice in
new words reads as "not found" until a pattern is added for it, and this list will need
adding to as more examples turn up. Patterns 1 and 2 date from the first version and had not
matched a corpus page as of 2026-10-27.

The phrases matched today (`CONFIRMATION_PATTERNS` in
`packages/capture-extension/src/observe/consent-data.ts`, case ignored, "opt-out" with or
without the hyphen or space):

| # | Matches | Seen as |
|---|---|---|
| 0 | "opt-out request", "request signal", "preference signal" or "signal", then optionally "has been" or "was", then honored, processed, received or applied | "Opt-Out Request Honored", "Opt-Out Signal Honored", "Opt-out preference signal honored.", "Your Opt-Out Preference Signal Has Been Honored", "Opt-Out Request Signal Honored" |
| 1 | "your opt-out preference" or "request", "has been" or "was", then received, processed or applied | not yet on a corpus page |
| 2 | "we processed", "received" or "honored your opt-out" | not yet on a corpus page |
| 3 | "Global Privacy Control" followed within the same sentence by detected, received, honored, processed or applied | "Global Privacy Control" over "Opt-Out Preference Signal detected and honored"; "GLOBAL PRIVACY CONTROL signal detected and applied." (Didomi's documented badge). "We've received your Global Privacy Control (GPC) signal" puts the verb first, so it does not match |
| 4 | "browser opt-out", optionally "has been" or "was", then honored, processed, received or applied | "Browser Opt-Out Honored" |
| 5 | "your opt-out preference choice(s)" with are, is, has been or have been, then honored, processed or applied | "Your Opt-Out Preference Choices Are Honored" |
| 6 | "opt-out signal" or "opt-out preference signal", then "was" or "has been", then detected | "Your browser's opt out signal was detected; your choice to opt out of targeted online advertising has been honored" (a page that shows it only with the signal on) |
| 7 | "GPC", optionally "signal", optionally "has been" or "was", then honored, processed, received or applied | "GPC Honored" |
| 8 | "GPC signal detected" or "GPC enabled and detected" | "GPC signal detected" (also Didomi's documented badge), "GPC Enabled and Detected", "GPC signal detected and applied" |
| 9 | "GPC opt-out preference honored" | "GPC opt-out preference honored" (a consent dialog that shows it only with the signal on) |
| 10 | "opt-out preference signal detected and honored" | "Opt-Out Preference Signal detected and honored" (a privacy settings page that shows "not detected" with the signal off) |
| 11 | "The GPC signal is honored" as a sentence of its own | "The GPC signal is honored", "The GPC signal is honoured." (Usercentrics' documented text) |
| 12 | "your opt-out preference signal is honored" ending the sentence | "Your Opt Out Preference Signal is Honored" |
| 13 | "opt-out signal is being honored" | "Opt-Out Signal is being honored" (Osano's published text) |
| 14 | "your opt-out signal is active and being honored" or "and respected" | "Your Opt-Out Signal is active and being honored by this site", "Your Opt-Out signal is active and respected by this site" (Osano's published text) |
| 15 | "your global privacy preferences have been applied" | "Your global privacy preferences have been applied." (Termly's documented text) |
| 16 | "your opt-out preference signal (GPC) has been honored" | "Your opt-out preference signal (GPC) has been honored." (iubenda's published text) |
| 17 | "your opt-out preference has been honored" | "Your opt-out preference has been honored." (CookieYes's published text, shown after any opt-out) |

Never matched: a control's state, such as "Do Not Sell or Share: On". It is the separate
§7026(g) setting, a consumer can switch it on without any signal, and it does not say the
signal was processed. Also never matched: wording without a word that ties it to the signal
or to the reader's own choice, such as a bare "opt-out honored", or a promise in policy copy
("will be honored", "requests are processed within 15 business days", "if an opt-out signal
is detected, we will").

A negation never counts, for any pattern: "not", "never" or "n't" inside the matched words
("Opt-Out Preference Signal not detected", "was not received", and pattern 3's span from
"Global Privacy Control" to the verb), or "no" or "not" right before them on the same line
("No Opt-Out Preference Signal has been detected."). Consent tools show such a line when the
signal did not arrive, sometimes under the same "Global Privacy Control" heading. After a
negated match the scan goes on to the next match of the same pattern.

Lines 0 and 17 also match a line that answers an opt-out the reader made by hand, such as
"Your opt-out request has been honored.", since they name the reader's own choice and not
the signal. On a page where the reader also opted out by hand, the quoted line can answer
that opt-out rather than the signal.

A phrase is added only when all of these hold:

1. It appears on a real page with the signal on and not with it off, checked on the live
   site, or a consent tool documents it as the text it shows once the signal is honored.
2. The pattern is no wider than the phrasings seen; wider wording waits for a page that
   uses it.
3. Unit tests cover each phrasing, its near misses and its negations (`consent.test.ts`,
   "confirmation notice scan").
4. A corpus run on the new build (`npm run corpus`) detects the new phrasing and finds no
   new detection elsewhere; any new one is checked against the live page the same way.
5. A new pattern goes at the end of the list, so a `patternIndex` already recorded in a
   report keeps its meaning, and this table is updated with it.

A new pattern is charged to the same false-positive release gate as the rest, since a
detected notice carries a finding.

---

## What Chrome reports about us

### Page console messages attributed to this extension

With "observe how scripts are loaded" on, `main-world-insertion.js` wraps the page's
insertion methods (`Node.prototype.appendChild`, `insertBefore`, `document.write` and the
rest, in observe/script-insertion.ts) and its request entry points (`fetch`,
`XMLHttpRequest.prototype.open`, `navigator.sendBeacon`, `HTMLImageElement.prototype.src`,
in observe/request-initiator.ts). Every wrapper hands the call straight to the original.
But the wrapper is then the JavaScript frame on the stack while the browser carries out the
page's request, and Chrome attributes a console message to whichever script is executing
when it is logged. A message the page earned therefore appears under this extension in
chrome://extensions, with our wrapper named as the stack frame.

Two are common on ad-heavy pages. "Blocked script execution in 'about:blank' because the
document's frame is sandboxed and the 'allow-scripts' permission is not set" is ad code
inserting a script into a sandboxed friendly iframe it created. "A speculation rule set was
inserted into the document but will be ignored" is a page building a `speculationrules`
script through `innerHTML` and appending it. Both were reproduced with the built bundle,
and both appear, worded identically, with the wrappers absent. Only the attribution changes.

**What it affects.** Nothing the extension records. The page behaves as it would without
us, and the wrappers swallow their own failures, never the page's. What changes is
appearance: the Errors panel on chrome://extensions fills with the page's messages, which a
reviewer or a user can take for faults in the extension. There is no way to keep a wrapper
off the stack while it wraps, so the choice is to carry this note, or to register the
observer for the top frame only and give up provenance inside ad frames. Turning the setting
off removes the wrappers and the attribution with them. Each wrapper's hand-off line carries a
`/*! GPC Inspector ... */` note saying exactly this, kept in the built file so that a reader
who expands the entry in chrome://extensions sees the cause and the setting without opening
the repository. One footnote for whoever reads the panel: Chrome keeps its entries until "Clear all" and shows the source of the file now on
disk, so after a rebuild the line it displays may belong to a different build.
