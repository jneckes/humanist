// Dragging selected text inside an Edit field moves it, as in any text field (SPEC 6.3 "Typing, selection … work as
// in any text field"; 9.2 Committing an edit step 2; lead decision E-10, review finding 12). Chromium moves a
// dragged selection with two inputs: deleteByDrag at the source, then insertFromDrop at the drop point. The field
// allowed only the second, so a drag-move left the word in both places and Enter wrote the copy. Real input only:
// a real click opens the field, a real double-click selects the word, and the drag is CDP mouse events
// (Input.dispatchMouseEvent), which Chromium turns into a real drag (as views-drag-inpage.spec.ts does). The file on
// disk is the oracle, byte for byte. A drag that ends outside the field takes nothing out of it: on text that is not
// editable nothing happens, and in the page's own editable element Chromium copies the word there (the field allows
// the deletion only for a drop inside it).
//
// SVG <text> is edited in an <input> the overlay places over it (P2-17), whose events reach window with the overlay
// host as their real target: the same two rules hold there (integration step after the review: the SVG field
// allowed every deleteByDrag, so a drag from it into the page's own editable element took the word out and the blur
// that followed wrote the deletion).
//
// Every test needs the Edit capability: @edit in each title (the reader-only gate leaves them out).

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Scratch, launchApp, resolveRunAs, sleep, type BlApp, type DeckView } from '../helpers/app';

test.describe.configure({ mode: 'serial' });

const DECK = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Drag move</title>
<style>
body { margin: 20px; font: 20px/1.4 sans-serif; }
</style>
</head>
<body>
<h1 id="t1">Alpha beta gamma</h1>
<p id="p2">Second para stays</p>
<div id="ce" contenteditable="true" style="width: 400px; border: 1px solid #888">Target box</div>
<svg width="400" height="40" id="chart"><text id="sv" x="4" y="28" font-size="22">Chart label</text></svg>
<script>
// The drag events the page sees (the field's own drop is stopped before any page listener, P2-7).
window.__drag = [];
['dragover', 'drop', 'dragend'].forEach(function (t) {
  document.addEventListener(t, function (e) {
    var s = t + ':' + ((e.target && e.target.id) || '');
    if (__drag[__drag.length - 1] !== s) __drag.push(s);
  });
});
</script>
</body>
</html>
`;

async function until<T>(what: string, fn: () => Promise<T | undefined>, timeout = 15_000): Promise<T> {
  const end = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch (e) {
      last = e;
    }
    await sleep(100);
  }
  throw new Error(`timed out: ${what}${last ? ` (${last instanceof Error ? last.message : String(last)})` : ''}`);
}

interface Opened {
  s: Scratch;
  app: BlApp;
  deck: DeckView;
  file: string;
  original: string;
}

/** The deck in the test's own temp folder, owned by the user the app runs as (as edit-main-flow.spec.ts does). */
async function open(): Promise<Opened> {
  const s = new Scratch(resolveRunAs());
  const dir = s.dir('edit-drag');
  const file = path.join(dir, 'deck.html');
  fs.writeFileSync(file, DECK);
  s.own(dir);
  const app = await launchApp({ files: [file], scratch: s });
  const deck = await app.waitForDeck('deck.html');
  return { s, app, deck, file, original: DECK };
}

async function close(o: Opened): Promise<void> {
  await o.app.close();
  o.s.cleanup();
}

/** Edit mode, then a real click on #t1's text until the overlay made it the field (its map arrives after first paint). */
async function openField(o: Opened): Promise<void> {
  await o.deck.chord('3');
  await until('Edit mode', async () => ((await o.app.win(o.deck.docId)).appMode === 'edit' ? true : undefined));
  await until(
    'an edit field on #t1',
    async () => {
      await o.deck.clickText('#t1');
      const open = await o.deck.eval<boolean>(`(function(){var e=document.getElementById('t1');return !!e && e.isContentEditable && document.activeElement === e;})()`);
      return open ? true : undefined;
    },
    20_000,
  );
}

interface Points {
  /** The middle of "beta" in #t1. */
  beta: [number, number];
  /** Just past the end of #t1's text. */
  end: [number, number];
  /** The middle of #p2's text (not editable). */
  p2: [number, number];
  /** Inside the page's own contenteditable #ce, right of its text. */
  ce: [number, number];
}

/** View coordinates (the page's CSS pixels times the view's zoom: Fit zooms a deck's view, 6.9). */
async function points(o: Opened): Promise<Points> {
  const zoom = await o.app.electronApp.evaluate(({ webContents }, id) => webContents.fromId(id)?.getZoomFactor() ?? 1, o.deck.wcId);
  const p = await o.deck.eval<Points>(`(function(){
    function box(t, s, e) { var r = document.createRange(); r.setStart(t, s); r.setEnd(t, e); return r.getBoundingClientRect(); }
    var t = document.getElementById('t1').firstChild, q = document.getElementById('p2').firstChild;
    var b = box(t, 6, 10), e = box(t, t.data.length, t.data.length), p = box(q, 0, q.data.length);
    var c = document.getElementById('ce').getBoundingClientRect();
    return { beta: [b.left + b.width / 2, b.top + b.height / 2], end: [e.left + 3, b.top + b.height / 2], p2: [p.left + p.width / 2, p.top + p.height / 2], ce: [c.right - 30, c.top + c.height / 2] };
  })()`);
  const z = (q: [number, number]): [number, number] => [Math.round(q[0] * zoom), Math.round(q[1] * zoom)];
  return { beta: z(p.beta), end: z(p.end), p2: z(p.p2), ce: z(p.ce) };
}

/** CDP mouse events on the deck view: a real double-click (selects the word under it). */
async function doubleClick(o: Opened, at: [number, number]): Promise<void> {
  await o.deck.focus();
  await o.app.electronApp.evaluate(
    async ({ webContents }, a) => {
      const dbg = webContents.fromId(a.id)!.debugger;
      const attached = dbg.isAttached();
      if (!attached) dbg.attach('1.3');
      try {
        const m = (type: string, buttons: number, extra: Record<string, unknown> = {}) =>
          dbg.sendCommand('Input.dispatchMouseEvent', { type, x: a.x, y: a.y, button: 'left', buttons, ...extra });
        await m('mouseMoved', 0, { button: 'none' });
        await m('mousePressed', 1, { clickCount: 1 });
        await m('mouseReleased', 0, { clickCount: 1 });
        await m('mousePressed', 1, { clickCount: 2 });
        await m('mouseReleased', 0, { clickCount: 2 });
        await new Promise((r) => setTimeout(r, 300));
      } finally {
        if (!attached) dbg.detach();
      }
    },
    { id: o.deck.wcId, x: at[0], y: at[1] },
  );
}

/** CDP mouse events on the deck view: press at `from`, move in steps to `to`, release (Chromium starts a real drag). */
async function dragTo(o: Opened, from: [number, number], to: [number, number]): Promise<void> {
  await o.app.electronApp.evaluate(
    async ({ webContents }, a) => {
      const dbg = webContents.fromId(a.id)!.debugger;
      const attached = dbg.isAttached();
      if (!attached) dbg.attach('1.3');
      try {
        const m = (type: string, x: number, y: number, buttons: number, extra: Record<string, unknown> = {}) =>
          dbg.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, ...extra });
        await m('mouseMoved', a.from[0], a.from[1], 0, { button: 'none' });
        await m('mousePressed', a.from[0], a.from[1], 1, { clickCount: 1 });
        for (let i = 1; i <= 12; i++) {
          await m('mouseMoved', Math.round(a.from[0] + ((a.to[0] - a.from[0]) * i) / 12), Math.round(a.from[1] + ((a.to[1] - a.from[1]) * i) / 12), 1);
          await new Promise((r) => setTimeout(r, 30));
        }
        await m('mouseReleased', a.to[0], a.to[1], 0, { clickCount: 1 });
        await new Promise((r) => setTimeout(r, 400));
      } finally {
        if (!attached) dbg.detach();
      }
    },
    { id: o.deck.wcId, from, to },
  );
}

/** Selects "beta" in the open field with a real double-click. */
async function selectBeta(o: Opened, p: Points): Promise<void> {
  await doubleClick(o, p.beta);
  expect(await o.deck.eval<string>('String(getSelection())')).toBe('beta');
  expect(await o.deck.eval<string | null>('document.activeElement && document.activeElement.id')).toBe('t1');
}

/** The field's text as the overlay holds it (its testState), and the element's text in the page. */
async function fieldText(o: Opened): Promise<{ overlay: string | null; page: string }> {
  const st = await o.deck.editState<{ field: { text: string } | null }>();
  return { overlay: st.field ? st.field.text : null, page: await o.deck.eval<string>(`document.getElementById('t1').textContent`) };
}

test('@edit dragging a selected word to the end of the field moves it, and Enter writes the move', async () => {
  const o = await open();
  try {
    await openField(o);
    const p = await points(o);
    await selectBeta(o, p);
    await dragTo(o, p.beta, p.end);
    // Before E-10 the deletion at the source was blocked and the field read "Alpha beta gammabeta".
    // Chromium may hold one of the two spaces left behind as U+00A0 (9.2 step 3 turns it back into a space). On Linux
    // (measured) both spaces stay; macOS turns on Chromium's smart insert and delete, which take a space away with
    // the word and add one before it at the drop (not measured in this container).
    const t = await fieldText(o);
    const moved = t.page.replace(/\u00a0/g, ' ');
    expect(['Alpha  gammabeta', 'Alpha gamma beta']).toContain(moved);
    if (process.platform !== 'darwin') expect(moved).toBe('Alpha  gammabeta');
    expect(t.overlay?.replace(/\u00a0/g, ' ')).toBe(moved);
    await o.deck.key('Enter');
    const want = o.original.replace('<h1 id="t1">Alpha beta gamma</h1>', `<h1 id="t1">${moved}</h1>`);
    await until('the file to hold the moved word', async () => (fs.readFileSync(o.file, 'utf8') === want ? true : undefined)).catch(() => undefined);
    expect(fs.readFileSync(o.file, 'utf8')).toBe(want);
  } finally {
    await close(o);
  }
});

test('@edit a drop of the selected word onto text that is not editable changes nothing', async () => {
  const o = await open();
  try {
    await openField(o);
    const p = await points(o);
    await selectBeta(o, p);
    await dragTo(o, p.beta, p.p2);
    // The drag ran and ended over #p2 (the page sees dragover and dragend; no drop: nothing there takes one).
    const seen = await o.deck.eval<string[]>('window.__drag');
    expect(seen).toContain('dragover:p2');
    expect(seen[seen.length - 1]).toMatch(/^dragend:/);
    expect(seen.filter((x) => x.startsWith('drop:'))).toEqual([]);
    // No editable drop point: Chromium neither deletes at the source nor inserts anywhere, and the field stays open.
    expect(await fieldText(o)).toEqual({ overlay: 'Alpha beta gamma', page: 'Alpha beta gamma' });
    expect(await o.deck.eval<string>(`document.getElementById('p2').textContent`)).toBe('Second para stays');
    expect(await o.deck.eval<boolean>(`document.activeElement === document.getElementById('t1')`)).toBe(true);
    // Enter on an unchanged field writes nothing.
    await o.deck.key('Enter');
    await sleep(1500);
    expect(fs.readFileSync(o.file, 'utf8')).toBe(o.original);
    expect((await o.app.win(o.deck.docId)).state.notes).toEqual([]);
  } finally {
    await close(o);
  }
});

test("@edit a drop of the selected word into the page's own editable element copies it there and takes nothing out of the field", async () => {
  const o = await open();
  try {
    await openField(o);
    const p = await points(o);
    await selectBeta(o, p);
    await dragTo(o, p.beta, p.ce);
    // The drop landed in the page's element, and Chromium put the word there: the page's business, never written.
    expect((await o.deck.eval<string[]>('window.__drag')).filter((x) => x.startsWith('drop:'))).toEqual(['drop:ce']);
    // (macOS's smart insert may put a space before it.)
    expect(await o.deck.eval<string>(`document.getElementById('ce').textContent`)).toMatch(process.platform === 'darwin' ? /^Target box ?beta$/ : /^Target boxbeta$/);
    // The deletion at the source is refused (its drop is outside the field): the field keeps the word. Allowed, it
    // took the word out, and the blur that followed (focus moved to #ce) wrote "Alpha  gamma" with no Enter.
    expect(await o.deck.eval<string>(`document.getElementById('t1').textContent`)).toBe('Alpha beta gamma');
    await sleep(1500);
    expect(fs.readFileSync(o.file, 'utf8')).toBe(o.original);
    expect((await o.app.win(o.deck.docId)).state.notes).toEqual([]);
  } finally {
    await close(o);
  }
});

/** Edit mode, then a real click on the SVG text #sv until the overlay opened its input over it (P2-17). */
async function openSvgField(o: Opened): Promise<void> {
  await o.deck.chord('3');
  await until('Edit mode', async () => ((await o.app.win(o.deck.docId)).appMode === 'edit' ? true : undefined));
  await until(
    'an SVG edit field on #sv',
    async () => {
      await o.deck.clickText('#sv');
      const st = await o.deck.editState<{ field: { svg: boolean } | null }>();
      return st.field && st.field.svg ? true : undefined;
    },
    20_000,
  );
}

interface SvgPoints {
  /** Inside "Chart", the first word of #sv. */
  chart: [number, number];
  /** Right of #sv's text, still over the overlay's input (it is 48 px wider than the text). */
  end: [number, number];
  /** Inside the page's own contenteditable #ce, right of its text. */
  ce: [number, number];
}

async function svgPoints(o: Opened): Promise<SvgPoints> {
  const zoom = await o.app.electronApp.evaluate(({ webContents }, id) => webContents.fromId(id)?.getZoomFactor() ?? 1, o.deck.wcId);
  const p = await o.deck.eval<SvgPoints>(`(function(){
    var r = document.createRange(); r.selectNodeContents(document.getElementById('sv').firstChild);
    var b = r.getBoundingClientRect(), c = document.getElementById('ce').getBoundingClientRect();
    var y = b.top + b.height / 2;
    return { chart: [b.left + b.width * 0.2, y], end: [b.right + 20, y], ce: [c.right - 30, c.top + c.height / 2] };
  })()`);
  const z = (q: [number, number]): [number, number] => [Math.round(q[0] * zoom), Math.round(q[1] * zoom)];
  return { chart: z(p.chart), end: z(p.end), ce: z(p.ce) };
}

async function svgFieldText(o: Opened): Promise<string | null> {
  const st = await o.deck.editState<{ field: { text: string; svg: boolean } | null }>();
  return st.field && st.field.svg ? st.field.text : null;
}

test('@edit in an SVG text field, dragging a selected word to the end moves it, and Enter writes the move', async () => {
  const o = await open();
  try {
    await openSvgField(o);
    const p = await svgPoints(o);
    await doubleClick(o, p.chart);
    await dragTo(o, p.chart, p.end);
    const moved = (await svgFieldText(o))?.replace(/\u00a0/g, ' ');
    expect([' labelChart', 'label Chart']).toContain(moved);
    if (process.platform !== 'darwin') expect(moved).toBe(' labelChart');
    await o.deck.key('Enter');
    const want = o.original.replace('font-size="22">Chart label</text>', `font-size="22">${moved}</text>`);
    await until('the file to hold the moved word', async () => (fs.readFileSync(o.file, 'utf8') === want ? true : undefined)).catch(() => undefined);
    expect(fs.readFileSync(o.file, 'utf8')).toBe(want);
  } finally {
    await close(o);
  }
});

test("@edit a drop from an SVG text field into the page's own editable element copies the word and takes nothing out of the field", async () => {
  const o = await open();
  try {
    await openSvgField(o);
    const p = await svgPoints(o);
    await doubleClick(o, p.chart);
    await dragTo(o, p.chart, p.ce);
    expect((await o.deck.eval<string[]>('window.__drag')).filter((x) => x.startsWith('drop:'))).toEqual(['drop:ce']);
    expect(await o.deck.eval<string>(`document.getElementById('ce').textContent`)).toMatch(process.platform === 'darwin' ? /^Target box ?Chart$/ : /^Target boxChart$/);
    // The deletion at the source is refused (its drop is outside the field). Allowed, it took "Chart" out of the
    // input, and the blur that followed (focus moved to #ce) wrote " label" with no Enter.
    const t = await svgFieldText(o);
    if (t !== null) expect(t).toBe('Chart label');
    await sleep(1500);
    expect(fs.readFileSync(o.file, 'utf8')).toBe(o.original);
    expect((await o.app.win(o.deck.docId)).state.notes).toEqual([]);
  } finally {
    await close(o);
  }
});
