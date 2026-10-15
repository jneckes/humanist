// The capability seam (D11, 9.6). The app resolves `capabilities = {edit, agent}` at startup. In v1 both
// are true whenever the editor bundle (packages/editor → dist/editor.cjs) is present. Nothing outside
// packages/editor imports it; the app loads it at runtime and codes against these interfaces.

import type { DeckMap, EditRequest, WriteOutcome, WriteRecord } from './types';

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

export type UndoOutcome =
  | { ok: true; record: WriteRecord; version: string }
  | { ok: false; why: string; canMakeNote: boolean };

/** Per-deck write queue: the write protocol (9.2) for direct edits, undo, redo and applied suggestions. */
export interface WriteQueue {
  /** Runs one edit through the queue: version check, re-check, atomic write, verify (or verbatim fallback). */
  edit(req: EditRequest): Promise<WriteOutcome>;
  /** Undo a write (9.2 Undo and redo, cases 1–3). Never restores a whole-file snapshot. */
  undo(record: WriteRecord): Promise<UndoOutcome>;
  /** Redo: the same operation with rawBefore and rawAfter swapped. */
  redo(record: WriteRecord): Promise<UndoOutcome>;
  /** The map of the file as of the last read or write through this queue, or null before the first. */
  currentMap(): DeckMap | null;
  /** Reads the file and rebuilds the map (used after external changes). */
  refresh(): Promise<DeckMap>;
}

export interface WriteQueueOptions {
  /** Hook run after every successful write, before the outcome resolves (9.2 Write protocol step 6). */
  afterWrite?: (map: DeckMap, record: WriteRecord) => void | Promise<void>;
}

/** What dist/editor.cjs exports. */
export interface EditorModule {
  readonly editorVersion: string;
  createWriteQueue(io: DeckIO, opts?: WriteQueueOptions): WriteQueue;
}
