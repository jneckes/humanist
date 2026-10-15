// The mutation probe of `blueline map` (section 10, Phase 0, "Mutation probe"). For every node reported
// `exact`:
//   1. Work on a copy, never on the document: `.<name>.bl-probe.html` in the same folder, served under the
//      original's trust state. Probe writes take no history snapshots and keep no session state. The copy
//      is deleted when map finishes or is interrupted, and at the end map asserts the original's bytes are
//      unchanged (map-command.ts).
//   2. Append the sentinel ⟦bl⟧ to the node's run through the real patcher (EditorModule.createWriteQueue).
//   3. Reload the copy and go to the same slide.
//   4. The node passes only if the sentinel appears in that DOM text node, in no other node except reported
//      renders of the same run, there is no new console error, and the slide count is unchanged.
//   5. Undo through the patcher, and assert that the copy's bytes equal the original.
// Coverage counts only nodes that pass. Each run is written once and every node mapped to it is checked
// against that one write (several nodes can be renders of one run).

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DeckIO, EditorModule, WriteQueue } from '@blueline/core/capabilities';
import type { FindResult, LocateResult, NodeLocator, TrustState } from '@blueline/core/ipc';
import { buildMap } from '@blueline/core/mapper';
import { buildServedCopy } from '@blueline/core/served';
import { decodeDeck, encodeDeck, encodeLatin1 } from '@blueline/core/text';
import { atomicWriteFile, createDeckIO, readRegularFile, sha256Hex } from './atomic-write';
import type { ServedDoc } from './protocol';
import type { CountedNode, ProbeVerdict } from './report';
import type { ConsoleError, RenderView } from './render-service';

/** Section 10 Mutation probe step 2: the sentinel appended to a run. */
export const SENTINEL = '⟦bl⟧';

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
}

/**
 * The probe copy: a hidden file next to the deck, served at blueline://<docId>/<copy name> in the
 * original's partition and under its trust state. Its served copy is rebuilt from the bytes on disk on
 * every load, so each reload shows the patcher's latest write.
 */
export class ProbeCopy implements ServedDoc {
  private removed = false;

  private constructor(
    readonly docId: string,
    readonly fileName: string,
    readonly folderReal: string,
    readonly path: string,
    private readonly original: ProbeOriginal,
  ) {}

  /**
   * Creates the copy with O_EXCL and O_NOFOLLOW. A file already at that path is never overwritten: it is
   * another map run's copy, or one an interrupted run left, and the user is told to remove it.
   */
  static async create(original: ProbeOriginal, docId: string): Promise<ProbeCopy> {
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
   * refuse the rest (closeWrites).
   */
  io(): DeckIO {
    const io = createDeckIO(this.path);
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

  /** Puts the original's bytes back (only after an undo that did not restore them). */
  async restore(): Promise<void> {
    await this.track(() => atomicWriteFile(this.path, this.original.bytes));
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
}

/**
 * Section 10 Mutation probe step 4 for one node.
 *
 * "In no other node except reported renders of the same run": another node with the sentinel fails the
 * node, unless the report maps it to the same run (exact, or that run among its ambiguous candidates). A
 * node the walk never counted and that is not visible now is not a reported node of the page, and is
 * skipped: reveal.js's clipped `.aria-status` live region repeats every run of the slide (fixtures/README,
 * Open points), and text that is never visible (display: none) cannot surprise anyone. A hidden node the
 * walk did count elsewhere (another slide) is checked like any other.
 */
export function judgeNode(c: NodeCheck): ProbeVerdict {
  if (!c.reached) return { pass: false, why: 'could not go back to its slide after the reload' };
  if (c.slideCountAfter !== c.slideCountBefore) {
    return { pass: false, why: `the slide count changed from ${c.slideCountBefore} to ${c.slideCountAfter}` };
  }
  if (!c.located || !c.located.found || !c.located.node) return { pass: false, why: 'the node is not there after the reload' };
  const data = c.located.node.node.data;
  if (!data.includes(SENTINEL)) return { pass: false, why: `the sentinel is not in the node (it reads ${JSON.stringify(data.slice(0, 80))})` };
  if (c.found.truncated) return { pass: false, why: 'the sentinel appears in too many nodes' };
  const self = locatorKey(c.self);
  for (const m of c.found.matches) {
    const k = locatorKey(m.locator);
    if (k === self || c.sameRun.has(k)) continue;
    if (!m.visible && !c.reported.has(k)) continue;
    const where = m.slide === null ? '' : ` on slide ${m.slide + 1}`;
    return { pass: false, why: `the sentinel also appears in another node${where}: ${JSON.stringify(m.node.data.slice(0, 80))}` };
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
  original: { bytes: Uint8Array; version: string };
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
  log(msg: string): void;
  interrupted(): boolean;
  /**
   * Cap on waiting for animations after a reload and after each replayed stop (default 300 ms). The probe
   * reads text nodes, not pixels, so it need not wait for a slide transition to end; key replays still
   * settle fully (RenderView.pressKey).
   */
  settleMs?: number;
}

export interface ProbeRun {
  /** Runs written (one write per run). */
  runs: number;
  /** Set when the probe stopped early (the copy could not be restored, or an interrupt); remaining nodes failed. */
  aborted: string | null;
}

/** Runs the probe over every exact node, sequentially, one write per run. */
export async function runProbe(ctx: ProbeContext): Promise<ProbeRun> {
  const groups = new Map<string, CountedNode[]>();
  for (const n of ctx.nodes) {
    if (n.match.confidence !== 'exact' || !n.match.runId) continue;
    let g = groups.get(n.match.runId);
    if (!g) groups.set(n.match.runId, (g = []));
    g.push(n);
  }
  const reported = new Set(ctx.nodes.map((n) => locatorKey(n.locator)));
  const queue: WriteQueue = ctx.editor.createWriteQueue(ctx.copy.io());
  const target = { docId: ctx.copy.docId, fileName: ctx.copy.fileName };
  let runs = 0;
  let aborted: string | null = null;
  let i = 0;
  for (const [runId, group] of groups) {
    i++;
    if (aborted) {
      for (const n of group) n.probe = { pass: false, why: `not probed: ${aborted}` };
      continue;
    }
    if (ctx.interrupted()) {
      aborted = 'interrupted';
      for (const n of group) n.probe = { pass: false, why: 'not probed: interrupted' };
      continue;
    }
    ctx.log(`probe ${i}/${groups.size}: ${runId} (${group.length} node${group.length === 1 ? '' : 's'})`);
    const sameRun = new Set(
      ctx.nodes
        .filter((n) => n.match.runId === runId || (n.match.confidence === 'ambiguous' && n.match.candidates.some((c) => c.runId === runId)))
        .map((n) => locatorKey(n.locator)),
    );
    const before = group[0].node.data;
    const fail = (why: string) => {
      for (const n of group) if (!n.probe || n.probe.pass) n.probe = { pass: false, why };
    };
    let outcome;
    try {
      outcome = await queue.edit({ version: ctx.original.version, runId, beforeText: before, afterText: before + SENTINEL });
    } catch (e) {
      outcome = { ok: false as const, verbatim: { before, after: before + SENTINEL }, why: e instanceof Error ? e.message : String(e) };
    }
    runs++;
    if (outcome.ok) {
      try {
        await checkRun(ctx, target, group, sameRun, reported);
      } catch (e) {
        fail(`the probe could not check it: ${e instanceof Error ? e.message : String(e)}`);
      }
      // Step 5: undo through the patcher; the copy's bytes must equal the original.
      let undoWhy: string | null = null;
      try {
        const u = await queue.undo(outcome.record);
        if (!u.ok) undoWhy = `undo failed: ${u.why}`;
      } catch (e) {
        undoWhy = `undo failed: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (undoWhy) fail(undoWhy);
    } else {
      fail(`the patcher did not write it: ${outcome.why}`);
    }
    // Whatever happened, the copy must be the original again before the next run.
    let bytes: Uint8Array | null = null;
    try {
      bytes = await ctx.copy.read();
    } catch {
      bytes = null;
    }
    if (!bytes || !sameBytes(bytes, ctx.original.bytes)) {
      fail(outcome.ok ? "undo did not restore the copy's bytes exactly" : 'the refused write changed the copy');
      try {
        await ctx.copy.restore();
        const again = await ctx.copy.read();
        if (!sameBytes(again, ctx.original.bytes)) aborted = 'the probe copy could not be restored';
      } catch (e) {
        aborted = `the probe copy could not be restored (${e instanceof Error ? e.message : String(e)})`;
      }
    }
  }
  return { runs, aborted };
}

/** Steps 3–4 for one written run: reload the copy, show each node's stop, judge each node. */
async function checkRun(
  ctx: ProbeContext,
  target: { docId: string; fileName: string },
  group: CountedNode[],
  sameRun: ReadonlySet<string>,
  reported: ReadonlySet<string>,
): Promise<void> {
  const view = ctx.view;
  const settleMs = ctx.settleMs ?? 300;
  await view.load(target);
  await view.waitStable(settleMs);
  const slideCountAfter = (await view.detect()).count;
  await ctx.start();
  const byStop = new Map<number, CountedNode[]>();
  for (const n of group) {
    let g = byStop.get(n.stop);
    if (!g) byStop.set(n.stop, (g = []));
    g.push(n);
  }
  for (const stop of [...byStop.keys()].sort((a, b) => a - b)) {
    const reached = await ctx.replay(stop);
    await view.waitStable(settleMs);
    const found = await view.find(SENTINEL);
    const newErrors = view
      .consoleErrors()
      .map((e) => ctx.normalize(e))
      .filter((m) => !ctx.baselineErrors.has(m));
    for (const n of byStop.get(stop)!) {
      let located: LocateResult | null = null;
      try {
        located = await view.locate(n.locator);
      } catch {
        located = null;
      }
      n.probe = judgeNode({
        reached,
        slideCountBefore: ctx.slideCount,
        slideCountAfter,
        located,
        found,
        self: n.locator,
        sameRun,
        reported,
        newErrors,
      });
    }
  }
}
