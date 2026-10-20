// The pure parts of Edit mode's controller (preload/edit-controller.ts): what a match means in Edit and which
// outline it gets, matched the way `blueline map` matches (P2-6: tracked, touched, stampedAncestor), the toasts and
// the Undo token (6.3 Saving, P2-14), main's result rebuilt, the page's own write moving it to the next map, and
// DeckInit's Phase 2 fields. The DOM parts run in Electron (test/e2e/edit-overlay-*.spec.ts).

import { describe, expect, it } from 'vitest';
import { createMatcher } from '../../../packages/core/src/matcher';
import type { ClientMap, DomTextNode } from '../../../packages/core/src/types';
import type { DeckInit } from '../../../packages/core/src/ipc';
import { EDIT_LIMITS } from '../../../packages/core/src/ipc-edit';
import {
  commitFits,
  differsOnlyIn,
  editInitFields,
  editability,
  failureToast,
  outlineKind,
  readResult,
  savedToast,
  utf8Length,
  verbatimOf,
} from '../../../packages/app/src/preload/edit-controller';

const V1 = 'a'.repeat(64);

function map(o: Partial<ClientMap> = {}): ClientMap {
  return {
    version: V1,
    utf8: true,
    runs: [
      { id: 'h:bl-1:0', stamp: 'bl-1', textIndex: 0, value: 'Quarterly review', aligned: true },
      { id: 'h:bl-2:0', stamp: 'bl-2', textIndex: 0, value: 'Hello ', aligned: true },
      { id: 'h:bl-2:1', stamp: 'bl-2', textIndex: 1, value: ' world', aligned: true },
      { id: 'h:bl-3:0', stamp: 'bl-3', textIndex: 0, value: 'Split heading', aligned: true },
    ],
    literals: [
      { id: 'l:1:0', value: 'Quarterly review', placeholder: false, html: false, strategy: 'script-literal', aligned: true },
      { id: 'l:2:0', value: 'Twin text', placeholder: false, html: false, strategy: 'script-literal', aligned: true },
      { id: 'l:3:0', value: 'Twin text', placeholder: false, html: false, strategy: 'script-literal', aligned: true },
      { id: 'l:4:0', value: 'S', placeholder: false, html: false, strategy: 'script-literal', aligned: true },
      { id: 'l:5:0', value: 'Repeated label', placeholder: false, html: false, strategy: 'script-literal', aligned: true },
      { id: 'l:6:0', value: 'Slide \ue000', placeholder: true, html: false, strategy: 'script-literal', aligned: true },
    ],
    keyValues: [],
    shadowValues: [],
    ...o,
  };
}

describe('editability and outlines, matched as the render walk matches (P2-6)', () => {
  const m = createMatcher(map());
  const own = (o: Partial<DomTextNode> = {}): DomTextNode => ({ stamp: 'bl-1', textIndex: 0, data: 'Quarterly review', texts: ['Quarterly review'], ...o });

  it("a tracked, untouched parser node is its own run's, even with an equal literal: solid", () => {
    const e = editability(m(own({ tracked: true })));
    expect(e).toEqual({ kind: 'exact', runId: 'h:bl-1:0' });
    expect(outlineKind(e)).toBe('solid');
  });

  it('without the tracker the equal literal makes it ambiguous (the spec rule), and the picker offers it: dashed', () => {
    const e = editability(m(own()));
    expect(e).toEqual({ kind: 'pick', pick: 'equal' });
    expect(outlineKind(e)).toBe('dashed');
  });

  it('a node a script rewrote is not the run\'s own: the literal it equals decides', () => {
    // Equal to a stamped run and a literal: duplicate (dashed).
    expect(outlineKind(editability(m(own({ tracked: true, touched: true }))))).toBe('dashed');
    // Equal to one literal only: exact (solid), the literal's run.
    expect(editability(m({ stamp: null, textIndex: 0, data: 'Repeated label', tracked: true, touched: true }))).toEqual({ kind: 'exact', runId: 'l:5:0' });
  });

  it('two equal literals: dashed; a split letter or one character: not editable (P2-8)', () => {
    expect(outlineKind(editability(m({ stamp: null, textIndex: 0, data: 'Twin text', tracked: true, touched: true })))).toBe('dashed');
    const split: DomTextNode = { stamp: null, textIndex: 0, data: 'S', tracked: true, touched: true, stampedAncestor: 'bl-3' };
    expect(m(split).reason).toBe('split');
    expect(editability(m(split))).toEqual({ kind: 'none' });
    expect(outlineKind(editability(m({ stamp: null, textIndex: 0, data: 'S', tracked: true, touched: true })))).toBeNull();
  });

  it('computed text and text with no run are not editable: no outline', () => {
    expect(outlineKind(editability(m({ stamp: null, textIndex: 0, data: 'Slide 3', tracked: true, touched: true })))).toBeNull();
    expect(outlineKind(editability(m({ stamp: null, textIndex: 0, data: 'Nothing like it', tracked: true })))).toBeNull();
  });

  it('a deck that is not UTF-8 has nothing editable', () => {
    expect(editability(createMatcher(map({ utf8: false }))(own({ tracked: true })))).toEqual({ kind: 'none' });
  });
});

describe('toasts and the Undo token (6.3 Saving; P2-14)', () => {
  it('"Saved \u00b7 file:line", with the other places the run feeds', () => {
    expect(savedToast({ line: 142, token: 'tok-12345678' }, 'deck.html', 0)).toEqual({ text: 'Saved \u00b7 deck.html:142', token: 'tok-12345678' });
    expect(savedToast({ line: 9 }, 'Board deck.html', 1).text).toBe('Saved \u00b7 Board deck.html:9 \u00b7 also changes 1 other place');
    expect(savedToast({ line: 9 }, null, 3).text).toBe('Saved \u00b7 deck.html:9 \u00b7 also changes 3 other places');
    expect(savedToast({}, 'deck.html', 0).text).toBe('Saved');
  });
  it('offers Undo only with a well-formed token', () => {
    expect(savedToast({ line: 1 }, 'd.html', 0).token).toBeNull();
    expect(savedToast({ line: 1, token: 'short' }, 'd.html', 0).token).toBeNull();
    expect(savedToast({ line: 1, token: 'has spaces in it' }, 'd.html', 0).token).toBeNull();
    expect(savedToast({ line: 1, token: 42 }, 'd.html', 0).token).toBeNull();
  });
  it('failures say the text was kept as a note (6.3 When a write fails)', () => {
    expect(failureToast('verbatim', 'the deck changed')).toBe('Not changed in place: the deck changed \u00b7 your text is kept as a note');
    expect(failureToast('verbatim', null)).toBe('Not changed in place \u00b7 your text is kept as a note');
    expect(failureToast('refused', 'editing is off')).toBe('Not saved: editing is off');
    expect(failureToast('noop', null)).toBeNull();
    expect(failureToast('written', null)).toBeNull();
  });
});

describe("readResult (main's EditResult, rebuilt field by field)", () => {
  it('keeps the known fields of a valid result', () => {
    expect(readResult({ fieldId: 3, outcome: 'written', text: 'New', line: 7, strategy: 'html-text', reload: false, noteId: 'n-0004', token: 'tok-abcdefgh', why: 'x', junk: 1 })).toEqual({
      fieldId: 3,
      outcome: 'written',
      text: 'New',
      line: 7,
      strategy: 'html-text',
      reload: false,
      noteId: 'n-0004',
      token: 'tok-abcdefgh',
      why: 'x',
    });
  });
  it('refuses a result with no field or outcome, and drops bad fields', () => {
    expect(readResult({ outcome: 'written' })).toBeNull();
    expect(readResult({ fieldId: 1, outcome: 'maybe' })).toBeNull();
    expect(readResult(null)).toBeNull();
    expect(readResult({ fieldId: 1, outcome: 'refused', text: 'a\uD800', line: 0, token: 'x', reload: 'yes' })).toEqual({ fieldId: 1, outcome: 'refused', reload: false });
    expect(readResult({ fieldId: 1, outcome: 'written', text: 'x'.repeat(EDIT_LIMITS.text + 1) })?.text).toBeUndefined();
  });
});

describe("differsOnlyIn (the page's own html-text write moves it to the next map, P2-6)", () => {
  const base = map();
  const next = (f: (m: ClientMap) => void): ClientMap => {
    const m = structuredClone(base);
    m.version = 'b'.repeat(64);
    f(m);
    return m;
  };
  it('accepts exactly that run with exactly that text', () => {
    const n = next((m) => (m.runs[1].value = 'Hi '));
    expect(differsOnlyIn(base, n, 'h:bl-2:0', 'Hi ')).toBe(true);
    expect(differsOnlyIn(base, n, 'h:bl-2:0', 'Hello ')).toBe(false);
    expect(differsOnlyIn(base, n, 'h:bl-1:0', 'Quarterly review')).toBe(false);
  });
  it('refuses any other change: another run, a literal, keys, shadows, renumbered stamps, a different shape', () => {
    expect(differsOnlyIn(base, next((m) => ((m.runs[1].value = 'Hi '), (m.runs[2].value = ' there'))), 'h:bl-2:0', 'Hi ')).toBe(false);
    expect(differsOnlyIn(base, next((m) => ((m.runs[1].value = 'Hi '), (m.literals[0].value = 'Q2'))), 'h:bl-2:0', 'Hi ')).toBe(false);
    expect(differsOnlyIn(base, next((m) => ((m.runs[1].value = 'Hi '), (m.keyValues = ['Hi']))), 'h:bl-2:0', 'Hi ')).toBe(false);
    expect(differsOnlyIn(base, next((m) => ((m.runs[1].value = 'Hi '), (m.shadowValues = ['x']))), 'h:bl-2:0', 'Hi ')).toBe(false);
    expect(differsOnlyIn(base, next((m) => ((m.runs[1].value = 'Hi '), (m.runs[3].stamp = 'bl-4'), (m.runs[3].id = 'h:bl-4:0'))), 'h:bl-2:0', 'Hi ')).toBe(false);
    expect(differsOnlyIn(base, next((m) => ((m.runs[1].value = 'Hi '), m.runs.pop())), 'h:bl-2:0', 'Hi ')).toBe(false);
    expect(differsOnlyIn(base, next((m) => ((m.runs[1].value = 'Hi '), (m.utf8 = false))), 'h:bl-2:0', 'Hi ')).toBe(false);
  });
});

describe('commit helpers', () => {
  it('verbatimOf cleans the text as a commit does, with smart quotes from the field', () => {
    expect(verbatimOf('He said "hi"', 'He said "hi"', 'invalid', true)).toBeNull();
    expect(verbatimOf('A\u00a0b', 'A\u00a0b c\u200b', 'invalid', false)).toEqual({ kind: 'verbatim', before: 'A\u00a0b', after: 'A\u00a0b c', why: 'invalid' });
    expect(verbatimOf('It\u2019s', "It\u2019s Josh's", 'invalid', true)).toEqual({ kind: 'verbatim', before: 'It\u2019s', after: 'It\u2019s Josh\u2019s', why: 'invalid' });
  });
  it('commitFits refuses what main would refuse: oversize or lone surrogates', () => {
    expect(commitFits({ kind: 'edit', runId: 'h:bl-1:0', beforeText: 'a', afterText: 'b' })).toBe(true);
    expect(commitFits({ kind: 'edit', runId: 'h:bl-1:0', beforeText: 'a', afterText: 'x'.repeat(EDIT_LIMITS.text + 1) })).toBe(false);
    expect(commitFits({ kind: 'verbatim', before: 'a', after: 'b\uDC00', why: 'invalid' })).toBe(false);
    expect(commitFits({ kind: 'noop' })).toBe(true);
  });
  it('utf8Length counts as TextEncoder does', () => {
    for (const s of ['', 'abc', '\u00e9', '\u20ac', '\u{1F680}', 'a\u00a0\u2014\u{1F389}z']) expect(utf8Length(s), s).toBe(new TextEncoder().encode(s).length);
  });
});

describe("DeckInit's Phase 2 fields (fileName, pageVersion, settings)", () => {
  const init = (o: Record<string, unknown>) => ({ mode: 'deck', appMode: 'edit', trust: 'trusted', capabilities: { edit: true, agent: true }, editingAllowed: true, map: null, notes: [], userName: '', ...o }) as unknown as DeckInit;
  it('reads them when main sends them', () => {
    expect(editInitFields(init({ fileName: 'Q3 board.html', pageVersion: 'f'.repeat(64), settings: { smartPunctuation: false } }))).toEqual({ fileName: 'Q3 board.html', pageVersion: 'f'.repeat(64), smartPunctuation: false });
  });
  it('defaults: no file name, no page version, smart punctuation on (6.3)', () => {
    expect(editInitFields(init({}))).toEqual({ fileName: null, pageVersion: null, smartPunctuation: true });
  });
  it('ignores malformed values', () => {
    expect(editInitFields(init({ fileName: 'a/b.html', pageVersion: 'xyz', settings: 'on' }))).toEqual({ fileName: null, pageVersion: null, smartPunctuation: true });
    expect(editInitFields(init({ fileName: 'a\u0000.html' })).fileName).toBeNull();
    expect(editInitFields(init({ fileName: '' })).fileName).toBeNull();
  });
});
