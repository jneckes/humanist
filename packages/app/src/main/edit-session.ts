// Edit in main (Phase 2; 6.3, 6.6 Edit notes, 9.1 Preload, 9.2 Write protocol, Watcher, Undo and redo; decisions
// P2-1 to P2-4, P2-7, P2-8, P2-10 to P2-14). The deck preload makes the edit field and sends what it holds; main
// computes every write from source text through the editor's write queue (dist/editor.cjs, loaded at runtime:
// the capability seam, 9.6), and keeps the notes, the locks, the undo stack and the history.
//
// Three layers:
//   - pure functions (unit-tested): Edit availability, the commit gate (P2-7), the picker's candidates (P2-8), the
//     undo patch (P2-10), the restore plan and its diff (P2-11), the notes list and Copy (P2-13), the texts;
//   - EditLane, one per realpath (EditRegistry): the write queue, the history store, and ONE serial lane through
//     which the watcher's external changes and the queue's own writes both pass, so their order is total (P2-3).
//     It survives a D-1 reopen (the registry keeps it a while after its window closed). knownHash and the
//     document's version never go back: an external change is taken only while it is still the newest the
//     watcher saw (doc.knownHash === its version), and an own write is adopted right after it lands (P2-2);
//   - EditSession, one per document window: the deck's edit channels (begin, commit, candidates, the toast's
//     Undo, busy) with the trusted-input rule (P2-7), app undo and redo (P2-10), Make a note, Copy, the history list
//     and Restore. It is the lane's host while its window shows the file.
//
// Refusals: a commit main does not take (no field begun with trusted input, another version or run than the
// field's, Edit off, editing not allowed, no Edit capability) is dropped before the queue, with no note, no
// snapshot and no session write (P2-7; test/security). A refusal at the moment of the write (9.1) is the queue's,
// and the user's text is kept as a verbatim note (6.3 When a write fails).

import DiffMatchPatch from 'diff-match-patch';
import type { AppMode, Capabilities, ShellEditAvailability, ShellHistory, ShellNote, ShellToast } from '@blueline/core/ipc';
import type { DeckIO, EditorModule, RestoreOutcome, UndoOutcome, WriteKind, WriteQueue, WrittenVersion } from '@blueline/core/capabilities';
import { liftPick, type CommitResult, type VerbatimWhy } from '@blueline/core/edit-commit';
import {
  EDIT_LIMITS,
  MainToDeckEdit,
  candidateContext,
  type EditApplied,
  type EditBegin,
  type EditBusy,
  type EditCandidatesReply,
  type EditCandidatesRequest,
  type EditCommit,
  type EditResult,
  type EditTarget,
  type EditUndoRequest,
  type PickerCandidate,
} from '@blueline/core/ipc-edit';
import { fileGoneText } from '@blueline/core/ipc-files';
import { LOCK_DIFF_TIMEOUT_SEC, applyOwnWrite, lockForRun, transformLockedSpans } from '@blueline/core/locked-spans';
import { decodeDeck } from '@blueline/core/text';
import type { DeckMap, EditRequest, HtmlRun, LockedSpan, Note, RefusalCode, WriteOutcome, WriteRecord } from '@blueline/core/types';
import { readRegularFile, sha256Hex } from './atomic-write';
import { contentHashOfBytes } from './documents';
import { HistoryStore, type HistoryEntry } from './history';
import { RateLimiter } from './ipc-guard';
import type { NotesStore } from './notes';
import { UndoStack, newUndoToken, type UndoEntry } from './undo-stack';

// ------------------------------------------------------------------------------------------- constants and texts

/**
 * P2-7: a field is taken only when main saw the trusted press that opened it (a mouse down, or the key that chose
 * a picker row) this soon before the field's EditBegin. One press opens one field.
 */
export const BEGIN_WINDOW_MS = 2000;
/** The picker's request follows the click on dashed text; the toast's Undo follows the click on its button. */
export const PRESS_WINDOW_MS = 2000;
/** A lane whose window closed is kept this long, so a D-1 reopen finds the same queue (P2-3). */
export const LANE_KEEP_MS = 30_000;
/** Versions whose source and map are kept for the picker and picked edits (P2-8: "the DeckMap of the field's version"). */
export const VERSIONS_KEPT = 8;
/** Field records kept per window (the overlay has at most one open field and a few commits in flight). */
const FIELDS_KEPT = 16;
/** Lines of the restore dialog's diff. */
const DIFF_LINES = 14;
const DIFF_LINE_CHARS = 120;

/** 9.2 Undo and redo case 3. */
export const CANT_UNDO = "Can't undo in place: the deck changed since this edit";
export const NOTHING_TO_UNDO = 'Nothing to undo';
export const NOTHING_TO_REDO = 'Nothing to redo';
/** 6.3 Edit's availability reasons (the texts setMode has shown since Phase 1). */
export const EDIT_UNAVAILABLE = 'Edit is not available in this version of Blueline.';
export const EDIT_PROTECTED = 'This file is in Protected view. Click Enable editing to edit it.';

/** Why commitField made a verbatim note (core/edit-commit.ts VerbatimWhy), as the note and the toast say it. */
export function verbatimWhyText(why: VerbatimWhy): string {
  switch (why) {
    case 'emptied':
      return 'the text was emptied';
    case 'run-emptied':
      return 'the change would empty a piece of text';
    case 'across-runs':
      return 'the change crosses formatting';
    case 'outside-runs':
      return 'the change is in text Blueline cannot place';
    case 'boundary':
      return 'the change sits between two pieces of text';
    case 'page-changed':
      return 'the page changed the text while you were editing';
    default:
      return 'the field changed while it was open';
  }
}

/** A refusal of the write protocol (types.ts RefusalCode), as the deck's toast says it (6.3 When a write fails). */
export function refusalText(code: RefusalCode): string {
  switch (code) {
    case 'not-utf8':
      return 'the file is not UTF-8';
    case 'structural':
      return 'the change would empty the text';
    case 'stale':
      return 'the deck changed meanwhile';
    case 'ambiguous':
      return 'the text is in several places';
    case 'placeholder':
      return 'the text comes from a script template';
    case 'markup':
      return 'the page may read this text as HTML';
    case 'escape':
      return 'the text has characters that cannot be written in place';
    case 'unaligned':
      return 'the text cannot be placed exactly';
    case 'conflict':
      return 'the deck kept changing';
    case 'verify':
      return 'the change did not verify';
    case 'refused':
      return 'editing is not allowed now';
    case 'noop':
      return 'nothing changed';
    default:
      return 'the write failed';
  }
}

// ------------------------------------------------------------------------------------------- Edit availability

export interface EditAvailabilityInput {
  /** capabilities.edit (9.6), and a write queue for this file. */
  capEdit: boolean;
  /** 9.2 rule 1: "deck.html is not UTF-8; direct edits are off", or null. */
  readOnlyReason: string | null;
  /** 9.2 Watcher: the file went away. */
  gone: boolean;
  fileName: string;
  /** 6.10: Trusted, or Enable editing was pressed. */
  editingAllowed: boolean;
}

/**
 * 6.3: "Edit mode is available when the Edit capability is on (D11) and editing is allowed: the file is Trusted, or
 * the user clicked Enable editing (6.10)." Also off for a file that is not UTF-8 (9.2 rule 1) or that went away.
 * `enable`: Enable editing would make it available (the toast asks for it, 6.2).
 */
export function editAvailability(i: EditAvailabilityInput): ShellEditAvailability {
  if (!i.capEdit) return { available: false, reason: EDIT_UNAVAILABLE, enable: false };
  if (i.readOnlyReason) return { available: false, reason: i.readOnlyReason, enable: false };
  if (i.gone) return { available: false, reason: fileGoneText(i.fileName), enable: false };
  if (!i.editingAllowed) return { available: false, reason: EDIT_PROTECTED, enable: true };
  return { available: true, reason: null, enable: false };
}

// ------------------------------------------------------------------------------------------- trusted input (P2-7)

/** InputEvent types (webContents 'input-event') that are a press: what opens a field, a picker row, a toast button. */
const PRESS_TYPES: ReadonlySet<string> = new Set(['mouseDown', 'keyDown', 'rawKeyDown', 'gestureTap', 'touchStart', 'pointerDown']);

/**
 * The trusted input main saw reach the deck view. Electron reports in 'input-event' only what the browser process
 * dispatched to the page (the OS, or main's own sendInputEvent): a page script or a forged message makes none.
 */
export class TrustedInput {
  private lastPress = Number.NEGATIVE_INFINITY;
  private pressTaken = true;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** One InputEvent the deck view received. */
  note(type: string): void {
    if (!PRESS_TYPES.has(type)) return;
    this.lastPress = this.now();
    this.pressTaken = false;
  }

  /** A press within `windowMs` that no field took yet; taking it means no other field opens on it. */
  takePress(windowMs: number): boolean {
    if (this.pressTaken || this.now() - this.lastPress > windowMs) return false;
    this.pressTaken = true;
    return true;
  }

  /** A press within `windowMs` (taken or not): the picker's request, the toast's Undo. */
  recentPress(windowMs: number): boolean {
    return this.now() - this.lastPress <= windowMs;
  }

  reset(): void {
    this.lastPress = Number.NEGATIVE_INFINITY;
    this.pressTaken = true;
  }
}

/** A field main accepted (EditBegin after a trusted press). */
export interface FieldRecord {
  id: number;
  /** The version of the page it opened on (P2-5: its commit carries it). */
  version: string;
  /** The runs of its text nodes: a commit may write only one of these (P2-7). */
  runIds: ReadonlySet<string>;
  openedAt: number;
  /** Main left Edit while it was open: its commit (sent because of that) is still taken. */
  leftEdit: boolean;
}

/** The fields of one page load (the preload's field ids restart with each load). */
export class FieldRegistry {
  private readonly fields = new Map<number, FieldRecord>();

  begin(b: EditBegin, at: number): FieldRecord {
    const rec: FieldRecord = { id: b.fieldId, version: b.version, runIds: new Set(b.runIds), openedAt: at, leftEdit: false };
    this.fields.delete(b.fieldId);
    this.fields.set(b.fieldId, rec);
    while (this.fields.size > FIELDS_KEPT) this.fields.delete(this.fields.keys().next().value as number);
    return rec;
  }

  peek(id: number): FieldRecord | null {
    return this.fields.get(id) ?? null;
  }

  /** Removes the record: one commit per field. */
  take(id: number): FieldRecord | null {
    const r = this.fields.get(id) ?? null;
    this.fields.delete(id);
    return r;
  }

  /** Main left Edit: the fields open now may still commit (the mode change itself makes the preload commit them). */
  leftEdit(): void {
    for (const f of this.fields.values()) f.leftEdit = true;
  }

  clear(): void {
    this.fields.clear();
  }

  get size(): number {
    return this.fields.size;
  }
}

/** What the commit gate knows of the window at the moment of the commit. */
export interface GateState {
  mode: AppMode;
  /** capabilities.edit, and a write queue for this file. */
  capEdit: boolean;
  /** doc.editable(): editing allowed, UTF-8, not gone. */
  editable: boolean;
}

export type CommitGate = { ok: true; field: FieldRecord } | { ok: false; reply: boolean; why: string };

/**
 * P2-7: whether main takes a commit. Only a field main accepted (a trusted press opened it), for the version it
 * opened on, and for an edit only one of that field's runs. Then Edit (or Edit left while the field was open),
 * the Edit capability and editing allowed, at this moment. `reply`: the commit is the preload's own (its field is
 * known), so the field is told it was refused; anything else is dropped without a word.
 */
export function gateCommit(c: EditCommit, field: FieldRecord | null, s: GateState): CommitGate {
  if (!field) return { ok: false, reply: false, why: 'no such field' };
  if (field.version !== c.version) return { ok: false, reply: false, why: 'another version than the field opened on' };
  if (c.result.kind === 'edit' && !field.runIds.has(c.result.runId)) return { ok: false, reply: false, why: 'a run the field does not hold' };
  if (!s.capEdit) return { ok: false, reply: true, why: 'Edit is not available in this version of Blueline' };
  if (s.mode !== 'edit' && !field.leftEdit) return { ok: false, reply: true, why: 'Edit is off' };
  if (!s.editable) return { ok: false, reply: true, why: 'editing is not allowed for this file' };
  return { ok: true, field };
}

// ------------------------------------------------------------------------------------------- maps and runs

/** A run of a map: an html-text run or a literal, with what the notes and the picker need. */
export interface RunInfo {
  id: string;
  strategy: 'html-text' | 'script-literal' | 'json-literal';
  start: number;
  end: number;
  line: number;
  col: number;
  value: string;
  aligned: boolean;
  placeholder: boolean;
  literal: boolean;
}

export function findRun(map: DeckMap, runId: string): RunInfo | null {
  if (runId.startsWith('h:')) {
    const r = map.runs.find((x) => x.id === runId);
    return r ? { id: r.id, strategy: 'html-text', start: r.start, end: r.end, line: r.line, col: r.col, value: r.value, aligned: r.aligned, placeholder: false, literal: false } : null;
  }
  const l = map.literals.find((x) => x.id === runId);
  return l
    ? { id: l.id, strategy: l.strategy, start: l.start, end: l.end, line: l.line, col: l.col, value: l.value, aligned: l.aligned !== false, placeholder: l.placeholder, literal: true }
    : null;
}

/** The strategy a run id names (h: html-text, l: a literal; notes.ts takes json-literal from the map when known). */
export function strategyOf(runId: string, map?: DeckMap): 'html-text' | 'script-literal' | 'json-literal' {
  if (runId.startsWith('h:')) return 'html-text';
  const l = map?.literals.find((x) => x.id === runId);
  return l?.strategy ?? 'script-literal';
}

/**
 * The source a write replaced, rebuilt from the new source and its record (P2-4: what the queue read, whose
 * sha256 is WrittenVersion.basedOn).
 */
export function sourceBefore(src: string, record: Pick<WriteRecord, 'start' | 'rawBefore' | 'rawAfter'>): string {
  return src.slice(0, record.start) + record.rawBefore + src.slice(record.start + record.rawAfter.length);
}

/**
 * P2-10: after an html-text undo or redo, the node the page must patch: the html-text run of the new map that holds
 * the whole splice (`record` is the undo's own record, in the new source). Null when no aligned run holds it (a
 * literal, or a splice across runs): the page reloads instead.
 */
export function undoPatch(map: DeckMap, record: Pick<WriteRecord, 'start' | 'rawAfter'>): { stamp: string; textIndex: number; text: string; run: HtmlRun } | null {
  const s = record.start;
  const e = record.start + record.rawAfter.length;
  for (const r of map.runs) {
    if (r.start <= s && e <= r.end && r.aligned) return { stamp: r.stamp, textIndex: r.textIndex, text: r.value, run: r };
  }
  return null;
}

/**
 * P2-8, 6.3, 9.2 Strategy 2 step 3: the picker's candidates, built from the map of the field's version: each
 * requested run that version has, with ±40 source characters of context, its line, and for a literal whose text
 * is also a key the warning with the key's line. A run Blueline cannot write (no verified table, a template
 * placeholder) is not offered. The context never reaches into the notes block, which the page is never served.
 */
export function pickerCandidates(map: DeckMap, src: string, runIds: readonly string[], fileName: string): PickerCandidate[] {
  const nb = map.notesBlock;
  const cut = nb ? nb.end - nb.start : 0;
  const shown = nb ? src.slice(0, nb.start) + src.slice(nb.end) : src;
  const at = (i: number): number => (nb && i >= nb.end ? i - cut : i);
  const keyLine = new Map<string, number>();
  for (const k of map.keys) if (!keyLine.has(k.value)) keyLine.set(k.value, k.line);
  const keys = new Set(map.keyValues);
  const out: PickerCandidate[] = [];
  const seen = new Set<string>();
  for (const id of runIds) {
    if (out.length >= EDIT_LIMITS.candidates || seen.has(id)) continue;
    seen.add(id);
    const r = findRun(map, id);
    if (!r || !r.aligned || r.placeholder) continue;
    if (nb && r.start < nb.end && r.end > nb.start) continue;
    const c: PickerCandidate = { runId: r.id, line: r.line, context: candidateContext(shown, at(r.start), at(r.end)) };
    if (r.literal && keys.has(r.value)) {
      const line = keyLine.get(r.value);
      c.keyWarning = line !== undefined ? `This text is also used as a key at ${fileName}:${line}` : `This text is also used as a key in ${fileName}`;
    }
    out.push(c);
  }
  return out;
}

/** The decoded text of a run in a map, or null (liftPick's run value, P2-8). */
export function runValueAt(map: DeckMap, runId: string): string | null {
  return findRun(map, runId)?.value ?? null;
}

// ------------------------------------------------------------------------------------------- notes (P2-13)

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const c = s.charCodeAt(max - 2);
  return `${s.slice(0, c >= 0xd800 && c <= 0xdbff ? max - 2 : max - 1)}…`;
}

/** The notes panel's list (P2-13): status, before → after, slide, line, and a violated lock flag. */
export function shellNotes(notes: readonly Note[], locked: readonly LockedSpan[], textMax: number): ShellNote[] {
  const lockOf = new Map<string, 'ok' | 'violated'>();
  for (const l of locked) if (lockOf.get(l.noteId) !== 'violated') lockOf.set(l.noteId, l.state === 'violated' ? 'violated' : 'ok');
  return notes.map((n) => {
    const line = n.targets.find((t) => t.source)?.source?.line ?? null;
    const out: ShellNote = {
      id: n.id,
      status: n.status,
      kind: n.kind,
      text: clip(n.text, textMax),
      slide: n.slide?.index ?? null,
      line: typeof line === 'number' && line > 0 ? line : null,
      locked: lockOf.get(n.id) ?? null,
    };
    if (n.summary) out.summary = clip(n.summary, textMax);
    if (n.verbatim) {
      out.before = clip(n.verbatim.before, textMax);
      out.after = clip(n.verbatim.after, textMax);
    }
    return out;
  });
}

/**
 * What Copy puts on the clipboard (P2-13): the note's id, kind, status and place, then its exact texts, whole
 * (the agent "must apply your exact words", 6.3).
 */
export function noteCopyText(n: Note, fileName: string): string {
  const line = n.targets.find((t) => t.source)?.source?.line;
  const where = typeof line === 'number' && line > 0 ? `${fileName}:${line}` : fileName;
  const slide = typeof n.slide?.index === 'number' ? ` · slide ${n.slide.index + 1}` : '';
  const head = `${n.id} · ${n.kind} · ${n.status} · ${where}${slide}`;
  const parts = [head];
  if (n.verbatim) {
    parts.push(`Before: ${n.verbatim.before}`, `After: ${n.verbatim.after}`);
    if (n.kind === 'verbatim' && n.summary) parts.push(n.summary);
  } else {
    if (n.summary) parts.push(n.summary);
    if (n.text) parts.push(n.text);
  }
  return parts.join('\n');
}

// ------------------------------------------------------------------------------------------- history (P2-11)

/** The history list as the shell shows it (newest first). */
export function shellHistory(entries: readonly HistoryEntry[], canRestore: boolean, reason: string | null): ShellHistory {
  return { entries: entries.map((e) => ({ id: e.id, at: e.at, cause: e.cause, size: e.size })), canRestore, reason };
}

/**
 * A short line diff for "Restore deck to <time>" (9.2 Undo and redo 4: "It shows the diff"): `- ` lines the current
 * deck has and the snapshot does not, `+ ` lines the snapshot brings back, at most `max` lines, each shortened.
 */
export function lineDiff(current: string, snapshot: string, max = DIFF_LINES): string[] {
  if (current === snapshot) return [];
  const dmp = new DiffMatchPatch();
  dmp.Diff_Timeout = 1;
  const a = dmp.diff_linesToChars_(current, snapshot);
  const diffs = dmp.diff_main(a.chars1, a.chars2, false);
  dmp.diff_charsToLines_(diffs, a.lineArray);
  const out: string[] = [];
  let more = 0;
  for (const [op, text] of diffs as [number, string][]) {
    if (op === 0) continue;
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    for (const l of lines) {
      const t = l.replace(/\t/g, '  ').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').trim();
      if (t.length === 0) continue;
      if (out.length >= max) {
        more++;
        continue;
      }
      out.push(`${op < 0 ? '−' : '+'} ${clip(t, DIFF_LINE_CHARS)}`);
    }
  }
  if (more > 0) out.push(`… and ${more} more ${more === 1 ? 'line' : 'lines'}`);
  return out;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The time a history entry shows (local, hours and minutes; the date when it is not today). */
export function historyTime(at: string, now: Date = new Date()): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString()} ${time}`;
}

/**
 * The confirmation of "Restore deck to <time>" (9.2 Undo and redo 4): the counts of later changes it discards and
 * the diff. `counts` is HistoryStore.countSince (the restored snapshot's own write included).
 */
export function restorePlan(o: { fileName: string; time: string; counts: { direct: number; external: number }; diff: readonly string[] }): {
  message: string;
  detail: string;
} {
  const lost: string[] = [];
  if (o.counts.direct > 0) lost.push(plural(o.counts.direct, 'direct edit', 'direct edits'));
  if (o.counts.external > 0) lost.push(plural(o.counts.external, 'change made outside Blueline', 'changes made outside Blueline'));
  const head = lost.length > 0 ? `This discards ${lost.join(' and ')} since then.` : 'This discards the changes since then.';
  const diff = o.diff.length > 0 ? `\n\n${o.diff.join('\n')}` : '';
  return { message: `Restore ${o.fileName} to ${o.time}?`, detail: `${head} Edit notes stay in the notes list.${diff}` };
}

// ------------------------------------------------------------------------------------------- the lane (P2-3)

/** Runs jobs one at a time, in the order given. */
export class SerialLane {
  private tail: Promise<unknown> = Promise.resolve();
  private running = 0;

  run<T>(job: () => Promise<T>): Promise<T> {
    this.running++;
    const r = this.tail.then(job, job);
    this.tail = r.then(
      () => undefined,
      () => undefined,
    );
    return r.finally(() => {
      this.running--;
    });
  }

  /** Resolves when every job queued so far (and any queued meanwhile) has finished. */
  async idle(): Promise<void> {
    while (this.running > 0) await this.tail;
  }

  get busy(): boolean {
    return this.running > 0;
  }
}

/** Sources and maps of recent versions (the picker and picked edits name the field's version, P2-8). */
export class VersionCache {
  private readonly m = new Map<string, { src: string; map: DeckMap }>();

  constructor(private readonly max = VERSIONS_KEPT) {}

  put(version: string, src: string, map: DeckMap): void {
    this.m.delete(version);
    this.m.set(version, { src, map });
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value as string);
  }

  get(version: string): { src: string; map: DeckMap } | null {
    return this.m.get(version) ?? null;
  }

  clear(): void {
    this.m.clear();
  }
}

/** What the lane needs of a document (BlDocument). */
export interface LaneDoc {
  readonly realpath: string;
  readonly fileName: string;
  readonly fileKey: string;
  readonly version: string;
  readonly decoded: { src: string; utf8: boolean };
  readonly map: DeckMap;
  readonly bytes: Uint8Array;
  readonly contentHash: string;
  readonly title: string;
  readonly marker: string | null;
  knownHash: string;
  trust(): 'protected' | 'trusted';
  editable(): boolean;
  adoptOwnWrite(bytes: Uint8Array, map: DeckMap, src: string): void;
  replaceContent(bytes: Uint8Array): void;
  io(editCapability: () => boolean): DeckIO;
}

/** An own write the lane adopted (P2-2), for its window. */
export interface Adopted {
  kind: WriteKind;
  /** The new version. */
  version: string;
  /** What the queue read and wrote on top of (WrittenVersion.basedOn). */
  basedOn: string;
  /** The version main had before (doc.version): basedOn differs when the write absorbed an external change. */
  previous: string;
  absorbed: boolean;
  record: WriteRecord;
  map: DeckMap;
  runId?: string;
  strategy?: 'html-text' | 'script-literal' | 'json-literal';
  /** Undo and redo: the node the page patches (null: it reloads). */
  patch: { stamp: string; textIndex: number; text: string } | null;
}

/** An external change the lane took (9.2 Watcher step 3). */
export interface Taken {
  previous: string;
  version: string;
}

/** The window that shows the lane's file (EditSession). */
export interface LaneHost {
  readonly doc: LaneDoc;
  /** Session.locked, read and replaced in place (the window's session object). */
  locks(): LockedSpan[];
  setLocks(spans: LockedSpan[]): void;
  /** SessionStore.known() and noteVersion() (P2-12). */
  known(): { version: string } | null;
  noteVersion(v: { version: string; contentHash: string; title: string }): void;
  save(): void;
  /** 9.1, P2-7: may this job write now? Checked by the queue right before the snapshot and right before the write. */
  canWrite(job: LaneJob): boolean;
  /** An own write was adopted: push the map (before the result, 9.2 step 6), the reload rule, products, trust. */
  adopted(e: Adopted): void;
  /** An external change was taken: push the map and reload under 6.6's rules. */
  taken(e: Taken): void;
  log(msg: string): void;
}

/** One operation of the queue, and its host. */
export interface LaneJob {
  host: LaneHost;
  kind: WriteKind;
  /** Undo and redo: the edit note of the write (its snapshot names it; undo drops its lock). */
  noteId?: string;
  /** P2-7: the field was open when main left Edit. */
  leftEdit?: boolean;
  adopted?: Adopted;
}

/** The queue's operations, run inside EditLane.exclusive. */
export interface LaneOps {
  edit(req: EditRequest, o?: { leftEdit?: boolean }): Promise<{ out: WriteOutcome; adopted: Adopted | null }>;
  undo(record: WriteRecord, noteId: string): Promise<{ out: UndoOutcome; adopted: Adopted | null }>;
  redo(record: WriteRecord): Promise<{ out: UndoOutcome; adopted: Adopted | null }>;
  restore(bytes: Uint8Array, expectVersion: string): Promise<{ out: RestoreOutcome; adopted: Adopted | null }>;
}

export interface EditLaneDeps {
  editor: EditorModule | null;
  /** capabilities.edit, read at the moment of each write (DeckIO refuse). */
  capEdit(): boolean;
  /** The history store of this file (null: no Edit capability, nothing is ever written). */
  history(): HistoryStore | null;
  log(msg: string): void;
  now?(): Date;
}

/**
 * One file's write queue and serial lane (P2-3). The queue's hooks act for the job running now, whose host is the
 * window that asked; external changes pass through the same lane, so an own write and an external take never
 * interleave.
 */
export class EditLane {
  readonly lane = new SerialLane();
  readonly versions = new VersionCache();
  private queue: WriteQueue | null = null;
  private job: LaneJob | null = null;
  private host: LaneHost | null = null;
  private readonly diffTimeout = LOCK_DIFF_TIMEOUT_SEC;

  constructor(
    readonly realpath: string,
    private readonly deps: EditLaneDeps,
  ) {}

  /** A write queue exists (the editor is loaded): Edit can write this file. */
  get hasQueue(): boolean {
    return this.queue !== null || this.deps.editor !== null;
  }

  /** The window that shows the file now, or null. */
  get attached(): LaneHost | null {
    return this.host;
  }

  /** The file's history store (P2-11), or null in a build without the Edit capability. */
  history(): HistoryStore | null {
    return this.deps.history();
  }

  private now(): string {
    return (this.deps.now ? this.deps.now() : new Date()).toISOString();
  }

  private log(msg: string): void {
    this.deps.log(`edit: ${msg}`);
  }

  private ensureQueue(): WriteQueue | null {
    if (this.queue || !this.deps.editor) return this.queue;
    const realpath = this.realpath;
    // The DeckIO of whichever window's job runs now: a D-1 reopen gives the file a new BlDocument, the queue stays.
    const io: DeckIO = {
      realpath,
      read: () => readRegularFile(realpath),
      sha256: sha256Hex,
      atomicWrite: (bytes, expectHash) => {
        const h = this.job?.host;
        if (!h) return Promise.reject(new Error('No window shows this deck'));
        return h.doc.io(() => this.deps.capEdit()).atomicWrite(bytes, expectHash);
      },
    };
    this.queue = this.deps.editor.createWriteQueue(io, {
      canWrite: () => (this.job ? this.job.host.canWrite(this.job) : false),
      beforeWrite: (prev, next) => this.beforeWrite(prev, next),
      afterWrite: (map, record, next) => this.afterWrite(map, record, next),
      onHookError: (e) => this.log(`${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`),
      maxRetries: 5,
    });
    return this.queue;
  }

  /**
   * A window shows the file (open, or a D-1 reopen): the queue learns the version its page holds (P2-3), and the
   * locks follow a change made while no window showed it, from the last known content (P2-12).
   */
  attach(host: LaneHost): Promise<void> {
    this.host = host;
    return this.lane.run(async () => {
      const doc = host.doc;
      const queue = this.ensureQueue();
      if (doc.decoded.utf8) {
        queue?.know(doc.version, doc.decoded.src, doc.map);
        this.versions.put(doc.version, doc.decoded.src, doc.map);
      }
      const known = host.known();
      const locks = host.locks();
      if (known && known.version !== doc.version && locks.length > 0 && doc.decoded.utf8) {
        const history = this.deps.history();
        let prev: Uint8Array | null = null;
        try {
          prev = history ? await history.readSha256(known.version) : null;
        } catch {
          prev = null;
        }
        // Without the old content nothing can vouch for the locks: over-report (section 8 rule 3), never hide.
        const next = prev ? transformLockedSpans(decodeDeck(prev).src, doc.decoded.src, locks, { timeoutSec: this.diffTimeout }) : violateAll(locks, doc.decoded.src);
        host.setLocks(next);
        this.noteBase(host);
        host.save();
        this.log(`${doc.fileName} changed while no window showed it: ${locks.length} lock(s) ${prev ? 'transformed' : 'flagged (the old content is not kept)'}`);
      } else if (!known || known.version !== doc.version) {
        // P2-12: the session's next save records it (a plain open writes nothing to userData).
        host.noteVersion({ version: doc.version, contentHash: doc.contentHash, title: doc.title });
      }
    });
  }

  /** The window closed (or is reopening): jobs it started finish with it; nothing new is done for it. */
  detach(host: LaneHost): void {
    if (this.host === host) this.host = null;
  }

  /**
   * No window shows the file any more: once its jobs are done, the lane drops the queue and the versions it kept, so
   * a closed window's document does not stay in main memory (finding 21). The serial order and the history store
   * stay for a D-1 reopen; the next attach makes a new queue that knows the version its page shows.
   */
  forget(): Promise<void> {
    return this.lane.idle().then(() => {
      if (this.host !== null) return;
      this.versions.clear();
      this.queue = null;
    });
  }

  /** P2-12: the version main knows now is the session's `known`, its bytes history's base (when locks need it). */
  private noteBase(host: LaneHost): void {
    const doc = host.doc;
    host.noteVersion({ version: doc.version, contentHash: doc.contentHash, title: doc.title });
    const history = this.deps.history();
    if (!history || host.locks().length === 0 || doc.bytes.length === 0) return;
    void history
      .setBase(doc.bytes, { sha256: doc.version, contentHash: doc.contentHash, at: this.now(), marker: doc.trust() === 'protected' ? doc.marker : undefined })
      .catch((e: unknown) => this.log(`history base not kept: ${e instanceof Error ? e.message : String(e)}`));
  }

  /**
   * An external change the watcher saw and D-1 decided on (9.2 Watcher step 3), taken in the lane: never one older
   * than the newest the watcher saw, nor one an own write already absorbed (P2-3, P2-4: knownHash has moved on).
   * The content main knew goes to history first (cause external), the locks follow by diff (section 8), off the
   * reload's critical path.
   */
  takeExternal(host: LaneHost, bytes: Uint8Array, version: string): Promise<'taken' | 'stale' | 'failed'> {
    return this.lane.run(async () => {
      const doc = host.doc;
      if (doc.knownHash !== version || doc.version === version) return 'stale';
      const prev = { src: doc.decoded.src, bytes: doc.bytes, version: doc.version, contentHash: doc.contentHash, utf8: doc.decoded.utf8 };
      const history = this.deps.history();
      if (history && prev.bytes.length > 0 && prev.utf8) {
        void history
          .snapshot(prev.bytes, { sha256: prev.version, contentHash: prev.contentHash, cause: 'external', at: this.now(), marker: doc.trust() === 'protected' ? doc.marker : undefined })
          .catch((e: unknown) => this.log(`history: ${e instanceof Error ? e.message : String(e)}`));
      }
      try {
        doc.replaceContent(bytes);
      } catch (e) {
        this.log(`external change not taken: ${e instanceof Error ? e.message : String(e)}`);
        return 'failed';
      }
      if (doc.decoded.utf8) {
        this.queue?.know(doc.version, doc.decoded.src, doc.map);
        this.versions.put(doc.version, doc.decoded.src, doc.map);
      }
      host.taken({ previous: prev.version, version: doc.version });
      host.noteVersion({ version: doc.version, contentHash: doc.contentHash, title: doc.title });
      if (host.locks().length > 0 && prev.utf8 && doc.decoded.utf8) {
        // P2-12: the reload's messages go out first; the diff has a time limit (a timeout only over-reports).
        await new Promise<void>((r) => setImmediate(r));
        host.setLocks(transformLockedSpans(prev.src, doc.decoded.src, host.locks(), { timeoutSec: this.diffTimeout }));
        this.noteBase(host);
        host.save();
      }
      return 'taken';
    });
  }

  /**
   * Runs `fn` alone in the lane with the queue's operations for `host`. Notes, locks and the undo stack change
   * inside it, so nothing (an external take) comes between a write and its note.
   */
  exclusive<T>(host: LaneHost, fn: (ops: LaneOps) => Promise<T>): Promise<T> {
    return this.lane.run(() => fn(this.opsFor(host)));
  }

  private opsFor(host: LaneHost): LaneOps {
    const refused = { ok: false as const, why: EDIT_UNAVAILABLE, code: 'refused' as const };
    const run = async <O>(job: LaneJob, op: (q: WriteQueue) => Promise<O>, none: O): Promise<{ out: O; adopted: Adopted | null }> => {
      const q = this.ensureQueue();
      if (!q) return { out: none, adopted: null };
      this.job = job;
      try {
        const out = await op(q);
        return { out, adopted: job.adopted ?? null };
      } finally {
        this.job = null;
      }
    };
    return {
      edit: (req, o = {}) =>
        run<WriteOutcome>({ host, kind: 'edit', leftEdit: o.leftEdit === true }, (q) => q.edit(req), { ok: false, verbatim: { before: req.beforeText, after: req.afterText }, why: EDIT_UNAVAILABLE, code: 'refused' }),
      undo: (record, noteId) => run<UndoOutcome>({ host, kind: 'undo', noteId }, (q) => q.undo(record), { ...refused, canMakeNote: false }),
      redo: (record) => run<UndoOutcome>({ host, kind: 'redo' }, (q) => q.redo(record), { ...refused, canMakeNote: false }),
      restore: (bytes, expect) => run<RestoreOutcome>({ host, kind: 'restore' }, (q) => q.restore(bytes, expect), refused),
    };
  }

  /**
   * P2-11: before every write, the bytes it replaces go to history (the queue refuses the write when this rejects).
   * When the queue read a version main never took (an external change it absorbs, P2-4), the content main knew is
   * kept first, as an external change.
   */
  private async beforeWrite(prev: { version: string; bytes: Uint8Array }, next: { version: string; kind: WriteKind }): Promise<void> {
    const job = this.job;
    const history = this.deps.history();
    if (!job || !history) return;
    const doc = job.host.doc;
    const at = this.now();
    const marker = doc.trust() === 'protected' ? doc.marker : undefined;
    if (prev.version !== doc.version && doc.bytes.length > 0 && doc.decoded.utf8) {
      await history
        .snapshot(doc.bytes, { sha256: doc.version, contentHash: doc.contentHash, cause: 'external', at, marker })
        .catch((e: unknown) => this.log(`history: ${e instanceof Error ? e.message : String(e)}`));
    }
    const contentHash = prev.version === doc.version ? doc.contentHash : contentHashOfBytes(prev.bytes, prev.version);
    const meta: Parameters<HistoryStore['snapshot']>[1] = { sha256: prev.version, contentHash, cause: next.kind, at, marker };
    if ((job.kind === 'undo' || job.kind === 'redo') && job.noteId) meta.noteId = job.noteId;
    await history.snapshot(prev.bytes, meta);
  }

  /**
   * 9.2 Write protocol step 6 and P2-2/P2-4: the write landed. An external change it absorbed is processed first as
   * the watcher would (the locks from the content main knew to the bytes the queue read; the window decides trust
   * again, D-1, and reloads); then the own write moves the locks (section 8 rule 6; an undo drops its note's lock; a
   * restore is a whole-file change, diffed), the document adopts the bytes and map (no second buildMap), and the
   * window pushes the new map before the queue answers.
   */
  private afterWrite(map: DeckMap, record: WriteRecord, next: WrittenVersion): void {
    const job = this.job;
    if (!job) {
      this.log('a write landed with no job');
      return;
    }
    const host = job.host;
    const doc = host.doc;
    const previous = doc.version;
    const absorbed = next.basedOn !== previous;
    let locks = host.locks();
    if (locks.length > 0) {
      const basedOnSrc = sourceBefore(next.src, record);
      if (absorbed && doc.decoded.utf8) locks = transformLockedSpans(doc.decoded.src, basedOnSrc, locks, { timeoutSec: this.diffTimeout });
      if (next.kind === 'restore') locks = transformLockedSpans(basedOnSrc, next.src, locks, { timeoutSec: this.diffTimeout });
      else locks = applyOwnWrite(locks, record, job.kind === 'undo' && job.noteId ? { noteId: job.noteId } : {});
      host.setLocks(locks);
    }
    try {
      doc.adoptOwnWrite(next.bytes, map, next.src);
    } catch (e) {
      // The write stands; the document follows by the slower path rather than not at all.
      this.log(`own write not adopted (${e instanceof Error ? e.message : String(e)}); mapping it again`);
      try {
        doc.replaceContent(next.bytes);
      } catch {
        return;
      }
    }
    this.versions.put(doc.version, doc.decoded.src, doc.map);
    const patch = next.kind === 'undo' || next.kind === 'redo' ? undoPatch(doc.map, record) : null;
    const adopted: Adopted = {
      kind: next.kind,
      version: doc.version,
      basedOn: next.basedOn,
      previous,
      absorbed,
      record,
      map: doc.map,
      patch: patch ? { stamp: patch.stamp, textIndex: patch.textIndex, text: patch.text } : null,
    };
    if (next.runId) adopted.runId = next.runId;
    if (next.strategy) adopted.strategy = next.strategy;
    job.adopted = adopted;
    this.noteBase(host);
    try {
      host.adopted(adopted);
    } catch (e) {
      this.log(`after the write: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** Every lock flagged as changed (P2-12: the deck changed while closed and its old content is not kept). */
function violateAll(locks: readonly LockedSpan[], src: string): LockedSpan[] {
  return locks.map((l) => {
    const out: LockedSpan = { start: l.start, end: l.end, text: l.text, noteId: l.noteId, state: 'violated' };
    const now = Number.isInteger(l.start) && Number.isInteger(l.end) && l.start >= 0 && l.start <= l.end && l.end <= src.length ? src.slice(l.start, l.end) : '';
    out.change = l.state === 'violated' && l.change ? { before: l.change.before, after: now } : { before: l.text, after: now };
    return out;
  });
}

/** The lanes of the open files, by realpath, shared by every window (P2-3). */
export class EditRegistry {
  private readonly lanes = new Map<string, { lane: EditLane; refs: number; timer: ReturnType<typeof setTimeout> | null; history: HistoryStore | null }>();

  constructor(
    private readonly deps: {
      editor: EditorModule | null;
      userData: string;
      capEdit(): boolean;
      log(msg: string): void;
      /** Tests: the history store of a file. */
      historyFor?(fileKey: string, realpath: string): HistoryStore;
    },
  ) {}

  /** The lane of a document's file (one per realpath), held until release(). */
  acquire(doc: { realpath: string; fileKey: string }): EditLane {
    // Only the strings: the lane outlives the window, and must not keep its document (finding 21).
    const realpath = doc.realpath;
    const fileKey = doc.fileKey;
    let e = this.lanes.get(realpath);
    if (!e) {
      const entry: { lane: EditLane; refs: number; timer: ReturnType<typeof setTimeout> | null; history: HistoryStore | null } = { lane: null as unknown as EditLane, refs: 0, timer: null, history: null };
      entry.lane = new EditLane(realpath, {
        editor: this.deps.editor,
        capEdit: () => this.deps.capEdit(),
        // P2-11: only a build that can write keeps history; created when first needed.
        history: () => {
          if (!this.deps.editor) return null;
          if (!entry.history) {
            try {
              entry.history = this.deps.historyFor
                ? this.deps.historyFor(fileKey, realpath)
                : HistoryStore.forFile(this.deps.userData, fileKey, { realpath, log: (m) => this.deps.log(m) });
            } catch (err) {
              this.deps.log(`history unavailable: ${err instanceof Error ? err.message : String(err)}`);
              return null;
            }
          }
          return entry.history;
        },
        log: (m) => this.deps.log(m),
      });
      e = entry;
      this.lanes.set(realpath, e);
    }
    if (e.timer) clearTimeout(e.timer);
    e.timer = null;
    e.refs++;
    return e.lane;
  }

  /** The window let go of its lane; it is kept LANE_KEEP_MS for a D-1 reopen, then dropped once idle. */
  release(lane: EditLane): void {
    const e = this.lanes.get(lane.realpath);
    if (!e || e.lane !== lane) return;
    e.refs = Math.max(0, e.refs - 1);
    if (e.refs > 0) return;
    void lane.forget();
    if (e.timer) clearTimeout(e.timer);
    e.timer = setTimeout(() => {
      e.timer = null;
      // Dropped only once its writes and their history are done: a later open makes a new store for the same folder.
      void lane.lane
        .idle()
        .then(() => e.history?.idle())
        .then(() => {
          if (e.refs === 0 && e.timer === null && this.lanes.get(lane.realpath) === e) this.lanes.delete(lane.realpath);
        });
    }, LANE_KEEP_MS);
    e.timer.unref?.();
  }

  /** The history store of an open file's lane, if it has one. */
  historyOf(realpath: string): HistoryStore | null {
    return this.lanes.get(realpath)?.history ?? null;
  }

  /** A deck write, an external take or a history write is running or queued (the quit waits, index.ts). */
  get busy(): boolean {
    for (const e of this.lanes.values()) if (e.lane.lane.busy || e.history?.busy) return true;
    return false;
  }

  /** Resolves when the lanes of `realpath` (or of every file) and their history have finished. */
  async idle(realpath?: string): Promise<void> {
    const list = realpath ? [this.lanes.get(realpath)].filter((e): e is NonNullable<typeof e> => !!e) : [...this.lanes.values()];
    await Promise.all(list.map(async (e) => {
      await e.lane.lane.idle();
      await e.history?.idle();
    }));
  }
}

// ------------------------------------------------------------------------------------------- the window's session

/** A toast main shows in the shell, with buttons (P2-14). */
export interface ToastSpec {
  text: string;
  kind: 'info' | 'warn' | 'error';
  actions?: { id: string; label: string; run(): void }[];
}

/**
 * The shell's toasts of one window (P2-14). A toast with buttons names a fresh token; a button acts only while its
 * toast is the last one main showed (any later toast replaces it on screen), once, and only with one of its own
 * actions. The shell never names what an action does: main keeps the functions.
 */
export class ToastBook {
  private last: { token: string; actions: Map<string, () => void> } | null = null;

  constructor(private readonly mint: () => string = newUndoToken) {}

  show(t: ToastSpec): ShellToast {
    const out: ShellToast = { text: t.text, kind: t.kind };
    if (!t.actions || t.actions.length === 0) {
      this.last = null;
      return out;
    }
    const token = this.mint();
    this.last = { token, actions: new Map(t.actions.map((a) => [a.id, a.run] as [string, () => void])) };
    out.token = token;
    out.actions = t.actions.map((a) => ({ id: a.id, label: a.label }));
    return out;
  }

  /** The action of the last toast for (token, actionId), taken once; null for anything else. */
  take(token: string, actionId: string): (() => void) | null {
    const l = this.last;
    if (!l || l.token !== token) return null;
    const run = l.actions.get(actionId);
    if (!run) return null;
    this.last = null;
    return run;
  }

  clear(): void {
    this.last = null;
  }
}

export interface EditSessionDeps {
  doc: LaneDoc & { readonly readOnlyReason: string | null; readonly gone: boolean; editingAllowed(): boolean };
  lane: EditLane;
  capabilities: Capabilities;
  notes: NotesStore;
  session: {
    readonly session: { locked: LockedSpan[] };
    known(): { version: string } | null;
    noteVersion(v: { version: string; contentHash: string; title: string }): void;
  };
  /** The window's ReloadCoordinator (view-state.ts). */
  reload: {
    readonly showing: string;
    noteOwnWrite(o: { basedOn: string; version: string; reload: boolean }): void;
    /** A reload to `version` under 6.6's deferral rules; `force` even when the page shows that version. */
    requestReload(version: string, o?: { force?: boolean }): void;
    setWriting(on: boolean): void;
    setEditBusy(b: EditBusy): void;
  };
  mode(): AppMode;
  sendDeck(channel: string, payload: unknown): void;
  toast(t: ToastSpec): void;
  /** Saves the session (and shows "Saving…"). */
  save(): void;
  /** The notes changed: the shell's panel and the deck's notes. */
  notesChanged(): void;
  /** The window's effects of an adopted own write and of a taken external change (window.ts). */
  adopted(e: Adopted): void;
  taken(e: Taken): void;
  /** Writes the clipboard (Electron's clipboard, in main: the shell has no clipboard permission, P2-13). */
  clipboard(text: string): void;
  /** A native confirmation: true when the user chose `button`. */
  confirm(o: { message: string; detail: string; button: string }): Promise<boolean>;
  log(msg: string): void;
  now?(): number;
}

/** Per-channel message rates of one window (on top of the router's 1,000 a second, 9.1). */
const RATES = { begin: 30, commit: 30, candidates: 20, undo: 5 } as const;

/**
 * One document window's Edit: the lane's host while its window shows the file. Records stay in main (P2-7):
 * the deck names fields, versions, run ids and tokens, never a path, a record or an offset.
 */
export class EditSession implements LaneHost {
  readonly fields = new FieldRegistry();
  readonly input: TrustedInput;
  readonly undo = new UndoStack();
  /**
   * The target and slide of each undoable write (redo's note and Make a note keep them), and whether it wrote a
   * run the author picked (P2-8): the page shows such a write truly only after a reload, so its undo and redo
   * reload too.
   */
  private readonly targets = new Map<string, { target: EditTarget | null; slide: number | null; picked?: boolean }>();
  private readonly rates = new Map<keyof typeof RATES, RateLimiter>();
  private disposed = false;

  constructor(private readonly d: EditSessionDeps) {
    const now = d.now ?? (() => Date.now());
    this.input = new TrustedInput(now);
    for (const k of Object.keys(RATES) as (keyof typeof RATES)[]) this.rates.set(k, new RateLimiter(RATES[k], now));
  }

  // ----- LaneHost

  get doc(): LaneDoc {
    return this.d.doc;
  }

  get lane(): EditLane {
    return this.d.lane;
  }

  locks(): LockedSpan[] {
    return this.d.session.session.locked;
  }

  setLocks(spans: LockedSpan[]): void {
    // In place: the session object is shared with the store that saves it and the notes store.
    const l = this.d.session.session.locked;
    l.splice(0, l.length, ...spans);
  }

  known(): { version: string } | null {
    return this.d.session.known();
  }

  noteVersion(v: { version: string; contentHash: string; title: string }): void {
    this.d.session.noteVersion(v);
  }

  save(): void {
    this.d.save();
  }

  canWrite(job: LaneJob): boolean {
    if (!this.capEdit() || !this.d.doc.editable()) return false;
    // P2-7: an edit in Edit (or from a field that was open when Edit was left); 9.1: undo, redo and restore are
    // edit writes too, allowed while editing is allowed and the capability is on.
    return job.kind !== 'edit' || this.d.mode() === 'edit' || job.leftEdit === true;
  }

  adopted(e: Adopted): void {
    this.d.adopted(e);
  }

  taken(e: Taken): void {
    this.d.taken(e);
  }

  log(msg: string): void {
    this.d.log(`edit: ${msg}`);
  }

  // ----- the window

  private capEdit(): boolean {
    return this.d.capabilities.edit && this.d.lane.hasQueue;
  }

  /** 6.3, 6.10: whether Edit is available now, and why not. */
  availability(): ShellEditAvailability {
    const doc = this.d.doc;
    return editAvailability({ capEdit: this.capEdit(), readOnlyReason: doc.readOnlyReason, gone: doc.gone, fileName: doc.fileName, editingAllowed: doc.editingAllowed() });
  }

  /** The window opened: the lane takes it as its host (P2-3, P2-12). */
  attach(): Promise<void> {
    return this.d.lane.attach(this);
  }

  /** The window closed or reopens (D-1): the undo stack goes with it (the toast's Undo then fails cleanly, P2-10). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.undo.clear();
    this.targets.clear();
    this.fields.clear();
    this.d.lane.detach(this);
  }

  /** An InputEvent main saw reach the deck view ('input-event'): trusted input (P2-7). */
  onInput(type: string): void {
    this.input.note(type);
  }

  /** A new page loaded in the deck view: its field ids start again. */
  onPageInit(): void {
    this.fields.clear();
  }

  /** Main changed the mode. */
  onModeChange(from: AppMode, to: AppMode): void {
    if (from === 'edit' && to !== 'edit') this.fields.leftEdit();
  }

  private allow(k: keyof typeof RATES): boolean {
    return this.rates.get(k)!.allow(0);
  }

  // ----- deck → main

  /** EditDeckToMain.begin: a field opened (P2-7: on a trusted press, in Edit, with editing allowed). */
  onBegin(b: EditBegin): void {
    if (this.disposed || !this.allow('begin')) return;
    if (this.d.mode() !== 'edit' || !this.availability().available) {
      this.log('a field began outside Edit: not taken');
      return;
    }
    if (!this.input.takePress(BEGIN_WINDOW_MS)) {
      this.log('a field began without trusted input: not taken');
      return;
    }
    this.fields.begin(b, this.d.now ? this.d.now() : Date.now());
    if (!this.d.notes.canRecordEdit()) this.log('this document has too many notes for another edit');
  }

  /** EditDeckToMain.busy (6.6: a reload waits for an open field and a commit in flight). */
  onBusy(b: EditBusy): void {
    if (this.disposed) return;
    this.d.reload.setEditBusy(b);
  }

  private reply(r: EditResult): void {
    const why = r.why;
    if (why !== undefined && why.length > EDIT_LIMITS.why / 4) r.why = clip(why, EDIT_LIMITS.why / 4);
    this.d.sendDeck(MainToDeckEdit.result, r);
  }

  /** EditDeckToMain.commit (9.2 Committing an edit 5; P2-7, P2-8). Resolves when it is answered (tests). */
  async onCommit(c: EditCommit): Promise<void> {
    if (this.disposed || !this.allow('commit')) return;
    const gate = gateCommit(c, this.fields.peek(c.fieldId), { mode: this.d.mode(), capEdit: this.capEdit(), editable: this.d.doc.editable() });
    if (!gate.ok) {
      this.log(`commit refused: ${gate.why}`);
      if (gate.reply) {
        this.fields.take(c.fieldId);
        this.reply({ fieldId: c.fieldId, outcome: 'refused', reload: false, why: gate.why });
      }
      return;
    }
    this.fields.take(c.fieldId);
    const result = c.result;
    if (result.kind === 'noop') {
      this.reply({ fieldId: c.fieldId, outcome: 'noop', reload: false });
      return;
    }
    if (result.kind === 'verbatim') {
      const why = verbatimWhyText(result.why);
      const note = this.d.notes.addVerbatim({ before: result.before, after: result.after, target: c.target, slide: c.slide, why, version: c.version });
      this.d.save();
      this.d.notesChanged();
      this.reply({ fieldId: c.fieldId, outcome: 'verbatim', reload: false, noteId: note.id, why });
      return;
    }
    await this.commitEdit(c, result, gate.field);
  }

  private async commitEdit(c: EditCommit, result: Extract<CommitResult, { kind: 'edit' }>, field: FieldRecord): Promise<void> {
    if (!this.d.notes.canRecordEdit()) {
      this.reply({ fieldId: c.fieldId, outcome: 'refused', reload: false, why: 'this document has too many notes' });
      return;
    }
    let req: EditRequest;
    if (c.pick && c.pick.kind !== 'equal') {
      // P2-8: a substring or whitespace/NFC candidate is lifted to its run, in the map of the field's version.
      const known = this.d.lane.versions.get(c.version);
      const value = known ? runValueAt(known.map, result.runId) : null;
      const lifted = value !== null ? liftPick(value, c.pick) : null;
      if (!lifted) {
        const why = 'the text cannot be placed exactly';
        const note = this.d.notes.addVerbatim({ before: c.pick.nodeBefore, after: c.pick.nodeAfter, target: c.target, slide: c.slide, why, version: c.version });
        this.d.save();
        this.d.notesChanged();
        this.reply({ fieldId: c.fieldId, outcome: 'verbatim', reload: false, noteId: note.id, why });
        return;
      }
      req = { version: c.version, runId: result.runId, beforeText: lifted.beforeText, afterText: lifted.afterText, pick: { kind: c.pick.kind, nodeBefore: c.pick.nodeBefore, nodeAfter: c.pick.nodeAfter } };
    } else {
      req = { version: c.version, runId: result.runId, beforeText: result.beforeText, afterText: result.afterText };
      if (c.pick) req.pick = { kind: c.pick.kind, nodeBefore: c.pick.nodeBefore, nodeAfter: c.pick.nodeAfter };
    }
    this.d.reload.setWriting(true);
    let answer: EditResult;
    try {
      answer = await this.d.lane.exclusive(this, async (ops) => {
        const { out, adopted } = await ops.edit(req, { leftEdit: field.leftEdit });
        return this.afterEdit(c, req, out, adopted);
      });
    } catch (e) {
      this.log(`commit failed: ${e instanceof Error ? e.message : String(e)}`);
      answer = { fieldId: c.fieldId, outcome: 'refused', reload: false, why: 'the write failed' };
    } finally {
      this.d.reload.setWriting(false);
    }
    this.reply(answer);
  }

  /** Inside the lane, right after the queue answered: the note, the lock, the undo entry (P2-10, 6.6 Edit notes). */
  private afterEdit(c: EditCommit, req: EditRequest, out: WriteOutcome, adopted: Adopted | null): EditResult {
    if (out.ok) {
      const doc = this.d.doc;
      const run = findRun(doc.map, out.runId);
      const strategy = adopted?.strategy ?? (run ? run.strategy : strategyOf(out.runId, doc.map));
      let lock: LockedSpan | null = null;
      try {
        lock = run ? lockForRun('n-0000', run, doc.decoded.src) : null;
      } catch {
        lock = null;
      }
      const note = this.d.notes.addEdit({
        before: req.beforeText,
        after: req.afterText,
        runId: out.runId,
        strategy,
        version: out.version,
        line: out.line,
        col: run?.col ?? 1,
        target: c.target,
        slide: c.slide,
        lock,
      });
      const entry = this.undo.push({ record: out.record, runId: out.runId, strategy, beforeText: req.beforeText, afterText: req.afterText, noteId: note.id, line: out.line });
      // P2-8: a picked run is the author's choice of where the node's text comes from. The node they edited is
      // not that run's own parser node (a script drew it, or it is another place with the same text), so neither
      // the overlay's write into it nor an undo's patch of the run's own node shows the page as the file makes it;
      // a reload does, as for a literal.
      const picked = req.pick !== undefined;
      this.targets.set(entry.token, { target: c.target, slide: c.slide, picked });
      this.d.save();
      this.d.notesChanged();
      // 9.2 Strategy 2 step 5.5: a literal write reloads once the field closes; P2-4: so does an absorbed change.
      const reload = picked || (adopted ? adopted.absorbed || strategy !== 'html-text' : strategy !== 'html-text');
      // The window counted an html-text write as shown (window.ts onOwnWrite); a picked one is not.
      if (picked) this.d.reload.requestReload(out.version, { force: true });
      const r: EditResult = { fieldId: c.fieldId, outcome: 'written', reload, text: run?.value ?? req.afterText, line: out.line, strategy, noteId: note.id, token: entry.token };
      if (r.text !== undefined && r.text.length > EDIT_LIMITS.text) delete r.text;
      return r;
    }
    if (out.code === 'noop') return { fieldId: c.fieldId, outcome: 'noop', reload: false };
    const note = this.d.notes.addVerbatim({ before: out.verbatim.before, after: out.verbatim.after, target: c.target, slide: c.slide, why: out.why, version: c.version });
    this.d.save();
    this.d.notesChanged();
    return { fieldId: c.fieldId, outcome: 'verbatim', reload: false, noteId: note.id, why: refusalText(out.code) };
  }

  /** EditDeckToMain.candidates (P2-8): built from the DeckMap of the field's version. */
  onCandidates(r: EditCandidatesRequest): void {
    if (this.disposed || !this.allow('candidates')) return;
    if (this.d.mode() !== 'edit' || !this.availability().available || !this.input.recentPress(PRESS_WINDOW_MS)) {
      this.log('a picker request outside Edit or without trusted input: not answered');
      return;
    }
    const known = this.d.lane.versions.get(r.version);
    const candidates = known ? pickerCandidates(known.map, known.src, r.runIds, this.d.doc.fileName) : [];
    const reply: EditCandidatesReply = { fieldId: r.fieldId, candidates };
    this.d.sendDeck(MainToDeckEdit.candidates, reply);
  }

  /** EditDeckToMain.undo: the toast's Undo (P2-14: only the document's latest undoable write, right after a click). */
  onUndoToken(r: EditUndoRequest): void {
    if (this.disposed || !this.allow('undo')) return;
    if (this.d.mode() !== 'edit' || !this.input.recentPress(PRESS_WINDOW_MS)) return;
    if (!this.undo.latest(r.token)) {
      this.log('the toast named a write that is not the latest undoable one');
      return;
    }
    void this.appUndo('undo');
  }

  // ----- app undo and redo (P2-10)

  /**
   * Cmd+Z and Cmd+Shift+Z outside a text field (6.2, 9.2 Undo and redo 1–3): the newest own write, with its ORIGINAL
   * record (redo swaps it in the queue). Undo deletes its edit note (6.6) and redo makes a new one. An html-text
   * change is patched into the page; anything else reloads it. Case 3 offers Make a note.
   */
  async appUndo(kind: 'undo' | 'redo'): Promise<void> {
    if (this.disposed) return;
    const nothing = kind === 'undo' ? NOTHING_TO_UNDO : NOTHING_TO_REDO;
    if (!this.capEdit()) {
      this.d.toast({ text: nothing, kind: 'info' });
      return;
    }
    const e = kind === 'undo' ? this.undo.undo() : this.undo.redo();
    if (!e) {
      if (!this.undo.busy) this.d.toast({ text: nothing, kind: 'info' });
      return;
    }
    if (!this.d.doc.editable()) {
      this.undo.settle(e.token, { ok: false });
      this.d.toast({ text: this.availability().reason ?? EDIT_PROTECTED, kind: 'warn' });
      return;
    }
    this.d.reload.setWriting(true);
    let settled = false;
    try {
      await this.d.lane.exclusive(this, async (ops) => {
        const { out, adopted } = kind === 'undo' ? await ops.undo(e.record, e.noteId) : await ops.redo(e.record);
        if (out.ok) {
          let noteId: string | undefined;
          if (kind === 'undo') this.d.notes.removeEdit(e.noteId, { tombstone: true });
          else noteId = this.redoNote(e, out.record, out.version);
          this.undo.settle(e.token, noteId ? { ok: true, noteId } : { ok: true });
          settled = true;
          this.d.save();
          this.d.notesChanged();
          this.sendApplied(adopted, this.targets.get(e.token)?.picked === true);
          const line = adopted?.patch ? (findRun(this.d.doc.map, `h:${adopted.patch.stamp}:${adopted.patch.textIndex}`)?.line ?? e.line) : e.line;
          this.d.toast({ text: `${kind === 'undo' ? 'Undone' : 'Redone'} · ${this.d.doc.fileName}:${line}`, kind: 'info' });
          return;
        }
        this.undo.settle(e.token, { ok: false });
        settled = true;
        if (out.canMakeNote && out.code === 'stale') {
          const token = e.token;
          this.d.toast({ text: CANT_UNDO, kind: 'warn', actions: [{ id: 'make-note', label: 'Make a note', run: () => this.makeNote(token, kind) }] });
        } else this.d.toast({ text: `Not ${kind === 'undo' ? 'undone' : 'redone'}: ${refusalText(out.code)}`, kind: 'warn' });
      });
    } catch (err) {
      this.log(`${kind} failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!settled) this.undo.settle(e.token, { ok: false });
      this.d.toast({ text: `Not ${kind === 'undo' ? 'undone' : 'redone'}: the write failed`, kind: 'error' });
    } finally {
      this.d.reload.setWriting(false);
    }
  }

  /** Redo writes the edit again: a new edit note, locked, with the original's target (6.6; undo deleted the old one). */
  private redoNote(e: UndoEntry, record: WriteRecord, version: string): string {
    const doc = this.d.doc;
    const patch = undoPatch(doc.map, record);
    const run = patch ? findRun(doc.map, patch.run.id) : findRun(doc.map, e.runId);
    let lock: LockedSpan | null = null;
    try {
      lock = run && run.start <= record.start && record.start + record.rawAfter.length <= run.end ? lockForRun('n-0000', run, doc.decoded.src) : null;
    } catch {
      lock = null;
    }
    const t = this.targets.get(e.token);
    const note = this.d.notes.addEdit({
      before: e.beforeText,
      after: e.afterText,
      runId: run?.id ?? e.runId,
      strategy: e.strategy,
      version,
      line: run?.line ?? e.line,
      col: run?.col ?? 1,
      target: t?.target ?? null,
      slide: t?.slide ?? null,
      lock,
    });
    return note.id;
  }

  /**
   * P2-10: after an undo or redo the page shows the run's text, or reloads (literals, absorbed changes, and a
   * write to a picked run, whose edited node the patch would not reach).
   */
  private sendApplied(a: Adopted | null, reload = false): void {
    if (!a) return;
    // The window counted a patchable undo as shown (window.ts onOwnWrite); after a picked write it is not.
    if (reload) this.d.reload.requestReload(a.version, { force: true });
    const msg: EditApplied =
      !reload && a.patch && !a.absorbed && this.d.reload.showing === a.version ? { stamp: a.patch.stamp, textIndex: a.patch.textIndex, text: a.patch.text } : { reload: true };
    this.d.sendDeck(MainToDeckEdit.applied, msg);
  }

  /** 9.2 case 3's Make a note: a verbatim note from the stored texts (the change the undo or redo would have made). */
  private makeNote(token: string, kind: 'undo' | 'redo'): void {
    const u = this.undo.get(token);
    if (!u) {
      this.d.toast({ text: 'That edit is no longer in the undo list', kind: 'info' });
      return;
    }
    const t = this.targets.get(token);
    const before = kind === 'undo' ? u.afterText : u.beforeText;
    const after = kind === 'undo' ? u.beforeText : u.afterText;
    const note = this.d.notes.addVerbatim({ before, after, target: t?.target ?? null, slide: t?.slide ?? null, why: CANT_UNDO });
    this.undo.drop(token);
    this.targets.delete(token);
    this.d.save();
    this.d.notesChanged();
    this.d.toast({ text: `Kept as note ${note.id}`, kind: 'info' });
  }

  // ----- the notes list (P2-13)

  /** Copy: main writes the note's exact text to the clipboard. False for a note this document does not have. */
  copyNote(id: string): boolean {
    const n = this.d.notes.find(id);
    if (!n) return false;
    this.d.clipboard(noteCopyText(n, this.d.doc.fileName));
    return true;
  }

  // ----- history (P2-11)

  /** The history list, newest first (empty without the Edit capability: such a build keeps none). */
  history(): ShellHistory {
    const h = this.d.lane.history();
    const a = this.availability();
    return shellHistory(h ? h.list() : [], a.available, a.reason);
  }

  /**
   * "Restore deck to <time>" (9.2 Undo and redo 4): the diff and the counts of what it discards, a confirmation,
   * then the queue's restore against the version the user confirmed on (P2-11: serialized with edits, checked).
   */
  async restore(id: string): Promise<void> {
    if (this.disposed) return;
    const a = this.availability();
    if (!a.available) {
      this.d.toast({ text: a.reason ?? EDIT_UNAVAILABLE, kind: 'warn' });
      return;
    }
    const h = this.d.lane.history();
    const entry = h?.entry(id) ?? null;
    if (!h || !entry) {
      this.d.toast({ text: 'That version is no longer in the history', kind: 'warn' });
      return;
    }
    const doc = this.d.doc;
    const expect = doc.version;
    if (entry.sha256 === expect) {
      this.d.toast({ text: `${doc.fileName} already is that version`, kind: 'info' });
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = await h.read(id);
    } catch {
      this.d.toast({ text: 'That version cannot be read any more', kind: 'error' });
      return;
    }
    const time = historyTime(entry.at);
    const plan = restorePlan({ fileName: doc.fileName, time, counts: h.countSince(id) ?? { direct: 0, external: 0 }, diff: lineDiff(doc.decoded.src, decodeDeck(bytes).src) });
    if (!(await this.d.confirm({ message: plan.message, detail: plan.detail, button: 'Restore' }))) return;
    if (this.disposed) return;
    this.d.reload.setWriting(true);
    try {
      const { out } = await this.d.lane.exclusive(this, (ops) => ops.restore(bytes, expect));
      if (out.ok) this.d.toast({ text: `Restored ${doc.fileName} to ${time}`, kind: 'info' });
      else if (out.code === 'conflict') this.d.toast({ text: `${doc.fileName} changed since you chose; look at the history again`, kind: 'warn' });
      else if (out.code === 'noop') this.d.toast({ text: `${doc.fileName} already is that version`, kind: 'info' });
      else this.d.toast({ text: `Not restored: ${refusalText(out.code)}`, kind: 'error' });
    } catch (e) {
      this.log(`restore failed: ${e instanceof Error ? e.message : String(e)}`);
      this.d.toast({ text: 'Not restored: the write failed', kind: 'error' });
    } finally {
      this.d.reload.setWriting(false);
    }
  }
}
