// How the deck preload was started (ARCHITECTURE "deck preload <-> main"): main passes `--bl-mode=<mode>`
// through webPreferences.additionalArguments, and `--bl-test=1` only in test builds.

import type { PreloadMode } from '@blueline/core/ipc';

const MODES: readonly PreloadMode[] = ['deck', 'render', 'diagnostics'];

export interface PreloadEnv {
  mode: PreloadMode;
  /** Test builds only: expose ipcRenderer to the isolated world as __blTestIpc (the security suite). */
  test: boolean;
}

/**
 * Reads the mode from argv. An unknown or missing mode falls back to `deck`, the most restricted view that
 * still works (no render agent answering requests, no diagnostics events).
 */
export function parsePreloadArgs(argv: readonly string[]): PreloadEnv {
  let mode: PreloadMode = 'deck';
  let test = false;
  for (const a of argv) {
    if (a.startsWith('--bl-mode=')) {
      const m = a.slice('--bl-mode='.length);
      if ((MODES as readonly string[]).includes(m)) mode = m as PreloadMode;
    } else if (a === '--bl-test=1') test = true;
  }
  return { mode, test };
}
