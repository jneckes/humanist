// The render agent in real Electron (SPEC 6.7 Background renders and Index replay; section 10 map steps 3-4
// and the mutation probe; review findings 31-35 and decision D-b). A minimal harness main serves scratch
// pages over `blueline://` (the 9.1 doc/-files split) in a hidden offscreen window with the built deck preload
// in `--bl-mode=render`, and sends RenderCmds the way the render service does.
//
// Run with `npm run test:e2e` (it builds first; global setup starts Xvfb on Linux). BL_E2E_PRELOAD_FILE runs
// another build of dist/preload-deck.cjs (e.g. a copy from before a fix).

import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { electronBinary } from '../../scripts/electron-binary.cjs';

const ROOT = resolve(__dirname, '../..');
const PRELOAD = process.env.BL_E2E_PRELOAD_FILE || join(ROOT, 'packages/app/dist/preload-deck.cjs');

test.skip(process.platform === 'linux' && !process.env.DISPLAY, 'needs a display: run through `npm run test:e2e` (its global setup starts Xvfb)');
test.describe.configure({ mode: 'serial' });

const HARNESS_MAIN = String.raw`
const { app, BrowserWindow, protocol, ipcMain, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
protocol.registerSchemesAsPrivileged([{ scheme: 'blueline', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
let served = { dir: '', file: '' };
let docId = '';
let seq = 0;
function handler(req) {
  const u = new URL(req.url);
  const segs = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (u.host === docId && segs.length === 1 && segs[0] === served.file) {
    return new Response(fs.readFileSync(path.join(served.dir, served.file)), { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  return new Response('', { status: 404 });
}
let reqId = 1;
const pending = new Map();
ipcMain.on('bl:render:reply', (_e, p) => { const r = pending.get(p.reqId); if (r) { pending.delete(p.reqId); r(p); } });
const h = {
  win: null, wc: null,
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  async load(file) {
    served = { dir: path.dirname(file), file: path.basename(file) };
    docId = 'abcdef' + (++seq).toString(16).padStart(10, '0');
    if (h.win && !h.win.isDestroyed()) h.win.destroy();
    const part = 'render-' + docId;
    session.fromPartition(part).protocol.handle('blueline', handler);
    h.win = new BrowserWindow({ width: 1600, height: 900, useContentSize: true, show: false, enableLargerThanScreen: true,
      webPreferences: { offscreen: { deviceScaleFactor: 1 }, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: part,
        preload: process.env.BL_E2E_PRELOAD, additionalArguments: ['--bl-mode=render'], backgroundThrottling: false } });
    h.wc = h.win.webContents;
    h.wc.on('will-navigate', (e) => e.preventDefault());
    await h.wc.loadURL('blueline://' + docId + '/' + encodeURIComponent(served.file));
    await h.wait(400);
  },
  render(cmd) {
    return new Promise((resolve) => {
      const id = reqId++;
      pending.set(id, resolve);
      h.wc.send('bl:render:request', { reqId: id, cmd });
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ reqId: id, ok: false, error: 'timeout' }); } }, 10000);
    });
  },
  async key(keyCode) {
    h.wc.focus();
    h.wc.sendInputEvent({ type: 'keyDown', keyCode });
    h.wc.sendInputEvent({ type: 'keyUp', keyCode });
    await h.wait(300);
  },
  main(code) { return h.wc.executeJavaScript(code); },
};
globalThis.h = h;
app.on('window-all-closed', () => {});
`;

const PAGES: Record<string, string> = {
  // review-map/stopimm.html: the page owns every key from a window capture listener (finding 33).
  'stopimm.html': `<!doctype html><html><head><meta charset="utf-8"><style>.slide{display:none}.slide.on{display:block}</style>
<script>
var cur=0, seen=0;
window.addEventListener('keydown',function(e){
  e.stopImmediatePropagation(); seen++; document.documentElement.dataset.seen = seen;
  if(!e.isTrusted) return;
  var s=[].slice.call(document.querySelectorAll('.slide'));
  if(e.key==='ArrowRight'&&cur<s.length-1){s[cur].classList.remove('on');cur++;s[cur].classList.add('on');}
},true);
</script></head><body>
<section class="slide on"><h1>One</h1></section><section class="slide"><h1>Two</h1></section><section class="slide"><h1>Three</h1></section>
</body></html>`,
  // Visually hidden live region (F17), a display:none copy and a visible copy (finding 31).
  'clipped.html': `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div style="position:absolute;clip:rect(1px,1px,1px,1px);width:1px;height:1px;overflow:hidden">needle in a live region</div>
<div style="display:none">needle in a hidden copy</div>
<p>needle in view</p>
</body></html>`,
  // Open and closed shadow roots, a srcdoc frame at a known offset, an about:blank frame written by script, a
  // frame whose text is below its own viewport, and a data: frame (finding 32).
  'trees.html': `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font:20px/1.5 sans-serif} iframe{position:absolute;border:0;width:600px;height:100px} p{margin:0}
#f1{left:100px;top:300px} #f2{left:800px;top:300px} #f3{left:100px;top:500px;height:60px} #f4{left:800px;top:500px}
</style></head><body>
<h1>Light heading</h1>
<open-card></open-card><closed-card></closed-card>
<iframe id="f1" srcdoc="<body style='margin:0'><p>Frame paragraph</p></body>"></iframe>
<iframe id="f2"></iframe>
<iframe id="f3" srcdoc="<body style='margin:0'><p style='margin-top:200px'>Below the frame's fold</p></body>"></iframe>
<iframe id="f4" src="data:text/html,%3Cp%3EOpaque%3C%2Fp%3E"></iframe>
<script>
customElements.define('open-card', class extends HTMLElement { connectedCallback() { const r = this.attachShadow({ mode: 'open' }); const s = document.createElement('span'); s.textContent = 'Open shadow text'; r.append(s, document.createTextNode('Bare shadow text')); } });
customElements.define('closed-card', class extends HTMLElement { connectedCallback() { const r = this.attachShadow({ mode: 'closed' }); const s = document.createElement('span'); s.textContent = 'Closed shadow text'; r.append(s); } });
const d = document.getElementById('f2').contentDocument; const p = d.createElement('p'); p.textContent = 'Written into a blank frame'; d.body.style.margin = '0'; d.body.append(p);
</script>
</body></html>`,
  // A scrolling document with a stamped breadcrumb (D-b) and short blocks (finding 35).
  'blocks.html': `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:20px/1.5 sans-serif} section{height:150px}</style></head><body>
<section id="a"><h2>Part one</h2><p data-bl-e="bl-7"> / Home<b>x</b> / Docs</p></section>
<section id="b"><h2>Part two</h2></section>
<section id="c"><h2>Part three</h2></section>
</body></html>`,
  // How each text run continues the one before it in its block (dom-walk CollectJoins; review finding 12).
  'joins.html': `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:20px/1.5 sans-serif} .ib{display:inline-block} .none{display:none}</style></head><body>
<h2>Growth</h2><p>Plan ahead.</p>
<p>Bold<b>er</b> moves</p>
<p><b>Hello</b> <i>world</i></p>
<p>Line<br>break</p>
<p>abc<span class="ib">X</span>def</p>
<p>x<span class="none">hidden</span>y</p>
<p>pre<img src="data:," width="4" height="4">img</p>
<div>Text <p>inner</p> more</div>
</body></html>`,
  // A page three viewports tall (finding 34).
  'tall.html': `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0} div{height:900px}</style></head><body>
<div>First screen</div><div>Second screen</div><div>Third screen</div>
</body></html>`,
};

let app: ElectronApplication;
let scratch = '';

test.beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'bl-render-agent-e2e-'));
  mkdirSync(join(scratch, 'pages'));
  for (const [f, html] of Object.entries(PAGES)) writeFileSync(join(scratch, 'pages', f), html);
  writeFileSync(join(scratch, 'main.cjs'), HARNESS_MAIN);
  const args = [join(scratch, 'main.cjs')];
  if (process.platform === 'linux' && process.getuid?.() === 0) args.unshift('--no-sandbox');
  // executablePath: without it Playwright requires electron's index.js, which downloads a missing binary
  // (supply chain, scripts/electron-binary.cjs).
  app = await electron.launch({ executablePath: electronBinary(), args, cwd: ROOT, env: { ...process.env, BL_E2E_PRELOAD: PRELOAD } as Record<string, string> });
  await app.evaluate(async () => {
    for (let i = 0; i < 100 && !(globalThis as { h?: unknown }).h; i++) await new Promise((r) => setTimeout(r, 50));
  });
});

test.afterAll(async () => {
  await app?.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** Runs a function on the harness object in Electron's main process. */
async function H<T>(fn: (h: Any, arg: Any) => Promise<T> | T, arg?: unknown): Promise<T> {
  return app.evaluate(
    async (_electron, { src, arg: a }) => new Function('h', 'arg', `return (${src})(h, arg);`)((globalThis as Any).h, a),
    { src: fn.toString(), arg },
  );
}

const page = (f: string) => join(scratch, 'pages', f);

test('keydowns: the trusted-keydown counter runs before a page window-capture listener that stops every key (finding 33)', async () => {
  const r = await H(async (h, f) => {
    await h.load(f);
    const before = await h.render({ type: 'keydowns' });
    await h.key('Right');
    const after = await h.render({ type: 'keydowns' });
    const cur = await h.render({ type: 'current' });
    return { before, after, cur, seen: await h.main('document.documentElement.dataset.seen') };
  }, page('stopimm.html'));
  expect(r.seen).toBe('1'); // the page's listener ran (and stopped the event)
  expect(r.before).toMatchObject({ ok: true, result: { trusted: 0, all: 0 } });
  expect(r.after).toMatchObject({ ok: true, result: { trusted: 1, all: 1 } });
  expect(r.cur.result.current).toBe(1);
});

test('find: a match clipped to a zero area is marked clipped; a display:none copy is not (finding 31, F17)', async () => {
  const r = await H(async (h, f) => {
    await h.load(f);
    return h.render({ type: 'find', needle: 'needle' });
  }, page('clipped.html'));
  expect(r.ok).toBe(true);
  const by = Object.fromEntries(r.result.matches.map((m: Any) => [m.node.data, [m.visible, m.clipped]]));
  expect(by).toEqual({
    'needle in a live region': [false, true],
    'needle in a hidden copy': [false, false],
    'needle in view': [true, false],
  });
});

test('collect and find enter open shadow roots and same-origin frames, offset frame rects, and list cross-origin frames (finding 32)', async () => {
  const r = await H(async (h, f) => {
    await h.load(f);
    await h.wait(300);
    const c = await h.render({ type: 'collect' });
    const found = await h.render({ type: 'find', needle: 'text' });
    const inFrame = await h.render({ type: 'find', needle: 'blank frame' });
    return { c, found, inFrame };
  }, page('trees.html'));
  expect(r.c.ok).toBe(true);
  const nodes = r.c.result.nodes as Any[];
  const by = Object.fromEntries(nodes.map((n) => [n.node.data, n]));
  expect(Object.keys(by).sort()).toEqual(['Bare shadow text', 'Frame paragraph', 'Light heading', 'Open shadow text', 'Written into a blank frame']);
  expect(by['Light heading'].tree ?? 'document').toBe('document');
  expect(by['Open shadow text'].tree).toBe('shadow');
  expect(by['Bare shadow text'].tree).toBe('shadow');
  expect(by['Frame paragraph'].tree).toBe('frame');
  expect(by['Written into a blank frame'].tree).toBe('frame');
  // Rects are in the top document's viewport: the frame's own position is added.
  expect(by['Frame paragraph'].rect.x).toBeGreaterThanOrEqual(100);
  expect(by['Frame paragraph'].rect.y).toBeGreaterThanOrEqual(300);
  expect(by['Written into a blank frame'].rect.x).toBeGreaterThanOrEqual(800);
  // Locators of subdocument nodes never collide with the top document's.
  expect(by['Open shadow text'].locator.cssPath).toContain('>>>');
  expect(by['Frame paragraph'].locator.cssPath).toContain('>>frame>>');
  // The data: frame is opaque: listed, not walked. The hidden-by-fold frame text and the closed root are not counted.
  expect(r.c.result.crossOriginFrames).toHaveLength(1);
  const texts = (r.found.result.matches as Any[]).map((m) => [m.node.data, m.tree ?? 'document']);
  expect(texts).toEqual(expect.arrayContaining([['Open shadow text', 'shadow'], ['Bare shadow text', 'shadow']]));
  expect(texts.map((t) => t[0])).not.toContain('Closed shadow text');
  expect(r.inFrame.result.matches.map((m: Any) => [m.node.data, m.tree])).toEqual([['Written into a blank frame', 'frame']]);
});

test("collect sends each node's live text nodes (texts) and the block that contains it (D-b, finding 35)", async () => {
  const r = await H(async (h, f) => {
    await h.load(f);
    await h.render({ type: 'detect' });
    return h.render({ type: 'collect' });
  }, page('blocks.html'));
  expect(r.ok).toBe(true);
  const by = Object.fromEntries((r.result.nodes as Any[]).map((n) => [n.node.data, n]));
  expect(by[' / Docs'].node).toMatchObject({ stamp: 'bl-7', textIndex: 1, texts: [' / Home', ' / Docs'] });
  expect(by['Part one'].node.texts).toEqual(['Part one']);
  expect([by['Part one'].slide, by['Part two'].slide, by['Part three'].slide]).toEqual([0, 1, 2]);
});

test('collect says how each text run continues the one before it in its block, as findInPage reads the page (review finding 12)', async () => {
  const r = await H(async (h, f) => {
    await h.load(f);
    await h.render({ type: 'detect' });
    return h.render({ type: 'collect' });
  }, page('joins.html'));
  expect(r.ok).toBe(true);
  const nodes = r.result.nodes as Any[];
  const joins = r.result.joins as number[];
  expect(joins).toHaveLength(nodes.length);
  const of = (data: string) => joins[nodes.findIndex((n) => n.node.data === data)];
  // A new block: never joined (findInPage never matches "growth plan" across the heading).
  expect([of('Growth'), of('Plan ahead.')]).toEqual([0, 0]);
  // An inline element: joined directly ("Bolder"); a space-only node between two inline elements: after a space.
  expect([of('Bold'), of('er'), of(' moves')]).toEqual([0, 1, 1]);
  expect([of('Hello'), of('world')]).toEqual([0, 2]);
  // A line break, an inline-block and an inline image break the run; display: none text is not on the page.
  expect([of('Line'), of('break')]).toEqual([0, 0]);
  expect([of('abc'), of('X'), of('def')]).toEqual([0, 0, 0]);
  expect([of('x'), of('y')]).toEqual([0, 1]);
  expect([of('pre'), of('img')]).toEqual([0, 0]);
  // The text around a nested block is two runs of the outer block.
  expect([of('Text '), of('inner'), of(' more')]).toEqual([0, 0, 0]);
});

test('scroll-to scrolls the document and reports where it is (finding 34)', async () => {
  const r = await H(async (h, f) => {
    await h.load(f);
    const a = await h.render({ type: 'scroll-to', y: 900 });
    const c = await h.render({ type: 'collect' });
    const b = await h.render({ type: 'scroll-to', y: 1e9 });
    return { a, c, b };
  }, page('tall.html'));
  expect(r.a).toMatchObject({ ok: true, result: { scrollY: 900, innerHeight: 900, scrollHeight: 2700 } });
  expect(r.c.result.nodes.map((n: Any) => n.node.data)).toEqual(['Second screen']);
  expect(r.b.result.scrollY).toBe(1800);
});
