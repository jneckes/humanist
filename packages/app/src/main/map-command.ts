// `blueline map deck.html --report [--json] [--min-coverage 0.95]` (section 10, Phase 0; section 11
// Coverage baseline). Runs headless in the app (the CLI launches it under xvfb-run on Linux CI):
//   1. Load the document in an offscreen render view at 1600×900 under its own trust state (its partition,
//      protocol and session policy, as the visible view would have).
//   2. Walk the slides: reveal.js, Reveal.slide(h, v) for each; generic engine, ArrowRight until the visible
//      slide stops changing, up to 200 times; scrolling document, scrollIntoView on each block; single page,
//      one pass.
//   3. Count each visible text node once across slides (the render agent's collect applies the step 4
//      visibility rules) and map it with the shared matcher.
//   4. Mutation probe for every exact node (probe.ts), unless the deck is not UTF-8 or the build is
//      reader-only.
//   5. Report (report.ts), write the CommandResult to --bl-out, and exit with its code.
// Progress goes to stderr.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, session } from 'electron';
import type { CommandResult, DetectResult, MapArgs, WalkNode } from '@blueline/core/ipc';
import { createMatcher } from '@blueline/core/matcher';
import { readRegularFile } from './atomic-write';
import { loadDocument, newDocumentId, OpenError, type BlDocument } from './documents';
import { loadEditorDetailed } from './editor-loader';
import { DEFAULT_ALLOWLIST, pickClosedLoopbackPort } from './network-policy';
import { normalizeConsoleMessage, onInterrupt, ProbeCopy, ProbeRefused, runProbe } from './probe';
import { installDeckProtocol } from './protocol';
import { DEFAULT_VIEWPORT, RenderView, type ConsoleError, type NavKey } from './render-service';
import { buildReport, exitCodeFor, formatText, type CountedBlock, type CountedNode, type ProbeSummary, type WalkSummary } from './report';
import { installDeckSessionPolicy } from './trust-hooks';

/** Section 10 step 3: a generic engine gets at most 200 forward keys. */
export const MAX_PRESSES = 200;

function log(msg: string): void {
  console.error(`[blueline map] ${msg}`);
}

// ------------------------------------------------------------------------------------------- the walk

/** How to show one stop of the walk again after a reload (the probe's "go to the same slide"). */
export type StopNav =
  | { kind: 'start' } // as loaded (single page, a scrolling document's top, a generic deck's first slide)
  | { kind: 'goto'; index: number } // RenderCmd goto: Reveal.slide, the hash, or scrollIntoView
  | { kind: 'keys'; key: NavKey; presses: number }; // forward keys pressed from the start

export interface WalkStop {
  /** The slide that was current when the stop was collected. */
  slide: number;
  nav: StopNav;
}

/** What brings a fresh load to the walk's starting point (a generic deck that does not open on slide 0). */
type StartNav = { kind: 'none' } | { kind: 'goto'; index: number } | { kind: 'keys'; key: NavKey; presses: number };

export interface WalkResult {
  detect: DetectResult;
  stops: WalkStop[];
  nodes: { w: WalkNode; slide: number; stop: number }[];
  blocks: CountedBlock[];
  reached: boolean[];
  keys: 'input' | 'synthetic' | null;
  forwardKey: NavKey | null;
  notes: string[];
  consoleErrors: ConsoleError[];
  start: StartNav;
}

/** Walks a deck in a render view (section 10 steps 2–4) and replays its stops for the probe. */
export class DeckWalker {
  private start: StartNav = { kind: 'none' };
  private stops: WalkStop[] = [];
  private kind: DetectResult['kind'] = 'single';
  /** Forward presses since the last start() (replaying `keys` stops). */
  private pos = 0;

  constructor(
    private readonly view: RenderView,
    private readonly say: (msg: string) => void = log,
  ) {}

  private async current(): Promise<number> {
    return (await this.view.detect()).current;
  }

  /** Brings a generic deck to its first slide the way the walk did: by hash, or back keys. */
  private async toStart(det: DetectResult, notes: string[] | null): Promise<StartNav> {
    if (det.kind !== 'generic' || det.current === 0) return { kind: 'none' };
    if (det.navKind === 'hash') {
      const r = await this.view.goto(0);
      if (!r.navigated) notes?.push('the deck did not open on slide 1 and the hash could not show it');
      return { kind: 'goto', index: 0 };
    }
    let presses = 0;
    while (presses < MAX_PRESSES) {
      const p = await this.view.pressKey('ArrowLeft');
      if (!p.moved) break;
      presses++;
      if (p.to === 0) break;
    }
    if ((await this.current()) !== 0) notes?.push('the deck did not open on slide 1 and ArrowLeft could not bring it there');
    return { kind: 'keys', key: 'ArrowLeft', presses };
  }

  async walk(target: { docId: string; fileName: string }): Promise<WalkResult> {
    const view = this.view;
    await view.load(target);
    await view.waitStable();
    let det = await view.detect();
    this.kind = det.kind;
    const notes: string[] = [];
    const count = Math.max(1, det.count);
    const reached: boolean[] = new Array(count).fill(false);
    const nodes = new Map<number, { w: WalkNode; slide: number; stop: number }>();
    const blocks = new Map<number, CountedBlock>();
    const stops: WalkStop[] = [];
    let keys: WalkResult['keys'] = null;
    let forwardKey: NavKey | null = null;

    const collectAt = async (nav: StopNav): Promise<number> => {
      await view.waitStable();
      const cur = Math.min(Math.max(0, await this.current()), count - 1);
      const stop = stops.push({ slide: cur, nav }) - 1;
      reached[cur] = true;
      const res = await view.collect();
      for (const w of res.nodes) if (!nodes.has(w.key)) nodes.set(w.key, { w, slide: cur, stop });
      for (const b of res.blocks) {
        const had = blocks.get(b.key);
        if (!had) blocks.set(b.key, { key: b.key, hasInline: b.hasInline, nodeKeys: b.nodeKeys.slice() });
        else {
          had.hasInline = had.hasInline || b.hasInline;
          for (const k of b.nodeKeys) if (!had.nodeKeys.includes(k)) had.nodeKeys.push(k);
        }
      }
      this.say(`slide ${cur + 1}/${count}: ${res.nodes.length} visible text nodes`);
      return cur;
    };

    switch (det.kind) {
      case 'reveal': {
        // Section 10 step 3: Reveal.slide(h, v) for each slide.
        for (let i = 0; i < det.count; i++) {
          const r = await view.goto(i);
          if (!r.navigated) notes.push(`Reveal.slide could not show slide ${i + 1}${r.reason ? ` (${r.reason})` : ''}`);
          await collectAt({ kind: 'goto', index: i });
        }
        break;
      }
      case 'scroll': {
        // scrollIntoView on each block; the top of the page first, since content above the first block (a
        // masthead, a contents list) is never in view otherwise (fixtures/README, Open points).
        await view.scrollToTop();
        await collectAt({ kind: 'start' });
        for (let i = 0; i < det.count; i++) {
          await view.goto(i);
          await collectAt({ kind: 'goto', index: i });
        }
        break;
      }
      case 'generic': {
        this.start = await this.toStart(det, notes);
        await collectAt({ kind: 'start' });
        // ArrowRight until the visible slide stops changing, up to 200 times (section 10 step 3). The 6.7
        // defaults then try PageDown when ArrowRight does not move the deck at all.
        let key: NavKey = 'ArrowRight';
        let presses = 0;
        while (presses < MAX_PRESSES) {
          let p = await view.pressKey(key);
          if (!p.moved && presses === 0 && det.count > 1) {
            notes.push('ArrowRight did not move the deck; trying PageDown');
            key = 'PageDown';
            p = await view.pressKey(key);
          }
          keys = keys === 'synthetic' || p.via === 'synthetic' ? 'synthetic' : 'input';
          if (!p.moved) {
            if (p.from < det.count - 1) notes.push(`${key} changed nothing on slide ${p.from + 1} of ${det.count}`);
            break;
          }
          presses++;
          forwardKey = key;
          await collectAt({ kind: 'keys', key, presses });
        }
        if (presses >= MAX_PRESSES) notes.push(`stopped after ${MAX_PRESSES} keys`);
        // A hash-routed deck whose keys did not reach every slide: show the rest by hash. The hash format is
        // known only once the deck has moved, so this asks the agent again.
        if (reached.includes(false) && (await view.detect()).navKind === 'hash') {
          for (let i = 0; i < det.count; i++) {
            if (reached[i]) continue;
            const r = await view.goto(i);
            if (r.navigated) {
              notes.push(`slide ${i + 1} reached by hash`);
              await collectAt({ kind: 'goto', index: i });
            }
          }
        }
        break;
      }
      default:
        await collectAt({ kind: 'start' });
    }
    for (let i = 0; i < count; i++) if (!reached[i]) notes.push(`slide ${i + 1} was never shown`);
    // The nav kind as known after the walk: a generic deck that opens with no hash shows that it is
    // hash-routed only after its first move (9.4 step 2). A late detect can also see more slides (a deck
    // that builds them lazily); the first count stands, so the probe compares against what the walk saw.
    const last = await view.detect();
    if (last.kind === det.kind && last.navKind !== det.navKind) det = { ...det, navKind: last.navKind };
    det = { ...det, count };
    this.stops = stops;
    return {
      detect: det,
      stops,
      nodes: [...nodes.values()],
      blocks: [...blocks.values()],
      reached,
      keys,
      forwardKey,
      notes,
      consoleErrors: view.consoleErrors().slice(),
      start: this.start,
    };
  }

  /** After a fresh load: the walk's starting point (probe step 3). */
  async startReplay(): Promise<void> {
    this.pos = 0;
    const s = this.start;
    if (this.kind === 'scroll') await this.view.scrollToTop();
    if (s.kind === 'goto') await this.view.goto(s.index);
    else if (s.kind === 'keys') {
      for (let i = 0; i < s.presses; i++) {
        const p = await this.view.pressKey(s.key);
        if (!p.moved) break;
      }
    }
  }

  /** Shows stop `i` again (stops are replayed in ascending order after startReplay); true when its slide is current. */
  async replay(i: number): Promise<boolean> {
    const stop = this.stops[i];
    if (!stop) return false;
    const nav = stop.nav;
    if (nav.kind === 'start') {
      if (this.pos !== 0) return false;
      if (this.kind === 'scroll') await this.view.scrollToTop();
    } else if (nav.kind === 'goto') {
      await this.view.goto(nav.index);
    } else {
      while (this.pos < nav.presses) {
        // Every key settles before the next: a slide read mid-transition is unreliable (two slides visible).
        const p = await this.view.pressKey(nav.key);
        if (process.env.BLUELINE_DEBUG === '1') this.say(`replay press ${nav.key}: ${p.from + 1} -> ${p.to + 1} via ${p.via} delivered ${p.delivered}`);
        if (!p.moved) break;
        this.pos++;
      }
      if (this.pos !== nav.presses) {
        this.say(`replay: stop ${i} needs ${nav.presses} ${nav.key} presses, the deck moved ${this.pos} times`);
        return false;
      }
    }
    const cur = await this.current();
    if (cur !== stop.slide) this.say(`replay: stop ${i} should show slide ${stop.slide + 1}, the deck shows ${cur + 1}`);
    return cur === stop.slide;
  }
}

// ------------------------------------------------------------------------------------------- the command

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function writeResult(outFile: string, r: CommandResult): Promise<void> {
  await fs.promises.writeFile(outFile, JSON.stringify(r, null, 2) + '\n', { mode: 0o600 });
}

function writeResultSync(outFile: string, r: CommandResult): void {
  try {
    fs.writeFileSync(outFile, JSON.stringify(r, null, 2) + '\n', { mode: 0o600 });
  } catch {
    // The CLI reports a missing result itself.
  }
}

const SIGNAL_EXIT: Readonly<Record<string, number>> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

/** Runs `blueline map` headless and writes its CommandResult JSON to `outFile`. Resolves to the exit code. */
export async function runMapCommand(args: MapArgs, outFile: string): Promise<number> {
  /** Once interrupted, only the interrupt writes the result and exits: the run itself parks here. */
  const halt = (): Promise<never> => new Promise<never>(() => undefined);
  let interrupted = false;
  const fail = async (text: string, code = 2): Promise<number> => {
    if (interrupted) return halt();
    log(text);
    await writeResult(outFile, { command: 'map', exitCode: code, text: `blueline map: ${text}`, json: { error: 'failed', message: text } });
    return code;
  };

  let doc: BlDocument;
  try {
    // The document's own trust state (6.10): its internet marker decides, as for a double-click.
    doc = await loadDocument(args.deck, { protectedRequested: false });
  } catch (e) {
    return fail(e instanceof OpenError ? e.message : `could not open ${args.deck}: ${e instanceof Error ? e.message : String(e)}`);
  }
  log(`${doc.fileName}: ${doc.utf8 ? 'UTF-8' : 'not UTF-8'}, ${doc.trust()}, ${doc.map.runs.length} parsed runs, ${doc.map.literals.length} literal runs`);

  const dist = __dirname;
  const editor = loadEditorDetailed(dist);
  const ses = session.fromPartition(doc.partition);
  let blockPort: number;
  try {
    blockPort = await pickClosedLoopbackPort();
  } catch (e) {
    return fail(`no loopback port for the Protected proxy: ${e instanceof Error ? e.message : String(e)}`);
  }
  const policy = installDeckSessionPolicy(ses, {
    trust: () => doc.trust(),
    networkAllowed: () => doc.networkAllowed(),
    strict: () => false,
    allowlist: () => DEFAULT_ALLOWLIST,
    blockPort,
    sourcePath: () => doc.realpath,
  });
  try {
    await policy.ready;
  } catch (e) {
    return fail(`Protected view could not block the network, so ${doc.fileName} was not loaded (${e instanceof Error ? e.message : String(e)})`);
  }
  let copy: ProbeCopy | null = null;
  installDeckProtocol(ses, (id) => (id === doc.docId ? doc : copy && id === copy.docId ? copy : undefined));

  const view = RenderView.create({
    partition: doc.partition,
    preload: path.join(dist, 'preload-deck.cjs'),
    viewport: { ...DEFAULT_VIEWPORT },
    folderReal: doc.folderReal,
    isProtected: () => doc.trust() === 'protected',
    networkOpen: () => doc.trust() === 'trusted' || doc.networkAllowed(),
    log,
  });
  let creating: Promise<unknown> | null = null;
  /**
   * Stops the run (section 10 Mutation probe step 1: the copy is deleted when map is interrupted). In order:
   * no new probe runs or writes; a write already in flight finishes, so the atomic writer removes its own
   * temp file and no late rename brings the copy back; the copy goes; the result is written; the app exits.
   * Repeated signals change nothing: Ctrl+C reaches this process twice (from the terminal's process group,
   * and forwarded by the CLI), and the stop is bounded anyway (closeWrites waits at most 3 s).
   */
  const interrupt = (why: string, code: number): void => {
    if (interrupted) return;
    interrupted = true;
    void (async () => {
      if (creating) await creating.catch(() => undefined);
      const settled = copy ? await copy.closeWrites(3000) : true;
      const removed = copy ? copy.removeSync() : true;
      log(`${why}: stopping${copy ? (removed ? '; probe copy removed' : '; THE PROBE COPY COULD NOT BE REMOVED') : ''}${settled ? '' : ' (a write was still running)'}`);
      writeResultSync(outFile, {
        command: 'map',
        exitCode: code,
        text: `blueline map: interrupted (${why})${copy ? (removed ? '; the probe copy was removed.' : `; delete ${copy.fileName} by hand.`) : '.'}`,
        json: { error: 'interrupted', why },
      });
      view.close();
      app.exit(code);
    })();
  };
  // Signals are handled for the whole run, so one that arrives while the copy is being made is covered too.
  const unsignal = onInterrupt(
    () => copy,
    (sig) => interrupt(sig, SIGNAL_EXIT[sig] ?? 130),
  );
  const onQuit = () => {
    copy?.removeSync();
  };
  app.once('will-quit', onQuit);
  // The CLI that started this run may be killed without its signal reaching this process (it signals
  // xvfb-run, not Electron): an orphaned run stops instead of writing probe files nobody waits for.
  const ppid = process.ppid;
  const watchdog = setInterval(() => {
    if (process.ppid !== ppid) interrupt('the command that started blueline map went away', SIGNAL_EXIT.SIGHUP);
  }, 500);
  watchdog.unref();
  try {
    const walker = new DeckWalker(view);
    const t0 = Date.now();
    const walk = await walker.walk({ docId: doc.docId, fileName: doc.fileName });
    log(`walk: ${walk.nodes.length} nodes on ${walk.reached.filter(Boolean).length}/${walk.detect.count} slides in ${Date.now() - t0} ms`);

    const matcher = createMatcher(doc.map, { fileName: doc.fileName });
    const nodes: CountedNode[] = walk.nodes.map(({ w, slide, stop }) => ({
      key: w.key,
      slide,
      stop,
      locator: w.locator,
      node: w.node,
      match: matcher(w.node),
    }));
    const warnings: string[] = [];
    const exactCount = nodes.filter((n) => n.match.confidence === 'exact').length;

    const probe: ProbeSummary = { ran: false, why: null, runs: 0, originalUnchanged: null, copyRemoved: null };
    if (!doc.utf8) {
      probe.why = `${doc.fileName} is not UTF-8: every node is none (not-utf8) and the file is never written (9.2 rule 1)`;
    } else if (!editor.editor) {
      probe.why = `reader-only build: no patcher (${editor.why ?? 'editor.cjs not loaded'}), so coverage is not verified`;
    } else if (exactCount === 0) {
      probe.ran = true;
    } else {
      try {
        const made = ProbeCopy.create(doc, newDocumentId());
        creating = made;
        copy = await made;
      } catch (e) {
        probe.why = e instanceof ProbeRefused ? e.message : `the probe copy could not be made: ${e instanceof Error ? e.message : String(e)}`;
      } finally {
        creating = null;
      }
      if (copy && !interrupted) {
        const c = copy;
        const baseline = (e: ConsoleError) =>
          normalizeConsoleMessage(e.message, { docIds: [doc.docId, c.docId], rename: [[c.fileName, doc.fileName]] });
        try {
          const t1 = Date.now();
          const r = await runProbe({
            view,
            editor: editor.editor,
            copy: c,
            original: { bytes: doc.bytes, version: doc.version },
            nodes,
            slideCount: walk.detect.count,
            baselineErrors: new Set(walk.consoleErrors.map(baseline)),
            normalize: baseline,
            start: () => walker.startReplay(),
            replay: (i) => walker.replay(i),
            log,
            interrupted: () => interrupted,
          });
          probe.ran = true;
          probe.runs = r.runs;
          if (r.aborted) warnings.push(`the probe stopped early: ${r.aborted}`);
          log(`probe: ${r.runs} runs in ${Date.now() - t1} ms`);
        } finally {
          // An interrupt deletes the copy itself, after the write in flight.
          if (!interrupted) probe.copyRemoved = c.removeSync();
        }
        if (!probe.copyRemoved) warnings.push(`the probe copy ${c.fileName} could not be deleted; delete it by hand`);
      }
    }
    // Section 10 Mutation probe step 1: at the end, the original's bytes are unchanged.
    try {
      probe.originalUnchanged = sameBytes(await readRegularFile(doc.realpath), doc.bytes);
    } catch {
      probe.originalUnchanged = false;
    }
    if (probe.originalUnchanged === false) warnings.push(`${doc.fileName} changed during the run: its bytes are not the ones read at the start`);
    if (walk.consoleErrors.length > 0) {
      // The docId is random per run; a baseline must not change with it.
      const first = normalizeConsoleMessage(walk.consoleErrors[0].message, { docIds: [doc.docId], rename: [] });
      warnings.push(`the page logged ${walk.consoleErrors.length} console error${walk.consoleErrors.length === 1 ? '' : 's'} during the walk, first: ${first.slice(0, 200)}`);
    }

    const summary: WalkSummary = {
      kind: walk.detect.kind,
      navKind: walk.detect.navKind,
      count: walk.detect.count,
      titles: walk.detect.titles,
      designSize: walk.detect.designSize,
      reached: walk.reached,
      keys: walk.keys,
      forwardKey: walk.forwardKey,
      notes: walk.notes,
    };
    const json = buildReport({
      deck: doc.fileName,
      deckSha: doc.version,
      utf8: doc.utf8,
      trust: doc.trust(),
      viewport: { ...view.viewport },
      walk: summary,
      nodes,
      blocks: walk.blocks,
      probe,
      consoleErrors: walk.consoleErrors.length,
      warnings,
    });
    if (interrupted) return halt();
    const exitCode = exitCodeFor(json.report, args.minCoverage);
    const text = formatText(json, { detailed: args.report, minCoverage: args.minCoverage, exitCode });
    await writeResult(outFile, { command: 'map', exitCode, text, json });
    return exitCode;
  } catch (e) {
    return fail(`${doc.fileName} could not be mapped: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearInterval(watchdog);
    if (!interrupted) {
      if (copy && !copy.isRemoved) copy.removeSync();
      unsignal();
      app.removeListener('will-quit', onQuit);
      view.close();
      policy.dispose();
    }
  }
}
