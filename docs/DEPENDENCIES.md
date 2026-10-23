# Dependencies and the supply chain

Blueline opens untrusted HTML, so the code it is built from has to be trusted. In 2025 several popular npm
packages were compromised: hijacked maintainer accounts published malicious versions, and install scripts ran
malware on the machines that installed them. These rules keep such a release out of the app, out of the machines
that build it, and out of CI. They are checked by `npm run check:lockfile` (before anything is installed),
`npm run check:registry` (against the registry's signatures), `npm run check:installed` (after `npm ci`),
`scripts/package-smoke.mjs`, the build and CI (`.github/workflows/checks.yml`, `.github/workflows/mac-build.yml`).
`test/unit/scripts/` holds a test for each way around them found so far.

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
  ships as its release binary. Each bundled package's resolved URL and integrity come from
  `node_modules/.package-lock.json`, npm's record of what it installed: the build fails if they are not
  package-lock.json's (a package installed from somewhere else, an `npm-shrinkwrap.json` or a git source say).
- **Vendored files.** One third-party component ships as files rather than bundled: reveal.js 6.0.2 (MIT), the
  Diagnostics window's deck (`fixtures/decks/reveal-hash/vendor`, copied by `scripts/build.mjs` to
  `dist/assets/diagnostics-deck/vendor`), whose `theme/white.css` embeds the Source Sans Pro font (OFL-1.1).
  `scripts/vendored.json` lists each file with its SHA-256, the npm tarball it came from (reveal.js@6.0.2, with
  that tarball's sha512; every file is byte for byte the tarball's) and the font's licence
  (`scripts/notices/source-sans-pro.LICENSE.txt`, from the same tarball). The build fails if a listed file changes,
  goes missing or gains an unlisted neighbour, in the repository or in `dist/`; `package:smoke` and the Mac build
  check the packaged copy (`node scripts/third-party.mjs --shipped <Resources>`). Neither the lockfile nor
  Dependabot covers these files: updating reveal.js means taking the new files from its npm tarball and updating
  the manifest.
- **Licences.** Each bundled package's and vendored component's licence text is in `THIRD-PARTY-NOTICES.txt`,
  which the build writes next to the bundles (`dist/` in app.asar, and `resources/cli`); the bundles also keep their `/*! */` licence comments
  (esbuild `legalComments: 'eof'`). A package whose licence is not in `PERMISSIVE` (`scripts/third-party.mjs`),
  or that has no licence file, fails the build until someone reviews it. Electron's and Chromium's notices ship as
  `LICENSE.electron.txt` and `LICENSES.chromium.html`: electron-builder keeps them next to the executable on Linux
  and Windows but deletes them on macOS, so `scripts/electron-notices.cjs` (afterExtract) puts them in
  `Blueline.app/Contents/Resources`; `package:smoke` and the Mac build check they are there.
- **SBOM.** `npm run sbom -- <file>` writes a CycloneDX 1.6 JSON SBOM of what ships: the bundled packages, with
  version, licence, sha512 (of the tarball npm installed) and bundles; the vendored components, with the source
  tarball's sha512 and each shipped file's SHA-256; and Electron with the SHA-256 of its release zip. The Mac build
  uploads it with the app (`Blueline-sbom.cdx.json`).

## Installing

- **Exact versions.** Every dependency in every `package.json` is an exact version (`.npmrc` `save-exact`), the
  one `package-lock.json` resolves. Install with `npm ci`, which installs exactly the lockfile.
- **Check a branch before installing it.** On a branch you did not write (a pull request, a Dependabot branch),
  run `npm run check:lockfile` (and `npm run check:registry`) before `npm install` or `npm ci`: they read only
  the manifests, `.npmrc` and npm's configuration, so they run before any of the branch's dependencies is
  downloaded. Nothing runs them for you locally.
- **No install scripts.** `.npmrc` sets `ignore-scripts=true`: no registry package runs code when it is installed.
  npm makes one exception: it runs a **git** dependency's `prepare` script even with `ignore-scripts=true` (it
  clones the repository and builds the package). So `.npmrc` also sets `git=false`: npm cannot run git, and a git
  source fails with `ENOGIT` before anything runs; `check:lockfile` rejects any git source in the lockfile, and
  any `npm-shrinkwrap.json`, which `npm ci` would prefer to `package-lock.json`. The one install step the repo
  needs is run explicitly:

  ```sh
  npm ci
  npm run install:electron   # node node_modules/electron/install.js: Electron's binary, checked against
                             # electron's checksums.json (covered by the lockfile's integrity)
  ```

  Electron 44 has no install script of its own; `require('electron')` downloads a missing binary on first use.
  The scripts and tests that launch Electron take its path from `scripts/electron-binary.cjs` instead, which
  never downloads and fails with "run `npm run install:electron`" when the binary is missing. That includes every
  Playwright `_electron.launch` (it takes `executablePath`; without one Playwright requires electron's
  `index.js`, which downloads), which `test/unit/scripts/supply-chain-docs.test.ts` checks. `npm run dist` does
  not need it (electron-builder fetches Electron itself); `npm start`, the tests, `package:smoke`, `first-paint`
  and the `blueline` command from a checkout do.

  The three packages with install scripts, and why none is needed:
  - `esbuild`: its postinstall checks the platform binary; the JS API that `scripts/build.mjs` uses finds it in
    the platform package (`@esbuild/<os>-<arch>`, an optional dependency) by itself;
  - `fsevents` (an optional dependency of vite, under vitest): its script rebuilds it with node-gyp, but the
    package ships a prebuilt binary, and only watch mode uses it;
  - `electron-winstaller` (electron-builder's Squirrel.Windows target): its script picks a 7-Zip binary; the
    Windows target is NSIS.
- **The lockfile check.** `npm run check:lockfile` (CI runs it before `npm ci`) fails unless:
  - npm installs from `package-lock.json` alone: no `npm-shrinkwrap.json`, at the root or in a workspace;
  - every package is resolved from `https://registry.npmjs.org/` at exactly its own tarball URL with a sha512
    integrity (the four workspace links excepted: no git, file, http, alias, bundled or other tarball sources);
  - every entry is reached from the `package.json` files through the dependency graph (an entry nothing depends
    on is still installed by `npm ci`, and `npm audit signatures` skips it);
  - no two packages put the same command in one `node_modules/.bin` (bar `playwright`, which `@playwright/test`
    re-exports), none provides `node`, `npm`, `git` or another system command, and the commands the scripts run
    (`tsc`, `vitest`, `playwright`, `electron-builder`, `esbuild`, `electron`) come from their own packages;
  - every `package.json` pin, and every `overrides` value at any depth, is an exact version, the pins equal to the
    locked ones;
  - the packages flagged with an install script are exactly the three above;
  - `.npmrc` holds exactly `ignore-scripts=true`, `git=false`, `engine-strict=true` and `save-exact=true` (no
    registry, scoped registry or `replace-registry-host`), no workspace has an `.npmrc`, and npm's effective
    configuration (`npm config ls`: the user's and global npmrc and `npm_config_*` variables included) installs
    from the registry with install scripts and git off.

  A new install script, source or command therefore fails CI until someone reviews it.
- **The registry check.** `npm run check:registry` (CI runs it before `npm ci`) fetches each locked version's
  manifest from the registry and checks that the registry's signature over `<name>@<version>:<integrity>`
  verifies with the registry's key (pinned in `scripts/check-registry.mjs`; the key that expired on 2025-01-29
  counts for versions published before then) and that the signed integrity and tarball URL are the lockfile's.
  `npm ci` checks each tarball against the lockfile's integrity and `npm audit signatures` checks the registry's
  signature over the registry's integrity, but neither compares the two: a lockfile with the sha512 of other
  content (served from a poisoned npm cache, say) would pass both. 2026-10-23: 389 packages, 2.5 s.
- **What was installed.** `npm run check:installed` (CI runs it after `npm ci`, and `package:smoke` before it
  packs) compares `node_modules/.package-lock.json`, npm's record of what it installed, with `package-lock.json`:
  the same entries for this platform (an optional package for another OS, CPU or libc excepted), each with the
  same version, resolved URL and integrity. It walks `node_modules` and fails on any folder that is not one of
  them, on an install script (`preinstall`, `install`, `postinstall`, or a `binding.gyp`) in a package outside the
  three known ones, whatever the lockfile's `hasInstallScript` flag says (npm reads the package, not the flag), on
  colliding commands and on a `.bin` entry no package declares. A `prepare` script is not counted: npm runs it only
  for git and folder sources, which this check rules out (45 registry packages here publish one that never runs).
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

1. CI must pass: `check:lockfile` (no new install script, source, orphan or command), `check:registry`,
   `check:installed`, `npm audit signatures`, typecheck, unit tests, and the Mac build. Check the branch locally
   before installing it (Installing, above).
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
- Every job that installs sets `npm_config_ignore_scripts=true`, `npm_config_git=false` and
  `npm_config_registry=https://registry.npmjs.org/` in its environment, which takes precedence over any npmrc, the
  project's included: a pull request that edits `.npmrc` cannot turn install scripts or git back on in CI. The
  steps run `check:lockfile`, `check:registry`, `npm ci`, `check:installed`, then `npm audit signatures`.
- Each job's token is `contents: read`. Only the Mac build's `attest` job, which runs no project code, can mint an
  OIDC token (`id-token: write`, `attestations: write`): it attests the build provenance of the dmg, the zip and
  the SBOM.
- **Build provenance.** To check that a download is what the Mac build workflow built from this branch:

  ```sh
  gh attestation verify Blueline-0.0.0-arm64.dmg --repo jneckes/humanist \
    --signer-workflow jneckes/humanist/.github/workflows/mac-build.yml \
    --source-ref refs/heads/claude/admiring-edison-1lohc0 \
    --deny-self-hosted-runners
  ```

  `--repo` alone is not enough: it accepts an attestation made by any workflow of the repository, on any branch
  (for example the Mac build dispatched on another branch, or another workflow given `id-token: write`).
  `--signer-workflow` pins the workflow, `--source-ref` the branch it built (the release branch, once there is
  one), and `--deny-self-hosted-runners` GitHub's own runners. Checked 2026-10-23 on run 39983323290: exit 0 for
  the dmg and the SBOM; the same command with `checks.yml` or `refs/heads/main` exits 1.
