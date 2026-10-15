// The shell preload (9.1 Shell view): a contextBridge API of named, typed functions, never a raw ipcRenderer.
import { describe, expect, it, vi } from 'vitest';
import { MainToShell, ShellToMain, type ShellApi } from '@blueline/core/ipc';

const exposed: Record<string, unknown> = {};
const invoke = vi.fn(async (..._args: unknown[]) => undefined as unknown);
const listeners = new Map<string, (e: unknown, p: unknown) => void>();

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (k: string, v: unknown) => (exposed[k] = v) },
  ipcRenderer: {
    invoke: (...a: unknown[]) => invoke(...a),
    on: (ch: string, fn: (e: unknown, p: unknown) => void) => listeners.set(ch, fn),
  },
}));

describe('preload-shell', async () => {
  await import('../../../packages/app/src/preload/shell');
  const api = exposed.blueline as ShellApi;

  it('exposes window.blueline with named functions only', () => {
    expect(Object.keys(exposed)).toEqual(['blueline']);
    const names = Object.keys(api).filter((k) => k !== 'diag').sort();
    expect(names).toEqual(['allowNetwork', 'dismissBanner', 'dismissTrustBar', 'enableEditing', 'getState', 'onState', 'onToast', 'openInBrowser', 'popupMenu', 'revealFile', 'setMode'].sort());
    for (const n of names) expect(typeof (api as unknown as Record<string, unknown>)[n]).toBe('function');
    expect(Object.keys(api.diag).sort()).toEqual(['getState', 'onState', 'record', 'runAuto', 'save']);
    expect(JSON.stringify(Object.values(api))).not.toMatch(/ipcRenderer/);
  });

  it('each call invokes its own channel with its own arguments', async () => {
    await api.setMode('review');
    await api.allowNetwork();
    await api.popupMenu('share', 10, 20);
    await api.diag.record('step-1', 'pass');
    await api.diag.record('step-2', 'fail', 'why');
    expect(invoke.mock.calls).toEqual([
      [ShellToMain.setMode, 'review'],
      [ShellToMain.allowNetwork],
      [ShellToMain.popupMenu, 'share', 10, 20],
      [ShellToMain.diagRecord, 'step-1', 'pass'],
      [ShellToMain.diagRecord, 'step-2', 'fail', 'why'],
    ]);
  });

  it('callbacks receive the payload, never the IPC event', () => {
    const got: unknown[] = [];
    api.onState((s) => got.push(s));
    api.onToast((t) => got.push(t));
    listeners.get(MainToShell.state)!({ sender: 'secret' }, { docName: 'x' });
    listeners.get(MainToShell.toast)!({ sender: 'secret' }, { text: 'hi', kind: 'info' });
    expect(got).toEqual([{ docName: 'x' }, { text: 'hi', kind: 'info' }]);
  });
});
