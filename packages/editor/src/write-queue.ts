// FSL-1.1-ALv2 (packages/editor/LICENSE.md)
//
// The per-deck write queue: the write protocol of 9.2 for direct edits, undo, redo and whole-file restores.
//
//   1. Versions. Every map carries `version`, the sha256 of the file bytes it was built from. The queue keeps
//      the source and map of recent versions, because a client may still hold an old one; main tells it the
//      versions its pages and open fields hold (know, P2-3) and pins them for as long as they are held (know with
//      `pin`, unpin; SPEC 9.2 step 1: "Main keeps the map for each version a client still holds"): the LRU of
//      `keepVersions` never evicts a pinned version.
//   2. The log. The queue keeps, in order, what the file became: each version it read (load), each write of its own
//      (an edit, undo or redo with its splice; a restore, a whole other version), and each version main read from
//      the file itself (know with `onDisk`: at open, and every external change main takes from the watcher). A
//      version that is not the one seen last, and that the queue did not write, is another program's change.
//   3. Queue and version check. One operation at a time. Each re-reads the file and hashes it. If the hash is not
//      the client's version V, or anything happened to the file since the client began to hold V (its oldest pin),
//      the run is carried along the log from where the file was V to the current version C (carryAlong). When every
//      change in between is Blueline's own edit, undo or redo, the run moves exactly by their splices: nothing to
//      guess. Otherwise another program changed the file (or a restore lies in between), and the uniqueness rule
//      decides (lead decision F-1; place.ts): beforeText must be the value of exactly one place in V and in C
//      (shadow values count as copies, as the matcher counts them), each other program's change is placed by that
//      rule between the versions around it, with the run's value at that step (so the text was in one place on the
//      way too), the run must land exactly on that one run of C, and the text on both sides must confirm it
//      (anchors.ts). When the queue does not hold the versions around those changes (or more than FOREIGN_STEPS_MAX
//      lie in between), one diff of V to C places it the same way, only when Blueline wrote nothing in that time
//      (one diff cannot see Blueline's own writes) and the text was in at most one place in every version another
//      program made in between (a slide duplicated, then its original deleted). A carry that a step refuses is a
//      note; it is never placed again across the whole span. No path ever chooses one copy among several across
//      another program's change. Anything else is a verbatim note: `ambiguous` when the text is in more than one
//      place, `stale` when it is in one place but the mapping or the anchors fail, when no run holds it, when the
//      diff timed out, or when the queue does not know the client's version (it cannot be checked against what the
//      client saw). Stale offsets are never applied.
//   4. Re-check before writing: the run must hold beforeText exactly (planEdit), and the splice is planned on
//      the file as just read. A picked candidate (EditRequest.pick) must lift to the run exactly (P2-8).
//   5. Atomic write through DeckIO.atomicWrite, which re-hashes the file on disk against the hash read in
//      step 3 before renaming. A conflict (someone wrote in between) aborts and requeues the operation: it
//      starts again at step 3, at most `maxRetries` more times. Right before it, canWrite is checked (9.1) and
//      beforeWrite gets the exact bytes the write replaces (the history snapshot, P2-11).
//   6. Verify: the exact bytes about to be written are decoded and re-parsed, and verifyEdit checks them
//      (same run holds afterText, nothing else moved, no new parse errors, Strategy 2 checks). This runs
//      BEFORE the rename, on the very bytes that are renamed in, so a failed check never reaches the disk and
//      the previous bytes stay in place; the result is the verbatim note of 9.2 step 5 (P2-1). After the
//      rename the file is read back and its hash compared.
//   7. After the write the map of the new version (built in step 6) becomes current, and opts.afterWrite runs
//      (adopt the version, push the map, move the locked spans) before the outcome resolves.
//
// Nothing after the rename can turn a written edit into a note: the outcome and the record are computed before
// the write, hooks are caught, and an atomic write that rejects after the file landed (a step after its rename
// threw) is recognised by reading the file back. A deck that failed the UTF-8 decode is never written (9.2 rule 1).

import { Parser, type DefaultTreeAdapterMap, type Token } from 'parse5';
import { changedSpan } from '@blueline/core/edit-cleanup';
import { LOCK_DIFF_TIMEOUT_SEC } from '@blueline/core/locked-spans';
import { liftPick } from '@blueline/core/edit-commit';
import { buildMap } from '@blueline/core/mapper';
import { decodeDeck, encodeDeck } from '@blueline/core/text';
import type { DeckIO, RestoreOutcome, UndoOutcome, WriteKind, WriteQueue, WriteQueueOptions } from '@blueline/core/capabilities';
import type { DeckMap, EditRequest, HtmlRun, LiteralRun, RefusalCode, WriteOutcome, WriteRecord } from '@blueline/core/types';
import { copiesOf, NOT_PLACED, placeStale, placesOf } from './place';
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

/** Only white space and whole comments (`<!-- … -->`, `<!-->`). */
function spaceAndComments(s: string): boolean {
  let t = s.trim();
  while (t.startsWith('<!--')) {
    const close = t.indexOf('-->', 2);
    if (close < 0) return false;
    t = t.slice(close + 3).trim();
  }
  return t === '';
}

/** The text ends with `</html>`, then only white space and comments (the cheap test before the parse). */
function endsWithHtmlEnd(src: string): boolean {
  let tail = src.slice(-4096).trimEnd();
  while (tail.endsWith('-->')) {
    const open = tail.lastIndexOf('<!--', tail.length - 3);
    if (open < 0) return false;
    tail = tail.slice(0, open).trimEnd();
  }
  return /<\/html\s*>$/i.test(tail);
}

/**
 * Whether a source ends as a whole HTML document does: its last `</html>` that the HTML parser reads as an end tag,
 * then only white space and comments. A program that writes the deck in place (a shell redirect, Python's open('w'),
 * a template engine streaming its output, curl or rsync --inplace) leaves a prefix of it on disk while it pauses; that
 * prefix does not end so, even when it stops right after a `</html>` that is text inside an attribute value (an
 * iframe's `srcdoc`), a script, a comment or a `<textarea>`: the parser never reads that one as a tag.
 */
export function endsWhole(src: string): boolean {
  if (!endsWithHtmlEnd(src)) return false;
  const parser = new Parser<DefaultTreeAdapterMap>({ sourceCodeLocationInfo: true });
  let end = -1;
  const onEndTag = parser.onEndTag;
  parser.onEndTag = function (this: typeof parser, token: Token.TagToken) {
    if (token.tagName === 'html' && token.location) end = token.location.endOffset;
    onEndTag.call(this, token);
  };
  parser.tokenizer.write(src, true);
  return end >= 0 && spaceAndComments(src.slice(end));
}

/** One version of the file, as read, written or told (know) through this queue. */
interface Version {
  version: string;
  src: string;
  utf8: boolean;
  map: DeckMap;
  /** On the queue's clock: when it first met this version (editTime of a version no client pins). */
  metAt?: number;
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
 * One entry of the log: the file became `version` at `at` (on the queue's clock). `parent` is the entry before it
 * (null for the first the queue saw). `splice`: the queue's own edit, undo or redo; null for another program's
 * change, a restore (a whole other version, whose meaning is not its prefix and suffix trimmed) and the first
 * sighting. `own`: the queue wrote it (a restore too). `copies`: the texts in more than one place in `version`
 * (placesOf), for a change placed without its versions; null when unknown (not UTF-8, or not told its source).
 */
interface Seen {
  at: number;
  version: string;
  parent: string | null;
  splice: Splice | null;
  own: boolean;
  copies: Set<string> | null;
}

/** A range carried along the log (carryAlong), or why not; `unknown`: a version around a change is not held. */
type Carried = { kind: 'ok'; start: number; end: number } | { kind: 'refused'; why: string; code: RefusalCode } | { kind: 'unknown' };

/**
 * How many entries the log keeps, and how many of the changes in a carry may be placed one by one (another
 * program's changes and restores: each is placed by position as a stale edit is, so each costs a diff); past
 * that, one diff over the whole span.
 */
const LOG_KEPT = 1024;
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

const OWN_AND_FOREIGN =
  "the deck changed around the edited place, by Blueline's own writes and by another program, so its place cannot be confirmed (9.2 Write protocol step 2)";
const NOT_REMEMBERED = 'the deck changed more often than Blueline remembers since the version the edit was made on, so its place cannot be found (9.2 Write protocol step 2)';

export function createWriteQueue(io: DeckIO, opts: EditorQueueOptions = {}): WriteQueue {
  const maxRetries = Math.max(0, opts.maxRetries ?? 5);
  const keep = Math.max(2, opts.keepVersions ?? 8);
  const diffTimeoutSec = opts.diffTimeoutSec ?? LOCK_DIFF_TIMEOUT_SEC;
  /** Recent versions by hash, least recently used first. */
  const versions = new Map<string, Version>();
  /** When each holder pinned each version (know with `pin`), oldest first: such a version is never evicted (9.2 step 1). */
  const pins = new Map<string, number[]>();
  /** The version the queue last read or wrote (the in-place writer's wait compares with it). */
  let current: Version | null = null;
  let tail: Promise<unknown> = Promise.resolve();
  /**
   * What the file became, in the order the queue saw it (Seen), and the clock its times are on. Whether another
   * program changed the file since a client began to hold its version is a question of this order, not of the
   * bytes (a change that was later undone, a slide duplicated and its original deleted, leave the same bytes).
   * `logFrom`: entries at or before it were dropped.
   */
  const log: Seen[] = [];
  let logFrom = 0;
  let clock = 0;
  /**
   * The versions on both sides of the last FOREIGN_STEPS_MAX changes placed one by one (another program's, and
   * restores): the LRU keeps them (at most 2 × FOREIGN_STEPS_MAX versions beyond `keep`).
   */
  let aroundForeign: string[] = [];

  /** The per-deck serial queue (9.2 Write protocol step 2): each job starts when the previous one settles. */
  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = tail.then(job, job);
    tail = run.catch(() => undefined);
    return run;
  }

  function remember(v: Version): Version {
    // The first time the queue met a version counts (a write that returns to a version already seen).
    const was = versions.get(v.version);
    const now = ++clock;
    v.metAt = Math.min(v.metAt ?? now, was?.metAt ?? now);
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

  // ----- the log

  function push(entry: Omit<Seen, 'at'>): void {
    log.push({ ...entry, at: ++clock });
    while (log.length > LOG_KEPT) logFrom = log.shift()!.at;
    if (entry.splice === null && entry.parent !== null) {
      aroundForeign = [...aroundForeign.filter((k) => k !== entry.parent && k !== entry.version), entry.parent, entry.version].slice(-2 * FOREIGN_STEPS_MAX);
    }
  }

  /** The version the queue saw last (read, written, or told on disk by main). */
  const lastSeen = (): string | null => (log.length > 0 ? log[log.length - 1].version : null);

  /**
   * The file is `version` now (read by the queue, or by main: know with `onDisk`). Unless it is the version seen
   * last, another program changed the file (or this is the first sighting). `v`: its source and map, when known.
   */
  function sawOnDisk(version: string, v?: Version): void {
    const parent = lastSeen();
    if (parent === version) return;
    push({ version, parent, splice: null, own: false, copies: v && v.utf8 ? copiesOf(v.map) : null });
  }

  /** Blueline's own write landed: `next` made from `cur` by `splice` (null: a restore, a whole other version). */
  function sawOwn(cur: Version, next: Version, splice: Splice | null): void {
    // The atomic write checked that the file was `cur`: if main saw something else in between, it was `cur` again.
    sawOnDisk(cur.version, cur);
    push({ version: next.version, parent: cur.version, splice, own: true, copies: splice ? null : copiesOf(next.map) });
  }

  /**
   * When a client began to hold version `v`: its oldest pin main has not let go (a field held open across another
   * program's changes keeps its time even when another page shows the same bytes later). A version no client pins
   * (main pins every version a page or field holds) may have been held since the queue first met it: that time, the
   * earliest, so that nothing another program did since is missed (a later know of the same bytes says nothing of
   * this client).
   */
  function editTime(v: Version): number {
    const held = pins.get(v.version)?.[0];
    if (held !== undefined) return held;
    const first = log.find((x) => x.version === v.version);
    return Math.min(v.metAt ?? clock, first ? first.at : clock);
  }

  /**
   * Where in the log the file was `version` for a client that holds it since `t`: the last entry of it at or before
   * `t`; else, when the first entry after `t` is it and the log is whole (main told the queue the version before the
   * queue or main saw it on disk), that one. Null when the log does not say (the version was never seen on disk by
   * then, or entries were dropped).
   */
  function startOf(version: string, t: number): number | null {
    if (t < logFrom) return null;
    let j = log.length - 1;
    while (j >= 0 && log[j].at > t) j--;
    for (let k = j; k >= 0; k--) if (log[k].version === version) return k;
    return logFrom === 0 && j + 1 < log.length && log[j + 1].version === version ? j + 1 : null;
  }

  /** The last entry of the log that is exactly the write `w` (its versions and its splice), or -1. */
  function lastMade(w: WriteRecord): number {
    for (let k = log.length - 1; k >= 0; k--) {
      const x = log[k];
      if (
        x.own &&
        x.splice !== null &&
        x.parent === w.versionBefore &&
        x.version === w.versionAfter &&
        x.splice.start === w.start &&
        x.splice.removed === w.rawBefore.length &&
        x.splice.inserted === w.rawAfter.length
      ) {
        return k;
      }
    }
    return -1;
  }

  /**
   * F-1 (a) on the way, for a span placed by one diff: `text` is in at most one place in each version another program
   * (or a restore) made in it. A copy seen there is a copy, even when a later change took it away again (a slide
   * duplicated, then its original deleted, reads as the slide alone).
   */
  function onTheWay(span: Seen[], text: string): boolean {
    return span.every((x) => x.splice !== null || (x.copies !== null && !x.copies.has(text)));
  }

  /** When each version that does not end as a whole document was first read (load), by hash. */
  const cutSeen = new Map<string, number>();
  /** Whether each version ends whole (endsWhole: a parse), by hash, so each version is parsed for it once. */
  const wholeOf = new Map<string, boolean>();
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());

  function isWhole(version: string, src: () => string): boolean {
    let w = wholeOf.get(version);
    if (w === undefined) {
      w = endsWhole(src());
      wholeOf.set(version, w);
      while (wholeOf.size > 64) wholeOf.delete(wholeOf.keys().next().value!);
    }
    return w;
  }

  /** endsWhole of bytes read: the cheap test on the last bytes first (a cut multi-byte character there does not matter). */
  function bytesWhole(bytes: Uint8Array, version: string): boolean {
    if (!endsWithHtmlEnd(new TextDecoder('utf-8').decode(bytes.subarray(Math.max(0, bytes.length - 4096))))) return false;
    return isWhole(version, () => decodeDeck(bytes).src);
  }

  /**
   * Reads the file. When the last version the queue knew ended as a whole document and the file now does not, another
   * program is probably writing it in place and has paused (the second hardening round): a write renamed over it now
   * would take the prefix for its version, and the rest of that program's output would go to the replaced file and be
   * lost. So the file is read again until it ends whole, for at most writerWaitMs; past that the operation is refused
   * (`DeckBeingWritten`), unless that very version has stood on disk for acceptCutMs (a deck that lost its end for
   * good is written on again).
   */
  async function readWhole(): Promise<{ bytes: Uint8Array; version: string }> {
    let bytes = await io.read();
    let version = io.sha256(bytes);
    if (bytesWhole(bytes, version)) return { bytes, version };
    // The deck ended whole before: as the queue last read or wrote it, or (before its first read) in any version it
    // was told about. A version main took from the watcher may be the half-written one itself.
    const wasWhole = current ? current.utf8 && isWhole(current.version, () => current!.src) : [...versions.values()].some((v) => v.utf8 && isWhole(v.version, () => v.src));
    if (!wasWhole) return { bytes, version };
    const waitMs = Math.max(0, opts.writerWaitMs ?? WAIT_WRITER_MS);
    const pollMs = Math.max(1, opts.writerPollMs ?? 100);
    const deadline = now() + waitMs;
    for (;;) {
      if (bytesWhole(bytes, version)) return { bytes, version };
      if (current && version === current.version) return { bytes, version };
      const first = cutSeen.get(version) ?? now();
      cutSeen.set(version, first);
      while (cutSeen.size > 64) cutSeen.delete(cutSeen.keys().next().value!);
      if (now() - first >= Math.max(0, opts.acceptCutMs ?? ACCEPT_CUT_MS)) return { bytes, version };
      if (now() >= deadline) throw new DeckBeingWritten(BEING_WRITTEN);
      await sleep(pollMs);
      bytes = await io.read();
      version = io.sha256(bytes);
    }
  }

  /**
   * Re-reads the file and hashes it (step 3), and logs what it found. A known version's map is reused only when its
   * source is the one these bytes decode to: a version main told the queue about (know) is never trusted beyond what
   * it can check.
   */
  async function load(): Promise<Loaded> {
    const { bytes, version } = await readWhole();
    const decoded = decodeDeck(bytes);
    const known = versions.get(version);
    const v: Version =
      known && known.utf8 === decoded.utf8 && known.src === decoded.src
        ? known
        : { version, src: decoded.src, utf8: decoded.utf8, map: buildMap(decoded.src, { version, utf8: decoded.utf8 }) };
    sawOnDisk(version, v);
    current = remember(v);
    return { v, bytes };
  }

  /** The map of a UTF-8 source about to be written: the one already built for that hash, or a new parse. */
  function mapFor(version: string, src: string): DeckMap {
    const known = versions.get(version);
    // Same hash, same bytes, same source: the map is the same (a redo returns to a version already seen).
    if (known && known.utf8 && known.src === src) return known.map;
    return buildMap(src, { version, utf8: true });
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
   * [s, e) of the version at log entry `from` carried along every later entry, in order, to the current version. An
   * own edit, undo or redo moves it exactly by its splice: one before it shifts it, one inside it (Blueline's own
   * write in the range, or at an empty range: the write that made it, or a later one the final check then refuses)
   * leaves the range holding its result, one across its edge refuses. Another program's change and a restore are
   * placed between the versions around them (placeRange, the uniqueness rule F-1, with the run's value at that
   * step). `unknown`: a version around such a change is no longer held, or more than FOREIGN_STEPS_MAX lie in the
   * span.
   */
  function carryAlong(from: number, s: number, e: number, kind?: string): Carried {
    let placed = 0;
    for (let k = from + 1; k < log.length; k++) {
      const x = log[k];
      const sp = x.splice;
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
          return { kind: 'refused', why: OWN_AND_FOREIGN, code: 'stale' };
        }
        continue;
      }
      if (++placed > FOREIGN_STEPS_MAX) return { kind: 'unknown' };
      const va = x.parent === null ? undefined : versions.get(x.parent);
      const vb = versions.get(x.version);
      if (!va || !vb) return { kind: 'unknown' };
      const p = placeRange(va, s, e, vb, kind);
      if (!p.ok) return { kind: 'refused', why: p.why, code: p.code };
      s = p.start;
      e = p.end;
    }
    return { kind: 'ok', start: s, end: e };
  }

  /**
   * Step 3: which run of the current version the request means. Nothing happened to the file since the client began
   * to hold its version: the request's own run. Blueline's own writes alone: the run carried exactly by their
   * splices. Another program's change in between: the uniqueness rule (F-1, place.ts) on the client's version, the
   * current one, and every change along the way. Anything else is a verbatim note. The client's version must be known
   * (main pins every version an open page or field holds).
   */
  function resolve(cur: Version, req: EditRequest): Resolved {
    const old = req.version === cur.version ? cur : versions.get(req.version);
    // Without the client's version nothing says where its run is now: text alone never picks a copy.
    if (!old) return { ok: false, why: 'the deck changed and the version the edit was made on is not known, so its place cannot be found (9.2 Write protocol step 2)', code: 'stale' };
    const from = startOf(old.version, editTime(old));
    const span = from === null ? null : log.slice(from + 1);
    // Nothing happened since: the request's own run (step 4 checks it holds beforeText).
    if (old === cur && span !== null && span.length === 0) return { ok: true, runId: req.runId };
    const kind = req.runId.slice(0, 2);
    if (kind !== 'h:' && kind !== 'l:') return { ok: false, why: 'unknown run id', code: 'refused' };
    const oldRun = findRun(old.map, req.runId);
    // The client's own map must agree with its request, or the request is not what the client saw.
    if (!oldRun || oldRun.value !== req.beforeText) {
      return { ok: false, why: 'the request does not match the version it names', code: 'refused' };
    }
    const text = req.beforeText;
    const copies = placesOf(old.map, text) > 1 || placesOf(cur.map, text) > 1;
    // Blueline's own writes alone since the client's version: carried exactly by their splices, copies or not.
    if (span !== null && span.every((x) => x.own && x.splice !== null)) {
      const c = carryAlong(from!, oldRun.start, oldRun.end, kind);
      const hit = c.kind === 'ok' ? runAt(cur.map, kind, c.start, c.end, text) : undefined;
      if (hit) return { ok: true, runId: hit.id };
      return { ok: false, why: NOT_PLACED.moved, code: copies ? 'ambiguous' : 'stale' };
    }
    // Another program changed the file (or a restore lies in between): F-1 (a) on the two ends ...
    if (copies) return { ok: false, why: NOT_PLACED.copies, code: 'ambiguous' };
    // ... and (b) the run carried along what happened, each other program's change placed by the same rule.
    const c: Carried = from === null ? { kind: 'unknown' } : carryAlong(from, oldRun.start, oldRun.end, kind);
    if (c.kind === 'refused') return { ok: false, why: c.why, code: c.code };
    if (c.kind === 'ok') {
      const hit = runAt(cur.map, kind, c.start, c.end, text);
      return hit ? { ok: true, runId: hit.id } : { ok: false, why: NOT_PLACED.moved, code: 'stale' };
    }
    // One diff over the whole span, only when Blueline wrote nothing in it (one diff cannot see Blueline's own writes)
    // and the text was in at most one place in every version another program made in it.
    const t = editTime(old);
    const after = span ?? (t < logFrom ? null : log.filter((x) => x.at > t));
    if (after === null) return { ok: false, why: NOT_REMEMBERED, code: 'stale' };
    // The client's version is not in the log: anything Blueline wrote may lie between it and now.
    if (after.some((x) => x.own) || (from === null && (logFrom > 0 || log.some((x) => x.own)))) return { ok: false, why: OWN_AND_FOREIGN, code: 'stale' };
    if (!onTheWay(after, text)) return { ok: false, why: NOT_PLACED.copies, code: 'ambiguous' };
    return placeStale(old, oldRun, cur, text, diffTimeoutSec);
  }

  /**
   * Step 4 for a picked candidate (P2-8, Strategy 2 step 4): the request's run texts must be exactly what lifting
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

  /** The write landed: `next` is current, the log has it, and it ends whole as `cur` did when a splice made it. */
  function landed(cur: Version, next: Version, step: Splice | null): void {
    // A splice inside a text run or a literal leaves the document's end as it was; a restore is parsed when read.
    if (step && wholeOf.has(cur.version)) wholeOf.set(next.version, wholeOf.get(cur.version)!);
    sawOwn(cur, next, step);
    current = remember(next);
  }

  /**
   * Steps 5–6 of one attempt: canWrite, the snapshot, canWrite again at the moment of the write, the atomic write
   * against the hash read in step 3, and the read-back. `next` becomes current once the bytes landed.
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
      if (isConflict(e)) return { kind: 'conflict' }; // step 5.3: abort and requeue
      // A step after the rename may have thrown: then the file holds the new bytes, and the write stands.
      if ((await fileIs(next.version)) !== true) return { kind: 'refused', why: `write failed: ${message(e)}`, code: 'internal' };
      hookError(e);
      landed(cur, next, step);
      return { kind: 'written' };
    }
    landed(cur, next, step);
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

  /** Step 7: the hook, after the write landed. Its errors never undo the write. */
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
      // Step 4: planEdit re-checks that the run holds beforeText in the file as just read.
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

  /** Step 6 on the exact bytes to be written: decode, re-parse, verify. */
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
   * Where the text the write `w` put at [start, start + rawAfter) is now, carried along the log from entry `from`
   * (where the file was w.versionAfter with that text in it): null for case 3. `placed`: another program changed the
   * file since (or a restore lies in between), so the uniqueness rule holds too (F-1): the run that holds the text is
   * the one place of its value in w.versionAfter and in the current file, each other program's change is placed by
   * that rule along the way (or, when the queue does not hold the versions around them and Blueline wrote nothing
   * since, one diff places it with the text in at most one place in every version another program made), and the
   * place lies in that one run of the current file, at the same offset.
   */
  function undoPlace(w: WriteRecord, from: number, cur: Version): { at: { start: number; end: number } | null; placed: boolean } | null {
    const span = log.slice(from + 1);
    const s = w.start;
    const e = w.start + w.rawAfter.length;
    if (span.every((x) => x.splice !== null)) {
      const c = carryAlong(from, s, e);
      return { at: c.kind === 'ok' ? c : null, placed: false };
    }
    const base = versions.get(w.versionAfter);
    if (!base || !base.utf8 || e > base.src.length || base.src.slice(s, e) !== w.rawAfter) return null;
    const hb = holderOf(base, s, e);
    if (!hb || placesOf(base.map, hb.value) !== 1) return null;
    const c = carryAlong(from, s, e);
    let at: { start: number; end: number } | null = null;
    if (c.kind === 'ok') at = c;
    else if (c.kind === 'unknown' && !span.some((x) => x.own) && onTheWay(span, hb.value)) {
      const p = placeRange(base, s, e, cur);
      if (p.ok) at = p;
    }
    if (!at || cur.src.slice(at.start, at.end) !== w.rawAfter) return null;
    const hc = holderOf(cur, at.start, at.end);
    if (!hc || hb.id.slice(0, 2) !== hc.id.slice(0, 2) || hb.value !== hc.value || s - hb.start !== at.start - hc.start) return null;
    if (placesOf(cur.map, hc.value) !== 1) return null;
    return { at, placed: true };
  }

  async function doUndo(record: WriteRecord, label: 'undo' | 'redo'): Promise<UndoOutcome> {
    if (!isWriteRecord(record)) return { ok: false, why: 'not a write record', canMakeNote: false, code: 'refused' };
    const cant: UndoOutcome = { ok: false, why: CANT_UNDO, canMakeNote: true, code: 'stale' };
    // The write whose text this operation replaces: the record's write for an undo; for a redo, its undo (the record
    // swapped, 9.2).
    const w = label === 'redo' ? swapRecord(record) : record;
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
      // Where the log last had that text placed by Blueline: the write itself (or a redo of it in case 1), and for a
      // redo also the version right before the write (its undo in case 2 is carried along the log from there).
      let from = lastMade(w);
      if (label === 'redo') {
        const k = lastMade(record);
        if (k > 0 && log[k - 1].version === record.versionBefore) from = Math.max(from, k - 1);
      }
      // Not in the log (an older write, or the log dropped it): nothing says what happened since: case 3.
      if (from < 0) return cant;
      const u = undoPlace(w, from, cur);
      if (!u) return cant;
      // Case 1 by the hash only when nothing but Blueline's own writes happened since; otherwise case 2's rules.
      const p = planUndo(cur.src, w, cur.version, { place: u.at, byHash: !u.placed });
      if (!p.ok) return { ok: false, why: p.why, canMakeNote: p.canMakeNote, code: p.code };
      const newSrc = applySplice(cur.src, p.start, p.start + p.rawBefore.length, p.rawAfter);
      const bytes = encodeDeck(newSrc);
      const decoded = decodeDeck(bytes);
      if (!decoded.utf8 || decoded.src !== newSrc) return { ok: false, why: `${label}: the bytes do not decode back`, canMakeNote: true, code: 'verify' };
      const version = io.sha256(bytes);
      // Case 1 restores the exact bytes of the version before the write: the hash must say so.
      if (p.case === 1 && version !== w.versionBefore) {
        return { ok: false, why: `${label}: the result is not the version before the write`, canMakeNote: true, code: 'verify' };
      }
      const map = mapFor(version, newSrc);
      const v = verifyUndo(cur.src, newSrc, cur.map, map, p);
      if (!v.ok) return { ok: false, why: `${label}: ${v.why}`, canMakeNote: true, code: 'verify' };
      const done = makeRecord(cur.src, p, cur.version, version);
      const next: Version = { version, src: newSrc, utf8: true, map };
      const wr = await writeBytes(loaded, bytes, next, label, { start: p.start, removed: p.rawBefore.length, inserted: p.rawAfter.length });
      if (wr.kind === 'conflict') continue;
      if (wr.kind === 'refused') return { ok: false, why: wr.why, canMakeNote: true, code: wr.code };
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
      // Logged as a whole other version (no splice): a field still open is placed across it as across another
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
   * P2-3: a version a client holds, so a stale edit made on it can be placed (step 3). Its source decides where a
   * stale edit lands, so it is taken only when it hashes to `version` (one encode and hash, a few milliseconds on a
   * large deck); anything else is ignored. A deck that is not UTF-8 is never written, so it has nothing to tell.
   * `pin`: the version stays until as many unpin calls (9.2 step 1); a version already known is pinned without a
   * new hash. `onDisk`: main has just read this version from the file (at open, or an external change it took from
   * the watcher): it goes in the log, so a change the queue did not read itself still counts as another program's
   * (F-1); that holds for a version that is not UTF-8 too, and for one whose source does not hash to it.
   */
  function know(version: string, src: string, map: DeckMap, o: { pin?: boolean; onDisk?: boolean } = {}): void {
    if (typeof version !== 'string' || !SHA256.test(version)) return;
    const onDisk = o?.onDisk === true;
    const usable = typeof src === 'string' && !!map && map.version === version && map.utf8 && !(map.served && map.served.srcLength !== src.length);
    // Keep the map already built for this source (complete, or completed later by its first reader, D-9).
    const known = versions.get(version);
    let v: Version | null = null;
    if (usable && known && known.src === src && known.utf8 === map.utf8) v = known;
    else if (usable) {
      try {
        if (io.sha256(encodeDeck(src)) === version) v = { version, src, utf8: map.utf8, map };
      } catch {
        v = null;
      }
    }
    if (onDisk) sawOnDisk(version, v ?? undefined);
    if (!v) return;
    remember(v);
    if (o?.pin === true) pins.set(version, [...(pins.get(version) ?? []), ++clock]);
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
      return await doUndo(record, label);
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
