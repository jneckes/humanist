// IPC contract of the Settings window (6.1 Becoming the default app, 6.10 Settings › Trust, 9.9) and the
// Protected view help text (6.10, 9.9; SECURITY.md Known channels). Types, channel names and strings only:
// environment-neutral, so the Settings shell page and the document shell can import it by subpath
// (`@blueline/core/ipc-trust`).
//
// The Settings window is a shell (9.1 Shell view): it reaches main only through the contextBridge API below
// (named, typed functions), and main accepts these channels only from the Settings window's own shell
// (ShellIpc, windowKey `settings`). Main accepts trust changes only from the trust bar's buttons and from
// Settings (9.1), never from a deck view.

/** Settings shell → main (`ipcRenderer.invoke`). */
export const SettingsToMain = {
  /** () → SettingsState. */
  getState: 'bl:settings:get-state',
  /** () → DefaultAppResult. macOS: the native helper; Windows: opens Default Apps settings (6.1). */
  makeDefaultApp: 'bl:settings:make-default-app',
  /** (kind) → FolderResult. Main shows the folder dialog itself: the shell never names a folder to add. */
  addFolder: 'bl:settings:add-folder',
  /** (kind, folder) → void. `folder` must be one of that list's entries. */
  removeFolder: 'bl:settings:remove-folder',
  /** (on) → void. 6.10 "Block all network in Protected view". */
  setStrictProtected: 'bl:settings:set-strict-protected',
  /** (host) → HostResult. 9.9 "The allowlist is user-editable in Settings › Trust". */
  addAllowlistHost: 'bl:settings:add-allowlist-host',
  /** (host) → void. */
  removeAllowlistHost: 'bl:settings:remove-allowlist-host',
  /** () → void. Back to the 9.9 list. */
  resetAllowlist: 'bl:settings:reset-allowlist',
} as const;

/** main → Settings shell (`webContents.send`). */
export const MainToSettings = {
  /** SettingsState, after every change. */
  state: 'bl:settings:state',
  /** SettingsPane: show this pane (openSettings('trust') from the trust bar's overflow). */
  showPane: 'bl:settings:show-pane',
} as const;

export type SettingsPane = 'general' | 'trust';
export type FolderKind = 'trusted' | 'untrusted';

/** Settings › General: whether Blueline is the default HTML app, and what the button does (6.1). */
export interface DefaultAppStatus {
  /** Whether the platform could tell (false: unknown, the line says so). */
  known: boolean;
  isDefault: boolean;
  /** The app that opens HTML files now, when known and not Blueline (macOS: its name). */
  current: string | null;
  /** What "Make Blueline your HTML app" does here: `set` (macOS helper), `open-settings` (Windows), `none`. */
  action: 'set' | 'open-settings' | 'none';
  /** Why the button does nothing here (Linux, a development build), or null. */
  reason: string | null;
}

/** The result of "Make Blueline your HTML app". */
export interface DefaultAppResult {
  ok: boolean;
  /** macOS 26.4 and later: the user chose Keep in the system's prompt ("not now", 6.0 First run). */
  declined?: boolean;
  /** Windows: Default Apps settings opened; the user chooses there (6.1). */
  openedSettings?: boolean;
  reason?: string;
}

export interface FolderResult {
  ok: boolean;
  /** The folder as stored (its realpath). */
  folder?: string;
  /** Why it was refused (6.10: "the home folder", "Downloads", "a temporary folder", …). */
  reason?: string;
  canceled?: boolean;
}

export interface HostResult {
  ok: boolean;
  /** The host as stored (normalized). */
  host?: string;
  reason?: string;
}

export interface SettingsState {
  platform: 'darwin' | 'win32' | 'linux' | 'other';
  /** null while main asks the platform. */
  defaultApp: DefaultAppStatus | null;
  trustedFolders: string[];
  untrustedFolders: string[];
  /** 6.10 "Block all network in Protected view". */
  strictProtected: boolean;
  /** The CDN allowlist in effect (9.9). */
  allowlist: string[];
  /** The allowlist is 9.9's list, unedited. */
  allowlistIsDefault: boolean;
}

/** The API the Settings preload exposes as window.blueline (named, typed functions only; 9.1). */
export interface SettingsApi {
  getState(): Promise<SettingsState>;
  onState(cb: (s: SettingsState) => void): void;
  onShowPane(cb: (pane: SettingsPane) => void): void;
  makeDefaultApp(): Promise<DefaultAppResult>;
  addFolder(kind: FolderKind): Promise<FolderResult>;
  removeFolder(kind: FolderKind, folder: string): Promise<void>;
  setStrictProtected(on: boolean): Promise<void>;
  addAllowlistHost(host: string): Promise<HostResult>;
  removeAllowlistHost(host: string): Promise<void>;
  resetAllowlist(): Promise<void>;
}

/** Limits main enforces on Settings calls (and the shell's inputs mirror). */
export const SETTINGS_LIMITS = Object.freeze({
  /** UTF-16 units of a folder path (PATH_MAX on macOS and Linux is 1024 and 4096). */
  folderPath: 4096,
  /** Entries per folder list. */
  folders: 500,
  /** A DNS name (RFC 1035). */
  host: 253,
  /** Hosts in the allowlist. */
  hosts: 200,
});

// ----------------------------------------------------------------- About Protected view (6.10, 9.9)

/**
 * "About Protected view": what Protected view blocks, what holds in every document, and the two DNS channels
 * that remain (9.9 Channels that onBeforeRequest does not see; SECURITY.md; PHASE0-FINDINGS F11). Settings ›
 * Trust shows it, and the trust bar's overflow shows the same text (protectedViewHelpText for a native dialog).
 */
export interface ProtectedViewHelp {
  title: string;
  intro: string;
  blockedHeading: string;
  blocked: readonly string[];
  alwaysHeading: string;
  always: readonly string[];
  remainHeading: string;
  remainIntro: string;
  remain: readonly string[];
  remainOutro: string;
}

export const PROTECTED_VIEW_HELP: ProtectedViewHelp = Object.freeze({
  title: 'About Protected view',
  intro:
    'Files from other people open in Protected view: a file that came from the internet, a file in a folder you marked as untrusted, or a file you opened in Protected view. The document’s scripts still run, sandboxed, as in every document.',
  blockedHeading: 'In Protected view',
  blocked: Object.freeze([
    'Network is off. The one exception: fonts, styles, scripts and images may load (GET only) from the CDN allowlist in Settings › Trust. “Block all network in Protected view” turns that exception off too.',
    'fetch, XMLHttpRequest, WebSocket, EventSource and beacons fail for every address, the document’s own included.',
    'Resource hints in the file (dns-prefetch, preconnect, prefetch, prerender) are removed. Every other connection, to this computer (localhost) and link-local addresses included, goes to a closed port.',
    'WebRTC uses only proxied connections, so no UDP packet leaves.',
    'Storage the document keeps (localStorage, IndexedDB) is cleared when its window closes.',
    'Downloads are blocked.',
    'Editing is off until you press Enable editing. Allow network turns on the Trusted network policy for this file. Both are remembered for this file until it changes where it came from (a new download).',
  ]),
  alwaysHeading: 'In every document, Protected or not',
  always: Object.freeze([
    'No camera, microphone, location, notifications, clipboard reading or devices.',
    'No navigation away from the document and no popups. A link you click opens outside Blueline only after you confirm its address.',
    'The document can show the files in its folder, but never read them.',
  ]),
  remainHeading: 'What Protected view cannot stop',
  remainIntro:
    'Two channels remain that Blueline cannot close. In both, the document can make your computer look up a host name it chooses, so whoever runs that name’s DNS server can learn the name, and up to about 250 characters of data hidden in it:',
  remain: Object.freeze([
    'a dns-prefetch link that a script adds after the page loads;',
    'the host name of a WebRTC TURN server reached over TCP or TLS.',
  ]),
  remainOutro:
    'No connection or request reaches that host, and the document cannot read anything from your computer this way. “Block all network in Protected view” does not change these two. If this matters for a file, keep it closed, or open it with networking off for the whole computer.',
});

/** The help as plain text (a native message box's detail, the trust bar's overflow). */
export function protectedViewHelpText(h: ProtectedViewHelp = PROTECTED_VIEW_HELP): string {
  const bullets = (items: readonly string[]) => items.map((s) => `• ${s}`).join('\n');
  return [
    h.intro,
    `${h.blockedHeading}:\n${bullets(h.blocked)}`,
    `${h.alwaysHeading}:\n${bullets(h.always)}`,
    `${h.remainHeading}:\n${h.remainIntro}\n${bullets(h.remain)}\n${h.remainOutro}`,
  ].join('\n\n');
}
