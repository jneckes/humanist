// The edit field's input rules (preload/edit-input.ts): the 9.2 step 2 filter as a decision table, the line-break
// rule of 6.3, native undo confined to the field (P2-9) and the input gate (P2-7). The DOM parts (ranges from the
// selection, snapshots) run in Electron: test/e2e/edit-overlay-field.spec.ts.

import { describe, expect, it } from 'vitest';
import {
  ALLOWED_INPUT_TYPES,
  COLLAPSED_DELETIONS,
  FieldHistory,
  FieldInputGate,
  affectedRanges,
  classifyInput,
  hasLineBreak,
  lineBreaksToSpaces,
  rangeFacts,
  type InputFacts,
  type RangeFacts,
} from '../../../packages/app/src/preload/edit-input';
import { noteDrop } from '../../../packages/app/src/preload/input-guard';
import { ALLOWED_INPUT_TYPES as FROM_DIAGNOSTICS } from '../../../packages/app/src/preload/diagnostics-hooks';

const inNode: RangeFacts = { collapsed: false, textNodes: 1, other: false, inField: true };
const caret: RangeFacts = { collapsed: true, textNodes: 1, other: false, inField: true };

function facts(o: Partial<InputFacts>): InputFacts {
  return { inputType: 'insertText', trusted: true, cancelable: true, range: caret, data: 'a', undoAllowed: false, redoAllowed: false, ...o };
}

describe('classifyInput (9.2 Committing an edit, step 2)', () => {
  it('allows exactly the listed input types inside one text node', () => {
    expect([...ALLOWED_INPUT_TYPES].sort()).toEqual(
      ['deleteByCut', 'deleteByDrag', 'deleteContentBackward', 'deleteContentForward', 'deleteWordBackward', 'deleteWordForward', 'insertFromDrop', 'insertFromPaste', 'insertReplacementText', 'insertText'].sort(),
    );
    for (const t of ALLOWED_INPUT_TYPES) {
      expect(classifyInput(facts({ inputType: t, range: inNode, data: t.startsWith('insert') ? 'x' : null })), t).toBe('allow');
      // A drag moves a selection, never a caret (below).
      if (t !== 'deleteByDrag') expect(classifyInput(facts({ inputType: t, range: caret, data: t.startsWith('insert') ? 'x' : null })), t).toBe('allow');
    }
    // The Diagnostics heading uses the same list.
    expect(FROM_DIAGNOSTICS).toBe(ALLOWED_INPUT_TYPES);
  });

  it('commits on insertParagraph (Enter) and blocks every other type, Shift+Enter included', () => {
    expect(classifyInput(facts({ inputType: 'insertParagraph' }))).toBe('commit');
    for (const t of ['insertLineBreak', 'formatBold', 'formatItalic', 'insertOrderedList', 'insertHorizontalRule', 'deleteSoftLineBackward', 'deleteHardLineForward', 'insertTranspose', 'insertLink', 'formatSetBlockTextDirection']) {
      expect(classifyInput(facts({ inputType: t })), t).toBe('block');
    }
  });

  it('blocks a range that crosses text nodes, holds an element, or leaves the field', () => {
    expect(classifyInput(facts({ inputType: 'deleteContentBackward', range: { ...inNode, textNodes: 2 }, data: null }))).toBe('block');
    expect(classifyInput(facts({ inputType: 'deleteByCut', range: { ...inNode, other: true }, data: null }))).toBe('block');
    expect(classifyInput(facts({ inputType: 'insertText', range: { ...inNode, textNodes: 0, other: true } }))).toBe('block');
    expect(classifyInput(facts({ inputType: 'insertText', range: { ...caret, inField: false } }))).toBe('block');
    expect(classifyInput(facts({ inputType: 'insertFromPaste', range: { ...inNode, textNodes: 3 }, data: 'x' }))).toBe('block');
    // No selection to read the range from: refused rather than guessed.
    expect(classifyInput(facts({ range: null }))).toBe('block');
    // A collapsed range at an element boundary is an insertion point: the commit's diff places it.
    expect(classifyInput(facts({ range: { collapsed: true, textNodes: 0, other: false, inField: true } }))).toBe('allow');
  });

  it('allows deleteByDrag (the source of a drag-move) only for a selection in one text node of the field (E-10)', () => {
    // Chromium moves dragged text with deleteByDrag at the source, then insertFromDrop at the drop point; with only
    // the second allowed, a drag-move copied the word (review finding 12). getTargetRanges() is empty for it, so the
    // range is the selection being dragged, confined as deleteByCut's is.
    const drag = (range: RangeFacts | null, o: Partial<InputFacts> = {}) => classifyInput(facts({ inputType: 'deleteByDrag', range, data: null, ...o }));
    expect(drag(inNode)).toBe('allow');
    expect(drag({ ...inNode, textNodes: 2 })).toBe('block');
    expect(drag({ ...inNode, other: true })).toBe('block');
    expect(drag({ ...inNode, textNodes: 0, other: true })).toBe('block');
    expect(drag({ ...inNode, inField: false })).toBe('block');
    expect(drag(null)).toBe('block');
    // A drag always moves a selection (Chromium deletes by drag only for a range): a caret is not the author's.
    expect(drag(caret)).toBe('block');
    expect(drag({ collapsed: true, textNodes: 0, other: false, inField: true })).toBe('block');
    expect(drag(inNode, { trusted: false })).toBe('block');
    // The drop that follows it is an insertion at the drop point: allowed, its line breaks rewritten.
    expect(classifyInput(facts({ inputType: 'insertFromDrop', range: caret, data: 'beta' }))).toBe('allow');
    expect(classifyInput(facts({ inputType: 'insertFromDrop', range: caret, data: 'be\nta' }))).toBe('rewrite');
  });

  it('rewrites pasted, dropped and dictated line breaks into spaces (6.3)', () => {
    for (const t of ['insertFromPaste', 'insertFromDrop', 'insertText', 'insertReplacementText']) {
      expect(classifyInput(facts({ inputType: t, data: 'one\ntwo' })), t).toBe('rewrite');
      expect(classifyInput(facts({ inputType: t, data: 'one two' })), t).toBe('allow');
    }
    expect(lineBreaksToSpaces('a\r\nb\rc\nd\u2028e\u2029f\u0085g\u000bh\u000ci')).toBe('a b c d e f g h i');
    expect(lineBreaksToSpaces('a\r\n\r\nb')).toBe('a  b');
    expect(hasLineBreak('plain')).toBe(false);
    expect(hasLineBreak(null)).toBe(false);
    expect(hasLineBreak('x\u2028')).toBe(true);
    // hasLineBreak keeps no state between calls (a global regex's lastIndex).
    expect(hasLineBreak('\n')).toBe(true);
    expect(hasLineBreak('\n')).toBe(true);
  });

  it('never acts on untrusted events; lets composition through, confined by the commit (P2-9)', () => {
    expect(classifyInput(facts({ trusted: false }))).toBe('block');
    expect(classifyInput(facts({ trusted: false, inputType: 'insertParagraph' }))).toBe('block');
    expect(classifyInput(facts({ inputType: 'insertCompositionText', cancelable: false, range: { ...inNode, textNodes: 2 } }))).toBe('allow');
    expect(classifyInput(facts({ inputType: 'insertCompositionText', cancelable: true }))).toBe('allow');
  });

  it('lets native undo and redo through only when the field allows them (P2-9)', () => {
    expect(classifyInput(facts({ inputType: 'historyUndo', data: null }))).toBe('block');
    expect(classifyInput(facts({ inputType: 'historyUndo', data: null, undoAllowed: true }))).toBe('allow');
    expect(classifyInput(facts({ inputType: 'historyRedo', data: null }))).toBe('block');
    expect(classifyInput(facts({ inputType: 'historyRedo', data: null, redoAllowed: true }))).toBe('allow');
  });

  it('maps collapsed deletions to Selection.modify directions and granularities', () => {
    expect(COLLAPSED_DELETIONS.deleteContentBackward).toEqual(['backward', 'character']);
    expect(COLLAPSED_DELETIONS.deleteWordForward).toEqual(['forward', 'word']);
    expect(COLLAPSED_DELETIONS.deleteByCut).toBeUndefined();
  });
});

describe('affectedRanges for deleteByDrag (E-10: a drag-move takes text out of the field only to put it back in)', () => {
  // A field <h1>"Alpha beta gamma"</h1> with "beta" selected, an inline element inside it, and a page element (the
  // page's own contenteditable) outside it. Fakes: rangeFacts needs only contains() for a range in one node.
  const text = { nodeType: 3 };
  const inner = { nodeType: 1 };
  const field = { nodeType: 1, ownerDocument: {}, contains: (n: unknown) => n === text || n === inner };
  const page = { nodeType: 1 };
  const dragged = { startContainer: text, startOffset: 6, endContainer: text, endOffset: 10, collapsed: false };
  function view(range = dragged) {
    const sel = { rangeCount: 1, getRangeAt: () => ({ cloneRange: () => range }) };
    return { getSelection: () => sel } as unknown as Window;
  }
  const input = (inputType = 'deleteByDrag') => ({ inputType, getTargetRanges: () => [] }) as unknown as InputEvent;
  const decide = (w: Window, e = input()) => {
    const r = affectedRanges(e, w);
    return classifyInput(facts({ inputType: e.inputType, range: r ? rangeFacts(r, field as unknown as Element) : null, data: null }));
  };
  const drop = (w: Window, target: unknown) => {
    const later: (() => void)[] = [];
    noteDrop(w, target as EventTarget, (fn) => later.push(fn));
    return () => later.splice(0).forEach((f) => f());
  };

  it("allows the deletion when this task's drop landed in the field, and only until the task ends", () => {
    const w = view();
    const endTask = drop(w, field);
    expect(affectedRanges(input(), w)).toEqual([dragged, { startContainer: field, startOffset: 0, endContainer: field, endOffset: 0, collapsed: true }]);
    expect(decide(w)).toBe('allow');
    endTask();
    expect(affectedRanges(input(), w)).toBeNull();
    expect(decide(w)).toBe('block');
    drop(w, inner);
    expect(decide(w)).toBe('allow');
  });

  it("blocks it when the drop landed outside the field (the page's own editable element) or no drop came first", () => {
    // The text would leave the field: Chromium copies it to the page's element instead, and the field keeps it.
    const w = view();
    drop(w, page);
    expect(decide(w)).toBe('block');
    expect(decide(view())).toBe('block');
    drop(w, null);
    expect(decide(w)).toBe('block');
    // A drop in the field does not let a dragged selection outside it go.
    const outside = view({ ...dragged, startContainer: page as typeof text });
    drop(outside, field);
    expect(decide(outside)).toBe('block');
  });

  it('adds the drop point to deleteByDrag only: the drop itself is an insertion at the selection Chromium moved there', () => {
    const w = view();
    drop(w, page);
    expect(affectedRanges(input('insertFromDrop'), w)).toEqual([dragged]);
    expect(affectedRanges(input('deleteByCut'), w)).toEqual([dragged]);
  });
});

describe('FieldHistory (P2-9: native undo stays inside the field)', () => {
  it('allows undo only after an own step and while the text differs from the opening text', () => {
    const h = new FieldHistory();
    expect(h.undoAllowed('abc', 'abc')).toBe(false);
    expect(h.undoAllowed('abcd', 'abc')).toBe(false); // no step of its own yet
    h.accepted('insertText');
    expect(h.undoAllowed('abcd', 'abc')).toBe(true);
    // Chromium coalesces typing: once the text is back where it started, every own step is undone.
    h.accepted('historyUndo');
    expect(h.undoAllowed('abc', 'abc')).toBe(false);
    expect(h.redoAllowed()).toBe(true);
    h.accepted('historyRedo');
    expect(h.redoAllowed()).toBe(false);
  });

  it('a new edit clears what redo could bring back', () => {
    const h = new FieldHistory();
    h.accepted('insertText');
    h.accepted('historyUndo');
    h.accepted('insertText');
    expect(h.redoAllowed()).toBe(false);
  });

  it('is off for good once a page change was refused (its step is on the frame stack)', () => {
    const h = new FieldHistory();
    h.accepted('insertText');
    h.accepted('historyUndo');
    h.poison();
    expect(h.undoAllowed('x', 'y')).toBe(false);
    expect(h.redoAllowed()).toBe(false);
  });
});

describe('FieldInputGate (P2-7: only input a trusted beforeinput announced)', () => {
  function gate(initial: { text: string; start: number; end: number }) {
    let reading = initial;
    const later: (() => void)[] = [];
    const g = new FieldInputGate(
      () => reading,
      (fn) => later.push(fn),
    );
    return {
      g,
      set: (r: typeof reading) => (reading = r),
      tick: () => later.splice(0).forEach((f) => f()),
    };
  }
  const ev = (inputType: string, data: string | null = null, isTrusted = true) => ({ inputType, data, isTrusted });

  it('accepts the input its beforeinput announced, once', () => {
    const t = gate({ text: 'abc', start: 3, end: 3 });
    t.g.arm(ev('insertText', 'd'));
    expect(t.g.check(ev('insertText', 'd'), 'abcd')).toBe(true);
    // The arm is consumed.
    expect(t.g.check(ev('insertText', 'e'), 'abcde')).toBe(false);
  });

  it('refuses an input with no beforeinput (a page execCommand), another type, or other data', () => {
    const t = gate({ text: 'abc', start: 3, end: 3 });
    expect(t.g.check(ev('insertText', 'EVIL'), 'abcEVIL')).toBe(false);
    t.g.arm(ev('insertText', 'd'));
    expect(t.g.check(ev('insertText', 'EVIL'), 'abcEVIL')).toBe(false);
    t.g.arm(ev('deleteContentBackward'));
    expect(t.g.check(ev('insertText', 'x'), 'abcx')).toBe(false);
    t.g.arm(ev('insertText', 'd', false));
    expect(t.g.check(ev('insertText', 'd'), 'abcd')).toBe(false);
  });

  it('a lingering deletion arm only accepts that deletion next to the recorded caret', () => {
    const t = gate({ text: 'abc', start: 0, end: 0 });
    // Backspace at the start deletes nothing and fires no input; a page's delete after selecting all must fail.
    t.g.arm(ev('deleteContentBackward'));
    expect(t.g.check(ev('deleteContentBackward'), '')).toBe(false);
    t.set({ text: 'abc', start: 2, end: 2 });
    t.g.arm(ev('deleteContentBackward'));
    expect(t.g.check(ev('deleteContentBackward'), 'ac')).toBe(true);
  });

  it('accepts a drag-move: the deletion of the dragged selection, then the drop at the drop point (E-10)', () => {
    const t = gate({ text: 'Alpha beta gamma', start: 6, end: 10 });
    t.g.arm(ev('deleteByDrag'));
    expect(t.g.check(ev('deleteByDrag'), 'Alpha  gamma')).toBe(true);
    // Chromium puts the selection at the drop point before the insertion.
    t.set({ text: 'Alpha  gamma', start: 12, end: 12 });
    t.g.arm(ev('insertFromDrop'));
    expect(t.g.check(ev('insertFromDrop'), 'Alpha  gammabeta')).toBe(true);
    // A deleteByDrag arm is consumed by its input and accepts no other type.
    t.set({ text: 'Alpha  gammabeta', start: 0, end: 5 });
    t.g.arm(ev('deleteByDrag'));
    expect(t.g.check(ev('deleteContentBackward'), '  gammabeta')).toBe(false);
    expect(t.g.check(ev('deleteByDrag'), '  gammabeta')).toBe(false);
  });

  it('expires an arm at the end of the task', () => {
    const t = gate({ text: 'abc', start: 3, end: 3 });
    t.g.arm(ev('insertText', 'd'));
    t.tick();
    expect(t.g.check(ev('insertText', 'd'), 'abcd')).toBe(false);
  });

  it("accepts the field's own insertion (a rewritten paste) while own() runs", () => {
    const t = gate({ text: 'abc', start: 3, end: 3 });
    let inside = false;
    t.g.own(() => {
      inside = t.g.owning;
      expect(t.g.check(ev('insertText', 'one two'), 'abcone two')).toBe(true);
    });
    expect(inside).toBe(true);
    expect(t.g.owning).toBe(false);
    expect(t.g.check(ev('insertText', 'x'), 'abcone twox')).toBe(false);
  });

  it('disarm drops a pending arm', () => {
    const t = gate({ text: 'abc', start: 3, end: 3 });
    t.g.arm(ev('insertText', 'd'));
    t.g.disarm();
    expect(t.g.check(ev('insertText', 'd'), 'abcd')).toBe(false);
  });
});
