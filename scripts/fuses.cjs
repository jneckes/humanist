// electron-builder afterPack hook: flips the Electron fuses (SPEC 9.9, "Electron fuses are set at build
// time"). It runs before signing, so the signature covers the flipped binary.
//
//   runAsNode                              off  (the CLI runs on the system's Node, 6.1)
//   enableNodeCliInspectArguments          off in release builds; BLUELINE_TEST_BUILD=1 keeps it on, because
//                                          Playwright's _electron.launch times out without it (the E2E and
//                                          security suites run on that test build)
//   enableEmbeddedAsarIntegrityValidation  on
//   onlyLoadAppFromAsar                    on
//   enableNodeOptionsEnvironmentVariable   off
//   grantFileProtocolExtraPrivileges       off  (no page loads from file://)
//
// Release CI reads the shipped fuses back with `npx @electron/fuses read --app <path>` and fails if any
// differs from this list (EXPECTED_FUSES).
'use strict';

const path = require('node:path');

/** The fuses SPEC 9.9 sets, by @electron/fuses FuseV1Options name. */
function expectedFuses(testBuild) {
  return {
    RunAsNode: false,
    EnableNodeCliInspectArguments: testBuild === true,
    EnableEmbeddedAsarIntegrityValidation: true,
    OnlyLoadAppFromAsar: true,
    EnableNodeOptionsEnvironmentVariable: false,
    GrantFileProtocolExtraPrivileges: false,
  };
}

/** Path of the packed Electron executable (or .app bundle) that flipFuses takes. */
function electronBinaryPath(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  const name = packager.appInfo.productFilename;
  if (electronPlatformName === 'darwin' || electronPlatformName === 'mas') return path.join(appOutDir, `${name}.app`);
  if (electronPlatformName === 'win32') return path.join(appOutDir, `${name}.exe`);
  return path.join(appOutDir, packager.executableName);
}

async function afterPack(context) {
  // @electron/fuses is ESM-only.
  const { flipFuses, FuseVersion, FuseV1Options } = await import('@electron/fuses');
  const testBuild = process.env.BLUELINE_TEST_BUILD === '1';
  const config = { version: FuseVersion.V1 };
  for (const [name, value] of Object.entries(expectedFuses(testBuild))) {
    if (!(name in FuseV1Options)) throw new Error(`fuses.cjs: unknown fuse ${name}`);
    config[FuseV1Options[name]] = value;
  }
  // An unsigned arm64 macOS binary must be re-signed ad hoc after its bytes change, or it will not start.
  // Release builds are signed after this hook anyway.
  const arch = context.arch;
  config.resetAdHocDarwinSignature = context.electronPlatformName === 'darwin' && (arch === 3 || arch === 'arm64');
  const binary = electronBinaryPath(context);
  await flipFuses(binary, config);
  console.log(`[fuses] ${path.basename(binary)}: ${testBuild ? 'test build (inspect arguments on)' : 'release fuses'} set`);
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.expectedFuses = expectedFuses;
module.exports.electronBinaryPath = electronBinaryPath;
