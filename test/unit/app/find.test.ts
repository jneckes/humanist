// 6.9 Find over the slide index: folding (case, diacritics, quotes, dashes, spaces), hits by slide, snippets,
// the occurrence findInPage must reach, the shell's argument checks, and highlightMatch against a fake
// webContents. Real-Electron runs: test/e2e/render-products-index.spec.ts.
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('electron', () => ({}));

import { FIND_MAX_HITS, type SlideIndex } from '@blueline/core/ipc-render';
import {
  findInDeck,
  findInPageSame,
  findOnSlide,
  findResponse,
  fold,
  foldQuery,
  highlightMatch,
  hitFor,
  inView,
  makeSnippet,
  searchIndex,
  validateFindArgs,
  validateFindShowArgs,
  type FindInPageTarget,
  type FoundInPage,
} from '../../../packages/app/src/main/find';

const V = 'c'.repeat(64);
const COMBINING_ACUTE = String.fromCodePoint(0x301);
const NBSP = String.fromCodePoint(0xa0);

function deck(slides: string[][], kind: SlideIndex['kind'] = 'generic'): SlideIndex {
  return {
    version: V,
    kind,
    navKind: kind === 'generic' ? 'index' : 'none',
    slides: slides.map((text, i) => ({ index: i, title: `Slide ${i + 1}`, nav: { kind: 'index', value: i }, text })),
    designSize: { w: 1600, h: 900 },
    complete: true,
  };
}

describe('folding', () => {
  it('ignores case and diacritics, precomposed or combining', () => {
    expect(fold('Résumé').text).toBe('resume');
    expect(fold('Re' + COMBINING_ACUTE + 'sume').text).toBe('resume');
    expect(fold('ÅNGSTRÖM naïve façade').text).toBe('angstrom naive facade');
    expect(foldQuery('  RÉSUMÉ ')).toBe('resume');
  });

  it('treats curly quotes, dashes and every space alike, and collapses whitespace', () => {
    expect(fold('it’s “fine” — ok').text).toBe('it\'s "fine" - ok');
    expect(fold(`a${NBSP}b \n\t c`).text).toBe('a b c');
    expect(fold('zero' + String.fromCodePoint(0x200b) + 'width').text).toBe('zerowidth');
    expect(fold('wait…').text).toBe('wait...');
  });

  it('maps every folded unit back to the original', () => {
    const s = 'Ça va? Résumé';
    const f = fold(s);
    const at = f.text.indexOf('resume');
    expect(s.slice(f.start[at], f.end[at + 'resume'.length - 1])).toBe('Résumé');
    const c = 'xe' + COMBINING_ACUTE + 'y';
    const fc = fold(c);
    // The combining mark folds away; "e" still maps to its own code unit, and the mark follows it.
    expect(fc.text).toBe('xey');
    expect(c.slice(fc.start[1], fc.end[1])).toBe('e');
  });
});

describe('findInDeck (6.9: all slides, shown or not, listed by slide)', () => {
  const index = deck([
    ['Q3 business review', 'Revenue grew'],
    ['Highlights', 'Latency halved', 'résumé screening'],
    ['Hidden slide', 'The resume step', 'RESUME again'],
  ]);

  it('finds across every slide, case- and diacritic-insensitively, in slide order', () => {
    const hits = findInDeck(index, 'Résumé');
    expect(hits.map((h) => [h.slide, h.matchIndex, h.text])).toEqual([
      [1, 0, 'résumé'],
      [2, 0, 'resume'],
      [2, 1, 'RESUME'],
    ]);
    expect(hits[1].title).toBe('Slide 3');
  });

  it('gives a snippet with the match position in the original spelling', () => {
    const [h] = findInDeck(index, 'latency');
    expect(h.snippet.slice(h.snippetMatch.start, h.snippetMatch.end)).toBe('Latency');
    expect(h.snippet).toContain('Highlights');
  });

  it('never matches across two of a slide’s strings: each is one block, and findInPage never matches across blocks (review finding 12)', () => {
    expect(findInDeck(index, 'highlights latency')).toEqual([]);
    // Within one block's string a phrase matches, however its inline runs were split.
    expect(findInDeck(deck([['Bolder moves first.']]), 'bolder moves').map((h) => h.text)).toEqual(['Bolder moves']);
  });

  it('the occurrence counts only earlier hits findInPage would also match; matchIndex stays Find’s own (review finding 12)', () => {
    // One slide spells it with an en dash and with hyphens: findInPage keeps them apart.
    const d = deck([['Plan 2020–2021', 'Budget 2020-2021', 'Audit 2020-2021']]);
    expect(findInDeck(d, '2020-2021').map((h) => [h.matchIndex, h.text, h.occurrence])).toEqual([
      [0, '2020–2021', 0],
      [1, '2020-2021', 0],
      [2, '2020-2021', 1],
    ]);
    expect(findOnSlide(findInDeck(d, '2020-2021')[2])).toMatchObject({ text: '2020-2021', occurrence: 1 });
    // Case, accents and curly quotes findInPage folds too: every earlier hit counts.
    const r = deck([['Résumé', 'resume', 'RESUME', 'don’t', "don't"]]);
    expect(findInDeck(r, 'resume').map((h) => h.occurrence)).toEqual([0, 1, 2]);
    expect(findInDeck(r, "don't").map((h) => h.occurrence)).toEqual([0, 1]);
    // A document counts across the page: a heading "Growth" and its paragraph "Plan ahead…" are two blocks,
    // so only the two real "growth plan" paragraphs are hits, and the second is findInPage's second.
    const doc = deck([['Growth', 'Plan ahead for the next year.'], ['The growth plan is described here.'], ['Another growth plan sentence.']], 'scroll');
    expect(findInDeck(doc, 'growth plan').map((h) => [h.slide, h.matchIndex, h.occurrence])).toEqual([
      [1, 0, 0],
      [2, 1, 1],
    ]);
  });

  it('findInPageSame: what Chromium’s find equates (checked against findInPage in Electron 44)', () => {
    const same: [string, string][] = [
      ['resume', 'Résumé'], ['strasse', 'Straße'], ['fine', 'ﬁne'], ['fullwidth', 'ＦＵＬＬwidth'], ['wait...', 'wait…'],
      ['zerowidth', 'zero\u200bwidth'], ['softhyphen', 'soft\u00adhyphen'], ["don't", 'don’t'], ['"curly"', '“curly”'], ['non breaking', 'non\u00a0breaking'],
    ];
    const apart: [string, string][] = [['2020-2021', '2020–2021'], ['em-dash', 'em—dash'], ['-5', '−5'], ["prime's", 'prime′s'], ['"guill"', '«guill»'], ['hyph-nb', 'hyph\u2011nb']];
    for (const [a, b] of same) expect(findInPageSame(a, b), `${a} ~ ${b}`).toBe(true);
    for (const [a, b] of apart) expect(findInPageSame(a, b), `${a} !~ ${b}`).toBe(false);
  });

  it('folds what findInPage folds, so Find lists every match findInPage counts: ß, ligatures, full-width, base letters', () => {
    expect(fold('Straße ﬁne ＦＵＬＬ Æsir Øre').text).toBe('strasse fine full aesir ore');
    expect(findInDeck(deck([['Straße', 'strasse']]), 'STRASSE').map((h) => h.occurrence)).toEqual([0, 1]);
  });

  it('documents count matches across the whole page (findInPage sees one page)', () => {
    const doc = deck([['intro resume'], ['Overview', 'resume and résumé'], ['Method', 'no match']], 'scroll');
    expect(findInDeck(doc, 'resume').map((h) => [h.slide, h.matchIndex])).toEqual([
      [0, 0],
      [1, 1],
      [1, 2],
    ]);
  });

  it('an empty or blank query finds nothing; hits are capped', () => {
    expect(findInDeck(index, '')).toEqual([]);
    expect(findInDeck(index, `  ${NBSP} `)).toEqual([]);
    const many = deck([[Array.from({ length: FIND_MAX_HITS + 20 }, () => 'aa').join(' ')]]);
    const r = searchIndex(many, 'aa');
    expect(r.hits).toHaveLength(FIND_MAX_HITS);
    expect(r.truncated).toBe(true);
  });

  it('findResponse says when the index is not ready, and hitFor checks a shell’s pick against the index', () => {
    expect(findResponse(null, 'x')).toEqual({ query: 'x', version: null, hits: [], truncated: false, pending: true });
    const r = findResponse(index, 'resume');
    expect(r.pending).toBe(false);
    expect(r.version).toBe(V);
    expect(hitFor(index, 'resume', 2, 1)?.text).toBe('RESUME');
    expect(hitFor(index, 'resume', 2, 5)).toBeNull();
  });

  it('findOnSlide: the matched text as the slide spells it, and its occurrence', () => {
    const h = findInDeck(index, 'resume')[2];
    expect(findOnSlide(h)).toEqual({ text: 'RESUME', occurrence: 1, pageWide: false, options: { matchCase: false } });
    // A hit without an occurrence (an older caller's) falls back to its matchIndex.
    expect(findOnSlide({ text: 'x', matchIndex: 3 }).occurrence).toBe(3);
    expect(findOnSlide(h, { kind: 'single' }).pageWide).toBe(true);
    expect(findOnSlide(h, { kind: 'reveal' }).pageWide).toBe(false);
  });
});

describe('snippets', () => {
  it('cuts at word boundaries with ellipses, and keeps the match offsets', () => {
    const text = 'alpha '.repeat(20) + 'TARGET' + ' omega'.repeat(30);
    const at = text.indexOf('TARGET');
    const s = makeSnippet(text, at, at + 6);
    expect(s.snippet.startsWith('…')).toBe(true);
    expect(s.snippet.endsWith('…')).toBe(true);
    expect(s.snippet.slice(s.start, s.end)).toBe('TARGET');
    expect(s.snippet.length).toBeLessThan(120);
  });

  it('never splits a surrogate pair at an edge', () => {
    const text = '😀'.repeat(30) + 'x' + '😀'.repeat(40);
    const at = text.indexOf('x');
    const s = makeSnippet(text, at, at + 1);
    const body = s.snippet.replace(/^…|…$/g, '');
    expect(/^[\uDC00-\uDFFF]/.test(body)).toBe(false);
    expect(/[\uD800-\uDBFF]$/.test(body)).toBe(false);
    expect(s.snippet.slice(s.start, s.end)).toBe('x');
  });

  it('short text has no ellipsis', () => {
    expect(makeSnippet('just this', 5, 9)).toEqual({ snippet: 'just this', start: 5, end: 9 });
  });
});

describe('shell argument checks', () => {
  it('validateFindArgs takes one short string without control characters', () => {
    expect(validateFindArgs(['résumé'])).toEqual({ ok: true, value: 'résumé' });
    expect(validateFindArgs([]).ok).toBe(false);
    expect(validateFindArgs([1]).ok).toBe(false);
    expect(validateFindArgs(['a', 'b']).ok).toBe(false);
    expect(validateFindArgs(['x'.repeat(257)]).ok).toBe(false);
    expect(validateFindArgs(['a' + String.fromCharCode(7)]).ok).toBe(false);
    expect(validateFindArgs([{ toString: () => 'x' }]).ok).toBe(false);
  });

  it('validateFindShowArgs takes two indices', () => {
    expect(validateFindShowArgs([2, 1])).toEqual({ ok: true, value: { slide: 2, matchIndex: 1 } });
    expect(validateFindShowArgs([2]).ok).toBe(false);
    expect(validateFindShowArgs([-1, 0]).ok).toBe(false);
    expect(validateFindShowArgs([1.5, 0]).ok).toBe(false);
    expect(validateFindShowArgs(['1', 0]).ok).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------- findInPage

/** A fake webContents: matches at `rects`, in page order; a new session starts at the first. */
class FakePage extends EventEmitter {
  calls: { text: string; findNext: boolean }[] = [];
  private active = 0;
  private id = 0;
  emptyFirst: boolean;

  constructor(
    private readonly rects: { x: number; y: number; width: number; height: number }[],
    opts: { emptyFirst?: boolean } = {},
  ) {
    super();
    this.emptyFirst = opts.emptyFirst === true;
  }

  findInPage(text: string, o?: { findNext?: boolean }): number {
    const id = ++this.id;
    const newSession = o?.findNext === true;
    this.calls.push({ text, findNext: newSession });
    if (newSession) this.active = 1;
    else this.active = (this.active % this.rects.length) + 1;
    const empty = this.emptyFirst;
    this.emptyFirst = false;
    setTimeout(() => {
      const r: FoundInPage = empty
        ? { requestId: id, activeMatchOrdinal: 0, matches: 0, selectionArea: { x: 0, y: 0, width: 0, height: 0 }, finalUpdate: true }
        : { requestId: id, activeMatchOrdinal: this.active, matches: this.rects.length, selectionArea: this.rects[this.active - 1], finalUpdate: true };
      this.emit('found-in-page', {}, r);
    }, 1);
    return id;
  }

  stopFindInPage(): void {
    this.active = 0;
  }
}

const VIEW = { width: 1600, height: 900 };
const OFF = { x: -3000, y: 10, width: 40, height: 18 };
const ON1 = { x: 100, y: 100, width: 40, height: 18 };
const ON2 = { x: 100, y: 400, width: 40, height: 18 };

describe('highlightMatch (6.9: highlight the match with findInPage)', () => {
  it('skips matches on slides that are rendered but not shown, and reaches the occurrence on screen', async () => {
    // Page order: a hidden slide's match off screen, then the shown slide's two matches.
    const page = new FakePage([OFF, ON1, ON2]);
    const r = await highlightMatch(page as unknown as FindInPageTarget, { text: 'alpha', occurrence: 1 }, VIEW);
    expect(r).toEqual({ ok: true, ordinal: 3, matches: 3, rect: ON2 });
    expect(page.calls[0].findNext).toBe(true);
  });

  it('retries once when the first request after a slide change finds nothing', async () => {
    const page = new FakePage([ON1], { emptyFirst: true });
    const r = await highlightMatch(page as unknown as FindInPageTarget, { text: 'alpha', occurrence: 0 }, VIEW, { retryMs: 5 });
    expect(r.ok).toBe(true);
    expect(r.ordinal).toBe(1);
  });

  it('reports a text that is not on screen', async () => {
    const page = new FakePage([OFF]);
    const r = await highlightMatch(page as unknown as FindInPageTarget, { text: 'alpha', occurrence: 0 }, VIEW);
    expect(r.ok).toBe(false);
    expect(await highlightMatch(new FakePage([ON1]) as unknown as FindInPageTarget, { text: '  ', occurrence: 0 }, VIEW)).toEqual({ ok: false, ordinal: 0, matches: 0 });
  });

  it('an occurrence past the visible ones highlights the last visible and says so', async () => {
    const page = new FakePage([ON1, ON2]);
    const r = await highlightMatch(page as unknown as FindInPageTarget, { text: 'alpha', occurrence: 5 }, VIEW);
    expect(r).toMatchObject({ ok: false, ordinal: 2, matches: 2 });
  });

  it('a document counts the occurrence across the page, wherever the match is', async () => {
    const page = new FakePage([ON1, OFF, ON2]);
    expect(await highlightMatch(page as unknown as FindInPageTarget, { text: 'alpha', occurrence: 1, pageWide: true }, VIEW)).toEqual({ ok: true, ordinal: 2, matches: 3, rect: OFF });
    expect(await highlightMatch(new FakePage([ON1]) as unknown as FindInPageTarget, { text: 'alpha', occurrence: 4, pageWide: true }, VIEW)).toMatchObject({ ok: false, ordinal: 1, matches: 1 });
  });

  it('inView: any overlap with the view counts; an empty rect never does', () => {
    expect(inView({ x: -10, y: -5, width: 20, height: 10 }, VIEW)).toBe(true);
    expect(inView({ x: 1600, y: 0, width: 20, height: 10 }, VIEW)).toBe(false);
    expect(inView({ x: 10, y: 10, width: 0, height: 10 }, VIEW)).toBe(false);
  });
});
