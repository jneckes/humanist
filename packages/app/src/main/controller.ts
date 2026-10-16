// The app controller: opening files (6.1), one window per file, and the actions behind the menu, the app
// chords and the shell's buttons. index.ts creates it after `ready`.

import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BrowserWindow, app, dialog, shell, webContents as allWebContents } from 'electron';
import type { Capabilities } from '@blueline/core/ipc';
import type { Person } from '@blueline/core/types';
import { PHASE_STUBS, SAVE_EXPLANATION, SAVE_RECEIVED_PHASE5, type AppAction } from './actions';
import type { ConfigStore } from './config';
import { DocumentRegistry, OpenError, loadDocument, newDocumentId, trustedDocumentId, type BlDocument } from './documents';
import { openDiagnostics } from './diagnostics';
import { SessionStore, sessionFileFor, type SaveEvent } from './session-store';
import { DocWindow, type AppPaths } from './window';
import { FileKeyMap, fileKeys, type FileKeys } from './window-key';

export interface ControllerDeps {
  capabilities: Capabilities;
  paths: AppPaths;
  userData: string;
  config: ConfigStore;
  person: Person;
  blockPort: number;
  test: boolean;
  devTools: boolean;
  platform: NodeJS.Platform;
  log(msg: string): void;
}

export interface OpenOptions {
  /** `--protected` or File › Open in Protected View (6.10). */
  protected: boolean;
}

export class AppController {
  readonly registry = new DocumentRegistry();
  /**
   * Document windows by their file's keys (window-key.ts: device and inode, and the realpath as returned, never
   * case-folded; 6.1 One window per file).
   */
  private readonly windows = new FileKeyMap<DocWindow>();
  /** Opens in flight, by the path asked for, so a double delivery opens one window. */
  private readonly opening = new Map<string, Promise<DocWindow | null>>();
  /** Windows being created, by their file's keys: two paths to one file (a symlink, another spelling) make one window. */
  private readonly creating = new FileKeyMap<Promise<DocWindow | null>>();
  /** Session stores with writes that may still be pending (open windows and recently closed ones). */
  private readonly stores = new Set<SessionStore>();
  /** Error dialogs still on screen. */
  private readonly dialogs = new Set<Promise<unknown>>();

  constructor(private readonly deps: ControllerDeps) {}

  /**
   * Every open document window. A window that is closing is left out (finding 23): its deck view is closed in
   * the window's 'close' event, and from then until 'closed' its deck webContents reads as undefined.
   */
  all(): DocWindow[] {
    return this.windows.values().filter((w) => w.usable());
  }

  /** The focused document window, or the most recent one. */
  focused(): DocWindow | null {
    const fw = BrowserWindow.getFocusedWindow();
    const list = this.all();
    for (const w of list) if (fw && w.win === fw) return w;
    return list.length > 0 ? list[list.length - 1] : null;
  }

  /**
   * Opens a file in its own window, or focuses the window that already shows it (6.1 One window per file).
   * Errors are shown to the user (and logged); resolves to null then.
   */
  open(p: string, o: OpenOptions): Promise<DocWindow | null> {
    const abs = path.resolve(p);
    const inflight = this.opening.get(abs);
    if (inflight) return inflight;
    const job = this.doOpen(abs, o).finally(() => this.opening.delete(abs));
    this.opening.set(abs, job);
    return job;
  }

  private async doOpen(abs: string, o: OpenOptions): Promise<DocWindow | null> {
    let realpath: string | null = null;
    try {
      realpath = await fs.promises.realpath(abs);
    } catch {
      // loadDocument reports it
    }
    if (realpath) {
      const known = await this.existing(await this.keysOf(realpath));
      if (known !== undefined) return known;
    }
    let doc: BlDocument;
    try {
      doc = await loadDocument(abs, {
        protectedRequested: o.protected,
        // 6.10 Storage: a Trusted file keeps its origin (and so its storage) across opens; Protected never does.
        docIdFor: (trust, fileKey) => (trust === 'trusted' ? trustedDocumentId(this.deps.userData, fileKey) : Promise.resolve(newDocumentId())),
      });
    } catch (e) {
      this.reportOpenError(abs, e);
      return null;
    }
    const keys = await this.keysOf(doc.realpath);
    // No await between the last check and creating.set: two paths to the same file make one window.
    while (this.windows.get(keys) !== undefined || this.creating.get(keys) !== undefined) {
      const known = await this.existing(keys);
      if (known !== undefined) return known;
    }
    const job: Promise<DocWindow | null> = this.createWindow(doc, keys).finally(() => this.creating.delete(job));
    this.creating.set(keys, job);
    return job;
  }

  /** A file's keys, after the open windows' inode keys were read again (window-key.ts). */
  private async keysOf(realpath: string): Promise<FileKeys> {
    const [keys] = await Promise.all([fileKeys(realpath), this.windows.rekey((w) => w.doc.realpath)]);
    return keys;
  }

  /**
   * The window that shows (or is about to show) the file with these keys, focused; undefined if none. A window
   * of the file that is closing is never returned: the open waits until it is gone (its Trusted docId and its
   * session.json are free again then) and opens a new one.
   */
  private async existing(keys: FileKeys): Promise<DocWindow | null | undefined> {
    for (;;) {
      const w = this.windows.get(keys);
      if (w && !w.isDestroyed()) {
        if (!w.closing) {
          w.focus();
          return w;
        }
        await w.closed;
        continue;
      }
      const pending = this.creating.get(keys);
      if (!pending) return undefined;
      const p = await pending;
      if (!p) return null;
      if (!p.closing) {
        p.focus();
        return p;
      }
      // It opened and is already closing: look again.
    }
  }

  private async createWindow(doc: BlDocument, keys: FileKeys): Promise<DocWindow | null> {
    let win: DocWindow | null = null;
    let store: SessionStore;
    try {
      // Throws on a docId that is still registered (a Trusted file's docId is stable, 6.10); remove() below
      // then leaves the other document alone.
      this.registry.add(doc);
      const file = sessionFileFor(this.deps.userData, doc.fileKey);
      // 6.8 One writer (finding 24): a recently closed window of this file may still be writing its session.json.
      // Read it only after that write landed (SessionStore.open also waits for any store's write of the file).
      await Promise.all([...this.stores].filter((s) => s.file === file).map((s) => s.idle()));
      store = await SessionStore.open(
        file,
        { path: doc.path, realpath: doc.realpath, fileKey: doc.fileKey, sha256: doc.contentHash, title: doc.title },
        (e: SaveEvent) => win?.onSaved(e),
      );
      win = await DocWindow.create({
        doc,
        registry: this.registry,
        session: store,
        capabilities: this.deps.capabilities,
        paths: this.deps.paths,
        test: this.deps.test,
        devTools: this.deps.devTools,
        blockPort: this.deps.blockPort,
        platform: this.deps.platform,
        person: () => this.deps.person,
        runAction: (a, w) => this.run(a, w),
        openLocalHtml: (rp, opt) => void this.open(rp, opt),
        openInBrowser: (rp) => this.openInBrowser(rp),
        reveal: (rp) => shell.showItemInFolder(rp),
        closed: (w) => this.onWindowClosed(w),
        log: (m) => this.deps.log(m),
      });
    } catch (e) {
      this.registry.remove(doc);
      this.reportOpenError(doc.path, e);
      return null;
    }
    // Closed while it was being created: its 'closed' already ran, so it never goes into the window map.
    if (win.closing) return win;
    this.windows.set(keys, win);
    this.stores.add(store);
    win.win.once('closed', () => void store.idle().then(() => this.stores.delete(store)));
    this.deps.log(`opened ${doc.fileName} (${doc.trust()}${doc.trustReason ? `: ${doc.trustReason}` : ''}) docId=${doc.docId}`);
    return win;
  }

  private onWindowClosed(w: DocWindow): void {
    this.windows.delete(w);
  }

  private reportOpenError(p: string, e: unknown): void {
    const msg = e instanceof OpenError ? e.message : `${path.basename(p)} could not be opened: ${e instanceof Error ? e.message : String(e)}`;
    this.deps.log(`open failed: ${msg}`);
    // A modal dialog would hang an automated run; tests read the log instead.
    if (!this.deps.test) {
      const d = dialog.showMessageBox({ type: 'error', message: 'Blueline could not open the file', detail: msg, buttons: ['OK'] }).catch(() => undefined);
      this.dialogs.add(d);
      void d.finally(() => this.dialogs.delete(d));
    }
  }

  /** Resolves when no error dialog is on screen. */
  async dialogsSettled(): Promise<void> {
    while (this.dialogs.size > 0) await Promise.all([...this.dialogs]);
  }

  /** A session or config write is pending or running. */
  writesPending(): boolean {
    return this.deps.config.busy || [...this.stores].some((s) => s.busy);
  }

  /** Resolves when every session and config write has finished (before quitting). */
  async idle(): Promise<void> {
    await Promise.all([...[...this.stores].map((s) => s.idle()), this.deps.config.idle()]);
  }

  /** File › Open… and File › Open in Protected View… */
  async showOpenDialog(protectedView: boolean): Promise<void> {
    const parent = BrowserWindow.getFocusedWindow();
    const opts: Electron.OpenDialogOptions = {
      title: protectedView ? 'Open in Protected View' : 'Open',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'HTML documents', extensions: ['html', 'htm'] }],
    };
    const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled) return;
    for (const f of r.filePaths) await this.open(f, { protected: protectedView });
  }

  /**
   * Open in Browser (6.1 Escape hatches): the file in the system browser, never in Blueline. When Blueline is
   * the default app for .html, opening the file "with its default app" would come straight back here, so
   * on macOS and Windows the browser is found as the default handler of https.
   */
  async openInBrowser(realpath: string): Promise<void> {
    if (this.deps.test) {
      this.deps.log(`open in browser: ${realpath}`);
      return;
    }
    try {
      if (this.deps.platform === 'darwin' || this.deps.platform === 'win32') {
        const info = await app.getApplicationInfoForProtocol('https://example.com/');
        if (info && typeof info.path === 'string' && info.path.length > 0) {
          if (this.deps.platform === 'darwin') {
            await new Promise<void>((resolve, reject) =>
              execFile('/usr/bin/open', ['-a', info.path, realpath], { timeout: 10_000 }, (err) => (err ? reject(err) : resolve())),
            );
          } else {
            const child = spawn(info.path, [realpath], { detached: true, stdio: 'ignore', windowsHide: false });
            child.on('error', () => undefined);
            child.unref();
          }
          return;
        }
      }
      const err = await shell.openPath(realpath);
      if (err) throw new Error(err);
    } catch (e) {
      this.deps.log(`open in browser failed: ${e instanceof Error ? e.message : String(e)}`);
      this.focused()?.toast('Could not open the file in your browser.', 'error');
    }
  }

  /** Runs a menu, chord or shell action on a window (the focused one when `w` is null). */
  run(action: AppAction, w: DocWindow | null = this.focused()): void {
    switch (action) {
      case 'open':
        void this.showOpenDialog(false);
        return;
      case 'open-protected':
        void this.showOpenDialog(true);
        return;
      case 'diagnostics':
        void openDiagnostics({ auto: false }).catch((e) => this.deps.log(`diagnostics: ${String(e)}`));
        return;
      case 'install-cli':
        (w ?? this.focused())?.toast(PHASE_STUBS['install-cli']!, 'info');
        return;
    }
    if (!w || w.isDestroyed()) return;
    switch (action) {
      case 'mode-read':
        w.setMode('read');
        return;
      case 'mode-review':
        w.setMode('review');
        return;
      case 'mode-edit':
        w.setMode('edit');
        return;
      case 'open-in-browser':
        void this.openInBrowser(w.doc.realpath);
        return;
      case 'reveal':
        shell.showItemInFolder(w.doc.realpath);
        return;
      case 'close':
        w.win.close();
        return;
      case 'save':
        void this.save(w);
        return;
      case 'undo':
      case 'redo': {
        // 6.2 / 9.2 step 5: inside a text field, native undo for that field; otherwise app undo (Phase 2).
        const focusedWc = allWebContents.getFocusedWebContents();
        if (focusedWc && focusedWc === w.deck.webContents && w.deckTextFieldFocused()) {
          if (action === 'undo') focusedWc.undo();
          else focusedWc.redo();
          return;
        }
        w.toast(PHASE_STUBS[action]!, 'info');
        return;
      }
      default: {
        const stub = PHASE_STUBS[action];
        if (stub) w.toast(stub, 'info');
      }
    }
  }

  /**
   * Cmd+S (6.2, 6.8). In Review: on your own document the notes stay in app data and the first Cmd+S says
   * so, once; on a received file Cmd+S will write the notes into the file (Phase 5). In Edit, edits are
   * already saved, so it does nothing.
   */
  private async save(w: DocWindow): Promise<void> {
    // Cmd+S saves notes, which are made in Review; in Edit the edits are already saved, and Read has
    // nothing to save.
    if (w.appMode !== 'review') return;
    if (w.doc.received) {
      w.toast(SAVE_RECEIVED_PHASE5, 'info');
      return;
    }
    if (this.deps.config.get().seen?.saveExplained) return;
    w.toast(SAVE_EXPLANATION, 'info');
    await this.deps.config.update({ seen: { saveExplained: true } });
  }
}
