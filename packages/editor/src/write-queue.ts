// FSL-1.1-ALv2 (packages/editor/LICENSE.md)
//
// The per-deck write queue: the write protocol of 9.2 for direct edits, undo, redo and whole-file restores.
//
//   1. Versions. Every map carries `version`, the sha256 of the file bytes it was built from. The queue keeps
//      the source and map of recent versions, because a client may still hold an old one; main tells it the
//      versions its pages hold (know, P2-3), so their context is there when a stale edit needs it.
//   2. Queue and version check. One operation at a time. Each re-reads the file and hashes it. If the hash is
//      not the client's version, the map is rebuilt from the current file and the edit goes to the only run
//      whose text equals beforeText, using 32 characters of the old version's source context on each side to
//      break ties; no run, or several, makes it a verbatim note. Stale offsets are never applied. A text that
//      was already in several places in the client's version counts as a tie even when one copy is left, and
//      so does a text that is also a shadow value (text the page may show from a source Blueline never
//      writes, DeckMap.shadows; decision D-a): it is not unique, so the context must single the run out.
//   3. Re-check before writing: the run must hold beforeText exactly (planEdit), and the splice is planned on
//      the file as just read. A picked candidate (EditRequest.pick) must lift to the run exactly (P2-8).
//   4. Atomic write through DeckIO.atomicWrite, which re-hashes the file on disk against the hash read in
//      step 2 before renaming. A conflict (someone wrote in between) aborts and requeues the operation: it
//      starts again at step 2, at most `maxRetries` more times. Right before it, canWrite is checked (9.1) and
//      beforeWrite gets the exact bytes the write replaces (the history snapshot, P2-11).
//   5. Verify: the exact bytes about to be written are decoded and re-parsed, and verifyEdit checks them
//      (same run holds afterText, nothing else moved, no new parse errors, Strategy 2 checks). This runs
//      BEFORE the rename, on the very bytes that are renamed in, so a failed check never reaches the disk and
//      the previous bytes stay in place; the result is the verbatim note of 9.2 step 5 (P2-1). After the
//      rename the file is read back and its hash compared.
//   6. After the write the map of the new version (built in step 5) becomes current, and opts.afterWrite runs
//      (adopt the version, push the map, move the locked spans) before the outcome resolves.
//
// Nothing after the rename can turn a written edit into a note: the outcome and the record are computed before
// the write, hooks are caught, and an atomic write that rejects after the file landed (a step after its rename
// threw) is recognised by reading the file back. A deck that failed the UTF-8 decode is never written (9.2 rule 1).

import { changedSpan } from '@blueline/core/edit-cleanup';
import { liftPick } from '@blueline/core/edit-commit';
import { buildMap } from '@blueline/core/mapper';
import { decodeDeck, encodeDeck } from '@blueline/core/text';
import type { DeckIO, RestoreOutcome, UndoOutcome, WriteKind, WriteQueue, WriteQueueOptions } from '@blueline/core/capabilities';
import type { DeckMap, EditRequest, HtmlRun, LiteralRun, RefusalCode, WriteOutcome, WriteRecord } from '@blueline/core/types';
import { findRun, planEdit, type EditPlan } from './plan';
import { applySplice } from './splice';
import { CONTEXT, isWriteRecord, makeRecord, planUndo, swapRecord } from './undo';
import { verifyEdit, verifyUndo } from './verify';

/** Options beyond the contract's WriteQueueOptions. */
export interface EditorQueueOptions extends WriteQueueOptions {
  /** How many recent versions (source and map) are kept for clients that hold an old one. Default 8. */
  keepVersions?: number;
}

/** One version of the file, as read, written or told (know) through this queue. */
interface Version {
  version: string;
  src: string;
  utf8: boolean;
  map: DeckMap;
}

/** A version just read from disk, with the bytes read (what beforeWrite snapshots). */
interface Loaded {
  v: Version;
  bytes: Uint8Array;
}

type Resolved = { ok: true; runId: string } | { ok: false; why: string; code: RefusalCode };

/** How a write attempt ended: written (possibly after a rejection, when the file landed), requeue, or refused. */
type WriteResult = { kind: 'written' } | { kind: 'conflict' } | { kind: 'refused'; why: string; code: RefusalCode };

const SHA256 = /^[0-9a-f]{64}$/;

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

const PICK_KINDS = new Set(['equal', 'substring', 'normalized']);

function isRequest(req: EditRequest): boolean {
  if (
    !req ||
    typeof req !== 'object' ||
    typeof req.version !== 'string' ||
    typeof req.runId !== 'string' ||
    typeof req.beforeText !== 'string' ||
    typeof req.afterText !== 'string'
  ) {
    return false;
  }
  const p = req.pick;
  if (p === undefined) return true;
  return !!p && typeof p === 'object' && PICK_KINDS.has(p.kind) && typeof p.nodeBefore === 'string' && typeof p.nodeAfter === 'string';
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

  /** Reports a hook's error; a failing reporter is ignored (nothing may throw once a write has landed). */
  function hookError(e: unknown): void {
    try {
      opts.onHookError?.(e);
    } catch {
      // ignored
    }
  }

  /**
   * Re-reads the file and hashes it (step 2). A known version's map is reused only when its source is the one
   * these bytes decode to: a version main told the queue about (know) is never trusted beyond what it can check.
   */
  async function load(): Promise<Loaded> {
    const bytes = await io.read();
    const version = io.sha256(bytes);
    const decoded = decodeDeck(bytes);
    const known = versions.get(version);
    if (known && known.utf8 === decoded.utf8 && known.src === decoded.src) {
      current = remember(known);
      return { v: known, bytes };
    }
    const map = buildMap(decoded.src, { version, utf8: decoded.utf8 });
    current = remember({ version, src: decoded.src, utf8: decoded.utf8, map });
    return { v: current, bytes };
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
    if (kind !== 'h:' && kind !== 'l:') return { ok: false, why: 'unknown run id', code: 'refused' };
    const old = versions.get(req.version);
    const oldRun = old ? findRun(old.map, req.runId) : null;
    // The client's own map must agree with its request, or the request is not what the client saw.
    if (old && (!oldRun || oldRun.value !== req.beforeText)) {
      return { ok: false, why: 'the request does not match the version it names', code: 'refused' };
    }
    const equal = allRuns(cur.map).filter((r) => r.value === req.beforeText);
    // A text that was already in several places in the client's version is a tie even when only one copy is
    // left: the copy the client edited may be the one that changed. Then the context must decide.
    const tiedBefore = !!old && allRuns(old.map).filter((r) => r.value === req.beforeText).length > 1;
    // A text that is also a shadow value (now or in the client's version) is not unique either (D-a).
    const isShadow = (m: DeckMap | undefined): boolean => !!m && (m.shadows ?? []).some((x) => x.value === req.beforeText);
    const shadowed = isShadow(cur.map) || isShadow(old?.map);
    let chosen: HtmlRun | LiteralRun | null = null;
    if (equal.length === 1 && !tiedBefore && !shadowed) {
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
      if (equal.length === 0) return { ok: false, why: 'the deck changed and no run holds beforeText any more', code: 'stale' };
      return {
        ok: false,
        code: 'ambiguous',
        why:
          equal.length === 1 && !tiedBefore
            ? 'the deck changed and beforeText is also text Blueline never writes, so it is not unique (9.2 Write protocol step 2)'
            : 'the deck changed and beforeText is in several places (9.2 Write protocol step 2)',
      };
    }
    // An edit never moves between parsed text and a script literal: that is a different place on the page.
    if (!chosen.id.startsWith(kind)) return { ok: false, why: 'the deck changed and the text now lives somewhere else', code: 'stale' };
    return { ok: true, runId: chosen.id };
  }

  /**
   * Step 3 for a picked candidate (P2-8, Strategy 2 step 4): the request's run texts must be exactly what lifting
   * the node's edit to the run gives. Main lifts before it sends; this keeps a node's text from ever being written
   * into a run it does not fit.
   */
  function checkPick(req: EditRequest): { ok: true } | { ok: false; why: string; code: RefusalCode } {
    if (req.pick === undefined) return { ok: true };
    const lifted = liftPick(req.beforeText, req.pick);
    if (!lifted) return { ok: false, why: 'the picked candidate cannot be mapped to its run exactly (9.2 Strategy 2 step 4)', code: 'ambiguous' };
    if (lifted.beforeText !== req.beforeText || lifted.afterText !== req.afterText) {
      return { ok: false, why: 'the request is not the picked node\'s edit lifted to its run', code: 'refused' };
    }
    return { ok: true };
  }

  /** The verbatim note for an edit that is not written (9.2 Strategy 3; 6.3 "When a write fails"). */
  function verbatimOf(req: EditRequest, why: string, code: RefusalCode): WriteOutcome {
    const valid = isRequest(req);
    return { ok: false, verbatim: { before: valid ? req.beforeText : '', after: valid ? req.afterText : '' }, why, code };
  }

  /** True when the file now holds `version` (a write that rejected after its rename, or the read-back). */
  async function fileIs(version: string): Promise<boolean | null> {
    try {
      return io.sha256(await io.read()) === version;
    } catch {
      return null;
    }
  }

  /**
   * Steps 4–5 of one attempt: canWrite, the snapshot, canWrite again at the moment of the write, the atomic write
   * against the hash read in step 2, and the read-back. `next` becomes current once the bytes landed.
   */
  async function writeBytes(loaded: Loaded, bytes: Uint8Array, next: Version, kind: WriteKind): Promise<WriteResult> {
    const cur = loaded.v;
    const notAllowed: WriteResult = { kind: 'refused', why: 'editing is not allowed for this document', code: 'refused' };
    if (opts.canWrite && !opts.canWrite()) return notAllowed;
    if (opts.beforeWrite) {
      try {
        await opts.beforeWrite({ version: cur.version, bytes: loaded.bytes }, { version: next.version, kind });
      } catch (e) {
        hookError(e);
        // No write lands without its snapshot (P2-11): the file stays as it is.
        return { kind: 'refused', why: `snapshot failed: ${message(e)}`, code: 'internal' };
      }
    }
    // 9.1: checked at the moment of the write.
    if (opts.canWrite && !opts.canWrite()) return notAllowed;
    try {
      await io.atomicWrite(bytes, cur.version);
    } catch (e) {
      if (isConflict(e)) return { kind: 'conflict' }; // step 4.3: abort and requeue
      // A step after the rename may have thrown: then the file holds the new bytes, and the write stands.
      if ((await fileIs(next.version)) !== true) return { kind: 'refused', why: `write failed: ${message(e)}`, code: 'internal' };
      hookError(e);
      current = remember(next);
      return { kind: 'written' };
    }
    current = remember(next);
    // P2-1: read the file back. A different hash means another writer landed right after the rename; restoring
    // the previous bytes would destroy that change, so the queue leaves it to the watcher, which sees a hash that
    // is not knownHash and takes it as an external change. It is reported, never thrown.
    if ((await fileIs(next.version)) === false) {
      const err = new Error('read-back: the deck changed right after the write; the watcher takes it as an external change');
      err.name = 'ReadBackMismatch';
      hookError(err);
    }
    return { kind: 'written' };
  }

  /** Step 6: the hook, after the write landed. Its errors never undo the write. */
  async function afterWrite(next: Version, record: WriteRecord, bytes: Uint8Array, basedOn: string, kind: WriteKind, plan?: EditPlan): Promise<void> {
    if (!opts.afterWrite) return;
    try {
      await opts.afterWrite(next.map, record, {
        version: next.version,
        src: next.src,
        bytes,
        basedOn,
        kind,
        ...(plan ? { runId: plan.runId, strategy: plan.strategy } : {}),
      });
    } catch (e) {
      hookError(e);
    }
  }

  async function doEdit(req: EditRequest): Promise<WriteOutcome> {
    const verbatim = (why: string, code: RefusalCode): WriteOutcome => verbatimOf(req, why, code);
    if (!isRequest(req)) return verbatim('invalid request', 'refused');
    if (req.afterText === req.beforeText) return verbatim('unchanged: afterText equals beforeText', 'noop');
    const picked = checkPick(req);
    if (!picked.ok) return verbatim(picked.why, picked.code);
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let loaded: Loaded;
      try {
        loaded = await load();
      } catch (e) {
        return verbatim(`read failed: ${message(e)}`, 'internal');
      }
      const cur = loaded.v;
      if (!cur.utf8) return verbatim('not-utf8: the deck is not UTF-8, so direct edits are off (9.2 rule 1)', 'not-utf8');
      const r = resolve(cur, req);
      if (!r.ok) return verbatim(r.why, r.code);
      // Step 3: planEdit re-checks that the run holds beforeText in the file as just read.
      const plan = planEdit(cur.src, cur.map, { version: cur.version, runId: r.runId, beforeText: req.beforeText, afterText: req.afterText });
      if (!plan.ok) return verbatim(plan.why, plan.code);
      const bytes = encodeDeck(plan.newSrc);
      const checked = check(cur, plan, bytes, req);
      if (!checked.ok) return verbatim(`verify: ${checked.why}`, 'verify');
      // Everything the outcome needs is computed before the write, so nothing after it can fail.
      const next = checked.next;
      const record = makeRecord(cur.src, plan, cur.version, next.version);
      const run = findRun(next.map, plan.runId);
      const outcome: WriteOutcome = {
        ok: true,
        record,
        version: next.version,
        runId: plan.runId,
        line: run ? run.line : 0,
        merged: cur.version !== req.version,
      };
      const w = await writeBytes(loaded, bytes, next, 'edit');
      if (w.kind === 'conflict') continue;
      if (w.kind === 'refused') return verbatim(w.why, w.code);
      await afterWrite(next, record, bytes, cur.version, 'edit', plan);
      return outcome;
    }
    return verbatim('conflict: the deck kept changing during the write', 'conflict');
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
    if (!isWriteRecord(record)) return { ok: false, why: 'not a write record', canMakeNote: false, code: 'refused' };
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let loaded: Loaded;
      try {
        loaded = await load();
      } catch (e) {
        return { ok: false, why: `read failed: ${message(e)}`, canMakeNote: true, code: 'internal' };
      }
      const cur = loaded.v;
      if (!cur.utf8) return { ok: false, why: 'not-utf8: the deck is not UTF-8 and is never written', canMakeNote: true, code: 'not-utf8' };
      const p = planUndo(cur.src, record, cur.version);
      if (!p.ok) return { ok: false, why: p.why, canMakeNote: p.canMakeNote, code: p.code };
      const newSrc = applySplice(cur.src, p.start, p.start + p.rawBefore.length, p.rawAfter);
      const bytes = encodeDeck(newSrc);
      const decoded = decodeDeck(bytes);
      if (!decoded.utf8 || decoded.src !== newSrc) return { ok: false, why: `${label}: the bytes do not decode back`, canMakeNote: true, code: 'verify' };
      const version = io.sha256(bytes);
      // Case 1 restores the exact bytes of the version before the write: the hash must say so.
      if (p.case === 1 && version !== record.versionBefore) {
        return { ok: false, why: `${label}: the result is not the version before the write`, canMakeNote: true, code: 'verify' };
      }
      const map = mapFor(version, newSrc);
      const v = verifyUndo(cur.src, newSrc, cur.map, map, p);
      if (!v.ok) return { ok: false, why: `${label}: ${v.why}`, canMakeNote: true, code: 'verify' };
      const done = makeRecord(cur.src, p, cur.version, version);
      const next: Version = { version, src: newSrc, utf8: true, map };
      const w = await writeBytes(loaded, bytes, next, label);
      if (w.kind === 'conflict') continue;
      if (w.kind === 'refused') return { ok: false, why: w.why, canMakeNote: true, code: w.code };
      await afterWrite(next, done, bytes, cur.version, label);
      return { ok: true, record: done, version };
    }
    return { ok: false, why: 'conflict: the deck kept changing during the write', canMakeNote: true, code: 'conflict' };
  }

  /**
   * "Restore deck to <time>" (9.2 Undo and redo step 4, P2-11): the snapshot's bytes, as they are, in place of the
   * file, only while the file is still the version the user confirmed against. Verified raw, as an undo is: the
   * bytes decode as UTF-8 to a source that is the current one with one splice (the minimal changed span), they are
   * exactly the snapshot's, and the read-back after the rename finds their hash. A restore goes back to whatever the
   * snapshot held, so its parse is not compared with the current one. The record afterWrite gets is that splice.
   */
  async function doRestore(bytes: Uint8Array, expectVersion: string): Promise<RestoreOutcome> {
    if (!(bytes instanceof Uint8Array) || typeof expectVersion !== 'string' || !SHA256.test(expectVersion)) {
      return { ok: false, why: 'invalid restore request', code: 'refused' };
    }
    const snapshot = bytes.slice(); // the caller's buffer may change while the restore waits in the queue
    const decoded = decodeDeck(snapshot);
    if (!decoded.utf8) return { ok: false, why: 'not-utf8: the snapshot is not UTF-8 (9.2 rule 1)', code: 'not-utf8' };
    const version = io.sha256(snapshot);
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let loaded: Loaded;
      try {
        loaded = await load();
      } catch (e) {
        return { ok: false, why: `read failed: ${message(e)}`, code: 'internal' };
      }
      const cur = loaded.v;
      if (!cur.utf8) return { ok: false, why: 'not-utf8: the deck is not UTF-8 and is never written (9.2 rule 1)', code: 'not-utf8' };
      if (cur.version !== expectVersion) {
        return { ok: false, why: 'conflict: the deck changed since the restore was confirmed', code: 'conflict' };
      }
      if (version === cur.version) return { ok: false, why: 'unchanged: the deck already holds this version', code: 'noop' };
      const span = changedSpan(cur.src, decoded.src);
      const splice = { start: span.start, rawBefore: cur.src.slice(span.start, span.endBefore), rawAfter: decoded.src.slice(span.start, span.endAfter) };
      if (applySplice(cur.src, splice.start, span.endBefore, splice.rawAfter) !== decoded.src || !bytesEqual(encodeDeck(decoded.src), snapshot)) {
        return { ok: false, why: 'restore: the snapshot does not round-trip byte for byte', code: 'verify' };
      }
      const next: Version = { version, src: decoded.src, utf8: true, map: mapFor(version, decoded.src) };
      const record = makeRecord(cur.src, splice, cur.version, version);
      const w = await writeBytes(loaded, snapshot, next, 'restore');
      if (w.kind === 'conflict') continue; // the next attempt finds another version and refuses
      if (w.kind === 'refused') return { ok: false, why: w.why, code: w.code };
      await afterWrite(next, record, snapshot, cur.version, 'restore');
      return { ok: true, version };
    }
    return { ok: false, why: 'conflict: the deck kept changing during the write', code: 'conflict' };
  }

  /**
   * P2-3: a version a client holds, so its context can resolve a stale edit. Its source decides where a stale edit
   * lands, so it is taken only when it hashes to `version` (one encode and hash, a few milliseconds on a large
   * deck); anything else is ignored. A deck that is not UTF-8 is never written, so it has nothing to tell.
   */
  function know(version: string, src: string, map: DeckMap): void {
    if (typeof version !== 'string' || !SHA256.test(version) || typeof src !== 'string' || !map || map.version !== version) return;
    if (!map.utf8 || (map.served && map.served.srcLength !== src.length)) return;
    try {
      if (io.sha256(encodeDeck(src)) !== version) return;
    } catch {
      return;
    }
    // Keep the map already built for this source (complete, or completed later by its first reader, D-9).
    const known = versions.get(version);
    if (known && known.src === src && known.utf8 === map.utf8) {
      remember(known);
      return;
    }
    remember({ version, src, utf8: map.utf8, map });
  }

  // An unexpected exception never escapes as a rejection: nothing was written before the atomic write
  // resolved, so the edit is kept as a verbatim note (or the undo refused) and the file is as it was.
  const guardEdit = async (req: EditRequest): Promise<WriteOutcome> => {
    try {
      return await doEdit(req);
    } catch (e) {
      return verbatimOf(req, `internal error: ${message(e)}`, 'internal');
    }
  };
  const guardUndo = async (record: WriteRecord, label: 'undo' | 'redo'): Promise<UndoOutcome> => {
    try {
      return await doUndo(label === 'redo' && isWriteRecord(record) ? swapRecord(record) : record, label);
    } catch (e) {
      return { ok: false, why: `internal error: ${message(e)}`, canMakeNote: true, code: 'internal' };
    }
  };
  const guardRestore = async (bytes: Uint8Array, expectVersion: string): Promise<RestoreOutcome> => {
    try {
      return await doRestore(bytes, expectVersion);
    } catch (e) {
      return { ok: false, why: `internal error: ${message(e)}`, code: 'internal' };
    }
  };

  return {
    edit: (req) => enqueue(() => guardEdit(req)),
    // undo(W) and redo(W) both take the record of the original write W; redo is undo with rawBefore and
    // rawAfter swapped (9.2). The record each returns describes the write it just made.
    undo: (record) => enqueue(() => guardUndo(record, 'undo')),
    redo: (record) => enqueue(() => guardUndo(record, 'redo')),
    restore: (bytes, expectVersion) => enqueue(() => guardRestore(bytes, expectVersion)),
    know,
    currentMap: () => enqueue(async () => (current ? current.map : (await load()).v.map)),
    refresh: () => enqueue(async () => (await load()).v.map),
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
