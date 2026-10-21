// FSL-1.1-ALv2 (packages/editor/LICENSE.md)
//
// The per-deck write queue: the write protocol of 9.2 for direct edits, undo, redo and whole-file restores.
//
//   1. Versions. Every map carries `version`, the sha256 of the file bytes it was built from. The queue keeps
//      the source and map of recent versions, because a client may still hold an old one; main tells it the
//      versions its pages and open fields hold (know, P2-3) and pins them for as long as they are held (know with
//      `pin`, unpin; SPEC 9.2 step 1: "Main keeps the map for each version a client still holds"): the LRU of
//      `keepVersions` never evicts a pinned version.
//   2. Queue and version check. One operation at a time. Each re-reads the file and hashes it. If the hash is
//      not the client's version, the edit is placed by POSITION (lead decision E-1): the run's raw range in the
//      client's version is mapped to the current source through a diff (core/locked-spans mapRange: diff_main with
//      a time limit, no clean-up, as the locked spans are moved), and only a run of the same kind (parsed text or
//      a literal) at exactly that range, holding beforeText, with no change overlapping it, is the edit's run, and
//      only when the text on both sides of it confirms the place (place.ts, anchors.ts; the hardening round). The
//      run is first carried through the changes the queue saw between the two versions: its own writes move it
//      exactly by their splices, and only another program's change is placed that way, between the versions around it.
//      Text alone never picks a copy, and neither does the 32 characters of context around it. Anything else is a
//      verbatim note: `ambiguous` when another run still holds beforeText, `stale` when none does, when the diff
//      timed out, or when the queue does not know the client's version (it cannot be checked against what the
//      client saw). Stale offsets are never applied.
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
import { LOCK_DIFF_TIMEOUT_SEC } from '@blueline/core/locked-spans';
import { liftPick } from '@blueline/core/edit-commit';
import { buildMap } from '@blueline/core/mapper';
import { decodeDeck, encodeDeck } from '@blueline/core/text';
import type { DeckIO, RestoreOutcome, UndoOutcome, WriteKind, WriteQueue, WriteQueueOptions } from '@blueline/core/capabilities';
import type { DeckMap, EditRequest, HtmlRun, LiteralRun, RefusalCode, WriteOutcome, WriteRecord } from '@blueline/core/types';
import { placeStale } from './place';
import { findRun, planEdit, type EditPlan } from './plan';
import { applySplice } from './splice';
import { isWriteRecord, makeRecord, planUndo, swapRecord } from './undo';
import { verifyEdit, verifyUndo } from './verify';

/** Options beyond the contract's WriteQueueOptions. */
export interface EditorQueueOptions extends WriteQueueOptions {
  /** How many recent versions (source and map) are kept for clients that hold an old one. Default 8; pinned ones stay. */
  keepVersions?: number;
  /** The time limit of the diff that places a stale edit by position (seconds; default LOCK_DIFF_TIMEOUT_SEC). */
  diffTimeoutSec?: number;
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

/** One splice: `removed` characters at `start` replaced by `inserted` characters. */
interface Splice {
  start: number;
  removed: number;
  inserted: number;
}

/**
 * A change the queue saw, by the version it produced: the version before it, and the splice when it was the
 * queue's own write (null when another program made it: the file was found changed when the queue read it).
 */
interface Step {
  parent: string;
  splice: Splice | null;
}

/**
 * How many changes are remembered, the longest chain of them a stale edit is carried through, and how many of
 * those may be another program's (each one is placed by position as a stale edit is, so each costs a diff).
 */
const STEPS_KEPT = 1024;
const CHAIN_MAX = 256;
const FOREIGN_STEPS_MAX = 3;

/** How a write attempt ended: written (possibly after a rejection, when the file landed), requeue, or refused. */
type WriteResult = { kind: 'written' } | { kind: 'conflict' } | { kind: 'refused'; why: string; code: RefusalCode };

const SHA256 = /^[0-9a-f]{64}$/;

function isConflict(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: unknown }).name === 'WriteConflictError';
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
  const diffTimeoutSec = opts.diffTimeoutSec ?? LOCK_DIFF_TIMEOUT_SEC;
  /** Recent versions by hash, least recently used first. */
  const versions = new Map<string, Version>();
  /** How many holders pinned each version (know with `pin`): such a version is never evicted (9.2 step 1). */
  const pins = new Map<string, number>();
  let current: Version | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  /**
   * The changes the queue saw, by the version each produced (Step). Across the queue's own writes a range moves
   * exactly by their splices (no diff, nothing to guess); only another program's change is placed by position, as
   * a stale edit made on the version before it would be (resolve, carry).
   */
  const steps = new Map<string, Step>();
  /**
   * The versions on both sides of the last FOREIGN_STEPS_MAX changes by another program: carry places a run across
   * such a change between them, so the LRU keeps them (at most 2 × FOREIGN_STEPS_MAX versions beyond `keep`).
   */
  let aroundForeign: string[] = [];

  /** The per-deck serial queue (9.2 Write protocol step 2): each job starts when the previous one settles. */
  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = tail.then(job, job);
    tail = run.catch(() => undefined);
    return run;
  }

  function remember(v: Version): Version {
    versions.delete(v.version);
    versions.set(v.version, v);
    // Least recently used first, skipping what a client still holds; pinned versions may exceed `keep`.
    if (versions.size > keep) {
      for (const k of [...versions.keys()]) {
        if (versions.size <= keep) break;
        if (k !== v.version && !pins.has(k) && !aroundForeign.includes(k)) versions.delete(k);
      }
    }
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
    // Not the version the queue last read or wrote: another program changed the file in between.
    if (current && current.version !== version) {
      if (noteStep(version, { parent: current.version, splice: null })) {
        aroundForeign = [...aroundForeign.filter((k) => k !== current!.version && k !== version), current.version, version].slice(-2 * FOREIGN_STEPS_MAX);
      }
    }
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

  /** Records the latest change that produced `version`. */
  function noteStep(version: string, step: Step): boolean {
    // The first change that produced a version is kept: an undo or a redo returns to a version already seen, and
    // linking that version to the one undone would make a cycle and cut it off from the versions before it.
    if (steps.has(version)) return false;
    steps.set(version, step);
    while (steps.size > STEPS_KEPT) steps.delete(steps.keys().next().value!);
    return true;
  }

  /** Records an own write that landed (`next` made from `cur` by one splice). */
  function noteOwn(cur: Version, next: Version, splice: Splice): void {
    noteStep(next.version, { parent: cur.version, splice });
  }

  /** The changes from version `from` to version `to`, oldest first, each with the version it produced. */
  function chain(from: string, to: string): Array<Step & { child: string }> | undefined {
    const out: Array<Step & { child: string }> = [];
    const seen = new Set<string>();
    let v = to;
    while (v !== from) {
      const st = steps.get(v);
      if (!st || out.length >= CHAIN_MAX || seen.has(v)) return undefined;
      seen.add(v);
      out.push({ ...st, child: v });
      v = st.parent;
    }
    return out.reverse();
  }

  /** The run of `kind` at exactly [start, end) of `map`, holding `value`. */
  function runAt(map: DeckMap, kind: string, start: number, end: number, value: string): HtmlRun | LiteralRun | undefined {
    return [...map.runs, ...map.literals].find((r) => r.id.slice(0, 2) === kind && r.start === start && r.end === end && r.value === value);
  }

  /**
   * The request's run carried from the client's version to the current one through the changes the queue saw: an
   * own write moves it exactly by its splice (and refuses when it touched the run or its edges), another program's
   * change is placed by position between the two versions around it (place.ts), as a stale edit made on the version
   * before that change would be. The id of the run in `cur`, or null when any step cannot carry it (the caller then
   * places it across the whole span).
   */
  function carry(old: Version, run: HtmlRun | LiteralRun, cur: Version, beforeText: string): string | null {
    const path = chain(old.version, cur.version);
    if (!path || path.filter((st) => st.splice === null).length > FOREIGN_STEPS_MAX) return null;
    const kind = run.id.slice(0, 2);
    let s = run.start;
    let e = run.end;
    for (const st of path) {
      const sp = st.splice;
      if (sp) {
        if (sp.start > e) continue;
        if (sp.start + sp.removed < s) {
          s += sp.inserted - sp.removed;
          e += sp.inserted - sp.removed;
          continue;
        }
        return null;
      }
      const a = versions.get(st.parent);
      const b = versions.get(st.child);
      if (!a || !b || !a.utf8 || !b.utf8) return null;
      const at = runAt(a.map, kind, s, e, beforeText);
      if (!at) return null;
      const placed = placeStale(a, at, b, beforeText, diffTimeoutSec);
      if (!placed.ok) return null;
      const got = findRun(b.map, placed.runId);
      if (!got) return null;
      s = got.start;
      e = got.end;
    }
    const hit = runAt(cur.map, kind, s, e, beforeText);
    return hit ? hit.id : null;
  }

  /**
   * Step 2: which run of the current version the request means. The same version: the request's run id. Another
   * version (E-1): the run at the position the client's run maps to through a diff of the client's version to the
   * current one, when it is of the same kind and holds beforeText, no change overlaps it, and the text on both sides
   * confirms the place (place.ts); anything else is a verbatim note. The client's version must be known (main pins
   * every version an open page or field holds).
   */
  function resolve(cur: Version, req: EditRequest): Resolved {
    if (req.version === cur.version) return { ok: true, runId: req.runId };
    const kind = req.runId.slice(0, 2);
    if (kind !== 'h:' && kind !== 'l:') return { ok: false, why: 'unknown run id', code: 'refused' };
    const old = versions.get(req.version);
    // Without the client's version nothing says where its run is now: text alone never picks a copy.
    if (!old) return { ok: false, why: 'the deck changed and the version the edit was made on is not known, so its place cannot be found (9.2 Write protocol step 2)', code: 'stale' };
    const oldRun = findRun(old.map, req.runId);
    // The client's own map must agree with its request, or the request is not what the client saw.
    if (!oldRun || oldRun.value !== req.beforeText) {
      return { ok: false, why: 'the request does not match the version it names', code: 'refused' };
    }
    // Through the changes the queue saw: its own writes move the run exactly, another program's is placed alone.
    const carried = carry(old, oldRun, cur, req.beforeText);
    if (carried !== null) return { ok: true, runId: carried };
    return placeStale(old, oldRun, cur, req.beforeText, diffTimeoutSec);
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
  async function writeBytes(loaded: Loaded, bytes: Uint8Array, next: Version, kind: WriteKind, step: Splice): Promise<WriteResult> {
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
      noteOwn(cur, next, step);
      return { kind: 'written' };
    }
    current = remember(next);
    noteOwn(cur, next, step);
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
      const w = await writeBytes(loaded, bytes, next, 'edit', { start: plan.start, removed: plan.rawBefore.length, inserted: plan.rawAfter.length });
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
      // Case 2 is placed by position from the version the write made (E-1): its source, when the queue still has it.
      const base = versions.get(record.versionAfter);
      const p = planUndo(cur.src, record, cur.version, base && base.utf8 ? base.src : null, { timeoutSec: diffTimeoutSec });
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
      const w = await writeBytes(loaded, bytes, next, label, { start: p.start, removed: p.rawBefore.length, inserted: p.rawAfter.length });
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
      const w = await writeBytes(loaded, snapshot, next, 'restore', { start: splice.start, removed: splice.rawBefore.length, inserted: splice.rawAfter.length });
      if (w.kind === 'conflict') continue; // the next attempt finds another version and refuses
      if (w.kind === 'refused') return { ok: false, why: w.why, code: w.code };
      await afterWrite(next, record, snapshot, cur.version, 'restore');
      return { ok: true, version };
    }
    return { ok: false, why: 'conflict: the deck kept changing during the write', code: 'conflict' };
  }

  /**
   * P2-3: a version a client holds, so a stale edit made on it can be placed (step 2). Its source decides where a
   * stale edit lands, so it is taken only when it hashes to `version` (one encode and hash, a few milliseconds on a
   * large deck); anything else is ignored. A deck that is not UTF-8 is never written, so it has nothing to tell.
   * `pin`: the version stays until as many unpin calls (9.2 step 1); a version already known is pinned without a
   * new hash.
   */
  function know(version: string, src: string, map: DeckMap, o: { pin?: boolean } = {}): void {
    if (typeof version !== 'string' || !SHA256.test(version) || typeof src !== 'string' || !map || map.version !== version) return;
    if (!map.utf8 || (map.served && map.served.srcLength !== src.length)) return;
    // Keep the map already built for this source (complete, or completed later by its first reader, D-9).
    const known = versions.get(version);
    if (known && known.src === src && known.utf8 === map.utf8) {
      if (o.pin === true) pins.set(version, (pins.get(version) ?? 0) + 1);
      remember(known);
      return;
    }
    try {
      if (io.sha256(encodeDeck(src)) !== version) return;
    } catch {
      return;
    }
    if (o.pin === true) pins.set(version, (pins.get(version) ?? 0) + 1);
    remember({ version, src, utf8: map.utf8, map });
  }

  /** One holder of `version` let it go (know with `pin`); the LRU may evict it once nobody holds it. */
  function unpin(version: string): void {
    const n = pins.get(version);
    if (n === undefined) return;
    if (n <= 1) pins.delete(version);
    else pins.set(version, n - 1);
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
    unpin,
    currentMap: () => enqueue(async () => (current ? current.map : (await load()).v.map)),
    refresh: () => enqueue(async () => (await load()).v.map),
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
