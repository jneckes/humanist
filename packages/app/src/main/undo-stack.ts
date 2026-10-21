// The app's undo and redo of Blueline's own writes, one stack per document, in memory (9.2 Undo and redo 1–4;
// decision P2-10). Outside a text field Cmd+Z and Cmd+Shift+Z come here; inside one they stay the browser's
// native undo for that field (9.2 Undo and redo 5), which main routes elsewhere.
//
// Each entry holds the ORIGINAL WriteRecord of a write (9.2: the raw splice, never decoded text). Undo and redo
// both pass that same record to the write queue: redo is undo with rawBefore and rawAfter swapped, which the
// queue does itself (swapRecord), so an undo restores the previous bytes exactly and a redo the written ones.
// The entry also keeps the decoded texts the write replaced and wrote, for case 3's **Make a note** (a verbatim
// note needs the words, not the escaped source), and the edit note's id, since undoing an edit deletes its note
// (6.6) and redoing it makes a new one.
//
// Records never come from a deck (P2-7): main pushes the queue's own outcome here, and a deck (the toast's Undo)
// names only a token that main minted, which `latest` checks is still the document's newest undoable write
// (P2-14). The stack is dropped with its window (a D-1 reopen starts empty, so an old toast's Undo then fails
// cleanly), and it never restores a whole-file snapshot: that is the history list's "Restore deck to <time>".
//
// Lead decision E-3 (review finding 14): an edit's entry exists from the moment main accepts its commit (reserve: a
// pending slot, in the order commits were accepted), is filled when its write lands and cancelled when it becomes a
// note or a refusal, so "the newest write" is well defined while writes are in flight. undo() takes the newest
// entry whose write has landed; main runs it in the document's lane, behind the commits in flight. An entry put
// back after a failed undo goes where it was, below everything accepted since. The hardening round: a Cmd+Z pressed
// while the newest slot is pending is for that write (pendingTop, undoSlot): when its commit becomes a note, the
// undo does nothing (it used to undo the author's previous edit, on another slide).

import { randomBytes } from 'node:crypto';
import type { WriteRecord } from '@blueline/core/types';

/** One own write that can be undone or redone. */
export interface UndoEntry {
  /** Main's id for this write: 32 lowercase hex characters, minted by push(). The toast's Undo names it. */
  token: string;
  /** The write's original record. Undo and redo both use it (the queue swaps it for redo). */
  record: WriteRecord;
  /** The run the write changed (`h:bl-<n>:<i>` or `l:<unit>:<run>`), in record.versionBefore's map. */
  runId: string;
  strategy: 'html-text' | 'script-literal' | 'json-literal';
  /** The run's decoded text before the write (EditRequest.beforeText). */
  beforeText: string;
  /** The run's decoded text the write put there (after the commit clean-up). */
  afterText: string;
  /** The edit note of the write's current state: deleted by an undo, replaced by redo's new note. */
  noteId: string;
  /** 1-based line of the run (WriteOutcome.line), for the toasts. */
  line: number;
}

/**
 * What push() takes: an entry without its token (or with one main minted earlier with newUndoToken()). The
 * strategy may come as a plain string (WrittenVersion.strategy); push() checks it is one of the three.
 */
export type NewUndoEntry = Omit<UndoEntry, 'token' | 'strategy'> & { token?: string; strategy: string };

/** The token form (main's IPC validators check a deck's token against it before looking it up). */
export const UNDO_TOKEN = /^[0-9a-f]{32}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RUN_ID = /^(?:h:bl-[0-9]{1,9}:[0-9]{1,9}|l:[0-9]{1,9}:[0-9]{1,9})$/;
const NOTE_ID = /^(?:[a-z0-9-]{1,40}:)?n-[0-9]{4,6}$/;
const STRATEGIES: readonly UndoEntry['strategy'][] = ['html-text', 'script-literal', 'json-literal'];
/** editor/undo.ts CONTEXT: 32 source characters, 33 when a surrogate pair is kept whole. */
const CONTEXT_MAX = 33;
/** Entries kept per stack; the oldest goes first. An undo that far back is a "Restore deck to <time>". */
export const MAX_UNDO_ENTRIES = 500;

/** A fresh token: 128 random bits, so a deck cannot guess another write's token. */
export function newUndoToken(): string {
  return randomBytes(16).toString('hex');
}

/**
 * True if `r` is a WriteRecord as the write queue makes them (9.2 Undo and redo): sha256 versions, a
 * non-negative integer start, raw slices, and at most 33 characters of context on each side. The same checks as
 * the editor's isWriteRecord (packages/editor/src/undo.ts), which main may not import (the capability seam,
 * 9.6), plus the version format. Main only stores records its own queue returned; this keeps a malformed one
 * (a bug, never a deck) out of the stack, because planUndo trusts `start` when the hash matches.
 */
export function isUndoRecord(r: unknown): r is WriteRecord {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return false;
  const o = r as Record<string, unknown>;
  const own = (k: string) => Object.prototype.hasOwnProperty.call(o, k);
  if (!['versionBefore', 'versionAfter', 'start', 'rawBefore', 'rawAfter', 'prefix', 'suffix'].every(own)) return false;
  return (
    typeof o.versionBefore === 'string' &&
    SHA256.test(o.versionBefore) &&
    typeof o.versionAfter === 'string' &&
    SHA256.test(o.versionAfter) &&
    typeof o.start === 'number' &&
    Number.isSafeInteger(o.start) &&
    o.start >= 0 &&
    typeof o.rawBefore === 'string' &&
    typeof o.rawAfter === 'string' &&
    typeof o.prefix === 'string' &&
    typeof o.suffix === 'string' &&
    o.prefix.length <= CONTEXT_MAX &&
    o.suffix.length <= CONTEXT_MAX
  );
}

/** A copy of the record, rebuilt field by field (the stack never shares a record object with its caller). */
function copyRecord(r: WriteRecord): WriteRecord {
  return { versionBefore: r.versionBefore, versionAfter: r.versionAfter, start: r.start, rawBefore: r.rawBefore, rawAfter: r.rawAfter, prefix: r.prefix, suffix: r.suffix };
}

function checkEntry(e: NewUndoEntry): void {
  if (!isUndoRecord(e.record)) throw new Error('UndoStack: not a write record');
  if (typeof e.runId !== 'string' || !RUN_ID.test(e.runId)) throw new Error('UndoStack: bad run id');
  if (!(STRATEGIES as readonly string[]).includes(e.strategy)) throw new Error('UndoStack: bad strategy');
  if (typeof e.beforeText !== 'string' || typeof e.afterText !== 'string') throw new Error('UndoStack: bad texts');
  if (typeof e.noteId !== 'string' || !NOTE_ID.test(e.noteId)) throw new Error('UndoStack: bad note id');
  if (typeof e.line !== 'number' || !Number.isSafeInteger(e.line) || e.line < 0) throw new Error('UndoStack: bad line');
  if (e.token !== undefined && (typeof e.token !== 'string' || !UNDO_TOKEN.test(e.token))) throw new Error('UndoStack: bad token');
}

function copyEntry(e: UndoEntry): UndoEntry {
  return { token: e.token, record: copyRecord(e.record), runId: e.runId, strategy: e.strategy, beforeText: e.beforeText, afterText: e.afterText, noteId: e.noteId, line: e.line };
}

/** How an undo or redo that undo()/redo() started ended (settle). */
export type UndoSettle =
  /** The queue wrote it. For a redo, `noteId` is the new edit note (6.6: undo deleted the old one). */
  | { ok: true; noteId?: string }
  /** Nothing was written (case 3, a refusal, a failed write): the entry goes back where it was. */
  | { ok: false };

/** A place on the undo stack: an accepted write, its entry once the write landed (null while it is pending). */
interface Slot {
  token: string;
  /** Order of acceptance (reserve) or of the write (redo): the stack is kept in this order. */
  seq: number;
  entry: UndoEntry | null;
}

/**
 * One document's undo and redo stacks. `undo()` and `redo()` start an operation and return the entry to pass to
 * the queue; `settle()` ends it. Only one operation runs at a time (both return null while one is in flight),
 * so a second Cmd+Z never sends the same record twice or skips past a write still being undone.
 */
export class UndoStack {
  /** Oldest first; the newest accepted write is last (pending ones too, E-3). */
  private readonly undos: Slot[] = [];
  /** Oldest first; the most recently undone write is last. */
  private readonly redos: UndoEntry[] = [];
  private inFlight: { entry: UndoEntry; seq: number; kind: 'undo' | 'redo'; pushedSince: boolean } | null = null;
  private seq = 0;

  constructor(private readonly max: number = MAX_UNDO_ENTRIES) {}

  /**
   * E-3: main accepted a commit; its write is in flight. Returns the token its entry will have (fill() when it
   * lands, cancel() when it does not). The slot keeps its place in the order commits were accepted.
   */
  reserve(token?: string): string {
    if (token !== undefined && (typeof token !== 'string' || !UNDO_TOKEN.test(token))) throw new Error('UndoStack: bad token');
    let t = token ?? newUndoToken();
    while (token === undefined && this.has(t)) t = newUndoToken();
    if (this.has(t)) throw new Error('UndoStack: token already used');
    this.undos.push({ token: t, seq: ++this.seq, entry: null });
    while (this.undos.length > this.max) this.undos.shift();
    return t;
  }

  /**
   * The reserved write landed: its entry, in its slot. A new write forks the history: the redo stack is cleared, as
   * in every editor. Null when the slot is gone (the stack was cleared meanwhile). Throws on a malformed entry (a bug
   * in main: the queue's own outcome is pushed here, never a deck's data).
   */
  fill(token: string, e: NewUndoEntry): UndoEntry | null {
    checkEntry(e);
    const slot = this.undos.find((x) => x.token === token);
    if (!slot || slot.entry) return null;
    slot.entry = { token, record: copyRecord(e.record), runId: e.runId, strategy: e.strategy as UndoEntry['strategy'], beforeText: e.beforeText, afterText: e.afterText, noteId: e.noteId, line: e.line };
    this.redos.length = 0;
    if (this.inFlight) this.inFlight.pushedSince = true;
    return copyEntry(slot.entry);
  }

  /** The reserved write did not land (a note, a refusal): its slot goes. False when no such pending slot. */
  cancel(token: string): boolean {
    const i = this.undos.findIndex((x) => x.token === token && x.entry === null);
    if (i === -1) return false;
    this.undos.splice(i, 1);
    return true;
  }

  /**
   * Records a new own write (an edit, an applied suggestion) that already landed, on top of the undo stack, and
   * returns it with its token (reserve and fill at once).
   */
  push(e: NewUndoEntry): UndoEntry {
    checkEntry(e);
    const token = this.reserve(e.token);
    return this.fill(token, e)!;
  }

  /**
   * Starts undoing the newest write that has landed (E-3: one still pending is newer, and its undo comes after it):
   * returns its entry (pass entry.record to WriteQueue.undo), or null.
   */
  undo(): UndoEntry | null {
    if (this.inFlight) return null;
    for (let i = this.undos.length - 1; i >= 0; i--) {
      const slot = this.undos[i];
      if (!slot.entry) continue;
      this.undos.splice(i, 1);
      this.inFlight = { entry: slot.entry, seq: slot.seq, kind: 'undo', pushedSince: false };
      return copyEntry(slot.entry);
    }
    return null;
  }

  /**
   * The token of the newest slot when its write is still pending (its commit in flight), else null. Cmd+Z pressed
   * then is for that write (the hardening round, E-3 as amended): undoSlot() takes it once it has landed.
   */
  pendingTop(): string | null {
    const top = this.undos[this.undos.length - 1];
    return top && top.entry === null ? top.token : null;
  }

  /**
   * Starts undoing the write of slot `token`, which has landed: its entry, or null when the slot is gone (its commit
   * became a note or a refusal), still pending, or another operation is in flight. Never an older write.
   */
  undoSlot(token: string): UndoEntry | null {
    if (this.inFlight) return null;
    const i = this.undos.findIndex((x) => x.token === token);
    if (i === -1 || !this.undos[i].entry) return null;
    const slot = this.undos.splice(i, 1)[0];
    this.inFlight = { entry: slot.entry!, seq: slot.seq, kind: 'undo', pushedSince: false };
    return copyEntry(slot.entry!);
  }

  /** Starts redoing the most recently undone write: pass entry.record (the ORIGINAL record) to WriteQueue.redo. */
  redo(): UndoEntry | null {
    if (this.inFlight || this.redos.length === 0) return null;
    const entry = this.redos.pop()!;
    // A redo is a write made now: commits accepted after it are newer.
    this.inFlight = { entry, seq: ++this.seq, kind: 'redo', pushedSince: false };
    return copyEntry(entry);
  }

  /**
   * Ends the operation undo() or redo() started for `token`. Written: an undone write moves to the redo stack
   * (unless a new write was pushed meanwhile, which cleared redo), a redone one back on the undo stack with its
   * new note id, below the commits accepted after it. Not written: the entry goes back where it was, below every
   * write accepted since (E-3), so Cmd+Z tries it again (and case 3 offers Make a note again) rather than skipping
   * to an older write, and never hides a newer one. Returns false for a token not in flight.
   */
  settle(token: string, how: UndoSettle): boolean {
    const f = this.inFlight;
    if (!f || f.entry.token !== token) return false;
    this.inFlight = null;
    const e = f.entry;
    if (how.ok && how.noteId !== undefined) {
      if (typeof how.noteId !== 'string' || !NOTE_ID.test(how.noteId)) throw new Error('UndoStack: bad note id');
      e.noteId = how.noteId;
    }
    if (f.kind === 'undo') {
      if (!how.ok) this.putBack({ token: e.token, seq: f.seq, entry: e });
      else if (!f.pushedSince) this.restoreTop(this.redos, e);
    } else {
      if (how.ok) this.putBack({ token: e.token, seq: f.seq, entry: e });
      else if (!f.pushedSince) this.restoreTop(this.redos, e);
    }
    return true;
  }

  /** A slot back in acceptance order. */
  private putBack(slot: Slot): void {
    const at = this.undos.findIndex((x) => x.seq > slot.seq);
    if (at === -1) this.undos.push(slot);
    else this.undos.splice(at, 0, slot);
    while (this.undos.length > this.max) this.undos.shift();
  }

  private restoreTop(stack: UndoEntry[], e: UndoEntry): void {
    stack.push(e);
    while (stack.length > this.max) stack.shift();
  }

  /**
   * The entry for `token` when it is the document's newest undoable write and nothing is in flight (P2-14: a
   * toast's Undo acts only on the write it announced, never on a later one), else null.
   */
  latest(token: string): UndoEntry | null {
    if (this.inFlight || typeof token !== 'string' || !UNDO_TOKEN.test(token)) return null;
    // A commit accepted after it (still pending) is newer: then it is not the latest.
    const top = this.undos[this.undos.length - 1];
    return top && top.entry && top.token === token ? copyEntry(top.entry) : null;
  }

  /** The entry for `token` on either stack (not in flight, not pending), or null: case 3's Make a note names it. */
  get(token: string): UndoEntry | null {
    if (typeof token !== 'string' || !UNDO_TOKEN.test(token)) return null;
    const e = this.undos.find((x) => x.token === token)?.entry ?? this.redos.find((x) => x.token === token);
    return e ? copyEntry(e) : null;
  }

  /** Removes the entry for `token` (after Make a note kept it as a verbatim note). Returns it, or null. */
  drop(token: string): UndoEntry | null {
    const i = this.undos.findIndex((x) => x.token === token && x.entry !== null);
    if (i !== -1) return copyEntry(this.undos.splice(i, 1)[0].entry!);
    const j = this.redos.findIndex((x) => x.token === token);
    if (j !== -1) return copyEntry(this.redos.splice(j, 1)[0]);
    return null;
  }

  /** Forgets everything (the document's window closed or reopened, D-1). An operation in flight settles to nothing. */
  clear(): void {
    this.undos.length = 0;
    this.redos.length = 0;
    this.inFlight = null;
  }

  get canUndo(): boolean {
    return !this.inFlight && this.undos.some((x) => x.entry !== null);
  }

  get canRedo(): boolean {
    return !this.inFlight && this.redos.length > 0;
  }

  /** An undo or redo is being written. */
  get busy(): boolean {
    return this.inFlight !== null;
  }

  /** Entries whose write has landed (undo), undone writes (redo). */
  get size(): { undo: number; redo: number } {
    return { undo: this.undos.filter((x) => x.entry !== null).length, redo: this.redos.length };
  }

  /** Accepted writes still in flight (E-3). */
  get pending(): number {
    return this.undos.filter((x) => x.entry === null).length;
  }

  private has(token: string): boolean {
    return this.undos.some((x) => x.token === token) || this.redos.some((x) => x.token === token) || this.inFlight?.entry.token === token;
  }
}
