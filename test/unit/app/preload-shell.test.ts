// The shell preload (9.1 Shell view): a contextBridge API of named, typed functions, never a raw ipcRenderer.
import { describe, expect, it, vi } from 'vitest';
import { MainToShell, ShellToMain, type ShellApi } from '@blueline/core/ipc';
import { RenderShellChannels } from '@blueline/core/ipc-render';
import { ViewsShellToMain } from '@blueline/core/ipc-views';

const exposed: Record<string, unknown> = {};
const invoke = vi.fn(async (..._args: unknown[]) => undefined as unknown);
const listeners = new Map<string, (e: unknown, p: unknown) => void>();

const windowListeners: string[] = [];

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (k: string, v: unknown) => (exposed[k] = v) },
  ipcRenderer: {
    invoke: (...a: unknown[]) => invoke(...a),
    on: (ch: string, fn: (e: unknown, p: unknown) => void) => listeners.set(ch, fn),
  },
  webUtils: { getPathForFile: () => '' },
}));

// The preload installs the shell's file-drop listeners on window (6.1; drop-guard.ts installShellFileDrop).
vi.stubGlobal('window', { addEventListener: (type: string) => windowListeners.push(type) });

describe('preload-shell', async () => {
  await import('../../../packages/app/src/preload/shell');
  const api = exposed.blueline as ShellApi;

  it('exposes window.blueline with named functions only', () => {
    expect(Object.keys(exposed)).toEqual(['blueline']);
    const names = Object.keys(api).filter((k) => k !== 'diag').sort();
    expect(names).toEqual(
      [
        'allowNetwork',
        'dismissBanner',
        'dismissTrustBar',
        'enableEditing',
        'getState',
        'onState',
        'onToast',
        'openInBrowser',
        'popupMenu',
        'revealFile',
        'setMode',
        // Phase 1 (views): commands, the rail, the scroll bars, Find, thumbnails.
        'command',
        'show',
        'scroll',
        'find',
        'findShow',
        'findClosed',
        'onThumb',
        'onIndexReady',
        'onFindOpen',
        'onScrollTo',
        // Phase 2 (main-wiring): toast buttons, Copy, the name chip, the history list.
        'toastAction',
        'copyNote',
        'setName',
        'historyClose',
        'historyRestore',
      ].sort(),
    );
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

  it('views calls invoke their own channels; drops are read in the preload (the page never sees a path)', async () => {
    invoke.mockClear();
    await api.command('present');
    await api.show(3);
    await api.scroll(10, 20);
    await api.find('revenue');
    await api.findShow(2, 0);
    await api.findClosed();
    expect(invoke.mock.calls).toEqual([
      [ViewsShellToMain.command, 'present'],
      [ViewsShellToMain.show, 3],
      [ViewsShellToMain.scroll, 10, 20],
      [RenderShellChannels.find, 'revenue'],
      [RenderShellChannels.findShow, 2, 0],
      [ViewsShellToMain.findClosed],
    ]);
    expect(windowListeners.sort()).toEqual(['dragenter', 'dragover', 'drop']);
  });

  it('Phase 2 calls (toast buttons, Copy, the name chip, history) invoke their own channels with their own arguments', async () => {
    invoke.mockClear();
    await api.toastAction('0123456789abcdef0123456789abcdef', 'make-note');
    await api.copyNote('n-0003');
    await api.setName('Josh');
    await api.historyClose();
    await api.historyRestore('h-4');
    expect(invoke.mock.calls).toEqual([
      [ShellToMain.toastAction, '0123456789abcdef0123456789abcdef', 'make-note'],
      [ShellToMain.copyNote, 'n-0003'],
      [ShellToMain.setName, 'Josh'],
      [ShellToMain.historyClose],
      [ShellToMain.historyRestore, 'h-4'],
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
