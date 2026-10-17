// Drag and drop (6.1 Ways in; 9.1: a deck view never gives main a path): main's checks of dropped paths and
// its shell channel, and the preload's capture-phase listeners for the deck view (refuse every file drag before
// the page sees it) and for the shell (paths read in the preload, sent to main).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({ ipcMain: { on: () => undefined, handle: () => undefined } }));

import { DROP_LIMITS, FilesShellChannels, type DroppedFiles, type DropResult } from '../../../packages/core/src/ipc-files';
import {
  DROP_REFUSED_TEXT,
  RefusedDropNotice,
  WELCOME_WINDOW_KEY,
  dropResultText,
  installDropHandler,
  openDroppedFiles,
  validateDropRefused,
  validateDroppedFiles,
  vetDroppedPath,
} from '../../../packages/app/src/main/drop';
import { ShellIpc, type ShellSender } from '../../../packages/app/src/main/ipc-guard';
import { carriesFiles, guardDeckFileDrops, installShellFileDrop, type ListenFn } from '../../../packages/app/src/preload/drop-guard';

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bl-drop-')));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function file(name: string, text = '<p>x</p>'): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, text);
  return p;
}

describe('validateDroppedFiles (the shell sent it)', () => {
  it('takes one plain object with at most 20 absolute-looking paths and the drop count', () => {
    expect(validateDroppedFiles([{ paths: ['/a.html'], total: 1 }])).toEqual({ ok: true, value: { paths: ['/a.html'], total: 1 } });
    expect(validateDroppedFiles([{ paths: [], total: 3 }]).ok).toBe(true);
    const twenty = Array.from({ length: DROP_LIMITS.files }, (_, i) => `/d/${i}.html`);
    expect(validateDroppedFiles([{ paths: twenty, total: 40 }]).ok).toBe(true);
    expect(validateDroppedFiles([{ paths: [...twenty, '/d/x.html'], total: 40 }]).ok).toBe(false);
  });

  it('refuses everything else', () => {
    for (const args of [
      [],
      [{ paths: ['/a.html'], total: 1 }, 'extra'],
      [null],
      [['/a.html']],
      [{ paths: '/a.html', total: 1 }],
      [{ paths: ['/a.html'], total: 0 }],
      [{ paths: ['/a.html'], total: 1.5 }],
      [{ paths: ['/a.html'], total: DROP_LIMITS.total + 1 }],
      [{ paths: [''], total: 1 }],
      [{ paths: ['/a\u0000.html'], total: 1 }],
      [{ paths: ['/a\n.html'], total: 1 }],
      [{ paths: ['/\uD800.html'], total: 1 }],
      [{ paths: [7], total: 1 }],
      [{ paths: ['x'.repeat(DROP_LIMITS.path + 1)], total: 1 }],
    ]) {
      expect(validateDroppedFiles(args).ok).toBe(false);
    }
    const accessor = { total: 1 } as Record<string, unknown>;
    Object.defineProperty(accessor, 'paths', { get: () => ['/a.html'], enumerable: true });
    expect(validateDroppedFiles([accessor]).ok).toBe(false);
  });

  it('the deck view’s refused-drop signal carries nothing', () => {
    expect(validateDropRefused(undefined).ok).toBe(true);
    expect(validateDropRefused(null).ok).toBe(true);
    expect(validateDropRefused({ path: '/etc/passwd' }).ok).toBe(false);
    expect(validateDropRefused('/x.html').ok).toBe(false);
  });
});

describe('vetDroppedPath and openDroppedFiles (main checks every path again)', () => {
  it('an existing .html or .htm file (any case) is opened through File › Open’s path', async () => {
    const a = file('a.html');
    const b = file('B.HTM');
    const opened: string[] = [];
    const r = await openDroppedFiles({ paths: [a, b], total: 2 }, { open: async (p) => opened.push(p) });
    expect(r).toEqual({ opened: 2, refused: [], skipped: 0 });
    expect(opened).toEqual([a, b]);
  });

  it('refuses folders, other files, missing files, relative paths, and a .html symlink to something else', async () => {
    fs.mkdirSync(path.join(dir, 'folder.html'));
    const pdf = file('notes.pdf');
    const txt = file('target.txt');
    const link = path.join(dir, 'link.html');
    fs.symlinkSync(txt, link);
    const goodLink = path.join(dir, 'good.html');
    fs.symlinkSync(file('real.htm'), goodLink);
    const opened: string[] = [];
    const r = await openDroppedFiles(
      { paths: [path.join(dir, 'folder.html'), pdf, path.join(dir, 'gone.html'), 'relative.html', link, goodLink], total: 6 },
      { open: async (p) => opened.push(p) },
    );
    expect(opened).toEqual([goodLink]);
    expect(r.refused).toEqual([
      { name: 'folder.html', reason: 'a folder' },
      { name: 'notes.pdf', reason: 'not an HTML file' },
      { name: 'gone.html', reason: 'not found' },
      { name: 'relative.html', reason: 'not a file path' },
      { name: 'link.html', reason: 'not an HTML file' },
    ]);
  });

  it('a FIFO named deck.html is not a regular file', async () => {
    if (process.platform === 'win32') return;
    const fifo = path.join(dir, 'pipe.html');
    const { spawnSync } = await import('node:child_process');
    if (spawnSync('mkfifo', [fifo]).status !== 0) return;
    expect(await vetDroppedPath(fifo)).toEqual({ ok: false, name: 'pipe.html', reason: 'not a regular file' });
  });

  it('at most 20 per drop; items with no file on disk are counted, never guessed at', async () => {
    const paths = Array.from({ length: 20 }, (_, i) => file(`d${i}.html`));
    const opened: string[] = [];
    const r = await openDroppedFiles({ paths: paths.slice(0, 18), total: 25 }, { open: async (p) => opened.push(p) });
    expect(opened).toHaveLength(18);
    expect(r.skipped).toBe(5);
    expect(r.refused).toEqual([
      { name: 'an item', reason: 'not a file on this computer' },
      { name: 'an item', reason: 'not a file on this computer' },
    ]);
  });

  it('dropResultText says what did not open, and nothing when all did', () => {
    expect(dropResultText({ opened: 2, refused: [], skipped: 0 })).toBeNull();
    expect(dropResultText({ opened: 0, refused: [{ name: 'notes.pdf', reason: 'not an HTML file' }], skipped: 0 })).toBe(
      'notes.pdf is not an HTML file. Blueline opens .html and .htm files.',
    );
    expect(dropResultText({ opened: 0, refused: [{ name: 'x', reason: 'a folder' }], skipped: 0 })).toBe('x was not opened (a folder).');
    const many: DropResult = { opened: 1, refused: Array.from({ length: 7 }, (_, i) => ({ name: `f${i}`, reason: 'not found' })), skipped: 3 };
    expect(dropResultText(many)).toBe(
      '7 files were not opened: f0 (not found), f1 (not found), f2 (not found), f3 (not found), f4 (not found), and 2 more. A drop opens at most 20 files; 3 more were not opened.',
    );
  });

  it('RefusedDropNotice: at most one notice every few seconds', () => {
    const n = new RefusedDropNotice(3000);
    expect(n.take(1000)).toBe(true);
    expect(n.take(2000)).toBe(false);
    expect(n.take(4001)).toBe(true);
    expect(DROP_REFUSED_TEXT).toMatch(/toolbar/);
  });
});

/** A ShellIpc over a fake ipcMain, and senders as Electron describes them. */
function shellRig() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const router = new ShellIpc({
    ipcMain: {
      on: () => undefined,
      handle: (ch, fn) => {
        handlers.set(ch, fn as (event: unknown, ...args: unknown[]) => unknown);
      },
    },
  });
  let nextId = 1;
  const shell = (windowKey: string, origin = 'app://shell') => {
    const id = nextId++;
    const mainFrame = { processId: 1, routingId: id, origin, parent: null };
    const wc = { id, mainFrame, isDestroyed: () => false, once: () => undefined };
    router.registerShell(wc, { windowKey });
    return (...args: unknown[]) => handlers.get(FilesShellChannels.openDropped)!({ sender: wc, senderFrame: mainFrame }, ...args);
  };
  return { router, handlers, shell };
}

describe('installDropHandler (FilesShellChannels.openDropped)', () => {
  it('a document shell or the welcome window: opens and reports; Settings, Diagnostics and unregistered senders are refused', async () => {
    const rig = shellRig();
    const opened: string[] = [];
    const reports: [ShellSender, DropResult][] = [];
    installDropHandler({ router: rig.router, open: async (p) => opened.push(p), report: (f, r) => reports.push([f, r]) });
    // Declared once per router.
    installDropHandler({ router: rig.router, open: async () => undefined });
    const a = file('a.html');
    const fromDoc = rig.shell('0123456789abcdef');
    expect(await fromDoc({ paths: [a, file('b.pdf')], total: 2 })).toEqual({ opened: 1, refused: [{ name: 'b.pdf', reason: 'not an HTML file' }], skipped: 0 });
    expect(reports[0][0].windowKey).toBe('0123456789abcdef');
    expect(await rig.shell(WELCOME_WINDOW_KEY)({ paths: [a], total: 1 })).toMatchObject({ opened: 1 });
    expect(opened).toEqual([a, a]);
    await expect(rig.shell('settings')({ paths: [a], total: 1 })).rejects.toThrow('Refused');
    await expect(rig.shell('diagnostics')({ paths: [a], total: 1 })).rejects.toThrow('Refused');
    await expect(rig.shell('0123456789abcdef', 'blueline://0123456789abcdef')({ paths: [a], total: 1 })).rejects.toThrow('Refused');
    await expect(fromDoc({ paths: [a] })).rejects.toThrow('Refused');
    expect(opened).toHaveLength(2);
  });
});

// ------------------------------------------------------------------------------------------- the preload side

interface FakeDrag {
  type: string;
  isTrusted: boolean;
  dataTransfer: { types: string[]; dropEffect: string; files: { length: number; [i: number]: File } } | null;
  prevented: boolean;
  stopped: boolean;
  preventDefault(): void;
  stopImmediatePropagation(): void;
}

function drag(type: string, o: { files?: string[]; types?: string[]; trusted?: boolean } = {}): FakeDrag {
  const files = o.files ?? [];
  const list: { length: number; [i: number]: File } = { length: files.length };
  files.forEach((f, i) => {
    list[i] = { name: f } as unknown as File;
  });
  return {
    type,
    isTrusted: o.trusted ?? true,
    dataTransfer: { types: o.types ?? (files.length ? ['Files'] : ['text/plain']), dropEffect: 'none', files: list },
    prevented: false,
    stopped: false,
    preventDefault() {
      this.prevented = true;
    },
    stopImmediatePropagation() {
      this.stopped = true;
    },
  };
}

/** A window whose capture listeners run first, then the "page" listeners, unless one stopped the event. */
function fakeWindow() {
  const capture: { type: string; fn: (e: DragEvent) => void }[] = [];
  const page: string[] = [];
  const listenFn: ListenFn = (_w, type, fn, c) => {
    expect(c).toBe(true);
    capture.push({ type, fn });
  };
  const dispatch = (e: FakeDrag) => {
    for (const l of capture) {
      if (l.type !== e.type) continue;
      l.fn(e as unknown as DragEvent);
      if (e.stopped) return;
    }
    page.push(e.type);
  };
  return { win: {} as Window, listenFn, capture, page, dispatch };
}

describe('guardDeckFileDrops (deck preload, capture phase)', () => {
  it('registers dragenter, dragover, dragleave and drop at window capture', () => {
    const w = fakeWindow();
    guardDeckFileDrops(w.win, { listen: w.listenFn });
    expect(w.capture.map((c) => c.type)).toEqual(['dragenter', 'dragover', 'dragleave', 'drop']);
  });

  it('a file drag never reaches the page: stopped, cancelled, dropEffect none; one notice', () => {
    const w = fakeWindow();
    let notices = 0;
    let t = 0;
    guardDeckFileDrops(w.win, { listen: w.listenFn, onRefused: () => notices++, now: () => t });
    for (const type of ['dragenter', 'dragover', 'dragover', 'dragleave', 'drop']) {
      const e = drag(type, { files: ['secret.pdf'] });
      w.dispatch(e);
      expect(e.stopped).toBe(true);
      expect(e.prevented).toBe(true);
      if (type !== 'dragleave') expect(e.dataTransfer!.dropEffect).toBe('none');
      t += 100;
    }
    expect(w.page).toEqual([]);
    expect(notices).toBe(1);
    t += 5000;
    w.dispatch(drag('dragenter', { files: ['again.html'] }));
    expect(notices).toBe(2);
  });

  it('drags of text or elements inside the page, and the page’s own synthetic events, are left alone', () => {
    const w = fakeWindow();
    guardDeckFileDrops(w.win, { listen: w.listenFn });
    const text = drag('drop', { types: ['text/plain', 'text/html'] });
    w.dispatch(text);
    const synthetic = drag('drop', { files: ['made-up.html'], trusted: false });
    w.dispatch(synthetic);
    expect(text.stopped || text.prevented || synthetic.stopped || synthetic.prevented).toBe(false);
    expect(w.page).toEqual(['drop', 'drop']);
  });

  it('a throwing notice still refuses the drag', () => {
    const w = fakeWindow();
    guardDeckFileDrops(w.win, {
      listen: w.listenFn,
      onRefused: () => {
        throw new Error('no');
      },
    });
    const e = drag('drop', { files: ['a.html'] });
    w.dispatch(e);
    expect(e.stopped && e.prevented).toBe(true);
  });

  it('carriesFiles reads the Files type', () => {
    expect(carriesFiles({ dataTransfer: { types: ['Files'] } })).toBe(true);
    expect(carriesFiles({ dataTransfer: { types: ['text/uri-list'] } })).toBe(false);
    expect(carriesFiles({ dataTransfer: null })).toBe(false);
  });
});

describe('installShellFileDrop (shell preloads)', () => {
  it('accepts file drags and sends the paths the preload read (at most 20) with the count', () => {
    const w = fakeWindow();
    const sent: DroppedFiles[] = [];
    installShellFileDrop(w.win, { listen: w.listenFn, getPathForFile: (f) => `/decks/${f.name}`, open: (d) => sent.push(d) });
    const over = drag('dragover', { files: ['a.html'] });
    w.dispatch(over);
    expect(over.prevented).toBe(true);
    expect(over.dataTransfer!.dropEffect).toBe('copy');
    // The shell page may still show a drop highlight: dragover is not stopped.
    expect(w.page).toEqual(['dragover']);
    const names = Array.from({ length: 23 }, (_, i) => `f${i}.html`);
    const drop = drag('drop', { files: names });
    w.dispatch(drop);
    expect(drop.prevented && drop.stopped).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].total).toBe(23);
    expect(sent[0].paths).toEqual(names.slice(0, 20).map((n) => `/decks/${n}`));
  });

  it('files that are not on disk give no path; untrusted drops and text drags are ignored', () => {
    const w = fakeWindow();
    const sent: DroppedFiles[] = [];
    installShellFileDrop(w.win, {
      listen: w.listenFn,
      getPathForFile: (f) => (f.name === 'memory.html' ? '' : `/d/${f.name}`),
      open: (d) => sent.push(d),
    });
    w.dispatch(drag('drop', { files: ['memory.html', 'disk.html'] }));
    w.dispatch(drag('drop', { files: ['forged.html'], trusted: false }));
    w.dispatch(drag('drop', { types: ['text/plain'] }));
    expect(sent).toEqual([{ paths: ['/d/disk.html'], total: 2 }]);
  });

  it('a rejected send (main refused) is swallowed', async () => {
    const w = fakeWindow();
    installShellFileDrop(w.win, { listen: w.listenFn, getPathForFile: () => '/d/a.html', open: () => Promise.reject(new Error('Refused')) });
    w.dispatch(drag('drop', { files: ['a.html'] }));
    await new Promise((r) => setTimeout(r, 0));
  });
});
