# Integration corpus

The runner that takes the real extension across a list of sites before a release. Unit
tests and the harness never fire a `webRequest` listener; this is where the build meets
real consent tools, real tag managers and real ad stacks.

```
npm run corpus                                        # every site, a fresh throwaway Chrome
node fixtures/corpus/sweep.mjs --sites my-sites.json  # another list (see "The site list")
node fixtures/corpus/sweep.mjs --group <group>        # one group
node fixtures/corpus/sweep.mjs --only retailer-a.example,apparel-c.example
node fixtures/corpus/sweep.mjs --urls https://gpc-check.invalid/     # a page not on the list
node fixtures/corpus/report.mjs fixtures/corpus/runs/<name>   # rebuild summary.md for a run
node fixtures/corpus/gap.mjs fixtures/corpus/runs/<name>      # third-party cookies with no place on the Overview
```

Build first (`npm run build && npm run build:ext --workspace packages/capture-extension`);
the runner loads `dist-ext/`. It launches Google Chrome on a throwaway profile, loads the
extension over the debugging pipe (the route `fixtures/provenance/launch.mjs` established,
since Chrome 137 and later ignore `--load-extension`), opens each site in the foreground,
waits for the load plus a settle period (20 s by default, `--settle`; ad-heavy pages were
still setting cookies at 12 s), renders the popup
for that tab, then reads the tab's capture back from the service worker. The first run
(2026-09-25) took about 40 seconds a site; the runs of 2026-09-28 took nearer two minutes a
site, about two hours for 67 pages. The Chrome window takes focus for the whole run.

## What a run writes

Under `fixtures/corpus/runs/<timestamp>/` (gitignored; raw captures stay on the machine):

| File | What it is |
|---|---|
| `<host>.json` | The summary: signal counts, engine counts, findings by flag, vendors and their cookies, the strings, the popup's fields |
| `<host>.obs.json` | The ObservationSet, passed through the schema's `redact()` (cookie values, `Cookie` and `Authorization` headers and query strings masked) |
| `<host>.popup.txt` | The popup's overview as text |
| `<host>.popup.png` | The popup at 420 px, full height |
| `run.json` | Extension version, Chrome version, list version, settle time, the site list |
| `summary.md` | One table across every site plus a findings section per site |

The summary's counts are computed twice: in the worker (`gpcFindings`, the same path as
the badge) and again in Node from the ObservationSet with the engine and the classifier
that the popup uses. `workerBadgeCount` and `distinctCookiesSigned` should agree; so
should `workerFindings` and `findings.total`. A difference is a bug. The popup's headline is
compared with the worker's badge read just before and just after the popup, not with the
capture: an ad-heavy page is still setting cookies at the settle, and the capture is dumped
a few seconds after the popup is read. Cookies that arrived in between are listed on their
own line.

Another Chromium browser runs the same way: `CHROME="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"`
or the Microsoft Edge binary (both checked 2026-10-02). Edge sometimes loses the extension's
worker while a fresh profile starts up, so a worker that does not answer within 15 s gets a
fresh browser, up to three tries.

Run records and replay captures are kept by the maintainer.

## Cookies with no place on the Overview

`gap.mjs` reads a run's `<host>.obs.json` files and sorts each third-party cookie key a page
set by the place the Overview gives it: counted, a company's summary, a container's, a
domain's row, the first-party section, request lost, a probe, or not stored. The rest are
listed by why and by domain. It changes nothing and judges nothing. `ROOT=<checkout>` reads
the captures by another checkout's built packages; by default, this one's. A capture holds
only what its build recorded, so sweep the build you are measuring.

## Where this sits in testing

This sweep, in an automated Chrome, is the integration test. Live testing on a normal
profile stays in addition to it and is what a public claim rests on (a review reply, the
store listing). The two answer different questions: the sweep says the
build holds across many real sites at once; the live pass says what an ordinary visitor
sees on the few sites a claim names.

## Two things this Chrome is not

It is flagged as automated. Loading an unpacked extension needs the debugging pipe, and a
Chrome launched that way reports `navigator.webdriver` as true. Bot managers read it:
retailer-o and grocer-a (Akamai) answer the reload after their challenge page with a 403 and a 429,
while the same Chrome launched without the pipe gets both sites. Ad scripts that filter
automated traffic can read it too, so counts here may understate a real visit. A site that
served a challenge page is marked `blocked` in the summary and its row describes that page,
not the site. Confirm such a site once on a normal profile before anything from it becomes a
claim.

A DevTools session stays attached to the service worker for the whole run, which keeps
the worker alive. The "capture incomplete after a worker restart" path is not exercised
here; the MCP route in `docs/TESTING.md` is where that is checked by hand.

## Captures as regression fixtures

`packages/capture-extension/test/corpus-replay.test.ts` replays real captures from corpus
runs, each beside an `.expected.json`: the engine's findings, the counts and what the popup
would show, as reviewed. It runs every capture through the same engine, classification list
and view model the extension uses, and fails when any of it changes. The failure is either
a bug or a decision; for a decision, update the expected file with the test's `-u` flag and
review its diff like code.

The test reads the folder `CORPUS_CAPTURES` names, an absolute path or one relative to the
repository root, and `fixtures/corpus/captures/` when it names none. A checkout without
the captures skips the replay and says why; a folder `CORPUS_CAPTURES` names must hold
captures, so a wrong path fails.

```
CORPUS_CAPTURES=<folder> npx vitest run corpus-replay
node fixtures/corpus/add-fixture.mjs fixtures/corpus/runs/<run> <host> [name]
npx vitest run corpus-replay -u
```

`add-fixture.mjs` writes into the same folder. It drops request and response headers, which
neither the engine nor the view model reads, and refuses to write a capture whose findings
change without them. The captures are already redacted by the runner (cookie values,
`Cookie` and `Authorization` headers and query strings masked) and come from a fresh
automated profile, so they hold no one's browsing. The list version is recorded in each
expected file, so a Disconnect update shows up as a reviewed diff too.

## The site list

`sweep.mjs` reads the file `--sites` names. Without it, it reads `sites.json` beside the
script when that file exists, else `sites.example.json`, which shows the format. Each entry
has a `host` (what `--only` matches, and the run's file names), a `url` (the page opened),
a `group` (what `--group` matches) and a `why`: every site on a list says why it is there.
The list run before a release is kept by the maintainer, like the run records.
