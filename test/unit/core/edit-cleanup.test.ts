import { describe, expect, it } from 'vitest';
import { changedSpan, cleanupCommit, smartPunctuation } from '@blueline/core/edit-cleanup';

describe('changedSpan (9.2 Committing an edit step 4)', () => {
  it('finds the minimal span from the common prefix and suffix', () => {
    expect(changedSpan('Hello world', 'Hello world')).toEqual({ start: 11, endBefore: 11, endAfter: 11 });
    expect(changedSpan('Hello world', 'Hello big world')).toEqual({ start: 6, endBefore: 6, endAfter: 10 });
    expect(changedSpan('Hello big world', 'Hello world')).toEqual({ start: 6, endBefore: 10, endAfter: 6 });
    expect(changedSpan('cat', 'cut')).toEqual({ start: 1, endBefore: 2, endAfter: 2 });
    expect(changedSpan('', 'x')).toEqual({ start: 0, endBefore: 0, endAfter: 1 });
    expect(changedSpan('x', '')).toEqual({ start: 0, endBefore: 1, endAfter: 0 });
  });

  it('never lets the prefix and suffix overlap (repeated characters)', () => {
    expect(changedSpan('aa', 'aaa')).toEqual({ start: 2, endBefore: 2, endAfter: 3 });
    expect(changedSpan('aaa', 'aa')).toEqual({ start: 2, endBefore: 3, endAfter: 2 });
    expect(changedSpan('abab', 'ab')).toEqual({ start: 2, endBefore: 4, endAfter: 2 });
  });

  it('never splits a surrogate pair at either end', () => {
    // Same high surrogate, different low: the prefix stops before the pair.
    expect(changedSpan('a\u{1F600}b', 'a\u{1F601}b')).toEqual({ start: 1, endBefore: 3, endAfter: 3 });
    // Same low surrogate, different high: the suffix starts after the pair.
    expect(changedSpan('\uD83D\uDE00', '\uD83E\uDE00')).toEqual({ start: 0, endBefore: 2, endAfter: 2 });
    // Inserting an astral character next to another one.
    const s = changedSpan('x\u{1F680}', 'x\u{1F680}\u{1F680}');
    expect(s.start % 1).toBe(0);
    expect('x\u{1F680}\u{1F680}'.slice(s.start, s.endAfter)).toBe('\u{1F680}');
  });
});

describe('cleanupCommit (9.2 Committing an edit step 3, 6.3)', () => {
  it('turns Chrome NBSPs into spaces (trailing and double spaces)', () => {
    expect(cleanupCommit('Hello', 'Hello\u00A0')).toBe('Hello ');
    expect(cleanupCommit('Hello world', 'Hello\u00A0 world')).toBe('Hello  world');
    expect(cleanupCommit('a b', 'a\u00A0')).toBe('a ');
    expect(cleanupCommit('Hello', '\u00A0Hello')).toBe(' Hello');
  });

  it("keeps the deck's own NBSP in the unchanged prefix and suffix", () => {
    expect(cleanupCommit('10\u00A0km', '10\u00A0km away')).toBe('10\u00A0km away');
    expect(cleanupCommit('Price:\u00A0$5', 'Cost:\u00A0$5')).toBe('Cost:\u00A0$5');
  });

  it('keeps an NBSP the old text had at the same position relative to the prefix or the suffix', () => {
    // Changed region "1\u00A0000" → "2\u00A0500": the NBSP sits at the same offset from the prefix end.
    expect(cleanupCommit('x 1\u00A0000 y', 'x 2\u00A0500 y')).toBe('x 2\u00A0500 y');
    // Same offset from the suffix start, though the region grew.
    expect(cleanupCommit('[a\u00A0b]', '[xyz\u00A0q]')).toBe('[xyz\u00A0q]');
    // A new NBSP elsewhere in the same region still becomes a space.
    expect(cleanupCommit('[a\u00A0b]', '[x\u00A0yy\u00A0zz]')).toBe('[x\u00A0yy zz]');
    // ...while one at the same offset from the suffix is kept, as the rule says.
    expect(cleanupCommit('[a\u00A0b]', '[x\u00A0y\u00A0z]')).toBe('[x\u00A0y\u00A0z]');
  });

  it('removes U+200B and U+FEFF the browser inserted, and keeps the ones the deck had', () => {
    expect(cleanupCommit('Hello', 'Hel\u200Blo')).toBe('Hello');
    expect(cleanupCommit('Hello', '\uFEFFHello world')).toBe('Hello world');
    expect(cleanupCommit('long\u200Bword', 'long\u200Bword!')).toBe('long\u200Bword!');
    expect(cleanupCommit('a\u200Bb', 'a\u200B\u200Bb')).toBe('a\u200Bb');
  });

  it('turns pasted or dictated line breaks (CRLF, CR, LF) into single spaces', () => {
    expect(cleanupCommit('Hello', 'Hello\r\nworld')).toBe('Hello world');
    expect(cleanupCommit('Hello', 'Hello\rworld')).toBe('Hello world');
    expect(cleanupCommit('Hello', 'Hello\nworld')).toBe('Hello world');
    expect(cleanupCommit('Hello', 'Hello\r\n\r\nworld')).toBe('Hello  world');
    expect(cleanupCommit('ab', 'a\n\r\nb')).toBe('a  b');
  });

  it('leaves line breaks the run already had (a text node that spans source lines)', () => {
    expect(cleanupCommit('one\n    two', 'one\n    two three')).toBe('one\n    two three');
    expect(cleanupCommit('one\ntwo', 'uno\ntwo')).toBe('uno\ntwo');
    // A CR typed right before an existing LF: only the CR is new.
    expect(cleanupCommit('a\nb', 'a\r\nb')).toBe('a \nb');
  });

  it('returns a pure deletion unchanged, and text with nothing to clean as it was', () => {
    expect(cleanupCommit('a\u00A0b c', 'a\u00A0b')).toBe('a\u00A0b');
    expect(cleanupCommit('Hello', 'Hello there')).toBe('Hello there');
    expect(cleanupCommit('Hello', 'Hello')).toBe('Hello');
  });

  it('keeps tabs, emoji and other characters', () => {
    expect(cleanupCommit('a', 'a\t\u{1F680} & <b>')).toBe('a\t\u{1F680} & <b>');
  });

  it('keeps the line breaks and NBSPs a run had between two changes made in one commit', () => {
    // A <pre> run changed before and after its own line break: the region between them is untouched.
    expect(cleanupCommit('one\ntwo', 'one!\ntwo!')).toBe('one!\ntwo!');
    expect(cleanupCommit('a\r\nb', 'A\r\nB')).toBe('A\r\nB');
    expect(cleanupCommit('10\u00A0km to go', '12\u00A0km to run')).toBe('12\u00A0km to run');
    expect(cleanupCommit('x\u200By', 'X\u200BY')).toBe('X\u200BY');
    // When the edit adds one on top of those the run had, the diff of the region still tells the run's own from the
    // added one (finding 23): the <pre> keeps its line break, and only the pasted one becomes a space.
    expect(cleanupCommit('one\ntwo', 'one!\ntw\no!')).toBe('one!\ntw o!');
    expect(cleanupCommit('a\u00A0b c', 'A\u00A0b\u00A0C')).toBe('A\u00A0b C');
  });
});

describe('smartPunctuation (6.3)', () => {
  it('converts typed straight quotes to match a run that already uses curly ones', () => {
    expect(smartPunctuation('\u201CHello\u201D', '\u201CHello\u201D and "bye"')).toBe('\u201CHello\u201D and \u201Cbye\u201D');
    expect(smartPunctuation('It\u2019s here', "It\u2019s here, isn't it 'now'")).toBe('It\u2019s here, isn\u2019t it \u2018now\u2019');
  });

  it('converts each kind only if the run uses that kind', () => {
    expect(smartPunctuation('\u201CQ\u201D', '\u201CQ\u201D it\'s')).toBe('\u201CQ\u201D it\'s');
    expect(smartPunctuation('it\u2019s', 'it\u2019s "x"')).toBe('it\u2019s "x"');
  });

  it('changes nothing in a run with only straight quotes, and leaves untouched text alone', () => {
    expect(smartPunctuation('say "hi"', 'say "hi" now')).toBe('say "hi" now');
    expect(smartPunctuation('\u201Cx\u201D "old"', '\u201Cx\u201D "old" new')).toBe('\u201Cx\u201D "old" new');
  });

  it('leaves a straight quote the run had between two changes alone', () => {
    expect(smartPunctuation('\u201Cx\u201D a "b" c', '\u201Cx\u201D A "b" C')).toBe('\u201Cx\u201D A "b" C');
  });

  it('opens after whitespace, brackets, dashes and at the start; closes after letters and punctuation', () => {
    expect(smartPunctuation('\u201C\u201D', '"a" ("b")\u2014"c".')).toBe('\u201Ca\u201D (\u201Cb\u201D)\u2014\u201Cc\u201D.');
  });
});
