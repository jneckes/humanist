// The fit guard's comparison (preload/fit-guard.ts; 6.3 Fit guard): line boxes from client rects, widows, overflow
// amounts and the badge's warnings. measureFit and the container heuristic read the layout in Electron
// (test/e2e/edit-overlay-ui.spec.ts).

import { describe, expect, it } from 'vitest';
import { WIDOW_WIDTH_SHARE, fitWarnings, isWidow, lineBoxes, overflowOf, type FitState } from '../../../packages/app/src/preload/fit-guard';

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
