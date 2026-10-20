// The ambiguity picker's model (preload/picker.ts; 6.3, 9.2 Strategy 2 step 3, P2-8): which matches it offers,
// how main's reply is rebuilt, and moving and choosing. The panel itself runs in Electron
// (test/e2e/edit-overlay-ui.spec.ts).

import { describe, expect, it } from 'vitest';
import { PICKER_MAX, PickerModel, candidateLabel, pickable, pickerItems } from '../../../packages/app/src/preload/picker';
import type { MatchReason, MatchResult } from '../../../packages/core/src/types';

const amb = (reason: MatchReason, n = 2): MatchResult => ({
  confidence: 'ambiguous',
  runId: null,
  strategy: null,
  reason,
  candidates: Array.from({ length: n }, (_, i) => ({ runId: `l:${i}:0`, strategy: 'script-literal' as const, start: -1, end: -1, line: -1 })),
});

describe('pickable (P2-8: what the picker offers)', () => {
  it('offers equal, substring and normalized candidates', () => {
    expect(pickable(amb('duplicate'))).toBe('equal');
    expect(pickable(amb('key', 1))).toBe('equal');
    expect(pickable(amb('shadow', 1))).toBe('equal');
    expect(pickable(amb('stamp-other', 1))).toBe('equal');
    expect(pickable(amb('substring'))).toBe('substring');
    expect(pickable(amb('not-equal'))).toBe('normalized');
  });
  it('never offers split or short matches (22 of 22 were wrong-place writes, F29)', () => {
    expect(pickable(amb('split', 1))).toBeNull();
    expect(pickable(amb('short', 1))).toBeNull();
  });
  it('offers nothing for exact or none, or without candidates', () => {
    expect(pickable({ confidence: 'exact', runId: 'h:bl-1:0', strategy: 'html-text', candidates: [] })).toBeNull();
    expect(pickable({ confidence: 'none', runId: null, strategy: null, candidates: [], reason: 'computed' })).toBeNull();
    expect(pickable(amb('duplicate', 0))).toBeNull();
  });
});

describe("pickerItems (main's reply, rebuilt field by field)", () => {
  const asked = new Set(['l:1:0', 'l:2:0', 'h:bl-3:0']);
  it('keeps the runs asked about, once, in main\'s order', () => {
    const items = pickerItems(
      {
        fieldId: 7,
        candidates: [
          { runId: 'l:2:0', line: 12, context: '\u2026two\u2026', keyWarning: 'This text is also used as a key at deck.html:3' },
          { runId: 'l:9:0', line: 1, context: 'not asked for' },
          { runId: 'l:1:0', line: 10, context: '\u2026one\u2026', extra: 'dropped' },
          { runId: 'l:2:0', line: 12, context: 'twice' },
        ],
      },
      7,
      asked,
    );
    expect(items).toEqual([
      { runId: 'l:2:0', line: 12, context: '\u2026two\u2026', keyWarning: 'This text is also used as a key at deck.html:3' },
      { runId: 'l:1:0', line: 10, context: '\u2026one\u2026' },
    ]);
  });
  it('drops malformed candidates', () => {
    const bad = [
      { runId: 'l:1:0', line: 0, context: 'x' },
      { runId: 'l:1:0', line: 1.5, context: 'x' },
      { runId: 'l:1:0', line: 3, context: 42 },
      { runId: 'l:1:0', line: 3, context: 'a\uD800b' },
      { runId: 'l:1:0', line: 3, context: 'x'.repeat(5000) },
      { runId: 'l:1:0', line: 3, context: 'x', keyWarning: 7 },
      { runId: 'not a run', line: 3, context: 'x' },
      null,
      'l:1:0',
    ];
    expect(pickerItems({ fieldId: 1, candidates: bad }, 1, asked)).toEqual([]);
  });
  it('answers null for another request or a malformed reply', () => {
    expect(pickerItems({ fieldId: 2, candidates: [] }, 1, asked)).toBeNull();
    expect(pickerItems({ fieldId: 1 }, 1, asked)).toBeNull();
    expect(pickerItems(null, 1, asked)).toBeNull();
    expect(pickerItems('x', 1, asked)).toBeNull();
  });
  it('lists at most PICKER_MAX candidates', () => {
    const many = new Set(Array.from({ length: 80 }, (_, i) => `l:${i}:0`));
    const reply = { fieldId: 1, candidates: [...many].map((runId, i) => ({ runId, line: i + 1, context: 'c' })) };
    expect(pickerItems(reply, 1, many)?.length).toBe(PICKER_MAX);
  });
});

describe('PickerModel (keys and mouse)', () => {
  const items = [
    { runId: 'l:1:0', line: 1, context: 'a' },
    { runId: 'l:2:0', line: 2, context: 'b' },
    { runId: 'l:3:0', line: 3, context: 'c' },
  ];
  it('moves the highlight with wrap-around and chooses it', () => {
    const m = new PickerModel(items);
    expect(m.index).toBe(0);
    m.move(-1);
    expect(m.index).toBe(2);
    m.move(1);
    m.move(1);
    expect(m.index).toBe(1);
    expect(m.choose()?.runId).toBe('l:2:0');
  });
  it('chooses a row by number (1\u20139) or a hovered row, and nothing out of range', () => {
    const m = new PickerModel(items);
    expect(m.choose(2)?.runId).toBe('l:3:0');
    expect(m.choose(3)).toBeNull();
    m.set(1);
    expect(m.index).toBe(1);
    m.set(9);
    expect(m.index).toBe(1);
    expect(new PickerModel([]).choose()).toBeNull();
  });
  it('labels a candidate with the file and line', () => {
    expect(candidateLabel('deck.html', items[1])).toBe('deck.html:2');
  });
});
