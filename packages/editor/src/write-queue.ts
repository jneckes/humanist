// FSL-1.1-ALv2 (packages/editor/LICENSE.md)
//
// The per-deck write queue: the write protocol of 9.2 for direct edits, undo, redo and applied suggestions.
//
//   1. Versions. Every map carries `version`, the sha256 of the file bytes it was built from. The queue keeps
//      the source and map of recent versions, because a client may still hold an old one.
//   2. Queue and version check. One operation at a time. Each re-reads the file and hashes it. If the hash is
//      not the client's version, the map is rebuilt from the current file and the edit goes to the only run
//      whose text equals beforeText, using 32 characters of the old version's source context on each side to
//      break ties; no run, or several, makes it a verbatim note. Stale offsets are never applied. A text that
//      was already in several places in the client's version counts as a tie even when one copy is left.
//   3. Re-check before writing: the run must hold beforeText exactly (planEdit), and the splice is planned on
//      the file as just read.
//   4. Atomic write through DeckIO.atomicWrite, which re-hashes the file on disk against the hash read in
//      step 2 before renaming. A conflict (someone wrote in between) aborts and requeues the operation: it
//      starts again at step 2, at most `maxRetries` more times.
//   5. Verify: the exact bytes about to be written are decoded and re-parsed, and verifyEdit checks them
//      (same run holds afterText, nothing else moved, no new parse errors, Strategy 2 checks). This runs
//      BEFORE the rename, on the very bytes that are renamed in, so a failed check never reaches the disk and
//      the previous bytes stay in place; the result is the verbatim note of 9.2 step 5.
//   6. After the write the map of the new version (built in step 5) becomes current, and opts.afterWrite runs
//      (push the map and version to the overlay, update locked spans) before the outcome resolves.
//
// A deck that failed the UTF-8 decode is never written (9.2 rule 1).

import { buildMap } from '@blueline/core/mapper';
import { decodeDeck, encodeDeck } from '@blueline/core/text';
import type { DeckIO, UndoOutcome, WriteQueue, WriteQueueOptions } from '@blueline/core/capabilities';
import type { DeckMap, EditRequest, HtmlRun, LiteralRun, WriteOutcome, WriteRecord } from '@blueline/core/types';
import { findRun, planEdit, type EditPlan } from './plan';
import { applySplice } from './splice';
import { CONTEXT, isWriteRecord, makeRecord, planUndo, swapRecord } from './undo';
import { verifyEdit, verifyUndo } from './verify';

/** Options beyond the contract's WriteQueueOptions. All optional. */
export interface EditorQueueOptions extends WriteQueueOptions {
  /** How many times an operation is requeued after a write conflict before it gives up. Default 5. */
  maxRetries?: number;
  /** How many recent versions (source and map) are kept for clients that hold an old one. Default 8. */
  keepVersions?: number;
  /**
   * Checked at the moment of each write (9.1: an edit write happens only while editing is allowed for the
   * document and capabilities.edit is on, checked at the moment of the write). False refuses the write.
   */
  canWrite?: () => boolean;
  /** Called when opts.afterWrite throws. The write itself has happened, so the outcome stays ok. */
  onHookError?: (err: unknown) => void;
}

/** One version of the file, as read or written through this queue. */
interface Version {
  version: string;
  src: string;
  utf8: boolean;
  map: DeckMap;
}

type Resolved = { ok: true; runId: string } | { ok: false; why: string };

function isConflict(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: unknown }).name === 'WriteConflictError';
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Every run of a map with its raw range, Strategy 1 and Strategy 2 alike. */
function allRuns(map: DeckMap): (HtmlRun | LiteralRun)[] {
  return [...map.runs, ...map.literals];
}

export function createWriteQueue(io: DeckIO, opts: EditorQueueOptions = {}): WriteQueue {
  const maxRetries = Math.max(0, opts.maxRetries ?? 5);
  const keep = Math.max(2, opts.keepVersions ?? 8);
  /** Recent versions by hash, least recently used first. */
  const versions = new Map<string, Version>();
  let current: Version | null = null;
  let tail: Promise<unknown> = Promise.resolve();

  /** The per-deck serial queue (9.2 Write protocol step 2): each job starts when the previous one settles. */
  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = tail.then(job, job);
    tail = run.catch(() => undefined);
    return run;
  }

  function remember(v: Version): Version {
    versions.delete(v.version);
    versions.set(v.version, v);
    while (versions.size > keep) versions.delete(versions.keys().next().value as string);
    return v;
  }

  /** Re-reads the file and hashes it (step 2); the map is rebuilt unless this version is already known. */
  async function load(): Promise<Version> {
    const bytes = await io.read();
    const version = io.sha256(bytes);
    const known = versions.get(version);
    if (known) {
      current = remember(known);
      return known;
    }
    const decoded = decodeDeck(bytes);
    const map = buildMap(decoded.src, { version, utf8: decoded.utf8 });
    current = remember({ version, src: decoded.src, utf8: decoded.utf8, map });
    return current;
  }

  /** The map of a UTF-8 source about to be written: the one already built for that hash, or a new parse. */
  function mapFor(version: string, src: string): DeckMap {
    const known = versions.get(version);
    // Same hash, same bytes, same source: the map is the same (a redo returns to a version already seen).
    if (known && known.utf8 && known.src === src) return known.map;
    return buildMap(src, { version, utf8: true });
  }

  /**
   * Step 2: which run of the current version the request means. The same version: the request's run id.
   * Another version: the only run whose text equals beforeText, ties broken by 32 characters of the old
   * version's source on each side of the old run; none or several is a verbatim note.
   */
  function resolve(cur: Version, req: EditRequest): Resolved {
    if (req.version === cur.version) return { ok: true, runId: req.runId };
    const kind = req.runId.slice(0, 2);
    if (kind !== 'h:' && kind !== 'l:') return { ok: false, why: 'unknown run id' };
    const old = versions.get(req.version);
    const oldRun = old ? findRun(old.map, req.runId) : null;
    // The client's own map must agree with its request, or the request is not what the client saw.
    if (old && (!oldRun || oldRun.value !== req.beforeText)) {
      return { ok: false, why: 'the request does not match the version it names' };
    }
    const equal = allRuns(cur.map).filter((r) => r.value === req.beforeText);
    // A text that was already in several places in the client's version is a tie even when only one copy is
    // left: the copy the client edited may be the one that changed. Then the context must decide.
    const tiedBefore = !!old && allRuns(old.map).filter((r) => r.value === req.beforeText).length > 1;
    let chosen: HtmlRun | LiteralRun | null = null;
    if (equal.length === 1 && !tiedBefore) {
      chosen = equal[0];
    } else if (equal.length >= 1 && old && oldRun) {
      const before = old.src.slice(Math.max(0, oldRun.start - CONTEXT), oldRun.start);
      const after = old.src.slice(oldRun.end, oldRun.end + CONTEXT);
      const hits = equal.filter(
        (r) => cur.src.slice(Math.max(0, r.start - CONTEXT), r.start) === before && cur.src.slice(r.end, r.end + CONTEXT) === after,
      );
      if (hits.length === 1) chosen = hits[0];
    }
    if (!chosen) {
      return {
        ok: false,
        why:
          equal.length === 0
            ? 'the deck changed and no run holds beforeText any more'
            : 'the deck changed and beforeText is in several places (9.2 Write protocol step 2)',
      };
    }
    // An edit never moves between parsed text and a script literal: that is a different place on the page.
    if (!chosen.id.startsWith(kind)) return { ok: false, why: 'the deck changed and the text now lives somewhere else' };
    return { ok: true, runId: chosen.id };
  }

  async function runHook(map: DeckMap, record: WriteRecord): Promise<void> {
    if (!opts.afterWrite) return;
    try {
      await opts.afterWrite(map, record);
    } catch (e) {
      opts.onHookError?.(e);
    }
  }

  function isRequest(req: EditRequest): boolean {
    return (
      !!req &&
      typeof req.version === 'string' &&
      typeof req.runId === 'string' &&
      typeof req.beforeText === 'string' &&
      typeof req.afterText === 'string'
    );
  }

  /** The verbatim note for an edit that is not written (9.2 Strategy 3; 6.3 "When a write fails"). */
  function verbatimOf(req: EditRequest, why: string): WriteOutcome {
    const valid = isRequest(req);
    return { ok: false, verbatim: { before: valid ? req.beforeText : '', after: valid ? req.afterText : '' }, why };
  }

  async function doEdit(req: EditRequest): Promise<WriteOutcome> {
    const verbatim = (why: string): WriteOutcome => verbatimOf(req, why);
    if (!isRequest(req)) return verbatim('invalid request');
    if (req.afterText === req.beforeText) return verbatim('unchanged: afterText equals beforeText');
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let cur: Version;
      try {
        cur = await load();
      } catch (e) {
        return verbatim(`read failed: ${message(e)}`);
      }
      if (!cur.utf8) return verbatim('not-utf8: the deck is not UTF-8, so direct edits are off (9.2 rule 1)');
      const r = resolve(cur, req);
      if (!r.ok) return verbatim(r.why);
      // Step 3: planEdit re-checks that the run holds beforeText in the file as just read.
      const plan = planEdit(cur.src, cur.map, { ...req, version: cur.version, runId: r.runId });
      if (!plan.ok) return verbatim(plan.why);
      const bytes = encodeDeck(plan.newSrc);
      const checked = check(cur, plan, bytes, req);
      if (!checked.ok) return verbatim(`verify: ${checked.why}`);
      if (opts.canWrite && !opts.canWrite()) return verbatim('editing is not allowed for this document');
      // Everything the outcome needs is computed before the write, so nothing after it can fail.
      const next = checked.next;
      const record = makeRecord(cur.src, plan, cur.version, next.version);
      const run = findRun(next.map, plan.runId);
      const outcome: WriteOutcome = { ok: true, record, version: next.version, runId: plan.runId, line: run ? run.line : 0 };
      try {
        await io.atomicWrite(bytes, cur.version);
      } catch (e) {
        if (isConflict(e)) continue; // step 4.3: abort and requeue
        return verbatim(`write failed: ${message(e)}`);
      }
      current = remember(next);
      await runHook(next.map, record);
      return outcome;
    }
    return verbatim('conflict: the deck kept changing during the write');
  }

  /** Step 5 on the exact bytes to be written: decode, re-parse, verify. */
  function check(
    cur: Version,
    plan: EditPlan,
    bytes: Uint8Array,
    req: EditRequest,
  ): { ok: true; next: Version } | { ok: false; why: string } {
    const decoded = decodeDeck(bytes);
    if (!decoded.utf8 || decoded.src !== plan.newSrc) return { ok: false, why: 'the new bytes do not decode to the new source' };
    const version = io.sha256(bytes);
    const map = mapFor(version, decoded.src);
    const v = verifyEdit(cur.src, decoded.src, cur.map, map, plan, req);
    if (!v.ok) return v;
    return { ok: true, next: { version, src: decoded.src, utf8: true, map } };
  }

  async function doUndo(record: WriteRecord, label: 'undo' | 'redo'): Promise<UndoOutcome> {
    if (!isWriteRecord(record)) return { ok: false, why: 'not a write record', canMakeNote: false };
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let cur: Version;
      try {
        cur = await load();
      } catch (e) {
        return { ok: false, why: `read failed: ${message(e)}`, canMakeNote: true };
      }
      if (!cur.utf8) return { ok: false, why: 'not-utf8: the deck is not UTF-8 and is never written', canMakeNote: true };
      const p = planUndo(cur.src, record, cur.version);
      if (!p.ok) return { ok: false, why: p.why, canMakeNote: p.canMakeNote };
      const newSrc = applySplice(cur.src, p.start, p.start + p.rawBefore.length, p.rawAfter);
      const bytes = encodeDeck(newSrc);
      const decoded = decodeDeck(bytes);
      if (!decoded.utf8 || decoded.src !== newSrc) return { ok: false, why: `${label}: the bytes do not decode back`, canMakeNote: true };
      const version = io.sha256(bytes);
      // Case 1 restores the exact bytes of the version before the write: the hash must say so.
      if (p.case === 1 && version !== record.versionBefore) {
        return { ok: false, why: `${label}: the result is not the version before the write`, canMakeNote: true };
      }
      const map = mapFor(version, newSrc);
      const v = verifyUndo(cur.src, newSrc, cur.map, map, p);
      if (!v.ok) return { ok: false, why: `${label}: ${v.why}`, canMakeNote: true };
      if (opts.canWrite && !opts.canWrite()) return { ok: false, why: 'editing is not allowed for this document', canMakeNote: true };
      const done = makeRecord(cur.src, p, cur.version, version);
      try {
        await io.atomicWrite(bytes, cur.version);
      } catch (e) {
        if (isConflict(e)) continue;
        return { ok: false, why: `write failed: ${message(e)}`, canMakeNote: true };
      }
      current = remember({ version, src: newSrc, utf8: true, map });
      await runHook(map, done);
      return { ok: true, record: done, version };
    }
    return { ok: false, why: 'conflict: the deck kept changing during the write', canMakeNote: true };
  }

  // An unexpected exception never escapes as a rejection: nothing was written before the atomic write
  // resolved, so the edit is kept as a verbatim note (or the undo refused) and the file is as it was.
  const guardEdit = async (req: EditRequest): Promise<WriteOutcome> => {
    try {
      return await doEdit(req);
    } catch (e) {
      return verbatimOf(req, `internal error: ${message(e)}`);
    }
  };
  const guardUndo = async (record: WriteRecord, label: 'undo' | 'redo'): Promise<UndoOutcome> => {
    try {
      return await doUndo(label === 'redo' && isWriteRecord(record) ? swapRecord(record) : record, label);
    } catch (e) {
      return { ok: false, why: `internal error: ${message(e)}`, canMakeNote: true };
    }
  };

  return {
    edit: (req) => enqueue(() => guardEdit(req)),
    // undo(W) and redo(W) both take the record of the original write W; redo is undo with rawBefore and
    // rawAfter swapped (9.2). The record each returns describes the write it just made.
    undo: (record) => enqueue(() => guardUndo(record, 'undo')),
    redo: (record) => enqueue(() => guardUndo(record, 'redo')),
    currentMap: () => current?.map ?? null,
    refresh: () => enqueue(async () => (await load()).map),
  };
}
