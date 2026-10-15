// <userData>/files/<fileKey>/session.json (9.7): a document's notes, edits, statuses, passes and settings.
// Every write goes through the atomic writer, one at a time per file, newest state wins (6.8 "One writer":
// "session.json writes are atomic: a temp file, then rename").
//
// The file is Blueline's own app data, but it is still read defensively: a file that does not parse, or
// that holds a note this version cannot read, is kept aside as `session.json.unreadable-<time>` before
// anything is written over it, so no note is ever lost to a parse.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  LockedSpan,
  Mark,
  MarkShape,
  MarkTool,
  Note,
  NoteKind,
  Person,
  Recording,
  Selector,
  Session,
  SlideNavKind,
  SlideRef,
  Status,
  Target,
} from '@blueline/core/types';
import { CoalescingWriter } from './atomic-write';

const STATUSES: readonly Status[] = ['draft', 'open', 'sent', 'working', 'done', 'question', 'accepted', 'reopened'];
const KINDS: readonly NoteKind[] = ['markup', 'verbatim', 'edit'];
const TOOLS: readonly MarkTool[] = ['pen', 'highlighter', 'arrow', 'pin', 'box'];
const SHAPES: readonly MarkShape[] = ['ellipse', 'freehand', 'underline', 'strike', 'rect'];
const NAV_KINDS: readonly SlideNavKind[] = ['hash', 'reveal', 'index', 'scroll', 'none'];
const NOTE_ID = /^(?:[a-z0-9-]{1,40}:)?n-[0-9]{4,6}$/;
const PERSON_ID = /^[a-z0-9-]{1,40}$/;
const COLOR = /^#[0-9a-f]{6}$/;
const MAX_SESSION_BYTES = 256 * 1024 * 1024;

export function sessionFileFor(userData: string, fileKey: string): string {
  if (!/^[0-9a-f]{16}$/.test(fileKey)) throw new Error('invalid fileKey');
  return path.join(userData, 'files', fileKey, 'session.json');
}

export function emptySession(deck: Session['deck']): Session {
  return { version: 2, deck: { ...deck }, people: [], notes: [], locked: [], passes: [], tombstones: [] };
}

// ------------------------------------------------------------------------------------- reading defensively

class Bad extends Error {}
function bad(why: string): never {
  throw new Bad(why);
}
function obj(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) bad(`${what}: not an object`);
  return v as Record<string, unknown>;
}
function field(o: Record<string, unknown>, k: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
}
function str(v: unknown, what: string): string {
  if (typeof v !== 'string') bad(`${what}: not a string`);
  return v;
}
function optStr(v: unknown, what: string): string | undefined {
  return v === undefined ? undefined : str(v, what);
}
function num(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) bad(`${what}: not a number`);
  return v;
}
function arr(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) bad(`${what}: not an array`);
  return v;
}
function oneOf<T extends string>(v: unknown, all: readonly T[], what: string): T {
  if (typeof v !== 'string' || !(all as readonly string[]).includes(v)) bad(`${what}: unexpected value`);
  return v as T;
}

function readSlide(v: unknown): SlideRef {
  const o = obj(v, 'slide');
  const nav = obj(field(o, 'nav'), 'slide.nav');
  const index = field(o, 'index');
  const id = field(o, 'id');
  const title = field(o, 'title');
  const value = field(nav, 'value');
  let navValue: SlideRef['nav']['value'];
  if (typeof value === 'string' || typeof value === 'number') navValue = value;
  else if (Array.isArray(value) && value.length === 2 && value.every((x) => typeof x === 'number')) navValue = [value[0] as number, value[1] as number];
  else bad('slide.nav.value');
  return {
    index: index === null ? null : num(index, 'slide.index'),
    id: id === null ? null : str(id, 'slide.id'),
    title: title === null ? null : str(title, 'slide.title'),
    nav: { kind: oneOf(field(nav, 'kind'), NAV_KINDS, 'slide.nav.kind'), value: navValue },
  };
}

function readSelector(v: unknown): Selector {
  const o = obj(v, 'selector');
  const type = field(o, 'type');
  switch (type) {
    case 'blueline:Stamp':
      return { type, value: str(field(o, 'value'), 'stamp'), sha256: str(field(o, 'sha256'), 'stamp.sha256') };
    case 'CssSelector':
      return { type, value: str(field(o, 'value'), 'css') };
    case 'TextQuoteSelector':
      return { type, exact: str(field(o, 'exact'), 'exact'), prefix: str(field(o, 'prefix'), 'prefix'), suffix: str(field(o, 'suffix'), 'suffix') };
    case 'TextPositionSelector':
      return { type, start: num(field(o, 'start'), 'start'), end: num(field(o, 'end'), 'end') };
    default:
      return bad('selector.type');
  }
}

function readTarget(v: unknown): Target {
  const o = obj(v, 'target');
  const box = obj(field(o, 'box'), 'target.box');
  const t: Target = {
    ref: str(field(o, 'ref'), 'target.ref'),
    selectors: arr(field(o, 'selectors'), 'target.selectors').map(readSelector),
    box: { x: num(field(box, 'x'), 'box.x'), y: num(field(box, 'y'), 'box.y'), w: num(field(box, 'w'), 'box.w'), h: num(field(box, 'h'), 'box.h') },
    role: str(field(o, 'role'), 'target.role'),
  };
  if (field(o, 'pending') === true) t.pending = true;
  const text = optStr(field(o, 'text'), 'target.text');
  if (text !== undefined) t.text = text;
  const html = optStr(field(o, 'html'), 'target.html');
  if (html !== undefined) t.html = html;
  const state = field(o, 'state');
  if (state !== undefined) {
    const s = obj(state, 'target.state');
    const click = field(s, 'click');
    const hover = field(s, 'hover');
    t.state = {};
    if (click !== undefined) t.state.click = arr(click, 'state.click').map((c) => str(c, 'state.click[]'));
    if (hover !== undefined) t.state.hover = str(hover, 'state.hover');
  }
  // `source` (SourceLoc) is re-resolved against the current file whenever it is used (9.5); Phase 0 keeps none.
  return t;
}

function readMark(v: unknown): Mark {
  const o = obj(v, 'mark');
  const m: Mark = {
    n: num(field(o, 'n'), 'mark.n'),
    tool: oneOf(field(o, 'tool'), TOOLS, 'mark.tool'),
    targets: arr(field(o, 'targets'), 'mark.targets').map((t) => str(t, 'mark.targets[]')),
  };
  const shape = field(o, 'shape');
  if (shape !== undefined) m.shape = oneOf(shape, SHAPES, 'mark.shape');
  const p = optStr(field(o, 'path'), 'mark.path');
  if (p !== undefined) m.path = p;
  const t = field(o, 't');
  if (t !== undefined) m.t = num(t, 'mark.t');
  return m;
}

function readRecording(v: unknown): Recording {
  const o = obj(v, 'recording');
  const r: Recording = {
    id: str(field(o, 'id'), 'recording.id'),
    author: str(field(o, 'author'), 'recording.author'),
    source: oneOf(field(o, 'source'), ['attached', 'recorded', 'received'] as const, 'recording.source'),
    mime: str(field(o, 'mime'), 'recording.mime'),
    file: str(field(o, 'file'), 'recording.file'),
    durationMs: num(field(o, 'durationMs'), 'recording.durationMs'),
  };
  const transcript = optStr(field(o, 'transcript'), 'recording.transcript');
  if (transcript !== undefined) r.transcript = transcript;
  // words and stt arrive with Phase 5 transcription.
  return r;
}

/** Rebuilds one note field by field; throws Bad if any field is unreadable. */
export function readNote(v: unknown): Note {
  const o = obj(v, 'note');
  const id = str(field(o, 'id'), 'note.id');
  if (!NOTE_ID.test(id)) bad('note.id');
  const pass = field(o, 'pass');
  const n: Note = {
    id,
    kind: oneOf(field(o, 'kind'), KINDS, 'note.kind'),
    status: oneOf(field(o, 'status'), STATUSES, 'note.status'),
    author: str(field(o, 'author'), 'note.author'),
    createdAt: str(field(o, 'createdAt'), 'note.createdAt'),
    updatedAt: str(field(o, 'updatedAt'), 'note.updatedAt'),
    pass: pass === null ? null : num(pass, 'note.pass'),
    slide: readSlide(field(o, 'slide')),
    targets: arr(field(o, 'targets'), 'note.targets').map(readTarget),
    marks: arr(field(o, 'marks'), 'note.marks').map(readMark),
    text: str(field(o, 'text'), 'note.text'),
    recordings: arr(field(o, 'recordings') ?? [], 'note.recordings').map(readRecording),
    thread: arr(field(o, 'thread') ?? [], 'note.thread').map((t) => {
      const e = obj(t, 'thread[]');
      return { from: str(field(e, 'from'), 'thread.from'), text: str(field(e, 'text'), 'thread.text'), at: str(field(e, 'at'), 'thread.at') };
    }),
  };
  const instruction = optStr(field(o, 'instruction'), 'note.instruction');
  if (instruction !== undefined) n.instruction = instruction;
  const verbatim = field(o, 'verbatim');
  if (verbatim !== undefined) {
    const vb = obj(verbatim, 'note.verbatim');
    n.verbatim = { before: str(field(vb, 'before'), 'verbatim.before'), after: str(field(vb, 'after'), 'verbatim.after') };
  }
  const shots = field(o, 'shots');
  if (shots !== undefined) {
    const s = obj(shots, 'note.shots');
    n.shots = { slide: str(field(s, 'slide'), 'shots.slide'), crop: str(field(s, 'crop'), 'shots.crop') };
    if (field(s, 'approximate') === true) n.shots.approximate = true;
  }
  const summary = optStr(field(o, 'summary'), 'note.summary');
  if (summary !== undefined) n.summary = summary;
  return n;
}

function readPerson(v: unknown): Person {
  const o = obj(v, 'person');
  const id = str(field(o, 'id'), 'person.id');
  const color = str(field(o, 'color'), 'person.color');
  if (!PERSON_ID.test(id) || !COLOR.test(color)) bad('person');
  return { id, name: str(field(o, 'name'), 'person.name'), color };
}

function readLocked(v: unknown): LockedSpan {
  const o = obj(v, 'locked');
  const l: LockedSpan = {
    start: num(field(o, 'start'), 'locked.start'),
    end: num(field(o, 'end'), 'locked.end'),
    text: str(field(o, 'text'), 'locked.text'),
    noteId: str(field(o, 'noteId'), 'locked.noteId'),
    state: oneOf(field(o, 'state'), ['ok', 'violated'] as const, 'locked.state'),
  };
  const change = field(o, 'change');
  if (change !== undefined) {
    const c = obj(change, 'locked.change');
    l.change = { before: str(field(c, 'before'), 'change.before'), after: str(field(c, 'after'), 'change.after') };
  }
  return l;
}

export interface ReadResult {
  session: Session;
  /** Something could not be read: the original file must be kept aside before the next write. */
  lossy: boolean;
}

/**
 * Reads a parsed session.json. Unreadable notes, people and spans are dropped and `lossy` is set; the
 * caller keeps the original file. `deck` is always the current document's (the caller passes it).
 */
export function readSession(raw: unknown, deck: Session['deck']): ReadResult {
  let lossy = false;
  const keep = <T>(items: unknown, read: (v: unknown) => T): T[] => {
    if (!Array.isArray(items)) {
      if (items !== undefined) lossy = true;
      return [];
    }
    const out: T[] = [];
    for (const it of items) {
      try {
        out.push(read(it));
      } catch (e) {
        if (!(e instanceof Bad)) throw e;
        lossy = true;
      }
    }
    return out;
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw as Record<string, unknown>).version !== 2) {
    return { session: emptySession(deck), lossy: true };
  }
  const r = raw as Record<string, unknown>;
  const s = emptySession(deck);
  s.notes = keep(field(r, 'notes'), readNote);
  s.people = keep(field(r, 'people'), readPerson);
  s.locked = keep(field(r, 'locked'), readLocked);
  s.tombstones = keep(field(r, 'tombstones'), (t) => {
    const id = str(t, 'tombstone');
    if (!NOTE_ID.test(id)) bad('tombstone');
    return id;
  });
  s.passes = keep(field(r, 'passes'), (p) => {
    const o = obj(p, 'pass');
    const out: Session['passes'][number] = { n: num(field(o, 'n'), 'pass.n'), sentAt: str(field(o, 'sentAt'), 'pass.sentAt'), snapshot: str(field(o, 'snapshot'), 'pass.snapshot') };
    const acceptedAt = optStr(field(o, 'acceptedAt'), 'pass.acceptedAt');
    if (acceptedAt !== undefined) out.acceptedAt = acceptedAt;
    const commit = optStr(field(o, 'commit'), 'pass.commit');
    if (commit !== undefined) out.commit = commit;
    return out;
  });
  const deckNav = field(r, 'deckNav');
  if (deckNav !== undefined) {
    try {
      const d = obj(deckNav, 'deckNav');
      s.deckNav = { forward: str(field(d, 'forward'), 'deckNav.forward'), back: str(field(d, 'back'), 'deckNav.back') };
    } catch {
      lossy = true;
    }
  }
  const viewport = field(r, 'viewport');
  if (viewport !== undefined) {
    try {
      const v = obj(viewport, 'viewport');
      s.viewport = { w: num(field(v, 'w'), 'w'), h: num(field(v, 'h'), 'h'), dpr: num(field(v, 'dpr'), 'dpr') };
    } catch {
      lossy = true;
    }
  }
  const settings = field(r, 'settings');
  if (settings !== undefined && settings && typeof settings === 'object' && !Array.isArray(settings)) {
    const st = settings as Record<string, unknown>;
    s.settings = {};
    const ink = field(st, 'inkFilter');
    if (ink === 'open' || ink === 'all' || ink === 'none') s.settings.inkFilter = ink;
    if (typeof field(st, 'smartPunctuation') === 'boolean') s.settings.smartPunctuation = st.smartPunctuation as boolean;
    if (typeof field(st, 'restatement') === 'boolean') s.settings.restatement = st.restatement as boolean;
  }
  return { session: s, lossy };
}

// ------------------------------------------------------------------------------------- the store

export type SaveEvent = { state: 'saved'; at: Date } | { state: 'error'; error: Error };

/** One document's session: loaded at open, written atomically after each change. */
export class SessionStore {
  private readonly writer: CoalescingWriter;
  private keptAside = false;

  private constructor(
    readonly file: string,
    readonly session: Session,
    private lossy: boolean,
    onSave: (e: SaveEvent) => void,
  ) {
    this.writer = new CoalescingWriter(file, (err) => onSave(err ? { state: 'error', error: err } : { state: 'saved', at: new Date() }));
  }

  /**
   * Loads `file` for `deck` (or starts empty). The deck fields are always the current document's: path,
   * realpath, fileKey, sha256 (without the notes block) and title. Phase 1 adds "Continue the review from
   * <old path>?" for moved files (9.7).
   */
  static async open(file: string, deck: Session['deck'], onSave: (e: SaveEvent) => void = () => undefined): Promise<SessionStore> {
    let text: string | null = null;
    try {
      const st = await fs.promises.stat(file);
      if (st.isFile() && st.size <= MAX_SESSION_BYTES) text = await fs.promises.readFile(file, 'utf8');
      else text = '';
    } catch (e) {
      if ((e as { code?: unknown }).code !== 'ENOENT') text = '';
    }
    if (text === null) return new SessionStore(file, emptySession(deck), false, onSave);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    const r = readSession(parsed, deck);
    return new SessionStore(file, r.session, r.lossy, onSave);
  }

  /** Writes the current session (coalesced). Resolves when the queue is idle; failures go to onSave. */
  async save(): Promise<void> {
    if (this.lossy && !this.keptAside) {
      // Keep what could not be read before writing over it.
      this.keptAside = true;
      const aside = `${this.file}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      await fs.promises.copyFile(this.file, aside, fs.constants.COPYFILE_EXCL).catch(() => undefined);
    }
    return this.writer.schedule(() => new TextEncoder().encode(JSON.stringify(this.session, null, 2) + '\n'));
  }

  idle(): Promise<void> {
    return this.writer.idle();
  }

  get busy(): boolean {
    return this.writer.busy;
  }
}
