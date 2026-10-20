// Edit mode in the deck view (6.3; 9.2 "Matching DOM to source at runtime", "Committing an edit" 1–5; decisions
// P2-5 to P2-9, P2-13, P2-14, P2-17). The preload never decides a write: it makes the field, filters what goes
// into it, turns the field's text into one run's edit or a verbatim note with the same code the fuzz gate runs
// (core/edit-commit commitField), and sends that to main, which computes every write from source text (9.1).
//
// Matching (P2-6). Nodes are described exactly as `blueline map`'s render walk describes them: dom-walk
// describeNode with the ScriptTouchTracker that deck.ts started at preload start, so `tracked`, `touched` and
// `stampedAncestor` agree with the map's coverage. The overlay's own changes (the field's typing, write-backs,
// restores) are exempt (ownRegion, ownChanges), so a node the author edited stays the parser's own and keeps
// matching its run. The matcher runs only on a complete map (D-9) of the version the page shows
// (DeckInit.pageVersion, advanced by the page's own html-text writes). When main sends a map of another version
// (an external change waiting to reload, P2-5), an open field may still commit, but outlines go off and no new field
// opens until the page reloads.
//
// The field (9.2 step 1). A press on text the map makes `exact` sets contenteditable="plaintext-only" on the
// innermost element holding the text node, before the browser's own mousedown runs, so the browser focuses it and
// places the caret where the author pressed (checked in Electron 44); each of the element's text nodes is recorded
// with its run (FieldRun, offsets in the element's text). SVG <text> cannot be made contenteditable (Electron 44:
// the attribute does nothing on SVG elements, P2-17), so SVG text is edited in an <input> the overlay places over
// it. A `dashed` (ambiguous) node opens the picker first (P2-8); anything else says "Not editable" (P2-13). None of
// these presses reaches the page (window capture: pointer, mouse and click events are stopped, and a click is
// prevented, so no click-to-advance and no link, P2-17).
//
// Commit (9.2 steps 3–5). Enter commits, Esc cancels, blur commits while the window has focus (a window that loses
// focus blurs the field too, P2-17). commitField gives an edit of one run, a verbatim note, or nothing; the page
// shows the text the file will hold at once (the clean-up and smart quotes applied), and the result puts the
// file's text back (written), or the old text (a note, a refusal). The field stays "busy" until main answers, so a
// reload never lands between a commit and its write (6.6).

import type { AppMode, DeckInit } from '@blueline/core/ipc';
import type { ClientMap, DomTextNode, EditPick, MatchResult } from '@blueline/core/types';
import { createMatcher, type Matcher } from '@blueline/core/matcher';
import { describeNode, stampOf, textIndexOf, type ScriptTouchTracker } from '@blueline/core/dom-walk';
import { commitField, isWellFormedText, type CommitResult, type FieldRun, type VerbatimWhy } from '@blueline/core/edit-commit';
import { cleanupCommit, smartPunctuation } from '@blueline/core/edit-cleanup';
import {
  EDIT_LIMITS,
  EDIT_TOKEN_RE,
  EditDeckToMain,
  RESULT_OUTCOMES,
  VERSION_RE,
  type EditBegin,
  type EditBusy,
  type EditCandidatesRequest,
  type EditCommit,
  type EditResult,
  type EditResultOutcome,
  type EditUndoRequest,
  type PickerCandidate,
} from '@blueline/core/ipc-edit';
import { isWhitespaceOnly } from '@blueline/core/text';
import type { ActiveEdit, DiagSend } from './diagnostics-hooks';
import {
  FieldHistory,
  FieldInputGate,
  affectedRanges,
  classifyInput,
  fieldTextNodes,
  insertedText,
  lineBreaksToSpaces,
  matchesSnapshot,
  rangeFacts,
  readField,
  restoreField,
  snapshotField,
  type FieldNode,
  type FieldSnapshot,
  type InputDecision,
  type RangeFacts,
} from './edit-input';
import { AnimationPause } from './animation-pause';
import { fitContainer, fitWarnings, measureFit, type FitState } from './fit-guard';
import type { PickerKey } from './key-router';
import { listen, listenOn } from './listeners';
import type { Overlay, ViewRect } from './overlay';
import { PickerModel, PickerView, pickable, pickerItems, type PickerHit } from './picker';
import { describeTarget } from './targets';

/** A commit main never answers (a Diagnostics deck, a broken main) is given up after this, and the text restored. */
export const COMMIT_TIMEOUT_MS = 15_000;
/** The picker's candidates request is given up after this. */
const CANDIDATES_TIMEOUT_MS = 10_000;
/** How often an open field checks that the page has not removed it (P2-17). */
const FIELD_WATCH_MS = 300;
/** Maps of other versions kept while the page waits for a reload (P2-5); older ones cannot be the page's next. */
const MAPS_AHEAD_MAX = 16;

const SVG_NS = 'http://www.w3.org/2000/svg';
const STAMP_RE = /^bl-[0-9]{1,9}$/;
/** Elements whose text is never page text, or that the browser edits itself (section 10 step 4; 9.2 Strategy 1 step 4). */
const NO_EDIT_TAGS = new Set(['script', 'style', 'noscript', 'template', 'textarea', 'title', 'input', 'select', 'option']);

/** Why a commit is a verbatim note when the page changed or removed the field while it was open (P2-17). */
const PAGE_CHANGED_WHY: VerbatimWhy = 'page-changed';

// ------------------------------------------------------------------------------------------- pure helpers

/** What a match means in Edit (6.3): `exact` is editable, a pickable ambiguity opens the picker, anything else is not editable. */
export type Editability = { kind: 'exact'; runId: string } | { kind: 'pick'; pick: EditPick['kind'] } | { kind: 'none' };

export function editability(m: MatchResult): Editability {
  if (m.confidence === 'exact' && typeof m.runId === 'string') return { kind: 'exact', runId: m.runId };
  const pick = pickable(m);
  return pick ? { kind: 'pick', pick } : { kind: 'none' };
}

/** 6.3 Hover outlines: solid for exact, dashed for ambiguous (when it can be picked), none otherwise. */
export function outlineKind(e: Editability): 'solid' | 'dashed' | null {
  return e.kind === 'exact' ? 'solid' : e.kind === 'pick' ? 'dashed' : null;
}

/** UTF-8 length, as main's validators count it. */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** Every text of a commit fits EDIT_LIMITS.text (UTF-8) and is well-formed: main would refuse the message otherwise. */
export function commitFits(r: CommitResult): boolean {
  const texts = r.kind === 'edit' ? [r.beforeText, r.afterText] : r.kind === 'verbatim' ? [r.before, r.after] : [];
  return texts.every((t) => utf8Length(t) <= EDIT_LIMITS.text && isWellFormedText(t));
}

/**
 * A verbatim note of the field's whole text (P2-17, a field the page changed), cleaned as commitField cleans one,
 * with the quotes smart punctuation would give it. null when nothing changed.
 */
export function verbatimOf(before: string, raw: string, why: VerbatimWhy, smart: boolean): CommitResult | null {
  const cleaned = cleanupCommit(before, raw);
  if (cleaned === before) return null;
  const after = smart ? smartPunctuation(before, cleaned) : cleaned;
  return { kind: 'verbatim', before, after, why };
}

/** The toast after a written edit (6.3 Saving; P2-14): its text, and the token its Undo sends (null: no Undo). */
export function savedToast(r: { line?: unknown; token?: unknown }, fileName: string | null, alsoPlaces: number): { text: string; token: string | null } {
  const line = Number.isInteger(r.line) && (r.line as number) >= 1 ? (r.line as number) : null;
  let text = line !== null ? `Saved \u00b7 ${fileName ?? 'deck.html'}:${line}` : 'Saved';
  if (alsoPlaces > 0) text += ` \u00b7 also changes ${alsoPlaces} other place${alsoPlaces === 1 ? '' : 's'}`;
  const token = typeof r.token === 'string' && EDIT_TOKEN_RE.test(r.token) ? r.token : null;
  return { text, token };
}

/** The toast after a commit that was not written (6.3 "When a write fails"; P2-14), or null for none. */
export function failureToast(outcome: EditResultOutcome, why: string | null): string | null {
  if (outcome === 'verbatim') return why ? `Not changed in place: ${why} \u00b7 your text is kept as a note` : 'Not changed in place \u00b7 your text is kept as a note';
  if (outcome === 'refused') return why ? `Not saved: ${why}` : 'Not saved';
  return null;
}

/** main's EditResult, rebuilt field by field (main is trusted, but the page shows only what fits). */
export function readResult(p: unknown): EditResult | null {
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  if (!Number.isInteger(o.fieldId) || typeof o.outcome !== 'string' || !(RESULT_OUTCOMES as readonly string[]).includes(o.outcome)) return null;
  const out: EditResult = { fieldId: o.fieldId as number, outcome: o.outcome as EditResultOutcome, reload: o.reload === true };
  const str = (v: unknown, max: number) => (typeof v === 'string' && utf8Length(v) <= max && isWellFormedText(v) ? v : undefined);
  const text = str(o.text, EDIT_LIMITS.text);
  if (text !== undefined) out.text = text;
  if (Number.isInteger(o.line) && (o.line as number) >= 1) out.line = o.line as number;
  const strategy = str(o.strategy, 32);
  if (strategy !== undefined) out.strategy = strategy;
  const noteId = str(o.noteId, 64);
  if (noteId !== undefined) out.noteId = noteId;
  if (typeof o.token === 'string' && EDIT_TOKEN_RE.test(o.token)) out.token = o.token;
  const why = str(o.why, EDIT_LIMITS.why);
  if (why !== undefined) out.why = why;
  return out;
}

/**
 * Whether `next` is `base` with exactly one html-text run changed to `text` (the page's own write, P2-6): then the
 * page, once its node shows `text`, shows `next`, and matching may use it. Anything else (another run changed,
 * literals, keys or shadows changed, stamps renumbered) means the page does not show that version: it waits for a
 * reload. A content check, so it does not depend on the order main's messages arrive in.
 */
export function differsOnlyIn(base: ClientMap, next: ClientMap, runId: string, text: string): boolean {
  if (base.utf8 !== next.utf8 || base.runs.length !== next.runs.length || base.literals.length !== next.literals.length) return false;
  let found = false;
  for (let i = 0; i < base.runs.length; i++) {
    const a = base.runs[i];
    const b = next.runs[i];
    if (a.id !== b.id || a.stamp !== b.stamp || a.textIndex !== b.textIndex) return false;
    if (a.id === runId) {
      if (b.value !== text) return false;
      found = true;
    } else if (a.value !== b.value || a.aligned !== b.aligned) return false;
  }
  if (!found) return false;
  for (let i = 0; i < base.literals.length; i++) {
    const a = base.literals[i];
    const b = next.literals[i];
    if (a.id !== b.id || a.value !== b.value || a.placeholder !== b.placeholder || a.html !== b.html || a.strategy !== b.strategy || a.aligned !== b.aligned) return false;
  }
  const same = (x: readonly string[] | undefined, y: readonly string[] | undefined) => {
    const p = x ?? [];
    const q = y ?? [];
    return p.length === q.length && p.every((v, i) => v === q[i]);
  };
  return same(base.keyValues, next.keyValues) && same(base.shadowValues, next.shadowValues);
}

/** DeckInit's Phase 2 fields (fileName, pageVersion, settings), read defensively: main adds them in Phase 2. */
export function editInitFields(p: DeckInit): { fileName: string | null; pageVersion: string | null; smartPunctuation: boolean } {
  const o = p as unknown as Record<string, unknown>;
  const name = o.fileName;
  // eslint-disable-next-line no-control-regex
  const fileName = typeof name === 'string' && name.length > 0 && name.length <= 1024 && !/[\u0000-\u001f\u007f/\\]/.test(name) && isWellFormedText(name) ? name : null;
  const pageVersion = typeof o.pageVersion === 'string' && VERSION_RE.test(o.pageVersion) ? o.pageVersion : null;
  const settings = o.settings && typeof o.settings === 'object' ? (o.settings as Record<string, unknown>) : null;
  // 6.3: smart punctuation is on by default.
  const smartPunctuation = settings?.smartPunctuation !== false;
  return { fileName, pageVersion, smartPunctuation };
}

// ------------------------------------------------------------------------------------------- fields

/** What a field needs from the controller. */
interface FieldHost {
  readonly doc: Document;
  readonly win: Window;
  readonly tracker: ScriptTouchTracker | null;
  readonly overlay: Overlay;
  diag(event: 'beforeinput' | 'paste' | 'heading-input', data: Record<string, string | number | boolean | null>): void;
  commit(f: Field, cause: CommitCause): void;
  tampered(f: Field): void;
  typed(f: Field): void;
  /** A short message for the author (the overlay's toast). */
  hint(text: string): void;
}

type CommitCause = 'enter' | 'blur' | 'mode' | 'replaced' | 'page' | 'picker';

interface FieldSpec {
  id: number;
  version: string;
  /** The element whose text is the field's text (the contenteditable element, or the SVG text element). */
  root: Element;
  nodes: FieldNode[];
  runs: FieldRun[];
  nodeRun: Map<Text, string>;
  /** The run the author picked in the picker (P2-8), with the kind of pick. */
  pick: { runId: string; kind: EditPick['kind'] } | null;
  /** The text node that was clicked. */
  clicked: Text;
}

/** One open field: the parts the HTML (contenteditable) and SVG (overlay input) fields share. */
abstract class Field implements ActiveEdit {
  abstract readonly element: Element;
  abstract readonly svg: boolean;
  readonly id: number;
  readonly version: string;
  readonly root: Element;
  readonly runs: FieldRun[];
  readonly pick: { runId: string; kind: EditPick['kind'] } | null;
  readonly clicked: Text;
  /** The field's text when it opened (commitField's `before`). */
  readonly before: string;
  closed = false;
  /** The page changed or removed the field while it was open (P2-17). */
  tamperedFlag = false;
  /** The page changed the field's element after it closed, before main answered: nothing is written back then. */
  changedAfterClose = false;
  caretRunId: string | null;
  readonly history = new FieldHistory();
  protected readonly nodeRun: Map<Text, string>;
  /** The DOM when the field opened: restored on cancel, on a note or a refusal, and under a written edit. */
  protected readonly snapshot: FieldSnapshot;
  protected readonly mo: MutationObserver;
  private release: (() => void) | null = null;
  private watch: ReturnType<typeof setInterval> | null = null;
  fitBefore: FitState | null = null;
  fitContainer: Element | null = null;

  constructor(
    protected readonly host: FieldHost,
    spec: FieldSpec,
  ) {
    this.id = spec.id;
    this.version = spec.version;
    this.root = spec.root;
    this.runs = spec.runs;
    this.nodeRun = spec.nodeRun;
    this.pick = spec.pick;
    this.clicked = spec.clicked;
    this.before = spec.root.textContent ?? '';
    this.caretRunId = spec.nodeRun.get(spec.clicked) ?? null;
    this.snapshot = snapshotField(spec.root);
    const MO = (host.win as Window & { MutationObserver: typeof MutationObserver }).MutationObserver;
    // Changes the field did not make through an accepted input or its own writes (which take their records at
    // once) are the page's (P2-17).
    this.mo = new MO((records) => {
      if (records.length === 0) return;
      if (this.closed) this.changedAfterClose = true;
      else this.markTampered();
    });
  }

  /** Starts watching: the overlay's own region (P2-6), the page's changes, the field's removal (P2-17). */
  protected watchPage(): void {
    this.release = this.host.tracker?.ownRegion(this.root) ?? null;
    this.mo.observe(this.root, { subtree: true, childList: true, characterData: true });
    this.watch = setInterval(() => {
      if (!this.root.isConnected) this.markTampered();
    }, FIELD_WATCH_MS);
  }

  /** A field the page took out of the document is one the page changed (P2-17), whatever event noticed it first. */
  noteDetached(): void {
    if (!this.closed && !this.root.isConnected) this.tamperedFlag = true;
  }

  protected markTampered(): void {
    if (this.closed || this.tamperedFlag) return;
    this.tamperedFlag = true;
    this.host.tampered(this);
  }

  commit(): void {
    this.host.commit(this, 'enter');
  }

  cancel(): void {
    // The controller's cancel path (the key router and DeckUi call ActiveEdit.cancel()).
    this.onCancel?.();
  }

  /** Set by the controller. */
  onCancel: (() => void) | null = null;

  /** What the author typed: the field's text now (an SVG field: its text with the input's value in the node). */
  abstract text(): string;

  /** A trusted input event from inside the field, which the input guard stops after this (P2-7). */
  abstract onInputEvent(e: Event): void;

  /** Ends the editing UI (contenteditable, styles, the input). */
  protected abstract endUi(): void;

  /** Focuses the field and puts the caret at the view point, or at the end of the clicked node. */
  abstract focusAt(x: number | null, y: number | null): void;

  /** Rect of the field for badges and the picker. */
  rect(): ViewRect {
    const r = this.root.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  /** The DOM the field opened with, put back (P2-6: the overlay's own change). Skipped when the page changed it. */
  restoreOriginal(): void {
    if (this.tamperedFlag || this.changedAfterClose) return;
    this.own(() => restoreField(this.snapshot));
  }

  /**
   * The file's text in the run's node, over the DOM the field opened with (9.2 step 3: the clean-up and smart
   * punctuation change what the author typed; the node must show what the file holds to keep matching its run).
   */
  writeRun(runId: string, text: string): void {
    if (this.tamperedFlag || this.changedAfterClose) return;
    this.own(() => {
      if (!matchesSnapshot(this.snapshot)) restoreField(this.snapshot);
      for (const [node, id] of this.nodeRun) if (id === runId && node.data !== text) node.data = text;
    });
  }

  /** Runs a DOM change of the field's own: exempt from the tracker, and its records taken so it is not the page's. */
  protected own(fn: () => void): void {
    const t = this.host.tracker;
    if (t) t.ownChanges(fn, this.root);
    else fn();
    this.mo.takeRecords();
  }

  /** Closes the editing UI; the field keeps watching the page until main answers (finish()). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.watch) clearInterval(this.watch);
    this.watch = null;
    this.endUi();
    // Records still queued are the field's own (the last input's) or the page's while it was open (tamperedFlag).
    this.mo.takeRecords();
    this.release?.();
    this.release = null;
  }

  /** Stops watching (main answered, or nothing was sent). */
  finish(): void {
    this.mo.disconnect();
  }
}

/** A deck element made contenteditable="plaintext-only" (9.2 step 1). */
class HtmlField extends Field {
  readonly svg = false;
  readonly element: HTMLElement;
  private readonly gate: FieldInputGate;
  /** The DOM after the last accepted input (P2-7: a change no trusted beforeinput announced goes back to it). */
  private accepted: FieldSnapshot;
  private acceptedText: string;
  private saved: { ce: string | null; styles: [string, string, string][]; sourceCase: boolean } | null = null;

  constructor(host: FieldHost, spec: FieldSpec) {
    super(host, spec);
    this.element = spec.root as HTMLElement;
    this.accepted = this.snapshot;
    this.acceptedText = this.before;
    this.gate = new FieldInputGate(() => readField(this.element, host.win));
  }

  /**
   * Makes the element editable (9.2 step 1) with the file's case showing (6.3 Source case) and text selection on
   * (P2-17). Called inside the press's pointerdown when `focus` is false: the browser's own mousedown then
   * focuses it and places the caret.
   */
  begin(focus: { x: number | null; y: number | null } | null): void {
    const el = this.element;
    const cs = this.host.win.getComputedStyle(el);
    const styles: [string, string, string][] = [];
    const set = (prop: string, value: string) => {
      styles.push([prop, el.style.getPropertyValue(prop), el.style.getPropertyPriority(prop)]);
      el.style.setProperty(prop, value, 'important');
    };
    // 6.3 Source case: reset text-transform and font-variant-caps while editing, so the author types the case the
    // file stores. (::first-letter and ::first-line transforms are not reset.)
    const sourceCase = cs.textTransform !== 'none' || cs.fontVariantCaps !== 'normal';
    if (sourceCase) {
      set('text-transform', 'none');
      set('font-variant-caps', 'normal');
      this.host.overlay.setBadge('Showing source case');
    }
    // P2-17: user-select: none on deck text (common on slides) is lifted while it is edited.
    const us = cs.getPropertyValue('user-select') || cs.getPropertyValue('-webkit-user-select');
    if (us === 'none') {
      set('user-select', 'text');
      set('-webkit-user-select', 'text');
    }
    this.saved = { ce: el.getAttribute('contenteditable'), styles, sourceCase };
    el.setAttribute('contenteditable', 'plaintext-only');
    this.watchPage();
    if (focus) this.focusAt(focus.x, focus.y);
  }

  focusAt(x: number | null, y: number | null): void {
    const el = this.element;
    el.focus({ preventScroll: true });
    const doc = this.host.doc;
    const sel = this.host.win.getSelection();
    if (!sel) return;
    if (x !== null && y !== null && typeof doc.caretPositionFromPoint === 'function') {
      const pos = doc.caretPositionFromPoint(x, y);
      if (pos && el.contains(pos.offsetNode)) {
        sel.collapse(pos.offsetNode, pos.offset);
        return;
      }
    }
    if (el.contains(this.clicked)) sel.collapse(this.clicked, this.clicked.data.length);
  }

  text(): string {
    // A field the page changed: what the author typed is the text of the last accepted input (P2-17).
    return this.tamperedFlag ? this.acceptedText : (this.element.textContent ?? '');
  }

  onInputEvent(e: Event): void {
    switch (e.type) {
      case 'beforeinput':
        this.beforeInput(e as InputEvent);
        break;
      case 'input':
        this.input(e as InputEvent);
        break;
      case 'paste': {
        const text = (e as ClipboardEvent).clipboardData?.getData('text/plain') ?? '';
        this.host.diag('paste', { length: text.length, field: 'edit' });
        break;
      }
    }
  }

  private facts(e: InputEvent): RangeFacts | null {
    const ranges = affectedRanges(e, this.host.win);
    return ranges ? rangeFacts(ranges, this.element) : null;
  }

  private beforeInput(e: InputEvent): void {
    if (this.closed) {
      if (e.cancelable) e.preventDefault();
      return;
    }
    const data = insertedText(e);
    const decision: InputDecision = classifyInput({
      inputType: e.inputType,
      trusted: e.isTrusted,
      cancelable: e.cancelable,
      range: this.facts(e),
      data,
      undoAllowed: this.history.undoAllowed(this.element.textContent ?? '', this.before),
      redoAllowed: this.history.redoAllowed(),
    });
    this.host.diag('beforeinput', { inputType: e.inputType, data: data === null ? null : data.slice(0, 2000), trusted: e.isTrusted, field: 'edit', decision });
    switch (decision) {
      case 'commit':
        e.preventDefault();
        this.host.commit(this, 'enter');
        return;
      case 'block':
        if (e.cancelable) e.preventDefault();
        // 6.3: "Shift+Enter is ignored in v1; ask for a line break with a note."
        if (e.inputType === 'insertLineBreak') this.host.hint('Shift+Enter is ignored: ask for a line break with a note');
        return;
      case 'rewrite': {
        e.preventDefault();
        const text = lineBreaksToSpaces(data ?? '');
        // The field's own insertion: its input (no beforeinput) is accepted by the gate.
        this.gate.own(() => this.host.doc.execCommand('insertText', false, text));
        return;
      }
      case 'allow':
        this.gate.arm(e);
    }
  }

  private input(e: InputEvent): void {
    if (this.closed) return;
    const text = this.element.textContent ?? '';
    const records = this.mo.takeRecords();
    const own = this.gate.owning;
    if (!this.gate.check(e, text)) {
      // P2-7: a change no trusted beforeinput announced (the page's document.execCommand): put the last accepted DOM
      // back. Its step is on the frame's undo stack now, so native undo is off for this field (P2-9).
      this.own(() => restoreField(this.accepted));
      this.history.poison();
      this.host.diag('heading-input', { field: 'edit', refused: true, inputType: e.inputType });
      return;
    }
    this.history.accepted(own ? 'insertText' : e.inputType);
    // The caret's run (9.2 step 4): the recorded node whose text the input changed; the browser may type into the
    // node before or after an element boundary, whatever the selection says (Electron 44).
    let caret: string | null | undefined;
    for (const r of records) {
      if (r.type === 'characterData' && r.target.nodeType === 3 && this.nodeRun.has(r.target as Text)) caret = this.nodeRun.get(r.target as Text);
      else if (r.type === 'characterData' && r.target.nodeType === 3 && this.snapshotHas(r.target as Text)) caret = null;
    }
    if (caret === undefined) {
      const f = this.host.win.getSelection()?.focusNode ?? null;
      if (f && f.nodeType === 3 && this.snapshotHas(f as Text)) caret = this.nodeRun.get(f as Text) ?? null;
    }
    if (caret !== undefined) this.caretRunId = caret;
    this.accepted = snapshotField(this.element);
    this.acceptedText = text;
    this.host.typed(this);
  }

  private snapshotHas(t: Text): boolean {
    return this.snapshot.texts.some(([n]) => n === t);
  }

  protected endUi(): void {
    this.gate.disarm();
    const el = this.element;
    const s = this.saved;
    if (s) {
      if (s.ce === null) el.removeAttribute('contenteditable');
      else el.setAttribute('contenteditable', s.ce);
      for (let i = s.styles.length - 1; i >= 0; i--) {
        const [prop, value, prio] = s.styles[i];
        if (value) el.style.setProperty(prop, value, prio);
        else el.style.removeProperty(prop);
      }
      if (el.getAttribute('style') === '') el.removeAttribute('style');
      if (s.sourceCase) this.host.overlay.setBadge(null);
      this.saved = null;
    }
    const doc = this.host.doc;
    const active = doc.activeElement;
    if (active && (active === el || el.contains(active))) el.blur();
    const sel = this.host.win.getSelection();
    if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) sel.removeAllRanges();
  }
}

/**
 * SVG <text>: an <input> the overlay places over the text node (P2-17; contenteditable does nothing on SVG
 * elements in Electron 44). The input holds the clicked node's text; the field's text is the SVG text element's,
 * with the input's value in place of the node.
 */
class SvgField extends Field {
  readonly svg = true;
  readonly element: HTMLInputElement;
  private readonly gate: FieldInputGate;
  private readonly nodeStart: number;
  private readonly nodeEnd: number;
  private acceptedValue: string;
  private readonly startValue: string;

  constructor(host: FieldHost, spec: FieldSpec, input: HTMLInputElement) {
    super(host, spec);
    this.element = input;
    const fn = spec.nodes.find((n) => n.node === spec.clicked);
    this.nodeStart = fn ? fn.start : 0;
    this.nodeEnd = fn ? fn.end : 0;
    this.startValue = spec.clicked.data;
    this.acceptedValue = this.startValue;
    this.gate = new FieldInputGate(() => ({ text: input.value, start: input.selectionStart ?? input.value.length, end: input.selectionEnd ?? input.value.length }));
  }

  begin(at: { x: number | null; y: number | null }): void {
    const input = this.element;
    const r = this.nodeRect();
    const cs = this.host.win.getComputedStyle(this.root);
    // The rendered size of SVG text depends on the viewBox: take it from the glyphs' box, not the style.
    const size = Math.max(10, Math.round(r.h * 0.78));
    input.value = this.startValue;
    input.style.setProperty('left', `${Math.round(r.x - 4)}px`);
    input.style.setProperty('top', `${Math.round(r.y - 3)}px`);
    input.style.setProperty('width', `${Math.round(Math.max(r.w + 48, 96))}px`);
    input.style.setProperty('height', `${Math.round(r.h + 6)}px`);
    input.style.setProperty('font-size', `${size}px`);
    input.style.setProperty('font-family', cs.fontFamily || 'system-ui, sans-serif');
    input.style.setProperty('font-weight', cs.fontWeight || 'normal');
    input.hidden = false;
    this.watchPage();
    this.focusAt(at.x, at.y);
  }

  private nodeRect(): ViewRect {
    const range = this.host.doc.createRange();
    range.selectNodeContents(this.clicked);
    let b = range.getBoundingClientRect();
    if (!(b.width > 0 && b.height > 0)) b = this.root.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  }

  focusAt(x: number | null, _y?: number | null): void {
    const input = this.element;
    input.focus({ preventScroll: true });
    const r = this.nodeRect();
    const len = input.value.length;
    // The caret where the author clicked, by the click's share of the text's width.
    const at = x !== null && r.w > 0 ? Math.max(0, Math.min(len, Math.round(((x - r.x) / r.w) * len))) : len;
    input.setSelectionRange(at, at);
  }

  text(): string {
    const value = this.tamperedFlag ? this.acceptedValue : this.element.value;
    return this.before.slice(0, this.nodeStart) + value + this.before.slice(this.nodeEnd);
  }

  onInputEvent(e: Event): void {
    if (e.type === 'beforeinput') this.beforeInput(e as InputEvent);
    else if (e.type === 'input') this.input(e as InputEvent);
    else if (e.type === 'paste') {
      const text = (e as ClipboardEvent).clipboardData?.getData('text/plain') ?? '';
      this.host.diag('paste', { length: text.length, field: 'edit' });
    }
  }

  private beforeInput(e: InputEvent): void {
    if (this.closed) {
      if (e.cancelable) e.preventDefault();
      return;
    }
    const input = this.element;
    const start = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? 0;
    const data = insertedText(e);
    // The input holds one text node's text: every range is inside the active node.
    const decision = classifyInput({
      inputType: e.inputType,
      trusted: e.isTrusted,
      cancelable: e.cancelable,
      range: { collapsed: start === end, textNodes: 1, other: false, inField: true },
      data,
      undoAllowed: this.history.undoAllowed(input.value, this.startValue),
      redoAllowed: this.history.redoAllowed(),
    });
    this.host.diag('beforeinput', { inputType: e.inputType, data: data === null ? null : data.slice(0, 2000), trusted: e.isTrusted, field: 'edit', decision });
    if (decision === 'commit') {
      e.preventDefault();
      this.host.commit(this, 'enter');
    } else if (decision === 'block') {
      if (e.cancelable) e.preventDefault();
    } else if (decision === 'rewrite') {
      e.preventDefault();
      const text = lineBreaksToSpaces(data ?? '');
      this.gate.own(() => this.host.doc.execCommand('insertText', false, text));
    } else this.gate.arm(e);
  }

  private input(e: InputEvent): void {
    if (this.closed) return;
    const input = this.element;
    const own = this.gate.owning;
    if (!this.gate.check(e, input.value)) {
      const caret = Math.min(this.acceptedValue.length, input.selectionEnd ?? this.acceptedValue.length);
      input.value = this.acceptedValue;
      input.setSelectionRange(caret, caret);
      this.history.poison();
      return;
    }
    this.history.accepted(own ? 'insertText' : e.inputType);
    this.acceptedValue = input.value;
    this.host.typed(this);
  }

  override rect(): ViewRect {
    return this.nodeRect();
  }

  protected endUi(): void {
    this.gate.disarm();
    const input = this.element;
    if (this.host.overlay.shadowRoot.activeElement === input) input.blur();
    input.hidden = true;
    input.value = '';
  }
}

// ------------------------------------------------------------------------------------------- the controller

export interface EditControllerDeps {
  send(channel: string, payload?: unknown): void;
  /** The ScriptTouchTracker deck.ts started at preload start (P2-6), or null (then no node is `tracked`). */
  tracker: ScriptTouchTracker | null;
  /** The slide the element is on (9.4), or null. */
  slideOf(el: Element): number | null;
  /** The field opened or closed: DeckUi sets its ActiveEdit (key routing, focus reports). */
  onActiveChange(edit: ActiveEdit | null): void;
  /** The busy state changed: report it now (6.6: a reload waits for an open field and a commit in flight). */
  onBusyChange(): void;
  /** A press that opens a field or the picker closes the open note card (6.4). */
  closeCard(): void;
  diag?: DiagSend;
}

/** A commit sent to main, waiting for its EditResult. */
interface Pending {
  field: Field;
  result: CommitResult;
  /** "· also changes N other places", counted when it was sent (6.3 Saving). */
  alsoPlaces: number;
  timer: ReturnType<typeof setTimeout>;
}

/** The press being handled at window capture, and what its click does. */
type Gesture =
  | { kind: 'overlay'; run: (() => void) | null }
  | { kind: 'field' }
  | { kind: 'opened'; x: number; y: number }
  | { kind: 'pick'; node: Text; match: MatchResult; pick: EditPick['kind']; x: number; y: number }
  | { kind: 'svg'; node: Text; runId: string; x: number; y: number }
  | { kind: 'refuse'; text: string }
  | { kind: 'swallow' };

interface PickerState {
  id: number;
  version: string;
  node: Text;
  data: string;
  pick: EditPick['kind'];
  requested: Set<string>;
  x: number;
  y: number;
  model: PickerModel | null;
  timer: ReturnType<typeof setTimeout>;
}

export class EditController implements FieldHost {
  readonly tracker: ScriptTouchTracker | null;
  private mode: AppMode = 'read';
  private capEdit = false;
  private editingAllowed = false;
  private fileName: string | null = null;
  private smart = true;
  /** The version of the served copy this page shows (P2-5, P2-6). */
  private pageVersion: string | null = null;
  /** The complete map of that version (D-9), or null while main finishes it. */
  private pageMap: ClientMap | null = null;
  /** Maps main sent for other versions since: the page waits for a reload, or for its own write's answer. */
  private mapsAhead: ClientMap[] = [];
  /** main said the last map is null (the deck is not UTF-8 any more, or has no map). */
  private latestNull = false;
  /** A write asked the page to reload once the field closes (a literal write, P2-4), or main said it will. */
  private reloadPending = false;
  private matcher: { version: string; m: Matcher } | null = null;
  private field: Field | null = null;
  private readonly pending = new Map<number, Pending>();
  private picker: PickerState | null = null;
  private readonly pickerView: PickerView;
  private readonly svgInput: HTMLInputElement;
  private nextId = 1;
  private gesture: Gesture | null = null;
  private pointer: { x: number; y: number } | null = null;
  private hoverScheduled = false;
  private fitScheduled = false;
  private readonly pause: AnimationPause;
  private readonly deferredApplied: { stamp: string; textIndex: number; text: string }[] = [];
  private lastBusy = '';
  /** Elements that were edit fields (P2-9: their steps stay on the frame's undo stack after they close). */
  private readonly pastRoots = new WeakSet<Element>();
  /** Fields the page changed or removed while they were open: their text is script text from then on (P2-6). */
  private readonly pageChanged = new WeakSet<Element>();
  /** The page's own html-text writes main answered before sending their map (P2-6: advance when it comes). */
  private awaitingMap: { runId: string; text: string }[] = [];

  constructor(
    readonly doc: Document,
    readonly win: Window,
    readonly overlay: Overlay,
    private readonly deps: EditControllerDeps,
  ) {
    this.tracker = deps.tracker;
    this.pause = new AnimationPause(() => this.doc);
    this.pickerView = new PickerView(doc, overlay.parts.edit);
    this.svgInput = doc.createElement('input');
    this.svgInput.type = 'text';
    // Not `chrome`: hiding it for a screenshot (6.7) would blur, and so commit, the open field.
    this.svgInput.className = 'svg-field';
    this.svgInput.hidden = true;
    this.svgInput.spellcheck = true;
    this.svgInput.autocomplete = 'off';
    this.svgInput.setAttribute('aria-label', 'Edit text');
    overlay.parts.edit.append(this.svgInput);
    // 6.3 "blur commits", for the SVG input (an HTML field's blur is seen at window capture, below).
    listenOn(this.svgInput, 'blur', () => this.onFieldBlur());
  }

  /**
   * Registers the window listeners. Must run at preload start, before any page script (so the page never sees a
   * press on editable text) and before the link reporter (so such a press on link text is not reported as a link
   * click). Through listen(), so document.open() does not erase them for good.
   */
  install(): void {
    const w = this.win;
    listen(w, 'pointerdown', (e) => this.onPointerDown(e), true);
    for (const type of ['mousedown', 'pointerup', 'mouseup', 'dblclick', 'auxclick'] as const) listen(w, type, (e) => this.onGestureEvent(e), true);
    listen(w, 'click', (e) => this.onClick(e), true);
    // Starting a selection in the field is the author's: a page cannot cancel it (decks often cancel selectstart).
    listen(w, 'selectstart', (e) => this.onSelectStart(e), true);
    listen(w, 'focusout', (e) => this.onFocusOut(e), true);
    listen(
      w,
      'pointermove',
      (e) => {
        if (!e.isTrusted) return;
        this.pointer = { x: e.clientX, y: e.clientY };
        this.scheduleHover();
      },
      { capture: true, passive: true },
    );
    // The pointer left the deck view (to the shell, or out of the window): no text is hovered.
    listen(
      w,
      'mouseout',
      (e) => {
        if (!e.isTrusted || e.relatedTarget !== null) return;
        this.pointer = null;
        this.overlay.showOutline(null);
      },
      { capture: true, passive: true },
    );
    listen(w, 'scroll', () => this.onLayout(), { capture: true, passive: true });
    listen(w, 'resize', () => this.onLayout(), { passive: true });
  }

  // ------------------------------------------------------------------------------------------- state from main

  applyInit(p: DeckInit): void {
    this.capEdit = !!p.capabilities && p.capabilities.edit === true;
    this.editingAllowed = p.editingAllowed === true;
    const f = editInitFields(p);
    this.fileName = f.fileName;
    this.smart = f.smartPunctuation;
    this.pageVersion = f.pageVersion;
    this.pageMap = null;
    this.mapsAhead = [];
    this.awaitingMap = [];
    this.latestNull = false;
    this.reloadPending = false;
    this.matcher = null;
    // The map in DeckInit comes through DeckUi.applyMap, as MainToDeck.map does.
  }

  /**
   * MainToDeck.settings (DeckSettingsUpdate): Settings › General's smart punctuation default changed after the
   * init (6.3). It applies from the next commit on; a missing or malformed value changes nothing.
   */
  applySettings(p: unknown): void {
    const v = p && typeof p === 'object' ? (p as { smartPunctuation?: unknown }).smartPunctuation : undefined;
    if (typeof v === 'boolean') this.smart = v;
  }

  /** MainToDeck.appMode (the mode, and whether editing is allowed now). */
  applyAppMode(mode: AppMode, editingAllowed?: boolean): void {
    this.mode = mode;
    if (typeof editingAllowed === 'boolean') this.editingAllowed = editingAllowed;
    if (mode === 'edit') {
      // 6.3: animations pause on entering Edit (and again when a field opens: new Web Animations may have started).
      if (!this.pause.active) this.pause.pause();
    } else {
      if (this.field) this.commit(this.field, 'mode');
      this.closePicker();
      this.overlay.showOutline(null);
      this.overlay.setFitBadge(null);
      // 6.3: resumed exactly on leaving Edit: only what the pause paused, and the sheet removed.
      this.pause.resume();
    }
    if (!this.active()) {
      this.overlay.showOutline(null);
      // Editing stopped being allowed in Edit (6.10): the open field ends as a blur would end it, and main decides.
      if (this.field) this.commit(this.field, 'mode');
      this.closePicker();
    }
  }

  /** MainToDeck.map: the complete map of a version, or null. */
  applyMap(p: unknown): void {
    if (!p || typeof p !== 'object' || typeof (p as ClientMap).version !== 'string' || !Array.isArray((p as ClientMap).runs)) {
      // No map: the deck is not UTF-8, or main has none for this version yet (D-9 sends null with mapPending).
      if (p === null && this.pageMap) this.latestNull = true;
      this.refreshAvailability();
      return;
    }
    const m = p as ClientMap;
    this.latestNull = false;
    // Without DeckInit.pageVersion (a main from before Phase 2), the first complete map is taken as the page's.
    if (this.pageVersion === null) this.pageVersion = m.version;
    if (m.version === this.pageVersion) {
      this.pageMap = m;
      // The newest map is the page's version again (a change reverted): the page shows what main holds.
      this.mapsAhead = [];
    } else {
      this.mapsAhead.push(m);
      if (this.mapsAhead.length > MAPS_AHEAD_MAX) this.mapsAhead.shift();
      // The page's own write that main answered before this map came (P2-6).
      const base = this.pageMap;
      const k = base ? this.awaitingMap.findIndex((w) => differsOnlyIn(base, m, w.runId, w.text)) : -1;
      if (k >= 0) {
        const w = this.awaitingMap.splice(k, 1)[0];
        this.advance(w.runId, w.text);
      }
    }
    this.refreshAvailability();
  }

  // ------------------------------------------------------------------------------------------- what DeckUi asks

  /** The open field's element (ActiveEdit.element), or null. */
  get activeField(): Field | null {
    return this.field;
  }

  /** The deck element the input guard routes events of (P2-7): the contenteditable element, never the overlay input. */
  fieldElement(): Element | null {
    return this.field && !this.field.svg && !this.field.closed ? this.field.element : null;
  }

  /** The SVG field's overlay input when it is the open field, else null. */
  svgFieldInput(): HTMLInputElement | null {
    return this.field && this.field.svg && !this.field.closed ? (this.field.element as HTMLInputElement) : null;
  }

  /**
   * P2-9: true for a native undo or redo aimed at an element that was an edit field and is not the open one.
   * Chromium keeps one undo stack per frame: once a field's own steps are undone, the next Cmd+Z targets the
   * previous field's element (Electron 44: beforeinput historyUndo fires there, not in the open field), whose text
   * main has written since. The input guard cancels it, so the step stays where it is and redo still reaches the
   * open field's own undone steps.
   */
  foreignHistory(e: Event): boolean {
    if (e.type !== 'beforeinput') return false;
    const t = (e as InputEvent).inputType;
    if (t !== 'historyUndo' && t !== 'historyRedo') return false;
    const path = e.composedPath();
    const real = (path.length > 0 ? path[0] : e.target) as Node | null;
    if (!real || typeof real.nodeType !== 'number') return false;
    const open = this.field && !this.field.svg && !this.field.closed ? this.field.element : null;
    if (open && (open === real || open.contains(real))) return false;
    for (let n: Node | null = real; n; n = n.parentNode) if (n.nodeType === 1 && this.pastRoots.has(n as Element)) return true;
    return false;
  }

  /** A trusted event from inside the open field (the input guard calls this, then stops the event). */
  onFieldEvent(e: Event): void {
    this.field?.onInputEvent(e);
  }

  /** Field open, and commits main has not answered (6.6 reload rules; EditBusy). */
  busy(): EditBusy {
    return { edit: this.field !== null, committing: this.pending.size > 0 };
  }

  get pickerOpen(): boolean {
    return this.picker !== null;
  }

  /** Esc with the picker open closes it (DeckUi's Esc order: help, picker, card, edit, Read). */
  closePickerIfOpen(): boolean {
    if (!this.picker) return false;
    this.closePicker();
    return true;
  }

  onPickerKey(k: PickerKey): void {
    const p = this.picker;
    if (!p) return;
    if (k === 'cancel') {
      this.closePicker();
      return;
    }
    if (!p.model) return;
    if ('move' in k) {
      p.model.move(k.move);
      this.pickerView.highlight(p.model.index);
      return;
    }
    const c = p.model.choose(k.choose === 'current' ? undefined : k.choose);
    if (c) this.choose(c);
  }

  /** The text Edit shows for a page whose text cannot be edited now, or null when it can. */
  blockedReason(): string | null {
    if (!this.capEdit || !this.editingAllowed) return 'Editing is off for this deck';
    if (!this.pageMap) return 'Getting the deck ready to edit\u2026';
    if (!this.pageMap.utf8) return 'Not editable: this deck is not UTF-8';
    if (this.reloadPending) return 'Reloading to show your edit\u2026';
    if (this.mapsAhead.length > 0 || this.latestNull) return 'Deck changed \u00b7 reloads when you finish';
    return null;
  }

  // ------------------------------------------------------------------------------------------- FieldHost

  diag(event: 'beforeinput' | 'paste' | 'heading-input', data: Record<string, string | number | boolean | null>): void {
    this.deps.diag?.(event, data);
  }

  tampered(f: Field): void {
    // P2-17: the page removed or re-rendered the open field: what was typed becomes a verbatim note now, before the
    // page changes it further.
    if (f === this.field) this.commit(f, 'page');
  }

  typed(f: Field): void {
    if (f !== this.field) return;
    this.scheduleFit();
  }

  hint(text: string): void {
    this.toast(text);
  }

  // ------------------------------------------------------------------------------------------- availability

  private active(): boolean {
    return this.mode === 'edit' && this.capEdit && this.editingAllowed;
  }

  private matcherNow(): Matcher | null {
    const m = this.pageMap;
    if (!m) return null;
    if (!this.matcher || this.matcher.version !== m.version || this.matcherMap !== m) {
      this.matcher = { version: m.version, m: createMatcher(m, { fileName: this.fileName ?? undefined }) };
      this.matcherMap = m;
    }
    return this.matcher.m;
  }

  private matcherMap: ClientMap | null = null;

  private refreshAvailability(): void {
    if (this.blockedReason()) {
      this.overlay.showOutline(null);
      // No new field opens on a stale page (P2-5); a picker for the old version would open one.
      this.closePicker();
    } else this.scheduleHover();
  }

  // ------------------------------------------------------------------------------------------- hit testing

  /** The visible, non-blank text node under a view point, outside the overlay and form controls, or null. */
  private textAt(x: number, y: number): Text | null {
    const doc = this.doc;
    let node: Node | null = null;
    if (typeof doc.caretPositionFromPoint === 'function') node = doc.caretPositionFromPoint(x, y)?.offsetNode ?? null;
    else {
      const legacy = (doc as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint;
      node = legacy ? (legacy.call(doc, x, y)?.startContainer ?? null) : null;
    }
    if (!node || node.nodeType !== 3) return null;
    const t = node as Text;
    if (isWhitespaceOnly(t.data) || !t.parentElement) return null;
    for (let a: Element | null = t.parentElement; a; a = a.parentElement) {
      if (a === this.overlay.host || NO_EDIT_TAGS.has(a.localName)) return null;
    }
    // caretPositionFromPoint answers the nearest text for a point in padding or a margin: the point must be on it.
    const range = doc.createRange();
    range.selectNodeContents(t);
    for (const r of Array.from(range.getClientRects())) {
      if (x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2) return t;
    }
    return null;
  }

  /**
   * The node as the render walk describes it (P2-6), except that text inside an element the page changed while it
   * was an open field counts as touched: the tracker held that element as the overlay's own then (ownRegion), so it
   * did not see the page's change.
   */
  private describe(t: Text): DomTextNode {
    const d = describeNode(t, this.tracker);
    if (d.touched !== true && this.tracker) {
      for (let a = t.parentElement; a; a = a.parentElement) {
        if (!this.pageChanged.has(a)) continue;
        d.touched = true;
        for (let s = t.parentElement; s; s = s.parentElement) {
          const st = stampOf(s);
          if (st) {
            d.stampedAncestor = st;
            break;
          }
        }
        break;
      }
    }
    return d;
  }

  private matchOf(t: Text): MatchResult | null {
    const m = this.matcherNow();
    return m ? m(this.describe(t)) : null;
  }

  private editabilityOf(t: Text): Editability {
    const m = this.matchOf(t);
    return m ? editability(m) : { kind: 'none' };
  }

  private nodeRect(t: Node): ViewRect | null {
    const range = this.doc.createRange();
    range.selectNodeContents(t);
    const r = range.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return null;
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  // ------------------------------------------------------------------------------------------- hover

  private scheduleHover(): void {
    if (this.hoverScheduled) return;
    this.hoverScheduled = true;
    this.win.requestAnimationFrame(() => {
      this.hoverScheduled = false;
      this.updateHover();
    });
  }

  /** 6.3 Hover outlines: solid over `exact` text, dashed over ambiguous text the picker can offer, none otherwise. */
  private updateHover(): void {
    const p = this.pointer;
    if (!p || !this.active() || this.blockedReason() || this.picker) {
      this.overlay.showOutline(null);
      return;
    }
    const t = this.textAt(p.x, p.y);
    if (!t || (this.field && !this.field.closed && (this.field.root === t.parentElement || this.field.root.contains(t)))) {
      this.overlay.showOutline(null);
      return;
    }
    const kind = outlineKind(this.editabilityOf(t));
    this.overlay.showOutline(kind ? this.nodeRect(t) : null, kind ?? 'solid');
  }

  private onLayout(): void {
    this.scheduleHover();
    if (this.field) this.scheduleFit();
  }

  // ------------------------------------------------------------------------------------------- presses

  private onPointerDown(e: PointerEvent): void {
    if (!e.isTrusted) return;
    this.gesture = null;
    const path = e.composedPath();
    const real = path.length > 0 ? path[0] : e.target;
    const x = e.clientX;
    const y = e.clientY;
    if (real === this.overlay.host) {
      this.overlayPress(e, x, y);
      return;
    }
    // A press anywhere else closes the picker (it belongs to the text it was opened on).
    if (this.picker) this.closePicker();
    if (this.mode !== 'edit') return;
    const f = this.field;
    if (f && !f.svg && !f.closed && real && f.element.contains(real as Node)) {
      // Inside the open field: the browser moves the caret or selects; the page never sees it.
      e.stopImmediatePropagation();
      this.gesture = { kind: 'field' };
      return;
    }
    const t = this.textAt(x, y);
    // Not on text: the press is the page's (an open field loses focus and commits, 6.3).
    if (!t) return;
    // On text in Edit, the press is Blueline's (P2-13, P2-17): the page never sees it. Like any press on the deck
    // in Edit, it closes the open note card (6.4).
    e.stopImmediatePropagation();
    this.deps.closeCard();
    if (e.button !== 0) {
      e.preventDefault();
      this.gesture = { kind: 'swallow' };
      return;
    }
    const why = this.blockedReason();
    if (why) {
      e.preventDefault();
      this.gesture = { kind: 'refuse', text: why };
      return;
    }
    const match = this.matchOf(t);
    const ed: Editability = match ? editability(match) : { kind: 'none' };
    const svg = t.parentElement?.namespaceURI === SVG_NS;
    if (ed.kind === 'exact' && !svg) {
      const busy = this.busyOn(t.parentElement);
      if (busy) {
        e.preventDefault();
        this.gesture = { kind: 'refuse', text: busy };
        return;
      }
      this.deps.closeCard();
      if (this.field) this.commit(this.field, 'replaced');
      // No preventDefault: the browser's mousedown focuses the field and places the caret where the author pressed.
      if (this.openField(t, ed.runId, null, null)) {
        this.gesture = { kind: 'opened', x, y };
        return;
      }
      e.preventDefault();
      this.gesture = { kind: 'refuse', text: 'Not editable' };
      return;
    }
    // Everything else acts on the click; nothing moves focus or starts a selection meanwhile.
    e.preventDefault();
    if (ed.kind === 'exact') this.gesture = { kind: 'svg', node: t, runId: ed.runId, x, y };
    else if (ed.kind === 'pick' && match) this.gesture = { kind: 'pick', node: t, match, pick: ed.pick, x, y };
    else this.gesture = { kind: 'refuse', text: 'Not editable' };
  }

  /** A press over the overlay: Edit's own panels (the picker, the toast's button) take it at window capture. */
  private overlayPress(e: PointerEvent, x: number, y: number): void {
    const el = this.overlay.elementAt(x, y);
    const pick = this.pickerView.hit(el);
    const toast = this.overlay.toastAction(el);
    if (!pick && !toast && !this.overlay.inToast(el)) return;
    // Page capture listeners would see the press retargeted to the host (a click-to-advance deck would move); the
    // panel's buttons work from here instead, and no focus moves (an open field stays open).
    e.stopImmediatePropagation();
    e.preventDefault();
    this.gesture = { kind: 'overlay', run: pick ? () => this.onPickerHit(pick) : toast };
  }

  private onGestureEvent(e: MouseEvent): void {
    if (!e.isTrusted || !this.gesture) return;
    e.stopImmediatePropagation();
    if (this.gesture.kind !== 'field' && this.gesture.kind !== 'opened') e.preventDefault();
  }

  private onClick(e: MouseEvent): void {
    if (!e.isTrusted) return;
    const g = this.gesture;
    if (!g) return;
    e.stopImmediatePropagation();
    // A link in the text never navigates (P2-17).
    e.preventDefault();
    switch (g.kind) {
      case 'overlay':
        this.gesture = null;
        g.run?.();
        return;
      case 'field':
      case 'swallow':
        return;
      case 'opened': {
        // The browser normally focused the field on the press; make sure (a page style may have stopped it).
        const f = this.field;
        if (f && !f.closed && this.doc.activeElement !== f.element) f.focusAt(g.x, g.y);
        this.gesture = { kind: 'field' };
        return;
      }
      case 'pick':
        this.gesture = null;
        this.deps.closeCard();
        if (this.field) this.commit(this.field, 'replaced');
        this.openPicker(g);
        return;
      case 'svg':
        this.gesture = null;
        this.deps.closeCard();
        if (this.field) this.commit(this.field, 'replaced');
        if (!this.openField(g.node, g.runId, null, { x: g.x, y: g.y })) this.toast('Not editable');
        return;
      case 'refuse':
        this.gesture = null;
        // The press did not move focus: an open field still ends as a blur would end it (6.3).
        if (this.field) this.commit(this.field, 'blur');
        this.toast(g.text);
        return;
    }
  }

  private onSelectStart(e: Event): void {
    const f = this.field;
    if (!e.isTrusted || !f || f.svg || f.closed) return;
    const t = e.target as Node | null;
    if (t && (t === f.element || f.element.contains(t))) e.stopImmediatePropagation();
  }

  private onFocusOut(e: FocusEvent): void {
    const f = this.field;
    if (!e.isTrusted || !f || f.svg || f.closed) return;
    const t = e.target as Node | null;
    if (!t || !(t === f.element || f.element.contains(t))) return;
    this.onFieldBlur();
  }

  /**
   * 6.3 "blur commits", only while the window has focus (P2-17): Cmd+Tab, a system panel or a dictation window
   * blurs the field too (Electron 44: focusout with document.hasFocus() false), and the field gets focus back
   * when the window does. Decided after the focus change, so a caret move inside the field is not a blur.
   */
  private onFieldBlur(): void {
    const f = this.field;
    if (!f || f.closed) return;
    setTimeout(() => {
      if (this.field !== f || f.closed) return;
      if (!this.doc.hasFocus()) return;
      if (f.svg) {
        if (this.overlay.shadowRoot.activeElement === f.element) return;
      } else {
        const a = this.doc.activeElement;
        if (a && (a === f.element || f.element.contains(a))) return;
      }
      this.commit(f, 'blur');
    }, 0);
  }

  // ------------------------------------------------------------------------------------------- the field

  /** Why no field may open on this element now (a commit for it is still in flight), or null. */
  private busyOn(el: Element | null): string | null {
    if (!el) return 'Not editable';
    for (const p of this.pending.values()) {
      const r = p.field.root;
      if (r === el || r.contains(el) || el.contains(r)) return 'Saving\u2026';
    }
    return null;
  }

  /**
   * Opens the field on the innermost element holding `t` (9.2 step 1): records each of its text nodes with its run
   * (the clicked one with `runId`, or the picked run), and tells main (EditBegin, P2-7). `focus` null means the
   * press's own mousedown will focus it.
   */
  private openField(t: Text, runId: string, pick: { runId: string; kind: EditPick['kind'] } | null, focus: { x: number; y: number } | null): boolean {
    const version = this.pageVersion;
    const matcher = this.matcherNow();
    const el = t.parentElement;
    if (!version || !matcher || !el || !t.isConnected) return false;
    const svg = el.namespaceURI === SVG_NS;
    const nodes = fieldTextNodes(el);
    const text = el.textContent ?? '';
    if (utf8Length(text) > EDIT_LIMITS.text) {
      this.toast('Not editable: this text is too long to edit in place');
      return false;
    }
    const runs: FieldRun[] = [];
    const nodeRun = new Map<Text, string>();
    const add = (fn: FieldNode, id: string) => {
      runs.push({ runId: id, start: fn.start, end: fn.end, value: fn.node.data });
      nodeRun.set(fn.node, id);
    };
    const clicked = nodes.find((n) => n.node === t);
    if (!clicked) return false;
    add(clicked, runId);
    for (const fn of nodes) {
      if (fn.node === t || runs.length >= EDIT_LIMITS.runIds) continue;
      if (isWhitespaceOnly(fn.node.data)) continue;
      let skip = false;
      for (let a = fn.node.parentElement; a && a !== el; a = a.parentElement) if (NO_EDIT_TAGS.has(a.localName)) skip = true;
      if (skip) continue;
      const m = matcher(this.describe(fn.node));
      if (m.confidence === 'exact' && typeof m.runId === 'string') add(fn, m.runId);
    }
    runs.sort((a, b) => a.start - b.start);
    const spec: FieldSpec = { id: this.nextId++, version, root: el, nodes, runs, nodeRun, pick, clicked: t };
    let field: Field;
    if (svg) {
      const f = new SvgField(this, spec, this.svgInput);
      field = f;
      f.onCancel = () => this.cancel(f);
      this.field = f;
      f.begin({ x: focus?.x ?? null, y: focus?.y ?? null });
    } else {
      const f = new HtmlField(this, spec);
      field = f;
      f.onCancel = () => this.cancel(f);
      this.field = f;
      f.begin(focus ? { x: focus.x, y: focus.y } : null);
    }
    // 6.3: whatever started running since Edit began (a slide change's Web Animations) pauses too.
    this.pause.pause();
    this.overlay.showOutline(null);
    field.fitContainer = svg ? null : fitContainer(el, this.win);
    field.fitBefore = svg ? null : measureFit(el, this.win, field.fitContainer);
    this.deps.onActiveChange(field);
    const begin: EditBegin = { fieldId: field.id, version, runIds: [...new Set(runs.map((r) => r.runId))] };
    this.deps.send(EditDeckToMain.begin, begin);
    this.reportBusy();
    return true;
  }

  /** Esc (6.3): the field's text goes back to what it was; nothing is sent. */
  private cancel(f: Field): void {
    if (f !== this.field || f.closed) return;
    f.restoreOriginal();
    this.endField(f);
    f.finish();
    this.afterClose();
  }

  private endField(f: Field): void {
    f.close();
    if (!f.svg) this.pastRoots.add(f.root);
    if (f.tamperedFlag) this.pageChanged.add(f.root);
    if (this.field === f) this.field = null;
    this.overlay.setFitBadge(null);
    this.deps.onActiveChange(null);
  }

  /**
   * Ends the field and sends its commit (9.2 steps 3–5). The page shows the text the file will hold at once (the
   * clean-up and smart punctuation applied); a verbatim note keeps the typed text until main answers.
   */
  commit(f: Field, cause: CommitCause): void {
    if (f !== this.field || f.closed) return;
    // Removing the focused field blurs it: the blur's commit may come before the watch notices the removal.
    f.noteDetached();
    const before = f.before;
    const after = f.text();
    let result: CommitResult = commitField({ before, after, runs: f.runs, caretRunId: f.caretRunId }, { smartPunctuation: this.smart });
    // P2-17: a field the page changed or removed: what was typed becomes a verbatim note, never a write.
    if (f.tamperedFlag && result.kind === 'edit') result = verbatimOf(before, after, PAGE_CHANGED_WHY, this.smart) ?? { kind: 'noop' };
    if (result.kind !== 'noop' && !commitFits(result)) {
      f.restoreOriginal();
      this.endField(f);
      f.finish();
      this.toast('Not saved: the text is too long to send');
      this.afterClose();
      return;
    }
    if (result.kind === 'noop') {
      f.restoreOriginal();
      this.endField(f);
      f.finish();
      this.afterClose();
      return;
    }
    if (result.kind === 'edit') f.writeRun(result.runId, result.afterText);
    const target = describeTarget(f.svg ? f.root : f.element);
    const slide = this.deps.slideOf(f.root);
    const alsoPlaces = result.kind === 'edit' ? this.alsoPlaces(f, result) : 0;
    const msg: EditCommit = {
      fieldId: f.id,
      version: f.version,
      result,
      target,
      slide: slide !== null && Number.isInteger(slide) && slide >= 0 && slide < EDIT_LIMITS.slide ? slide : null,
      alsoPlaces: Math.min(alsoPlaces, EDIT_LIMITS.alsoPlaces),
    };
    // A picked run (P2-8): main lifts the node's edit to the run (liftPick) and the queue checks it again.
    if (result.kind === 'edit' && f.pick && f.pick.runId === result.runId) {
      msg.pick = { kind: f.pick.kind, nodeBefore: result.beforeText, nodeAfter: result.afterText };
    }
    // In flight before the field closes, so the busy state never reads idle between the two (6.6: a reload that
    // lands then would lose the edit).
    const timer = setTimeout(() => this.timedOut(f.id), COMMIT_TIMEOUT_MS);
    this.pending.set(f.id, { field: f, result, alsoPlaces: msg.alsoPlaces, timer });
    this.endField(f);
    this.deps.send(EditDeckToMain.commit, msg);
    this.diag('heading-input', { field: 'edit', committed: true, kind: result.kind, cause });
    this.afterClose();
  }

  /** "· also changes N other places" (6.3 Saving): other visible nodes the same run feeds, as the map matches them. */
  private alsoPlaces(f: Field, r: { runId: string; beforeText: string }): number {
    if (f.pick && f.pick.kind !== 'equal' && f.pick.runId === r.runId) return 0;
    const m = this.matcherNow();
    const root = this.doc.body ?? this.doc.documentElement;
    if (!m || !root) return 0;
    let n = 0;
    const walker = this.doc.createTreeWalker(root, 0x4 /* SHOW_TEXT */);
    for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
      if (t.data !== r.beforeText || f.root.contains(t) || this.overlay.host.contains(t)) continue;
      if (!this.onScreen(t)) continue;
      const res = m(this.describe(t));
      if (res.confidence === 'exact' && res.runId === r.runId && ++n >= EDIT_LIMITS.alsoPlaces) break;
    }
    return n;
  }

  /**
   * The node shows on screen now: section 10 step 4's test (a non-zero box in the viewport, visible, not
   * transparent), read fresh. (DomWalker.isVisible keeps its ancestors' styles from the walk that last began, so
   * it is not used outside a walk.)
   */
  private onScreen(t: Text): boolean {
    const el = t.parentElement;
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    if (r.right <= 0 || r.bottom <= 0 || r.left >= this.win.innerWidth || r.top >= this.win.innerHeight) return false;
    const check = (el as Element & { checkVisibility?: (o: Record<string, boolean>) => boolean }).checkVisibility;
    return typeof check === 'function' ? check.call(el, { opacityProperty: true, visibilityProperty: true }) : true;
  }

  private afterClose(): void {
    this.reportBusy();
    this.flushApplied();
    this.scheduleHover();
  }

  private timedOut(fieldId: number): void {
    const p = this.pending.get(fieldId);
    if (!p) return;
    this.pending.delete(fieldId);
    p.field.restoreOriginal();
    p.field.finish();
    this.toast('Not saved: Blueline did not answer');
    this.reportBusy();
  }

  /** MainToDeckEdit.result (9.2 step 6: after MainToDeck.map with the new version). */
  onResult(p: unknown): void {
    const r = readResult(p);
    if (!r) return;
    const pend = this.pending.get(r.fieldId);
    if (!pend) return;
    this.pending.delete(r.fieldId);
    clearTimeout(pend.timer);
    const f = pend.field;
    const res = pend.result;
    if (r.outcome === 'written') {
      const picked = f.pick && res.kind === 'edit' && f.pick.runId === res.runId ? f.pick.kind : null;
      if (res.kind === 'edit' && typeof r.text === 'string' && (picked === null || picked === 'equal')) {
        // The run's text as the file holds it now (html-text needs no reload, Strategy 2 needs one).
        f.writeRun(res.runId, r.text);
        if (!r.reload && r.strategy === 'html-text' && !f.tamperedFlag && !f.changedAfterClose) this.advance(res.runId, r.text);
      }
      if (r.reload) this.reloadPending = true;
      const t = savedToast(r, this.fileName, pend.alsoPlaces);
      this.toast(t.text, t.token ? { label: 'Undo', run: () => this.undo(t.token!) } : undefined);
    } else {
      // A note, a no-op or a refusal: the page shows what the file holds, the old text.
      f.restoreOriginal();
      const msg = failureToast(r.outcome, r.why ?? null);
      if (msg) this.toast(msg);
      if (r.reload) this.reloadPending = true;
    }
    f.finish();
    this.refreshAvailability();
    this.reportBusy();
    this.flushApplied();
  }

  /** The toast's Undo (6.3 Saving): main checks the token is still the document's latest undoable write (P2-14). */
  private undo(token: string): void {
    const req: EditUndoRequest = { token };
    this.deps.send(EditDeckToMain.undo, req);
  }

  /**
   * The page's own html-text write landed: when one of the maps main sent since is the page's map with exactly
   * that run changed to `text`, the page (its node now showing `text`) shows that version (P2-6).
   */
  private advance(runId: string, text: string): void {
    const base = this.pageMap;
    if (!base) return;
    const i = this.mapsAhead.findIndex((m) => differsOnlyIn(base, m, runId, text));
    if (i < 0) {
      // 9.2 step 6 sends the map first; should it come after the answer, it is matched when it comes.
      this.awaitingMap.push({ runId, text });
      if (this.awaitingMap.length > MAPS_AHEAD_MAX) this.awaitingMap.shift();
      return;
    }
    const next = this.mapsAhead[i];
    this.pageMap = next;
    this.pageVersion = next.version;
    this.mapsAhead = this.mapsAhead.slice(i + 1);
    this.matcher = null;
  }

  /** MainToDeckEdit.applied (P2-10): after an app undo or redo of an html-text write, the node's text; or a reload. */
  onApplied(p: unknown): void {
    if (!p || typeof p !== 'object') return;
    const o = p as Record<string, unknown>;
    if (o.reload === true) {
      this.reloadPending = true;
      this.refreshAvailability();
      return;
    }
    if (typeof o.stamp !== 'string' || !STAMP_RE.test(o.stamp) || !Number.isInteger(o.textIndex) || (o.textIndex as number) < 0) return;
    if (typeof o.text !== 'string' || utf8Length(o.text) > EDIT_LIMITS.text || !isWellFormedText(o.text)) return;
    this.deferredApplied.push({ stamp: o.stamp, textIndex: o.textIndex as number, text: o.text });
    this.flushApplied();
  }

  /** Applies the undo and redo patches, except one for an element whose field is open or committing. */
  private flushApplied(): void {
    const keep: { stamp: string; textIndex: number; text: string }[] = [];
    for (const a of this.deferredApplied.splice(0)) {
      const els = Array.from(this.doc.querySelectorAll(`[data-bl-e="${a.stamp}"]`));
      const blocked = els.some((el) => this.touchesField(el));
      if (blocked) {
        keep.push(a);
        continue;
      }
      for (const el of els) {
        if (stampOf(el) !== a.stamp) continue;
        for (let c = el.firstChild; c; c = c.nextSibling) {
          if (c.nodeType !== 3 || textIndexOf(c as Text) !== a.textIndex) continue;
          const t = c as Text;
          // Only the parser's own node shows the run; a node a script rewrote is not that run's (P2-6).
          if (this.tracker?.isTouched(t)) break;
          if (t.data !== a.text) {
            if (this.tracker) this.tracker.ownChanges(() => (t.data = a.text), el);
            else t.data = a.text;
          }
          break;
        }
      }
      this.advance(`h:${a.stamp}:${a.textIndex}`, a.text);
    }
    this.deferredApplied.push(...keep);
    this.refreshAvailability();
  }

  private touchesField(el: Element): boolean {
    const roots = [this.field?.root, ...Array.from(this.pending.values(), (p) => p.field.root)];
    return roots.some((r) => !!r && (r === el || r.contains(el) || el.contains(r)));
  }

  // ------------------------------------------------------------------------------------------- the picker

  private openPicker(g: { node: Text; match: MatchResult; pick: EditPick['kind']; x: number; y: number }): void {
    const version = this.pageVersion;
    if (!version) return;
    const runIds = [...new Set(g.match.candidates.map((c) => c.runId))].slice(0, EDIT_LIMITS.candidates);
    if (runIds.length === 0) {
      this.toast('Not editable');
      return;
    }
    this.closePicker();
    const id = this.nextId++;
    const timer = setTimeout(() => {
      if (this.picker?.id !== id) return;
      this.closePicker();
      this.toast('Could not list the places this text comes from');
    }, CANDIDATES_TIMEOUT_MS);
    this.picker = { id, version, node: g.node, data: g.node.data, pick: g.pick, requested: new Set(runIds), x: g.x, y: g.y, model: null, timer };
    this.overlay.showOutline(null);
    this.pickerView.loading(this.nodeRect(g.node) ?? { x: g.x, y: g.y, w: 0, h: 0 });
    const req: EditCandidatesRequest = { fieldId: id, version, runIds };
    this.deps.send(EditDeckToMain.candidates, req);
  }

  /** MainToDeckEdit.candidates (P2-8). */
  onCandidates(p: unknown): void {
    const pk = this.picker;
    if (!pk) return;
    const items = pickerItems(p, pk.id, pk.requested);
    if (items === null) return;
    clearTimeout(pk.timer);
    if (items.length === 0) {
      // Main offers nothing it could write (split and short are never offered): the node is not editable.
      this.closePicker();
      this.toast('Not editable');
      return;
    }
    pk.model = new PickerModel(items);
    this.pickerView.show(this.nodeRect(pk.node) ?? { x: pk.x, y: pk.y, w: 0, h: 0 }, this.fileName ?? 'deck.html', pk.model);
  }

  private onPickerHit(h: PickerHit): void {
    const p = this.picker;
    if (!p) return;
    if (h.kind === 'cancel') this.closePicker();
    else if (h.kind === 'choose' && p.model) {
      p.model.set(h.index);
      this.pickerView.highlight(p.model.index);
      const c = p.model.choose(h.index);
      if (c) this.choose(c);
    }
  }

  private choose(c: PickerCandidate): void {
    const p = this.picker;
    if (!p) return;
    this.closePicker();
    const why = this.blockedReason();
    if (why) {
      this.toast(why);
      return;
    }
    if (p.version !== this.pageVersion || !p.node.isConnected || p.node.data !== p.data) {
      this.toast('The text changed meanwhile: click it again');
      return;
    }
    const busy = this.busyOn(p.node.parentElement);
    if (busy) {
      this.toast(busy);
      return;
    }
    if (this.field) this.commit(this.field, 'picker');
    if (!this.openField(p.node, c.runId, { runId: c.runId, kind: p.pick }, { x: p.x, y: p.y })) this.toast('Not editable');
  }

  private closePicker(): void {
    const p = this.picker;
    if (!p) return;
    clearTimeout(p.timer);
    this.picker = null;
    this.pickerView.hide();
  }

  // ------------------------------------------------------------------------------------------- fit guard, toasts, busy

  private scheduleFit(): void {
    if (this.fitScheduled) return;
    this.fitScheduled = true;
    this.win.requestAnimationFrame(() => {
      this.fitScheduled = false;
      this.updateFit();
    });
  }

  /** 6.3 Fit guard: the badge shows what changed since the field opened; it warns and never blocks. */
  private updateFit(): void {
    const f = this.field;
    if (!f || f.closed || f.svg || !f.fitBefore) {
      this.overlay.setFitBadge(null);
      return;
    }
    const now = measureFit(f.element, this.win, f.fitContainer);
    const warnings = fitWarnings(f.fitBefore, now);
    this.overlay.setFitBadge(warnings.length > 0 ? warnings.join(' \u00b7 ') : null, f.rect());
  }

  private toast(text: string, action?: { label: string; run(): void }): void {
    this.overlay.showToast(text, action ? { action } : 2600);
  }

  /**
   * Test builds only (deck.ts exposes it as __blTestEdit in the preload's isolated world, beside __blTestIpc): what
   * the closed overlay shows and the controller holds, as plain data, so E2E tests can check outlines, badges, the
   * toast and the picker. Production never calls it.
   */
  testState(withMap = false): Record<string, unknown> {
    const parts = this.overlay.parts;
    const box = (el: HTMLElement) => ({ x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0, w: parseFloat(el.style.width) || 0, h: parseFloat(el.style.height) || 0 });
    const f = this.field;
    const p = this.picker;
    const rectOf = (el: Element | null) => {
      if (!el || (el as HTMLElement).hidden) return null;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
    };
    return {
      mode: this.mode,
      blocked: this.blockedReason(),
      pageVersion: this.pageVersion,
      mapsAhead: this.mapsAhead.length,
      outline: parts.outline.hidden ? null : { kind: parts.outline.dataset.kind ?? 'solid', ...box(parts.outline) },
      toast: this.overlay.toastText,
      toastAction: !parts.toast.hidden && parts.toast.classList.contains('actionable'),
      toastButton: rectOf(parts.toast.querySelector('.toast-action')),
      pickerRows: Array.from(parts.edit.querySelectorAll('.picker-row')).map((r) => rectOf(r)),
      fit: parts.fit.hidden ? null : parts.fit.textContent,
      badge: parts.badge.hidden ? null : parts.badge.textContent,
      picker: p ? { id: p.id, loading: p.model === null, index: p.model?.index ?? -1, items: p.model ? p.model.items.map((c) => ({ ...c })) : [] } : null,
      field: f
        ? { id: f.id, svg: f.svg, version: f.version, before: f.before, text: f.text(), runs: f.runs.map((r) => ({ ...r })), caretRunId: f.caretRunId, tag: f.root.localName, rootId: f.root.id, tampered: f.tamperedFlag }
        : null,
      busy: this.busy(),
      paused: this.pause.active,
      smartPunctuation: this.smart,
      map: withMap ? this.pageMap : undefined,
    };
  }

  /** Reports the busy state when it changed: EditBusy, and the view hooks' DeckBusy at once (6.6). */
  reportBusy(): void {
    const b = this.busy();
    const key = `${b.edit}:${b.committing}`;
    if (key === this.lastBusy) return;
    this.lastBusy = key;
    this.deps.send(EditDeckToMain.busy, b);
    this.deps.onBusyChange();
  }
}
