# Contributing

Thanks for helping. Read three sections before anything else: what is accepted today,
just below, and then the project's two unusual, strictly enforced rules, which are easy to
trip over. The rest is ordinary.

## What is accepted today

Code from outside the project is not accepted for now: a pull request from outside the
project will not be merged. These are welcome:

- **Issues**: a bug, a question, a string that reads wrong.
- **"Finding looks wrong" reports**, from the extension's own report flow. They are the
  most useful thing you can send (see "Corrections become fixtures" below).
- **Data corrections**: a domain in the wrong category, a cookie name labeled wrongly, with
  the page where you saw it.
- **Security reports**, privately, as `SECURITY.md` describes.

If you have a fix in mind, describe it in an issue: what is wrong, where, and what the
change should do. Do not paste it as a patch or a diff; the fix is then written here, so
the code keeps a single owner. Translations are not being taken yet. There is no DCO or
CLA to sign while no outside code is merged.

**What happens to a report.** Every "Finding looks wrong" report is reviewed. A confirmed
correction is fixed in a release and noted in the changelog. Each report gets a first
reply within 14 days.

## Rule 1: The wording rule (enforced in CI)

**The website is never the subject of a verb about intent.**

This tool reports what was observed, never what a site "meant." A cookie coming back is a
fact; "the site ignored you" is a claim about intent this tool cannot support. The
distinction is the whole reason the project can make findings about large companies
without being dismissed.

The linter (`scripts/wording-lint.mjs`) runs in CI over
`packages/capture-extension/public/_locales` and fails the build on banned vocabulary. Run
it yourself: `npm run lint:wording`.

| Never emit | Emit instead |
|---|---|
| ignored, refused, defied, honored\* | returned, set, sent, was present, was not detected |
| violates, illegal, non-compliant, compliant | relates to the requirement described in §7025(c)(6) |
| sells your data | shared an identifier with a third-party domain |
| the site didn't show a confirmation | the extension did not find a confirmation notice on this page |
| tracking you, spying | set a cookie with a 2-year expiry |
| caught, exposed, busted | observed, recorded |
| known tracker (as our claim) | Category: Advertising · Source: <list> <date> |

\* "honored" may appear only inside an allowlisted locale key that quotes regulatory text
verbatim. That allowlist is tiny and reviewed; adding to it needs a reason in the PR.

The same linter holds each thing to one name (`TERM_RULES`): "GPC field" for the GPP
string's field and "GPC signal" for the browser's, "called the GPP consent API (__gpp)",
"US Privacy string" in a sentence, "tag container", "consent manager", "site", and "the
extension" or a passive for what was measured ("we" only in first run and feedback
strings). A vendor row's hover text says "this vendor" on a company row and "this domain"
on a domain the list names no company for.

The claim never exceeds the artifact. When a correction shows an artifact was sound but
the sentence overreached, the fix is the **sentence**, not the engine.

## Rule 2: The engine stays pure

The repo is four packages with hard boundaries:

```
schema   ← the versioned contract. Zero runtime dependencies.
engine   ← pure function: ObservationSet in, Finding[] out.
lists    ← classification data (Disconnect, Open Cookie Database, Public Suffix List), its own licenses, data-not-code.
capture-extension ← the only package allowed to touch chrome.*, the DOM, or the network. It also renders the popup.
```

**`engine` must not import `chrome.*`, touch the DOM, open the network, or read the
clock.** It is a pure function of its input, so the same engine runs in the browser and in
Node tests. A PR that reaches into a browser API from the engine will be sent back
regardless of how well it works.

Capture and engine communicate **only** through `@gpc-inspector/schema`. If the engine
needs a new fact, it gets added to the schema (a versioned change), captured by the
capture layer, and consumed by the engine. It is never smuggled across the boundary.

Code comments carry labels such as FR-17, NFR-10 or D4. They name requirements in a design
document that is not published; read each one as a stable label for the rule the comment
states.

## Corrections become fixtures

The highest-value contribution is a case where the tool is wrong. A "Finding looks wrong"
report contains a real `ObservationSet` and the finding it produced. A confirmed correction
becomes a test, public when it can be: the report's findings as a fixture in this
repository, with the site's own domain replaced by `first-party.example` and recipient
domains kept, or, when the case needs the recorded page itself, an entry in the
maintainer's private set of recorded pages, which is replayed before each release. Either
way, the same mistake is caught if it comes back. Someone telling us we're wrong is how we
stop being wrong that way again.

## Deletions are invisible to an archive

If you apply changes from an archive, note that unzipping can add or overwrite a file but
cannot delete one. A file removed upstream lingers locally: still compiled, still
referencing symbols that no longer exist.

This happened: an orphaned `packages/engine/src/rules/gtm-decision.ts` survived a deletion
and passed `npm run check` locally, because tsc's incremental build info considered the
project current. Only CI, running from a clean checkout, caught it.

`SOURCE_FILES.txt` is the authoritative list, and `npm run verify:manifest` (the first step
of `npm run check`) fails on any divergence in either direction: a file present but
unlisted, or listed but absent. After intentionally adding or removing files:

    node scripts/verify-manifest.mjs --update

## Ordinary parts

- **Node 24** (`.nvmrc`). `npm ci`, then `npm run check` (manifest, license lines,
  typecheck, tests, wording lint) is the full gate CI runs.
- **TypeScript strict**, and then some: `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, no unused locals or parameters. The config is deliberate.
- **No CSS framework**, no `eval`. `package-lock.json` pins every dependency; `package.json`
  gives ranges. `schema` and `engine` take no runtime dependencies at all.
- **Tests are Vitest**, colocated in each package's `test/`. New behavior needs a test;
  new findings need a fixture.
- **Rebuild before you look.** After any edit under `packages/capture-extension/src` or
  `public`, run `npm run build:ext --workspace packages/capture-extension` before loading
  the extension or taking a screenshot. Chrome loads `dist-ext/`, which is gitignored. The
  build compiles `schema`, `engine` and `lists` (`tsc --build`) first, because esbuild
  bundles each package's compiled `dist/`, not its source: a bundle from a stale `dist/`
  can pair new data with old code. `docs/TESTING.md` covers what to check after that.
- Commit messages: reference the issue. Small, reviewable PRs.

## Know what the capture cannot see

`docs/LIMITATIONS.md` lists the boundaries of what this extension observes. Read it before
adding a finding or writing a string that asserts an absence.

The recurring mistake in this codebase has been reporting "we did not see X" as "X did not
happen". Several gaps are structural (requests with no tab, requests from other tabs,
server-side tagging), and no amount of care in the rule that consumes the data will make
the data complete. If a new claim depends on the capture being exhaustive, it is wrong, and
the document says why.

## Changing anything visual

`docs/DESIGN.md` states what every color, weight, typeface and size means. Two rules carry
the most weight:

- **Amber means "look more closely here".** It marks a key finding. Never a value colored
  by what it says, never a ground, never "we could not look".
- **Accent means interactive or active.** Nothing else; emphasis is weight.

Run `npm run harness` before and after. The checklist in `docs/DESIGN.md` (§11) is what a
reviewer will ask.

## Refreshing the lists, at a release

Three lists ship inside the extension, and none updates on its own: nothing is downloaded
at run time. They are refreshed by hand at a release, by one person, and the diff is read by
a second. Do them together.

**Disconnect's list** (vendor categories, CC BY-NC-SA 4.0):

1. Replace `packages/lists/data/services.json` and `entities.json` with the current files
   from Disconnect's repository
   (https://github.com/disconnectme/disconnect-tracking-protection).
2. `npm run compile-list --workspace packages/lists`. It stops if either file has lost its
   license notice, and warns on a category it does not know: add one to `CATEGORY_MAP` and
   `CATEGORY_PRECEDENCE` in the script and to the engine's `CATEGORIES`, never map it onto
   another. One that describes a technique rather than a recipient goes in
   `TECHNIQUE_CATEGORIES` instead and is never shown.
3. Read the counts it prints against the last compile's, and the diff of
   `compiled-list.json`.

**The Open Cookie Database** (functional cookie names, Apache-2.0):

1. Pick the commit to move to, and see what it would change. This writes nothing:
   `npm run compile-functional-cookies --workspace packages/lists -- --commit <sha>`
2. Read the three lists it prints: entries added, removed or changed; names our overlay
   adds that the database now has, to take out of the overlay; and entries outside the
   filter that read like infrastructure. Take none of the last without reading the
   provider's own page, and add it to `src/functional-overlay.ts` with its reason.
3. Set `DATABASE.commit` and `DATABASE.csvBlob` in `src/functional-overlay.ts` to the two
   values the command printed.
4. `npm run build --workspace packages/lists`, then
   `npm run compile-functional-cookies --workspace packages/lists`.
5. If it stops on the database's license, a `NOTICE` file or a copyright line, do not work
   around it. A changed license means staying at the last Apache-2.0 commit; a notice or a
   copyright line has to be carried in `packages/lists/NOTICE` first.
6. Offer each name the overlay adds to the database as a pull request.

**The container owners' cookie names** (from the same database, Apache-2.0): the names each
tag manager's owner writes, which decide whether a cookie written inside a tag container is
counted. It is compiled from the commit the functional list pins, so it moves with it.

1. After the functional list's step 4, `npm run compile-owner-cookies --workspace packages/lists`.
   It makes the same license checks, and stops if the overlay takes a name the database
   does not have under the platform it names.
2. Read the entries it prints as added, removed or changed, and the additions the database
   now has, to take out of `src/owner-overlay.ts`.
3. Check each name the overlay adds against the provider's page it cites, and move its
   `checked` date. A name the page no longer lists comes out.
4. A company the classification list now names differently for a manager's host changes
   that manager's owner: `test/owner-cookies.test.ts` fails until `OWNERS` in the overlay
   agrees with the list.

**Then, for all three:**

1. `npm run check`.
2. `npm run build:ext` in `packages/capture-extension`, and confirm `dist-ext` has
   `LICENSE`, `NOTICE`, `LICENSES/Apache-2.0.txt`, `lists/LICENSE` and `lists/NOTICE`.
3. Commit the upstream files or the overlay together with the compiled file they produce.
   A compiled file whose source is not in the same commit cannot be checked.

A domain under the wrong company or category comes from Disconnect's list, and the
extension adds no mapping of its own: report it to Disconnect, and the change arrives here
with the next refresh. A cookie name labeled wrongly is a correction between releases, in
`src/functional-overlay.ts` or `src/owner-overlay.ts`, with the fixture that shows it
(above, "Corrections become fixtures").

## No analytics, ever

Do not add telemetry, usage counters, a crash reporter, an error beacon, or any ping that
carries version or configuration data. This is settled, and NON-GOALS.md gives the
reasoning. A pull request adding one will be closed with a link to it rather than debated.

The failure mode this guards against is not a deliberate decision to collect data. It is
drift: each individual addition is defensible, and their sum is a data collection program
nobody chose. If you believe there is a case, open an issue naming the specific question the
data would answer and why it cannot be answered from the store's own metrics or from a
"Finding looks wrong" report.

The extension makes exactly one network request of its own: a site's published
`/.well-known/gpc.json`, to the site being visited, controllable in Settings. Any code that
adds a second one needs to justify itself in the same terms.

## What not to send

The things in NON-GOALS.md. Blocking, verdicts, telemetry, regulator reporting. Those are
settled decisions, not open questions, and a PR implementing one will be closed with a
link rather than a review.
