// The Diagnostics window's evidence for the guided dictation steps (section 10, Diagnostics window:
// "dictating in each mode, with focus on the page body, changes no mode, fires no shortcut and does not
// move the deck"). Electron is mocked: evidenceFor is pure.
import { describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';

vi.mock('electron', () => ({
  app: { getName: () => 'Blueline', getVersion: () => '0.0.0', getPath: () => os.tmpdir(), on() {}, once() {}, removeListener() {}, isPackaged: false },
  BrowserWindow: class {},
  WebContentsView: class {},
  ipcMain: { on() {}, handle() {} },
  protocol: { registerSchemesAsPrivileged() {} },
  session: { fromPartition: () => ({}) },
  nativeTheme: { shouldUseDarkColors: false },
  Menu: {},
  dialog: {},
  shell: {},
}));

import { evidenceFor } from '../../../packages/app/src/main/diagnostics';

const at = new Date().toISOString();
const e = (event: string, data: Record<string, unknown> = {}) => ({ at, event, data });

describe('evidenceFor: dictate-body-*', () => {
  it("does not count the preload's echo of the setup chord's own mode switch (cause main)", () => {
    // Ctrl+2 on the body: main logs app-chord and app-mode, then the preload's mode-change (cause 'main')
    // arrives over IPC after both. Then a Wispr-like Ctrl+V on the body.
    const log = [
      e('app-chord', { action: 'mode-review' }),
      e('app-mode', { from: 'read', to: 'review', cause: 'chord' }),
      e('mode-change', { from: 'read', to: 'review', cause: 'main' }),
      e('key-order', { key: 'v' }),
    ];
    expect(evidenceFor('dictate-body-review', log, { mode: 'review', lastNote: null })).toBe(
      'mode review; after the setup keys: 0 mode change(s), 0 shortcut(s), 0 deck move(s), 0 paste',
    );
  });

  it('does not count a mode-change from the initial handshake (cause init)', () => {
    const log = [e('app-chord', { action: 'mode-edit' }), e('mode-change', { from: 'read', to: 'edit', cause: 'init' }), e('paste', { length: 12 })];
    expect(evidenceFor('dictate-body-edit', log, { mode: 'edit', lastNote: null })).toContain('0 mode change(s)');
  });

  it('still counts a mode change the page made after the setup keys (Esc-Esc, or a change with no cause)', () => {
    // Esc-Esc on the body: the preload asks main for Read, main logs app-mode (cause esc), and the
    // preload's mode-change (cause esc) follows. That is not a setup key: the paste before it still counts.
    const esc = [
      e('app-chord', { action: 'mode-review' }),
      e('app-mode', { from: 'read', to: 'review', cause: 'chord' }),
      e('mode-change', { from: 'read', to: 'review', cause: 'main' }),
      e('paste', { length: 30 }),
      e('app-mode', { from: 'review', to: 'read', cause: 'esc' }),
      e('mode-change', { from: 'review', to: 'read', cause: 'esc' }),
    ];
    expect(evidenceFor('dictate-body-review', esc, { mode: 'read', lastNote: null })).toBe(
      'mode read, NOT review; after the setup keys: 1 mode change(s), 0 shortcut(s), 0 deck move(s), 1 paste',
    );
    const bare = [e('app-chord', { action: 'mode-read' }), e('mode-change', { from: 'read', to: 'edit' })];
    expect(evidenceFor('dictate-body-read', bare, { mode: 'edit', lastNote: null })).toContain('1 mode change(s)');
  });
});
