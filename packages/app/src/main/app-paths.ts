// Where the folders main serves from live on disk (9.10 Packaging; 9.1 Shell view; section 10 Diagnostics
// window). Pure: no Electron, so unit tests pin the resolution.
//
// A packaged build reads its code from app.asar, but the folders served through the confined protocol
// handlers (resolveConfined, 9.9) must be real files: inside an archive Electron's fs gives lstat synthetic
// stats (dev=1, ino=1) while open() extracts the entry to a temporary file, so the handle check refuses
// every file and the shell window comes up blank, with no trust bar. electron-builder therefore ships
// dist/shell and dist/assets unpacked (asarUnpack in electron-builder.config.cjs), into app.asar.unpacked
// next to the archive, and main serves them from there. Dev runs serve dist/ as it is.

import * as path from 'node:path';

export const ASAR = 'app.asar';
export const ASAR_UNPACKED = 'app.asar.unpacked';

/**
 * `p` with its `app.asar` path segment replaced by `app.asar.unpacked` when the app is packaged; `p`
 * itself otherwise (a dev run, or a packaged app without an archive). Only a whole segment counts, and
 * only the last one.
 */
export function unpackedPath(p: string, isPackaged: boolean, platform: NodeJS.Platform = process.platform): string {
  if (!isPackaged) return p;
  // Windows paths may use either separator; elsewhere a backslash is an ordinary file name character.
  const segment = platform === 'win32' ? /(^|[\\/])app\.asar(?=[\\/]|$)/g : /(^|\/)app\.asar(?=\/|$)/g;
  let at = -1;
  for (const m of p.matchAll(segment)) at = (m.index ?? 0) + m[1].length;
  if (at < 0) return p;
  return p.slice(0, at) + ASAR_UNPACKED + p.slice(at + ASAR.length);
}

/** The folders main serves, from the folder of main.cjs (dist/). */
export interface ServedDirs {
  /** dist/shell: the shell UI (app://shell/…). */
  shellDir: string;
  /** dist/assets/diagnostics-deck/index.html: the Diagnostics window's reveal.js deck. */
  diagnosticsDeck: string;
}

export function servedDirs(distDir: string, isPackaged: boolean, platform: NodeJS.Platform = process.platform): ServedDirs {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const dist = unpackedPath(distDir, isPackaged, platform);
  return {
    shellDir: p.join(dist, 'shell'),
    diagnosticsDeck: p.join(dist, 'assets', 'diagnostics-deck', 'index.html'),
  };
}
