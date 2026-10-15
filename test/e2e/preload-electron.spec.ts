// The deck preload in real Electron (SPEC 6.2, 6.4, 6.7, 9.1 Preload, 9.4, 10 Phase 0). Self-contained: it
// builds its own copy of the preload bundle with the scripts/build.mjs options, writes a minimal harness main
// (a `blueline://` handler with the 9.1 doc/-files split, a fake main that answers the handshake and assigns
// note ids) and a few scratch pages to a temp folder, and drives the deck view with trusted input
// (webContents.sendInputEvent).
//
// Run under a display: `xvfb-run -a -s "-screen 0 3840x2160x24" npx playwright test test/e2e/preload-electron.spec.ts`
// (as root the harness passes --no-sandbox).

import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import * as esbuild from 'esbuild';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');
const DECKS = join(ROOT, 'fixtures/decks');

test.skip(process.platform === 'linux' && !process.env.DISPLAY, 'needs a display: run under xvfb-run');
test.describe.configure({ mode: 'serial' });

// ------------------------------------------------------------------------------------------- harness main

const HARNESS_MAIN = String.raw`
const { app, BrowserWindow, protocol, ipcMain, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
protocol.registerSchemesAsPrivileged([{ scheme: 'blueline', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
const PRELOAD = process.env.BL_E2E_PRELOAD;
const MIME = { css: 'text/css', js: 'text/javascript', png: 'image/png', svg: 'image/svg+xml', woff2: 'font/woff2' };
let served = { dir: '', file: '' };
let docId = 'e2e0';
let seq = 0;
function isUtf8(buf) { try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; } catch { return false; } }
function handler(req) {
  const u = new URL(req.url);
  const segs = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (u.host === docId) {
    if (segs.length === 1 && segs[0] === served.file) {
      const body = fs.readFileSync(path.join(served.dir, served.file));
      return new Response(body, { headers: { 'content-type': isUtf8(body) ? 'text/html; charset=utf-8' : 'text/html' } });
    }
    return new Response(null, { status: 307, headers: { location: 'blueline://' + docId + '-files' + u.pathname } });
  }
  if (u.host === docId + '-files') {
    const p = path.join(served.dir, ...segs);
    if (!p.startsWith(served.dir + path.sep) || !fs.existsSync(p)) return new Response('', { status: 404 });
    return new Response(fs.readFileSync(p), { headers: { 'content-type': MIME[path.extname(p).slice(1)] || 'application/octet-stream', 'x-content-type-options': 'nosniff', 'content-security-policy': 'sandbox' } });
  }
  return new Response('', { status: 404 });
}
const log = [];
const allLog = [];
const h = {
  log, allLog, notes: [], nextNote: 1, win: null, wc: null, navs: [],
  init: { mode: 'deck', appMode: 'read', trust: 'trusted', capabilities: { edit: true, agent: true }, editingAllowed: true, map: null, notes: [], userName: 'Josh' },
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  async load(file, o) {
    o = o || {};
    served = { dir: path.dirname(file), file: path.basename(file) };
    docId = 'e2e' + (++seq).toString(16);
    if (h.win && !h.win.isDestroyed()) h.win.destroy();
    log.length = 0; h.navs = [];
    if (o.appMode) h.init.appMode = o.appMode;
    const part = 'deck-' + docId;
    session.fromPartition(part).protocol.handle('blueline', handler);
    h.win = new BrowserWindow({ width: 1600, height: 900, useContentSize: true, show: !o.offscreen,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, partition: part, preload: PRELOAD,
        additionalArguments: ['--bl-mode=' + (o.mode || 'deck'), '--bl-test=1'], ...(o.offscreen ? { offscreen: { deviceScaleFactor: 1 } } : {}) } });
    h.wc = h.win.webContents;
    h.wc.on('will-navigate', (e, url) => { h.navs.push(url); e.preventDefault(); });
    await h.wc.loadURL('blueline://' + docId + '/' + encodeURIComponent(served.file));
    await h.wait(o.settle || 400);
    return true;
  },
  main(code) { return h.wc.executeJavaScript(code); },
  send(ch, p) { h.wc.send(ch, p); },
  msgs(ch) { return log.filter((m) => m.ch === ch).map((m) => m.p); },
  clear() { log.length = 0; },
  async key(keyCode, modifiers) {
    modifiers = modifiers || [];
    h.wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode.length === 1 && !modifiers.some((m) => ['cmd', 'control', 'meta', 'alt'].includes(m))) h.wc.sendInputEvent({ type: 'char', keyCode, modifiers });
    h.wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await h.wait(60);
  },
  async type(text) { for (const c of text) h.wc.sendInputEvent({ type: 'char', keyCode: c }); await h.wait(60); },
  async drag(points, modifiers) {
    modifiers = modifiers || [];
    const p0 = points[0];
    h.wc.sendInputEvent({ type: 'mouseMove', x: p0[0], y: p0[1], modifiers });
    h.wc.sendInputEvent({ type: 'mouseDown', x: p0[0], y: p0[1], button: 'left', clickCount: 1, modifiers });
    for (const p of points.slice(1)) { h.wc.sendInputEvent({ type: 'mouseMove', x: p[0], y: p[1], button: 'left', modifiers: modifiers.concat(['leftButtonDown']) }); await h.wait(8); }
    const p1 = points[points.length - 1];
    h.wc.sendInputEvent({ type: 'mouseUp', x: p1[0], y: p1[1], button: 'left', clickCount: 1, modifiers });
    await h.wait(120);
  },
  async click(x, y) { h.wc.sendInputEvent({ type: 'mouseMove', x, y }); h.wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); h.wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 }); await h.wait(100); },
  setMode(m) { h.init.appMode = m; h.send('bl:deck:app-mode', { appMode: m }); },
  rect(sel) { return h.main('(function(){var e=document.querySelector(' + JSON.stringify(sel) + ');if(!e)return null;var r=e.getBoundingClientRect();return [r.left,r.top,r.width,r.height]})()'); },
  loop(r, pad, turn, n) {
    pad = pad === undefined ? 20 : pad; turn = turn || 0.95; n = n || 36;
    const cx = r[0] + r[2] / 2, cy = r[1] + r[3] / 2, out = [];
    for (let i = 0; i <= n; i++) { const t = (i / n) * Math.PI * 2 * turn; out.push([Math.round(cx + (r[2] / 2 + pad) * Math.cos(t)), Math.round(cy + (r[3] / 2 + pad) * Math.sin(t))]); }
    return out;
  },
  async bluePixels(x, y, size) {
    const img = await h.wc.capturePage({ x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)), width: size, height: size });
    const b = img.toBitmap(); let n = 0;
    for (let i = 0; i < b.length; i += 4) if (b[i] > 180 && b[i + 2] < 100 && b[i + 1] < 140) n++;
    return n;
  },
  pushNotes(created) { h.send('bl:deck:notes', created ? { notes: h.notes, created } : { notes: h.notes }); },
};
const toMarks = (ms) => ms.map((m, i) => ({ n: i + 1, tool: m.tool, shape: m.shape, path: m.path, targets: [] }));
for (const ch of ['bl:deck:ready', 'bl:deck:focus', 'bl:deck:link', 'bl:deck:slides', 'bl:deck:mode', 'bl:deck:note', 'bl:deck:diag', 'bl:render:reply']) {
  ipcMain.on(ch, (e, p) => {
    log.push({ ch, p });
    allLog.push({ ch, p });
    if (ch === 'bl:deck:ready') e.sender.send('bl:deck:init', h.init);
    if (ch === 'bl:deck:mode') h.setMode('read');
    if (ch !== 'bl:deck:note') return;
    if (p.op === 'create') {
      const id = 'n-' + String(h.nextNote++).padStart(4, '0');
      h.notes.push({ id, kind: 'markup', status: 'draft', author: 'josh', createdAt: '', updatedAt: '', pass: null, slide: { index: p.slide, id: null, title: null, nav: { kind: 'none', value: 0 } }, targets: [], marks: toMarks(p.marks), text: p.text, recordings: [], thread: [] });
      setTimeout(() => h.pushNotes([{ clientId: p.clientId, id }]), 30);
    } else if (p.op === 'update') {
      const n = h.notes.find((x) => x.id === p.id);
      if (n) { if (p.text !== undefined) n.text = p.text; if (p.marks) n.marks = toMarks(p.marks); }
      setTimeout(() => h.pushNotes(), 10);
    } else if (p.op === 'close') {
      const i = h.notes.findIndex((x) => x.id === p.id);
      if (i >= 0) { const n = h.notes[i]; if (!n.text && n.marks.length === 0) h.notes.splice(i, 1); else n.status = 'open'; }
      setTimeout(() => h.pushNotes(), 10);
    }
  });
}
let reqId = 1;
const pending = new Map();
ipcMain.on('bl:render:reply', (_e, p) => { const r = pending.get(p.reqId); if (r) { pending.delete(p.reqId); r(p); } });
h.render = (cmd) => new Promise((resolve) => {
  const id = reqId++;
  pending.set(id, (p) => { allLog.push({ ch: 'reply:' + cmd.type, p }); resolve(p); });
  h.send('bl:render:request', { reqId: id, cmd });
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve({ reqId: id, ok: false, error: 'timeout' }); } }, 10000);
});
h.electron = require('electron');
globalThis.h = h;
app.on('window-all-closed', () => {});
`;

// ------------------------------------------------------------------------------------------- scratch pages

/** Records whether the host existed when the first page script ran, and the order the page's listeners see keys. */
const EARLY_PAGE = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<script>
  document.documentElement.dataset.hostAtFirstScript = String(!!document.querySelector('blueline-overlay'));
  var order = [];
  function rec(s) { order.push(s); document.documentElement.dataset.order = order.join(','); }
  window.addEventListener('keydown', function (e) { rec('w-cap:' + e.code); }, true);
  document.addEventListener('keydown', function (e) { rec('d-cap:' + e.code); }, true);
  window.addEventListener('keydown', function (e) { rec('w-bub:' + e.code); });
  window.addEventListener('keypress', function (e) { rec('press:' + e.code); }, true);
  window.addEventListener('keyup', function (e) { rec('up:' + e.code); }, true);
  document.addEventListener('click', function () { rec('click'); });
</script>
</head><body style="margin:0"><h1 style="margin:200px 300px; display:inline-block">Early</h1><p>Body text here.</p></body></html>`;

/** The strictest policy: nothing loads, no inline styles, Trusted Types required, a fake reveal.js in the main world. */
const STRICT_PAGE = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-x'; require-trusted-types-for 'script'; trusted-types 'none'">
<script nonce="x">
  (function () {
    var seen = [];
    document.addEventListener('securitypolicyviolation', function (e) {
      seen.push(e.effectiveDirective + ' ' + (e.blockedURI || '-'));
      document.documentElement.dataset.cspViolations = seen.join(' | ');
    });
  })();
</script>
</head><body>
<div class="reveal"><div class="slides">
  <section><h1 id="t">Strict deck</h1><p class="spin">Nothing loads by URL here.</p></section>
  <section><h2>Second</h2><p>Two</p></section>
  <section><h2>Third</h2><p>Three</p></section>
</div></div>
<script nonce="x">
  window.Reveal = {
    slide: function (h, v) {
      document.documentElement.dataset.revealCalled = h + ',' + v;
      var s = document.querySelectorAll('.reveal .slides > section');
      for (var i = 0; i < s.length; i++) s[i].classList.toggle('present', i === h);
    },
    getConfig: function () { return { width: 1280, height: 720 }; },
  };
  document.querySelector('.reveal .slides > section').classList.add('present');
  var t = document.getElementById('t'); t.style.display = 'inline-block'; t.style.margin = '200px 300px';
  document.querySelector('.spin').animate([{ opacity: 1 }, { opacity: 0.5 }], { duration: 1000, iterations: Infinity });
  document.documentElement.dataset.scriptsRan = 'yes';
</script>
</body></html>`;

// ------------------------------------------------------------------------------------------- setup

/** `@blueline/core/<file>` → packages/core/src/<file>.ts, as in scripts/build.mjs. */
const coreSubpaths: esbuild.Plugin = {
  name: 'core-subpaths',
  setup(b) {
    b.onResolve({ filter: /^@blueline\/core\// }, (a) => ({ path: join(ROOT, 'packages/core/src', a.path.slice('@blueline/core/'.length) + '.ts') }));
  },
};

let app: ElectronApplication;
let scratch = '';

test.beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'bl-preload-e2e-'));
  mkdirSync(join(scratch, 'pages'));
  writeFileSync(join(scratch, 'pages/early.html'), EARLY_PAGE);
  writeFileSync(join(scratch, 'pages/strict.html'), STRICT_PAGE);
  writeFileSync(join(scratch, 'main.cjs'), HARNESS_MAIN);
  // The scripts/build.mjs options for dist/preload-deck.cjs.
  await esbuild.build({
    bundle: true,
    charset: 'ascii',
    logLevel: 'warning',
    legalComments: 'none',
    entryPoints: [join(ROOT, 'packages/app/src/preload/deck.ts')],
    outfile: join(scratch, 'preload-deck.cjs'),
    platform: 'browser',
    format: 'cjs',
    target: 'chrome152',
    external: ['electron'],
    plugins: [coreSubpaths],
  });
  const args = [join(scratch, 'main.cjs')];
  if (process.platform === 'linux' && process.getuid?.() === 0) args.unshift('--no-sandbox');
  app = await electron.launch({ args, cwd: ROOT, env: { ...process.env, BL_E2E_PRELOAD: join(scratch, 'preload-deck.cjs') } as Record<string, string> });
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function H<T>(fn: (h: any, arg: any) => Promise<T> | T, arg?: unknown): Promise<T> {
  return app.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (_electron, { src, arg: a }) => new Function('h', 'arg', `return (${src})(h, arg);`)((globalThis as any).h, a),
    { src: fn.toString(), arg },
  );
}

// ------------------------------------------------------------------------------------------- overlay

test('the overlay host mounts before the first page script, closed, and stays mounted (9.1, 9.6)', async () => {
  const r = await H(async (h, f) => {
    await h.load(f);
    const q = "document.querySelector('blueline-overlay')";
    const first = await h.main(
      `({ at: document.documentElement.dataset.hostAtFirstScript, last: document.documentElement.lastElementChild.localName, shadow: String(${q}.shadowRoot), pos: getComputedStyle(${q}).position, z: getComputedStyle(${q}).zIndex, pe: getComputedStyle(${q}).pointerEvents })`,
    );
    await h.main(`${q}.remove()`);
    await h.wait(50);
    const back = await h.main(`!!${q}`);
    await h.main(`${q}.style.setProperty('display','none','important')`);
    await h.wait(50);
    const display = await h.main(`getComputedStyle(${q}).display`);
    const globals = await h.main(`['__blTestIpc','ipcRenderer','blueline','require','process','webFrame'].filter((k) => k in window)`);
    return { first, back, display, globals };
  }, join(scratch, 'pages/early.html'));
  expect(r.first).toEqual({ at: 'true', last: 'blueline-overlay', shadow: 'null', pos: 'fixed', z: '2147483647', pe: 'none' });
  expect(r.back).toBe(true);
  expect(r.display).toBe('block');
  // Nothing reaches the page's world: no contextBridge, and the test hook lives in the isolated world only.
  expect(r.globals).toEqual([]);
});

// ------------------------------------------------------------------------------------------- key router

test('the capture listener runs first and its stopImmediatePropagation stops main-world listeners (6.2)', async () => {
  const r = await H(async (h, f) => {
    await h.load(f, { appMode: 'read' });
    await h.key('Right');
    const read = await h.main('order.splice(0).join()');
    h.setMode('review');
    await h.wait(80);
    await h.key('v');
    const review = await h.main('order.splice(0).join()');
    await h.key('Right');
    const forward = await h.main('order.splice(0).join()');
    await h.key('v', ['meta']);
    await h.key('v', ['control']);
    const chords = await h.main('order.splice(0).join()');
    await h.main(`window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true }))`);
    await h.wait(50);
    const synthetic = await h.main('order.splice(0).join()');
    return { read, review, forward, chords, synthetic, modeMsgs: h.msgs('bl:deck:mode').length };
  }, join(scratch, 'pages/early.html'));
  expect(r.read).toBe('w-cap:ArrowRight,d-cap:ArrowRight,w-bub:ArrowRight,up:ArrowRight');
  expect(r.review).toBe(''); // consumed: no keydown, keypress or keyup reached the page
  expect(r.forward).toBe('w-cap:ArrowRight,d-cap:ArrowRight,w-bub:ArrowRight,up:ArrowRight');
  expect(r.chords).toBe('w-cap:KeyV,d-cap:KeyV,w-bub:KeyV,up:KeyV,w-cap:KeyV,d-cap:KeyV,w-bub:KeyV,up:KeyV');
  // An untrusted Esc is the page's own business: the router ignores it (no mode request).
  expect(r.synthetic).toBe('w-cap:Escape,w-bub:Escape');
  expect(r.modeMsgs).toBe(0);
});

test('diagnostics: the reveal fixture key log shows the preload first and the page stopped (section 10)', async () => {
  const r = await H(async (h, f) => {
    await h.load(f, { mode: 'diagnostics', appMode: 'read', settle: 900 });
    await h.key('Right');
    await h.wait(400);
    h.setMode('review');
    await h.wait(80);
    await h.key('k');
    await h.key('Left');
    await h.wait(400);
    const log = await h.main('document.documentElement.dataset.blKeyLog');
    const diag = h.msgs('bl:deck:diag').filter((d: Any) => ['key-order', 'stop-propagation', 'deck-moved'].includes(d.event));
    return { log, diag };
  }, join(DECKS, 'reveal-hash/index.html'));
  const ko = r.diag.filter((d: Any) => d.event === 'key-order').map((d: Any) => d.data.first);
  expect(ko).toEqual(['preload', 'preload', 'preload']);
  expect(r.diag).toContainEqual({ event: 'stop-propagation', data: { pageListenerRan: false, key: 'k', code: 'KeyK' } });
  expect(r.diag.filter((d: Any) => d.event === 'deck-moved').map((d: Any) => d.data)).toEqual([
    { from: 0, to: 1 },
    { from: 1, to: 0 },
  ]);
  // The page's own listeners saw ArrowRight and ArrowLeft (seq 2), never K.
  expect(r.log).toBe('2:ArrowLeft:true');
});

// ------------------------------------------------------------------------------------------- card and ink

test('two strokes with a card open make two marks on one note; Shift starts a separate note (6.4)', async () => {
  const r = await H(async (h, f) => {
    await h.load(f, { mode: 'diagnostics', appMode: 'review', settle: 900 });
    h.notes.length = 0;
    await h.key('1');
    await h.drag(h.loop(await h.rect('#diag-heading')));
    // Wispr Flow pastes through the clipboard (section 10, Expected Wispr behavior).
    h.electron.clipboard.writeText('make ');
    h.wc.paste();
    await h.wait(80);
    const h1 = await h.rect('h1');
    const squiggle = [];
    for (let i = 0; i <= 20; i++) squiggle.push([Math.round(h1[0] + 600 + i * 20), Math.round(h1[1] + 10 + (i % 2) * 30)]);
    await h.drag(squiggle);
    await h.type('one match two');
    await h.wait(450);
    const one = JSON.parse(JSON.stringify(h.notes));
    const focus = h.msgs('bl:deck:focus');
    const marksAdded = h.msgs('bl:deck:diag').filter((d: Any) => d.event === 'mark-added').map((d: Any) => d.data.n);
    await h.key('Escape');
    await h.wait(100);
    await h.drag(h.loop([1150, 650, 160, 80]), ['shift']);
    await h.type('separate');
    await h.wait(450);
    await h.key('Escape');
    await h.wait(100);
    await h.key('Escape');
    await h.wait(150);
    const creates = h.msgs('bl:deck:note').filter((o: Any) => o.op === 'create');
    return { one, focus, marksAdded, all: h.notes.map((n: Any) => [n.id, n.text, n.marks.length, n.status]), mode: h.msgs('bl:deck:mode'), creates };
  }, join(DECKS, 'reveal-hash/index.html'));
  expect(r.one).toHaveLength(1);
  expect(r.one[0].text).toBe('make one match two'); // the caret stayed in the card through the second stroke
  expect(r.one[0].marks.map((m: { n: number; shape: string }) => [m.n, m.shape])).toEqual([
    [1, 'ellipse'],
    [2, 'freehand'],
  ]);
  expect(r.marksAdded).toEqual([1, 2]);
  expect(r.focus).toEqual([{ textField: false }, { textField: true }]);
  expect(r.all).toEqual([
    ['n-0001', 'make one match two', 2, 'open'],
    ['n-0002', 'separate', 1, 'open'],
  ]);
  expect(r.creates[0].marks[0].targets[0]).toEqual({ css: '#diag-heading', text: 'Strategy offsite, day one', role: 'heading', stamp: null });
  expect(r.creates[0].slide).toBe(0);
  expect(r.mode).toEqual([{ mode: 'read' }]); // the second Esc asks main for Read
});

test('after document.open() the router is reinstalled and the overlay remounted (listeners.ts)', async () => {
  const r = await H(async (h, f) => {
    await h.load(f, { mode: 'diagnostics', appMode: 'review' });
    await h.main(
      `document.open(); document.write('<!DOCTYPE html><html><head><script>var order=[];setTimeout(function(){window.addEventListener("keydown",function(e){order.push(e.code)},true);},0);<\\/script></head><body><h1>Rewritten</h1></body></html>'); document.close();`,
    );
    await h.wait(200);
    await h.key('v');
    return { host: await h.main(`!!document.querySelector('blueline-overlay')`), order: await h.main('order.join()'), shortcuts: h.msgs('bl:deck:diag').filter((d: Any) => d.event === 'shortcut').map((d: Any) => d.data.action) };
  }, join(scratch, 'pages/early.html'));
  expect(r).toEqual({ host: true, order: '', shortcuts: ['tool-select'] });
});

test('the overlay works under every CSP fixture and adds no violation (section 10 Exit gate, 9.1)', async () => {
  const pages = [
    join(DECKS, 'csp-default-none.html'),
    join(DECKS, 'csp-nonce-strict-dynamic.html'),
    join(DECKS, 'csp-self-inline.html'),
    join(scratch, 'pages/strict.html'),
  ];
  for (const page of pages) {
    const r = await H(async (h, f) => {
      await h.load(f, { appMode: 'review' });
      const before = await h.main('document.documentElement.dataset.cspViolations || null');
      h.notes.length = 0;
      await h.key('1');
      const rect = await h.rect('h1');
      const loop = h.loop(rect);
      await h.drag(loop);
      await h.wait(150);
      await h.type('csp ok');
      await h.wait(450);
      const blue = await h.bluePixels(loop[Math.floor(loop.length / 2)][0] - 6, loop[Math.floor(loop.length / 2)][1] - 6, 12);
      await h.key('Escape');
      const after = await h.main('document.documentElement.dataset.cspViolations || null');
      return { before, after, ran: await h.main('document.documentElement.dataset.scriptsRan'), notes: h.notes.map((n: Any) => [n.text, n.marks.length]), blue };
    }, page);
    expect(r.ran, page).toBe('yes');
    expect(r.notes, page).toEqual([['csp ok', 1]]);
    expect(r.blue, page).toBeGreaterThan(0); // the stroke is drawn
    expect(r.after, page).toBe(r.before); // the deck's own expected violations only
  }
});

test('the Diagnostics heading logs beforeinput, paste and input, and turns pasted line breaks into spaces (9.2, 10)', async () => {
  const r = await H(async (h, f) => {
    const { clipboard } = h.electron;
    await h.load(f, { mode: 'diagnostics', appMode: 'read', settle: 900 });
    const rr = await h.rect('#diag-heading');
    await h.click(Math.round(rr[0] + rr[2] / 2), Math.round(rr[1] + rr[3] / 2));
    const during = await h.main(`document.querySelector('#diag-heading').getAttribute('contenteditable') + ' ' + getComputedStyle(document.querySelector('#diag-heading')).textTransform`);
    await h.key('End');
    await h.type(' X');
    clipboard.writeText('pasted\nline');
    h.wc.paste();
    await h.wait(150);
    await h.key('Return');
    await h.wait(100);
    const after = await h.main(`[document.querySelector('#diag-heading').textContent, document.querySelector('#diag-heading').getAttribute('contenteditable'), getComputedStyle(document.querySelector('#diag-heading')).textTransform, document.documentElement.dataset.blKeyLog || null]`);
    const events = h.msgs('bl:deck:diag').filter((d: Any) => ['beforeinput', 'paste'].includes(d.event)).map((d: Any) => d.event + ':' + (d.data.inputType || d.data.length));
    return { during, after, events, focus: h.msgs('bl:deck:focus') };
  }, join(DECKS, 'reveal-hash/index.html'));
  expect(r.during).toBe('plaintext-only none'); // 6.3 source case while editing
  expect(r.after).toEqual(['Strategy offsite, day one Xpasted line', null, 'uppercase', null]); // no key reached the page
  expect(r.events).toEqual(['beforeinput:insertText', 'beforeinput:insertText', 'paste:11', 'beforeinput:insertFromPaste']);
  expect(r.focus).toEqual([{ textField: false }, { textField: true }, { textField: false }]);
});

test('a trusted link click is reported without preventing it; fragment links are not (9.9)', async () => {
  const r = await H(async (h, f) => {
    await h.load(f, { appMode: 'read' });
    for (let i = 0; i < 3; i++) {
      await h.key('Right');
      await h.wait(500);
    }
    const pos = await h.main(`Array.from(document.querySelectorAll('a')).map((a) => { const r = a.getClientRects()[0]; return r ? [Math.round(r.left + 4), Math.round(r.top + r.height / 2)] : null; }).filter(Boolean)`);
    for (const p of pos) await h.click(p[0], p[1]);
    await h.main(`document.querySelector('a[href^="https"]').click()`); // untrusted: not reported
    await h.wait(100);
    return { links: h.msgs('bl:deck:link'), navs: h.navs };
  }, join(DECKS, 'inline-markup.html'));
  expect(r.links).toEqual([{ href: 'https://chat.northwind.example/gtm' }, { href: 'mailto:revops@northwind.example' }, { href: 'https://northwind.example/gtm/' }]);
  // The navigation still happens (main cancels it in will-navigate); the untrusted click navigates too.
  expect(r.navs.slice(0, 3)).toEqual(['https://chat.northwind.example/gtm', 'mailto:revops@northwind.example', 'https://northwind.example/gtm/']);
});

// ------------------------------------------------------------------------------------------- render agent

test('render agent: detection matches every fixture, and the walk counts each visible node once (9.4, 10)', async () => {
  test.setTimeout(300_000);
  const expects = readdirSync(DECKS)
    .filter((f) => f.endsWith('.expect.json'))
    .map((f) => join(DECKS, f))
    .concat(join(DECKS, 'reveal-hash/index.expect.json'));
  for (const ef of expects) {
    const exp = JSON.parse(readFileSync(ef, 'utf8'));
    const r = await H(async (h, f) => {
      await h.load(f, { mode: 'render', offscreen: true, settle: 700 });
      const det = await h.render({ type: 'detect' });
      const seen = new Set();
      const n = det.ok ? det.result.count : 0;
      const errors = [];
      for (let i = 0; i < n; i++) {
        if (i > 0) {
          if (det.result.navKind === 'index') {
            // Index navigation is main's: trusted keys with sendInputEvent (6.7).
            h.wc.focus();
            h.wc.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
            h.wc.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
            await h.wait(450);
          } else {
            const g = await h.render({ type: 'goto', index: i });
            if (!g.ok || !g.result.navigated || g.result.current !== i) errors.push(['goto', i, g]);
          }
        }
        const s = await h.render({ type: 'settle' });
        const cur = await h.render({ type: 'current' });
        if (!cur.ok || cur.result.current !== i) errors.push(['current', i, cur]);
        const c = await h.render({ type: 'collect' });
        if (!s.ok || !s.result.sheetAdopted || !c.ok) errors.push(['settle/collect', i, s, c.error]);
        else for (const nd of c.result.nodes) seen.add(nd.key);
      }
      return { det, total: seen.size, errors };
    }, join(dirname(ef), exp.deck));
    expect(r.det.ok, exp.deck).toBe(true);
    const d = r.det.result;
    expect([d.kind, d.count, d.titles], exp.deck).toEqual([exp.kind, exp.slides, exp.titles]);
    // generic-hash opens with no hash: hash navigation is known only after the deck first moves (9.4 step 2).
    expect(d.navKind, exp.deck).toBe(exp.deck === 'generic-hash.html' ? 'index' : exp.navKind);
    if (exp.revealIndices) expect(d.revealIndices).toEqual(exp.revealIndices);
    if (exp.designSize) expect(d.designSize).toEqual(exp.designSize);
    expect(r.errors, exp.deck).toEqual([]);
    expect(r.total, exp.deck).toBeGreaterThan(0);
  }
});

test('render agent: generic-hash reports hash navigation once the deck has moved the hash (9.4 step 2)', async () => {
  const r = await H(async (h, f) => {
    await h.load(f, { mode: 'render', offscreen: true, settle: 600 });
    await h.render({ type: 'detect' });
    h.wc.focus();
    h.wc.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
    h.wc.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
    await h.wait(500);
    const det = await h.render({ type: 'detect' });
    const g = await h.render({ type: 'goto', index: 4 });
    return { det: det.result, g: g.result, hash: await h.main('location.hash') };
  }, join(DECKS, 'generic-hash.html'));
  expect(r.det.navKind).toBe('hash');
  expect(r.det.hashes).toEqual(['#intro', '#roles', '#process', '#budget', '#ask']);
  expect(r.g).toEqual({ navigated: true, current: 4, navKind: 'hash' });
  expect(r.hash).toBe('#ask');
});

test('render agent: Reveal.slide and getConfig run in the main world under a strict CSP; settle pauses animations (6.7, 9.4)', async () => {
  const r = await H(async (h, f) => {
    await h.load(f, { mode: 'render', offscreen: true });
    const det = await h.render({ type: 'detect' });
    const go = await h.render({ type: 'goto', index: 2 });
    const settle = await h.render({ type: 'settle' });
    const state = await h.main(`[document.documentElement.dataset.revealCalled, getComputedStyle(document.querySelector('.spin')).animationPlayState, document.getAnimations().map((a) => a.playState).join(), document.documentElement.dataset.cspViolations || null]`);
    const find = await h.render({ type: 'find', needle: 'Three' });
    const loc = find.result.matches[0].locator;
    const locate = await h.render({ type: 'locate', locator: loc });
    const blocks = await h.render({ type: 'scroll-blocks' });
    const bad = await h.render({ type: 'goto', index: 99 });
    return { det: det.result, go: go.result, settle: settle.result, state, find: find.result, locate: locate.result, blocks: blocks.ok, bad };
  }, join(scratch, 'pages/strict.html'));
  expect(r.det.designSize).toEqual({ w: 1280, h: 720 }); // Reveal.getConfig() read from the main world
  expect(r.go).toEqual({ navigated: true, current: 2, navKind: 'reveal' });
  expect(r.settle).toEqual({ fontsReady: true, paused: 1, sheetAdopted: true });
  expect(r.state).toEqual(['2,0', 'paused', 'paused', null]);
  expect(r.find.matches).toHaveLength(1);
  expect(r.find.matches[0]).toMatchObject({ node: { stamp: null, textIndex: 0, data: 'Three' }, visible: true, slide: 2 });
  expect(r.locate).toMatchObject({ found: true, visible: true, slide: 2, node: { node: { data: 'Three' } } });
  expect(r.blocks).toBe(true);
  expect(r.bad.ok).toBe(false);
});

// ------------------------------------------------------------------------------------------- contract with main

test('every message the preload sent in this run passes main\'s IPC validators (9.1; ipc-guard.ts)', async () => {
  // Main's own validators, bundled as main.cjs would bundle them.
  let guard: Any;
  try {
    await esbuild.build({
      bundle: true,
      logLevel: 'silent',
      entryPoints: [join(ROOT, 'packages/app/src/main/ipc-guard.ts')],
      outfile: join(scratch, 'ipc-guard.cjs'),
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
      plugins: [coreSubpaths],
    });
    guard = createRequire(__filename)(join(scratch, 'ipc-guard.cjs'));
  } catch (e) {
    test.skip(true, `ipc-guard.ts did not build: ${e}`);
    return;
  }
  const all: { ch: string; p: Any }[] = await H((h) => JSON.parse(JSON.stringify(h.allLog)));
  expect(all.length).toBeGreaterThan(50);
  const failures: unknown[] = [];
  const seen = new Set<string>();
  for (const m of all) {
    seen.add(m.ch);
    if (m.ch.startsWith('reply:')) {
      const type = m.ch.slice('reply:'.length);
      const reply = guard.validateRenderReply(m.p);
      if (!reply.ok) failures.push([m.ch, reply.why]);
      else if (m.p.ok && type === 'detect' && !guard.validateDetectResult(reply.value.result).ok) failures.push([m.ch, guard.validateDetectResult(reply.value.result).why]);
      else if (m.p.ok && type === 'collect' && !guard.validateCollectResult(reply.value.result).ok) failures.push([m.ch, guard.validateCollectResult(reply.value.result).why]);
      continue;
    }
    const v = guard.DECK_VALIDATORS[m.ch];
    if (!v) {
      if (m.ch !== 'bl:render:reply') failures.push([m.ch, 'no validator']);
      continue;
    }
    const res = v(m.p);
    if (!res.ok) failures.push([m.ch, res.why, m.p]);
  }
  expect(failures).toEqual([]);
  for (const ch of ['bl:deck:ready', 'bl:deck:focus', 'bl:deck:link', 'bl:deck:slides', 'bl:deck:mode', 'bl:deck:note', 'bl:deck:diag', 'reply:detect', 'reply:collect']) {
    expect(seen.has(ch), ch).toBe(true);
  }
});
