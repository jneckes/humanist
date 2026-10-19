// The Settings window's preload (9.1 Shell view): bundled to dist/preload-settings.cjs and run sandboxed in the
// Settings shell's isolated world. The page reaches main only through this contextBridge API of named, typed
// functions (core/ipc-trust.ts SettingsApi), never a raw ipcRenderer; event objects never cross into the page.
// Main accepts these channels only from the Settings window's own shell (settings-window.ts).

import { contextBridge, ipcRenderer } from 'electron';
import { MainToSettings, SettingsToMain, type FolderKind, type SettingsApi, type SettingsPane, type SettingsState } from '@blueline/core/ipc-trust';

/**
 * Settings › General › Smart punctuation (6.3). The channel is main's SETTINGS_GENERAL_CHANNELS.setSmartPunctuation
 * (settings-window.ts, which a preload cannot import: it holds main-only Electron code); test/unit/app/settings
 * holds the two names together until core/ipc-trust.ts carries it.
 */
const SET_SMART_PUNCTUATION = 'bl:settings:set-smart-punctuation';

/** The Settings API, with Settings › General's smart punctuation default. */
export type SettingsWindowApi = SettingsApi & { setSmartPunctuation(on: boolean): Promise<void> };

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

const api: SettingsWindowApi = {
  getState: () => ipcRenderer.invoke(SettingsToMain.getState) as Promise<SettingsState>,
  onState: (cb) => subscribe<SettingsState>(MainToSettings.state, cb),
  onShowPane: (cb) => subscribe<SettingsPane>(MainToSettings.showPane, cb),
  makeDefaultApp: () => ipcRenderer.invoke(SettingsToMain.makeDefaultApp),
  addFolder: (kind: FolderKind) => ipcRenderer.invoke(SettingsToMain.addFolder, kind),
  removeFolder: (kind: FolderKind, folder: string) => ipcRenderer.invoke(SettingsToMain.removeFolder, kind, folder) as Promise<void>,
  setStrictProtected: (on: boolean) => ipcRenderer.invoke(SettingsToMain.setStrictProtected, on) as Promise<void>,
  addAllowlistHost: (host: string) => ipcRenderer.invoke(SettingsToMain.addAllowlistHost, host),
  removeAllowlistHost: (host: string) => ipcRenderer.invoke(SettingsToMain.removeAllowlistHost, host) as Promise<void>,
  resetAllowlist: () => ipcRenderer.invoke(SettingsToMain.resetAllowlist) as Promise<void>,
  setSmartPunctuation: (on: boolean) => ipcRenderer.invoke(SET_SMART_PUNCTUATION, on) as Promise<void>,
};

contextBridge.exposeInMainWorld('blueline', api);
