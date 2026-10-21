// The fit guard's comparison (preload/fit-guard.ts; 6.3 Fit guard): line boxes from client rects, widows, overflow
// amounts and the badge's warnings. measureFit and the container heuristic read the layout in Electron
// (test/e2e/edit-overlay-ui.spec.ts).

import { describe, expect, it } from 'vitest';
import { WIDOW_WIDTH_SHARE, fitWarnings, isWidow, lineBoxes, measureFitAs, overflowOf, type FitState } from '../../../packages/app/src/preload/fit-guard';

const r = (top: number, bottom: number, left: number, right: number) => ({ top, bottom, left, right });
const fit = (o: Partial<FitState>): FitState => ({ lines: 1, overflow: 0, containerOverflow: 0, widow: false, ...o });

describe('lineBoxes (distinct line tops of Range.getClientRects)', () => {
  it('groups the rects of one line, whatever their heights, and orders lines by top', () => {
    const lines = lineBoxes([r(30, 51, 10, 90), r(5, 26, 10, 200), r(3, 28, 200, 260), r(30, 51, 90, 95), r(55, 76, 10, 40)]);
    expect(lines).toEqual([r(3, 28, 10, 260), r(30, 51, 10, 95), r(55, 76, 10, 40)]);
  });

  it('counts the element box a range reports on the line it overlaps, and ignores empty rects', () => {
    // A <b> fully inside the range adds its own border box on the same line.
    expect(lineBoxes([r(10, 30, 0, 50), r(9, 31, 20, 40), r(40, 40, 0, 0), r(50, 50, 0, 100)]).length).toBe(1);
    expect(lineBoxes([])).toEqual([]);
  });

  it('keeps two lines apart when they overlap by less than half a line', () => {
    expect(lineBoxes([r(0, 20, 0, 10), r(14, 34, 0, 10)]).length).toBe(2);
    expect(lineBoxes([r(0, 20, 0, 10), r(8, 28, 0, 10)]).length).toBe(1);
  });
});

describe('isWidow (6.3: a last line with one word, or less than 15% of the block width)', () => {
  it('is never a widow on one line', () => {
    expect(isWidow(1, { width: 5, words: 1 }, 300)).toBe(false);
  });
  it('one word on the last line', () => {
    expect(isWidow(2, { width: 200, words: 1 }, 300)).toBe(true);
  });
  it('a short last line', () => {
    expect(isWidow(3, { width: 300 * WIDOW_WIDTH_SHARE - 1, words: 2 }, 300)).toBe(true);
    expect(isWidow(3, { width: 300 * WIDOW_WIDTH_SHARE + 1, words: 2 }, 300)).toBe(false);
  });
  it('an unknown block width counts words only', () => {
    expect(isWidow(2, { width: 1, words: 2 }, 0)).toBe(false);
  });
});

describe('overflowOf (scrollHeight > clientHeight + 1, and the same for width)', () => {
  it('ignores a pixel of rounding and sums both axes', () => {
    expect(overflowOf({ scrollWidth: 101, clientWidth: 100, scrollHeight: 50, clientHeight: 50 })).toBe(0);
    expect(overflowOf({ scrollWidth: 100, clientWidth: 100, scrollHeight: 73, clientHeight: 50 })).toBe(23);
    expect(overflowOf({ scrollWidth: 120, clientWidth: 100, scrollHeight: 73, clientHeight: 50 })).toBe(43);
  });
});

describe('fitWarnings (the badge: +1 line, overflows, widow; against the state before the edit)', () => {
  it('says nothing when the text still fits as before, or takes fewer lines', () => {
    expect(fitWarnings(fit({}), fit({}))).toEqual([]);
    expect(fitWarnings(fit({ lines: 3 }), fit({ lines: 2 }))).toEqual([]);
  });
  it('counts new lines', () => {
    expect(fitWarnings(fit({}), fit({ lines: 2 }))).toEqual(['+1 line']);
    expect(fitWarnings(fit({}), fit({ lines: 4 }))).toEqual(['+3 lines']);
  });
  it('warns of an overflow of the element or of its container that is new or grew', () => {
    expect(fitWarnings(fit({}), fit({ overflow: 12 }))).toEqual(['overflows']);
    expect(fitWarnings(fit({}), fit({ containerOverflow: 23 }))).toEqual(['overflows']);
    // A deck that already spilled over warns only when the text makes it worse.
    expect(fitWarnings(fit({ containerOverflow: 20 }), fit({ containerOverflow: 20 }))).toEqual([]);
    expect(fitWarnings(fit({ containerOverflow: 20 }), fit({ containerOverflow: 30 }))).toEqual(['overflows']);
  });
  it('warns of a new widow only', () => {
    expect(fitWarnings(fit({}), fit({ lines: 2, widow: true }))).toEqual(['+1 line', 'widow']);
    expect(fitWarnings(fit({ lines: 2, widow: true }), fit({ lines: 2, widow: true }))).toEqual([]);
  });
  it('lists every warning in the badge order', () => {
    expect(fitWarnings(fit({}), fit({ lines: 3, containerOverflow: 30, widow: true }))).toEqual(['+2 lines', 'overflows', 'widow']);
  });
});

describe('measureFitAs: the reading as the deck renders the text, not the source case the field shows (E-10)', () => {
  /** An element whose layout depends on its inline text-transform: uppercase takes two lines, the source case one. */
  function fakeElement(inline: Record<string, [string, string]>) {
    const style = {
      getPropertyValue: (p: string) => inline[p]?.[0] ?? '',
      getPropertyPriority: (p: string) => inline[p]?.[1] ?? '',
      setProperty: (p: string, v: string, prio = '') => void (inline[p] = [v, prio]),
      removeProperty: (p: string) => void delete inline[p],
    };
    const rendered = () => (inline['text-transform']?.[0] ?? 'uppercase') === 'uppercase';
    const range = {
      selectNodeContents: () => undefined,
      getClientRects: () => (rendered() ? [r(0, 20, 0, 390), r(24, 44, 0, 40)] : [r(0, 20, 0, 336)]),
      setStart: () => undefined,
      setEnd: () => undefined,
      getBoundingClientRect: () => ({ top: 24, bottom: 44, left: 0, right: 40, width: 40, height: 20 }),
    };
    const el = {
      style,
      ownerDocument: { createRange: () => range, createTreeWalker: () => ({ nextNode: () => null }) },
      scrollWidth: 400,
      clientWidth: 400,
      scrollHeight: 44,
      clientHeight: 44,
      getBoundingClientRect: () => ({ width: 400 }),
      parentElement: null,
    };
    const win = { getComputedStyle: () => ({ display: 'block', paddingLeft: '0', paddingRight: '0' }) };
    return { el: el as unknown as HTMLElement, win: win as unknown as Window, inline };
  }

  it('puts the deck\'s own case back for the reading, then the field\'s source case again', () => {
    // The field set text-transform: none !important (6.3 Source case); before, the element had no inline value.
    const { el, win, inline } = fakeElement({ 'text-transform': ['none', 'important'], 'font-variant-caps': ['normal', 'important'] });
    const asRendered = measureFitAs(el, win, null, [
      ['text-transform', '', ''],
      ['font-variant-caps', '', ''],
    ]);
    expect(asRendered.lines).toBe(2);
    expect(inline).toEqual({ 'text-transform': ['none', 'important'], 'font-variant-caps': ['normal', 'important'] });
    // Without the case to put back (no Source case), the reading is of what shows now.
    expect(measureFitAs(el, win, null, []).lines).toBe(1);
  });

  it('an inline value the element had is the one put back', () => {
    const { el, win, inline } = fakeElement({ 'text-transform': ['none', 'important'] });
    expect(measureFitAs(el, win, null, [['text-transform', 'uppercase', '']]).lines).toBe(2);
    expect(inline['text-transform']).toEqual(['none', 'important']);
  });
});
