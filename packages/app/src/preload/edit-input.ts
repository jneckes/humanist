// The edit field's input rules (9.2 Committing an edit step 2; 6.3 Ending an edit; P2-7 real input; P2-9 undo
// inside the field), shared by the Edit field (edit-controller.ts) and the Diagnostics heading
// (diagnostics-hooks.ts). The decisions are pure functions of facts the DOM code reads (unit-tested in node);
// the DOM helpers below read those facts and restore a field.
//
// Filtering (9.2 step 2). In `beforeinput`, block any edit whose range starts or ends outside the active text node;
// allow only the listed inputTypes; insertParagraph commits; pasted and dropped line breaks become spaces.
// Electron 44 gives no target ranges for a `contenteditable="plaintext-only"` element (getTargetRanges() is empty
// in both worlds; it is filled for contenteditable="true"), so the range is read from the selection: a selection
// is the range an insertion or deletion replaces, and for a deletion at a collapsed caret, Selection.modify
// ('extend', direction, 'character' | 'word') finds the character or word the browser is about to remove; the
// selection is put back before the default action runs. A deletion at the start of " world" in
// "Hello <b>bold</b> world" removes the "d" of "bold": that range is in another text node, so it is blocked.
// Ranges are still taken from getTargetRanges() when a browser gives them.
//
// Dragging selected text inside the field moves it, as in any text field (6.3; E-10, review finding 12): Chromium
// removes the dragged selection with deleteByDrag, then inserts it at the drop point with insertFromDrop, so both
// are allowed. deleteByDrag is confined as deleteByCut is (the dragged selection, in one text node of the field),
// never at a caret (a drag always moves a selection), and its drop must land inside the field too: a drag that
// ends in the page's own editable element copies the text there and takes nothing out of the field.
//
// The input gate (P2-7, as CardInputGate does for the card). The field's text changes only through a trusted
// beforeinput the filter allowed, followed by its input in the same task: a page's document.execCommand fires a
// trusted `input` with no beforeinput (checked in Electron 44), and that change is put back. Line breaks rewritten
// to spaces are inserted by the field itself with execCommand('insertText'), whose input is marked as its own.
//
// Native undo (P2-9). Chromium keeps one undo stack per frame, so Cmd+Z in a new field could undo an earlier,
// already written edit elsewhere, or the page's own execCommand edits. historyUndo is allowed only while the field
// has accepted steps of its own and its text differs from the text it opened with (Chromium coalesces typing
// into one undo step, so counting inputs over-counts; once the text is back to where it started, every step of
// this field is undone); historyRedo only while it has undone steps of its own. A refused page change poisons
// both, since its step sits on the stack too. Composition input (insertCompositionText) cannot be cancelled: it is
// allowed, confined by the commit's diff (9.2 step 4).

import { dropTarget, matchesArmed, type InputLike } from './input-guard';

/**
 * 9.2 Committing an edit, step 2: the input types an edit field accepts; insertParagraph commits. deleteByDrag is the
 * source half of a drag-move whose insertFromDrop is listed (E-10; spec-amendments, 9.2 step 2).
 */
export const ALLOWED_INPUT_TYPES: ReadonlySet<string> = new Set([
  'insertText',
  'insertReplacementText',
  'insertFromPaste',
  'insertFromDrop',
  'deleteContentBackward',
  'deleteContentForward',
  'deleteWordBackward',
  'deleteWordForward',
  'deleteByCut',
  'deleteByDrag',
]);

/** Insertions whose text may carry line breaks (pasted, dropped, dictated, replaced): they become spaces (6.3). */
const INSERTIONS = new Set(['insertText', 'insertReplacementText', 'insertFromPaste', 'insertFromDrop']);

/** A deletion at a collapsed caret: which way and how much (Selection.modify's arguments). */
export const COLLAPSED_DELETIONS: Readonly<Record<string, readonly ['forward' | 'backward', 'character' | 'word']>> = Object.freeze({
  deleteContentBackward: ['backward', 'character'],
  deleteContentForward: ['forward', 'character'],
  deleteWordBackward: ['backward', 'word'],
  deleteWordForward: ['forward', 'word'],
});

const LINE_BREAKS = /\r\n|[\r\n\u2028\u2029\u0085\u000b\u000c]/g;

/** True when `s` holds a line break (CRLF, CR, LF, NEL, VT, FF, U+2028, U+2029). */
export function hasLineBreak(s: string | null | undefined): boolean {
  if (!s) return false;
  LINE_BREAKS.lastIndex = 0;
  return LINE_BREAKS.test(s);
}

/** 6.3: "Line breaks in pasted or dictated text become spaces." A CRLF pair is one break, one space. */
export function lineBreaksToSpaces(s: string): string {
  return s.replace(LINE_BREAKS, ' ');
}

// ------------------------------------------------------------------------------------------- the decision

/** What the filter knows about the range an input would change. */
export interface RangeFacts {
  collapsed: boolean;
  /** Text nodes the range covers at least one character of (a collapsed range: 1 when it sits in a text node). */
  textNodes: number;
  /** The range wholly contains a node that is not text (an inline element, a <br>, a comment): deleting it is structural. */
  other: boolean;
  /** Both ends lie inside the field (its edit root). */
  inField: boolean;
}

export interface InputFacts {
  inputType: string;
  trusted: boolean;
  cancelable: boolean;
  /** The range the input changes, or null when there is no selection to read it from. */
  range: RangeFacts | null;
  /** The inserted text (InputEvent.data, else the dataTransfer's text/plain), or null. */
  data: string | null;
  /** P2-9, now (FieldHistory). */
  undoAllowed: boolean;
  redoAllowed: boolean;
}

/**
 * allow: let the browser do it (the gate arms); block: preventDefault; commit: preventDefault and commit the field
 * (insertParagraph, 6.3 "Enter commits"); rewrite: preventDefault and insert the text with its line breaks turned
 * into spaces (6.3).
 */
export type InputDecision = 'allow' | 'block' | 'commit' | 'rewrite';

/** 9.2 step 2 and P2-9 for one beforeinput. */
export function classifyInput(f: InputFacts): InputDecision {
  // 9.1: the page's synthetic events are never acted on (they have no default action anyway).
  if (!f.trusted) return 'block';
  if (f.inputType === 'insertParagraph') return 'commit';
  // Composition input cannot be cancelled: it is allowed and confined by the commit's diff (P2-9).
  if (f.inputType === 'insertCompositionText' || !f.cancelable) return 'allow';
  if (f.inputType === 'historyUndo') return f.undoAllowed ? 'allow' : 'block';
  if (f.inputType === 'historyRedo') return f.redoAllowed ? 'allow' : 'block';
  // Shift+Enter (insertLineBreak), formatting, transposition, line deletions: every other type is blocked.
  if (!ALLOWED_INPUT_TYPES.has(f.inputType)) return 'block';
  const r = f.range;
  if (!r || !r.inField) return 'block';
  // A collapsed range is an insertion point: the browser puts the text in the text node at it, or next to it at an
  // element boundary, where the commit's diff gives it to the run that held the caret (9.2 step 4).
  if (!r.collapsed && (r.textNodes !== 1 || r.other)) return 'block';
  // deleteByDrag removes the dragged selection (getTargetRanges() is empty for it, so the range is that selection);
  // Chromium moves only a range selection, so one at a caret is not the author's drag.
  if (f.inputType === 'deleteByDrag' && r.collapsed) return 'block';
  if (INSERTIONS.has(f.inputType) && hasLineBreak(f.data)) return 'rewrite';
  return 'allow';
}

// ------------------------------------------------------------------------------------------- P2-9 history

/** The field's own native-undo steps (P2-9). */
export class FieldHistory {
  /** Accepted inputs other than undo and redo since the field opened. */
  private steps = 0;
  /** Undo steps of this field that redo may bring back. */
  private undone = 0;
  private poisoned = false;

  /** historyUndo may reach only this field's own steps: some were accepted and the text is not back at its start. */
  undoAllowed(textNow: string, textAtOpen: string): boolean {
    return !this.poisoned && this.steps > 0 && textNow !== textAtOpen;
  }

  redoAllowed(): boolean {
    return !this.poisoned && this.undone > 0;
  }

  /** An input the gate accepted. */
  accepted(inputType: string): void {
    if (inputType === 'historyUndo') this.undone++;
    else if (inputType === 'historyRedo') this.undone = Math.max(0, this.undone - 1);
    else {
      this.steps++;
      // A new edit clears the browser's redo stack.
      this.undone = 0;
    }
  }

  /** A refused page change left a step on the frame's undo stack: native undo and redo are off for this field. */
  poison(): void {
    this.poisoned = true;
  }
}

// ------------------------------------------------------------------------------------------- the gate

/** The field's text and the selection as offsets into it, when a beforeinput arms the gate. */
export interface FieldReading {
  text: string;
  start: number;
  end: number;
}

interface Armed {
  inputType: string;
  data: string | null;
  text: string;
  start: number;
  end: number;
}

/**
 * Accepts a change of the field only when the trusted beforeinput the filter allowed announced it, in the same
 * task (P2-7). "The same task": the arm is consumed by the next input and cleared by a zero-delay timer. A
 * beforeinput with no input (a deletion with nothing to delete) leaves an arm a page task could reach before the
 * timer; matchesArmed then requires the change to be that deletion next to the recorded caret, and an insertion
 * to carry the same data (input-guard.ts).
 */
export class FieldInputGate {
  private armed: Armed | null = null;
  private ownDepth = 0;

  constructor(
    private readonly read: () => FieldReading,
    private readonly later: (fn: () => void) => void = (fn) => {
      setTimeout(fn, 0);
    },
  ) {}

  /** A beforeinput the filter allowed. */
  arm(e: InputLike): void {
    if (!e.isTrusted) return;
    const r = this.read();
    const armed: Armed = { inputType: e.inputType, data: typeof e.data === 'string' ? e.data : null, text: r.text, start: r.start, end: r.end };
    this.armed = armed;
    this.later(() => {
      if (this.armed === armed) this.armed = null;
    });
  }

  /** Runs `fn`, an edit the field makes itself (execCommand('insertText') of a rewritten paste): its input is accepted. */
  own<T>(fn: () => T): T {
    this.ownDepth++;
    try {
      return fn();
    } finally {
      this.ownDepth--;
    }
  }

  /** True while own() runs. */
  get owning(): boolean {
    return this.ownDepth > 0;
  }

  /** An input event, after its change: true when the change is accepted. */
  check(e: InputLike, textNow: string): boolean {
    if (this.ownDepth > 0) return e.isTrusted;
    const a = this.armed;
    this.armed = null;
    if (!e.isTrusted || !a) return false;
    return matchesArmed({ inputType: a.inputType, data: a.data, value: a.text, start: a.start, end: a.end }, e, textNow);
  }

  /** Drops a pending arm (the field closed). */
  disarm(): void {
    this.armed = null;
  }
}

// ------------------------------------------------------------------------------------------- DOM helpers

/** One text node of a field with its place in the field's text (textContent). */
export interface FieldNode {
  node: Text;
  start: number;
  end: number;
}

/** The text nodes under `root` in tree order, with their offsets in root.textContent. */
export function fieldTextNodes(root: Node): FieldNode[] {
  const doc = root.ownerDocument ?? (root as Document);
  const out: FieldNode[] = [];
  const walker = doc.createTreeWalker(root, 0x4 /* SHOW_TEXT */);
  let at = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    out.push({ node: t, start: at, end: at + t.data.length });
    at += t.data.length;
  }
  return out;
}

/** The offset of a boundary point in root's text (Range.toString is the text nodes' data in tree order, as textContent). */
export function textOffset(root: Node, node: Node, offset: number): number {
  const doc = root.ownerDocument ?? (root as Document);
  try {
    const r = doc.createRange();
    r.setStart(root, 0);
    r.setEnd(node, offset);
    return r.toString().length;
  } catch {
    return 0;
  }
}

/** The field's text and its selection as offsets (FieldReading); a selection outside the field reads as its end. */
export function readField(root: Element, win: Window): FieldReading {
  const text = root.textContent ?? '';
  const sel = win.getSelection();
  if (!sel || sel.rangeCount === 0) return { text, start: text.length, end: text.length };
  const r = sel.getRangeAt(0);
  if (!root.contains(r.startContainer) || !root.contains(r.endContainer)) return { text, start: text.length, end: text.length };
  return { text, start: textOffset(root, r.startContainer, r.startOffset), end: textOffset(root, r.endContainer, r.endOffset) };
}

/** A range's boundary points (a Range or a StaticRange). */
export interface RangeLike {
  startContainer: Node;
  startOffset: number;
  endContainer: Node;
  endOffset: number;
  collapsed: boolean;
}

/**
 * The ranges a beforeinput changes: getTargetRanges() when the browser gives them, else the selection, and for a
 * deletion at a collapsed caret the character or word Selection.modify('extend') reaches (the selection is put
 * back at once). Null when there is no selection.
 *
 * deleteByDrag (E-10) also changes the drop point, where the insertFromDrop that follows puts the text: a collapsed
 * range at the real target of this task's drop (input-guard.ts noteDrop), so rangeFacts confines both ends of the
 * move to the field. Null when no drop came first.
 */
export function affectedRanges(e: InputEvent, win: Window): RangeLike[] | null {
  const ranges = inputRanges(e, win);
  if (!ranges || e.inputType !== 'deleteByDrag') return ranges;
  const at = dropTarget(win) as Node | null | undefined;
  if (!at || typeof at.nodeType !== 'number') return null;
  return [...ranges, { startContainer: at, startOffset: 0, endContainer: at, endOffset: 0, collapsed: true }];
}

function inputRanges(e: InputEvent, win: Window): RangeLike[] | null {
  let given: RangeLike[] = [];
  try {
    given = typeof e.getTargetRanges === 'function' ? e.getTargetRanges() : [];
  } catch {
    given = [];
  }
  if (given.length > 0) return given;
  const sel = win.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0).cloneRange();
  const del = COLLAPSED_DELETIONS[e.inputType];
  if (!r.collapsed || !del) return [r];
  const anchor = sel.anchorNode;
  const anchorOffset = sel.anchorOffset;
  const focus = sel.focusNode;
  const focusOffset = sel.focusOffset;
  try {
    sel.modify('extend', del[0], del[1]);
    return [sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : r];
  } catch {
    return [r];
  } finally {
    try {
      if (anchor && focus) sel.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
    } catch {
      // the nodes left the document meanwhile
    }
  }
}

function within(root: Node, n: Node): boolean {
  return n === root || root.contains(n);
}

/** RangeFacts of `ranges` against the field's edit root. */
export function rangeFacts(ranges: readonly RangeLike[], root: Element): RangeFacts {
  const facts: RangeFacts = { collapsed: true, textNodes: 0, other: false, inField: true };
  const doc = root.ownerDocument;
  for (const r of ranges) {
    if (!within(root, r.startContainer) || !within(root, r.endContainer)) {
      facts.inField = false;
      continue;
    }
    if (r.collapsed) {
      if (r.startContainer.nodeType === 3) facts.textNodes = Math.max(facts.textNodes, 1);
      continue;
    }
    facts.collapsed = false;
    if (r.startContainer === r.endContainer && r.startContainer.nodeType === 3) {
      facts.textNodes += 1;
      continue;
    }
    // Spans boundaries: count the text nodes it covers a character of, and look for whole non-text nodes inside.
    const live = doc.createRange();
    live.setStart(r.startContainer, r.startOffset);
    live.setEnd(r.endContainer, r.endOffset);
    const walker = doc.createTreeWalker(root, 0x1 | 0x4 | 0x80 /* SHOW_ELEMENT | SHOW_TEXT | SHOW_COMMENT */);
    const probe = doc.createRange();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === 3) {
        const t = n as Text;
        const s = t === r.startContainer ? r.startOffset : live.comparePoint(t, 0) < 0 ? t.data.length : 0;
        const e = t === r.endContainer ? r.endOffset : live.comparePoint(t, t.data.length) > 0 ? 0 : t.data.length;
        if (e > s) facts.textNodes++;
      } else {
        probe.selectNode(n);
        if (live.compareBoundaryPoints(Range.START_TO_START, probe) <= 0 && live.compareBoundaryPoints(Range.END_TO_END, probe) >= 0) facts.other = true;
      }
    }
  }
  return facts;
}

/** The text an insertion carries: InputEvent.data, else the dataTransfer's text (a drop). */
export function insertedText(e: InputEvent): string | null {
  if (typeof e.data === 'string') return e.data;
  try {
    return e.dataTransfer?.getData('text/plain') ?? null;
  } catch {
    return null;
  }
}

/** A field's DOM at one moment: every element's children and every text node's data, under its root. */
export interface FieldSnapshot {
  root: Element;
  elements: [Element, Node[]][];
  texts: [Text, string][];
}

export function snapshotField(root: Element): FieldSnapshot {
  const elements: [Element, Node[]][] = [[root, Array.from(root.childNodes)]];
  const texts: [Text, string][] = [];
  const walker = root.ownerDocument.createTreeWalker(root, 0x1 | 0x4 /* SHOW_ELEMENT | SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === 3) texts.push([n as Text, (n as Text).data]);
    else elements.push([n as Element, Array.from(n.childNodes)]);
  }
  return { root, elements, texts };
}

function sameChildren(el: Element, kids: readonly Node[]): boolean {
  const now = el.childNodes;
  if (now.length !== kids.length) return false;
  for (let i = 0; i < kids.length; i++) if (now[i] !== kids[i]) return false;
  return true;
}

/** True when the field's DOM is exactly the snapshot (same nodes in the same places, same text). */
export function matchesSnapshot(s: FieldSnapshot): boolean {
  for (const [el, kids] of s.elements) if (!sameChildren(el, kids)) return false;
  for (const [t, data] of s.texts) if (t.data !== data) return false;
  // A node added inside a snapshot element shows up as a children mismatch above.
  return true;
}

/**
 * Puts the field's DOM back to the snapshot: the original nodes in their original places (parents first, in tree
 * order), then their text. The caller wraps it in ScriptTouchTracker.ownChanges, so the parser's own text nodes
 * stay untouched and keep matching their runs (P2-6).
 */
export function restoreField(s: FieldSnapshot): void {
  for (const [el, kids] of s.elements) if (!sameChildren(el, kids)) el.replaceChildren(...kids);
  for (const [t, data] of s.texts) if (t.data !== data) t.data = data;
}
