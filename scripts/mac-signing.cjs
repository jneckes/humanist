// How `npm run dist` signs the macOS app (SPEC 9.10; SPEC 10 Phase 1, Builds: "local unsigned builds for
// dogfooding"). packages/app/electron-builder.config.cjs spreads macSigningFor(process.env).mac into its `mac`
// section; it lives here because electron-builder refuses any key of its config it does not know.
'use strict';

/**
 * How the macOS app is signed. Release signing (9.10: Developer ID, hardened runtime, notarization) runs only
 * when a signing identity is configured: electron-builder's own CSC_LINK or CSC_NAME, or BLUELINE_SIGN=1 to let
 * it find a Developer ID in the keychain (notarization then needs the APPLE_* variables it documents).
 * Otherwise this is a local dogfooding build (SPEC 10 Phase 1, Builds: "local unsigned builds"):
 * - signed ad hoc (identity '-'), not left unsigned: Apple silicon runs no unsigned code, and packing changes the
 *   bundle (its name, Info.plist, app.asar, the fuses), which breaks the signature Electron's own binary carries;
 * - without the hardened runtime: under it, an ad-hoc signed app fails library validation on Electron's
 *   frameworks, which carry another Team ID (electron-builder's own warning);
 * - never notarized, so a Mac without an Apple developer account builds it with no credentials at all.
 * @param {NodeJS.ProcessEnv} env
 */
function macSigningFor(env) {
  const release = Boolean(env.CSC_LINK || env.CSC_NAME) || env.BLUELINE_SIGN === '1';
  if (release) return { release: true, mac: { hardenedRuntime: true } };
  return { release: false, mac: { identity: '-', hardenedRuntime: false, notarize: false } };
}

module.exports = { macSigningFor };
