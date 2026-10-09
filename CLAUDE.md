# Working in this repo

How to test lives in `docs/TESTING.md`: the rebuild rule, the harness, the real extension
in a live Chrome through the chrome-devtools MCP, and the corpus. What a contributor needs
is in `CONTRIBUTING.md`, and the visual system in `docs/DESIGN.md`. Read `docs/TESTING.md`
before verifying anything in a browser.

Rebuild before verifying: after any edit under `packages/capture-extension/src` or
`public`, run `npm run build:ext` in `packages/capture-extension` before loading the
extension, taking screenshots, or committing.
