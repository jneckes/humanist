// The capability seam (D11, 9.6). The app resolves `capabilities = {edit, agent}` at startup. In v1 both
// are true whenever the editor bundle (packages/editor → dist/editor.cjs) is present. Nothing outside
// packages/editor imports it; the app loads it at runtime and codes against these interfaces.

import type { DeckMap, EditRequest, RefusalCode, WriteOutcome, WriteRecord } from './types';

/** File access for one deck, supplied by the app (its atomic writer lives in packages/app, 9.6). */
export interface DeckIO {
  /** The deck's realpath, resolved at open (9.2 Atomic write step 1). */
  readonly realpath: string;
  /** Reads the deck's current bytes from its realpath. */
  read(): Promise<Uint8Array>;
  /**
   * Atomic write (9.2 Atomic write steps 2–4, 9.9): temp file in the same directory, copy mode bits and
   * extended attributes, fsync, re-hash the file on disk and compare with `expectHash`, then rename.
   * Rejects with a WriteConflictError (name === 'WriteConflictError') when the on-disk hash differs.
   */
  atomicWrite(bytes: Uint8Array, expectHash: string): Promise<void>;
  /** sha256 hex of bytes. */
  sha256(bytes: Uint8Array): string;
}

/**
 * The outcome of an undo or redo (9.2 Undo and redo). A refusal with `canMakeNote` offers "Make a note" (case 3:
 * CANT_UNDO, code `stale`); `code` was added in Phase 2.
 */
export type UndoOutcome =
  | { ok: true; record: WriteRecord; version: string }
  | { ok: false; why: string; canMakeNote: boolean; code: RefusalCode };

/** The outcome of "Restore deck to <time>" (9.2 Undo and redo step 4; P2-11). */
export type RestoreOutcome = { ok: true; version: string } | { ok: false; why: string; code: RefusalCode };

/** Which operation of the queue made a write. */
export type WriteKind = 'edit' | 'undo' | 'redo' | 'restore';

/** What afterWrite learns about the write that just landed (9.2 Write protocol step 6). */
export interface WrittenVersion {
  /** sha256 of `bytes`: the file's new version. */
  version: string;
  /** The decoded new file (the map's source). */
  src: string;
  /** The exact bytes renamed in. */
  bytes: Uint8Array;
  /**
   * The hash the queue read in step 2, which the write replaced (record.versionBefore). When it is not the version
   * main last took, the write absorbed an external change main has not processed yet (P2-4).
   */
  basedOn: string;
  kind: WriteKind;
  /** Edits: the run written (in the new version's map). */
  runId?: string;
  /** Edits: how it was written. Literal writes reload once the field closes (9.2 Strategy 2 step 5.5). */
  strategy?: 'html-text' | 'script-literal' | 'json-literal';
}

/** Per-deck write queue: the write protocol (9.2) for direct edits, undo, redo and restores. */
export interface WriteQueue {
  /** Runs one edit through the queue: version check, re-check, verify, atomic write (or the verbatim fallback). */
  edit(req: EditRequest): Promise<WriteOutcome>;
  /** Undo a write (9.2 Undo and redo, cases 1–3). Never restores a whole-file snapshot. Takes the ORIGINAL record. */
  undo(record: WriteRecord): Promise<UndoOutcome>;
  /** Redo: the same operation with rawBefore and rawAfter swapped. Takes the ORIGINAL record, not undo's. */
  redo(record: WriteRecord): Promise<UndoOutcome>;
  /**
   * "Restore deck to <time>" (9.2 Undo and redo step 4, P2-11): writes `bytes` (a history snapshot) as the whole
   * file, serialized with edits, only while the file still is `expectVersion` (the version the user confirmed the
   * restore against). The bytes are written as they are, never re-encoded.
   */
  restore(bytes: Uint8Array, expectVersion: string): Promise<RestoreOutcome>;
  /**
   * Tells the queue about a version a client holds (P2-3): its source and map, so a stale edit made on it can be
   * placed by position, through a diff from it to the current version (9.2 Write protocol step 2; lead decision
   * E-1). Call it at open and after every external change main takes. `pin`: the version is held (a page shows it,
   * a field is open on it, or its commit is unanswered) and is never evicted until unpin is called as many times
   * (9.2 step 1: "Main keeps the map for each version a client still holds"). Synchronous; it never reads or writes
   * the file.
   */
  know(version: string, src: string, map: DeckMap, opts?: { pin?: boolean }): void;
  /** Releases one pin of `version` (know with `pin`); unknown or unpinned versions are ignored. */
  unpin(version: string): void;
  /** The map of the file as of the last read or write through this queue, after the operations queued before it. */
  currentMap(): Promise<DeckMap>;
  /** Reads the file and rebuilds the map now (in the queue). */
  refresh(): Promise<DeckMap>;
}

export interface WriteQueueOptions {
  /**
   * Runs after every write that landed, before the outcome resolves (9.2 Write protocol step 6): adopt the new
   * version, push the map, move the locked spans. Errors go to onHookError; the write stands.
   */
  afterWrite?(map: DeckMap, record: WriteRecord, next: WrittenVersion): Promise<void> | void;
  /**
   * Runs right before each atomic write with the exact bytes it replaces (the version read in step 2): the history
   * snapshot (P2-11). A rejection refuses the write (code `internal`), so no write ever lands without its
   * snapshot. The mutation probe passes none, so `blueline map` writes no history.
   */
  beforeWrite?(prev: { version: string; bytes: Uint8Array }, next: { version: string; kind: WriteKind }): Promise<void>;
  /**
   * Checked at the moment of each write (9.1: an edit write happens only while editing is allowed for the
   * document and capabilities.edit is on). False refuses the write (code `refused`).
   */
  canWrite?(): boolean;
  /** Called when a hook throws (afterWrite, beforeWrite) or a read-back after the rename disagrees. */
  onHookError?(e: unknown): void;
  /** How many times an operation is requeued after a write conflict before it gives up. Default 5. */
  maxRetries?: number;
}

/** What dist/editor.cjs exports. */
export interface EditorModule {
  readonly editorVersion: string;
  createWriteQueue(io: DeckIO, opts?: WriteQueueOptions): WriteQueue;
}
