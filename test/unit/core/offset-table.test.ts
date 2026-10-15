import { describe, expect, it } from 'vitest';
import { UnitTable, composeTables } from '@blueline/core/offset-table';

describe('UnitTable', () => {
  it('maps plain characters one to one', () => {
    const t = new UnitTable();
    for (let i = 0; i < 3; i++) t.push(1, 1);
    t.finish();
    expect([0, 1, 2, 3].map((i) => t.toRaw(i))).toEqual([0, 1, 2, 3]);
    expect(t.widen(1, 2)).toEqual({ start: 1, end: 2 });
  });

  it('keeps a character reference atomic', () => {
    // raw "a&amp;b" -> decoded "a&b"
    const t = new UnitTable();
    t.push(1, 1);
    t.push(1, 5);
    t.push(1, 1);
    t.finish();
    expect([0, 1, 2, 3].map((i) => t.toRaw(i))).toEqual([0, 1, 6, 7]);
    expect(t.rawLength).toBe(7);
  });

  it('widens around a unit that decodes to two code units', () => {
    // raw "x&#x1F600;y" -> decoded "x😀y"
    const t = new UnitTable();
    t.push(1, 1);
    t.push(2, 9);
    t.push(1, 1);
    t.finish();
    expect(t.length).toBe(4);
    expect(t.widen(2, 2)).toEqual({ start: 1, end: 3 });
    expect(t.toRaw(1)).toBe(1);
    expect(t.toRaw(3)).toBe(10);
  });

  it('folds a unit that decodes to nothing into the next character', () => {
    // JS raw "ab\\\ncd" (line continuation) -> cooked "abcd"
    const t = new UnitTable();
    t.push(1, 1);
    t.push(1, 1);
    t.push(0, 2);
    t.push(1, 1);
    t.push(1, 1);
    t.finish();
    expect([0, 1, 2, 3, 4].map((i) => t.toRaw(i))).toEqual([0, 1, 2, 5, 6]);
  });

  it('composes a run table inside a container table', () => {
    // container raw 'a\\u0026b' (JS) cooked 'a&b'; run = cooked[1..3] = '&b'
    const container = new UnitTable();
    container.push(1, 1);
    container.push(1, 6);
    container.push(1, 1);
    container.finish();
    const run = new UnitTable();
    run.push(1, 1);
    run.push(1, 1);
    run.finish();
    const c = composeTables(run, 1, container);
    expect([0, 1, 2].map((i) => c.toRaw(i))).toEqual([0, 6, 7]);
    expect(c.widen(0, 1)).toEqual({ start: 0, end: 1 });
  });
});
