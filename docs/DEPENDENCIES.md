# Dependencies and the supply chain

Blueline opens untrusted HTML, so the code it is built from has to be trusted. In 2025 several popular npm
packages were compromised: hijacked maintainer accounts published malicious versions, and install scripts ran
malware on the machines that installed them. These rules keep such a release out of the app, out of the machines
that build it, and out of CI. They are checked by `npm run check:lockfile`, `scripts/package-smoke.mjs`, the build
and CI (`.github/workflows/checks.yml`, `.github/workflows/mac-build.yml`).

## What ships

- **No node_modules.** Every package the app runs is bundled by esbuild (`scripts/build.mjs`). At runtime main
  loads only `node:` builtins and `electron`. app.asar holds only `package.json` and `dist/`; `resources/cli` holds
  only the command's bundle, its shims and the notices. `packages/app` has no `dependencies`: electron-builder
  copies a package's production dependencies into app.asar, so the packages the bundles use are `devDependencies`,
  and `'!node_modules/**'` in `electron-builder.config.cjs` keeps one out if it ever gets one.
  `npm run package:smoke` lists the archive with `@electron/asar` and fails on any `node_modules` entry, and the
  Mac build checks its real app.asar the same way (`scripts/asar-contents.mjs`).
- **The bundled packages.** `npm run bundled` lists them from esbuild's metafile (`out/esbuild-meta.json`, written
  by every build), with each bundle they are in. As of 2026-10-23:

  | Package | Version | Licence | Bundles |
  | --- | --- | --- | --- |
  | `acorn`, `acorn-walk` | 8.19.0, 8.3.5 | MIT | main.cjs, editor.cjs |
  | `parse5`, `entities` | 8.0.1, 8.1.0 | MIT, BSD-2-Clause | main.cjs, editor.cjs |
  | `diff-match-patch` | 1.0.5 | Apache-2.0 | main.cjs, editor.cjs |
  | `pdf-lib` and what it pulls in: `@pdf-lib/standard-fonts`, `@pdf-lib/upng`, `pako`, `tslib` | 1.17.1; 1.0.0, 1.0.1, 1.0.11, 1.14.1 | MIT; pako (MIT AND Zlib), tslib 0BSD | main.cjs |
  | `perfect-freehand` | 1.2.3 | MIT | preload-deck.cjs |
  | `magic-string` and `@jridgewell/sourcemap-codec` | 1.4.3, 1.6.0 | MIT | editor.cjs |

  The shell bundles, the other preloads and the `blueline` command contain no third-party code. Electron itself
  ships as its release binary.
- **Licences.** Each bundled package's licence text is in `THIRD-PARTY-NOTICES.txt`, which the build writes next
  to the bundles (`dist/` in app.asar, and `resources/cli`); the bundles also keep their `/*! */` licence comments
  (esbuild `legalComments: 'eof'`). A package whose licence is not in `PERMISSIVE` (`scripts/third-party.mjs`),
  or that has no licence file, fails the build until someone reviews it.
- **SBOM.** `npm run sbom -- <file>` writes a CycloneDX 1.6 JSON SBOM of what ships: the bundled packages, with
  version, licence, sha512 (from `package-lock.json`) and bundles, and Electron with the SHA-256 of its release
  zip. The Mac build uploads it with the app (`Blueline-sbom.cdx.json`).

## Installing

- **Exact versions.** Every dependency in every `package.json` is an exact version (`.npmrc` `save-exact`), the
  one `package-lock.json` resolves. Install with `npm ci`, which installs exactly the lockfile.
- **No install scripts.** `.npmrc` sets `ignore-scripts=true`: no package runs code when it is installed. The one
  step the repo needs is run explicitly:

  ```sh
  npm ci
  npm run install:electron   # node node_modules/electron/install.js: Electron's binary, checked against
                             # electron's checksums.json (covered by the lockfile's integrity)
  ```

  Electron 44 has no install script of its own; `require('electron')` downloads a missing binary on first use.
  The scripts and tests that launch Electron take its path from `scripts/electron-binary.cjs` instead, which
  never downloads and fails with "run `npm run install:electron`" when the binary is missing. `npm run dist` does
  not need it (electron-builder fetches Electron itself); `npm start`, the tests, `package:smoke`, `first-paint`
  and the `blueline` command from a checkout do.

  The three packages with install scripts, and why none is needed:
  - `esbuild`: its postinstall checks the platform binary; the JS API that `scripts/build.mjs` uses finds it in
    the platform package (`@esbuild/<os>-<arch>`, an optional dependency) by itself;
  - `fsevents` (an optional dependency of vite, under vitest): its script rebuilds it with node-gyp, but the
    package ships a prebuilt binary, and only watch mode uses it;
  - `electron-winstaller` (electron-builder's Squirrel.Windows target): its script picks a 7-Zip binary; the
    Windows target is NSIS.
- **The lockfile check.** `npm run check:lockfile` (CI runs it before `npm ci`) fails unless every package is
  resolved from `https://registry.npmjs.org/` at exactly its own tarball URL with a sha512 integrity (the four
  workspace links excepted: no git, file, http, alias or other tarball sources), every `package.json` pin equals
  the locked version, and the packages with an install script are exactly the three above. A new install script
  therefore fails CI until someone reviews it.
- **Signatures.** CI runs `npm audit signatures`, which verifies the registry signature of every installed package
  and the provenance attestations of those that publish them. 2026-10-23: 344 packages with verified registry
  signatures, 64 with verified attestations; `npm audit --omit=dev` and `npm audit`: 0 vulnerabilities.

## Updating dependencies

Dependabot (`.github/dependabot.yml`) opens update pull requests weekly, grouped, at most four at a time for npm
and two for GitHub Actions:

- **Cooldown.** A new version is proposed only once it is 7 days old (patch or minor) or 14 days old (major), so a
  malicious release is usually found and unpublished first. GitHub Actions wait 7 days. Dependabot security
  updates, for a published advisory, are not delayed.
- **Electron has no cooldown** and its own pull request: upgrade within 14 days of each Electron security release
  (SPEC 9.6), because the app opens untrusted HTML.
- **Groups.** `electron`; `shipped` (minor and patch updates of the packages whose code is bundled); `tooling`
  (minor and patch updates of everything else); each major update is a pull request of its own.

Reviewing an update:

1. CI must pass: `check:lockfile` (no new install script, no new source), `npm audit signatures`, typecheck, unit
   tests, and the Mac build.
2. **A package that lands in a bundle** (`npm run bundled`, before and after the update; the table above): read the
   package's own diff, not only the lockfile's: `npm diff --diff=<name>@<old> --diff=<name>@<new>`. Look for
   network, `child_process`, `eval`/`Function`, file system access, and obfuscated or minified code that was not
   there before. A new package in the `npm run bundled` list needs the same review and a licence in `PERMISSIVE`.
3. Tooling (electron-builder, vitest, Playwright, TypeScript, esbuild) runs on developer machines and in CI, not
   in the app: check its changelog, its provenance (`npm audit signatures`) and anything new it runs.
4. Electron: read the release notes for security fixes, then run the full suites (`npm run test:e2e`,
   `npm run test:security`, `npm run package:smoke`).

Adding a dependency: prefer none. If its code runs in the app, it is bundled and is a `devDependency` of
`packages/app` (never a `dependency`), pinned to an exact version. `electron-updater` (Phase 6) and
`@modelcontextprotocol/server` (Phase 4) were removed until their phase needs them and come back that way,
pinned, and bundled.

## CI

- Every action is pinned by its full commit SHA, with its version tag in a comment (Dependabot updates both).
- Each job's token is `contents: read`. Only the Mac build's `attest` job, which runs no project code, can mint an
  OIDC token (`id-token: write`, `attestations: write`): it attests the build provenance of the dmg, the zip and
  the SBOM. To check a download:

  ```sh
  gh attestation verify Blueline-0.0.0-arm64.dmg --repo jneckes/humanist
  ```
