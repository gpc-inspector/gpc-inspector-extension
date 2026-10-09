# GPC Inspector

A Chrome extension that reports **facts** about how websites respond to the Global
Privacy Control signal: what your browser sent, what the site did with it, and what the
site broadcast about you to its advertising vendors. No verdicts, no scores, no legal
conclusions. Every finding is an artifact you can reproduce.

Install it from the
[Chrome Web Store](https://chromewebstore.google.com/detail/niiahgnkkalkindhghjcaojcpbkhfbbp).

## Why

Twelve US states now require businesses to honor a universal opt-out signal, and on
January 1, 2027, California's AB 566 requires browsers themselves to send one. Chrome will
send `Sec-GPC: 1` and tell you nothing about whether any site listened. This extension is
the missing feedback: it shows you, per page, what actually happened.

## Browsers

Chrome 114 or later, and the same build unchanged in Brave and Microsoft Edge. Brave sends
GPC itself, so there the popup says the signal is set by the browser and the extension does
not send a second header. Edge does not send it today, so it behaves as Chrome does.
Firefox and Safari are not supported.

## Architecture

Four packages, with hard boundaries (see CONTRIBUTING.md):

| Package | Role | Touches browser? |
|---|---|---|
| `schema` | Versioned contract: `ObservationSet` to `Finding[]`, evidence bundles, hashing | No |
| `engine` | Pure function from observations to findings | No |
| `lists` | Classification data: Disconnect's list, cookie names from the Open Cookie Database, the Public Suffix List | No |
| `capture-extension` | Signal, observation and the popup; the only package using `chrome.*` | Yes |

The engine has no browser dependencies, so the same engine runs in the extension and in
Node tests.

## Notices

GPC Inspector records what was observed on a page load. It is not legal advice.

A finding is an observation, not a legal conclusion. A page with no findings may still
share data in ways the extension cannot see.

GPC Inspector is independent and is not affiliated with the Global Privacy Control
project, Disconnect, or any regulator.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
See the GNU General Public License for more details.

Company names identify their owners only.

What the extension reads, where it stays and what can leave your device:
[PRIVACY.md](PRIVACY.md).

Parts of the code were written with AI assistance and reviewed by the maintainer.

## Licensing

- **Code**: all of this project's own code is **GPL-3.0-only** (`LICENSE`), copyright 2026
  GPC Inspector. That covers `schema`, `engine`, `capture-extension`, the tooling, and our
  own files in `lists` (`src`, `scripts`, `test`). Each source file carries an
  `SPDX-License-Identifier` line, which `npm run check` verifies.
- **Bundled data has its own licenses**, which the GPL does not replace:
  - The vendor categories are derived from **Disconnect's** list, under **CC BY-NC-SA
    4.0**, a *non-commercial* license. Bundling it makes the shipped extension
    non-commercial. `packages/lists/LICENSE` and `packages/lists/NOTICE` say which file is
    under which license, a built extension ships copies of both, and the popup credits the
    list.
  - The functional cookie names are compiled from the **Open Cookie Database**, under
    **Apache-2.0** (`LICENSES/Apache-2.0.txt`).
  - Registrable domains come from the **Public Suffix List**, under **MPL-2.0**
    (`packages/lists/data/public_suffix_list.dat`, `LICENSES/MPL-2.0.txt`).
- **The name and the icons are not licensed.** The GPC Inspector name and the icons in
  `packages/capture-extension/public/icons` identify this project's own releases. A build
  from this source goes out under its own name and icon. See `NOTICE`.

## Development

```sh
npm ci
npm run check      # manifest, license lines, typecheck (strict), tests, wording lint: the full CI gate
npm run test       # tests only
npm run test:watch
npm run harness    # every popup surface at 420px, and the side panel at four widths, in one page
npm run strings    # regenerate docs/STRINGS.md from the locale file
npm run build:ext --workspace packages/capture-extension   # the unpacked extension, in dist-ext
```

`npm run harness` renders each popup surface (both tabs, every empty state, the report and
settings screens) into a single contact sheet, driven by the real view model over fixture
captures. Use it before and after any UI change; `docs/DESIGN.md` states the system it is
checking against. `docs/TESTING.md` covers the harness, testing the built extension in a
live Chrome, and the integration corpus.

Node 24 (`.nvmrc`).

## Verify a release

Every store version is a tag here, and anyone can rebuild it.

1. Clone the tag: `git clone --branch v1.0.0 https://github.com/gpc-inspector/gpc-inspector-extension.git`
2. In the folder, use the Node version in `.nvmrc` (`nvm use`), then run `npm ci` and `npm run build:ext --workspace packages/capture-extension`.
3. The build is in `packages/capture-extension/dist-ext`. List its files with SHA-256 hashes and compare with `SHA256SUMS.txt` on the GitHub release for that tag.
4. To compare with what the Chrome Web Store serves, download the package for the extension's id, unzip it (unzip warns about the signature header; that is expected) and compare the folders. The store adds a `_metadata` folder with its signature and an `update_url` line to `manifest.json`; nothing else should differ. The release notes for each tag say what the comparison showed.

## Contributing

Code contributions are not accepted for now. Issues, "Finding looks wrong" reports, data
corrections and security reports are; CONTRIBUTING.md says how, along with the project's
two strict rules: the wording rule and engine purity. Scope boundaries are in NON-GOALS.md.

Every "Finding looks wrong" report is reviewed. A confirmed correction is fixed in a
release and noted in the changelog.
