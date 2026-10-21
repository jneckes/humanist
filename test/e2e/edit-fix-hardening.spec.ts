// The hardening round after the Phase 2 repair: wrong-place writes an attacker found in the built app, each driven
// as it was found (a real click opens the field, real keys type, another program saves over the file as editors do,
// temp file and rename), and each must now leave the author's words as a verbatim note with the other program's
// file untouched, or land in the run the author pressed. The file on disk is the oracle.
//
//   - a stale edit next to copies of its text (packages/editor/src/anchors.ts, place.ts): a serialiser respelling the
//     other copy while deleting the author's slide; the author's heading re-wrapped while a templated slide is
//     inserted before it; a table cell changed while a row ending in the old value is appended; two task-list items
//     with the same text swapped;
//   - Cmd+Z and Cmd+Shift+Z after another program changed the text right next to the edited copy (undo case 2 by
//     position, undo.ts);
//   - one click on uppercase text, and a click straight from one field into other text with keys typed at once
//     (the caret worked out in the layout the author pressed on, edit-controller.ts pressCaret);
//   - Cmd+Z right after an Enter whose commit becomes a note (E-3 as amended);
//   - Enter while a marked download saved over the deck waits for its D-1 reopen (window.ts writeTrust).
//
// Every test needs the Edit capability: @edit in each title (the reader-only gate leaves them out).

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse, serialize } from 'parse5';
import { Scratch, launchApp, resolveRunAs } from '../helpers/app';
import { closeAll, enterEdit, externalSave, openDeck, openFieldAt, settled, sleep, textPoint, typeKeys, until, type Opened } from './edit-fix-helpers';

const STYLE = '<style>body{font:22px/1.35 sans-serif;margin:24px;width:760px} section{min-height:200px}</style>';
const deck = (...ss: string[]) => `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>Deck</title>${STYLE}</head><body>\n${ss.join('')}</body></html>\n`;
const slide = (h: string, body: string) => `<section class="slide">\n  <div class="kicker">Quarterly review</div>\n  <h2>${h}</h2>\n  <p>${body}</p>\n</section>\n`;

/** The notes of the deck's window: [kind, before, after]. */
async function notes(o: Opened): Promise<(string | undefined)[][]> {
  return (await o.app.win(o.deck.docId)).state.notes.map((n) => [n.kind, n.before, n.after]);
}

/** Field open, text typed, another program saves C, Enter `delay` ms later; the file once it settled. */
async function staleCommit(o: Opened, open: string, typed: string, C: string, delay: number): Promise<string> {
  await openFieldAt(o.deck, open);
  await o.deck.key('End', ['control']);
  await typeKeys(o.deck, typed);
  externalSave(o, C);
  await sleep(delay);
  await o.deck.key('Enter');
  await until('the commit answered', async () => ((await notes(o)).length > 0 || fs.readFileSync(o.file, 'utf8') !== C ? true : undefined), 20_000);
  return settled(o.file);
}

function serialiserDelete(A: string, index: number): string {
  const doc = parse(A) as unknown as { childNodes: { tagName?: string; childNodes: { tagName?: string }[] }[] };
  const body = doc.childNodes.find((n) => n.tagName === 'html')!.childNodes.find((n) => n.tagName === 'body') as unknown as { childNodes: { tagName?: string }[] };
  const secs = body.childNodes.filter((c) => c.tagName === 'section');
  body.childNodes.splice(body.childNodes.indexOf(secs[index]), 2);
  return serialize(doc as never);
}

test.describe('a stale edit next to copies of its text is a note, never a write into the other copy', () => {
  const li = (a: string, b: string) => `  <li><b>${a}</b> <i>${b}</i></li>\n`;
  const tr = (cells: string[]) => `    <tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>\n`;
  const table = (rows: string[][]) => deck(`<table>\n  <tbody>\n${rows.map(tr).join('')}  </tbody>\n</table>\n`);
  const rows = [
    ['Single sign-on', 'Partial', 'Yes', 'No'],
    ['Audit log', 'Yes', 'Partial', 'Partial'],
    ['API access', 'No', 'Partial', 'No'],
  ];
  const cases: { name: string; A: string; C: string; open: string; typed: string; before: string }[] = [];
  {
    const A = deck(slide('Agenda', 'What we cover today'), slide('R&amp;D update', 'Revenue grew in every region'), slide('R&D update', 'Costs fell in two regions'), slide('Next steps', 'Owners and dates'));
    cases.push({ name: 'a DOM serialiser removes the author\'s slide and respells the other copy (R&amp;D)', A, C: serialiserDelete(A, 1), open: 'section:nth-of-type(2) h2', typed: ' draft', before: 'R&D update' });
  }
  {
    const A = deck(slide('Agenda', 'What we cover today'), slide('Key takeaways', 'Revenue grew in every region'), slide('Next steps', 'Owners and dates'));
    const C = deck(slide('Agenda', 'What we cover today'), slide('Key takeaways', 'Costs fell in two regions'), slide('<em>Key takeaways</em>', 'Revenue grew in every region'), slide('Next steps', 'Owners and dates'));
    cases.push({ name: 'a templated slide inserted before the author\'s, whose heading is wrapped in <em>', A, C, open: 'section:nth-of-type(2) h2', typed: ' two', before: 'Key takeaways' });
  }
  cases.push({
    name: 'the author\'s table cell set to another value and a row ending in the old value appended',
    A: table(rows),
    C: table([rows[0], rows[1], ['API access', 'No', 'Partial', 'Yes'], ['Uptime SLA', 'Yes', 'Partial', 'No']]),
    open: 'tbody tr:nth-child(3) td:nth-child(4)',
    typed: ' (beta)',
    before: 'No',
  });
  cases.push({
    name: 'two task-list items with the same text swapped',
    A: deck(`<ul class="tasks">\n${li('Hire', 'Open')}${li('Ship', 'Done')}${li('Hire', 'Done')}</ul>\n`),
    C: deck(`<ul class="tasks">\n${li('Hire', 'Done')}${li('Ship', 'Done')}${li('Hire', 'Open')}</ul>\n`),
    open: 'li:nth-of-type(3) b',
    typed: ' two',
    before: 'Hire',
  });
  for (const c of cases) {
    test(`@edit ${c.name}`, async () => {
      const o = await openDeck({ html: c.A, name: 'deck.html' });
      try {
        const now = await staleCommit(o, c.open, c.typed, c.C, 50);
        expect(now).toBe(c.C);
        expect(await notes(o)).toContainEqual(['verbatim', c.before, `${c.before}${c.typed}`]);
      } finally {
        await closeAll(o);
      }
    });
  }
});

test.describe('undo and redo after a change next to the edited copy: refused, never the twin', () => {
  const s = (h: string, sub: string) => `<section class="slide">\n  <h2 class="title">${h}</h2>\n  <p class="sub">${sub}</p>\n</section>\n`;
  async function takeExternal(o: Opened, text: string): Promise<void> {
    const before = (await o.app.win(o.deck.docId)).handshakes;
    externalSave(o, text);
    await until('the external change taken', async () => ((await o.app.win(o.deck.docId)).handshakes > before ? true : undefined), 30_000);
    await sleep(1000);
  }
  async function undoCount(o: Opened): Promise<number> {
    return ((await o.app.editInfo(o.deck.docId))?.undo as { undo: number } | undefined)?.undo ?? 0;
  }

  test('@edit Cmd+Z: the "!" the author deleted is not put into the other slide', async () => {
    const A = deck(s('Revenue!', 'Up 12% this year'), s('Revenue', 'Up 12% this year'));
    const o = await openDeck({ html: A, name: 'u1.html' });
    try {
      await openFieldAt(o.deck, 'section:nth-of-type(1) h2');
      await o.deck.key('End', ['control']);
      await o.deck.key('Backspace');
      await o.deck.key('Enter');
      const B = deck(s('Revenue', 'Up 12% this year'), s('Revenue', 'Up 12% this year'));
      await until('the edit on disk', async () => (fs.readFileSync(o.file, 'utf8') === B ? true : undefined), 30_000);
      await until('the edit in the undo stack', async () => ((await undoCount(o)) === 1 ? true : undefined));
      const C = deck(s('Revenue', 'Up 15% this year'), s('Revenue', 'Up 12% this year'));
      await takeExternal(o, C);
      await o.deck.chord('z');
      await sleep(2500);
      expect(await settled(o.file)).toBe(C);
    } finally {
      await closeAll(o);
    }
  });

  test('@edit Cmd+Shift+Z: the redone edit does not go into the identical slide', async () => {
    const A = deck(s('Key takeaways', 'Same subtitle here'), s('Key takeaways', 'Same subtitle here'));
    const o = await openDeck({ html: A, name: 'r1.html' });
    try {
      await openFieldAt(o.deck, 'section:nth-of-type(2) h2');
      await o.deck.key('End', ['control']);
      await typeKeys(o.deck, ' two');
      await o.deck.key('Enter');
      await until('the edit on disk', async () => (fs.readFileSync(o.file, 'utf8').includes('Key takeaways two') ? true : undefined), 30_000);
      await until('the edit in the undo stack', async () => ((await undoCount(o)) === 1 ? true : undefined));
      await sleep(800);
      await o.deck.chord('z');
      await until('undone', async () => (fs.readFileSync(o.file, 'utf8') === A ? true : undefined), 30_000);
      await sleep(800);
      const C = deck(s('Key takeaways', 'Same subtitle here'), s('Key takeaways', 'Agent rewrote it'));
      await takeExternal(o, C);
      await o.deck.chord('z', ['shift']);
      await sleep(2500);
      expect(await settled(o.file)).toBe(C);
    } finally {
      await closeAll(o);
    }
  });
});

test.describe('the caret goes where the author pressed, in the layout they pressed on (6.3 Source case)', () => {
  const css = `body{margin:24px;font:22px/1.35 sans-serif;width:760px} section{border:1px solid #ccc;padding:12px 18px;margin:0 0 16px;min-height:220px} h2{font-size:34px;margin:6px 0} .title{text-transform:uppercase} .kicker{text-transform:uppercase;letter-spacing:.06em;font-size:16px;color:#555}`;
  const page = (body: string) => `<!doctype html>\n<html><head><meta charset="utf-8"><title>T</title><style>${css}</style></head><body>\n${body}</body></html>\n`;
  async function press(o: Opened, p: { x: number; y: number }): Promise<void> {
    await o.deck.input(
      [
        { type: 'mouseMove', x: Math.round(p.x), y: Math.round(p.y) },
        { type: 'mouseDown', x: Math.round(p.x), y: Math.round(p.y), button: 'left', clickCount: 1 },
        { type: 'mouseUp', x: Math.round(p.x), y: Math.round(p.y), button: 'left', clickCount: 1 },
      ],
      10,
    );
  }

  test('@edit one click at the end of the first copy of an uppercase word: typed there, not in the second copy', async () => {
    const o = await openDeck({ html: page('<section id="s1">\n  <h2 class="title">Revenue <em>Revenue</em></h2>\n  <p>Body</p>\n</section>\n'), name: 'r4.html' });
    try {
      const p = (await textPoint(o.deck, '#s1 h2', { nth: 0, at: 'end' }))!;
      await o.deck.click(p.x, p.y);
      await until('a field', async () => ((await o.deck.editState<{ field: unknown }>()).field ? true : undefined));
      await typeKeys(o.deck, 's');
      await o.deck.key('Enter');
      await until('the write', async () => (fs.readFileSync(o.file, 'utf8').includes('<h2 class="title">Revenue <em>Revenue</em>') ? undefined : true), 15_000);
      const now = await settled(o.file);
      expect(now).toContain('<em>Revenue</em></h2>');
      expect(now).toMatch(/<h2 class="title">Revenue ?s ?<em>Revenue<\/em><\/h2>/);
    } finally {
      await closeAll(o);
    }
  });

  test('@edit one click at the end of GREW in an uppercase title with emphasis: typed after GREW', async () => {
    const o = await openDeck({ html: page('<section id="s1">\n  <h2 class="title">Revenue grew <em>12%</em> in Q3</h2>\n  <p>Body</p>\n</section>\n'), name: 'r1.html' });
    try {
      const p = (await textPoint(o.deck, '#s1 h2', { nth: 0, at: 'end' }))!;
      await o.deck.click(p.x, p.y);
      await until('a field', async () => ((await o.deck.editState<{ field: unknown }>()).field ? true : undefined));
      await typeKeys(o.deck, ' fast');
      await o.deck.key('Enter');
      await until('the write', async () => (fs.readFileSync(o.file, 'utf8').includes('fast') ? true : undefined), 15_000);
      const now = await settled(o.file);
      expect(now).toContain('<em>12%</em> in Q3</h2>');
      expect(now).toMatch(/<h2 class="title">Revenue grew ?\s?fast ?<em>12%<\/em>/);
    } finally {
      await closeAll(o);
    }
  });

  test('@edit from a changed uppercase kicker straight onto the body\'s second line, keys typed at once: they go to line 2', async () => {
    const html = page(
      '<section id="s1">\n  <div class="kicker" style="width:300px">Quarterly business review 2026</div>\n  <h2>Results</h2>\n  <p class="body">Revenue grew in every region<br>Costs fell in two regions</p>\n</section>\n',
    );
    const o = await openDeck({ html, name: 'r2.html' });
    try {
      await openFieldAt(o.deck, '.kicker');
      await o.deck.key('End', ['control']);
      await typeKeys(o.deck, 's');
      const p = (await textPoint(o.deck, '#s1 .body', { nth: 1, at: 'end' }))!;
      await press(o, p);
      await typeKeys(o.deck, ' again');
      await o.deck.key('Enter');
      await until('the write', async () => (fs.readFileSync(o.file, 'utf8').includes('again') ? true : undefined), 20_000);
      const now = await settled(o.file);
      expect(now).toContain('<p class="body">Revenue grew in every region<br>Costs fell in two regions again</p>');
      expect(now).toContain('Quarterly business review 2026s</div>');
    } finally {
      await closeAll(o);
    }
  });
});

test('@edit Cmd+Z right after an Enter whose commit becomes a note: nothing is undone, the earlier edit stays', async () => {
  const sl = (id: string, body: string) => `<section id="${id}">\n  <div class="kicker">Section summary</div>\n  <h2 class="title">Key takeaways</h2>\n  <p class="sub">Same subtitle</p>\n  <p>${body}</p>\n</section>\n`;
  const A = deck(sl('intro', 'Revenue grew in every region'), sl('next', 'Costs fell in two regions'));
  const o = await openDeck({ html: A, name: 'u6.html' });
  try {
    await openFieldAt(o.deck, '#intro p.sub');
    await o.deck.key('End', ['control']);
    await typeKeys(o.deck, ' one');
    await o.deck.key('Enter');
    await until('E1', async () => (fs.readFileSync(o.file, 'utf8').includes('Same subtitle one') ? true : undefined), 60_000);
    await until('E1 in the undo stack', async () => (((await o.app.editInfo(o.deck.docId))?.undo as { undo: number } | undefined)?.undo === 1 ? true : undefined));
    await sleep(500);
    const A1 = fs.readFileSync(o.file, 'utf8');
    await openFieldAt(o.deck, '#next h2');
    await o.deck.key('End', ['control']);
    await typeKeys(o.deck, ' two');
    // Another program moves #intro to the end: the heading's commit becomes a note.
    const s1 = A1.indexOf('<section id="intro">');
    const s2 = A1.indexOf('<section id="next">');
    const e2 = A1.indexOf('</section>\n', s2) + '</section>\n'.length;
    const C = A1.slice(0, s1) + A1.slice(s2, e2) + A1.slice(s1, s2) + A1.slice(e2);
    externalSave(o, C);
    await sleep(40);
    await o.app.electronApp.evaluate(
      async ({ webContents }, id) => {
        const wc = webContents.fromId(id)!;
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
        await new Promise((r) => setTimeout(r, 30));
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'z', modifiers: ['control'] });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'z', modifiers: ['control'] });
      },
      o.deck.wcId,
    );
    await sleep(3000);
    const now = await settled(o.file);
    expect(now).toBe(C);
    expect(now).toContain('Same subtitle one');
    expect(await notes(o)).toContainEqual(['verbatim', 'Key takeaways', 'Key takeaways two']);
  } finally {
    await closeAll(o);
  }
});

test('@edit Enter while a marked download saved over the deck waits for its reopen: a note, the download untouched', async () => {
  const sl = (id: string, body: string) => `<section id="${id}">\n  <div class="kicker">Section summary</div>\n  <h2 class="title">Key takeaways</h2>\n  <p class="sub">Same subtitle</p>\n  <p>${body}</p>\n</section>\n`;
  const s = new Scratch(resolveRunAs());
  const dir = s.dir('d1-write');
  const file = path.join(dir, 'deck.html');
  fs.writeFileSync(file, deck(sl('s1', 'Revenue grew'), sl('s2', 'Costs fell')));
  s.own(dir);
  const mdir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-d1w-'));
  const markers = path.join(mdir, 'markers.json');
  const real = fs.realpathSync(file);
  fs.writeFileSync(markers, '{}', { mode: 0o644 });
  s.own(mdir);
  s.own(markers);
  const app = await launchApp({ files: [file], scratch: s, env: { BLUELINE_TEST_MARKERS: markers } });
  try {
    const d = await app.waitForDeck('deck.html');
    await enterEdit(app, d);
    await openFieldAt(d, '#s2 h2');
    await d.key('End', ['control']);
    await typeKeys(d, ' two');
    // A browser saves a marked download (the same deck, slide 1's body changed) over the path.
    const download = deck(sl('s1', 'Revenue grew (downloaded)'), sl('s2', 'Costs fell'));
    fs.writeFileSync(markers, JSON.stringify({ [real]: '0083;6720f2b7;Chrome;T8' }), { mode: 0o644 });
    const tmp = path.join(dir, '.deck.html.crdownload');
    fs.writeFileSync(tmp, download);
    s.own(tmp);
    fs.renameSync(tmp, file);
    await until('the trust decision', async () => (app.logsMatching(/trust changed on disk: deck\.html/).length > 0 ? true : undefined), 15_000);
    await sleep(300);
    await d.key('Enter');
    await sleep(4000);
    expect(fs.readFileSync(file, 'utf8')).toBe(download);
  } finally {
    await app.close().catch(() => undefined);
    s.cleanup();
  }
});
