# Contributing

Read [SPEC.md](SPEC.md) first. It is the source of truth for v1, and the decisions in its section 2 are
settled.

## Setup

```sh
npm ci                    # Node 22 or later; exactly package-lock.json, no install scripts (.npmrc)
npm run install:electron  # Electron's binary, the one explicit install step
npm run build             # esbuild bundles for main, preloads, shell, CLI and the editor
npm test                  # vitest unit and fuzz tests
npm start                 # run the app (under xvfb-run when there is no display)
npm run test:e2e          # Playwright Electron tests
npm run test:security
npm run build:reader-only
```

## Rules that CI enforces

- Nothing outside `packages/editor` imports `@blueline/editor` (D11). `npm run build:reader-only` fails if it does.
- The shell never sets `innerHTML`, `outerHTML` or `insertAdjacentHTML`, and never writes data into a style string (9.1).
- The deck overlay loads nothing by URL, runs no inline code and uses only constructable stylesheets (9.1, Preload).
- Every stored offset is a UTF-16 index into the decoded file string, never a byte offset (8, 9.2).
- A change that touches the mapper or matcher keeps each committed fixture's coverage within 1 point of
  `fixtures/expected/` (section 11).
- Dependencies are exact versions from the npm registry, with no new install scripts (`npm run check:lockfile`),
  and nothing ships from `node_modules`: code the app runs is bundled (docs/DEPENDENCIES.md).

## Licensing of contributions

- Contributions outside `packages/editor` are accepted under Apache-2.0.
- Contributions to `packages/editor` need a signed Contributor Licence Agreement, because that package is
  FSL-1.1-ALv2 and may be offered commercially (D14). A CLA bot is set up before the public release (Phase 6).

**Never install or run Blueline through `npx blueline`.** The unscoped npm name belongs to an unrelated
package (SPEC 9.5).
