// The shell preload (9.1 Shell view): bundled to dist/preload-shell.cjs and run sandboxed in the shell's
// isolated world. The shell reaches main only through this contextBridge API of named, typed functions,
// never a raw ipcRenderer. Event objects never cross into the page: callbacks get the payload only.
// Used by every window's shell and by the Diagnostics window (the `diag` functions).

import { contextBridge, ipcRenderer } from 'electron';
import {
  MainToShell,
  ShellToMain,
  type AppMode,
  type DiagState,
  type ShellApi,
  type ShellMenu,
  type ShellState,
} from '@blueline/core/ipc';

type Toast = { text: string; kind: 'info' | 'warn' | 'error' };

function subscribe<T>(channel: string, cb: (v: T) => void): void {
  if (typeof cb !== 'function') return;
  ipcRenderer.on(channel, (_event, payload: T) => {
    try {
      cb(payload);
    } catch {
      // A throwing callback must not break the next message.
    }
  });
}

const api: ShellApi = {
  getState: () => ipcRenderer.invoke(ShellToMain.getState) as Promise<ShellState>,
  onState: (cb) => subscribe<ShellState>(MainToShell.state, cb),
  onToast: (cb) => subscribe<Toast>(MainToShell.toast, cb),
  setMode: (mode: AppMode) => ipcRenderer.invoke(ShellToMain.setMode, mode) as Promise<void>,
  allowNetwork: () => ipcRenderer.invoke(ShellToMain.allowNetwork) as Promise<void>,
  enableEditing: () => ipcRenderer.invoke(ShellToMain.enableEditing) as Promise<void>,
  dismissTrustBar: () => ipcRenderer.invoke(ShellToMain.dismissTrustBar) as Promise<void>,
  openInBrowser: () => ipcRenderer.invoke(ShellToMain.openInBrowser) as Promise<void>,
  revealFile: () => ipcRenderer.invoke(ShellToMain.revealFile) as Promise<void>,
  dismissBanner: () => ipcRenderer.invoke(ShellToMain.dismissBanner) as Promise<void>,
  popupMenu: (menu: ShellMenu, x: number, y: number) => ipcRenderer.invoke(ShellToMain.popupMenu, menu, x, y) as Promise<void>,
  diag: {
    getState: () => ipcRenderer.invoke(ShellToMain.diagState) as Promise<DiagState>,
    onState: (cb) => subscribe<DiagState>(MainToShell.diag, cb),
    record: (stepId: string, result: 'pass' | 'fail' | 'skip', detail?: string) =>
      (detail === undefined
        ? ipcRenderer.invoke(ShellToMain.diagRecord, stepId, result)
        : ipcRenderer.invoke(ShellToMain.diagRecord, stepId, result, detail)) as Promise<void>,
    runAuto: () => ipcRenderer.invoke(ShellToMain.diagRunAuto) as Promise<void>,
    save: () => ipcRenderer.invoke(ShellToMain.diagSave) as Promise<string>,
  },
};

contextBridge.exposeInMainWorld('blueline', api);
