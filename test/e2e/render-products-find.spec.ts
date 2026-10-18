// Find's numbering matches findInPage's (6.9 Find: "Choosing a result navigates to that slide, then highlights
// the match with findInPage"; review finding 12). In the app's own window: __blTest.find lists the hits and
// __blTest.findShow chooses each one as the shell does; then stopFindInPage('keepSelection') and getSelection()
// show what findInPage really highlighted. Every hit must highlight its own text, and none may report false
// while its text is on screen: a phrase that runs from a heading into its paragraph is no hit (findInPage never
// matches across blocks), a slide that spells a date with an en dash and with hyphens highlights each spelling
// in its own place, and a word split across an inline element ("Bold<b>er</b>") is found as findInPage finds it.

import { expect, test } from '@playwright/test';
import * as path from 'node:path';
import { FIXTURES, Scratch, copyInto, launchApp, resolveRunAs, sleep, type BlApp, type DeckView } from '../helpers/app';

test.describe.configure({ mode: 'serial' });
test.skip(process.platform === 'linux' && !process.env.DISPLAY, 'needs a display: run through `npm run test:e2e` (its global setup starts Xvfb)');
test.setTimeout(300_000);

interface Hit {
  slide: number;
  matchIndex: number;
  text: string;
  snippet: string;
}

const scratch = new Scratch(resolveRunAs());
test.afterAll(() => scratch.cleanup());

function find(app: BlApp, docId: string, q: string): Promise<{ pending: boolean; hits: Hit[] } | null> {
  return app.electronApp.evaluate((_e, a) => (globalThis as unknown as { __blTest: { find(d: string, q: string): { pending: boolean; hits: Hit[] } | null } }).__blTest.find(a.id, a.q), { id: docId, q });
}

function show(app: BlApp, docId: string, h: Hit): Promise<boolean> {
  return app.electronApp.evaluate((_e, a) => (globalThis as unknown as { __blTest: { findShow(d: string, s: number, m: number): Promise<boolean> } }).__blTest.findShow(a.id, a.slide, a.m), {
    id: docId,
    slide: h.slide,
    m: h.matchIndex,
  });
}

/** What findInPage highlighted: the id of the element its selection starts in, and the selected text. */
async function highlighted(app: BlApp, deck: DeckView): Promise<{ id: string | null; text: string }> {
  await app.electronApp.evaluate(({ webContents }, id) => webContents.fromId(id)?.stopFindInPage('keepSelection'), deck.wcId);
  await sleep(150);
  return deck.eval(
    '(function(){var s=getSelection();if(!s||!s.rangeCount)return {id:null,text:""};var n=s.getRangeAt(0).startContainer;var el=n.nodeType===3?n.parentElement:n;var h=el&&el.closest("[id]");return {id:h?h.id:null,text:String(s)}})()',
  );
}

async function hitsOf(app: BlApp, docId: string, q: string): Promise<Hit[]> {
  await expect.poll(async () => (await find(app, docId, q))?.pending ?? true, { timeout: 120_000 }).toBe(false);
  return (await find(app, docId, q))!.hits;
}

test('a document: no hit across a heading and its paragraph, and each real hit highlights its own paragraph', async () => {
  const dir = scratch.dir('find-blocks');
  const file = copyInto(path.join(FIXTURES, 'render/find-blocks.html'), dir);
  scratch.own(dir);
  const app = await launchApp({ files: [file], scratch });
  try {
    const deck = await app.waitForDeck('find-blocks.html');
    const hits = await hitsOf(app, deck.docId, 'growth plan');
    expect(hits.map((h) => h.text)).toEqual(['growth plan', 'growth plan']);
    const want = ['p2', 'p3'];
    for (let i = 0; i < hits.length; i++) {
      await deck.eval('scrollTo(0,0)');
      await find(app, deck.docId, 'growth plan');
      expect(await show(app, deck.docId, hits[i]), `hit ${i + 1} is on the page`).toBe(true);
      expect(await highlighted(app, deck), `hit ${i + 1}`).toEqual({ id: want[i], text: 'growth plan' });
    }
  } finally {
    await app.close();
  }
});

test('a document: no hit across a preserved line break (a <pre> block, or white-space: pre-line), only the real paragraphs (review finding 12 re-verification)', async () => {
  const dir = scratch.dir('find-preline');
  const file = copyInto(path.join(FIXTURES, 'render/find-preline.html'), dir);
  scratch.own(dir);
  const app = await launchApp({ files: [file], scratch });
  try {
    const deck = await app.waitForDeck('find-preline.html');
    const hits = await hitsOf(app, deck.docId, 'growth plan');
    // Only the two ordinary paragraphs: not the <pre> or the pre-line paragraph, where the phrase spans a break.
    expect(hits.map((h) => h.text)).toEqual(['growth plan', 'growth plan']);
    const want = ['p2', 'p4'];
    for (let i = 0; i < hits.length; i++) {
      await deck.eval('scrollTo(0,0)');
      await find(app, deck.docId, 'growth plan');
      expect(await show(app, deck.docId, hits[i]), `hit ${i + 1} is on the page`).toBe(true);
      expect(await highlighted(app, deck), `hit ${i + 1}`).toEqual({ id: want[i], text: 'growth plan' });
    }
  } finally {
    await app.close();
  }
});

test('a deck: two spellings of a date, a word split by <b>, and no phrase across a heading: every hit highlights its own text', async () => {
  const dir = scratch.dir('find-dashes');
  const file = copyInto(path.join(FIXTURES, 'render/find-dashes.html'), dir);
  scratch.own(dir);
  const app = await launchApp({ files: [file], scratch });
  try {
    const deck = await app.waitForDeck('find-dashes.html');
    const cases: { q: string; want: { slide: number; id: string; text: string }[] }[] = [
      {
        q: '2020-2021',
        want: [
          { slide: 0, id: 'a', text: '2020–2021' },
          { slide: 0, id: 'b', text: '2020-2021' },
          { slide: 0, id: 'c', text: '2020-2021' },
        ],
      },
      {
        q: 'bolder moves',
        want: [
          { slide: 1, id: 'd', text: 'Bolder moves' },
          { slide: 1, id: 'e', text: 'bolder moves' },
        ],
      },
      { q: 'growth plan', want: [{ slide: 2, id: 'g', text: 'growth plan' }] },
    ];
    for (const c of cases) {
      const hits = await hitsOf(app, deck.docId, c.q);
      expect(
        hits.map((h) => [h.slide, h.text]),
        c.q,
      ).toEqual(c.want.map((w) => [w.slide, w.text]));
      for (let i = 0; i < hits.length; i++) {
        await find(app, deck.docId, c.q);
        expect(await show(app, deck.docId, hits[i]), `${c.q} hit ${i + 1} is on screen`).toBe(true);
        const got = await highlighted(app, deck);
        expect(got.id, `${c.q} hit ${i + 1}`).toBe(c.want[i].id);
        expect(got.text.replace(/\s+/g, ' ').toLowerCase()).toBe(c.want[i].text.toLowerCase());
      }
    }
  } finally {
    await app.close();
  }
});
