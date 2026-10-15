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

import type { NoteOp, NoteOpMark, SlideState } from '@blueline/core/ipc';
import type { Mark, Note, Person, Selector, Session, SlideRef, Status, Target } from '@blueline/core/types';

/** Section 8: a block with more than 2,000 notes is refused; a session never grows past it either. */
export const MAX_NOTES = 2000;
const MAX_LOCAL_ID = 999_999;
const LOCAL_ID = /^n-([0-9]{4,6})$/;
const TITLE_MAX = 80;
const TARGET_TEXT_MAX = 300;

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
        if (t.text) target.text = t.text.slice(0, TARGET_TEXT_MAX);
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
    if (!this.session.people.some((p) => p.id === me.id)) this.session.people.push({ id: me.id, name: me.name, color: me.color });
    this.created.set(op.clientId, id);
    return { ok: true, created: { clientId: op.clientId, id } };
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
