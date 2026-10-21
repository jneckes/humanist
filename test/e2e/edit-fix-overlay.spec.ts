// The overlay keeps Edit usable and the field faithful (lead decisions E-6, E-9, E-10; review findings 2, 9, 10, 11
// and 13; SPEC 6.3 Hover outlines, The edit field, Fit guard; 9.2 Strategy 2 step 5.5; P2-6). Real clicks and keys on
// the built app:
//   - an own html-text write advances the page version even when the new map differs in a shadow (a script literal
//     the typed text repeats) or the page touched the field right after it closed: no 'Deck changed', the next field
//     opens;
//   - exact text under an empty nav button gets a solid outline and opens a field, and the slide does not move; a
//     node a script rewrote shows no outline and opens no picker;
//   - the fit guard measures the text as it will render (uppercase); Space types a space in a button or summary;
//     a right-click on a misspelt word offers the dictionary's suggestions.
//
// Every test needs the Edit capability: @edit in each title (the reader-only gate leaves them out).

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Scratch, resolveRunAs, type DeckView } from '../helpers/app';
import { FIXTURES, closeAll, openDeck, openFieldAt, sleep, typeKeys, until, type Opened } from './edit-fix-helpers';

test.describe.configure({ mode: 'serial' });

type St = { blocked: string | null; mapsAhead: number; pageVersion: string; outline: { kind: string } | null; fit: string | null; toast: string; picker: { items: unknown[] } | null; field: { rootId: string; tag: string; text: string } | null };
const state = (d: DeckView) => d.editState<St>();
const has = (f: string, s: string) => fs.readFileSync(f, 'utf8').includes(s);

/** The centre of the first non-blank text of `selector`, in the view's coordinates. */
async function centreOf(deck: DeckView, selector: string): Promise<{ x: number; y: number }> {
  const p = await deck.eval<{ x: number; y: number } | null>(
    `(function(){var e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;var w=document.createTreeWalker(e,4),t;` +
      `while((t=w.nextNode())&&!t.data.trim()){}if(!t)return null;var g=document.createRange();g.selectNodeContents(t);var b=g.getClientRects()[0];` +
      `return b?{x:b.left+b.width/2,y:b.top+b.height/2}:null;})()`,
  );
  if (!p) throw new Error(`no text in ${selector}`);
  const zoom = await deck.app.electronApp.evaluate(({ webContents }, id) => webContents.fromId(id)?.getZoomFactor() ?? 1, deck.wcId);
  return { x: Math.round(p.x * zoom), y: Math.round(p.y * zoom) };
}

/** The hover outline over `selector`'s text (the pointer first moves to an empty corner so the outline restarts). */
async function hover(deck: DeckView, selector: string): Promise<St['outline']> {
  await deck.focus();
  await deck.input([{ type: 'mouseMove', x: 5, y: 5 }], 20);
  await sleep(300);
  const p = await centreOf(deck, selector);
  await deck.input([{ type: 'mouseMove', x: p.x, y: p.y }], 20);
  await sleep(500);
  return (await state(deck)).outline;
}

async function editReady(o: Opened, what: string): Promise<St> {
  return until(what, async () => {
    const st = await state(o.deck);
    return st.blocked === null && st.mapsAhead === 0 && !st.field ? st : undefined;
  }, 10_000);
}

// ----- E-6 (finding 2)

for (const c of [
  { label: 'typing " 40%" while a script literal holds "40%"', word: ' 40%' },
  { label: 'control: typing " up"', word: ' up' },
]) {
  test(`@edit ${c.label} at the end of the heading: the page version advances and a field on the next paragraph opens`, async () => {
    const o = await openDeck({ fixture: path.join(FIXTURES, 'edit/shadow-number.html'), name: 'shadow.html' });
    try {
      const before = await state(o.deck);
      const handshakes = (await o.app.win(o.deck.docId)).handshakes;
      await openFieldAt(o.deck, '#h');
      await o.deck.key('End', ['control']);
      await typeKeys(o.deck, c.word);
      await o.deck.key('Enter');
      await until('the write', async () => (has(o.file, `Revenue grew${c.word}</h1>`) ? true : undefined));
      const st = await editReady(o, 'Edit ready after the own write');
      expect(st.pageVersion).not.toBe(before.pageVersion);
      await openFieldAt(o.deck, '#p');
      expect((await state(o.deck)).field?.rootId).toBe('p');
      await o.deck.key('Escape');
      expect((await o.app.win(o.deck.docId)).handshakes).toBe(handshakes);
    } finally {
      await closeAll(o);
    }
  });
}

test('@edit the page resets a child of the heading right after the field closes: Edit keeps working', async () => {
  const o = await openDeck({ fixture: path.join(FIXTURES, 'edit/shadow-number.html'), name: 'shadow.html' });
  try {
    await openFieldAt(o.deck, '#m', { nth: 0, at: 'start' });
    await o.deck.key('Home');
    await typeKeys(o.deck, 'X');
    await o.deck.key('Enter');
    await until('the write', async () => (has(o.file, '<h2 id="m">XMargins held <span id="c">today</span></h2>') ? true : undefined));
    await sleep(1000);
    await editReady(o, 'Edit ready after the page touched the closed field');
    await openFieldAt(o.deck, '#q');
    expect((await state(o.deck)).field?.rootId).toBe('q');
  } finally {
    await closeAll(o);
  }
});

// ----- E-9 (finding 9)

async function slideOf(deck: DeckView): Promise<number> {
  return Number(await deck.eval<string>(`document.documentElement.getAttribute('data-slide')`));
}

async function toSlide(deck: DeckView, n: number): Promise<void> {
  for (let i = 0; i < 6 && (await slideOf(deck)) !== n; i++) {
    await deck.key((await slideOf(deck)) < n ? 'ArrowRight' : 'ArrowLeft');
    await sleep(200);
  }
  expect(await slideOf(deck)).toBe(n);
}

for (const id of ['cov', 'h1', 'pe', 'free']) {
  const what = { cov: 'a paragraph under an empty nav button', h1: 'a heading under an empty nav button', pe: 'a pointer-events:none paragraph', free: 'control: an uncovered paragraph' }[id];
  test(`@edit ${what}: a solid outline, a real click opens a field on it, and the slide does not move`, async () => {
    const o = await openDeck({ fixture: path.join(FIXTURES, 'edit/nav-cover.html'), name: 'nav.html' });
    try {
      await toSlide(o.deck, 1);
      expect(await hover(o.deck, `#${id}`)).toMatchObject({ kind: 'solid' });
      const p = await centreOf(o.deck, `#${id}`);
      await o.deck.click(p.x, p.y);
      const st = await until('a field', async () => {
        const s = await state(o.deck);
        return s.field ? s : undefined;
      }, 5_000);
      expect(st.field?.rootId).toBe(id);
      expect(await slideOf(o.deck)).toBe(1);
      // The caret is where the click was: a typed letter lands inside the text, not on the button.
      await typeKeys(o.deck, 'Q');
      expect((await state(o.deck)).field?.text).toMatch(/Q/);
      await o.deck.key('Escape');
      expect(fs.readFileSync(o.file, 'utf8')).toBe(o.original);
    } finally {
      await closeAll(o);
    }
  });
}

for (const c of [
  { id: 'lab', what: 'a label in a pointer-events:none layer painted above an opaque slide' },
  { id: 'lab2', what: 'a pointer-events:none tag in the slide, under a transparent wrapper whose text is elsewhere' },
]) {
  test(`@edit ${c.what}: a solid outline, and a real click opens a field on it`, async () => {
    const o = await openDeck({ fixture: path.join(FIXTURES, 'edit/pe-layer.html'), name: 'layer.html' });
    try {
      const sheets = await o.deck.eval<number>('document.adoptedStyleSheets.length');
      expect(await hover(o.deck, `#${c.id}`)).toMatchObject({ kind: 'solid' });
      const p = await centreOf(o.deck, `#${c.id}`);
      await o.deck.click(p.x, p.y);
      const st = await until('a field', async () => {
        const s = await state(o.deck);
        return s.field ? s : undefined;
      }, 5_000);
      expect(st.field?.rootId).toBe(c.id);
      await o.deck.key('Escape');
      expect(fs.readFileSync(o.file, 'utf8')).toBe(o.original);
      // The hit test changed nothing of the page: its layer still takes no pointer, and it adopted no sheet.
      await o.deck.input([{ type: 'mouseMove', x: 700, y: 520 }], 20);
      await sleep(400);
      expect(await o.deck.eval(`[getComputedStyle(document.querySelector('nav.labels')).pointerEvents, getComputedStyle(document.getElementById('lab2')).pointerEvents, document.adoptedStyleSheets.length]`)).toEqual(['none', 'none', sheets]);
    } finally {
      await closeAll(o);
    }
  });
}

// Finding 9, re-verification: E-9's see-through walk looked only at an element's own background, so text under a
// layer whose ::before paints an opaque fill (a scrim, a curtain) counted as reachable: an outline around a blank
// area, a field on text no one can see, and the layer's own click lost. That layer is not see-through now.
test('@edit text hidden under a layer whose ::before paints it over: no outline, no field, and the press goes to the layer', async () => {
  const o = await openDeck({ fixture: path.join(FIXTURES, 'edit/scrim.html'), name: 'scrim.html' });
  try {
    expect(await hover(o.deck, '#scr')).toBeNull();
    const p = await centreOf(o.deck, '#scr');
    await o.deck.click(p.x, p.y);
    await until('the scrim\'s own click', async () => ((await o.deck.eval<string | null>(`document.documentElement.getAttribute('data-scrim')`)) === 'clicked' ? true : undefined), 5_000);
    expect((await state(o.deck)).field).toBeNull();
    // Controls: a layer whose ::before paints nothing is seen through, and uncovered text is plain.
    for (const id of ['veiled', 'free']) {
      expect(await hover(o.deck, `#${id}`), id).toMatchObject({ kind: 'solid' });
      const q = await centreOf(o.deck, `#${id}`);
      await o.deck.click(q.x, q.y);
      const st = await until(`a field on #${id}`, async () => {
        const s = await state(o.deck);
        return s.field ? s : undefined;
      }, 5_000);
      expect(st.field?.rootId).toBe(id);
      await o.deck.key('Escape');
      await sleep(300);
    }
    expect(fs.readFileSync(o.file, 'utf8')).toBe(o.original);
  } finally {
    await closeAll(o);
  }
});

// The repair's re-verification of finding 9: an empty layer can paint over text without a background or a pseudo-
// element fill: an inset box-shadow, a thick border, an outline drawn inside it, a ::after border, a ::before shadow,
// a shadow tree (a custom element), a border the page scales up. The text under each is invisible (no dark pixel on
// its row), so it gets no outline and no field, and the press goes to the layer. Text inside a thin frame, under an
// outline drawn outside a layer, and under a clear layer shows, and is reached as before.
test('@edit text hidden by a layer that paints without a background: no outline, no field, the press goes to the layer; text that shows is reached', async () => {
  const o = await openDeck({ fixture: path.join(FIXTURES, 'edit/covers.html'), name: 'covers.html' });
  const hidden = [
    ['shd', 'shade'],
    ['bdr', 'border'],
    ['oli', 'outline'],
    ['pbd', 'pborder'],
    ['psh', 'pshadow'],
    ['hst', 'host'],
    ['scl', 'scaled'],
  ] as const;
  const shown = [
    ['frm', 'frame'],
    ['olo', 'olout'],
    ['clr', 'clear'],
  ] as const;
  try {
    // The fixture does what it says: a capture with the pointer away shows no dark pixel on a hidden text's row.
    await o.deck.input([{ type: 'mouseMove', x: 5, y: 600 }], 20);
    await sleep(400);
    const cap = await o.app.electronApp.evaluate(async ({ webContents }, id) => {
      const img = await webContents.fromId(id)!.capturePage();
      return { w: img.getSize().width, data: img.toBitmap().toString('base64') };
    }, o.deck.wcId);
    const bmp = Buffer.from(cap.data, 'base64');
    // Capture pixels per CSS px of the page.
    const scale = cap.w / (await o.deck.eval<number>('innerWidth'));
    const darkOnRow = async (id: string): Promise<number> => {
      const r = await o.deck.eval<{ left: number; mid: number }>(`(function(){var r=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();return {left:r.left,mid:r.top+r.height/2};})()`);
      const y = Math.round(r.mid * scale);
      let dark = 0;
      for (let x = Math.round(r.left * scale); x < Math.round((r.left + 380) * scale); x++) {
        const i = (y * cap.w + x) * 4;
        if (bmp[i] < 128 && bmp[i + 1] < 128 && bmp[i + 2] < 128) dark++;
      }
      return dark;
    };
    for (const [id] of hidden) expect(await darkOnRow(id), `#${id} is hidden`).toBe(0);
    for (const [id] of shown) expect(await darkOnRow(id), `#${id} shows`).toBeGreaterThan(0);
    for (const [id, layer] of hidden) {
      expect(await hover(o.deck, `#${id}`), `#${id}: no outline`).toBeNull();
      const p = await centreOf(o.deck, `#${id}`);
      await o.deck.click(p.x, p.y);
      await until(`#${layer}'s own click`, async () => ((await o.deck.eval<string | null>(`document.documentElement.getAttribute('data-${layer}')`)) === 'clicked' ? true : undefined), 5_000);
      expect((await state(o.deck)).field, `#${id}: no field`).toBeNull();
    }
    for (const [id, layer] of shown) {
      expect(await hover(o.deck, `#${id}`), `#${id}: an outline`).toMatchObject({ kind: 'solid' });
      const q = await centreOf(o.deck, `#${id}`);
      await o.deck.click(q.x, q.y);
      const st = await until(`a field on #${id}`, async () => {
        const s = await state(o.deck);
        return s.field ? s : undefined;
      }, 5_000);
      expect(st.field?.rootId).toBe(id);
      expect(await o.deck.eval<string | null>(`document.documentElement.getAttribute('data-${layer}')`)).toBeNull();
      await o.deck.key('Escape');
      await sleep(300);
    }
    expect(fs.readFileSync(o.file, 'utf8')).toBe(o.original);
  } finally {
    await closeAll(o);
  }
});

test('@edit control: in Read the same click on covered text still goes to the nav button', async () => {
  const o = await openDeck({ fixture: path.join(FIXTURES, 'edit/nav-cover.html'), name: 'nav.html', edit: false });
  try {
    await toSlide(o.deck, 1);
    const p = await centreOf(o.deck, '#cov');
    await o.deck.click(p.x, p.y);
    await until('the previous slide', async () => ((await slideOf(o.deck)) === 0 ? true : undefined), 5_000);
  } finally {
    await closeAll(o);
  }
});

test('@edit a title a script wrote from another place\'s text: no outline, and a click opens neither a field nor a picker', async () => {
  const o = await openDeck({ fixture: path.join(FIXTURES, 'edit/touched-title.html'), name: 'touched.html' });
  try {
    expect(await o.deck.eval(`document.getElementById('ttl').textContent`)).toBe('Quarterly results');
    expect(await hover(o.deck, '#ttl')).toBeNull();
    const p = await centreOf(o.deck, '#ttl');
    await o.deck.click(p.x, p.y);
    await sleep(800);
    const st = await state(o.deck);
    expect(st.field).toBeNull();
    expect(st.picker).toBeNull();
    // Control: the list item it was copied from is exact.
    expect(await hover(o.deck, '#n1')).toMatchObject({ kind: 'solid' });
  } finally {
    await closeAll(o);
  }
});

// ----- E-10 (findings 10, 11, 13)

for (const c of [
  { id: 'up', word: ' ok', want: /\+1 line/, what: 'uppercase heading that wraps once it renders' },
  { id: 'lab', word: ' ok', want: /overflows/, what: 'uppercase label in a fixed box' },
  { id: 'ctl', word: ' OK', want: /\+1 line/, what: 'control: the same glyphs typed in capitals' },
]) {
  test(`@edit fit guard, ${c.what}: "${c.want.source.replace(/\\/g, '')}" while typing`, async () => {
    const o = await openDeck({ fixture: path.join(FIXTURES, 'edit/fit-case.html'), name: 'fit.html' });
    try {
      await openFieldAt(o.deck, `#${c.id}`);
      await o.deck.key('End', ['control']);
      await typeKeys(o.deck, c.word);
      const fit = await until('the fit badge', async () => {
        const f = (await state(o.deck)).fit;
        return f && c.want.test(f) ? f : undefined;
      }, 5_000);
      expect(fit).toMatch(c.want);
      await o.deck.key('Escape');
    } finally {
      await closeAll(o);
    }
  });
}

test('@edit Space in a field on a button or a summary types a space, and no click or toggle reaches the page', async () => {
  const o = await openDeck({ fixture: path.join(FIXTURES, 'edit/button-space.html'), name: 'space.html' });
  try {
    for (const c of [
      { sel: '#b1', file: '<button id="b1" type="button">Go to the next slide z</button>' },
      { sel: '#sum', file: '<summary id="sum">Show the details z</summary>' },
      { sel: '#b3', file: '<button id="b3" type="button">Begin <b>bold</b> ending words z</button>' },
      { sel: '#s2', file: '<span id="s2">Label in a span z</span>' },
      { sel: '#s4', file: '<span id="s4">Summary span text z</span>' },
      { sel: '#para', file: '<p id="para">A plain paragraph line z</p>' },
    ]) {
      await openFieldAt(o.deck, c.sel);
      await o.deck.key('End', ['control']);
      await typeKeys(o.deck, ' z');
      await o.deck.key('Enter');
      await until(`${c.sel} written`, async () => (has(o.file, c.file) ? true : undefined), 10_000);
      await sleep(400);
    }
    expect(await o.deck.eval(`document.documentElement.getAttribute('data-ev')`)).toBeNull();
    expect(await o.deck.eval(`document.getElementById('det').open`)).toBe(false);
  } finally {
    await closeAll(o);
  }
});

test('@edit Shift+Space in a field on a button or a summary types a space too (finding 11, re-verification)', async () => {
  const o = await openDeck({ fixture: path.join(FIXTURES, 'edit/button-space.html'), name: 'space.html' });
  try {
    for (const c of [
      { sel: '#b1', file: '<button id="b1" type="button">Go to the next slide Z</button>' },
      { sel: '#sum', file: '<summary id="sum">Show the details Z</summary>' },
      { sel: '#para', file: '<p id="para">A plain paragraph line Z</p>' },
    ]) {
      await openFieldAt(o.deck, c.sel);
      await o.deck.key('End', ['control']);
      // Typing a capital at speed: Shift held over the space.
      await o.deck.key(' ', ['shift']);
      await o.deck.key('Z', ['shift']);
      await o.deck.key('Enter');
      await until(`${c.sel} written`, async () => (has(o.file, c.file) ? true : undefined), 10_000);
      await sleep(400);
    }
    expect(await o.deck.eval(`document.documentElement.getAttribute('data-ev')`)).toBeNull();
    expect(await o.deck.eval(`document.getElementById('det').open`)).toBe(false);
  } finally {
    await closeAll(o);
  }
});

function dictionary(): string | null {
  for (const p of [process.env.BL_TEST_SPELL_DICT, '/root/.config/Electron/Dictionaries/en-US-10-1.bdic']) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

test('@edit a right-click on a misspelt word in the field offers the dictionary\'s suggestions, and choosing one writes it', async () => {
  const dict = dictionary();
  test.skip(!dict, 'no hunspell dictionary for en-US (set BL_TEST_SPELL_DICT to an en-US-10-1.bdic): Chromium cannot download one here');
  const s = new Scratch(resolveRunAs());
  const ud = s.dir('edit-fix-spell-ud');
  fs.mkdirSync(path.join(ud, 'Dictionaries'), { recursive: true });
  fs.copyFileSync(dict!, path.join(ud, 'Dictionaries', 'en-US-10-1.bdic'));
  const o = await openDeck({ fixture: path.join(FIXTURES, 'edit/spell.html'), name: 'spell.html', s, userData: ud });
  try {
    // Observe the menu the app pops up instead of showing it (a native menu would wait for a real click).
    await o.app.electronApp.evaluate(({ Menu }) => {
      const g = globalThis as unknown as { __menus: { labels: string[]; menu: Electron.Menu }[] };
      g.__menus = [];
      Menu.prototype.popup = function (this: Electron.Menu) {
        g.__menus.push({ labels: this.items.map((i) => i.label), menu: this });
      } as typeof Menu.prototype.popup;
    });
    await openFieldAt(o.deck, '#p');
    await o.deck.key('End', ['control']);
    await typeKeys(o.deck, ' teh');
    await sleep(1200);
    const r = await o.deck.eval<{ x: number; y: number } | null>(
      `(function(){var e=document.getElementById('p');var w=document.createTreeWalker(e,4),t,last=null;while((t=w.nextNode()))last=t;if(!last)return null;` +
        `var i=last.data.lastIndexOf('teh');if(i<0)return null;var g=document.createRange();g.setStart(last,i);g.setEnd(last,i+3);var b=g.getBoundingClientRect();return {x:b.left+b.width/2,y:b.top+b.height/2};})()`,
    );
    const zoom = await o.app.electronApp.evaluate(({ webContents }, id) => webContents.fromId(id)?.getZoomFactor() ?? 1, o.deck.wcId);
    const X = Math.round(r!.x * zoom);
    const Y = Math.round(r!.y * zoom);
    const labels = await until('the suggestions menu', async () => {
      await o.deck.input([
        { type: 'mouseMove', x: X, y: Y },
        { type: 'mouseDown', x: X, y: Y, button: 'right', clickCount: 1 },
        { type: 'mouseUp', x: X, y: Y, button: 'right', clickCount: 1 },
      ], 20);
      await sleep(600);
      const m = await o.app.electronApp.evaluate(() => (globalThis as unknown as { __menus: { labels: string[] }[] }).__menus.map((x) => x.labels));
      return m.length > 0 ? m[m.length - 1] : undefined;
    }, 10_000);
    expect(labels).toContain('the');
    expect(labels.length).toBeLessThanOrEqual(8);
    // The page's own listeners did not see the right-click inside the field.
    expect(await o.deck.eval(`document.documentElement.getAttribute('data-ctx')`)).toBeNull();
    await o.app.electronApp.evaluate(() => {
      const g = globalThis as unknown as { __menus: { menu: Electron.Menu }[] };
      const m = g.__menus[g.__menus.length - 1].menu;
      const item = m.items.find((i) => i.label === 'the')!;
      (item.click as unknown as () => void)();
    });
    await until('the field holds the suggestion', async () => ((await state(o.deck)).field?.text === 'A short line of text the' ? true : undefined), 5_000);
    await o.deck.key('Enter');
    await until('the write', async () => (has(o.file, '<p id="p">A short line of text the</p>') ? true : undefined));
  } finally {
    await closeAll(o);
  }
});

// Finding 13, re-verification: an SVG text field is the overlay's input in its closed shadow root, so the overlay
// compared the right-click's real target (the overlay host, seen from window) with the input and let every
// right-click through to the page. A deck that cancels right-clicks at window capture then got no suggestions in
// SVG fields. The page now sees none of them, and the menu is offered.
test('@edit a right-click on a misspelt word in an SVG text field, on a deck that cancels right-clicks: the page never sees it, and the suggestion is written', async () => {
  const dict = dictionary();
  test.skip(!dict, 'no hunspell dictionary for en-US (set BL_TEST_SPELL_DICT to an en-US-10-1.bdic): Chromium cannot download one here');
  const s = new Scratch(resolveRunAs());
  const ud = s.dir('edit-fix-spell-svg-ud');
  fs.mkdirSync(path.join(ud, 'Dictionaries'), { recursive: true });
  fs.copyFileSync(dict!, path.join(ud, 'Dictionaries', 'en-US-10-1.bdic'));
  const o = await openDeck({ fixture: path.join(FIXTURES, 'edit/spell-block.html'), name: 'spell.html', s, userData: ud });
  try {
    await o.app.electronApp.evaluate(({ Menu }) => {
      const g = globalThis as unknown as { __menus: { labels: string[]; menu: Electron.Menu }[] };
      g.__menus = [];
      Menu.prototype.popup = function (this: Electron.Menu) {
        g.__menus.push({ labels: this.items.map((i) => i.label), menu: this });
      } as typeof Menu.prototype.popup;
    });
    await openFieldAt(o.deck, '#svgtext');
    await o.deck.key('End');
    // Chromium marks a word in an <input> once it is finished.
    await typeKeys(o.deck, ' teh ');
    await o.deck.key('Home');
    await sleep(1500);
    const r = await o.deck.eval<{ x: number; y: number; w: number; h: number }>(
      `(function(){var g=document.createRange();g.selectNodeContents(document.getElementById('svgtext').firstChild);var b=g.getBoundingClientRect();return {x:b.left,y:b.top,w:b.width,h:b.height};})()`,
    );
    const zoom = await o.app.electronApp.evaluate(({ webContents }, id) => webContents.fromId(id)?.getZoomFactor() ?? 1, o.deck.wcId);
    // The input is wider than the text it covers; walk the pointer across where ' teh' lies until the menu comes.
    let labels: string[] | undefined;
    for (let dx = -60; dx <= 60 && !labels; dx += 5) {
      const X = Math.round((r.x + r.w + dx) * zoom);
      const Y = Math.round((r.y + r.h / 2) * zoom);
      await o.deck.input([
        { type: 'mouseMove', x: X, y: Y },
        { type: 'mouseDown', x: X, y: Y, button: 'right', clickCount: 1 },
        { type: 'mouseUp', x: X, y: Y, button: 'right', clickCount: 1 },
      ], 20);
      await sleep(300);
      const m = await o.app.electronApp.evaluate(() => (globalThis as unknown as { __menus: { labels: string[] }[] }).__menus.map((x) => x.labels));
      if (m.length && m[m.length - 1].includes('the')) labels = m[m.length - 1];
    }
    expect(labels).toContain('the');
    // The deck's own listener never saw a right-click in the field (it would have cancelled the menu).
    expect(await o.deck.eval(`document.documentElement.getAttribute('data-ctx')`)).toBeNull();
    await o.app.electronApp.evaluate(() => {
      const g = globalThis as unknown as { __menus: { menu: Electron.Menu }[] };
      const m = g.__menus[g.__menus.length - 1].menu;
      (m.items.find((i) => i.label === 'the')!.click as unknown as () => void)();
    });
    await until('the field holds the suggestion', async () => ((await state(o.deck)).field?.text === 'Chart label the ' ? true : undefined), 5_000);
    await o.deck.key('Enter');
    await until('the write', async () => (has(o.file, '<text id="svgtext" x="4" y="40" font-size="32">Chart label the </text>') ? true : undefined));
  } finally {
    await closeAll(o);
  }
});
