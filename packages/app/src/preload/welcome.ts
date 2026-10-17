// The welcome window's preload (6.0 First run; 9.1 Shell view): bundled to dist/preload-welcome.cjs and run
// sandboxed in the welcome shell's isolated world. The page reaches main only through this contextBridge API of
// named, typed functions (core/ipc-files.ts WelcomeApi), never a raw ipcRenderer; event objects never cross into
// the page. Main accepts these channels only from the welcome window's own shell (first-run.ts).
//
// A file dropped on the window opens in Blueline (6.1 Ways in): the drop listener reads the paths here, in the
// isolated world, and sends them to main, which checks them (drop.ts); the page never sees a path.

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { FilesShellChannels, MainToWelcome, WelcomeToMain, type NameResult, type WelcomeApi, type WelcomeOpenResult, type WelcomeState } from '@blueline/core/ipc-files';
import type { DefaultAppResult } from '@blueline/core/ipc-trust';
import { installShellFileDrop } from './drop-guard';

// Capture-phase drop listeners, before the page's script runs.
installShellFileDrop(window, {
  getPathForFile: (f) => webUtils.getPathForFile(f),
  open: (d) => ipcRenderer.invoke(FilesShellChannels.openDropped, d),
});

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

const api: WelcomeApi = {
  getState: () => ipcRenderer.invoke(WelcomeToMain.getState) as Promise<WelcomeState>,
  onState: (cb) => subscribe<WelcomeState>(MainToWelcome.state, cb),
  openFile: () => ipcRenderer.invoke(WelcomeToMain.openFile) as Promise<WelcomeOpenResult>,
  makeDefaultApp: () => ipcRenderer.invoke(WelcomeToMain.makeDefaultApp) as Promise<DefaultAppResult>,
  openSample: () => ipcRenderer.invoke(WelcomeToMain.openSample) as Promise<WelcomeOpenResult>,
  setName: (name: string) => ipcRenderer.invoke(WelcomeToMain.setName, String(name)) as Promise<NameResult>,
  setCrashReports: (on: boolean) => ipcRenderer.invoke(WelcomeToMain.setCrashReports, on === true) as Promise<void>,
  close: () => ipcRenderer.invoke(WelcomeToMain.close) as Promise<void>,
};

contextBridge.exposeInMainWorld('blueline', api);
