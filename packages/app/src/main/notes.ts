// Minimal Phase 0 notes for one document (6.4 A new note / Closing a card; 6.6 Status transitions, the
// author rows the card can trigger). The deck view sends NoteOps (validated by the IPC guard); main assigns
// ids, the author and timestamps, and the deck never sets a status itself (9.1 Preload: "accepts only the
// author transitions of 6.6, other than Send and Accept pass, on that document's own notes").
//
// Phase 0 rows:
//   (none)                      create (new mark with no card open, or N)   → draft
//   draft                       close, with text or marks                   → open
//   draft                       close, empty and no marks                   → deleted (never shared: no tombstone)
//   draft                       delete                                       → deleted (discarded)
//   open, reopened, question    delete                                       → deleted, id kept as a tombstone
// Updates change text and marks of the user's own draft, open or reopened notes. Editing a sent or working
// note appends "Edited: …" to its thread and answering a question re-sends it: Phase 4 (the agent loop).
// Full anchoring (selectors, boxes) is Phase 3; a target here records the stamp and CSS path the overlay hit.
//
// Phase 2 adds the system actions of 6.6 that Edit needs, which main performs itself (never a deck's NoteOp):
//   - a direct edit creates its `edit` note as `done` (addEdit), with pass = the next pass to be sent,
//     verbatim {before, after}, the summary "Edited: <before> → <after>", the target with its SourceLoc, and
//     the locked span that protects it (section 8 Locked spans);
//   - a failed write creates a `verbatim` note as `open` with the exact before and after text, the target
//     selectors and the candidate locations, if any (addVerbatim; 6.3 When a write fails, 9.2 Strategy 3);
//   - undoing an edit deletes its `edit` note and its lock (removeEdit). Its id is kept as a tombstone, so
//     nextLocalId never hands it to another note (a redo makes a new note with a new id).
// Room: an edit whose write succeeded always gets its note. Author notes stop at MAX_NOTES (section 8), system
// notes may pass it; main asks canRecordEdit() before it opens a field and again before the write, which keeps
// the session under MAX_SESSION_NOTES (plus the edits already queued) and the local ids unexhausted.

import * as path from 'node:path';
import type { NoteOp, NoteOpMark, SlideState } from '@blueline/core/ipc';
import type { LockedSpan, Mark, Note, Person, Selector, Session, SlideRef, SourceLoc, Status, Target } from '@blueline/core/types';

/** Section 8: a block with more than 2,000 notes is refused; author notes never take a session past it. */
export const MAX_NOTES = 2000;
/**
 * The 6.6 system actions (edit and verbatim notes) may take a session past MAX_NOTES, so an edit already
 * written always gets its note; canRecordEdit() refuses new edits from this many notes on.
 */
export const MAX_SESSION_NOTES = 2500;
const MAX_LOCAL_ID = 999_999;
/** Local ids canRecordEdit() keeps free for edits already in the write queue. */
const ID_MARGIN = 100;
const LOCAL_ID = /^n-([0-9]{4,6})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TITLE_MAX = 80;
const TARGET_TEXT_MAX = 300;
/** Each side of an edit note's one-line summary (the exact texts are in `verbatim`). */
const SUMMARY_SIDE_MAX = 120;
const WHY_MAX = 200;

export type NoteOpResult =
  | { ok: true; created?: { clientId: string; id: string } }
  | { ok: false; why: string };

export interface NotesDeps {
  me(): Person;
  /** ISO timestamp. */
  now(): string;
  /** sha256 of the deck version the overlay's stamps belong to. */
  version(): string;
  /** The deck view's last slide report, or null. */
  slides(): SlideState | null;
}

/** The first `max` UTF-16 units of `s`, one fewer when the cut would split a surrogate pair (session.json is UTF-8). */
export function clipText(s: string, max: number): string {
  if (s.length <= max) return s;
  const c = s.charCodeAt(max - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? max - 1 : max);
}

/** "n-0001" … "n-999999" (section 8 id format). */
export function formatLocalId(n: number): string {
  return `n-${String(n).padStart(4, '0')}`;
}

/** The next free local id: one past the highest local id among notes and tombstones. */
export function nextLocalId(notes: readonly Pick<Note, 'id'>[], tombstones: readonly string[]): string | null {
  let max = 0;
  for (const id of [...notes.map((n) => n.id), ...tombstones]) {
    const m = LOCAL_ID.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1 > MAX_LOCAL_ID ? null : formatLocalId(max + 1);
}

/** The SlideRef of a slide index, from the deck view's slide report (9.4, section 8). */
export function slideRefFor(index: number | null, s: SlideState | null): SlideRef {
  if (index === null || !s || index < 0 || index >= s.count) {
    return { index: index ?? null, id: null, title: null, nav: { kind: 'none', value: 0 } };
  }
  const t = s.titles[index];
  const title = typeof t === 'string' && t.length > 0 ? t.slice(0, TITLE_MAX) : null;
  const hash = s.hashes?.[index];
  const id = s.ids?.[index] ?? (typeof hash === 'string' && hash.startsWith('#') && hash.length > 1 ? hash.slice(1) : null);
  let value: SlideRef['nav']['value'] = index;
  if (s.navKind === 'reveal' && s.revealIndices?.[index]) value = [s.revealIndices[index][0], s.revealIndices[index][1]];
  else if (s.navKind === 'hash' && typeof hash === 'string') value = hash;
  else if (s.navKind === 'none') value = 0;
  return { index, id: id ?? null, title, nav: { kind: s.navKind, value } };
}

function targetKey(t: NoteOpMark['targets'][number]): string {
  return JSON.stringify([t.stamp, t.css, t.role, t.text]);
}

/** Marks and targets of a note from the overlay's marks: targets deduplicated, refs t1, t2… (section 8). */
export function marksToNote(ops: readonly NoteOpMark[], version: string): { marks: Mark[]; targets: Target[] } {
  const targets: Target[] = [];
  const byKey = new Map<string, string>();
  const marks: Mark[] = ops.map((m, i) => {
    const refs: string[] = [];
    for (const t of m.targets) {
      const key = targetKey(t);
      let ref = byKey.get(key);
      if (!ref) {
        ref = `t${targets.length + 1}`;
        byKey.set(key, ref);
        const selectors: Selector[] = [];
        if (t.stamp) selectors.push({ type: 'blueline:Stamp', value: t.stamp, sha256: version });
        if (t.css) selectors.push({ type: 'CssSelector', value: t.css });
        const target: Target = { ref, selectors, box: { x: 0, y: 0, w: 1, h: 1 }, role: t.role };
        if (t.text) target.text = clipText(t.text, TARGET_TEXT_MAX);
        targets.push(target);
      }
      refs.push(ref);
    }
    const mark: Mark = { n: i + 1, tool: m.tool, path: m.path, targets: refs };
    if (m.shape) mark.shape = m.shape;
    return mark;
  });
  return { marks, targets };
}

/** 6.6 Edit notes: "pass = the next pass to be sent": one past the highest pass sent, else 1. */
export function nextPass(passes: readonly { n: number }[]): number {
  let max = 0;
  for (const p of passes) if (Number.isSafeInteger(p.n) && p.n > max) max = p.n;
  return max + 1;
}

/** One line of at most `max` characters: line breaks and tabs become spaces, a surrogate pair is never cut. */
export function oneLine(s: string, max: number): string {
  const t = s.replace(/[\r\n\t\u2028\u2029]+/g, ' ');
  if (t.length <= max) return t;
  return `${clipText(t, max - 1)}…`;
}

/** 6.6 Edit notes: the summary "Edited: <before> → <after>", one line, each side shortened to 120 characters. */
export function editSummary(before: string, after: string): string {
  return `Edited: ${oneLine(before, SUMMARY_SIDE_MAX)} → ${oneLine(after, SUMMARY_SIDE_MAX)}`;
}

/** Updates `person`'s entry in Session.people (6.8: a name change shows on every note). True when it changed. */
export function updatePersonIn(session: Session, person: Person): boolean {
  const p = session.people.find((x) => x.id === person.id);
  if (!p || (p.name === person.name && p.color === person.color)) return false;
  p.name = person.name;
  p.color = person.color;
  return true;
}

/** The element an edit was made in, as the overlay described it (core/ipc-edit.ts `target`). */
export interface SystemTarget {
  /** CSS path of the element ('' when unknown). */
  css: string;
  /** Its visible text (trimmed to 300 characters here). */
  text: string;
  role: string;
  /** Its `data-bl-e` stamp, or null. */
  stamp: string | null;
}

/** A candidate location (SourceLoc.candidates, 9.2 Strategy 2 step 3). */
export type SourceCandidate = NonNullable<SourceLoc['candidates']>[number];

/** addEdit's input: one successful direct write (WriteOutcome ok, and the commit that asked for it). */
export interface EditNoteInput {
  /** The run's decoded text before the write (EditRequest.beforeText). */
  before: string;
  /** The run's decoded text the write put there (EditRequest.afterText). */
  after: string;
  runId: string;
  /** Default: `html-text` for an `h:` run, `script-literal` for an `l:` run (pass `json-literal` for JSON). */
  strategy?: 'html-text' | 'script-literal' | 'json-literal';
  /** The version the write produced (WriteOutcome.version): the lock's offsets and the stamp belong to it. */
  version: string;
  /** 1-based line and column of the run (WriteOutcome.line, the map run's col; col 1 when omitted). */
  line: number;
  col?: number;
  target: SystemTarget | null;
  /** The slide index the deck view reported for the element, or null. */
  slide: number | null;
  /**
   * The run's range and text in `version` (core/locked-spans.ts lockForRun gives the same fields). The note's
   * id and state are set here. Null: the note is created without a lock.
   */
  lock: Pick<LockedSpan, 'start' | 'end' | 'text'> | null;
}

/** addVerbatim's input: a write that could not be placed or verified (6.3), or undo's Make a note (9.2 case 3). */
export interface VerbatimNoteInput {
  /** The exact text before, and the text the user wanted (6.3: "The agent must apply your exact words"). */
  before: string;
  after: string;
  target: SystemTarget | null;
  slide: number | null;
  /** Why it was not written; kept as the note's one-line summary ("Not written: …") until the agent's own. */
  why?: string;
  /** Where the text is, when main knows it (strategy is set to `agent`, 9.2 Strategy 3). */
  source?: SourceLoc;
  /** Candidate locations (9.2 Strategy 3). Without `source`, they need `version` (the version they index). */
  candidates?: SourceCandidate[];
  /** The version the field was opened on (the commit's): the candidates' offsets and the stamp belong to it. */
  version?: string;
}

function isOffset(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

function goodCandidate(c: SourceCandidate): boolean {
  return (
    !!c &&
    isOffset(c.start) &&
    isOffset(c.end) &&
    c.start <= c.end &&
    isOffset(c.line) &&
    typeof c.context === 'string' &&
    (c.keyWarning === undefined || typeof c.keyWarning === 'string')
  );
}

function copyCandidate(c: SourceCandidate): SourceCandidate {
  const out: SourceCandidate = { start: c.start, end: c.end, line: c.line, context: c.context };
  if (c.keyWarning !== undefined) out.keyWarning = c.keyWarning;
  return out;
}

const UPDATABLE: ReadonlySet<Status> = new Set<Status>(['draft', 'open', 'reopened']);
const DELETABLE: ReadonlySet<Status> = new Set<Status>(['draft', 'open', 'reopened', 'question']);

function isEmptyNote(n: Note): boolean {
  return n.text.trim().length === 0 && n.marks.length === 0 && n.recordings.length === 0;
}

/** The notes of one document, kept in its Session. */
export class NotesStore {
  /** clientId → note id, so a repeated create from the same card is not a second note. */
  private readonly created = new Map<string, string>();

  constructor(
    private readonly session: Session,
    private readonly deps: NotesDeps,
  ) {}

  get notes(): readonly Note[] {
    return this.session.notes;
  }

  find(id: string): Note | undefined {
    return this.session.notes.find((n) => n.id === id);
  }

  /** Applies one validated NoteOp from this document's deck view. */
  apply(op: NoteOp): NoteOpResult {
    switch (op.op) {
      case 'create':
        return this.create(op);
      case 'update':
        return this.update(op);
      case 'close':
        return this.close(op.id);
      case 'delete':
        return this.remove(op.id);
      default:
        return { ok: false, why: 'unknown op' };
    }
  }

  private create(op: Extract<NoteOp, { op: 'create' }>): NoteOpResult {
    const known = this.created.get(op.clientId);
    if (known && this.find(known)) return { ok: true, created: { clientId: op.clientId, id: known } };
    if (this.session.notes.length >= MAX_NOTES) return { ok: false, why: 'too many notes' };
    const id = nextLocalId(this.session.notes, this.session.tombstones);
    if (!id) return { ok: false, why: 'no free note id' };
    const me = this.deps.me();
    const at = this.deps.now();
    const { marks, targets } = marksToNote(op.marks, this.deps.version());
    const note: Note = {
      id,
      kind: 'markup',
      status: 'draft',
      author: me.id,
      createdAt: at,
      updatedAt: at,
      pass: null,
      slide: slideRefFor(op.slide, this.deps.slides()),
      targets,
      marks,
      text: op.text,
      recordings: [],
      thread: [],
    };
    this.session.notes.push(note);
    this.addPerson(me);
    this.created.set(op.clientId, id);
    return { ok: true, created: { clientId: op.clientId, id } };
  }

  /** 6.8: Session.people lists everyone with notes; the entry follows the user's current name. */
  private addPerson(me: Person): void {
    if (this.session.people.some((p) => p.id === me.id)) updatePersonIn(this.session, me);
    else this.session.people.push({ id: me.id, name: me.name, color: me.color });
  }

  /** A name change (identity.ts Identity.setName): updates the person's entry. True when the session changed. */
  updatePerson(person: Person): boolean {
    return updatePersonIn(this.session, person);
  }

  /**
   * Room for one more direct edit and its note: the session holds fewer than MAX_SESSION_NOTES notes and local
   * ids are left. Main asks before it opens an edit field and again before the write (never after it: an edit
   * already written always gets its note).
   */
  canRecordEdit(): boolean {
    if (this.session.notes.length >= MAX_SESSION_NOTES) return false;
    const next = nextLocalId(this.session.notes, this.session.tombstones);
    return next !== null && Number(next.slice(2)) + ID_MARGIN <= MAX_LOCAL_ID;
  }

  /** The deck file as SourceLoc.file names it: relative to its folder, so its name (section 8). */
  private fileName(): string {
    return path.basename(this.session.deck.realpath || this.session.deck.path);
  }

  private systemTargets(t: SystemTarget | null, version: string, source: SourceLoc | undefined): Target[] {
    if (!t && !source) return [];
    const selectors: Selector[] = [];
    if (t?.stamp) selectors.push({ type: 'blueline:Stamp', value: t.stamp, sha256: version });
    if (t?.css) selectors.push({ type: 'CssSelector', value: t.css });
    const target: Target = { ref: 't1', selectors, box: { x: 0, y: 0, w: 1, h: 1 }, role: t?.role || 'element' };
    if (t?.text) target.text = clipText(t.text, TARGET_TEXT_MAX);
    if (source) target.source = source;
    return [target];
  }

  /**
   * 6.6 Edit notes: records a successful direct write as an `edit` note, `done`, with pass = the next pass to be
   * sent, verbatim {before, after}, the summary "Edited: <before> → <after>", the target and its SourceLoc, and
   * locks its span (section 8). Never refuses for room (see canRecordEdit); throws only when no local id is
   * left, which canRecordEdit rules out.
   */
  addEdit(i: EditNoteInput): Note {
    const id = nextLocalId(this.session.notes, this.session.tombstones);
    if (!id) throw new Error('no free note id');
    const me = this.deps.me();
    const at = this.deps.now();
    const version = typeof i.version === 'string' && SHA256.test(i.version) ? i.version : this.deps.version();
    const strategy = i.strategy ?? (typeof i.runId === 'string' && i.runId.startsWith('h:') ? 'html-text' : 'script-literal');
    const lock = i.lock && isOffset(i.lock.start) && isOffset(i.lock.end) && i.lock.start <= i.lock.end && typeof i.lock.text === 'string' ? i.lock : null;
    let source: SourceLoc | undefined;
    if (lock) {
      source = {
        file: this.fileName(),
        version,
        start: lock.start,
        end: lock.end,
        line: isOffset(i.line) && i.line > 0 ? i.line : 1,
        col: isOffset(i.col) && i.col > 0 ? i.col : 1,
        strategy,
        confidence: 'exact',
      };
    }
    const note: Note = {
      id,
      kind: 'edit',
      status: 'done',
      author: me.id,
      createdAt: at,
      updatedAt: at,
      pass: nextPass(this.session.passes),
      slide: slideRefFor(i.slide, this.deps.slides()),
      targets: this.systemTargets(i.target, version, source),
      marks: [],
      text: '',
      verbatim: { before: i.before, after: i.after },
      recordings: [],
      thread: [],
      summary: editSummary(i.before, i.after),
    };
    this.session.notes.push(note);
    if (lock) this.session.locked.push({ start: lock.start, end: lock.end, text: lock.text, noteId: id, state: 'ok' });
    this.addPerson(me);
    return note;
  }

  /**
   * 6.3 When a write fails, 9.2 Strategy 3: keeps the user's exact words as a `verbatim` note, `open`, with the
   * target selectors and the candidate locations, if any. Also undo's Make a note (9.2 case 3). Never refuses
   * for room; throws only when no local id is left.
   */
  addVerbatim(i: VerbatimNoteInput): Note {
    const id = nextLocalId(this.session.notes, this.session.tombstones);
    if (!id) throw new Error('no free note id');
    const me = this.deps.me();
    const at = this.deps.now();
    const candidates = (i.candidates ?? []).filter(goodCandidate).map(copyCandidate);
    let source: SourceLoc | undefined;
    if (i.source && SHA256.test(i.source.version) && isOffset(i.source.start) && isOffset(i.source.end) && i.source.start <= i.source.end) {
      const s = i.source;
      source = {
        file: this.fileName(),
        version: s.version,
        start: s.start,
        end: s.end,
        line: isOffset(s.line) && s.line > 0 ? s.line : 1,
        col: isOffset(s.col) && s.col > 0 ? s.col : 1,
        // 9.2 Strategy 3: whatever was planned, the agent applies it now; how well the text matched stays.
        strategy: 'agent',
        confidence: s.confidence === 'exact' || s.confidence === 'ambiguous' ? s.confidence : 'none',
      };
      const all = candidates.length > 0 ? candidates : (s.candidates ?? []).filter(goodCandidate).map(copyCandidate);
      if (all.length > 0) source.candidates = all;
    } else if (candidates.length > 0 && typeof i.version === 'string' && SHA256.test(i.version)) {
      // Only the candidates are known: the location is the first one's (they carry no column).
      const c = candidates[0];
      source = { file: this.fileName(), version: i.version, start: c.start, end: c.end, line: c.line > 0 ? c.line : 1, col: 1, strategy: 'agent', confidence: 'ambiguous', candidates };
    }
    const note: Note = {
      id,
      kind: 'verbatim',
      status: 'open',
      author: me.id,
      createdAt: at,
      updatedAt: at,
      pass: null,
      slide: slideRefFor(i.slide, this.deps.slides()),
      // The stamp belongs to the version the field was opened on (the commit's), when main gives it.
      targets: this.systemTargets(i.target, source?.version ?? (typeof i.version === 'string' && SHA256.test(i.version) ? i.version : this.deps.version()), source),
      marks: [],
      text: '',
      verbatim: { before: i.before, after: i.after },
      recordings: [],
      thread: [],
    };
    if (typeof i.why === 'string' && i.why.trim().length > 0) note.summary = `Not written: ${oneLine(i.why.trim(), WHY_MAX)}`;
    this.session.notes.push(note);
    this.addPerson(me);
    return note;
  }

  /**
   * 6.6: "undoing the edit deletes its note". Removes the `edit` note `id` and its locked spans, and keeps the
   * id as a tombstone (the default), so no later note reuses it. Returns false when there is no such edit note.
   */
  removeEdit(id: string, opts: { tombstone?: boolean } = {}): boolean {
    const i = this.session.notes.findIndex((n) => n.id === id && n.kind === 'edit');
    if (i === -1) return false;
    this.session.notes.splice(i, 1);
    // In place: the session object is shared with the window that saves it.
    for (let k = this.session.locked.length - 1; k >= 0; k--) if (this.session.locked[k].noteId === id) this.session.locked.splice(k, 1);
    if (opts.tombstone !== false && !this.session.tombstones.includes(id)) this.session.tombstones.push(id);
    this.forgetClientId(id);
    return true;
  }

  private update(op: Extract<NoteOp, { op: 'update' }>): NoteOpResult {
    const n = this.find(op.id);
    if (!n) return { ok: false, why: 'no such note' };
    // Reviewer-owned fields (text, marks) belong to the note's author (6.8).
    if (n.author !== this.deps.me().id) return { ok: false, why: 'not your note' };
    if (!UPDATABLE.has(n.status)) return { ok: false, why: `cannot edit a ${n.status} note yet` };
    let changed = false;
    if (op.text !== undefined && op.text !== n.text) {
      n.text = op.text;
      changed = true;
    }
    if (op.marks !== undefined) {
      const { marks, targets } = marksToNote(op.marks, this.deps.version());
      n.marks = marks;
      n.targets = targets;
      changed = true;
    }
    if (changed) n.updatedAt = this.deps.now();
    return { ok: true };
  }

  private close(id: string): NoteOpResult {
    const i = this.session.notes.findIndex((n) => n.id === id);
    if (i === -1) return { ok: false, why: 'no such note' };
    const n = this.session.notes[i];
    if (n.status !== 'draft') return { ok: true }; // closing a card on a note that is not a draft changes nothing
    if (n.author !== this.deps.me().id) return { ok: false, why: 'not your note' };
    if (isEmptyNote(n)) {
      this.session.notes.splice(i, 1);
      this.forgetClientId(id);
      return { ok: true };
    }
    n.status = 'open';
    n.updatedAt = this.deps.now();
    return { ok: true };
  }

  private remove(id: string): NoteOpResult {
    const i = this.session.notes.findIndex((n) => n.id === id);
    if (i === -1) return { ok: false, why: 'no such note' };
    const n = this.session.notes[i];
    if (!DELETABLE.has(n.status)) return { ok: false, why: `cannot delete a ${n.status} note` };
    if (n.status === 'draft' && n.author !== this.deps.me().id) return { ok: false, why: 'not your note' };
    this.session.notes.splice(i, 1);
    // A discarded draft never left the machine; anything else keeps a tombstone so bringing the same copy
    // in again does not re-create it (6.6).
    if (n.status !== 'draft' && !this.session.tombstones.includes(id)) this.session.tombstones.push(id);
    this.forgetClientId(id);
    return { ok: true };
  }

  private forgetClientId(id: string): void {
    for (const [c, v] of this.created) if (v === id) this.created.delete(c);
  }
}
