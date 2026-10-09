# Testing

`npm run check` is the gate CI runs: the source manifest, the license lines, the
typecheck, every unit test and the wording lint. It never draws the popup or loads the
extension in a browser. Three tools go further, each for a different question:

| Tool | What it runs | Use it for |
|---|---|---|
| `npm run harness` | Every popup surface, from fixture captures | Any visible change |
| Chrome DevTools MCP | The real extension on one real page, in a throwaway Chrome | A question about one page |
| `npm run corpus` | The real extension over many pages, unattended | A check before a release |

## Rebuild before verifying

After any edit under `packages/capture-extension/src` or `public`, run
`npm run build:ext --workspace packages/capture-extension` before loading the extension,
taking screenshots, or committing. `dist-ext/` is gitignored and is what Chrome actually
loads.

`build:ext` and the harness compile `schema`, `engine` and `lists` (`tsc --build`) before
bundling, because esbuild inlines each package's compiled `dist/`, not its source. A bundle
from a stale `dist/` can pair a new compiled list with old code.

Chrome keeps running the copy it last loaded. After a rebuild, reload the extension
(`chrome://extensions`, or `reload_extension` below). A stack frame that does not match the
source usually means the new build was never loaded.

## The harness

`npm run harness` serves a contact sheet at `http://localhost:8731/` (set `HARNESS_PORT` for
another port). Every popup surface is drawn at 420px by the real view model and renderers
over fixture captures, and the side panel at 320, 360, 420 and 600px. One surface on its own:
`popup.html?fixture=<name>`.

This is where every popup surface is checked against a known view model. Open it before and
after any change to `popup.css`, `popup.html` or the renderers, and check a change to the
panel at all four widths. `docs/DESIGN.md` is the system it is checked against. A narrow
browser window is not a substitute for the panel frames: a device emulation that narrows the
window also lays the page out as a phone would, at 980px.

## The real extension in a live Chrome

The unit tests' Chrome fake registers `webRequest` listeners but never fires them, and the
harness draws fixtures, so neither runs the extension against real traffic.
[Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) does. It
launches its own Chrome (Chrome 144 or newer) on a throwaway profile, and an MCP client,
such as an AI coding assistant, can install the unpacked extension there, open real pages,
and read the network, the console, the popup and the extension's service worker.

### Setup

Register the server with your MCP client. For a client that reads a project `.mcp.json`:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": [
        "-y",
        "chrome-devtools-mcp@1.10.1",
        "--categoryExtensions=true",
        "--categoryPerformance=false",
        "--isolated",
        "--viewport=1280x900",
        "--no-performance-crux",
        "--no-usage-statistics"
      ]
    }
  }
}
```

Pin an exact version, as above. With `@latest`, `npx` runs whatever version was published
that day. `--categoryExtensions=true` turns on the extension tools, and `--isolated` gives
each session a fresh profile. Keep the file local and out of commits.

### Each session

1. Build the extension (see the rebuild rule above).
2. `install_extension` with the absolute path to `packages/capture-extension/dist-ext`.
   The profile is isolated, so this is needed once per session.
3. `new_page` to the target site. Then `list_network_requests` filtered by URL substring
   (never the full list on an ad-heavy page), `get_network_request` to confirm `Sec-GPC`
   and `Set-Cookie`, `list_console_messages` for content-script output, and
   `evaluate_script` to read `navigator.globalPrivacyControl`, `__gpp` or `__tcfapi`.
   Reading `navigator.globalPrivacyControl` that way goes through the extension's counting
   accessor: it adds one read whose stack holds only the extension's frames and `pptr:`
   frames, which the popup reports as a script that could not be identified. Read the value
   from the worker's `gpcDump()` instead, or do it after the capture you are checking.
4. After a rebuild, `reload_extension` with the ID from `list_extensions`.

### The popup, the worker and the side panel

- **The popup.** `select_page` the target tab with `bringToFront`, then
  `trigger_extension_action` with the extension ID. The real popup for that tab appears in
  `list_pages` under "Extension Pages" as `popup.html`, and `evaluate_script` and
  `take_screenshot` work on it. On a fresh profile the first-run disclosure shows first;
  click its button. The popup page closes on `reload_extension`, so trigger it again and
  list the pages again.
- **The worker.** `sw.js` is listed under "Extension Service Workers". `evaluate_script`
  with its `serviceWorkerId` reads `chrome.storage.session`, the dynamic rules and the
  registered scripts. After a reload the old worker ids stay listed; use the newest.
- **The side panel.** With the popup open, `click` its "Open in side panel" button: the
  popup closes and the panel appears under "Extension Pages" as `popup.html?host=panel`.
  `list_pages` can take a second call to show it. The panel follows the active tab, so
  `select_page` with `bringToFront` on another tab changes what it shows;
  `chrome.runtime.getContexts({})` in the worker lists it as `SIDE_PANEL`.
- **An install or an update.** `reload_extension` with a tab left open reproduces what an
  install or an update does to that tab: session storage is cleared and the new content
  scripts are not injected. That is the case behind the "reload the page" notice.

### Limits

- The harness is still where every popup surface is checked against a known view model, and
  where the side panel is drawn at its four widths. The live popup shows one real page at
  a time, and the live panel one width.
- The launched Chrome is flagged as automated, and consent managers and ad stacks can
  behave differently in it. Label a result from it as automation-profile, and confirm it
  once on a normal profile before it becomes a claim in a string, a test or an issue.
- This supplements `npm run check`. It is not part of it and does not run in CI.

## The integration corpus

`npm run corpus` runs the real extension over a list of pages in a throwaway Chrome, and
writes a summary table, the redacted captures and a popup screenshot per page under
`fixtures/corpus/runs/` (gitignored). Use it for a check across many pages at once; use the
live Chrome above for one page with a question. How to run it, its options and what a run
writes are in `fixtures/corpus/README.md`.
