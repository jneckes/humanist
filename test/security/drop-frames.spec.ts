// File drops onto the frames of a deck view (review finding 2, decision D-4; SPEC 9.1 "a deck view never gives
// main a path", 6.1, 6.10). A file dragged onto any frame of a deck view, in either trust state, must never reach
// that frame's page: no frame may see a File, read its bytes, or take the drop.
//
// One deck holds one frame of each kind, each running the same recorder (it accepts every drag, reads a dropped
// file and posts what it saw to the top page):
//   srcdoc, an about:blank frame its parent scripts (no document.write), an about:blank frame the parent writes with
//   document.write, a data: frame (opaque origin), a blob: frame, a same-origin frame (the deck's own URL), a frame
//   nested in a srcdoc frame, a sibling file (the -files origin, served with CSP sandbox: no script runs there),
//   and in Trusted view a cross-origin http frame (another process).
// Each frame gets a trusted file drag (CDP Input.dispatchDragEvent with a file path, the way Chromium sees a drag
// from the desktop, as in test/e2e/views-open.spec.ts) at its centre, then, as the positive control, a trusted
// text drag at the same point, which the guard lets through: the frame must record that one, so the file drag
// did reach the frame and its recorder. The main frame's own refusal (with its toast) is the control for the top.
//
// It also checks the other half of D-4 in real Electron: the deck preload runs in the subframes (test builds put
// its ipcRenderer there as __blTestIpc, in the isolated world), and main's IPC guard refuses every message they
// send (9.1: only the main frame of a deck view speaks for it), while the same message from the main frame works.
//
// Known limits (expected failures). CDP Input.dispatchDragEvent enters the page where a drag from the desktop
// does (RenderWidgetHostImpl::DragTargetDragEnter/Over/Drop, the calls WebContentsViewAura makes for an OS drag),
// so these are limits for a real desktop drag too, in both trust states (SECURITY.md, Known limits):
//   1. document.open()/write(): a script a deck writes into a same-origin frame can register a capture listener
//      before the preload adds its guard again (document.open erases every listener; the guard returns from a
//      MutationObserver callback, after the written scripts ran). This is the ordering limit listeners.ts and
//      SECURITY.md state for the top window (test/e2e/card-input.spec.ts).
//   2. A frame a deck's own script creates as about:blank inside a shadow root: window.frames excludes a
//      shadow-nested iframe, the frame's load event does not cross a closed shadow boundary, and the subframe
//      preload does not run in an initial about:blank document (PHASE0-FINDINGS F11), so no renderer-side guard
//      runs there before the deck's own capture listener (review finding 2 re-verification).
// Electron 44 offers main no event to cancel a drop before the renderer sees it. Chromium's drag interception
// (CDP Input.setInterceptDrags) is no backstop: it holds only drags the page itself starts, never a drag that
// enters from the desktop, and it left the deck ignoring input after any drag it started, so the app does not
// use it (test/e2e/views-drag-inpage.spec.ts).

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { Scratch, launchApp, resolveRunAs, sleep, type BlApp, type DeckView } from '../helpers/app';

test.describe.configure({ mode: 'serial' });

const SECRET = 'SECRET-DROP-FRAMES-0123456789';

/** The recorder every frame runs: it accepts each drag, reads a dropped file, and posts what it saw to the top. */
const REC = `function __blRec(name, w, hostile) {
  w = w || window;
  var post = function (m) { m.frame = name; try { window.top.postMessage({ blRec: m }, '*'); } catch (e) {} };
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(function (t) {
    w.addEventListener(t, function (e) {
      if (hostile) e.stopImmediatePropagation();
      var dt = e.dataTransfer;
      var types = dt ? Array.prototype.slice.call(dt.types) : [];
      var files = dt && dt.files ? dt.files.length : 0;
      if (t !== 'dragleave') { e.preventDefault(); if (dt) { try { dt.dropEffect = 'copy'; } catch (x) {} } }
      post({ ev: t, types: types, files: files });
      if (t === 'drop' && dt) {
        if (files > 0) { var f = dt.files[0]; f.text().then(function (x) { post({ ev: 'read', name: f.name, text: x.slice(0, 64) }); }); }
        var s = dt.getData('text/plain'); if (s) post({ ev: 'text', text: s });
      }
    }, true);
  });
  post({ ev: 'ready' });
}`;

/** A string as a JavaScript literal that is safe inside a <script> element. */
const js = (s: string): string => JSON.stringify(s).replace(/</g, '\\u003c');
const recPage = (name: string, hostile = false): string =>
  `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#eef}</style></head><body><p>${name}</p><script>${REC};__blRec(${js(name)}, null, ${hostile})</script></body></html>`;

interface FrameSpec {
  name: string;
  /** Builds the frame `f` (an <iframe> already in the page) in the top page's script. */
  build: string;
  /** No script can run in it, so it cannot report (the -files origin, CSP sandbox). */
  silent?: boolean;
  /** The known ordering limit: kept as an expected failure. */
  hostile?: boolean;
  /** The frame lives in a closed shadow root (no renderer-side guard can reach it): a known limit. */
  shadowLimit?: boolean;
  /** Instead of an <iframe> appended to body, the build makes its own node tree (f is undefined). */
  custom?: boolean;
}

function frameSpecs(httpUrl: string | null): FrameSpec[] {
  const nestedOuter = `<!doctype html><style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%;display:block}</style><iframe id="i"></iframe><script>document.getElementById('i').srcdoc = ${js(recPage('nested'))};</script>`;
  const specs: FrameSpec[] = [
    { name: 'srcdoc', build: `f.srcdoc = ${js(recPage('srcdoc'))};` },
    // The parent puts the listeners on the child window; no script runs in the frame itself.
    { name: 'blank-dom', build: `f.contentDocument.body.style.background = '#eef'; __blRec('blank-dom', f.contentWindow, false);` },
    { name: 'blank-write', build: `var d = f.contentDocument; d.open(); d.write(${js(recPage('blank-write'))}); d.close();` },
    { name: 'data', build: `f.src = 'data:text/html;charset=utf-8,' + encodeURIComponent(${js(recPage('data'))});` },
    { name: 'blob', build: `f.src = URL.createObjectURL(new Blob([${js(recPage('blob'))}], { type: 'text/html' }));` },
    { name: 'same-origin', build: `f.src = 'deck.html?inner';` },
    { name: 'nested', build: `f.srcdoc = ${js(nestedOuter)};` },
    { name: 'files', build: `f.src = 'frame-files.html';`, silent: true },
    { name: 'blank-write-hostile', build: `var d = f.contentDocument; d.open(); d.write(${js(recPage('blank-write-hostile', true))}); d.close();`, hostile: true },
    // A closed-shadow-root about:blank frame the deck wires a capture recorder on: no renderer guard can reach
    // it (finding 2 re-verify). The host div carries the id so the test can find its rect; the iframe fills it.
    {
      name: 'shadow-blank',
      custom: true,
      shadowLimit: true,
      build: `var host = document.createElement('div'); host.id = 'shadow-blank'; host.style.cssText = 'position:absolute;left:POSLEFT;top:POSTOP;width:${W}px;height:${H}px'; document.body.appendChild(host); var sr = host.attachShadow({ mode: 'closed' }); var f = document.createElement('iframe'); f.style.cssText = 'width:100%;height:100%;border:0;background:#eef'; sr.appendChild(f); __blRec('shadow-blank', f.contentWindow, false);`,
    },
  ];
  if (httpUrl) specs.push({ name: 'http', build: `f.src = ${js(httpUrl)};` });
  return specs;
}

const COLS = 4;
const W = 160;
const H = 110;
const pos = (i: number) => ({ left: 20 + (i % COLS) * (W + 20), top: 20 + Math.floor(i / COLS) * (H + 20) });
/** A point of the top document with no frame under it (right of the grid). */
const EMPTY = { x: 20 + COLS * (W + 20) + 60, y: 40 };

function deckHtml(specs: FrameSpec[]): string {
  const frames = specs
    .map((s, i) => {
      const p = pos(i);
      if (s.custom) {
        const build = s.build.replace('POSLEFT', `${p.left}px`).replace('POSTOP', `${p.top}px`);
        return `(function(){ ${build} })();`;
      }
      return `(function(){ var f = document.createElement('iframe'); f.id = ${js(s.name)}; f.style.left = '${p.left}px'; f.style.top = '${p.top}px'; document.body.appendChild(f); ${s.build} })();`;
    })
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Drop frames</title>
<style>html,body{margin:0;height:100%;background:#fff;overflow:hidden}iframe{position:absolute;width:${W}px;height:${H}px;border:0;background:#eef}</style>
</head><body><p style="position:absolute;left:${EMPTY.x - 40}px;top:0">Drop frames</p>
<script>${REC}
if (window.top !== window) {
  __blRec('same-origin', null, false);
} else {
  window.__r = [];
  window.addEventListener('message', function (e) { if (e.data && e.data.blRec) window.__r.push(e.data.blRec); });
  __blRec('top', null, false);
${frames}
}
</script></body></html>`;
}

/** A trusted drag onto a webContents at (x, y): dragEnter, dragOver, drop (CDP Input.dispatchDragEvent). */
async function drag(app: BlApp, wcId: number, x: number, y: number, what: { file?: string; text?: string }): Promise<void> {
  await app.electronApp.evaluate(
    async ({ webContents }, a) => {
      const wc = webContents.fromId(a.id)!;
      const dbg = wc.debugger;
      const attached = dbg.isAttached();
      if (!attached) dbg.attach('1.3');
      try {
        const data = a.file
          ? { items: [], files: [a.file], dragOperationsMask: 1 }
          : { items: [{ mimeType: 'text/plain', data: a.text ?? '' }], dragOperationsMask: 1 };
        for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
          await dbg.sendCommand('Input.dispatchDragEvent', { type, x: a.x, y: a.y, data });
        }
      } finally {
        if (!attached) dbg.detach();
      }
    },
    { id: wcId, x, y, file: what.file ?? null, text: what.text ?? null },
  );
}

type Rec = { frame: string; ev: string; types?: string[]; files?: number; text?: string; name?: string };

interface Run {
  app: BlApp;
  deck: DeckView;
  specs: FrameSpec[];
  /** Records per frame during the file drag on that frame (and the top during the main-frame control). */
  fileRecs: Map<string, Rec[]>;
  /** Records per frame during the text drag (the positive control). */
  textRecs: Map<string, Rec[]>;
  topFileRecs: Rec[];
  toast: string;
  deckUrlBefore: string;
  deckUrlAfter: string;
  frameUrls: string[];
}

async function readRecs(deck: DeckView): Promise<Rec[]> {
  return JSON.parse(await deck.eval<string>('JSON.stringify(window.__r.splice(0))')) as Rec[];
}

/** Opens the deck in one trust state, drags a file and then text onto each frame, and keeps what each frame saw. */
async function dropRun(scratch: Scratch, prot: boolean): Promise<Run> {
  const label = prot ? 'protected' : 'trusted';
  let server: http.Server | null = null;
  let httpUrl: string | null = null;
  if (!prot) {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(recPage('http'));
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    httpUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/frame.html`;
  }
  const specs = frameSpecs(httpUrl);
  const dir = scratch.dir(`drop-frames-${label}`);
  const secretDir = scratch.dir(`drop-frames-secret-${label}`);
  const secret = path.join(secretDir, 'secret.html');
  fs.writeFileSync(secret, `<!doctype html><title>x</title><p>${SECRET}</p>`);
  fs.writeFileSync(path.join(dir, 'deck.html'), deckHtml(specs));
  fs.writeFileSync(path.join(dir, 'frame-files.html'), recPage('files'));
  scratch.own(dir);
  scratch.own(secretDir);
  const app = await launchApp({ files: [path.join(dir, 'deck.html')], scratch, protected: prot });
  try {
    const deck = await app.waitForDeck('deck.html');
    const w = await app.win(deck.docId);
    expect(w.trust).toBe(label);
    // Every frame that runs script has reported (the -files frame runs none).
    const scripted = specs.filter((s) => !s.silent).map((s) => s.name);
    await expect
      .poll(async () => {
        const ready = await deck.eval<string[]>(`window.__r.filter(function (m) { return m.ev === 'ready'; }).map(function (m) { return m.frame; })`);
        return scripted.filter((n) => !ready.includes(n));
      }, { timeout: 20_000 })
      .toEqual([]);
    await readRecs(deck);
    const frameUrls = await app.electronApp.evaluate(({ webContents }, id) => webContents.fromId(id)!.mainFrame.framesInSubtree.map((f) => f.url), w.deckWebContentsId);
    const deckUrlBefore = await deck.url();

    // The main-frame control: a file dropped on the top document is refused with the toast, and the page saw nothing.
    expect(await deck.eval<string>(`document.elementFromPoint(${EMPTY.x}, ${EMPTY.y}).tagName`)).not.toBe('IFRAME');
    await drag(app, w.deckWebContentsId, EMPTY.x, EMPTY.y, { file: secret });
    await sleep(600);
    const topFileRecs = await readRecs(deck);
    const shell = await app.shellPage(deck.docId);
    const toast = (await shell.locator('#toast').textContent().catch(() => '')) ?? '';

    const fileRecs = new Map<string, Rec[]>();
    const textRecs = new Map<string, Rec[]>();
    for (const s of specs) {
      const r = await deck.rect(`#${s.name}`);
      if (!r) throw new Error(`no frame #${s.name}`);
      const x = Math.round(r.x + r.w / 2);
      const y = Math.round(r.y + r.h / 2);
      await drag(app, w.deckWebContentsId, x, y, { file: secret });
      await sleep(500);
      fileRecs.set(s.name, await readRecs(deck));
      await drag(app, w.deckWebContentsId, x, y, { text: `probe-${s.name}` });
      await sleep(500);
      textRecs.set(s.name, await readRecs(deck));
    }
    const deckUrlAfter = await deck.url();
    return { app, deck, specs, fileRecs, textRecs, topFileRecs, toast, deckUrlBefore, deckUrlAfter, frameUrls };
  } catch (e) {
    await app.close();
    throw e;
  } finally {
    if (server) server.close();
  }
}

/** Sends forged messages from every subframe's preload world (CDP), and returns how many worlds sent. */
async function sendFromSubframes(app: BlApp, wcId: number): Promise<{ senders: number; frameUrls: string[] }> {
  return await app.electronApp.evaluate(
    async ({ webContents }, id) => {
      const wc = webContents.fromId(id)!;
      const dbg = wc.debugger;
      const attached = dbg.isAttached();
      if (!attached) dbg.attach('1.3');
      const contexts: { id: number; auxData?: { frameId?: string; isDefault?: boolean } }[] = [];
      const onMessage = (_e: unknown, method: string, params: { context?: (typeof contexts)[number] }) => {
        if (method === 'Runtime.executionContextCreated' && params.context) contexts.push(params.context);
      };
      dbg.on('message', onMessage as never);
      try {
        await dbg.sendCommand('Runtime.enable');
        await new Promise((r) => setTimeout(r, 500));
        const tree = (await dbg.sendCommand('Page.getFrameTree')) as { frameTree: { frame: { id: string; url: string } } };
        const mainId = tree.frameTree.frame.id;
        let senders = 0;
        const frameUrls: string[] = [];
        for (const c of contexts) {
          if (!c.auxData || c.auxData.isDefault || c.auxData.frameId === mainId) continue;
          const probe = (await dbg.sendCommand('Runtime.evaluate', {
            contextId: c.id,
            expression: `typeof globalThis.__blTestIpc === 'object' ? location.href : ''`,
            returnByValue: true,
          })) as { result: { value?: string } };
          if (!probe.result.value) continue;
          frameUrls.push(probe.result.value);
          await dbg.sendCommand('Runtime.evaluate', {
            contextId: c.id,
            expression: `(function () {
              var ipc = globalThis.__blTestIpc;
              ipc.send('bl:deck:note', { op: 'create', clientId: 'subframe-' + Math.random(), text: 'from a subframe', marks: [], slide: 0 });
              ipc.send('bl:deck:focus', { textField: true });
              ipc.send('bl:files:drop-refused');
              return true;
            })()`,
            returnByValue: true,
          });
          senders++;
        }
        await dbg.sendCommand('Runtime.disable');
        return { senders, frameUrls };
      } finally {
        dbg.removeListener('message', onMessage as never);
        if (!attached) dbg.detach();
      }
    },
    wcId,
  );
}

for (const prot of [true, false]) {
  const label = prot ? 'Protected' : 'Trusted';
  test.describe(`drops onto the frames of a ${label} deck`, () => {
    const scratch = new Scratch(resolveRunAs());
    let run: Run | null = null;

    test.beforeAll(async () => {
      test.setTimeout(180_000);
      run = await dropRun(scratch, prot);
    });
    test.afterAll(async () => {
      if (run) await run.app.close();
      scratch.cleanup();
    });

    test(`no frame of a ${label} deck sees a dropped file; the same frames take a text drag (positive control)`, async () => {
      const r = run!;
      // The main frame: refused before the page saw it, with the toast, and the view did not navigate.
      expect(r.topFileRecs, 'the top page saw the file drag').toEqual([]);
      expect(r.toast).toContain('drop it on the toolbar or the slide rail');
      expect(r.deckUrlAfter).toBe(r.deckUrlBefore);
      // Every frame kind is there (the -files frame on the second origin, the nested one inside a srcdoc frame).
      expect(r.frameUrls.some((u) => /^blueline:\/\/[^/]+-files\/frame-files\.html/.test(u)), r.frameUrls.join(' ')).toBe(true);
      expect(r.frameUrls.filter((u) => u === 'about:srcdoc').length).toBeGreaterThanOrEqual(3);
      if (!prot) expect(r.frameUrls.some((u) => u.startsWith('http://127.0.0.1:'))).toBe(true);

      const problems: string[] = [];
      for (const s of r.specs) {
        const seen = (recs: Rec[] | undefined) => (recs ?? []).map((m) => `${m.frame}:${m.ev}${m.files ? `(${m.files} files)` : ''}`).join(',') || '-';
        console.log(`[drop-frames ${label}] ${s.name}: file drag ${seen(r.fileRecs.get(s.name))}; text drag ${seen(r.textRecs.get(s.name))}`);
        if (s.hostile || s.shadowLimit) continue;
        const recs = r.fileRecs.get(s.name) ?? [];
        // No frame may see a File, take the drop, or read the bytes.
        for (const m of recs) {
          if ((m.files ?? 0) > 0 || m.ev === 'drop' || m.ev === 'read' || (m.text ?? '').includes(SECRET)) problems.push(`${s.name}: ${JSON.stringify(m)}`);
        }
        // blank-write's own listeners come before the re-added guard (document.open), so it may see the drag
        // (types only, never a File: the guard ends it with dropEffect 'none', so no drop follows). Every other
        // frame must see nothing at all.
        if (s.name !== 'blank-write') {
          for (const m of recs) if (m.frame === s.name || m.frame === 'top') problems.push(`${s.name}: saw ${JSON.stringify(m)}`);
        }
        // The positive control: the text drag at the same point reached this frame's recorder and dropped.
        if (!s.silent) {
          const t = r.textRecs.get(s.name) ?? [];
          if (!t.some((m) => m.frame === s.name && m.ev === 'text' && m.text === `probe-${s.name}`)) problems.push(`${s.name}: the text drag never reached it (${JSON.stringify(t)})`);
        }
      }
      expect(problems, problems.join('\n')).toEqual([]);
    });

    test(`main refuses every message sent from a subframe of a ${label} deck`, async () => {
      const r = run!;
      const before = (await r.app.win(r.deck.docId)).state.notes.length;
      const dropsBefore = r.app.logsMatching(/ipc drop bl:deck:note frame/).length;
      const sent = await sendFromSubframes(r.app, (await r.app.win(r.deck.docId)).deckWebContentsId);
      // The deck preload runs in the subframes (srcdoc, nested, data:, blob:, the same-origin frame, ...).
      expect(sent.senders, sent.frameUrls.join(' ')).toBeGreaterThanOrEqual(4);
      await expect.poll(() => r.app.logsMatching(/ipc drop bl:deck:note frame/).length - dropsBefore, { timeout: 10_000 }).toBeGreaterThanOrEqual(sent.senders);
      await sleep(500);
      expect((await r.app.win(r.deck.docId)).state.notes.length, 'a subframe created a note').toBe(before);
      // Positive control: the same message from the main frame's preload world creates the note.
      await r.deck.isolated(`(function(){ globalThis.__blTestIpc.send('bl:deck:note', { op: 'create', clientId: 'main-frame', text: 'from the main frame', marks: [], slide: 0 }); return true; })()`);
      await expect.poll(async () => (await r.app.win(r.deck.docId)).state.notes.length, { timeout: 10_000 }).toBe(before + 1);
    });

    test(`known limit: a closed-shadow-root about:blank frame a deck wires can take a dropped file (${label})`, async () => {
      // Expected to fail: no renderer-side guard can reach a frame created about:blank inside a closed shadow root
      // before the deck's own capture listener, and a desktop drag enters the page the same way dispatchDragEvent
      // does (finding 2 re-verify; SECURITY.md, Known limits). When it starts passing, the limit is gone.
      test.fail(true, 'no renderer guard reaches a closed-shadow about:blank frame before the deck\'s own listener');
      const r = run!;
      const recs = r.fileRecs.get('shadow-blank') ?? [];
      expect(recs.filter((m) => (m.files ?? 0) > 0 || m.ev === 'read'), JSON.stringify(recs)).toEqual([]);
    });

    test(`known limit: a frame written with document.write whose listener stops the drag first can take the drop (${label})`, async () => {
      // Expected to fail until the guard can get ahead of a listener that document.write's scripts register
      // (the ordering limit of listeners.ts; SECURITY.md, known limits). When it starts passing, the limit is gone.
      test.fail(true, 'listeners.ts ordering limit: document.open() erases the guard; scripts written into the frame register first');
      const r = run!;
      const recs = r.fileRecs.get('blank-write-hostile') ?? [];
      expect(recs.filter((m) => (m.files ?? 0) > 0 || m.ev === 'read'), JSON.stringify(recs)).toEqual([]);
    });
  });
}
