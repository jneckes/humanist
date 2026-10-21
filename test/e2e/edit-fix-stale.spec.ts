// A stale edit never lands on another copy of its text (lead decision E-1; review findings 0, 1 and 22; SPEC 9.2
// Write protocol steps 1-2, 10 Phase 2 Concurrency). Real clicks and keys on the built app:
//   - the author's own quick edits: a field never opens on a version with an unanswered commit of this page, so a
//     click from one field into the next waits for the first write and opens on the new version;
//   - another program's change near the edited copy: the queue places the edit by position, never by context, and
//     writes it only where the text on both sides confirms the place (else a verbatim note);
//   - a field held open across 8 external saves: the lane keeps its version, and the commit is a verbatim note.
//
// Every test needs the Edit capability: @edit in each title (the reader-only gate leaves them out).

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FIXTURES, closeAll, externalSave, openDeck, openFieldAt, settled, sleep, sessions, textPoint, typeKeys, until, type Opened } from './edit-fix-helpers';

test.describe.configure({ mode: 'serial' });

/** Where a text landed: in slide 1, in slide 2, or nowhere. */
function slideOf(src: string, text: string): 'slide 1' | 'slide 2' | 'nowhere' {
  const s2 = src.indexOf('<section id="s2">');
  const at = src.indexOf(text);
  return at < 0 ? 'nowhere' : at < s2 ? 'slide 1' : 'slide 2';
}

async function waitField(o: Opened, rootSel: string): Promise<void> {
  await until(
    `the field on ${rootSel}`,
    async () => {
      const st = await o.deck.editState<{ field: { tag: string } | null }>();
      if (!st.field) return undefined;
      const mine = await o.deck.eval<boolean>(`(function(){var e=document.querySelector(${JSON.stringify(rootSel)});return !!e && e.isContentEditable;})()`);
      return mine ? true : undefined;
    },
    20_000,
  );
}

test('@edit a click from one field straight into the next: both edits are on the slide the author typed on', async () => {
  const o = await openDeck({ fixture: path.join(FIXTURES, 'edit/dup-slides.html'), name: 'dup.html' });
  try {
    await openFieldAt(o.deck, '#s2 .kicker');
    await o.deck.key('End', ['control']);
    await typeKeys(o.deck, ' two');
    // A real click on slide 2's heading while the kicker's field is open: it commits the kicker, and the heading's
    // field opens only once that write is answered, on the new version.
    const p = (await textPoint(o.deck, '#s2 h2'))!;
    await o.deck.click(p.x, p.y);
    await waitField(o, '#s2 h2');
    const page = await o.deck.editState<{ pageVersion: string; field: { version: string } }>();
    expect(page.field.version).toBe(page.pageVersion);
    await o.deck.key('End', ['control']);
    await typeKeys(o.deck, ' two');
    await o.deck.key('Enter');
    await until('both writes', async () => (fs.readFileSync(o.file, 'utf8').includes('Key takeaways two') ? true : undefined));
    const now = await settled(o.file);
    expect(slideOf(now, 'Section summary two')).toBe('slide 2');
    expect(slideOf(now, 'Key takeaways two')).toBe('slide 2');
    expect(now.slice(0, now.indexOf('<section id="s2">'))).toBe(o.original.slice(0, o.original.indexOf('<section id="s2">')));
    // The page shows them where they are in the file.
    expect(await o.deck.eval(`Array.from(document.querySelectorAll('h2')).map(function(h){return h.textContent})`)).toEqual(['Key takeaways', 'Key takeaways two']);
  } finally {
    await closeAll(o);
  }
});

test('@edit a 2.2 MB deck: Enter on slide 2\'s subtitle, then a click on slide 2\'s heading 60 ms later: both on slide 2', async () => {
  const slide = (n: number) =>
    `<section id="s${n}">\n  <div class="kicker">Section summary</div>\n  <h2 class="title">Key takeaways</h2>\n  <p class="sub">Same subtitle</p>\n  <p>Body ${n} text goes here and is long enough to break context</p>\n</section>\n`;
  // A large inert block makes each write take a moment (the queue maps the whole deck), as on a real deck.
  const filler = Array.from({ length: 40_000 }, (_, i) => `<li>Filler item number ${i} with some words in it</li>`).join('\n');
  const html = `<!doctype html>\n<html><head><meta charset="utf-8"><title>T</title><style>section{min-height:160px} ul{display:none}</style></head><body>\n${slide(1)}${slide(2)}<ul>\n${filler}\n</ul>\n</body></html>\n`;
  expect(Buffer.byteLength(html)).toBeGreaterThan(2_000_000);
  const o = await openDeck({ html, name: 'self.html' });
  try {
    await openFieldAt(o.deck, '#s2 p.sub');
    await o.deck.key('Home');
    await typeKeys(o.deck, 'Not ');
    const p = (await textPoint(o.deck, '#s2 h2'))!;
    await o.deck.input([{ type: 'keyDown', keyCode: 'Return' }, { type: 'char', keyCode: '\r' }, { type: 'keyUp', keyCode: 'Return' }], 5);
    await sleep(60);
    await o.deck.input(
      [
        { type: 'mouseMove', x: Math.round(p.x), y: Math.round(p.y) },
        { type: 'mouseDown', x: Math.round(p.x), y: Math.round(p.y), button: 'left', clickCount: 1 },
        { type: 'mouseUp', x: Math.round(p.x), y: Math.round(p.y), button: 'left', clickCount: 1 },
      ],
      10,
    );
    await waitField(o, '#s2 h2');
    const st = await o.deck.editState<{ pageVersion: string; field: { version: string } }>();
    expect(st.field.version).toBe(st.pageVersion);
    await o.deck.key('End', ['control']);
    await typeKeys(o.deck, ' two');
    await o.deck.key('Enter');
    await until('the heading write', async () => (fs.readFileSync(o.file, 'utf8').includes('Key takeaways two') ? true : undefined), 30_000);
    const now = await settled(o.file);
    expect(slideOf(now, 'Not Same subtitle')).toBe('slide 2');
    expect(slideOf(now, 'Key takeaways two')).toBe('slide 2');
  } finally {
    await closeAll(o);
  }
});

// Finding 0's own case: the 32-character context wrote it into slide 1. Placed by position it landed on slide 2, but a
// change right next to the run cannot be told from the run being replaced and a copy put beside it (the hardening
// round, packages/editor/src/anchors.ts): it is a verbatim note now, and never written into slide 1.
for (const before of [50, 1500]) {
  test(`@edit another program rewrites slide 2's subtitle ${before} ms before Enter: slide 2's heading edit is a verbatim note, never written into slide 1`, async () => {
    const o = await openDeck({ fixture: path.join(FIXTURES, 'edit/dup-slides.html'), name: 'dup.html' });
    try {
      await openFieldAt(o.deck, '#s2 h2');
      await o.deck.key('End', ['control']);
      await typeKeys(o.deck, ' two');
      const s2 = o.original.indexOf('<section id="s2">');
      const changed = o.original.slice(0, s2) + o.original.slice(s2).replace('<p class="sub">Same subtitle</p>', '<p class="sub">Agent rewrote this subtitle</p>');
      externalSave(o, changed);
      await sleep(before);
      await o.deck.key('Enter');
      const notes = await until('the verbatim note', async () => {
        const n = (await o.app.win(o.deck.docId)).state.notes;
        return n.length > 0 ? n : undefined;
      });
      expect(notes.map((x) => [x.kind, x.before, x.after])).toEqual([['verbatim', 'Key takeaways', 'Key takeaways two']]);
      const now = await settled(o.file);
      expect(now).toBe(changed);
      expect(slideOf(now, 'Key takeaways two')).toBe('nowhere');
    } finally {
      await closeAll(o);
    }
  });
}

test('@edit a field held open across 8 saves of another program, the 8th rewriting it: a verbatim note, the other copy untouched', async () => {
  const deck = (n: number, b: string) =>
    `<!doctype html>\n<html><head><meta charset="utf-8"><title>T</title><style>h2{font-size:30px}</style></head><body>\n<h2 id="a">Agenda</h2>\n<p>counter ${n}</p>\n<h2 id="b">${b}</h2>\n</body></html>\n`;
  const o = await openDeck({ html: deck(0, 'Agenda'), name: 'evict.html' });
  try {
    await openFieldAt(o.deck, '#b');
    await typeKeys(o.deck, ' Monday');
    const taken = () => o.app.logsMatching(/external change: evict\.html is now/).length;
    let last = '';
    for (let k = 1; k <= 8; k++) {
      const n0 = taken();
      last = deck(k, k === 8 ? 'Plan for today' : 'Agenda');
      externalSave(o, last);
      await until(`external change ${k} taken`, async () => (taken() > n0 ? true : undefined), 10_000);
      await sleep(250);
    }
    expect((await o.deck.editState<{ field: { text: string } | null }>()).field?.text).toBe('Agenda Monday');
    await o.deck.key('Enter');
    const notes = await until('the verbatim note', async () => {
      const n = (await o.app.win(o.deck.docId)).state.notes;
      return n.length > 0 ? n : undefined;
    });
    expect(notes.map((x) => [x.kind, x.before, x.after])).toEqual([['verbatim', 'Agenda', 'Agenda Monday']]);
    expect(fs.readFileSync(o.file, 'utf8')).toBe(last);
    // Nothing went into #a; the session holds no edit note.
    expect(sessions(o.app.userData).flatMap((x) => x.json.notes ?? []).map((n) => n.kind)).not.toContain('edit');
  } finally {
    await closeAll(o);
  }
});

// Finding 0 re-verification (E-1): placing a stale edit by position alone wrote it into ANOTHER slide when another
// program moved a templated slide (S-B), or inserted one at the top and rewrote the edited slide's subtitle (S-C).
// The queue now writes only where the text around every copy confirms the diff's placement; these are notes.
{
  const sl = (id: string, body: string, sub = 'Same subtitle') =>
    `<section id="${id}">\n  <div class="kicker">Section summary</div>\n  <h2 class="title">Key takeaways</h2>\n  <p class="sub">${sub}</p>\n  <p>${body}</p>\n</section>\n`;
  const dk = (...s: string[]) => `<!doctype html>\n<html><head><meta charset="utf-8"><title>T</title><style>section{min-height:220px}</style></head><body>\n${s.join('')}</body></html>\n`;
  const A = dk(sl('intro', 'Revenue grew in every region'), sl('next', 'Costs fell in two regions'));
  const cases = [
    { name: 'moves slide 1 to the end (field on slide 2\'s heading)', open: '#next h2', C: dk(sl('next', 'Costs fell in two regions'), sl('intro', 'Revenue grew in every region')) },
    {
      name: 'inserts a templated slide at the top and rewrites the edited slide\'s subtitle',
      open: '#intro h2',
      C: dk(sl('new', 'Headcount stayed flat'), sl('intro', 'Revenue grew in every region', 'Agent rewrote this subtitle'), sl('next', 'Costs fell in two regions')),
    },
  ];
  for (const c of cases) {
    for (const before of [50, 1500]) {
      test(`@edit another program ${c.name} ${before} ms before Enter: a verbatim note, never another slide`, async () => {
        const o = await openDeck({ html: A, name: 'move.html' });
        try {
          await openFieldAt(o.deck, c.open);
          await o.deck.key('End', ['control']);
          await typeKeys(o.deck, ' two');
          externalSave(o, c.C);
          await sleep(before);
          await o.deck.key('Enter');
          const notes = await until('the verbatim note', async () => {
            const n = (await o.app.win(o.deck.docId)).state.notes;
            return n.length > 0 ? n : undefined;
          });
          expect(notes.map((x) => [x.kind, x.before, x.after])).toEqual([['verbatim', 'Key takeaways', 'Key takeaways two']]);
          expect(await settled(o.file)).toBe(c.C);
          expect(sessions(o.app.userData).flatMap((x) => x.json.notes ?? []).map((n) => n.kind)).not.toContain('edit');
        } finally {
          await closeAll(o);
        }
      });
    }
  }
}

// Finding 0 re-verification (E-1, the overlay half): the keys typed while a press waits for this page's commit are
// the new field's. On a 2.2 MB deck they reached the deck while the field waited, and the field then wrote the text
// without them ('Quarterly resultsow'). They are now kept from the deck and typed into the field when it opens.
for (const flow of ['a click straight from the subtitle field to the heading', 'Enter in the subtitle, then a click on the heading']) {
  test(`@edit a 2.2 MB deck: ${flow}, then " now" typed at once and Enter: every key is written`, async () => {
    const filler = Array.from({ length: 40_000 }, (_, i) => `<li>Filler item number ${i} with some words in it</li>`).join('\n');
    const html =
      `<!doctype html>\n<html><head><meta charset="utf-8"><title>Keys</title><style>section{min-height:300px} ul{display:none}</style></head><body>\n` +
      `<section id="s1">\n  <h2 class="title">Quarterly results</h2>\n  <p class="sub">Revenue grew in every region</p>\n</section>\n` +
      `<section id="s2">\n  <h2 class="title">Next steps</h2>\n  <p class="sub">Hire two engineers</p>\n</section>\n<ul>\n${filler}\n</ul>\n</body></html>\n`;
    expect(Buffer.byteLength(html)).toBeGreaterThan(2_000_000);
    const o = await openDeck({ html, name: 'keys.html' });
    try {
      await openFieldAt(o.deck, '#s1 p.sub');
      await o.deck.key('End', ['control']);
      await typeKeys(o.deck, ' today');
      if (flow.startsWith('Enter')) await o.deck.key('Enter');
      const p = (await textPoint(o.deck, '#s1 h2'))!;
      await o.deck.input(
        [
          { type: 'mouseMove', x: Math.round(p.x), y: Math.round(p.y) },
          { type: 'mouseDown', x: Math.round(p.x), y: Math.round(p.y), button: 'left', clickCount: 1 },
          { type: 'mouseUp', x: Math.round(p.x), y: Math.round(p.y), button: 'left', clickCount: 1 },
        ],
        10,
      );
      // At once: on this deck the heading's field is still waiting for the subtitle's write.
      await typeKeys(o.deck, ' now');
      await o.deck.key('Enter');
      await until('both writes', async () => (fs.readFileSync(o.file, 'utf8').includes('Quarterly results now') ? true : undefined), 30_000);
      const now = await settled(o.file);
      const h = /<section id="s1">\s*<h2 class="title">([^<]*)<\/h2>\s*<p class="sub">([^<]*)<\/p>/.exec(now);
      expect([h?.[1], h?.[2]]).toEqual(['Quarterly results now', 'Revenue grew in every region today']);
      // The keys never reached the deck (no slide moved, no note was made by the N in " now").
      expect((await o.app.win(o.deck.docId)).state.notes.filter((n) => n.kind !== 'edit')).toEqual([]);
    } finally {
      await closeAll(o);
    }
  });
}
