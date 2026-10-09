# Provenance fixture

A fixture page for the script-insertion observer (`script-insertion.ts`).
A page that inserts scripts by every path the observer must recognize, served on real
vendor hostnames so the classifier treats them as the vendors they name.

## Run

```
node fixtures/provenance/serve.mjs       # HTTPS on 443, self-signed cert made on first run
node fixtures/provenance/launch.mjs      # throwaway Chrome, extension loaded, hosts mapped
node fixtures/provenance/inspect.mjs     # what ran, and the extension's tab state
node fixtures/provenance/assert.mjs      # the record-level assertions below; --cmpwrap
```

`assert.mjs` re-captures the page and checks every case at the record level (method,
container frames, inline flag, currentScript resolution, parser records, coverage). Run it
plain, then navigate the tab to `?cmpwrap=1` and run it with `--cmpwrap`. Both are green
as of 2026-09-13.

Then open the popup on `https://provenance.localhost/`. `launch.mjs "?cmpwrap=1"` makes the
fake CMP wrap `appendChild` the way Osano and New Relic do on real pages. `inspect.mjs
--reload` re-captures from scratch; `--raw` dumps the whole tab state.

Why a Node launcher: Google Chrome 137 and later ignore `--load-extension` (verified on
152: accepted, nothing loads). The supported route is the DevTools command
`Extensions.loadUnpacked` over a debugging pipe, which `launch.mjs` holds. A TCP debugging
port is opened too, for `inspect.mjs`.

Why real hostnames: the classifier is a compiled list keyed on them, so invented ones
classify as unknown. The set is chosen so the engine sees advertising and analytics
vendors (Meta, Criteo, Permutive, The Trade Desk, Amazon, Comscore) and one functional
entity (OneTrust) for the chaining case. Why HTTPS: facebook.net, amazon-adsystem.com and cookielaw.org are on
Chrome's HSTS preload list, so Chrome upgrades them to https:// before any resolver rule
runs and a plain HTTP server never sees the requests. Why port 443 and not a high port: the
stack-frame URL regex stops at the first colon after the scheme, so a port in the URL
truncates every path. Why a separate Chrome: host resolver rules and ignoring the
self-signed certificate are launch flags, scoped to a throwaway profile.

## Expected record per case

`assert.mjs` encodes this table at the record level; the `expected loader` column is the
engine's resolution (`resolveLoaders` in `packages/engine/src/provenance.ts`) and is not
asserted here. `via` is the wrapped method. "site"
means the site's own inline snippet or file. One thing the records showed that the table
did not anticipate: an inline script inserted as an element (the Custom HTML cases) has an
anonymous frame with a position rather than the document URL, and is recognized as inline
by that.

| data-case | what happens | via | expected loader |
| --- | --- | --- | --- |
| parser | vendor script in the HTML | parser | site |
| gtm-loader-fix1 | standard snippet inserts gtm.js?id=GTM-FIX1 | insertBefore | site (inline, currentScript = parser element); graph root |
| gtm-loader-fix2 | second snippet, own dataLayer name | insertBefore | site; second graph root |
| appendChild … insertNode | FIX1 inserts one Meta path per method | each method | container GTM-FIX1 |
| fragment | FIX1 appends a fragment containing a script | appendChild | container GTM-FIX1 |
| custom-html-inline | FIX1 inserts an inline script | appendChild | (inline element record) container GTM-FIX1 |
| custom-html-sync | that inline script inserts Meta synchronously | appendChild | container GTM-FIX1 (gtm.js beneath on the stack) |
| custom-html-inline-deferred | FIX1 inserts an inline script that defers | appendChild | (inline element record) container GTM-FIX1 |
| custom-html-deferred | the deferred insertion fires | appendChild | undetermined (no container frame, currentScript null) |
| loader | FIX1 inserts a Meta loader | appendChild | container GTM-FIX1 |
| late-from-loader | the loader inserts more from setTimeout | appendChild | entity Meta, inheriting container GTM-FIX1 through the loader's record |
| importer | FIX1 inserts a script that dynamic-imports | appendChild | container GTM-FIX1 |
| (module.js) | the import fetches with no insertion | none | no record; undetermined |
| child-container | FIX1 inserts gtm.js?id=GTM-FIX1-CHILD | appendChild | container GTM-FIX1; graph edge FIX1 → CHILD |
| child-vendor | CHILD inserts Comscore | appendChild | container GTM-FIX1-CHILD, parent GTM-FIX1 |
| helper | FIX1 inserts a Google-hosted script with no id | appendChild | container GTM-FIX1 |
| friendly-iframe | FIX1 inserts an about:blank iframe | appendChild | container GTM-FIX1 (element iframe); its contents invisible until match_about_blank |
| fix2 | FIX2 inserts Criteo | appendChild | container GTM-FIX2 |
| site-inline-sync-vendor | site inline snippet inserts Criteo | appendChild | site (inline, currentScript = parser element) |
| site-inline-deferred-vendor | site inline snippet inserts from setTimeout | appendChild | undetermined |
| written | document.write of a Trade Desk script | write | site |
| cmp-release (gated) | text/plain script in the HTML | none | not recorded; counted as nonExecuting |
| cmp-release-live | the CMP clones it live | appendChild | entity OneTrust |
| site-file | site.js inserts Criteo | appendChild | site, file URL |
| cmp-script | site inline inserts the CMP | appendChild | site |
| after-pushstate | inline callback inserts Meta after pushState | appendChild | undetermined; inline frame recognized by the initial URL |
| subframe (frame.html) | inline script in a same-origin sub-frame inserts Meta | appendChild | site, frameOrigin the page's, topFrame false |
| in-friendly-iframe | inserted inside the about:blank frame | (none observed) | invisible: no content script runs in `about:blank` frames |
| pixel-from-fix1 … beacon-from-fix1 | FIX1 makes an image, fetch, XHR and beacon request | src / fetch / open / sendBeacon | request record, container GTM-FIX1 |
| pixel-from-site, xhr-from-site | the site's inline snippet makes a pixel and an XHR | src / open | request record, inline-only, undetermined (no currentScript for requests) |

Entity expectations, for the engine (`provenance.ts`): Meta has loaders {container GTM-FIX1} plus the
loader chain; Criteo has three loaders {site inline, site file, container GTM-FIX2} and
so is the mixed case; Permutive {parser, undetermined}; The Trade Desk {site via write};
Amazon {entity OneTrust}; Comscore {container GTM-FIX1-CHILD under GTM-FIX1}.

With `?cmpwrap=1`, every insertion after the CMP loads carries a `cdn.cookielaw.org`
frame beneath the extension's own. The wrapper-frame rule must remove it before any
resolution above holds; without the rule, most rows would read "entity OneTrust".

## What this fixture cannot do yet

Resolution into "loaded by X" is the engine's job (`provenance.ts`); the assertions here
stop at the record. The friendly iframe's contents stay invisible until the extension
injects into `about:blank` frames.
