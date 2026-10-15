# Licensing

> **Status: proposed, pending confirmation.** This split is SPEC decision D14. Josh confirms it before the
> first public release (SPEC section 13, question 2). The licensor named in `packages/editor/LICENSE.md`
> also waits on section 13, question 4 (whether Josh or a company publishes Blueline).
> The repository layout supports either outcome: if everything becomes Apache-2.0, only the editor's
> licence file and this page change.

| Path | Licence | Why |
|---|---|---|
| everything outside `packages/editor/` (`packages/core`, `packages/app`, `packages/cli`, `native/`, `skill/`, `fixtures/`, `test/`, `scripts/`, docs) | [Apache-2.0](LICENSE) | Everything a reader or reviewer touches is open source. |
| `packages/editor/` | [FSL-1.1-ALv2](packages/editor/LICENSE.md) | Source-available and free to use. Each release becomes Apache-2.0 two years after it ships. This keeps a paid Edit tier possible (D11). |

Related pages:

- [READER-PROMISE.md](READER-PROMISE.md): Read and Review never move to a paid tier.
- [TRADEMARKS.md](TRADEMARKS.md): the Blueline name and icon are not licensed for forks.
- [CONTRIBUTING.md](CONTRIBUTING.md): contributions to `packages/editor` need a CLA.

## The capability seam

The app resolves `capabilities = {edit, agent}` at startup (SPEC 9.6). Read and Review build and run with
`packages/editor` removed: `npm run build:reader-only` fails if any code outside the editor imports it.
