// The deck watcher (9.2 Watcher; 6.6 Reload), with real files in temp folders: in-place writes, rename-replace
// (vim, VS Code, Claude's Write tool, Blueline's own atomic write), a half-written file, delete and recreate,
// a burst of events, Blueline's own writes through knownHash, and the stat poll as a backstop.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { atomicWriteFile } from '../../../packages/app/src/main/atomic-write';
import { DeckWatcher, WATCH_TIMING, nodeWatchFs, type FileSig, type WatchFs, type WatchHandle } from '../../../packages/app/src/main/watcher';

const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await sleep(10);
  return pred();
}

let dir: string;
let deck: string;
const watchers: DeckWatcher[] = [];

interface Seen {
  changes: { text: string; version: string }[];
  gone: number;
  back: number;
  events: string[];
  logs: string[];
}

function watch(opts: Partial<ConstructorParameters<typeof DeckWatcher>[0]> = {}, file = deck): { w: DeckWatcher; seen: Seen } {
  const seen: Seen = { changes: [], gone: 0, back: 0, events: [], logs: [] };
  const w = new DeckWatcher({
    realpath: file,
    knownHash: sha(fs.readFileSync(file)),
    onExternalChange: (bytes, version) => {
      seen.changes.push({ text: Buffer.from(bytes).toString('utf8'), version });
      seen.events.push('change');
    },
    onGone: () => {
      seen.gone++;
      seen.events.push('gone');
    },
    onBack: () => {
      seen.back++;
      seen.events.push('back');
    },
    log: (m) => seen.logs.push(m),
    ...opts,
  });
  watchers.push(w);
  return { w, seen };
}

/** Lets the watcher's start-up check (150 ms + 50 ms) finish, so a test's own change is the next one. */
async function started(w: DeckWatcher): Promise<void> {
  w.start();
  await waitFor(() => w.checks >= 1);
  await sleep(120);
}

/** Writes through a temp file and a rename, as editors that save by rename-replace do. */
function renameReplace(file: string, text: string): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${Math.random().toString(36).slice(2)}.tmp`);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bl-watch-')));
  deck = path.join(dir, 'deck.html');
  fs.writeFileSync(deck, '<p>v1</p>');
});

afterEach(() => {
  for (const w of watchers.splice(0)) w.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('DeckWatcher on real files (Linux, 9.2 Watcher)', () => {
  it('uses the 9.2 timings', () => {
    expect(WATCH_TIMING).toMatchObject({ settleMs: 150, rereadMs: 50, pollMs: 1000 });
  });

  it('an in-place write (same inode) is an external change, with the bytes and their sha256', async () => {
    const { w, seen } = watch({ timing: { pollMs: 60_000 } });
    await started(w);
    const ino = fs.statSync(deck).ino;
    fs.writeFileSync(deck, '<p>v2</p>');
    expect(fs.statSync(deck).ino).toBe(ino);
    expect(await waitFor(() => seen.changes.length === 1)).toBe(true);
    expect(seen.changes[0]).toEqual({ text: '<p>v2</p>', version: sha('<p>v2</p>') });
    expect(w.knownHash).toBe(sha('<p>v2</p>'));
  });

  it('rename-replace, again and again: the folder watch never goes silent (the file itself is not watched)', async () => {
    // The poll is off (60 s), so only fs.watch on the folder can report these.
    const { w, seen } = watch({ timing: { pollMs: 60_000 } });
    await started(w);
    for (const v of ['v2', 'v3', 'v4']) {
      renameReplace(deck, `<p>${v}</p>`);
      expect(await waitFor(() => seen.changes.at(-1)?.text === `<p>${v}</p>`)).toBe(true);
    }
    expect(seen.changes.map((c) => c.text)).toEqual(['<p>v2</p>', '<p>v3</p>', '<p>v4</p>']);
  });

  it("vim's save: the original renamed to a backup, a new file written, the backup deleted", async () => {
    const { w, seen } = watch({ timing: { pollMs: 60_000 } });
    await started(w);
    fs.renameSync(deck, `${deck}~`);
    fs.writeFileSync(deck, '<p>from vim</p>');
    fs.unlinkSync(`${deck}~`);
    expect(await waitFor(() => seen.changes.length === 1)).toBe(true);
    expect(seen.changes[0].text).toBe('<p>from vim</p>');
    expect(seen.gone).toBe(0);
  });

  it('a half-written file is never acted on: a writer appending every 20 ms gives one change, the whole file', async () => {
    const { w, seen } = watch({ timing: { pollMs: 60_000 } });
    await started(w);
    const fd = fs.openSync(deck, 'w');
    let whole = '';
    for (let i = 0; i < 20; i++) {
      const part = `<p>part ${i}</p>`;
      fs.writeSync(fd, part);
      whole += part;
      await sleep(20);
    }
    fs.closeSync(fd);
    expect(await waitFor(() => seen.changes.length >= 1)).toBe(true);
    await sleep(500);
    expect(seen.changes.map((c) => c.text)).toEqual([whole]);
  });

  it('deleted: gone; recreated with new content: back, then the change', async () => {
    const { w, seen } = watch({ timing: { pollMs: 60_000 } });
    await started(w);
    fs.unlinkSync(deck);
    expect(await waitFor(() => seen.gone === 1)).toBe(true);
    expect(w.isGone).toBe(true);
    fs.writeFileSync(deck, '<p>again</p>');
    expect(await waitFor(() => seen.changes.length === 1)).toBe(true);
    expect(seen.events).toEqual(['gone', 'back', 'change']);
    expect(w.isGone).toBe(false);
  });

  it('recreated with the same content: back only, no reload', async () => {
    const { w, seen } = watch({ timing: { pollMs: 60_000 } });
    await started(w);
    const bytes = fs.readFileSync(deck);
    fs.unlinkSync(deck);
    expect(await waitFor(() => seen.gone === 1)).toBe(true);
    fs.writeFileSync(deck, bytes);
    expect(await waitFor(() => seen.back === 1)).toBe(true);
    await sleep(400);
    expect(seen.events).toEqual(['gone', 'back']);
  });

  it('renamed away is gone too (the path is what is watched)', async () => {
    const { w, seen } = watch({ timing: { pollMs: 60_000 } });
    await started(w);
    fs.renameSync(deck, path.join(dir, 'renamed.html'));
    expect(await waitFor(() => seen.gone === 1)).toBe(true);
    expect(seen.changes).toEqual([]);
  });

  it('a delete and a recreate within the settle time is a change, never gone', async () => {
    const { w, seen } = watch({ timing: { pollMs: 60_000 } });
    await started(w);
    fs.unlinkSync(deck);
    await sleep(30);
    fs.writeFileSync(deck, '<p>quick</p>');
    expect(await waitFor(() => seen.changes.length === 1)).toBe(true);
    expect(seen.gone).toBe(0);
  });

  it('a burst of 50 writes is one change, with the last content', async () => {
    const { w, seen } = watch({ timing: { pollMs: 60_000 } });
    await started(w);
    const before = w.checks;
    for (let i = 0; i < 50; i++) {
      if (i % 2) renameReplace(deck, `<p>burst ${i}</p>`);
      else fs.writeFileSync(deck, `<p>burst ${i}</p>`);
    }
    expect(await waitFor(() => seen.changes.length >= 1)).toBe(true);
    await sleep(500);
    expect(seen.changes.map((c) => c.text)).toEqual(['<p>burst 49</p>']);
    expect(w.checks - before).toBeLessThanOrEqual(2);
  });

  it("Blueline's own writes (setKnownHash, then the atomic write) never reload; an external one after them does", async () => {
    const { w, seen } = watch({ timing: { pollMs: 60_000 } });
    await started(w);
    for (const v of ['own 1', 'own 2', 'own 3']) {
      const bytes = new TextEncoder().encode(`<p>${v}</p>`);
      // As DeckIO does: the write, then onWritten(hash) as soon as it resolves (9.2 Write protocol step 6).
      await atomicWriteFile(deck, bytes, { expectHash: w.knownHash });
      w.setKnownHash(sha(bytes));
      await sleep(30);
    }
    await sleep(500);
    expect(seen.changes).toEqual([]);
    fs.writeFileSync(deck, '<p>external</p>');
    expect(await waitFor(() => seen.changes.length === 1)).toBe(true);
    expect(seen.changes[0].text).toBe('<p>external</p>');
  });

  it('an own write followed at once by an external one: the external one is reported', async () => {
    const { w, seen } = watch({ timing: { pollMs: 60_000 } });
    await started(w);
    const own = new TextEncoder().encode('<p>own</p>');
    await atomicWriteFile(deck, own, { expectHash: w.knownHash });
    w.setKnownHash(sha(own));
    renameReplace(deck, '<p>agent</p>');
    expect(await waitFor(() => seen.changes.length === 1)).toBe(true);
    await sleep(300);
    expect(seen.changes.map((c) => c.text)).toEqual(['<p>agent</p>']);
  });

  it('an atomic replace by another inode with the same bytes is not a change', async () => {
    const { w, seen } = watch({ timing: { pollMs: 60_000 } });
    await started(w);
    const ino = fs.statSync(deck).ino;
    renameReplace(deck, fs.readFileSync(deck, 'utf8'));
    expect(fs.statSync(deck).ino).not.toBe(ino);
    const checks = w.checks;
    expect(await waitFor(() => w.checks > checks)).toBe(true);
    await sleep(300);
    expect(seen.changes).toEqual([]);
  });

  it('events for other files in the folder are ignored (no read of the deck)', async () => {
    const { w, seen } = watch({ timing: { pollMs: 60_000 } });
    await started(w);
    const checks = w.checks;
    for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(dir, `other-${i}.css`), `p{color:red}/*${i}*/`);
    renameReplace(path.join(dir, 'deck.html.bak'), 'x');
    await sleep(500);
    expect(w.checks).toBe(checks);
    expect(seen.changes).toEqual([]);
  });

  it('the file changed between its open and start(): the first check reports it', async () => {
    const { w, seen } = watch({ knownHash: sha('<p>what was opened</p>'), timing: { pollMs: 60_000 } });
    w.start();
    expect(await waitFor(() => seen.changes.length === 1)).toBe(true);
    expect(seen.changes[0].text).toBe('<p>v1</p>');
  });

  it('the stat poll catches a change the folder watch never reported (1 s backstop)', async () => {
    const silent: WatchFs = { ...nodeWatchFs, watch: () => ({ close: () => undefined, on: () => undefined }) };
    const { w, seen } = watch({ fs: silent });
    await started(w);
    const t0 = Date.now();
    fs.writeFileSync(deck, '<p>polled, longer</p>');
    expect(await waitFor(() => seen.changes.length === 1, 4000)).toBe(true);
    // Within one poll interval plus the settle and the reread.
    expect(Date.now() - t0).toBeLessThan(WATCH_TIMING.pollMs + 800);
    expect(seen.changes[0].text).toBe('<p>polled, longer</p>');
  });

  it('close() releases the folder watch and the timers, and nothing is reported after it', async () => {
    let closedWatches = 0;
    const counting: WatchFs = {
      ...nodeWatchFs,
      watch: (d, l) => {
        const h = nodeWatchFs.watch(d, l);
        return {
          close: () => {
            closedWatches++;
            h.close();
          },
          on: (e, f) => h.on(e, f),
        };
      },
    };
    const { w, seen } = watch({ fs: counting, timing: { pollMs: 100 } });
    await started(w);
    w.close();
    expect(w.isClosed).toBe(true);
    expect(closedWatches).toBe(1);
    const checks = w.checks;
    fs.writeFileSync(deck, '<p>after close</p>');
    fs.unlinkSync(deck);
    await sleep(600);
    expect(w.checks).toBe(checks);
    expect(seen.events).toEqual([]);
  });
});

/** A WatchFs whose events and reads the test drives. */
class FakeFs implements WatchFs {
  listeners: ((event: string, filename: string | null) => void)[] = [];
  errorHandlers: ((e: Error) => void)[] = [];
  watchCalls = 0;
  content = 'a';
  reads: string[] = [];
  /** Returned by the next reads instead of `content`, one per read. */
  script: string[] = [];
  sig: FileSig = { dev: '1', ino: '1', size: '1', mtime: '1' };

  watch(_dir: string, listener: (event: string, filename: string | null) => void): WatchHandle {
    this.watchCalls++;
    this.listeners.push(listener);
    return {
      close: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
      on: (_e: 'error', f: (e: Error) => void) => {
        this.errorHandlers.push(f);
      },
    };
  }
  async stat(): Promise<FileSig> {
    return { ...this.sig };
  }
  async read(): Promise<{ bytes: Uint8Array; sig: FileSig }> {
    const text = this.script.length ? this.script.shift()! : this.content;
    this.reads.push(text);
    return { bytes: new TextEncoder().encode(text), sig: { ...this.sig } };
  }
  emit(filename: string | null): void {
    for (const l of this.listeners) l('change', filename);
  }
}

describe('DeckWatcher decisions (injected file system)', () => {
  function fake(f: FakeFs, knownText = 'a') {
    const seen: string[] = [];
    const w = new DeckWatcher({ realpath: '/decks/deck.html', knownHash: sha(knownText), fs: f, timing: { pollMs: 60_000 }, onExternalChange: (b) => seen.push(Buffer.from(b).toString()) });
    watchers.push(w);
    return { w, seen };
  }

  it('two reads that disagree are not acted on; the next settled pair is', async () => {
    const f = new FakeFs();
    const { w, seen } = fake(f);
    await started(w);
    f.content = 'final';
    f.script = ['half', 'half and more', 'half and more still'];
    f.emit('deck.html');
    expect(await waitFor(() => seen.length === 1)).toBe(true);
    expect(seen).toEqual(['final']);
    // half / half and more disagree; half and more still / final disagree; final / final agree.
    const tail = f.reads.slice(f.reads.indexOf('half'));
    expect(tail).toEqual(['half', 'half and more', 'half and more still', 'final', 'final', 'final']);
  });

  it('a null filename counts as the deck; another name does not', async () => {
    const f = new FakeFs();
    const { w, seen } = fake(f);
    await started(w);
    const checks = w.checks;
    f.content = 'b';
    f.emit('other.html');
    await sleep(300);
    expect(w.checks).toBe(checks);
    f.emit(null);
    expect(await waitFor(() => seen.length === 1)).toBe(true);
  });

  it('macOS and Windows: the name is compared case- and normalization-insensitively', async () => {
    const f = new FakeFs();
    const seen: string[] = [];
    const w = new DeckWatcher({ realpath: '/decks/Café.html', knownHash: sha('a'), fs: f, platform: 'darwin', timing: { pollMs: 60_000 }, onExternalChange: (b) => seen.push(Buffer.from(b).toString()) });
    watchers.push(w);
    await started(w);
    f.content = 'b';
    f.emit('café.HTML');
    expect(await waitFor(() => seen.length === 1)).toBe(true);
  });

  it('a folder watch error is caught, and the poll makes a new watch', async () => {
    const f = new FakeFs();
    const logs: string[] = [];
    const w = new DeckWatcher({ realpath: '/decks/deck.html', knownHash: sha('a'), fs: f, timing: { pollMs: 50 }, onExternalChange: () => undefined, log: (m) => logs.push(m) });
    watchers.push(w);
    w.start();
    expect(f.watchCalls).toBe(1);
    for (const h of f.errorHandlers) h(new Error('EPERM'));
    expect(await waitFor(() => f.watchCalls === 2)).toBe(true);
    expect(logs.some((l) => l.includes('stopped: EPERM'))).toBe(true);
  });

  it('a throwing onExternalChange is logged, and the watcher keeps going', async () => {
    const f = new FakeFs();
    const logs: string[] = [];
    let calls = 0;
    const w = new DeckWatcher({
      realpath: '/decks/deck.html',
      knownHash: sha('a'),
      fs: f,
      timing: { pollMs: 60_000 },
      log: (m) => logs.push(m),
      onExternalChange: () => {
        calls++;
        throw new Error('boom');
      },
    });
    watchers.push(w);
    await started(w);
    f.content = 'b';
    f.sig = { ...f.sig, mtime: '2' };
    f.emit('deck.html');
    expect(await waitFor(() => calls === 1)).toBe(true);
    f.content = 'c';
    f.sig = { ...f.sig, mtime: '3' };
    f.emit('deck.html');
    expect(await waitFor(() => calls === 2)).toBe(true);
    expect(logs.some((l) => l.includes('onExternalChange failed: boom'))).toBe(true);
  });

  it('reads and writes knownHash on its holder (the BlDocument, whose own writes set it)', async () => {
    const f = new FakeFs();
    const doc = { knownHash: sha('a') };
    const seen: string[] = [];
    const w = new DeckWatcher({ realpath: '/decks/deck.html', holder: doc, fs: f, timing: { pollMs: 60_000 }, onExternalChange: (b) => seen.push(Buffer.from(b).toString()) });
    watchers.push(w);
    await started(w);
    // Blueline's own write: DeckIO's onWritten sets doc.knownHash; the watcher sees it at decision time.
    f.content = 'own';
    doc.knownHash = sha('own');
    f.sig = { ...f.sig, mtime: '9' };
    f.emit('deck.html');
    await sleep(400);
    expect(seen).toEqual([]);
    f.content = 'agent';
    f.sig = { ...f.sig, mtime: '10' };
    f.emit('deck.html');
    expect(await waitFor(() => seen.length === 1)).toBe(true);
    expect(doc.knownHash).toBe(sha('agent'));
    expect(() => new DeckWatcher({ realpath: '/d/x.html', onExternalChange: () => undefined })).toThrow(/holder or a knownHash/);
  });

  it('refuses a relative path', () => {
    expect(() => new DeckWatcher({ realpath: 'deck.html', knownHash: 'x', onExternalChange: () => undefined })).toThrow(/absolute/);
  });
});
