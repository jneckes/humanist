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

/**
 * One document's undo and redo stacks. `undo()` and `redo()` start an operation and return the entry to pass to
 * the queue; `settle()` ends it. Only one operation runs at a time (both return null while one is in flight),
 * so a second Cmd+Z never sends the same record twice or skips past a write still being undone.
 */
export class UndoStack {
  /** Oldest first; the newest undoable write is last. */
  private readonly undos: UndoEntry[] = [];
  /** Oldest first; the most recently undone write is last. */
  private readonly redos: UndoEntry[] = [];
  private inFlight: { entry: UndoEntry; kind: 'undo' | 'redo'; pushedSince: boolean } | null = null;

  constructor(private readonly max: number = MAX_UNDO_ENTRIES) {}

  /**
   * Records a new own write (an edit, an applied suggestion) on top of the undo stack and returns it with its
   * token. A new write forks the history: the redo stack is cleared, as in every editor. Throws on a malformed
   * entry (a bug in main: the queue's own outcome is pushed here, never a deck's data).
   */
  push(e: NewUndoEntry): UndoEntry {
    checkEntry(e);
    let token = e.token ?? newUndoToken();
    while (e.token === undefined && this.has(token)) token = newUndoToken();
    if (this.has(token)) throw new Error('UndoStack: token already used');
    const entry: UndoEntry = { token, record: copyRecord(e.record), runId: e.runId, strategy: e.strategy as UndoEntry['strategy'], beforeText: e.beforeText, afterText: e.afterText, noteId: e.noteId, line: e.line };
    this.undos.push(entry);
    while (this.undos.length > this.max) this.undos.shift();
    this.redos.length = 0;
    if (this.inFlight) this.inFlight.pushedSince = true;
    return copyEntry(entry);
  }

  /** Starts undoing the newest write: returns its entry (pass entry.record to WriteQueue.undo), or null. */
  undo(): UndoEntry | null {
    if (this.inFlight || this.undos.length === 0) return null;
    const entry = this.undos.pop()!;
    this.inFlight = { entry, kind: 'undo', pushedSince: false };
    return copyEntry(entry);
  }

  /** Starts redoing the most recently undone write: pass entry.record (the ORIGINAL record) to WriteQueue.redo. */
  redo(): UndoEntry | null {
    if (this.inFlight || this.redos.length === 0) return null;
    const entry = this.redos.pop()!;
    this.inFlight = { entry, kind: 'redo', pushedSince: false };
    return copyEntry(entry);
  }

  /**
   * Ends the operation undo() or redo() started for `token`. Written: an undone write moves to the redo stack
   * (unless a new write was pushed meanwhile, which cleared redo), a redone one back on top of the undo stack
   * with its new note id. Not written: the entry goes back where it was, so Cmd+Z tries it again (and case 3
   * offers Make a note again) rather than skipping to an older write. Returns false for a token not in flight.
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
      if (!how.ok) this.restoreTop(this.undos, e);
      else if (!f.pushedSince) this.restoreTop(this.redos, e);
    } else {
      if (how.ok) this.restoreTop(this.undos, e);
      else if (!f.pushedSince) this.restoreTop(this.redos, e);
    }
    return true;
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
    const top = this.undos[this.undos.length - 1];
    return top && top.token === token ? copyEntry(top) : null;
  }

  /** The entry for `token` on either stack (not in flight), or null: case 3's Make a note names it. */
  get(token: string): UndoEntry | null {
    if (typeof token !== 'string' || !UNDO_TOKEN.test(token)) return null;
    const e = this.undos.find((x) => x.token === token) ?? this.redos.find((x) => x.token === token);
    return e ? copyEntry(e) : null;
  }

  /** Removes the entry for `token` (after Make a note kept it as a verbatim note). Returns it, or null. */
  drop(token: string): UndoEntry | null {
    for (const stack of [this.undos, this.redos]) {
      const i = stack.findIndex((x) => x.token === token);
      if (i !== -1) return copyEntry(stack.splice(i, 1)[0]);
    }
    return null;
  }

  /** Forgets everything (the document's window closed or reopened, D-1). An operation in flight settles to nothing. */
  clear(): void {
    this.undos.length = 0;
    this.redos.length = 0;
    this.inFlight = null;
  }

  get canUndo(): boolean {
    return !this.inFlight && this.undos.length > 0;
  }

  get canRedo(): boolean {
    return !this.inFlight && this.redos.length > 0;
  }

  /** An undo or redo is being written. */
  get busy(): boolean {
    return this.inFlight !== null;
  }

  get size(): { undo: number; redo: number } {
    return { undo: this.undos.length, redo: this.redos.length };
  }

  private has(token: string): boolean {
    return this.undos.some((x) => x.token === token) || this.redos.some((x) => x.token === token) || this.inFlight?.entry.token === token;
  }
}
