// knownHash never moves back, even when another program puts back the very bytes Blueline's write replaced (lead
// decision E-8; review finding 3, re-verification). A real BlDocument and its DeckIO (the atomic writer), the real
// DeckWatcher on the real file system, the real EditLane and write queue; latency is injected by wrapping
// fs.promises.open (a slow directory fsync right after Blueline's rename, or a slow read-back of the written file).
// The host wires recheck to the watcher as window.ts does. In every case the document must end on what is on disk.
// The ABA cases (the other program restores the original bytes during the slow step) failed before the fix: the
// watcher decided the restored hash, and adopting the own write moved knownHash back to it, because it equalled the
// version the write replaced; the external change was then dropped as stale and the document stayed on its own write.
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { createWriteQueue, editorVersion } from '@blueline/editor';
import type { EditorModule } from '@blueline/core/capabilities';
import { BlDocument } from '../../../packages/app/src/main/documents';
import { EditLane, type LaneHost } from '../../../packages/app/src/main/edit-session';
import { watchDeck } from '../../../packages/app/src/main/watcher';

const editor: EditorModule = { editorVersion, createWriteQueue };
const sha = (b: Uint8Array | Buffer) => createHash('sha256').update(b).digest('hex');
const short = (h: string) => h.slice(0, 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DECK = '<!doctype html>\n<html><head><meta charset="utf-8"><title>T</title></head><body>\n<h1>Hello world</h1>\n<p>Book a demo</p>\n</body></html>\n';

type Mode = 'none' | 'dirsync' | 'readback';
type Ext = { gap: number; make: (own: string) => string; label: string }[];

async function run(mode: Mode, SLOW: number, exts: Ext, wireRecheck = true) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bl-aba-')));
  const file = path.join(root, 'deck.html');
  fs.writeFileSync(file, DECK);
  const t0 = Date.now();
  const ev: string[] = [];
  const say = (m: string) => ev.push(`+${String(Date.now() - t0).padStart(5)}ms ${m}`);
  const doc = new BlDocument({ docId: 'abcdef0123456789', path: file, realpath: file, bytes: new Uint8Array(fs.readFileSync(file)), trust: { trust: 'trusted', reason: null, marker: null }, received: false });
  const C = doc.version;
  let locks: any[] = [];
  let known: { version: string } | null = null;
  const lane = new EditLane(file, { editor, capEdit: () => true, history: () => null, log: (m) => say(`lane log: ${m}`) });
  let watcher: any = null;
  const takes: string[] = [];
  const host: LaneHost = {
    doc: doc as any,
    locks: () => locks,
    setLocks: (l) => (locks = l),
    known: () => known,
    noteVersion: (v) => (known = { version: v.version }),
    save: () => undefined,
    canWrite: () => true,
    adopted: (e) => say(`host.adopted ${short(e.version)} basedOn ${short(e.basedOn)}; doc.knownHash ${short(doc.knownHash)}`),
    taken: (e) => say(`host.taken ${short(e.previous)} -> ${short(e.version)}`),
    log: (m) => say(`host log: ${m}`),
  };
  if (wireRecheck) (host as any).recheck = () => {
    say('host.recheck -> watcher.recheck()');
    watcher?.recheck();
  };
  await lane.attach(host);
  watcher = watchDeck({
    realpath: file,
    holder: doc,
    onExternalChange: (bytes, v) => {
      say(`WATCHER decided external ${short(v)} (knownHash ${short(doc.knownHash)}, doc.version ${short(doc.version)})`);
      void lane.takeExternal(host, bytes, v).then((r) => {
        takes.push(`${short(v)}:${r}`);
        say(`takeExternal(${short(v)}) -> ${r} [knownHash ${short(doc.knownHash)}, doc.version ${short(doc.version)}]`);
      });
    },
    log: (m) => say(`watcher log: ${m}`),
  });
  await sleep(400);
  const realOpen = fs.promises.open;
  let renamed = false;
  let lastExt: Buffer | null = null;
  const landExternals = () => {
    for (const x of exts) {
      setTimeout(() => {
        const own = fs.readFileSync(file, 'utf8');
        const next = x.make(own);
        const tmp = path.join(root, `.agent-${Math.random().toString(16).slice(2)}.tmp`);
        fs.writeFileSync(tmp, next);
        fs.renameSync(tmp, file);
        lastExt = Buffer.from(next);
        say(`EXTERNAL ${x.label} ${short(sha(lastExt))} landed`);
      }, x.gap);
    }
  };
  (fs.promises as any).open = async function (p: any, flags: any, m?: any) {
    const fh = await (realOpen as any).call(fs.promises, p, flags, m);
    if (mode === 'dirsync' && p === root) {
      const realSync = fh.sync.bind(fh);
      fh.sync = async () => {
        say(`dir fsync start; slow ${SLOW} ms`);
        landExternals();
        await sleep(SLOW);
        const r = await realSync();
        say('dir fsync done');
        return r;
      };
    }
    if (mode === 'readback' && p === file && renamed && /fileIs/.test(new Error().stack ?? '')) {
      const realRead = fh.readFile.bind(fh);
      fh.readFile = async (...a: any[]) => {
        say(`read-back start (knownHash ${short(doc.knownHash)}); slow ${SLOW} ms`);
        landExternals();
        await sleep(SLOW);
        const r = await realRead(...a);
        say(`read-back done (${short(sha(r))})`);
        return r;
      };
    }
    if (mode === 'none' && p === root) {
      const realSync = fh.sync.bind(fh);
      fh.sync = async () => {
        landExternals();
        return realSync();
      };
    }
    return fh;
  };
  const realRename = fs.promises.rename;
  (fs.promises as any).rename = async (a: any, b: any) => {
    const r = await realRename.call(fs.promises, a, b);
    if (b === file) {
      renamed = true;
      say(`rename -> D ${short(sha(fs.readFileSync(file)))}`);
    }
    return r;
  };
  const run = doc.map.runs.find((r: any) => r.value === 'Hello world')!;
  let out: any;
  try {
    out = await lane.exclusive(host, (ops) => ops.edit({ version: C, runId: run.id, beforeText: 'Hello world', afterText: 'Hello world now' }));
  } finally {
    (fs.promises as any).open = realOpen;
    (fs.promises as any).rename = realRename;
  }
  await sleep(3500);
  const disk = fs.readFileSync(file);
  const res = {
    mode,
    SLOW,
    exts: exts.map((x) => `${x.label}@${x.gap}`).join(','),
    recheck: wireRecheck,
    writeOk: out.out.ok,
    disk: short(sha(disk)),
    D: out.out.ok ? short(out.out.version) : '',
    C: short(C),
    docVersion: short(doc.version),
    knownHash: short(doc.knownHash),
    takes,
    mainOnDisk: doc.version === sha(disk),
    knownOnDisk: doc.knownHash === sha(disk),
    servedIsDisk: new TextDecoder().decode((await doc.documentBody()).body).includes(disk.toString('utf8').includes('Book a call') ? 'Book a call' : 'Book a demo') && new TextDecoder().decode((await doc.documentBody()).body).includes(disk.toString('utf8').includes('Hello world now') ? 'Hello world now' : 'Hello world</h1>'),
  };
  watcher.close();
  fs.rmSync(root, { recursive: true, force: true });
  if (!res.mainOnDisk) console.log(`\n==== ${JSON.stringify({ mode, SLOW, exts: res.exts, recheck: wireRecheck })}\n${ev.join('\n')}\nRESULT ${JSON.stringify(res)}`);
  return res;
}

const callIt = (own: string) => own.replace('Book a demo', 'Book a call');
const backToC = () => DECK;
const later = (own: string) => own.replace('<title>T</title>', '<title>T2</title>');

describe('E-8: an external change during the end of an own write is taken (finding 3 and its variants)', () => {
  it('original: dirsync 500, E at +10 (recheck wired)', async () => {
    const r = await run('dirsync', 500, [{ gap: 10, make: callIt, label: 'E' }]);
    expect(r.mainOnDisk).toBe(true);
    expect(r.knownOnDisk).toBe(true);
  }, 30000);
  it('original: readback 500, E at +10 (recheck wired)', async () => {
    const r = await run('readback', 500, [{ gap: 10, make: callIt, label: 'E' }]);
    expect(r.mainOnDisk).toBe(true);
    expect(r.knownOnDisk).toBe(true);
  }, 30000);
  it('original: dirsync 500, E at +10, host WITHOUT recheck (the knownHash rule alone)', async () => {
    const r = await run('dirsync', 500, [{ gap: 10, make: callIt, label: 'E' }], false);
    expect(r.mainOnDisk).toBe(true);
    expect(r.knownOnDisk).toBe(true);
  }, 30000);
  it('variant: two external saves in one 700 ms fsync window (+10, +350)', async () => {
    const r = await run('dirsync', 700, [{ gap: 10, make: callIt, label: 'E1' }, { gap: 350, make: later, label: 'E2' }]);
    expect(r.mainOnDisk).toBe(true);
    expect(r.knownOnDisk).toBe(true);
  }, 30000);
  it('variant: ABA, the other program restores the original bytes during a 500 ms fsync', async () => {
    const r = await run('dirsync', 500, [{ gap: 10, make: backToC, label: 'C-again' }]);
    expect(r.mainOnDisk).toBe(true);
    expect(r.knownOnDisk).toBe(true);
  }, 30000);
  it('variant: ABA during a 500 ms read-back', async () => {
    const r = await run('readback', 500, [{ gap: 10, make: backToC, label: 'C-again' }]);
    expect(r.mainOnDisk).toBe(true);
    expect(r.knownOnDisk).toBe(true);
  }, 30000);
});
