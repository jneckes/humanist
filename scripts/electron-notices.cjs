// electron-builder afterExtract hook: Electron's and Chromium's licence notices ship in the Mac app.
//
// Electron's release zip holds LICENSE (Electron, MIT) and LICENSES.chromium.html (Chromium and the code it
// includes) next to Electron.app. On Linux and Windows electron-builder keeps them next to the executable
// (LICENSE.electron.txt, LICENSES.chromium.html). On macOS it deletes them, because they sit outside the .app
// (app-builder-lib electronMac.js), so a Mac build would ship without them. This hook runs right after Electron is
// extracted, before that deletion, and copies both into Electron.app/Contents/Resources, where they are signed
// with the app. With an unpacked electronDist (package-smoke: node_modules/electron/dist) electron-builder copies
// only Electron.app, so the notices come from that folder. The build fails if they cannot be found.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** The notices, as the zip names them and as the app ships them. */
const NOTICES = [
  ['LICENSE', 'LICENSE.electron.txt'],
  ['LICENSES.chromium.html', 'LICENSES.chromium.html'],
];

async function afterExtract(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== 'darwin' && electronPlatformName !== 'mas') return;
  const appName = packager.info.framework.distMacOsAppName;
  const resources = path.join(appOutDir, appName, 'Contents', 'Resources');
  const dist = typeof packager.config.electronDist === 'string' ? path.resolve(packager.projectDir, packager.config.electronDist) : null;
  for (const [from, to] of NOTICES) {
    const src = [path.join(appOutDir, from), dist && path.join(dist, from)].find((p) => p && fs.existsSync(p));
    if (!src) throw new Error(`electron-notices: Electron's ${from} was not found next to ${appName} (${appOutDir}${dist ? ` or ${dist}` : ''}); the Mac app must ship it`);
    fs.copyFileSync(src, path.join(resources, to));
  }
}

module.exports = afterExtract;
module.exports.default = afterExtract;
module.exports.NOTICES = NOTICES;
