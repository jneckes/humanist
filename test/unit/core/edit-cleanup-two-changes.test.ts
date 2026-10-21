// The commit clean-up when one commit changes a run in two places (SPEC 9.2 Committing an edit step 3; 6.3 Ending
// an edit and Smart punctuation: "Nothing else changes"; review finding 23, lead decision E-12). The changed region
// then spans the untouched text between the two changes; a character diff of that region decides what the commit
// introduced, so the deck's own NBSPs, zero-width spaces, line breaks and straight quotes there stay as they are
// even when the same commit adds one more of them, and only the characters the author put there are cleaned.

import { describe, expect, it } from 'vitest';
import { cleanupCommit, smartPunctuation } from '@blueline/core/edit-cleanup';
import { commitField } from '@blueline/core/edit-commit';

const NB = '\u00A0';
const ZW = '\u200B';

/** commitField on a field that is one run, the caret in it, smart punctuation on: the overlay's path. */
function commitOne(before: string, after: string): string {
  const res = commitField({ before, after, runs: [{ runId: 'h:bl-1:0', start: 0, end: before.length, value: before }], caretRunId: 'h:bl-1:0' }, { smartPunctuation: true });
  if (res.kind !== 'edit') throw new Error(`not an edit: ${JSON.stringify(res)}`);
  return res.afterText;
}

describe("the deck's own characters between two changes stay when the commit adds one more", () => {
  it('an NBSP the run had stays; the NBSP the commit added becomes a space', () => {
    // "Delivery" -> "Deliveries", and " soon" plus an NBSP typed at the end (a paste or Option+Space).
    expect(cleanupCommit(`Delivery in 10${NB}km`, `Deliveries in 10${NB}km soon${NB}`)).toBe(`Deliveries in 10${NB}km soon `);
    expect(cleanupCommit(`Price 10${NB}km away`, `Prices 10${NB}km away${NB}`)).toBe(`Prices 10${NB}km away `);
    expect(cleanupCommit(`one${NB}two three`, `One!${NB}two three ${NB}four`)).toBe(`One!${NB}two three  four`);
    // A pasted ", ready in 5<NBSP>min" at the end and a second change at the start.
    expect(cleanupCommit(`Delivery in 10${NB}km`, `Deliveries in 10${NB}km, ready in 5${NB}min`)).toBe(`Deliveries in 10${NB}km, ready in 5 min`);
    expect(commitOne(`Delivery in 10${NB}km`, `Deliveries in 10${NB}km soon${NB}`)).toBe(`Deliveries in 10${NB}km soon `);
  });

  it("a straight quote the run had stays straight; only the typed ones are curled", () => {
    const before = '\u201CA\u201D and "b" end';
    expect(smartPunctuation(before, '\u201CAA\u201D and "b" end "c"')).toBe('\u201CAA\u201D and "b" end \u201Cc\u201D');
    expect(commitOne(before, '\u201CAA\u201D and "b" end "c"')).toBe('\u201CAA\u201D and "b" end \u201Cc\u201D');
    // Single quotes alike.
    expect(smartPunctuation('It\u2019s a \'b\' c', 'It\u2019s AA \'b\' c \'dd\'')).toBe('It\u2019s AA \'b\' c \u2018dd\u2019');
  });

  it('a line break the run had (a <pre>) stays; a pasted one becomes a space', () => {
    expect(cleanupCommit('one\ntwo', 'one!\ntw\no!')).toBe('one!\ntw o!');
    expect(cleanupCommit('line1\nline2', 'lines1\nline2 x\r\ny')).toBe('lines1\nline2 x y');
    expect(cleanupCommit('a\r\nb', 'AA\r\nbB\r\ncc')).toBe('AA\r\nbB cc');
  });

  it('a zero-width space the run had stays; the one the browser inserted is dropped', () => {
    expect(cleanupCommit(`long${ZW}word here`, `longer${ZW}word here${ZW}!`)).toBe(`longer${ZW}word here!`);
  });

  it('in a long run, every NBSP between two far-apart changes stays', () => {
    const body = `word${NB}`.repeat(4000);
    // The first change shortens the start, so every NBSP after it moves; the second adds one NBSP at the end.
    const out = cleanupCommit(`Start ${body}end`, `Go ${body}end${NB}`);
    expect(out).toBe(`Go ${body}end `);
  });
});

describe('the opposite case: an NBSP the commit added, while it replaced one the run had', () => {
  it('the added NBSP becomes a space', () => {
    // The deck's NBSP replaced by a space, and " now" pasted with an NBSP at the end.
    expect(cleanupCommit(`Price 10${NB}km away`, `Price 10 km away${NB}now`)).toBe('Price 10 km away now');
    expect(commitOne(`Price 10${NB}km away`, `Price 10 km away${NB}now`)).toBe('Price 10 km away now');
  });
});

describe('beyond the diff size cap: never rewrite a character class the old region had', () => {
  it('keeps every NBSP when the old region had one, and still removes what the region never held', () => {
    const before = `[${'a'.repeat(3000)}${NB}]`;
    const after = `{${'b'.repeat(3000)}${NB}${NB}${ZW}}`;
    expect(cleanupCommit(before, after)).toBe(`{${'b'.repeat(3000)}${NB}${NB}}`);
  });
});
