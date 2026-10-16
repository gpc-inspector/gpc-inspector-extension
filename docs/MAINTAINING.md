# Maintaining GPC Inspector

How a report becomes an issue and then a fix, how a fix is checked and merged, and how a
release is made. CONTRIBUTING.md says what the project accepts from outside; this file says
what happens next. It is written for the maintainer and for anyone helping.

One maintainer reviews and merges every change. Code from outside the project is not
accepted for now: a pull request from outside the project will not be merged, as
CONTRIBUTING.md says. Some changes are drafted with AI assistance; every change goes through
the same pull request, CI and review.

## Intake

### Where reports come from

| Route | Template | Label it starts with |
|---|---|---|
| The extension itself misbehaves | `bug.yml` ("Bug") | `bug` |
| A finding about a site may be wrong | `looks-wrong.yml` ("Looks wrong"), also opened by the popup's "Finding looks wrong" | `looks-wrong` |
| Something the extension should do | `feature.yml` ("Feature request") | `enhancement` |
| A security issue | Not an issue: private vulnerability reporting (see Security) | None |

Blank issues are open too, for questions, a string that reads wrong, or a data correction.
The template chooser links NON-GOALS.md and the private security report form.

### Labels and milestones

| Label | Meaning |
|---|---|
| `bug` | The extension itself misbehaves |
| `looks-wrong` | A finding about a site may be wrong |
| `enhancement` | A feature request |
| `data-correction` | A domain, category or cookie name labeled wrongly |
| `documentation` | The docs are wrong or missing |
| `question` | A question, not a fault |
| `needs-info` | Waiting on the reporter |
| `confirmed` | Reproduced by the maintainer |
| `release-blocker` | Must be fixed before the next release |
| `duplicate`, `invalid`, `wontfix`, `non-goal` | Closed, with the reason in the label; `non-goal` links NON-GOALS.md |
| `dependencies`, `javascript` | Set by Dependabot on its own pull requests |

Milestones group the fixes meant for a release. "After 1.0.0" holds the fixes that waited
until 1.0.0 was released.

### From report to issue

Each new issue gets a label and a first reply. CONTRIBUTING.md states the promise for
reports, and it is the only one:

> Every "Finding looks wrong" report is reviewed. A confirmed correction is fixed in a
> release and noted in the changelog. Each report gets a first reply within 14 days.

An issue labeled `needs-info` with no reply in 30 days is closed, and it can be reopened at
any time. A report sent another way (the support address, a store review) becomes an issue
written from the code's side: what the extension does, what it should do, and how to see it.
Nothing personal from the original report is copied into it.

### What makes a "Looks wrong" report actionable

The report button fills most of it in:

- The page, in the Site field or the title.
- The extension version and the browser version.
- What the extension showed, and what the reporter expected instead.
- Optionally, the masked findings the report screen copies. Never a file saved with "Save
  log with sensitive information" (its name ends in `-sensitive.json`); one posted here is
  deleted.

A report missing the page or what was expected gets `needs-info`.

### From report to fix

1. Reproduce it on an ordinary browser profile with the same version. A result seen only in
   an automated browser is noted and kept open until it reproduces (docs/TESTING.md,
   "Limits").
2. Decide what kind of error it is:
   - **The capture or the engine is wrong.** Fix it, and keep the case as a fixture, as
     CONTRIBUTING.md "Corrections become fixtures" describes.
   - **The observation is right, and the sentence says more than it shows.** Fix the
     sentence, not the engine.
   - **A domain has the wrong company or category.** That comes from Disconnect's list: the
     report goes upstream, and the change arrives here with the next list refresh.
   - **A cookie name is labeled wrongly.** Fix it in `packages/lists/src/functional-overlay.ts`
     or `owner-overlay.ts`, citing the provider's own page.
   - **The extension is right.** Close the issue with what the capture shows.
3. Label it `confirmed` once reproduced, and add it to the next release's milestone.

## Changes

Every change lands in this repository as a pull request.

- **One change per pull request**, linked to its issue with "Fixes #N" in the description.
- **Branch names**: `fix/<topic>`, `feature/<topic>`, `docs/<topic>`, `data/<topic>`,
  `release/<version>`.
- **A test for every fix**: the test fails before the fix and passes after it. New behavior
  needs a test; a new finding needs a fixture.
- **Before merge**:
  - `npm run check` passes locally and in CI. The `check` job is required.
  - After any edit under `packages/capture-extension/src` or `public`,
    `npm run build:ext --workspace packages/capture-extension` before loading the extension
    or taking a screenshot. A change to what the extension observes is also checked on a
    live page, as docs/TESTING.md describes.
  - Any UI change: `npm run harness` before and after, with harness screenshots in the pull
    request. Screenshots of real browsing are not posted.
  - A string change: `npm run strings`, and commit the regenerated `docs/STRINGS.md`.
  - A file added or deleted under `packages/` or `scripts/`:
    `node scripts/verify-manifest.mjs --update`.
- **The maintainer merges**, by squash merge only. The pull request title becomes the commit
  subject, so it names the change. `main` takes no direct pushes and no force pushes.
- **Paths that never move**, because installed copies and the store listing link to them:
  docs/LIMITATIONS.md, NON-GOALS.md, PRIVACY.md, the three issue templates and their field
  ids. The default branch stays `main`.
- **Commit messages, pull request descriptions and code comments** are written for a reader
  of the history: what changed, why, and how it was checked. They state the rule a change
  follows and cite public issues and the documents in this repository.
- **A user-visible change** adds a line under "Unreleased" in CHANGELOG.md, in the same pull
  request.

## Security

Reports arrive privately through GitHub's private vulnerability reporting, as SECURITY.md
describes, and are acknowledged within three working days, as SECURITY.md promises. They are
never discussed in a public issue.

1. The fix is prepared in the private fork attached to the security advisory, or in the
   advisory's draft. Actions do not run there, so `npm run check` runs locally.
2. The fixed version is built and submitted to the Chrome Web Store with no public
   description of the flaw. The reporter is told when the fix is submitted and when it is
   live.
3. Once that version is live, the fix is merged, tagged and released, and the advisory is
   published with it. The release notes credit the reporter if they want it.

For the days between the store submission and the merge, the source of the store version is
not yet public. This is the one exception to the rule that every store version is a public
tag.

## Releases

### Versions

- `1.0.x` for fixes, wording and data refreshes.
- `1.x.0` for features: a new finding, a new screen, a schema change or any new permission.

The version in `packages/capture-extension/public/manifest.json` and in the root
`package.json` is the same. Tags never move; a mistake in a release becomes the next patch
version.

### Checklist

1. Everything for the release is merged, and no open issue carries `release-blocker`.
2. The lists are refreshed if due (see "Data list updates").
3. `npm run strings`: `docs/STRINGS.md` is current, and `npm run lint:wording` passes.
4. A pull request "Release X.Y.Z" on `release/X.Y.Z` bumps both versions and turns
   "Unreleased" in CHANGELOG.md into `## X.Y.Z (YYYY-MM-DD)`, with a new empty
   "Unreleased" above it. Merge it.
5. The release check across many real pages runs on the build of that commit. It is the
   maintainer's integration check. Any change in what the extension reports is explained in
   the changelog.
6. The built extension loads in Brave and in Edge, and the popup draws on a page in each.
7. A signed tag `vX.Y.Z` on the merge commit, pushed: `git tag -s vX.Y.Z -m "X.Y.Z"`.
8. The zip, built from the tag with the same steps as "Verify a release" in the README:
   1. `git clone --branch vX.Y.Z https://github.com/gpc-inspector/gpc-inspector-extension.git`
   2. In the folder, `nvm use`, `npm ci`, then
      `npm run build:ext --workspace packages/capture-extension`.
   3. In `packages/capture-extension/dist-ext`, zip the contents with `manifest.json` at the
      root of the zip: `zip -rX ../../../gpc-inspector-X.Y.Z.zip .`. The manifest has no
      `key` and no `update_url`.
   4. In the same folder, write the file list with SHA-256 hashes:
      `find . -type f | LC_ALL=C sort | xargs shasum -a 256 > ../../../SHA256SUMS.txt`.
      Each line is a hash and a path that starts with `./`.
9. A GitHub release for the tag, with the zip and `SHA256SUMS.txt`. Its notes are the
   changelog section, plus "Verify this build": the tag, the commit, and what each file is.
   Builds for testers are pre-releases tagged `vX.Y.Z-rc.N`.
10. The same zip goes to the Chrome Web Store. It is never rebuilt for the upload.
11. After the store publishes the version, the "Verify a release" comparison:
    1. Download the package the store serves for the extension's id
       (`niiahgnkkalkindhghjcaojcpbkhfbbp`), unzip it (unzip warns about the signature
       header; that is expected) and compare it file by file with the release zip.
    2. The only differences are the two the store adds: a `_metadata` folder with its
       signature, and an `update_url` line in `manifest.json`.
    3. A fresh build of the tag matches `SHA256SUMS.txt`.
    4. Record the date and the result in the release notes, under "Verify this build".

## Data list updates

Three lists ship inside the extension, and none updates on its own: nothing is downloaded at
run time. Disconnect's list gives the vendor categories; the Open Cookie Database gives the
functional cookie names and the container owners' cookie names; the Public Suffix List gives
registrable domains.

- **How a list is compiled.** The steps are in CONTRIBUTING.md, "Refreshing the lists, at a
  release". Each refresh is its own pull request on a `data/` branch, and commits the
  upstream files or the overlay together with the compiled file they produce.
- **How a change is checked before release.** The pull request shows the counts the compile
  prints next to the previous ones, and the diff of the compiled file is read by someone
  other than whoever made it. `npm run check` passes, and the release check across many real
  pages runs on the new build before the release that carries it. A changed list is noted in
  the changelog.
- **Attribution kept current.** When an upstream license, copyright line or notice changes:
  - `packages/lists/NOTICE` and `packages/lists/LICENSE`, which say which file is under
    which license.
  - The Credits group in Settings (the `aboutList` and `aboutFunctionalList` strings and
    their descriptions in `_locales`), and the credit line on the Overview (`listCredit`).
    The list's date and fingerprint are filled in from the compiled list.
  - A built extension carries `LICENSE`, `NOTICE`, `LICENSES/Apache-2.0.txt`,
    `lists/LICENSE` and `lists/NOTICE`; confirm them in `dist-ext` after the build.

  A compile that stops on a license, a `NOTICE` file or a copyright line is not worked
  around: a changed license means staying at the last commit under the old one.

## What never goes in this repository

Issues, pull requests, commits, fixtures and screenshots here never contain:

- Credentials of any kind: passwords, tokens, keys, signing material, store account
  details.
- Cookie values or other identifiers from real browsing. A fixture uses masked findings or
  made-up values, with the site's own domain replaced by `first-party.example`.
- Personal data from reports: a reporter's name, email address, account details, or a page
  that identifies them. A report that contains any of it is edited or deleted, and the
  issue keeps only what reproduces the case.

Issues and pull requests here are about the extension: what it observes, what it says, and
how it is built. A feature request is answered yes, no or not now, without a date.
