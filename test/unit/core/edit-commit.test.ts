// core/edit-commit: the commit path of a typed edit (9.2 Committing an edit steps 3–4, Strategy 2 step 4; 6.3;
// P2-8). commitField is what the deck preload's field and the fuzz harnesses call; liftToRun / liftPick map a
// picked candidate's node edit to its run.
import { describe, expect, it } from 'vitest';
import { commitField, isWellFormedText, liftPick, liftToRun, pickKindFor, VERBATIM_WHYS, type FieldRun } from '@blueline/core/edit-commit';
import {
  candidateContext,
  COMMIT_KINDS,
  EDIT_LIMITS,
  EDIT_TOKEN_RE,
  EditDeckToMain,
  MainToDeckEdit,
  PICKER_CONTEXT,
  REFUSAL_CODES,
  RUN_ID_RE,
  VERSION_RE,
} from '@blueline/core/ipc-edit';

const SMART = { smartPunctuation: true };
const PLAIN = { smartPunctuation: false };

/** A field made of runs laid end to end (gaps given as plain strings), with each run's offsets. */
function field(...parts: (string | [string, string])[]): { text: string; runs: FieldRun[] } {
  let text = '';
  const runs: FieldRun[] = [];
  for (const p of parts) {
    if (typeof p === 'string') text += p;
    else {
      runs.push({ runId: p[0], start: text.length, end: text.length + p[1].length, value: p[1] });
      text += p[1];
    }
  }
  return { text, runs };
}

const commit = (f: { text: string; runs: FieldRun[] }, after: string, caret: string | null, opts = PLAIN) =>
  commitField({ before: f.text, after, runs: f.runs, caretRunId: caret }, opts);

describe('commitField: one run (9.2 step 4)', () => {
  const one = field(['h:bl-1:0', 'Hello world']);

  it('an edit inside the run gives the run\'s whole text before and after', () => {
    expect(commit(one, 'Hello big world', 'h:bl-1:0')).toEqual({ kind: 'edit', runId: 'h:bl-1:0', beforeText: 'Hello world', afterText: 'Hello big world' });
    // The caret is not needed when only one run can hold the change.
    expect(commit(one, 'Hello big world', null)).toMatchObject({ kind: 'edit', afterText: 'Hello big world' });
    expect(commit(one, 'Jello world', null)).toMatchObject({ kind: 'edit', afterText: 'Jello world' });
    expect(commit(one, 'Hello world!', null)).toMatchObject({ kind: 'edit', afterText: 'Hello world!' });
  });

  it('whole-run replacement', () => {
    expect(commit(one, 'Goodbye', null)).toEqual({ kind: 'edit', runId: 'h:bl-1:0', beforeText: 'Hello world', afterText: 'Goodbye' });
  });

  it('no change, or a change the clean-up removes, is a no-op', () => {
    expect(commit(one, 'Hello world', null)).toEqual({ kind: 'noop' });
    expect(commit(one, 'Hello​ world', null)).toEqual({ kind: 'noop' });
    expect(commit(one, '﻿Hello world', null)).toEqual({ kind: 'noop' });
  });

  it("Chrome's NBSP becomes a space; the deck's own NBSP stays", () => {
    expect(commit(one, 'Hello world ', null)).toMatchObject({ kind: 'edit', afterText: 'Hello world ' });
    expect(commit(one, 'Hello  world', null)).toMatchObject({ kind: 'edit', afterText: 'Hello  world' });
    const nb = field(['h:bl-1:0', '10 km']);
    expect(commit(nb, '10 km away', null)).toMatchObject({ kind: 'edit', afterText: '10 km away' });
  });

  it('U+200B and U+FEFF the browser inserted are dropped', () => {
    expect(commit(one, 'Hello​ big world', null)).toMatchObject({ kind: 'edit', afterText: 'Hello big world' });
    expect(commit(one, 'Hello big﻿ world', null)).toMatchObject({ kind: 'edit', afterText: 'Hello big world' });
  });

  it('pasted or dictated CRLF, CR and LF become spaces', () => {
    expect(commit(one, 'Hello world\r\nagain', null)).toMatchObject({ afterText: 'Hello world again' });
    expect(commit(one, 'Hello world\ragain', null)).toMatchObject({ afterText: 'Hello world again' });
    expect(commit(one, 'Hello world\nagain', null)).toMatchObject({ afterText: 'Hello world again' });
    // The pasted breaks replace the space between the words: two breaks, two spaces.
    expect(commit(one, 'Hello\r\n\r\nworld', null)).toMatchObject({ afterText: 'Hello  world' });
  });

  it('the field emptied, or left only white space, is a verbatim note', () => {
    expect(commit(one, '', null)).toEqual({ kind: 'verbatim', before: 'Hello world', after: '', why: 'emptied' });
    expect(commit(one, '  \t', null)).toEqual({ kind: 'verbatim', before: 'Hello world', after: '  \t', why: 'emptied' });
    // A pasted line break alone becomes a space: still only white space.
    expect(commit(one, '\r\n', null)).toMatchObject({ kind: 'verbatim', why: 'emptied' });
  });

  it('emoji and surrogate pairs are never split', () => {
    const e = field(['h:bl-1:0', 'Go \u{1F680} now']);
    expect(commit(e, 'Go \u{1F681} now', null)).toMatchObject({ kind: 'edit', afterText: 'Go \u{1F681} now' });
    expect(commit(e, 'Go  now', null)).toMatchObject({ kind: 'edit', afterText: 'Go  now' });
    expect(commit(e, 'Go \u{1F680}\u{1F680} now', null)).toMatchObject({ kind: 'edit', afterText: 'Go \u{1F680}\u{1F680} now' });
    const zwj = field(['h:bl-1:0', '\u{1F468}‍\u{1F469}']);
    expect(commit(zwj, '\u{1F468}‍\u{1F469}‍\u{1F467}', null)).toMatchObject({ afterText: '\u{1F468}‍\u{1F469}‍\u{1F467}' });
  });
});

describe('commitField: several runs (inline markup, 6.3)', () => {
  // <p>Hello <b>bold</b> world</p>: three runs that cover the field.
  const three = field(['h:bl-1:0', 'Hello '], ['h:bl-2:0', 'bold'], ['h:bl-1:1', ' world']);

  it('a change inside one run goes to that run, whatever the caret says', () => {
    expect(commit(three, 'Hello boXld world', null)).toEqual({ kind: 'edit', runId: 'h:bl-2:0', beforeText: 'bold', afterText: 'boXld' });
    expect(commit(three, 'Hello boXld world', 'h:bl-1:0')).toMatchObject({ runId: 'h:bl-2:0', afterText: 'boXld' });
    expect(commit(three, 'Hello bold wide world', 'h:bl-1:1')).toEqual({ kind: 'edit', runId: 'h:bl-1:1', beforeText: ' world', afterText: ' wide world' });
    // " wide" typed at the end of "bold" gives the same text: with the caret there, that is the reading taken.
    expect(commit(three, 'Hello bold wide world', 'h:bl-2:0')).toEqual({ kind: 'edit', runId: 'h:bl-2:0', beforeText: 'bold', afterText: 'bold wide' });
    expect(commit(three, 'Hello bold wide world', null)).toMatchObject({ kind: 'verbatim', why: 'boundary' });
    expect(commit(three, 'Hullo bold world', 'h:bl-1:1')).toMatchObject({ runId: 'h:bl-1:0', afterText: 'Hullo ' });
  });

  it('an insertion at a run boundary goes to the run that held the caret (each boundary, each caret)', () => {
    // Boundary 6: "Hello |bold".
    const at6 = 'Hello Xbold world';
    expect(commit(three, at6, 'h:bl-1:0')).toEqual({ kind: 'edit', runId: 'h:bl-1:0', beforeText: 'Hello ', afterText: 'Hello X' });
    expect(commit(three, at6, 'h:bl-2:0')).toEqual({ kind: 'edit', runId: 'h:bl-2:0', beforeText: 'bold', afterText: 'Xbold' });
    // Boundary 10: "bold| world".
    const at10 = 'Hello boldX world';
    expect(commit(three, at10, 'h:bl-2:0')).toEqual({ kind: 'edit', runId: 'h:bl-2:0', beforeText: 'bold', afterText: 'boldX' });
    expect(commit(three, at10, 'h:bl-1:1')).toEqual({ kind: 'edit', runId: 'h:bl-1:1', beforeText: ' world', afterText: 'X world' });
  });

  it('an insertion at a boundary with no caret, or a caret in neither run, is a verbatim note', () => {
    expect(commit(three, 'Hello Xbold world', null)).toEqual({ kind: 'verbatim', before: 'Hello bold world', after: 'Hello Xbold world', why: 'boundary' });
    expect(commit(three, 'Hello boldX world', 'h:bl-1:0')).toMatchObject({ kind: 'verbatim', why: 'boundary' });
    expect(commit(three, 'Hello boldX world', 'h:unknown')).toMatchObject({ kind: 'verbatim', why: 'boundary' });
  });

  it('an insertion at the start or end of the field has only one run to go to', () => {
    expect(commit(three, '>Hello bold world', null)).toMatchObject({ kind: 'edit', runId: 'h:bl-1:0', afterText: '>Hello ' });
    expect(commit(three, 'Hello bold world<', null)).toMatchObject({ kind: 'edit', runId: 'h:bl-1:1', afterText: ' world<' });
  });

  it('text equal to its neighbours: every equivalent place is considered, and the caret run takes it', () => {
    // "ab|bc": typing "b" at the end of "ab" gives the same text as typing it at the start of "bc".
    const ab = field(['h:bl-1:0', 'ab'], ['h:bl-2:0', 'bc']);
    expect(commit(ab, 'abbbc', 'h:bl-1:0')).toEqual({ kind: 'edit', runId: 'h:bl-1:0', beforeText: 'ab', afterText: 'abb' });
    expect(commit(ab, 'abbbc', 'h:bl-2:0')).toEqual({ kind: 'edit', runId: 'h:bl-2:0', beforeText: 'bc', afterText: 'bbc' });
    expect(commit(ab, 'abbbc', null)).toMatchObject({ kind: 'verbatim', why: 'boundary' });
    // Deleting one "b" likewise.
    expect(commit(ab, 'abc', 'h:bl-1:0')).toEqual({ kind: 'edit', runId: 'h:bl-1:0', beforeText: 'ab', afterText: 'a' });
    expect(commit(ab, 'abc', 'h:bl-2:0')).toEqual({ kind: 'edit', runId: 'h:bl-2:0', beforeText: 'bc', afterText: 'c' });
    // An emoji typed next to the same emoji in the other run.
    const em = field(['h:bl-1:0', 'go \u{1F680}'], ['h:bl-2:0', '\u{1F680} up']);
    expect(commit(em, 'go \u{1F680}\u{1F680}\u{1F680} up', 'h:bl-1:0')).toMatchObject({ runId: 'h:bl-1:0', afterText: 'go \u{1F680}\u{1F680}' });
    expect(commit(em, 'go \u{1F680}\u{1F680}\u{1F680} up', 'h:bl-2:0')).toMatchObject({ runId: 'h:bl-2:0', afterText: '\u{1F680}\u{1F680} up' });
  });

  it('a deletion or replacement across runs is a verbatim note', () => {
    expect(commit(three, 'Hellold world', 'h:bl-1:0')).toEqual({ kind: 'verbatim', before: 'Hello bold world', after: 'Hellold world', why: 'across-runs' });
    expect(commit(three, 'Hello boXorld', 'h:bl-2:0')).toMatchObject({ kind: 'verbatim', why: 'across-runs' });
  });

  it('a run emptied, or left only white space, is structural: a verbatim note (6.3)', () => {
    expect(commit(three, 'Hello  world', 'h:bl-2:0')).toEqual({ kind: 'verbatim', before: 'Hello bold world', after: 'Hello  world', why: 'run-emptied' });
    expect(commit(three, 'Hello    world', 'h:bl-2:0')).toMatchObject({ kind: 'verbatim', why: 'run-emptied' });
    expect(commit(three, 'bold world', 'h:bl-1:0')).toMatchObject({ kind: 'verbatim', why: 'run-emptied' });
  });

  it('a pasted line break at a run boundary goes to the caret run as a space', () => {
    expect(commit(three, 'Hello bold\r\n world', 'h:bl-2:0')).toMatchObject({ runId: 'h:bl-2:0', afterText: 'bold ' });
  });

  it('accepts runs in any order and the same run twice (two text nodes of one run)', () => {
    const shuffled = { text: three.text, runs: [three.runs[2], three.runs[0], three.runs[1]] };
    expect(commit(shuffled, 'Hello bolder world', 'h:bl-2:0')).toMatchObject({ runId: 'h:bl-2:0', afterText: 'bolder' });
    const twice = field(['l:0:0', 'Owner'], ' / ', ['l:0:0', 'Owner']);
    expect(commit(twice, 'Owners / Owner', 'l:0:0')).toEqual({ kind: 'edit', runId: 'l:0:0', beforeText: 'Owner', afterText: 'Owners' });
  });
});

describe('commitField: unmapped text in the field', () => {
  // <li><b>One</b> <i>Two</i></li>: a white-space text node between the runs.
  const gap = field(['h:bl-2:0', 'One'], ' ', ['h:bl-3:0', 'Two']);

  it('a change in text that is no run is a verbatim note', () => {
    expect(commit(gap, 'One-Two', null)).toEqual({ kind: 'verbatim', before: 'One Two', after: 'One-Two', why: 'outside-runs' });
    const none = { text: 'Computed 42', runs: [] };
    expect(commit(none, 'Computed 43', null)).toMatchObject({ kind: 'verbatim', why: 'outside-runs' });
    expect(commit({ text: '', runs: [] }, 'New', null)).toMatchObject({ kind: 'verbatim', why: 'outside-runs' });
  });

  it('an insertion where a run meets unmapped text needs the caret', () => {
    expect(commit(gap, 'One! Two', 'h:bl-2:0')).toMatchObject({ kind: 'edit', runId: 'h:bl-2:0', afterText: 'One!' });
    expect(commit(gap, 'One! Two', null)).toMatchObject({ kind: 'verbatim', why: 'boundary' });
    expect(commit(gap, 'One !Two', 'h:bl-3:0')).toMatchObject({ kind: 'edit', runId: 'h:bl-3:0', afterText: '!Two' });
  });
});

describe('commitField: smart punctuation (6.3)', () => {
  it('converts straight quotes typed into a run that already uses curly ones, only when on', () => {
    const q = field(['h:bl-1:0', 'It’s “fine”']);
    expect(commit(q, 'It’s “fine”, isn\'t it "now"', null, SMART)).toMatchObject({
      afterText: 'It’s “fine”, isn’t it “now”',
    });
    expect(commit(q, 'It’s “fine” "now"', null, PLAIN)).toMatchObject({ afterText: 'It’s “fine” "now"' });
  });

  it('the run decides, not the rest of the field', () => {
    const f = field(['h:bl-1:0', '“Quoted” '], ['h:bl-2:0', 'plain']);
    expect(commit(f, '“Quoted” plain "x"', 'h:bl-2:0', SMART)).toMatchObject({ runId: 'h:bl-2:0', afterText: 'plain "x"' });
    expect(commit(f, '“Quoted” "y" plain', 'h:bl-1:0', SMART)).toMatchObject({ runId: 'h:bl-1:0', afterText: '“Quoted” “y” ' });
  });

  it('a quote at the start of a run opens or closes by the character before it in the field', () => {
    const spaced = field(['h:bl-1:0', 'Say '], ['h:bl-2:0', '‘hi’']);
    expect(commit(spaced, "Say '‘hi’", 'h:bl-2:0', SMART)).toMatchObject({ runId: 'h:bl-2:0', afterText: '‘‘hi’' });
    const tight = field(['h:bl-1:0', 'Say'], ['h:bl-2:0', '‘hi’']);
    expect(commit(tight, "Say'‘hi’", 'h:bl-2:0', SMART)).toMatchObject({ runId: 'h:bl-2:0', afterText: '’‘hi’' });
    // The character before is itself a curly quote: it decides opening, not whether the run uses curly quotes.
    const after = field(['h:bl-1:0', '“'], ['h:bl-2:0', 'x']);
    expect(commit(after, '“"x', 'h:bl-2:0', SMART)).toMatchObject({ runId: 'h:bl-2:0', afterText: '"x' });
  });

  it('a straight quote typed over the same curly quote is a no-op', () => {
    const q = field(['h:bl-1:0', 'a” b “']);
    expect(commit(q, 'a" b “', null, SMART)).toEqual({ kind: 'noop' });
  });

  it('a verbatim note holds the text cleaned and with the quotes smart punctuation would give', () => {
    const f = field(['h:bl-1:0', '“A” '], ['h:bl-2:0', 'B']);
    expect(commit(f, '"Z" ', 'h:bl-1:0', SMART)).toEqual({ kind: 'verbatim', before: '“A” B', after: '“Z” ', why: 'across-runs' });
  });
});

describe('commitField: input that does not fit', () => {
  const one = field(['h:bl-1:0', 'Hello']);

  it('runs that do not fit the field are invalid', () => {
    const bad = (runs: FieldRun[]) => commitField({ before: 'Hello', after: 'Hello!', runs, caretRunId: null }, PLAIN);
    expect(bad([{ runId: 'h:bl-1:0', start: 0, end: 5, value: 'Jello' }])).toMatchObject({ kind: 'verbatim', why: 'invalid' });
    expect(bad([{ runId: 'h:bl-1:0', start: 0, end: 9, value: 'Hello' }])).toMatchObject({ why: 'invalid' });
    expect(bad([{ runId: 'h:bl-1:0', start: 0, end: 3, value: 'Hel' }, { runId: 'h:bl-2:0', start: 2, end: 5, value: 'llo' }])).toMatchObject({ why: 'invalid' });
    expect(bad([{ runId: '', start: 0, end: 5, value: 'Hello' }])).toMatchObject({ why: 'invalid' });
    expect(bad([{ runId: 'h:bl-1:0', start: 2, end: 2, value: '' }])).toMatchObject({ why: 'invalid' });
    expect(bad([{ runId: 'h:bl-1:0', start: 0.5, end: 5, value: 'Hello' }])).toMatchObject({ why: 'invalid' });
    // A run boundary inside a surrogate pair.
    const pair = commitField({ before: 'a\u{1F680}', after: 'a\u{1F680}!', runs: [{ runId: 'x', start: 0, end: 2, value: 'a\uD83D' }], caretRunId: null }, PLAIN);
    expect(pair).toMatchObject({ why: 'invalid' });
  });

  it('a lone surrogate is invalid, and the note holds U+FFFD in its place (a note cannot hold one)', () => {
    expect(commit(one, 'Hel\uD83Dlo', null)).toEqual({ kind: 'verbatim', before: 'Hello', after: 'Hel�lo', why: 'invalid' });
    expect(isWellFormedText('a\u{1F680}b')).toBe(true);
    expect(isWellFormedText('a\uDE80b')).toBe(false);
    expect(isWellFormedText('a\uD83D')).toBe(false);
  });
});

describe('liftToRun (9.2 Strategy 2 step 4; P2-8)', () => {
  it('substring: the node\'s text occurs once in the run', () => {
    expect(liftToRun('Revenue grew 12% in Q3', 'grew 12%', 'grew 14%', 'substring')).toEqual({
      beforeText: 'Revenue grew 12% in Q3',
      afterText: 'Revenue grew 14% in Q3',
    });
    expect(liftToRun('Plan: next steps', 'next steps', 'next three steps', 'substring')).toMatchObject({ afterText: 'Plan: next three steps' });
  });

  it('substring: absent, twice, overlapping twice, or empty is null', () => {
    expect(liftToRun('abc', 'x', 'y', 'substring')).toBeNull();
    expect(liftToRun('to be or not to be', 'to be', 'to see', 'substring')).toBeNull();
    expect(liftToRun('aaa', 'aa', 'ab', 'substring')).toBeNull();
    expect(liftToRun('abc', '', 'x', 'substring')).toBeNull();
  });

  const run = 'Hello\n      big   world';
  it('normalized: edits inside words and at word edges map through the white space', () => {
    expect(liftToRun(run, 'Hello big world', 'Hello bigger world', 'normalized')).toEqual({ beforeText: run, afterText: 'Hello\n      bigger   world' });
    expect(liftToRun(run, 'Hello big world', 'Hello, big world', 'normalized')).toMatchObject({ afterText: 'Hello,\n      big   world' });
    expect(liftToRun(run, 'Hello big world', 'Hello very big world', 'normalized')).toMatchObject({ afterText: 'Hello\n      very big   world' });
    expect(liftToRun(run, 'Hello big world', 'Hello world', 'normalized')).toMatchObject({ afterText: 'Hello\n      world' });
    expect(liftToRun(run, 'Hello big world', 'Hello bigworld', 'normalized')).toMatchObject({ afterText: 'Hello\n      bigworld' });
    expect(liftToRun(run, 'Hello big world', 'Hi big world', 'normalized')).toMatchObject({ afterText: 'Hi\n      big   world' });
    expect(liftToRun(run, 'Hello big world', 'Hello big world!', 'normalized')).toMatchObject({ afterText: 'Hello\n      big   world!' });
  });

  it('normalized: leading and trailing white space the node does not have', () => {
    const padded = '\n  Title text\n';
    expect(liftToRun(padded, 'Title text', 'New title text', 'normalized')).toEqual({ beforeText: padded, afterText: '\n  New title text\n' });
    expect(liftToRun(padded, 'Title text', 'Title text!', 'normalized')).toMatchObject({ afterText: '\n  Title text!\n' });
    expect(liftToRun('Title', '  Title', 'X  Title', 'normalized')).toBeNull(); // would add a space the run never had
    expect(liftToRun('Title', '  Title', '  XTitle', 'normalized')).toMatchObject({ afterText: 'XTitle' });
  });

  it('normalized: a position strictly inside white space that differs is not exact', () => {
    expect(liftToRun('a\n\nb', 'a  b', 'a X b', 'normalized')).toBeNull();
    // The same white space in both maps exactly.
    expect(liftToRun('x a  b', 'x\na  b', 'x\na X b', 'normalized')).toMatchObject({ afterText: 'x a X b' });
  });

  it('normalized: NFC differences are exact only at word edges', () => {
    const decomposed = 'Café open';
    expect(liftToRun(decomposed, 'Café open', 'Café! open', 'normalized')).toEqual({ beforeText: decomposed, afterText: 'Café! open' });
    expect(liftToRun(decomposed, 'Café open', 'Café now open', 'normalized')).toMatchObject({ afterText: 'Café now open' });
    expect(liftToRun(decomposed, 'Café open', 'Cxfé open', 'normalized')).toBeNull();
  });

  it('normalized: different words, or a different count, is null', () => {
    expect(liftToRun('Hello world', 'Hello there', 'Hello there!', 'normalized')).toBeNull();
    expect(liftToRun('Hello big world', 'Hello world', 'Hello world!', 'normalized')).toBeNull();
    expect(liftToRun('   ', ' ', 'x', 'normalized')).toBeNull();
    expect(liftToRun('a', 'a', 'b', 'bogus' as 'normalized')).toBeNull();
  });
});

describe('liftPick and pickKindFor (P2-8)', () => {
  it('an equal pick is the run\'s own text', () => {
    expect(liftPick('Owner', { kind: 'equal', nodeBefore: 'Owner', nodeAfter: 'Owners' })).toEqual({ beforeText: 'Owner', afterText: 'Owners' });
    expect(liftPick('Owner', { kind: 'equal', nodeBefore: 'Owner ', nodeAfter: 'Owners' })).toBeNull();
  });

  it('substring and normalized picks are lifted', () => {
    expect(liftPick('Revenue grew', { kind: 'substring', nodeBefore: 'grew', nodeAfter: 'fell' })).toEqual({ beforeText: 'Revenue grew', afterText: 'Revenue fell' });
    expect(liftPick('A\n  B', { kind: 'normalized', nodeBefore: 'A B', nodeAfter: 'A C' })).toEqual({ beforeText: 'A\n  B', afterText: 'A\n  C' });
    expect(liftPick('A', { kind: 'other' as 'equal', nodeBefore: 'A', nodeAfter: 'B' })).toBeNull();
  });

  it('maps match reasons to pick kinds; split and short are never offered', () => {
    for (const r of ['duplicate', 'key', 'shadow', 'stamp-other'] as const) expect(pickKindFor(r)).toBe('equal');
    expect(pickKindFor('not-equal')).toBe('normalized');
    expect(pickKindFor('substring')).toBe('substring');
    for (const r of ['split', 'short', 'computed', 'no-match', 'unaligned', 'placeholder', 'multi-literal', 'not-utf8'] as const) expect(pickKindFor(r)).toBeNull();
    expect(pickKindFor(undefined)).toBeNull();
  });
});

describe('ipc-edit: formats, limits and the picker context (P2-8)', () => {
  it('channel names follow the plan, and the format checks accept what the map makes', () => {
    expect(EditDeckToMain).toEqual({ begin: 'bl:edit:begin', commit: 'bl:edit:commit', candidates: 'bl:edit:candidates', undo: 'bl:edit:undo', busy: 'bl:edit:busy' });
    expect(MainToDeckEdit).toEqual({ candidates: 'bl:edit:candidates', result: 'bl:edit:result', applied: 'bl:edit:applied' });
    for (const id of ['h:bl-1:0', 'h:bl-123456789:42', 'l:0:0', 'l:1234567:999999']) expect(RUN_ID_RE.test(id)).toBe(true);
    for (const id of ['h:bl-1', 'h:x:0', 'l:a:0', 'h:bl-1:0 ', 'H:bl-1:0', 'l:-1:0', 'h:bl-1:0\n']) expect(RUN_ID_RE.test(id)).toBe(false);
    expect(VERSION_RE.test('a'.repeat(64))).toBe(true);
    expect(VERSION_RE.test('A'.repeat(64))).toBe(false);
    expect(EDIT_TOKEN_RE.test('tok_12345')).toBe(true);
    expect(EDIT_TOKEN_RE.test('short')).toBe(false);
    expect(REFUSAL_CODES).toHaveLength(13);
    expect(COMMIT_KINDS).toEqual(['edit', 'verbatim', 'noop']);
    expect(VERBATIM_WHYS).toEqual(['emptied', 'run-emptied', 'across-runs', 'outside-runs', 'boundary', 'invalid']);
  });

  it('candidateContext: ±40 source characters on one line, cut with an ellipsis', () => {
    const src = 'a'.repeat(100) + 'RUN TEXT' + '\n' + 'b'.repeat(100);
    const start = 100;
    const end = 108;
    expect(candidateContext(src, start, end)).toBe('\u2026' + 'a'.repeat(PICKER_CONTEXT) + 'RUN TEXT' + ' ' + 'b'.repeat(PICKER_CONTEXT - 1) + '\u2026');
    expect(candidateContext('<p>Owner</p>', 3, 8)).toBe('<p>Owner</p>');
    expect(candidateContext('x', 2, 1)).toBe('');
    expect(candidateContext('x', 0, 5)).toBe('');
  });

  it('candidateContext: a long run is shortened in the middle, never past the limit or through a surrogate pair', () => {
    const run = '\u4E2D'.repeat(3000);
    const src = '\u{1F680}'.repeat(30) + run + '\u{1F680}'.repeat(30);
    const c = candidateContext(src, 60, 60 + run.length);
    expect(new TextEncoder().encode(c).length).toBeLessThanOrEqual(EDIT_LIMITS.context);
    expect(isWellFormedText(c)).toBe(true);
    expect(c).toContain('\u2026');
    // A context edge that would fall between the halves of a pair moves outward.
    const head = 'ab' + '\u{1F680}'.repeat(20) + 'c' + 'RUN'; // 40 before the run starts on a low surrogate
    expect(candidateContext(head, 43, 46)).toBe('\u2026' + '\u{1F680}'.repeat(20) + 'cRUN');
    const tail = 'RUNc' + '\u{1F680}'.repeat(20) + 'z'; // 40 after the run ends on a low surrogate
    expect(candidateContext(tail, 0, 3)).toBe('RUNc' + '\u{1F680}'.repeat(20) + '\u2026');
  });
});
