// The mutation probe of `blueline map` (section 10, Phase 0, "Mutation probe"). For every node reported
// `exact`:
//   1. Work on a copy, never on the document: `.<name>.bl-probe.html` in the same folder, served under the
//      original's trust state. Probe writes take no history snapshots and keep no session state. The copy
//      is deleted when map finishes or is interrupted, and at the end map asserts the original's bytes are
//      unchanged (map-command.ts).
//   2. Append the sentinel ⟦bl⟧ to the node's run through the real patcher (EditorModule.createWriteQueue).
//   3. Reload the copy and go to the same slide. Every load is on a fresh origin (a new docId for the copy), so
//      no localStorage, sessionStorage or IndexedDB of an earlier load carries over, as the walk's own load
//      had none (review finding 30; PHASE0-FINDINGS F13).
//   4. The node passes only if the sentinel appears in that DOM text node, in no other node except reported
//      renders of the same run, there is no new console error, and the slide count is unchanged.
//   5. Undo through the patcher, and assert that the copy's bytes equal the original.
// Coverage counts only nodes that pass. Each run is written once and every node mapped to it is checked
// against that one write (several nodes can be renders of one run).
//
// Batches. A probe load of a large animated deck takes seconds (a reload, then replaying every key to the
// node's slide), and one load per run made `map` run for hours on real decks. So the probe first writes up
// to BATCH_SIZE runs at once, each with a sentinel of its own (⟦bl1⟧, ⟦bl2⟧…; the closing bracket keeps one
// from being a substring of another), and checks every node of the batch on one load: each node must hold
// its own run's sentinel, and each sentinel may appear in no other node except reported renders of that
// run, exactly as step 4 asks of ⟦bl⟧. Then it undoes the writes in reverse and checks the copy's bytes
// (step 5). A run passes on the batch only if all its nodes pass. Anything the batch cannot attribute to
// one run (a new console error, a changed slide count, a refused or failed write, a failed undo) and every
// run that fails on the batch is probed again on its own with ⟦bl⟧, and that result is its verdict. A wrong
// write cannot pass a batch: the run's own sentinel would be missing from its node, or present in another.
//
// The Phase 2 fuzz gate (P2-16, test/fuzz/) probes edited text with the same machinery: probeTargets takes the
// runs explicitly, each with the text its sentinel is appended to and, for an edited run, the text its nodes
// must read exactly (NodeCheck.expectData: the edit's new text plus the sentinel). Its copy holds the fuzz's
// edits, so ProbeContext.original is the version each pass must restore, not the deck's bytes. A run the
// author picked in the picker (P2-8) is judged only on where else its sentinel lands (NodeCheck.pickedRun).
// `blueline map` sets none of these, and its writes, loads and verdicts are as before.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DeckIO, EditorModule, WriteQueue } from '@blueline/core/capabilities';
import type { FindResult, LocateResult, NodeLocator, TrustState } from '@blueline/core/ipc';
import type { WriteOutcome, WriteRecord } from '@blueline/core/types';
import { buildMap } from '@blueline/core/mapper';
import { buildServedCopy } from '@blueline/core/served';
import { decodeDeck, encodeDeck, encodeLatin1 } from '@blueline/core/text';
import { atomicWriteFile, createDeckIO, readRegularFile, sha256Hex, type DeckIOOptions } from './atomic-write';
import { markDerivedFile, type DerivedSource } from './markers';
import type { ServedDoc } from './protocol';
import type { CountedNode, ProbeVerdict } from './report';
import type { ConsoleError, RenderView } from './render-service';

/** Section 10 Mutation probe step 2: the sentinel appended to a run. */
export const SENTINEL = '⟦bl⟧';

/** What every sentinel starts with: one find() on a batch load returns every node holding any of them. */
export const SENTINEL_PREFIX = '⟦bl';

/** The sentinel of the j-th run of a batch (0-based): ⟦bl1⟧, ⟦bl2⟧… Never a substring of another. */
export function batchSentinel(j: number): string {
  return `${SENTINEL_PREFIX}${j + 1}⟧`;
}

/** Runs written and checked on one probe load (1 turns batching off). */
export const BATCH_SIZE = 24;

/** `.<name>.bl-probe.html`: hidden, in the deck's folder (section 10 Mutation probe step 1). */
export function probeCopyName(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  return `.${stem}.bl-probe.html`;
}

export class ProbeRefused extends Error {
  override readonly name = 'ProbeRefused';
}

/** What the probe copy needs from the original document. */
export interface ProbeOriginal {
  folderReal: string;
  fileName: string;
  bytes: Uint8Array;
  trust(): TrustState;
  networkAllowed(): boolean;
  /** The Protected network policy applies to the served copy (no resource hints, connect-src 'none'). */
  servedProtected(): boolean;
  /**
   * The deck's realpath and the marker it opened with (BlDocument has both). When given, the copy gets the
   * deck's marker (9.9 Derived files keep the marker): a copy that an interrupted run (SIGKILL) leaves next to
   * a marked deck must not open Trusted.
   */
  realpath?: string;
  marker?: string | null;
}

export interface ProbeCopyOptions {
  /** Marks the copy as derived from the deck; default markers.markDerivedFile (a no-op on Linux). */
  mark?: (copy: string, source: DerivedSource) => Promise<void>;
}

/**
 * The probe copy: a hidden file next to the deck, served at blueline://<docId>/<copy name> in the
 * original's partition and under its trust state. Its served copy is rebuilt from the bytes on disk on
 * every load, so each reload shows the patcher's latest write. Each probe load gets a docId of its own
 * (addDocId), so each load is a fresh origin with empty storage (review finding 30).
 */
export class ProbeCopy implements ServedDoc {
  private removed = false;
  private readonly ids: string[];

  private constructor(
    readonly docId: string,
    readonly fileName: string,
    readonly folderReal: string,
    readonly path: string,
    private readonly original: ProbeOriginal,
  ) {
    this.ids = [docId];
  }

  /** Serves the copy under one more docId (a fresh origin for one probe load); returns it. */
  addDocId(id: string): string {
    if (!this.ids.includes(id)) this.ids.push(id);
    return id;
  }

  /** The copy answers blueline://<id>/ for every docId it was given, and only those. */
  servesDocId(id: string): boolean {
    return this.ids.includes(id);
  }

  private readonly views = new Map<string, ServedDoc>();

  /**
   * The copy as the protocol handler sees it under one of its docIds (the handler requires the served
   * document's docId to equal the host it was asked for), or undefined for any other id.
   */
  servedAs(id: string): ServedDoc | undefined {
    if (id === this.docId) return this;
    if (!this.servesDocId(id)) return undefined;
    let v = this.views.get(id);
    if (!v) {
      v = {
        docId: id,
        fileName: this.fileName,
        folderReal: this.folderReal,
        trust: () => this.trust(),
        networkAllowed: () => this.networkAllowed(),
        documentBody: () => this.documentBody(),
      };
      this.views.set(id, v);
    }
    return v;
  }

  /** Every docId the copy has been served under, the first one first (console messages are normalized over all). */
  get docIds(): readonly string[] {
    return this.ids;
  }

  /**
   * Creates the copy with O_EXCL and O_NOFOLLOW. A file already at that path is never overwritten: it is
   * another map run's copy, or one an interrupted run left, and the user is told to remove it.
   */
  static async create(original: ProbeOriginal, docId: string, opts: ProbeCopyOptions = {}): Promise<ProbeCopy> {
    const name = probeCopyName(original.fileName);
    const p = path.join(original.folderReal, name);
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
    let fh: fs.promises.FileHandle;
    try {
      fh = await fs.promises.open(p, flags, 0o600);
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      if (code === 'EEXIST') {
        throw new ProbeRefused(`${name} already exists next to the deck (another blueline map is running, or an interrupted run left it); delete it and run again`);
      }
      throw new ProbeRefused(`the probe copy ${name} could not be created (${e instanceof Error ? e.message : String(e)})`);
    }
    const copy = new ProbeCopy(docId, name, original.folderReal, p, original);
    // 9.9 Derived files keep the marker: the copy is marked right after it is created, while it is still
    // empty, so a run killed at any later point leaves a marked copy, never the deck's bytes without the
    // marker (review finding 30). A marker belongs to the inode, so the bytes written next keep it.
    if (original.realpath !== undefined) {
      try {
        await (opts.mark ?? ((c: string, src: DerivedSource) => markDerivedFile(c, src)))(p, {
          realpath: original.realpath,
          marker: original.marker ?? null,
          protectedView: original.trust() === 'protected',
        });
      } catch (e) {
        await fh.close().catch(() => undefined);
        copy.removeSync();
        throw new ProbeRefused(`the probe copy ${name} could not be given the deck's internet marker (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    try {
      await fh.writeFile(original.bytes);
      await fh.sync();
    } catch (e) {
      await fh.close().catch(() => undefined);
      copy.removeSync();
      throw new ProbeRefused(`the probe copy ${name} could not be written (${e instanceof Error ? e.message : String(e)})`);
    }
    await fh.close();
    return copy;
  }

  trust(): TrustState {
    return this.original.trust();
  }

  networkAllowed(): boolean {
    return this.original.networkAllowed();
  }

  read(): Promise<Uint8Array> {
    return readRegularFile(this.path);
  }

  /**
   * The patcher's DeckIO for the copy: reads and atomic writes of the copy only. No history, no session.
   * Writes are tracked, so an interrupt can let one in flight finish (it removes its own temp file) and
   * refuse the rest (closeWrites). `opts` reach the app's createDeckIO as they are (the fuzz gate lands an
   * external write inside the atomic write with `write.prepareTemp`); `blueline map` passes none.
   */
  io(opts?: DeckIOOptions): DeckIO {
    const io = createDeckIO(this.path, opts);
    return {
      realpath: io.realpath,
      read: () => io.read(),
      sha256: (b) => io.sha256(b),
      atomicWrite: (bytes, expectHash) => this.track(() => io.atomicWrite(bytes, expectHash)),
    };
  }

  private readonly inflight = new Set<Promise<unknown>>();
  private writesClosed = false;

  private track<T>(write: () => Promise<T>): Promise<T> {
    if (this.writesClosed) return Promise.reject(new Error('the probe was interrupted'));
    const p = write();
    this.inflight.add(p);
    p.finally(() => this.inflight.delete(p)).catch(() => undefined);
    return p;
  }

  /**
   * Refuses every later write and waits (at most `ms`) for the ones in flight. An atomic write that is allowed
   * to finish removes its own temp file, and no late rename can bring the copy back after it is deleted.
   * True when nothing is still in flight.
   */
  async closeWrites(ms: number): Promise<boolean> {
    this.writesClosed = true;
    if (this.inflight.size === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = await Promise.race([
      Promise.allSettled([...this.inflight]).then(() => true),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(false), ms);
      }),
    ]);
    clearTimeout(timer);
    return done;
  }

  /** The served (stamped) copy of the probe file as it is on disk now (9.1 Serving). */
  async documentBody(): Promise<{ body: Uint8Array; utf8: boolean }> {
    const bytes = await this.read();
    const d = decodeDeck(bytes);
    const map = buildMap(d.src, { version: sha256Hex(bytes), utf8: d.utf8 });
    const served = buildServedCopy(d.src, map, { protected: this.original.servedProtected() });
    return { body: d.utf8 ? encodeDeck(served) : encodeLatin1(served), utf8: d.utf8 };
  }

  /**
   * Puts the original's bytes back (only after an undo that did not restore them), or `bytes`: the version a
   * probe pass started from when the copy holds edits of its own (the fuzz gate).
   */
  async restore(bytes: Uint8Array = this.original.bytes): Promise<void> {
    await this.track(() => atomicWriteFile(this.path, bytes));
  }

  /** Deletes the copy (synchronous, so it also runs from exit and signal handlers). True when it is gone. */
  removeSync(): boolean {
    if (this.removed) return true;
    try {
      fs.unlinkSync(this.path);
    } catch (e) {
      if ((e as { code?: unknown }).code !== 'ENOENT') return false;
    }
    this.removed = true;
    return true;
  }

  get isRemoved(): boolean {
    return this.removed;
  }
}

/**
 * Section 10 Mutation probe step 1 ("map deletes the copy when it finishes or is interrupted"): calls
 * `onSignal` on SIGINT, SIGTERM and SIGHUP, which then stops the run in order (refuse new writes, let one in
 * flight finish, delete the copy, exit), and deletes the copy synchronously if the process exits first.
 * `copy()` is read at that moment, so the handlers can be installed before the copy exists. Returns a
 * function that removes the handlers.
 */
export function onInterrupt(copy: () => ProbeCopy | null, onSignal: (signal: NodeJS.Signals) => void): () => void {
  const onExit = () => {
    copy()?.removeSync();
  };
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as NodeJS.Signals[]) {
    const h = () => onSignal(sig);
    handlers.set(sig, h);
    process.on(sig, h);
  }
  process.on('exit', onExit);
  return () => {
    process.removeListener('exit', onExit);
    for (const [sig, h] of handlers) process.removeListener(sig, h);
  };
}

// ------------------------------------------------------------------------------------------- judging

/** A locator as one comparable string (stamps and CSS paths are stable across a probe write). */
export function locatorKey(l: NodeLocator): string {
  return `${l.stamp ?? ''}\u0000${l.cssPath}\u0000${l.childIndex}`;
}

export interface NodeCheck {
  /** The replay reached the node's slide after the reload. */
  reached: boolean;
  slideCountBefore: number;
  slideCountAfter: number;
  /** The node at its locator after the reload (null when locating failed). */
  located: LocateResult | null;
  /** Every node containing the sentinel after the reload. */
  found: FindResult;
  self: NodeLocator;
  /** Locator keys of reported renders of the same run (nodes the report maps to it, exact or as a candidate). */
  sameRun: ReadonlySet<string>;
  /** Locator keys of every node the report counted. */
  reported: ReadonlySet<string>;
  /** Console errors of the probe load that the walk's load did not have. */
  newErrors: readonly string[];
  /** The sentinel written to this node's run (default ⟦bl⟧; batches give each run its own). */
  sentinel?: string;
  /**
   * The fuzz gate (P2-16): the node must read exactly this, the edited run's new text plus the sentinel, so an
   * edit that renders other than as written (an entity shown literally, a lost character) fails the node.
   */
  expectData?: string;
  /**
   * The fuzz gate: the author picked this node's run in the picker (P2-8), so whether the node renders that run
   * is the author's choice, not something the probe can know. The node need not hold the sentinel; the sentinel
   * must still appear in no node other than reported renders of the run, with no new console error and the same
   * slide count.
   */
  pickedRun?: boolean;
}

/**
 * Section 10 Mutation probe step 4 for one node.
 *
 * "In no other node except reported renders of the same run": another node with the sentinel fails the
 * node, unless the report maps it to the same run (exact, or that run among its ambiguous candidates). The
 * one exception is a node the walk never counted that sits inside an absolutely or fixed positioned element
 * clipped to a zero area (the walk's skipClipped rule): reveal.js's `.aria-status` live region repeats every
 * run of the slide (PHASE0-FINDINGS F17). Any other node the report does not count fails the node, hidden or
 * not: a display:none copy, an opacity-0 fragment, text off the viewport or on a slide the walk never showed
 * is not a reported render, and an edit would change it unseen (review finding 31). So does a copy in a
 * shadow root or a frame (review finding 32).
 */
export function judgeNode(c: NodeCheck): ProbeVerdict {
  if (!c.reached) return { pass: false, why: 'could not go back to its slide after the reload' };
  if (c.slideCountAfter !== c.slideCountBefore) {
    return { pass: false, why: `the slide count changed from ${c.slideCountBefore} to ${c.slideCountAfter}` };
  }
  const sentinel = c.sentinel ?? SENTINEL;
  if (!c.pickedRun) {
    if (!c.located || !c.located.found || !c.located.node) return { pass: false, why: 'the node is not there after the reload' };
    const data = c.located.node.node.data;
    if (!data.includes(sentinel)) return { pass: false, why: `the sentinel is not in the node (it reads ${JSON.stringify(data.slice(0, 80))})` };
    if (c.expectData !== undefined && data !== c.expectData) {
      return { pass: false, why: `the node reads ${JSON.stringify(data.slice(0, 120))}, not the edited text ${JSON.stringify(c.expectData.slice(0, 120))}` };
    }
  }
  if (c.found.truncated) return { pass: false, why: 'the sentinel appears in too many nodes' };
  const self = locatorKey(c.self);
  for (const m of c.found.matches) {
    // A batch load holds other runs' sentinels too: only this run's own sentinel is this node's business.
    if (!m.node.data.includes(sentinel)) continue;
    const k = locatorKey(m.locator);
    if (k === self || c.sameRun.has(k)) continue;
    const reported = c.reported.has(k);
    if (!reported && m.clipped === true) continue;
    const where = m.slide === null ? '' : ` on slide ${m.slide + 1}`;
    const tree = m.tree === 'shadow' ? ' in a shadow root' : m.tree === 'frame' ? ' in a frame' : '';
    const text = JSON.stringify(m.node.data.slice(0, 80));
    if (reported) return { pass: false, why: `the sentinel also appears in another node${tree}${where}: ${text}` };
    const hidden = m.visible ? '' : ' (hidden now)';
    return { pass: false, why: `the sentinel also appears in a node the report does not count${tree}${where}${hidden}; an edit would change it unseen: ${text}` };
  }
  if (c.newErrors.length > 0) return { pass: false, why: `new console error: ${c.newErrors[0].slice(0, 200)}` };
  return { pass: true };
}

/**
 * A console message with the parts that differ between the original's load and the probe copy's removed:
 * the docId hosts and the copy's file name, so the same error compares equal across the two.
 */
export function normalizeConsoleMessage(msg: string, opts: { docIds: readonly string[]; rename: readonly [string, string][] }): string {
  let s = msg;
  for (const id of opts.docIds) {
    if (!/^[0-9a-f]{8,64}$/.test(id)) continue;
    s = s.split(`${id}-files`).join('DOC-files').split(id).join('DOC');
  }
  for (const [from, to] of opts.rename) {
    if (!from) continue;
    s = s.split(encodeURIComponent(from)).join(to).split(from).join(to);
  }
  return s;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ------------------------------------------------------------------------------------------- running

export interface ProbeContext {
  view: RenderView;
  editor: EditorModule;
  copy: ProbeCopy;
  /**
   * The bytes and version the copy holds when the probe starts; every pass writes on this version and must leave
   * the copy byte-identical to it (step 5). For `blueline map` the deck's own bytes; for the fuzz gate, the
   * version its edits produced.
   */
  original: { bytes: Uint8Array; version: string };
  /**
   * The write queue of the copy. Default: a bare queue made here (no hooks, so no snapshots and no session, step
   * 1). The fuzz gate passes the queue its edits went through.
   */
  queue?: WriteQueue;
  /** Every node the report counted; verdicts are written onto the exact ones. */
  nodes: CountedNode[];
  /** The walk's slide count (step 4: unchanged). */
  slideCount: number;
  /** Normalized console errors of the walk's load. */
  baselineErrors: ReadonlySet<string>;
  normalize(e: ConsoleError): string;
  /** After a fresh load of the copy: bring the deck to the walk's starting point. */
  start(): Promise<void>;
  /** Shows a stop of the walk (stops are replayed in ascending order after start()); true when it reached the stop's slide. */
  replay(stop: number): Promise<boolean>;
  /**
   * A new docId for each load of the copy (a fresh origin: review finding 30). Without it every load uses the
   * copy's first docId.
   */
  newDocId?(): string;
  log(msg: string): void;
  interrupted(): boolean;
  /**
   * Cap on waiting for animations after a reload and after each replayed stop (default 300 ms). The probe
   * reads text nodes, not pixels, so it need not wait for a slide transition to end; key replays still
   * settle fully (RenderView.pressKey).
   */
  settleMs?: number;
  /** Runs written and checked per load (default BATCH_SIZE; 1 probes each run on its own). */
  batchSize?: number;
}

export interface ProbeRun {
  /** Writes made (one per run on its batch, plus one per run probed again on its own). */
  runs: number;
  /** Set when the probe stopped early (the copy could not be restored, or an interrupt); remaining nodes failed. */
  aborted: string | null;
  /** Probe loads (batches plus single runs), for the report's timing line. */
  loads?: number;
}

/**
 * One run to probe (probeTargets): the sentinel is appended to `before`, and every node of `nodes` is judged.
 * runProbe makes one per run of the exact nodes; the fuzz gate makes one per edited run.
 */
export interface ProbeTarget {
  runId: string;
  /** The nodes that render the run; each gets a verdict (CountedNode.probe). Never empty. */
  nodes: CountedNode[];
  /** The run's whole text now, to which the sentinel is appended. Default: the first node's data (an exact node's text is its run's). */
  before?: string;
  /** Each node must read exactly `expect` plus the sentinel (NodeCheck.expectData). */
  expect?: string;
  /** The author picked the run for `nodes` in the picker (NodeCheck.pickedRun). */
  picked?: boolean;
}

interface RunGroup {
  runId: string;
  group: CountedNode[];
  /** Locator keys of every reported render of this run (exact, or this run among ambiguous candidates). */
  sameRun: ReadonlySet<string>;
  /** Earliest walk stop that shows one of its nodes: batches follow the walk's order. */
  firstStop: number;
  before?: string;
  expect?: string;
  picked?: boolean;
}

type PassItem = { run: RunGroup; sentinel: string };
/** Per run: its nodes' verdicts are final (`done`), or the batch could not decide it (`retry`). */
type PassOutcome = Map<string, 'done' | 'retry'>;

/** Runs the probe over every exact node: batches first, then each undecided run on its own. */
export async function runProbe(ctx: ProbeContext): Promise<ProbeRun> {
  const groups = new Map<string, CountedNode[]>();
  for (const n of ctx.nodes) {
    if (n.match.confidence !== 'exact' || !n.match.runId) continue;
    let g = groups.get(n.match.runId);
    if (!g) groups.set(n.match.runId, (g = []));
    g.push(n);
  }
  return probeTargets(
    ctx,
    [...groups].map(([runId, nodes]) => ({ runId, nodes })),
  );
}

/**
 * Probes the given runs (each run once, every node of it judged): batches of up to ctx.batchSize first, in the
 * walk's order, then each run the batch could not decide on its own. Every pass leaves the copy byte-identical to
 * ctx.original.
 */
export async function probeTargets(ctx: ProbeContext, targets: readonly ProbeTarget[]): Promise<ProbeRun> {
  const reported = new Set(ctx.nodes.map((n) => locatorKey(n.locator)));
  const runsList: RunGroup[] = targets
    .filter((t) => t.nodes.length > 0)
    .map((t) => ({
      runId: t.runId,
      group: t.nodes,
      sameRun: new Set(
        ctx.nodes
          .filter((n) => n.match.runId === t.runId || (n.match.confidence === 'ambiguous' && n.match.candidates.some((c) => c.runId === t.runId)))
          .map((n) => locatorKey(n.locator)),
      ),
      firstStop: Math.min(...t.nodes.map((n) => n.stop)),
      ...(t.before !== undefined ? { before: t.before } : {}),
      ...(t.expect !== undefined ? { expect: t.expect } : {}),
      ...(t.picked ? { picked: true } : {}),
    }));
  runsList.sort((a, b) => a.firstStop - b.firstStop);
  const queue: WriteQueue = ctx.queue ?? ctx.editor.createWriteQueue(ctx.copy.io());
  // Every load on its own origin: storage a deck wrote on an earlier probe load (the slide it was on, a "seen"
  // flag) never changes where or how the next load opens (review finding 30).
  const target = () => ({ docId: ctx.newDocId ? ctx.copy.addDocId(ctx.newDocId()) : ctx.copy.docId, fileName: ctx.copy.fileName });
  const state = { runs: 0, loads: 0, aborted: null as string | null };
  const size = Math.max(1, ctx.batchSize ?? BATCH_SIZE);

  const single: RunGroup[] = [];
  if (size === 1) single.push(...runsList);
  else {
    for (let at = 0; at < runsList.length; at += size) {
      const batch = runsList.slice(at, at + size);
      if (state.aborted || ctx.interrupted()) {
        single.push(...batch);
        continue;
      }
      ctx.log(`probe batch ${at / size + 1}/${Math.ceil(runsList.length / size)}: ${batch.length} run${batch.length === 1 ? '' : 's'}`);
      const out = await probePass(ctx, queue, batch.map((run, j) => ({ run, sentinel: batchSentinel(j) })), reported, target, state, true);
      for (const run of batch) if (out.get(run.runId) !== 'done') single.push(run);
    }
    if (single.length > 0) ctx.log(`probe: ${single.length} run${single.length === 1 ? '' : 's'} again on their own`);
  }
  single.sort((a, b) => a.firstStop - b.firstStop);
  let i = 0;
  for (const run of single) {
    i++;
    if (state.aborted) {
      for (const n of run.group) n.probe = { pass: false, why: `not probed: ${state.aborted}` };
      continue;
    }
    if (ctx.interrupted()) {
      state.aborted = 'interrupted';
      for (const n of run.group) n.probe = { pass: false, why: 'not probed: interrupted' };
      continue;
    }
    ctx.log(`probe ${i}/${single.length}: ${run.runId} (${run.group.length} node${run.group.length === 1 ? '' : 's'})`);
    await probePass(ctx, queue, [{ run, sentinel: SENTINEL }], reported, target, state, false);
  }
  return { runs: state.runs, aborted: state.aborted, loads: state.loads };
}

/**
 * Steps 2–5 for one load: write every item's sentinel, reload, show each node's stop, judge each node, undo
 * every write in reverse and check the copy's bytes. In a batch (`tentative`), only a run whose nodes all
 * pass is decided here; everything else is left for a probe of its own. On its own, every verdict is final.
 */
async function probePass(
  ctx: ProbeContext,
  queue: WriteQueue,
  items: PassItem[],
  reported: ReadonlySet<string>,
  target: () => { docId: string; fileName: string },
  state: { runs: number; loads: number; aborted: string | null },
  tentative: boolean,
): Promise<PassOutcome> {
  const out: PassOutcome = new Map(items.map((it) => [it.run.runId, 'retry']));
  const finalFail = (run: RunGroup, why: string) => {
    for (const n of run.group) if (!n.probe || n.probe.pass) n.probe = { pass: false, why };
    out.set(run.runId, 'done');
  };
  // Step 2, for each item. Each write names the version the previous one produced, so the queue never takes
  // the stale-version path between two writes of the same pass.
  const records: WriteRecord[] = [];
  const written: PassItem[] = [];
  let version = ctx.original.version;
  let writeTrouble = false;
  for (const it of items) {
    const before = it.run.before ?? it.run.group[0].node.data;
    let outcome: WriteOutcome;
    try {
      outcome = await queue.edit({ version, runId: it.run.runId, beforeText: before, afterText: before + it.sentinel });
    } catch (e) {
      outcome = { ok: false, verbatim: { before, after: before + it.sentinel }, why: e instanceof Error ? e.message : String(e), code: 'internal' };
    }
    if (outcome.ok) {
      state.runs++;
      records.push(outcome.record);
      written.push(it);
      version = outcome.version;
    } else if (tentative) {
      writeTrouble = true; // decided on its own: an earlier write of the batch may be the cause
    } else {
      state.runs++;
      finalFail(it.run, `the patcher did not write it: ${outcome.why}`);
    }
  }
  // Steps 3–4.
  let inconclusive = false;
  if (written.length > 0) {
    try {
      const verdicts = await checkPass(ctx, target(), written, reported);
      state.loads++;
      // A batch cannot tell which run caused a new console error or a changed slide count.
      if (tentative && (verdicts.newErrors || verdicts.slideCountChanged)) inconclusive = true;
      for (const it of written) {
        const v = verdicts.byRun.get(it.run.runId)!;
        const allPass = it.run.group.every((n) => v.get(n)?.pass === true);
        if (!tentative || (allPass && !inconclusive)) {
          for (const n of it.run.group) n.probe = v.get(n) ?? { pass: false, why: 'the probe could not check it' };
          out.set(it.run.runId, 'done');
        }
      }
    } catch (e) {
      if (tentative) inconclusive = true;
      else for (const it of written) finalFail(it.run, `the probe could not check it: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Step 5: undo through the patcher, newest first; the copy's bytes must equal the original.
  let undoWhy: string | null = null;
  for (let k = records.length - 1; k >= 0; k--) {
    try {
      const u = await queue.undo(records[k]);
      if (!u.ok) undoWhy = undoWhy ?? `undo failed: ${u.why}`;
    } catch (e) {
      undoWhy = undoWhy ?? `undo failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  let bytes: Uint8Array | null = null;
  try {
    bytes = await ctx.copy.read();
  } catch {
    bytes = null;
  }
  const restored = !!bytes && sameBytes(bytes, ctx.original.bytes);
  if (undoWhy || !restored) {
    const why = undoWhy ?? (written.length > 0 ? "undo did not restore the copy's bytes exactly" : 'the refused write changed the copy');
    if (tentative) for (const it of items) out.set(it.run.runId, 'retry');
    else for (const it of items) finalFail(it.run, why);
    if (!restored) {
      try {
        await ctx.copy.restore(ctx.original.bytes);
        const again = await ctx.copy.read();
        if (!sameBytes(again, ctx.original.bytes)) state.aborted = 'the probe copy could not be restored';
      } catch (e) {
        state.aborted = `the probe copy could not be restored (${e instanceof Error ? e.message : String(e)})`;
      }
    }
  }
  if (tentative && (inconclusive || writeTrouble)) {
    // Keep the passes the batch did decide only when nothing about the load is in doubt.
    if (inconclusive) for (const it of items) out.set(it.run.runId, 'retry');
  }
  for (const it of items) if (out.get(it.run.runId) === 'retry') for (const n of it.run.group) n.probe = undefined;
  return out;
}

/** Steps 3–4 for one load: reload the copy, show each node's stop, judge each node against its own sentinel. */
async function checkPass(
  ctx: ProbeContext,
  target: { docId: string; fileName: string },
  items: PassItem[],
  reported: ReadonlySet<string>,
): Promise<{ byRun: Map<string, Map<CountedNode, ProbeVerdict>>; newErrors: boolean; slideCountChanged: boolean }> {
  const view = ctx.view;
  const settleMs = ctx.settleMs ?? 300;
  await view.load(target);
  await view.waitStable(settleMs);
  const slideCountAfter = (await view.detect()).count;
  await ctx.start();
  const byStop = new Map<number, { node: CountedNode; item: PassItem }[]>();
  for (const it of items) {
    for (const n of it.run.group) {
      let g = byStop.get(n.stop);
      if (!g) byStop.set(n.stop, (g = []));
      g.push({ node: n, item: it });
    }
  }
  const byRun = new Map<string, Map<CountedNode, ProbeVerdict>>(items.map((it) => [it.run.runId, new Map()]));
  let anyNewErrors = false;
  const needle = items.length === 1 ? items[0].sentinel : SENTINEL_PREFIX;
  for (const stop of [...byStop.keys()].sort((a, b) => a - b)) {
    const reached = await ctx.replay(stop);
    await view.waitStable(settleMs);
    const found = await view.find(needle);
    const newErrors = view
      .consoleErrors()
      .map((e) => ctx.normalize(e))
      .filter((m) => !ctx.baselineErrors.has(m));
    if (newErrors.length > 0) anyNewErrors = true;
    for (const { node: n, item } of byStop.get(stop)!) {
      let located: LocateResult | null = null;
      try {
        located = await view.locate(n.locator);
      } catch {
        located = null;
      }
      byRun.get(item.run.runId)!.set(
        n,
        judgeNode({
          reached,
          slideCountBefore: ctx.slideCount,
          slideCountAfter,
          located,
          found,
          self: n.locator,
          sameRun: item.run.sameRun,
          reported,
          newErrors,
          sentinel: item.sentinel,
          ...(item.run.expect !== undefined ? { expectData: item.run.expect + item.sentinel } : {}),
          ...(item.run.picked ? { pickedRun: true } : {}),
        }),
      );
    }
  }
  return { byRun, newErrors: anyNewErrors, slideCountChanged: slideCountAfter !== ctx.slideCount };
}
