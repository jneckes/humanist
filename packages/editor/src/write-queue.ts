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
//      not the client's version V, the run is carried to the current version C through the changes the queue saw
//      (carryRange). When every one of them is Blueline's own edit, undo or redo, the run moves exactly by their
//      splices: nothing to guess. When another program changed the file (or a restore, a whole other version, lies
//      in between; judged by time, not by the route: a change the queue saw since the oldest hold of V counts
//      even when the bytes came back), the uniqueness rule decides (lead decision F-1; place.ts): beforeText must be
//      the value of exactly one run in V and exactly one in C (shadow values count as copies, as the matcher counts
//      them), and of at most one in each version another program made in between, the run must land exactly on that
//      one run, and the text on both sides must confirm it (anchors.ts). Each other
//      program's change is placed that way, between the versions around it, with the run's value at that step.
//      When the queue did not see every change, one diff over the whole span places it the same way, and only when
//      Blueline wrote nothing since V (one diff cannot see Blueline's own writes); a carry that a step refused is a
//      note, never placed again across the whole span (the queue saw the text in two places on the way: a slide
//      duplicated, then its original deleted).
//      No path ever chooses one copy among several across another program's change. Anything else is a verbatim
//      note: `ambiguous` when the text is in more than one place in V or C, `stale` when it is in one place but the
//      mapping or the anchors fail, when no run holds it, when the diff timed out, or when the queue does not know
//      the client's version (it cannot be checked against what the client saw). Stale offsets are never applied.
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
import { NOT_PLACED, placeStale, placesOf } from './place';
import { findRun, planEdit, type EditPlan } from './plan';
import { applySplice } from './splice';
import { CANT_UNDO, isWriteRecord, makeRecord, planUndo, swapRecord } from './undo';
import { verifyEdit, verifyUndo } from './verify';

/** Options beyond the contract's WriteQueueOptions. */
export interface EditorQueueOptions extends WriteQueueOptions {
  /** How many recent versions (source and map) are kept for clients that hold an old one. Default 8; pinned ones stay. */
  keepVersions?: number;
  /** The time limit of the diff that places a stale edit by position (seconds; default LOCK_DIFF_TIMEOUT_SEC). */
  diffTimeoutSec?: number;
  /**
   * A deck another program is still writing in place (load): how long an operation waits for it to end as the last
   * whole version did (ms; default WAIT_WRITER_MS), how often it reads again meanwhile (ms; default 100), and how
   * long a version that does not end so must have been on disk before it is taken as it is (ms; default
   * ACCEPT_CUT_MS). `sleep` and `now` are test hooks.
   */
  writerWaitMs?: number;
  writerPollMs?: number;
  acceptCutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** How long an operation waits for another program to finish writing the deck in place (load). */
export const WAIT_WRITER_MS = 5000;
/** How long a deck that no longer ends as a whole document must have stood unchanged before it is written on. */
export const ACCEPT_CUT_MS = 30_000;

/** The deck on disk looks half-written by another program (load), so nothing is written on it. */
class DeckBeingWritten extends Error {
  override name = 'DeckBeingWritten';
}

const BEING_WRITTEN =
  'conflict: another program is still writing the deck (it does not end as the last whole version did), so nothing was written on it (9.2 Write protocol step 2)';

/**
 * Whether a source ends as a whole HTML document does: `</html>`, then only white space and comments. A program
 * that writes the deck in place (a shell redirect, Python's open('w'), a template engine streaming its output, curl
 * or rsync --inplace) leaves a prefix of it on disk while it pauses; that prefix does not end so.
 */
function endsWhole(src: string): boolean {
  let tail = src.slice(-4096).trimEnd();
  while (tail.endsWith('-->')) {
    const open = tail.lastIndexOf('<!--', tail.length - 3);
    if (open < 0) return false;
    tail = tail.slice(0, open).trimEnd();
  }
  return /<\/html\s*>$/i.test(tail);
}

/** endsWhole on the last bytes of a file (a cut multi-byte character there does not matter: the tag is ASCII). */
function bytesEndWhole(bytes: Uint8Array): boolean {
  return endsWhole(new TextDecoder('utf-8').decode(bytes.subarray(Math.max(0, bytes.length - 4096))));
}

/** One version of the file, as read, written or told (know) through this queue. */
interface Version {
  version: string;
  src: string;
  utf8: boolean;
  map: DeckMap;
  /** How many writes of its own the queue had made when it first met this version (resolve, doUndo). */
  ownAt?: number;
  /**
   * On the queue's clock (foreignSince): when it first met this version, when main last told it about the version
   * (know: a page shown, a field opened, a version taken from the watcher), and when Blueline's own edit, undo or
   * redo last made it.
   */
  metAt?: number;
  toldAt?: number;
  madeAt?: number;
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
 * queue's own edit, undo or redo (null when another program made it, the file found changed when the queue read
 * it, and for a restore: a whole other version, whose meaning is not its prefix and suffix trimmed). `own`: the
 * queue made it (a restore too).
 */
interface Step {
  parent: string;
  splice: Splice | null;
  own: boolean;
}

/**
 * A range carried through the recorded changes (carryRange), or why not. `own`: Blueline wrote in the span;
 * `foreign`: another program's change or a restore lies in it (each placed by the uniqueness rule, F-1).
 */
type Carried =
  | { kind: 'ok'; start: number; end: number; own: boolean; foreign: boolean }
  | { kind: 'refused'; own: boolean; why?: string; code?: RefusalCode }
  | { kind: 'unknown' };

/**
 * How many changes are remembered, the longest chain of them a stale edit is carried through, and how many of
 * those may be placed (another program's changes and restores: each one is placed by position as a stale edit is,
 * so each costs a diff).
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
  const pins = new Map<string, number[]>();
  let current: Version | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  /**
   * The changes the queue saw, by the version each produced (Step). Across the queue's own writes a range moves
   * exactly by their splices (no diff, nothing to guess); only another program's change, or a restore, is placed by
   * position, as a stale edit made on the version before it would be (resolve, carryRange).
   */
  const steps = new Map<string, Step[]>();
  /** The versions the recorded steps produced, oldest first (one entry per step), for evicting the oldest. */
  const stepOrder: string[] = [];
  /**
   * The versions on both sides of the last FOREIGN_STEPS_MAX placed changes (another program's, and restores): carry
   * places a run across such a change between them, so the LRU keeps them (at most 2 × FOREIGN_STEPS_MAX versions
   * beyond `keep`).
   */
  let aroundForeign: string[] = [];
  /** How many writes landed through this queue (edits, undos, redos and restores). */
  let ownWrites = 0;
  /**
   * When the queue met each version and saw each change not carried exactly (another program's, a restore), on one
   * clock: whether another program changed the file since a version is a question of time, not of the route between
   * the two versions (a change that was later undone, a slide duplicated and its original deleted, leaves a route of
   * Blueline's own writes alone). `foreignFrom`: entries before it were dropped.
   */
  let clock = 0;
  const foreignLog: { at: number; child: string }[] = [];
  let foreignFrom = 0;

  /** The per-deck serial queue (9.2 Write protocol step 2): each job starts when the previous one settles. */
  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = tail.then(job, job);
    tail = run.catch(() => undefined);
    return run;
  }

  function remember(v: Version): Version {
    // The first time the queue met a version counts (a write that returns to a version already seen).
    const was = versions.get(v.version);
    v.ownAt = Math.min(v.ownAt ?? ownWrites, was?.ownAt ?? ownWrites);
    const now = ++clock;
    v.metAt = Math.min(v.metAt ?? now, was?.metAt ?? now);
    const latest = (a?: number, b?: number) => (a === undefined ? b : b === undefined ? a : Math.max(a, b));
    v.toldAt = latest(v.toldAt, was?.toldAt);
    v.madeAt = latest(v.madeAt, was?.madeAt);
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

  /** When each version that does not end as a whole document was first read (load), by hash. */
  const cutSeen = new Map<string, number>();
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());

  /**
   * Reads the file. When the last version the queue knew ended as a whole document and the file now does not, another
   * program is probably writing it in place and has paused (the second hardening round): a write renamed over it now
   * would take the prefix for its version, and the rest of that program's output would go to the replaced file and be
   * lost. So the file is read again until it ends whole, for at most writerWaitMs; past that the operation is refused
   * (`DeckBeingWritten`), unless that very version has stood on disk for acceptCutMs (a deck that lost its end for
   * good is written on again).
   */
  async function readWhole(): Promise<Uint8Array> {
    let bytes = await io.read();
    if (bytesEndWhole(bytes)) return bytes;
    // The deck ended whole before: as the queue last read or wrote it, or (before its first read) in any version it
    // was told about. A version main took from the watcher may be the half-written one itself.
    const wasWhole = current ? current.utf8 && endsWhole(current.src) : [...versions.values()].some((v) => v.utf8 && endsWhole(v.src));
    if (!wasWhole) return bytes;
    const waitMs = Math.max(0, opts.writerWaitMs ?? WAIT_WRITER_MS);
    const pollMs = Math.max(1, opts.writerPollMs ?? 100);
    const deadline = now() + waitMs;
    for (;;) {
      if (bytesEndWhole(bytes)) return bytes;
      const hash = io.sha256(bytes);
      if (current && hash === current.version) return bytes;
      const first = cutSeen.get(hash) ?? now();
      cutSeen.set(hash, first);
      while (cutSeen.size > 64) cutSeen.delete(cutSeen.keys().next().value!);
      if (now() - first >= Math.max(0, opts.acceptCutMs ?? ACCEPT_CUT_MS)) return bytes;
      if (now() >= deadline) throw new DeckBeingWritten(BEING_WRITTEN);
      await sleep(pollMs);
      bytes = await io.read();
    }
  }

  /**
   * Re-reads the file and hashes it (step 2). A known version's map is reused only when its source is the one
   * these bytes decode to: a version main told the queue about (know) is never trusted beyond what it can check.
   */
  async function load(): Promise<Loaded> {
    const bytes = await readWhole();
    const version = io.sha256(bytes);
    const decoded = decodeDeck(bytes);
    // Not the version the queue last read or wrote: another program changed the file in between.
    if (current && current.version !== version) {
      noteForeign(version);
      if (noteStep(version, { parent: current.version, splice: null, own: false })) keepAround(current.version, version);
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

  /**
   * Records a change that produced `version`. Every one is kept: an undo or a redo returns to a version already seen,
   * by another route than the first one, and chain() takes the shortest route, the newest first (a redo is carried
   * through the write it redoes and its undo, not through an older edit that happened to make the same bytes).
   */
  function noteStep(version: string, step: Step): boolean {
    const list = steps.get(version) ?? [];
    if (list.some((x) => x.parent === step.parent && x.own === step.own && JSON.stringify(x.splice) === JSON.stringify(step.splice))) return false;
    list.push(step);
    steps.set(version, list);
    stepOrder.push(version);
    while (stepOrder.length > STEPS_KEPT) {
      const old = stepOrder.shift()!;
      const l = steps.get(old);
      if (l) {
        l.shift();
        if (l.length === 0) steps.delete(old);
      }
    }
    return true;
  }

  /** Keeps the versions on both sides of a placed change (another program's, or a restore). */
  function keepAround(before: string, after: string): void {
    aroundForeign = [...aroundForeign.filter((k) => k !== before && k !== after), before, after].slice(-2 * FOREIGN_STEPS_MAX);
  }

  /** Records an own write that landed (`next` made from `cur` by one splice, or a restore: null). */
  function noteOwn(cur: Version, next: Version, splice: Splice | null): void {
    if (splice === null) noteForeign(next.version);
    if (noteStep(next.version, { parent: cur.version, splice, own: true }) && splice === null) keepAround(cur.version, next.version);
  }

  /** A change not carried exactly (another program's, or a restore) that produced `child`, seen now. */
  function noteForeign(child: string): void {
    foreignLog.push({ at: ++clock, child });
    while (foreignLog.length > STEPS_KEPT) foreignFrom = foreignLog.shift()!.at;
  }

  /**
   * The versions that another program's changes (and restores) produced since `t`, whatever the route between the
   * versions; a change that produced `v` itself does not count. Null when the queue no longer remembers them all.
   * The time of a stale edit's version is when the oldest client still holding it began to (editTime); the time of
   * an undo's or redo's is when Blueline's own write last made it (undoTime).
   */
  function foreignSince(v: Version, t: number): string[] | null {
    if (t < foreignFrom) return null;
    return [...new Set(foreignLog.filter((f) => f.at > t && f.child !== v.version).map((f) => f.child))];
  }
  /**
   * A stale edit's version: since the oldest hold of it that main has not let go (a field held open across another
   * program's changes keeps its time even when another page shows the same bytes later), else since main last told
   * the queue about it, else since the queue first met it.
   */
  const editTime = (v: Version): number => pins.get(v.version)?.[0] ?? v.toldAt ?? v.metAt ?? 0;
  /** The time of the write an undo or redo record names: when its result (`made`) was last made, else `base` met. */
  const undoTime = (made: Version | undefined, base: Version): number => made?.madeAt ?? base.metAt ?? 0;

  /**
   * F-1 (a) on the way: `text` is in at most one place in each version another program made since the version an
   * operation was made on (`made`, from foreignSince). A copy the queue saw there is a copy, even when a later change
   * took it away again (a slide duplicated, then its original deleted, reads as the slide alone). A version the queue
   * no longer holds cannot be checked: false.
   */
  function oneOnTheWay(made: string[] | null, text: string): boolean {
    if (made === null) return false;
    for (const h of made) {
      const x = versions.get(h);
      if (!x || !x.utf8 || placesOf(x.map, text) > 1) return false;
    }
    return true;
  }

  /**
   * The changes from version `from` to version `to`, oldest first, each with the version it produced: the shortest
   * route through the recorded steps (searched back from `to`, the newest step of each version first), at most
   * CHAIN_MAX long.
   */
  function chain(from: string, to: string): Array<Step & { child: string }> | undefined {
    if (from === to) return [];
    // Breadth first, back from `to`: each version reached keeps the step that reached it.
    const via = new Map<string, Step & { child: string }>();
    let level = [to];
    const seen = new Set<string>([to]);
    for (let depth = 0; depth < CHAIN_MAX && level.length > 0; depth++) {
      const next: string[] = [];
      for (const v of level) {
        const list = steps.get(v) ?? [];
        for (let k = list.length - 1; k >= 0; k--) {
          const st = list[k];
          if (seen.has(st.parent)) continue;
          seen.add(st.parent);
          via.set(st.parent, { ...st, child: v });
          if (st.parent === from) {
            const out: Array<Step & { child: string }> = [];
            for (let u = from; u !== to; ) {
              const x = via.get(u)!;
              out.push(x);
              u = x.child;
            }
            return out;
          }
          next.push(st.parent);
        }
      }
      level = next;
    }
    return undefined;
  }

  /** The run of `kind` at exactly [start, end) of `map`, holding `value`. */
  function runAt(map: DeckMap, kind: string, start: number, end: number, value: string): HtmlRun | LiteralRun | undefined {
    return [...map.runs, ...map.literals].find((r) => r.id.slice(0, 2) === kind && r.start === start && r.end === end && r.value === value);
  }

  /**
   * The run of `v` that holds [s, e): a mapped one (a literal's shadow run has the same range and is never written),
   * the innermost when one holds another; none when two of the same size hold it. `kind`: of that kind.
   */
  function holderOf(v: Version, s: number, e: number, kind?: string): HtmlRun | LiteralRun | null {
    const holders = [...v.map.runs, ...v.map.literals]
      .filter((r) => (kind === undefined || r.id.slice(0, 2) === kind) && r.start <= s && e <= r.end && r.aligned !== false)
      .sort((x, y) => x.end - x.start - (y.end - y.start));
    if (holders.length === 0 || (holders.length > 1 && holders[1].end - holders[1].start === holders[0].end - holders[0].start && holders[1].start !== holders[0].start)) return null;
    return holders[0];
  }

  /**
   * [s, e) of `a` placed in `b` across one change by another program (or a restore): the run that holds it is placed
   * as a stale edit made on `a` would be (place.ts: its value in one place in `a` and in `b`, the diff landing on it,
   * both sides confirming it), and the range keeps its offset in it, which needs the run's raw text unchanged (the
   * whole run itself needs only its text). `kind`: the run must be of that kind.
   */
  function placeRange(a: Version, s: number, e: number, b: Version, kind?: string): { ok: true; start: number; end: number } | { ok: false; why: string; code: RefusalCode } {
    const no = (why: string, code: RefusalCode = 'stale') => ({ ok: false as const, why, code });
    if (!a.utf8 || !b.utf8) return no('the deck is not UTF-8 on one side of the change');
    const r = holderOf(a, s, e, kind);
    if (!r) return no('the edited place is in no run Blueline can place (9.2 Write protocol step 2)');
    const placed = placeStale(a, r, b, r.value, diffTimeoutSec);
    if (!placed.ok) return placed;
    const got = findRun(b.map, placed.runId);
    if (!got) return no(NOT_PLACED.gone);
    if (s === r.start && e === r.end) return { ok: true, start: got.start, end: got.end };
    if (b.src.slice(got.start, got.end) !== a.src.slice(r.start, r.end)) return no(NOT_PLACED.moved);
    return { ok: true, start: got.start + (s - r.start), end: got.start + (e - r.start) };
  }

  /**
   * [s, e) of version `from` carried to `to` through the changes the queue saw. An own edit, undo or redo moves it
   * exactly by its splice: one before it shifts it, one inside it (Blueline's own write in the range, or at an empty
   * range: the write that made it, or a later one the final check then refuses) leaves the range holding its result,
   * one across its edge refuses. Another program's change and a restore are placed between the versions around them
   * (placeRange, the uniqueness rule F-1). `unknown`: the queue did not see every change between the two (or too many
   * of them must be placed).
   */
  function carryRange(from: Version, s: number, e: number, to: Version, kind?: string): Carried {
    if (from.version === to.version) return { kind: 'ok', start: s, end: e, own: false, foreign: false };
    const path = chain(from.version, to.version);
    if (!path || path.filter((st) => st.splice === null).length > FOREIGN_STEPS_MAX) return { kind: 'unknown' };
    const own = path.some((st) => st.own);
    const foreign = path.some((st) => st.splice === null);
    for (const st of path) {
      const sp = st.splice;
      if (sp) {
        const a = sp.start;
        const b = sp.start + sp.removed;
        const d = sp.inserted - sp.removed;
        if (b < s || (b === s && (a < s || s < e))) {
          s += d;
          e += d;
        } else if (a > e || (a === e && (b > a || s < e))) {
          // after the range
        } else if (s <= a && b <= e) {
          e += d;
        } else {
          return { kind: 'refused', own };
        }
        continue;
      }
      const va = versions.get(st.parent);
      const vb = versions.get(st.child);
      if (!va || !vb) return { kind: 'refused', own, why: 'a version around another program\'s change is no longer known, so the place cannot be found (9.2 Write protocol step 2)', code: 'stale' };
      const placed = placeRange(va, s, e, vb, kind);
      if (!placed.ok) return { kind: 'refused', own, why: placed.why, code: placed.code };
      s = placed.start;
      e = placed.end;
    }
    return { kind: 'ok', start: s, end: e, own, foreign };
  }

  /** Whether Blueline wrote since the queue first met `v` (when the changes in between are not all known). */
  function ownSince(v: Version): boolean {
    return ownWrites > (v.ownAt ?? 0);
  }

  /**
   * Step 2: which run of the current version the request means. The same version: the request's run id. Another
   * version: the run carried through the changes the queue saw; Blueline's own writes alone move it exactly, and when
   * another program changed the file in between, the uniqueness rule must hold (F-1, place.ts): beforeText in one
   * place in the client's version and in the current one, and the run landing exactly there. Anything else is a
   * verbatim note. The client's version must be known (main pins every version an open page or field holds).
   */
  function resolve(cur: Version, req: EditRequest): Resolved {
    if (req.version === cur.version) {
      // The same bytes: the run is the request's own, unless another program changed the file in between and put it
      // back as it was (a slide duplicated and its original deleted reads the same): then F-1 (a) holds over that time.
      const made = foreignSince(cur, editTime(cur));
      if ((made === null || made.length > 0) && (placesOf(cur.map, req.beforeText) !== 1 || !oneOnTheWay(made, req.beforeText))) {
        return { ok: false, why: NOT_PLACED.copies, code: 'ambiguous' };
      }
      return { ok: true, runId: req.runId };
    }
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
    // The note's code: `ambiguous` when the text is in more than one place on either side, else `stale`.
    const code = (): RefusalCode => (placesOf(old.map, req.beforeText) > 1 || placesOf(cur.map, req.beforeText) > 1 ? 'ambiguous' : 'stale');
    // Through the changes the queue saw: its own writes move the run exactly, another program's are placed by F-1.
    const c = carryRange(old, oldRun.start, oldRun.end, cur, kind);
    if (c.kind === 'ok') {
      const hit = runAt(cur.map, kind, c.start, c.end, req.beforeText);
      const made = foreignSince(old, editTime(old));
      if (hit && !c.foreign && made !== null && made.length === 0) return { ok: true, runId: hit.id };
      // F-1 (a) on the two ends and in every version another program made in between; each placed step was checked
      // with the run's value at that step.
      if (hit && placesOf(old.map, req.beforeText) === 1 && placesOf(cur.map, req.beforeText) === 1 && oneOnTheWay(made, req.beforeText)) {
        return { ok: true, runId: hit.id };
      }
      if (hit) return { ok: false, why: NOT_PLACED.copies, code: 'ambiguous' };
      return {
        ok: false,
        why: c.own
          ? 'the deck changed around the edited place, by Blueline\'s own writes and by another program, so its place cannot be confirmed (9.2 Write protocol step 2)'
          : NOT_PLACED.moved,
        code: code(),
      };
    }
    // A step refused: never placed again across the whole span, which could not see the copies the queue saw on the
    // way (a slide duplicated, then its original deleted).
    if (c.kind === 'refused') return { ok: false, why: c.why ?? NOT_PLACED.moved, code: c.code === 'ambiguous' ? 'ambiguous' : code() };
    // The queue did not see every change: one diff over the whole span, only when Blueline wrote nothing since (one
    // diff cannot see Blueline's own writes).
    if (ownSince(old)) {
      return {
        ok: false,
        why: 'the deck changed around the edited place, by Blueline\'s own writes and by another program, so its place cannot be confirmed (9.2 Write protocol step 2)',
        code: code(),
      };
    }
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
  async function writeBytes(loaded: Loaded, bytes: Uint8Array, next: Version, kind: WriteKind, step: Splice | null): Promise<WriteResult> {
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
      ownWrites++;
      current = remember(next);
      if (step) next.madeAt = ++clock;
      noteOwn(cur, next, step);
      return { kind: 'written' };
    }
    ownWrites++;
    current = remember(next);
    if (step) next.madeAt = ++clock;
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
        if (e instanceof DeckBeingWritten) return verbatim(e.message, 'conflict');
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

  /**
   * Where the write's range [start, start + rawAfter) of `base` (the version it made) is in `cur`, or null (case 3).
   * Carried through the changes the queue saw: Blueline's own later writes exactly. When another program changed
   * the file since (or a restore lies in between), the uniqueness rule holds too (F-1): the text the undo replaces
   * lies in a run whose value is in one place in `base` and in `cur`, each other program's change is placed by that
   * rule (carryRange), and the place lies in that one run of `cur`, at the same offset. When the queue did not see
   * every change, one diff over the whole span places it so, only when Blueline wrote nothing since.
   */
  function undoPlace(base: Version, record: WriteRecord, cur: Version, t: number): { start: number; end: number } | null {
    const s = record.start;
    const e = record.start + record.rawAfter.length;
    if (e > base.src.length || base.src.slice(s, e) !== record.rawAfter) return null;
    const c = carryRange(base, s, e, cur);
    let at: { start: number; end: number } | null = null;
    let foreign = true;
    const made = foreignSince(base, t);
    if (c.kind === 'ok') {
      at = c;
      foreign = c.foreign || made === null || made.length > 0;
    } else if (c.kind === 'unknown' && !ownSince(base)) {
      const p = placeRange(base, s, e, cur);
      if (p.ok) at = p;
    }
    if (!at || cur.src.slice(at.start, at.end) !== record.rawAfter) return null;
    if (foreign) {
      const hb = holderOf(base, s, e);
      const hc = holderOf(cur, at.start, at.end);
      if (!hb || !hc || hb.id.slice(0, 2) !== hc.id.slice(0, 2) || hb.value !== hc.value || s - hb.start !== at.start - hc.start) return null;
      if (placesOf(base.map, hb.value) !== 1 || placesOf(cur.map, hc.value) !== 1 || !oneOnTheWay(made, hb.value)) return null;
    }
    return at;
  }

  async function doUndo(record: WriteRecord, label: 'undo' | 'redo'): Promise<UndoOutcome> {
    if (!isWriteRecord(record)) return { ok: false, why: 'not a write record', canMakeNote: false, code: 'refused' };
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let loaded: Loaded;
      try {
        loaded = await load();
      } catch (e) {
        if (e instanceof DeckBeingWritten) return { ok: false, why: e.message, canMakeNote: true, code: 'conflict' };
        return { ok: false, why: `read failed: ${message(e)}`, canMakeNote: true, code: 'internal' };
      }
      const cur = loaded.v;
      if (!cur.utf8) return { ok: false, why: 'not-utf8: the deck is not UTF-8 and is never written', canMakeNote: true, code: 'not-utf8' };
      // Case 2 is placed by position from the version the write made (E-1), when the queue still has it: the
      // write's range carried through every change since (its own later writes exactly; another program's change
      // by the uniqueness rule, F-1), or, when the queue did not see them all and Blueline wrote nothing since,
      // placed across the whole span by that rule. Anything else is case 3.
      const base = versions.get(record.versionAfter);
      // Since when another program's change counts: the time the write was made (a redo's record is swapped, so the
      // write's result is its versionBefore).
      const t = base ? undoTime(versions.get(label === 'redo' ? record.versionBefore : record.versionAfter), base) : 0;
      const place = cur.version === record.versionAfter || !base || !base.utf8 ? null : undoPlace(base, record, cur, t);
      // Case 1 with another program's change in between that put the bytes back as they were (a slide duplicated and
      // its original deleted reads the same): the text it replaces must be in one place (F-1), else case 3.
      const made = cur.version === record.versionAfter ? foreignSince(cur, t) : [];
      if (made === null || made.length > 0) {
        const h = holderOf(cur, record.start, record.start + record.rawAfter.length);
        if (!h || placesOf(cur.map, h.value) !== 1 || !oneOnTheWay(made, h.value)) return { ok: false, why: CANT_UNDO, canMakeNote: true, code: 'stale' };
      }
      const p = planUndo(cur.src, record, cur.version, { place });
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
        if (e instanceof DeckBeingWritten) return { ok: false, why: e.message, code: 'conflict' };
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
      // Recorded as a whole other version (no splice): a field still open is placed across it as across another
      // program's change. Its prefix and suffix trimmed are no meaning of it: a slide the restore removed can share
      // its heading with the templated slide that took its place (the second hardening round).
      const w = await writeBytes(loaded, snapshot, next, 'restore', null);
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
      remember(known);
      known.toldAt = ++clock;
      if (o.pin === true) pins.set(version, [...(pins.get(version) ?? []), known.toldAt]);
      return;
    }
    try {
      if (io.sha256(encodeDeck(src)) !== version) return;
    } catch {
      return;
    }
    const v = remember({ version, src, utf8: map.utf8, map });
    v.toldAt = ++clock;
    if (o.pin === true) pins.set(version, [...(pins.get(version) ?? []), v.toldAt]);
  }

  /**
   * One holder of `version` let it go (know with `pin`); the LRU may evict it once nobody holds it. Which holder is
   * not said, so the newest hold goes: the oldest one still held keeps its time (editTime).
   */
  function unpin(version: string): void {
    const n = pins.get(version);
    if (n === undefined) return;
    if (n.length <= 1) pins.delete(version);
    else pins.set(version, n.slice(0, -1));
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
