// Trust hooks for deck partitions and deck views (9.9 "Always", Network policy, Navigation and links;
// 6.10). Two entry points:
//
//   installDeckSessionPolicy(ses, policy)    once per deck partition: permissions, device choosers, the
//                                            single onBeforeRequest listener, the Protected PAC proxy,
//                                            downloads
//   installDeckWebContentsPolicy(wc, opts)   once per deck view or render view: navigation, popups,
//                                            webviews, the Bluetooth chooser, WebRTC, link handling
//
// The decisions are pure exported helpers (classifyTopNavigation, classifySubframeNavigation,
// classifyLinkTarget, parseExternalUrl, LinkTracker) so they are unit-tested without Electron.

import * as electron from 'electron';
import type { DownloadItem, SaveDialogOptions, Session, WebContents } from 'electron';
import type { TrustState } from '@blueline/core/ipc';
import { resolveConfinedPath } from './confine';
import {
  buildPacScript,
  decideRequest,
  networkOpen,
  pacDataUrl,
  upstreamProxyFromEnv,
  type RequestReason,
} from './network-policy';
import { writeDownloadMarker } from './markers';

// ---------------------------------------------------------------------------------------------------
// Pure decisions
// ---------------------------------------------------------------------------------------------------

/** Schemes `shell.openExternal` may ever receive, and only after the user confirmed (9.9). */
export const EXTERNAL_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:']);
const MAX_EXTERNAL_URL = 16 * 1024;
const HTML_EXTENSIONS: ReadonlySet<string> = new Set(['html', 'htm']);

/**
 * A main-frame navigation (will-navigate / will-frame-navigate with isMainFrame). 9.9: every top-level
 * navigation is cancelled except a fragment change within the same document. Chromium performs
 * same-document fragment navigations without emitting these events at all, so in practice everything
 * that reaches here is cancelled; the check keeps the rule explicit should an event ever report one.
 */
export function classifyTopNavigation(currentUrl: string, targetUrl: string, isSameDocument: boolean): 'allow' | 'cancel' {
  if (!isSameDocument) return 'cancel';
  try {
    const a = new URL(currentUrl);
    const b = new URL(targetUrl);
    a.hash = '';
    b.hash = '';
    return a.href === b.href ? 'allow' : 'cancel';
  } catch {
    return 'cancel';
  }
}

/**
 * A subframe navigation (will-frame-navigate / will-redirect with !isMainFrame). A frame cannot take the
 * document's place, so this only keeps frames on harmless targets:
 * - `about:blank`, `about:srcdoc`, `data:` and `blob:` (local; no network, and they inherit the page's CSP);
 * - this document's own two hosts (`blueline://<docId>` and `-files`, the latter served with CSP sandbox);
 * - `http`/`https` only while the Trusted network policy applies (Trusted, or Allow network). In Protected
 *   these are cancelled here and again by onBeforeRequest, so a form POST into a frame goes nowhere.
 * Everything else (`file:`, another document's host, `app:`, custom schemes) is cancelled. A frame that
 * targets the top (`target=_top`, `top.location = …`) is a main-frame navigation and is handled as one.
 */
export function classifySubframeNavigation(url: string, ctx: { docId: string; networkOpen: boolean }): 'allow' | 'cancel' {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'cancel';
  }
  switch (u.protocol) {
    case 'about:':
      return u.pathname === 'blank' || u.pathname === 'srcdoc' ? 'allow' : 'cancel';
    case 'data:':
    case 'blob:':
      return 'allow';
    case 'blueline:':
      return u.hostname === ctx.docId || u.hostname === `${ctx.docId}-files` ? 'allow' : 'cancel';
    case 'http:':
    case 'https:':
      return ctx.networkOpen ? 'allow' : 'cancel';
    default:
      return 'cancel';
  }
}

/**
 * True when `targetUrl` is the current document's own URL apart from the fragment: a reload
 * (`location.reload()`, a form or link back to the same URL). It is cancelled like every other top-level
 * navigation, but silently, because it does not leave the document.
 */
export function isSelfNavigation(currentUrl: string, targetUrl: string): boolean {
  try {
    const a = new URL(currentUrl);
    const b = new URL(targetUrl);
    a.hash = '';
    b.hash = '';
    return a.href === b.href;
  } catch {
    return false;
  }
}

/** Returns the URL normalized if `shell.openExternal` may receive it (http, https, mailto), else null. */
export function parseExternalUrl(url: string): string | null {
  if (typeof url !== 'string' || url.length > MAX_EXTERNAL_URL) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!EXTERNAL_SCHEMES.has(u.protocol)) return null;
  if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname === '') return null;
  return u.href;
}

export type LinkTarget =
  | { kind: 'external'; url: string }
  | { kind: 'local-html'; realpath: string }
  | { kind: 'blocked'; url: string; why: 'scheme' | 'outside' | 'not-html' };

/**
 * Where a link the user clicked goes (9.9 Navigation and links):
 * - `http`, `https`, `mailto` → external, opened only after a dialog that shows the full URL;
 * - a `.html`/`.htm` file in this document's folder or below (a `blueline://<docId>…` URL that passes the
 *   same confinement as the protocol handler) → local-html, opened in its own Blueline window;
 * - anything else → blocked.
 */
export function classifyLinkTarget(url: string, ctx: { docId: string; folderReal: string }): LinkTarget {
  const ext = parseExternalUrl(url);
  if (ext) return { kind: 'external', url: ext };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { kind: 'blocked', url, why: 'scheme' };
  }
  if (u.protocol !== 'blueline:') return { kind: 'blocked', url, why: 'scheme' };
  if (u.hostname !== ctx.docId && u.hostname !== `${ctx.docId}-files`) return { kind: 'blocked', url, why: 'outside' };
  if (u.username !== '' || u.password !== '' || u.port !== '') return { kind: 'blocked', url, why: 'outside' };
  const realpath = resolveConfinedPath(ctx.folderReal, u.pathname, { allowedExtensions: HTML_EXTENSIONS });
  if (!realpath) return { kind: 'blocked', url, why: 'not-html' };
  return { kind: 'local-html', realpath };
}

function normalizeUrl(s: string): string | null {
  try {
    return new URL(s).href;
  } catch {
    return null;
  }
}

export interface LinkTrackerOptions {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** How long a reported click authorizes a navigation to its URL (default 2,000 ms). */
  clickTtlMs?: number;
  /** How long a cancelled navigation waits for a click report that arrives after it (default 300 ms). */
  graceMs?: number;
  /** A second attempt at the same URL within this window is ignored (default 1,000 ms). */
  dedupeMs?: number;
}

const MAX_CLICKS = 16;

/**
 * Pairs cancelled navigations and window.open calls with link clicks the preload reported
 * (DeckToMain.link). A click authorizes one attempt at exactly its URL within `clickTtlMs`. The click
 * report and the navigation travel on different IPC paths, so an attempt with no click yet waits
 * `graceMs` for one before it is routed as "not clicked". will-frame-navigate and will-navigate both fire
 * for one main-frame navigation; the second attempt is dropped by `dedupeMs`.
 */
export class LinkTracker {
  private clicks: { url: string; at: number }[] = [];
  private pending = new Map<string, unknown>();
  private recent: { url: string; at: number }[] = [];
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly clickTtlMs: number;
  private readonly graceMs: number;
  private readonly dedupeMs: number;
  private disposed = false;

  constructor(
    private readonly route: (url: string, userClicked: boolean) => void,
    opts: LinkTrackerOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.clickTtlMs = opts.clickTtlMs ?? 2000;
    this.graceMs = opts.graceMs ?? 300;
    this.dedupeMs = opts.dedupeMs ?? 1000;
  }

  private prune(now: number): void {
    this.clicks = this.clicks.filter((c) => now - c.at <= this.clickTtlMs);
    this.recent = this.recent.filter((r) => now - r.at <= this.dedupeMs);
  }

  /** A trusted click on a link whose resolved URL is `href` (from the preload, via the IPC guard). */
  noteClick(href: string): void {
    if (this.disposed) return;
    const url = normalizeUrl(href);
    if (url === null) return;
    this.prune(this.now());
    if (this.pending.has(url)) {
      this.clearTimer(this.pending.get(url));
      this.pending.delete(url);
      this.route(url, true);
      return;
    }
    this.clicks.push({ url, at: this.now() });
    if (this.clicks.length > MAX_CLICKS) this.clicks.shift();
  }

  /** A navigation or popup that was cancelled. Routes it once: as clicked, or after graceMs as not. */
  attempt(rawUrl: string): void {
    if (this.disposed) return;
    const url = normalizeUrl(rawUrl) ?? String(rawUrl);
    const now = this.now();
    this.prune(now);
    if (this.pending.has(url) || this.recent.some((r) => r.url === url)) return;
    this.recent.push({ url, at: now });
    const i = this.clicks.findIndex((c) => c.url === url);
    if (i !== -1) {
      this.clicks.splice(i, 1); // one click authorizes one attempt
      this.route(url, true);
      return;
    }
    const timer = this.setTimer(() => {
      if (this.disposed || this.pending.get(url) !== timer) return;
      this.pending.delete(url);
      this.route(url, false);
    }, this.graceMs);
    this.pending.set(url, timer);
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.pending.values()) this.clearTimer(t);
    this.pending.clear();
    this.clicks = [];
  }
}

/**
 * Opens an external URL only if it is http, https or mailto and `confirm` (a dialog that shows the full
 * URL) resolves true. The single path to `shell.openExternal` for anything that came from a document
 * (9.9: "`shell.openExternal` only ever receives `http`, `https` or `mailto` URLs the user confirmed").
 */
export async function openExternalConfirmed(
  url: string,
  confirm: (url: string) => Promise<boolean>,
  open: (url: string) => Promise<void> = (u) => electron.shell.openExternal(u),
): Promise<boolean> {
  const target = parseExternalUrl(url);
  if (!target) return false;
  if ((await confirm(target)) !== true) return false;
  await open(target);
  return true;
}

// ---------------------------------------------------------------------------------------------------
// Per-partition policy
// ---------------------------------------------------------------------------------------------------

export interface DownloadInfo {
  url: string;
  filename: string;
  mime: string;
  webContentsId: number | null;
}

/** Live view of one deck partition's document state. Getters are read on every request. */
export interface DeckSessionPolicy {
  trust(): TrustState;
  networkAllowed(): boolean;
  strict(): boolean;
  allowlist(): readonly string[];
  /** Closed loopback port for the Protected PAC (network-policy pickClosedLoopbackPort, once per launch). */
  blockPort: number;
  /** Dev/CI upstream proxy for allowlisted hosts. Default: upstreamProxyFromEnv(). null forces DIRECT. */
  upstreamProxy?: string | null;
  /** The document's realpath, recorded as a download's source in its internet marker (9.9). */
  sourcePath?(): string | null;
  /**
   * Trusted downloads need confirmation (9.9). Return the options of the save dialog Electron then shows
   * (choosing a place and pressing Save is the confirmation), or false to cancel. Absent: a default save
   * dialog that names the file.
   */
  confirmDownload?(info: DownloadInfo): SaveDialogOptions | false;
  /** After a Trusted download completes and its internet marker was written. */
  onDownloaded?(savePath: string, info: DownloadInfo): void;
  /** A cancelled download (always in Protected). */
  onDownloadBlocked?(info: DownloadInfo): void;
  /** Every onBeforeRequest decision, cancelled or not (diagnostics, logs, the security suite). Never decides. */
  onRequest?(details: { url: string; method: string; resourceType: string; webContentsId: number | null }, decision: { cancel: boolean; reason: RequestReason }): void;
}

export interface DeckSessionHandle {
  /** Resolves once the proxy for the current trust state is applied and verified. Load the deck after it. */
  readonly ready: Promise<void>;
  /** Re-applies the proxy after a trust change, Allow network, or an allowlist/strict change. */
  update(): Promise<void>;
  /** Removes this policy's session event listeners. The deny-all handlers stay in place. */
  dispose(): void;
}

const PROBE_URL = 'https://blueline-proxy-check.invalid/';
const sessionHandles = new WeakMap<Session, DeckSessionHandle>();

/**
 * Installs the always-on policy of one deck partition (9.9 Always, Network policy):
 * - permission requests and checks are denied (Electron grants everything by default); device permission
 *   is denied; Bluetooth pairing is refused; the HID, serial and USB choosers are cancelled with no
 *   device. An `openExternal` permission request (a page navigating to an external protocol such as
 *   `mailto:`) is denied and handed to the link handling of its webContents instead;
 * - the single `webRequest.onBeforeRequest` listener (only the last one attached is used, so nothing else
 *   may attach one) applies decideRequest with the live getters;
 * - Protected without Allow network: a PAC proxy (allowlisted hosts DIRECT, everything else to a closed
 *   loopback port), verified with resolveProxy; otherwise the system proxy;
 * - downloads are cancelled in Protected, and need confirmation in Trusted, then get an internet marker.
 * Calling it again for the same session replaces the previous policy.
 */
export function installDeckSessionPolicy(ses: Session, policy: DeckSessionPolicy): DeckSessionHandle {
  sessionHandles.get(ses)?.dispose();

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (permission === 'openExternal' && wc) {
      const url = (details as { externalURL?: unknown }).externalURL;
      if (typeof url === 'string') linkAttempt(wc, url);
    }
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  // Windows and Linux only; macOS pairs through the system and has no handler.
  if (typeof ses.setBluetoothPairingHandler === 'function') {
    try {
      ses.setBluetoothPairingHandler((_details, callback) => callback({ confirmed: false }));
    } catch {
      // Not supported on this platform: pairing then needs no handler (macOS pairs through the system).
    }
  }

  const onHid = (event: electron.Event, _details: unknown, callback: (deviceId?: string | null) => void) => {
    event.preventDefault();
    callback();
  };
  const onSerial = (event: electron.Event, _ports: unknown, _wc: unknown, callback: (portId: string) => void) => {
    event.preventDefault();
    callback('');
  };
  const onUsb = (event: electron.Event, _details: unknown, callback: (deviceId?: string) => void) => {
    event.preventDefault();
    callback();
  };
  ses.on('select-hid-device', onHid);
  ses.on('select-serial-port', onSerial);
  ses.on('select-usb-device', onUsb);

  ses.webRequest.onBeforeRequest((details, callback) => {
    let cancel = true;
    let reason: RequestReason = 'bad-url';
    try {
      const d = decideRequest({
        url: details.url,
        method: details.method,
        resourceType: details.resourceType,
        trust: policy.trust(),
        networkAllowed: policy.networkAllowed(),
        strict: policy.strict(),
        allowlist: policy.allowlist(),
      });
      cancel = d.cancel;
      reason = d.reason;
    } catch {
      // A getter threw: refuse.
    }
    if (policy.onRequest) {
      try {
        policy.onRequest(
          { url: details.url, method: details.method, resourceType: details.resourceType, webContentsId: details.webContentsId ?? null },
          { cancel, reason },
        );
      } catch {
        // logging must never decide
      }
    }
    callback({ cancel });
  });

  const onDownload = (event: electron.Event, item: DownloadItem, wc: WebContents) => {
    const info: DownloadInfo = {
      url: item.getURL(),
      filename: item.getFilename(),
      mime: item.getMimeType(),
      webContentsId: wc && !wc.isDestroyed() ? wc.id : null,
    };
    let opts: SaveDialogOptions | false = false;
    try {
      if (policy.trust() === 'trusted') {
        opts = policy.confirmDownload
          ? policy.confirmDownload(info)
          : { title: 'Save download', message: `This document wants to save “${info.filename}”.`, buttonLabel: 'Save' };
      }
    } catch {
      opts = false;
    }
    if (opts === false) {
      // 9.9: will-download is cancelled in Protected view.
      event.preventDefault();
      try {
        policy.onDownloadBlocked?.(info);
      } catch {
        // ignore
      }
      return;
    }
    // No save path is set, so Electron shows the save dialog: the user's confirmation (9.9).
    item.setSaveDialogOptions(opts);
    item.once('done', (_e, state) => {
      if (state !== 'completed') return;
      const savePath = item.getSavePath();
      // 9.9: a file a deck downloads gets an internet marker naming the deck as its source; Electron's own
      // marking is not relied on.
      void writeDownloadMarker(savePath, { hostUrl: info.url, sourcePath: policy.sourcePath?.() ?? null })
        .catch(() => false)
        .then(() => policy.onDownloaded?.(savePath, info));
    });
  };
  ses.on('will-download', onDownload);

  let chain: Promise<void> = Promise.resolve();
  const applyProxy = async (): Promise<void> => {
    if (policy.trust() === 'protected' && !policy.networkAllowed()) {
      const upstream = policy.upstreamProxy === undefined ? upstreamProxyFromEnv() : policy.upstreamProxy;
      const script = buildPacScript(policy.allowlist(), policy.strict(), { blockPort: policy.blockPort, upstream });
      await ses.setProxy({ mode: 'pac_script', pacScript: pacDataUrl(script) });
      await ses.closeAllConnections();
      // Chromium falls back to DIRECT if a PAC script fails to load or run. Verify it took effect, and
      // fail (so the caller does not load the deck) if it did not.
      const probe = await ses.resolveProxy(PROBE_URL);
      if (!probe.includes(`127.0.0.1:${policy.blockPort}`)) {
        throw new Error(`Protected view proxy did not apply (got "${probe}")`);
      }
    } else {
      await ses.setProxy({ mode: 'system' });
      await ses.closeAllConnections();
    }
  };
  const update = (): Promise<void> => {
    const next = chain.then(applyProxy, applyProxy);
    chain = next.catch(() => undefined);
    return next;
  };

  const handle: DeckSessionHandle = {
    ready: update(),
    update,
    dispose() {
      ses.removeListener('select-hid-device', onHid);
      ses.removeListener('select-serial-port', onSerial);
      ses.removeListener('select-usb-device', onUsb);
      ses.removeListener('will-download', onDownload);
      if (sessionHandles.get(ses) === handle) sessionHandles.delete(ses);
    },
  };
  // Keep an unobserved rejection of `ready` from crashing main; callers await it and see the error.
  handle.ready.catch(() => undefined);
  sessionHandles.set(ses, handle);
  return handle;
}

// ---------------------------------------------------------------------------------------------------
// Per-view policy
// ---------------------------------------------------------------------------------------------------

export type BlockReason = 'not-clicked' | 'scheme' | 'outside' | 'not-html';

export interface DeckWebContentsOptions {
  docId: string;
  /** realpath of the document's folder (local .html links must resolve inside it). */
  folderReal: string;
  /** This document is Protected (a local .html link then opens Protected too). */
  isProtected(): boolean;
  /** The Trusted network policy applies (Trusted, or Allow network): http(s) frames may load. */
  networkOpen(): boolean;
  /**
   * A clicked http, https or mailto link. Show a dialog with the full URL, then open it with
   * openExternalConfirmed (never call shell.openExternal directly).
   */
  onUserLink(url: string): void;
  /** A clicked local .html/.htm file inside the document's folder: open it in its own window and session. */
  openLocalHtml(realpath: string, o: { protected: boolean }): void;
  /** Anything else that tried to leave: show the bar "This page tried to leave the document". */
  onBlocked(url: string, why: BlockReason): void;
  /** A cancelled subframe navigation (diagnostics only; no bar). */
  onSubframeBlocked?(url: string): void;
  tracker?: LinkTrackerOptions;
}

export interface DeckWebContentsHandle {
  /** Records a trusted link click reported by the preload (DeckToMain.link). */
  noteLinkClick(href: string): void;
  /**
   * Removes the listeners (re-install calls it). The view is then unguarded apart from the window-open
   * handler, so only call it right before installing again or when the view is being destroyed.
   */
  dispose(): void;
}

const trackers = new WeakMap<WebContents, LinkTracker>();
const viewHandles = new WeakMap<WebContents, DeckWebContentsHandle>();

/** Records a user's link click for `wc` (DeckToMain.link, after the IPC guard validated it). */
export function noteLinkClick(wc: WebContents, href: string): void {
  trackers.get(wc)?.noteClick(href);
}

function linkAttempt(wc: WebContents, url: string): void {
  trackers.get(wc)?.attempt(url);
}

interface NavDetails {
  url: string;
  isMainFrame: boolean;
  isSameDocument: boolean;
  preventDefault(): void;
}

/**
 * Installs the per-view policy on a deck view or render view (9.9 Always):
 * - will-navigate and will-frame-navigate cancel every top-level navigation except a same-document
 *   fragment change; a cancelled one goes to link handling. Subframe navigations follow
 *   classifySubframeNavigation (a frame's form submit or script redirect stays in the frame or is
 *   cancelled; it can never replace the document). will-redirect: a main-frame redirect is cancelled,
 *   a subframe redirect follows the subframe rule;
 * - setWindowOpenHandler denies every popup, and routes it to link handling;
 * - `<webview>` is refused; the Bluetooth chooser is cancelled with no device;
 * - WebRTC may not use non-proxied UDP (with the Protected PAC, its TCP fallback dies on the closed port);
 * - beforeunload cannot keep the view from closing or reloading;
 * - link handling (LinkTracker): a cancelled navigation or popup that matches a recent user click
 *   (noteLinkClick) runs onUserLink (http, https, mailto) or openLocalHtml (a local .html/.htm in the
 *   folder); everything else runs onBlocked.
 */
export function installDeckWebContentsPolicy(wc: WebContents, opts: DeckWebContentsOptions): DeckWebContentsHandle {
  // Re-installing (for example after the window follows a saved copy) replaces the previous listeners.
  viewHandles.get(wc)?.dispose();
  const route = (url: string, userClicked: boolean) => {
    try {
      if (!userClicked) {
        opts.onBlocked(url, 'not-clicked');
        return;
      }
      const t = classifyLinkTarget(url, { docId: opts.docId, folderReal: opts.folderReal });
      if (t.kind === 'external') opts.onUserLink(t.url);
      else if (t.kind === 'local-html') opts.openLocalHtml(t.realpath, { protected: opts.isProtected() });
      else opts.onBlocked(url, t.why);
    } catch {
      // A callback threw; the navigation is cancelled regardless.
    }
  };
  const tracker = new LinkTracker(route, opts.tracker);
  trackers.set(wc, tracker);

  const onTop = (d: NavDetails) => {
    const current = wc.getURL();
    if (classifyTopNavigation(current, d.url, d.isSameDocument) === 'allow') return;
    d.preventDefault();
    // location.reload() emits will-frame-navigate to the same URL (Phase 0 finding): cancel it without the
    // "tried to leave" bar. main reloads the document itself with loadURL when the file changes.
    if (isSelfNavigation(current, d.url)) return;
    tracker.attempt(d.url);
  };
  const onSub = (d: NavDetails) => {
    if (classifySubframeNavigation(d.url, { docId: opts.docId, networkOpen: opts.networkOpen() }) === 'allow') return;
    d.preventDefault();
    try {
      opts.onSubframeBlocked?.(d.url);
    } catch {
      // ignore
    }
  };
  // will-frame-navigate fires for every frame (and before will-navigate for the main frame); will-navigate
  // is handled too in case an Electron version emits only it. The tracker drops the duplicate attempt.
  const onFrameNavigate = (d: NavDetails) => (d.isMainFrame ? onTop(d) : onSub(d));
  const onNavigate = (d: NavDetails) => onTop(d);
  const onRedirect = (d: NavDetails) => {
    if (d.isMainFrame) {
      d.preventDefault();
      tracker.attempt(d.url);
      return;
    }
    onSub(d);
  };
  const onAttachWebview = (event: electron.Event) => event.preventDefault();
  const onBluetooth = (event: electron.Event, _devices: unknown, callback: (deviceId: string) => void) => {
    event.preventDefault();
    callback('');
  };
  const onPreventUnload = (event: electron.Event) => event.preventDefault();

  wc.on('will-frame-navigate', onFrameNavigate);
  wc.on('will-navigate', onNavigate);
  wc.on('will-redirect', onRedirect);
  wc.on('will-attach-webview', onAttachWebview);
  wc.on('select-bluetooth-device', onBluetooth);
  wc.on('will-prevent-unload', onPreventUnload);
  wc.setWindowOpenHandler((details) => {
    tracker.attempt(details.url);
    return { action: 'deny' };
  });
  wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');

  const handle: DeckWebContentsHandle = {
    noteLinkClick: (href) => tracker.noteClick(href),
    dispose() {
      tracker.dispose();
      if (trackers.get(wc) === tracker) trackers.delete(wc);
      if (viewHandles.get(wc) === handle) viewHandles.delete(wc);
      if (wc.isDestroyed()) return;
      wc.removeListener('will-frame-navigate', onFrameNavigate);
      wc.removeListener('will-navigate', onNavigate);
      wc.removeListener('will-redirect', onRedirect);
      wc.removeListener('will-attach-webview', onAttachWebview);
      wc.removeListener('select-bluetooth-device', onBluetooth);
      wc.removeListener('will-prevent-unload', onPreventUnload);
    },
  };
  wc.once('destroyed', () => {
    tracker.dispose();
    if (trackers.get(wc) === tracker) trackers.delete(wc);
  });
  viewHandles.set(wc, handle);
  return handle;
}

// ---------------------------------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------------------------------

/** The shell loads only from its own scheme and host (9.1 Shell view); devtools runs in its own contents. */
export function shellRequestAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'app:' && u.hostname === 'shell' && u.port === '' && u.username === '' && u.password === '';
  } catch {
    return false;
  }
}

/**
 * Hardens the shell's session and view (9.1 Shell view): requests other than `app://shell/…` are
 * cancelled, the shell never navigates (only main's own loadURL runs), opens no popups, attaches no
 * webviews and downloads nothing, and permissions are denied. Phase 5: the shell is granted the microphone
 * for the in-card recorder (9.9); that grant goes here, for `media` with audio only, after main's
 * askForMediaAccess.
 */
export function installShellPolicy(ses: Session, wc: WebContents): void {
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !shellRequestAllowed(details.url) }));
  ses.on('will-download', (event) => event.preventDefault());
  const cancel = (d: { preventDefault(): void }) => d.preventDefault();
  wc.on('will-frame-navigate', cancel);
  wc.on('will-navigate', cancel);
  wc.on('will-redirect', cancel);
  wc.on('will-attach-webview', (event) => event.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
}

/** Re-exported for callers that only import trust-hooks. */
export { networkOpen };
