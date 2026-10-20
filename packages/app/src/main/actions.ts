// The app actions behind the menu items and the app chords (6.2: the chords are menu accelerators that
// main also takes in before-input-event and runs itself). One list, so a menu click, a chord and a shell
// button run the same code.

import type { AppChordAction } from './chords';

export type AppAction =
  | AppChordAction
  | 'open'
  | 'open-protected'
  | 'open-in-browser'
  | 'reveal'
  | 'close'
  | 'diagnostics'
  | 'install-cli'
  // Added by views (Phase 1): 6.9 Views, the rail, 6.10 help, Settings and first run.
  | 'zoom-fit'
  | 'zoom-actual'
  | 'zoom-fill'
  | 'reading-width'
  | 'toggle-rail'
  | 'about-protected'
  | 'settings'
  | 'welcome'
  // Added by main-wiring (Phase 2): File › History… (9.2 Undo and redo 4; P2-11).
  | 'history';

/** Menu items whose feature belongs to a later phase: a toast says when it arrives. */
export const PHASE_STUBS: Readonly<Partial<Record<AppAction, string>>> = Object.freeze({
  send: 'Send to Claude Code arrives in Phase 4.',
});

/** 6.8 Save (Review): the explanation the first Cmd+S on your own document shows, once. */
export const SAVE_EXPLANATION = 'Your notes are kept in Blueline. To send them to someone, use Share › Save a copy for review.';
/** 6.8 Save on a received file writes the notes into it: Phase 5. */
export const SAVE_RECEIVED_PHASE5 = 'Saving notes into a received file arrives in Phase 5. Your notes are kept in Blueline.';

/** The platform's name for showing a file in the file manager. */
export function revealLabel(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'Reveal in Finder';
  if (platform === 'win32') return 'Show in Explorer';
  return 'Show in Folder';
}
