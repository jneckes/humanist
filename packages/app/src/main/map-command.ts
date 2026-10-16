// `blueline map deck.html --report [--json] [--min-coverage 0.95]` (section 10, Phase 0; section 11
// Coverage baseline). Runs headless in the app (the CLI launches it under xvfb-run on Linux CI):
//   1. Load the document in an offscreen render view at 1600×900 under its own trust state (its partition,
//      protocol and session policy, as the visible view would have).
//   2. Walk the slides: reveal.js, Reveal.slide(h, v) for each; generic engine, ArrowRight until the visible
//      slide stops changing, up to 200 times; scrolling document, scrollIntoView on each block; single page,
//      one pass. Scrolling and single-page documents are also stepped through in viewport heights until
//      their bottom has been in view, so text below the first viewport of a block or page is counted
//      (decision D-j, review finding 34).
//   3. Count each visible text node once across slides (the render agent's collect applies the step 4
//      visibility rules, in the document, its open shadow roots and its same-origin frames) and map it with
//      the shared matcher; shadow-root and frame text is `none` (`subdocument`, section 7).
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
import { buildReport, exitCodeFor, formatText, SUBDOCUMENT_MATCH, type CountedBlock, type CountedNode, type ProbeSummary, type WalkSummary } from './report';
import { installDeckSessionPolicy } from './trust-hooks';

/** Section 10 step 3: a generic engine gets at most 200 forward keys. */
export const MAX_PRESSES = 200;
/** Viewport-height steps through one scrolling or single-page document (a document 900 viewports tall). */
export const MAX_SCROLL_STEPS = 900;
/**
 * Waits before pressing a key again that changed nothing on a slide that is not the last. Decks with build
 * animations take the first press to finish the build in progress, and ignore keys during a transition
 * (Josh's real decks: `next()` returns while busy, and fast-forwards a build that has more than 0.6 s left).
 * 6.7 says a key that changes nothing stops the walk; read literally, those decks stop on slide 2. The walk
 * and the probe's replay press with the same patience, so a replay reaches the stop the walk recorded.
 */
export const PRESS_RETRY_GAPS_MS: readonly number[] = [700, 1400, 2500];

function log(msg: string): void {
  console.error(`[blueline map] ${msg}`);
}

// ------------------------------------------------------------------------------------------- the walk

/** How to show one stop of the walk again after a reload (the probe's "go to the same slide"). */
export type StopNav =
  | { kind: 'start' } // as loaded (a generic deck's first slide)
  | { kind: 'goto'; index: number } // RenderCmd goto: Reveal.slide, the hash, or scrollIntoView
  // forward keys from the start: `presses` moved the deck, then `still` more changed the slide but showed a build step
  | { kind: 'keys'; key: NavKey; presses: number; still?: number }
  | { kind: 'scroll'; y: number }; // RenderCmd scroll-to: a scrolling or single-page document at this offset

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
  /** Visible frames whose document the page cannot read, seen anywhere in the walk (review finding 32). */
  crossOriginFrames: number;
}

/** True when the intervals [a, b) of `list` together cover [from, to). */
export function covers(list: readonly [number, number][], from: number, to: number): boolean {
  let at = from;
  for (const [a, b] of [...list].sort((x, y) => x[0] - y[0])) {
    if (a > at) break;
    if (b > at) at = b;
    if (at >= to) return true;
  }
  return at >= to;
}

/** Walks a deck in a render view (section 10 steps 2–4) and replays its stops for the probe. */
export class DeckWalker {
  private start: StartNav = { kind: 'none' };
  private stops: WalkStop[] = [];
  private kind: DetectResult['kind'] = 'single';
  /** Forward presses since the last start() (replaying `keys` stops). */
  private pos = 0;
  /** The walk's slide count: a press on the last slide changed nothing because the deck has ended. */
  private count = 1;
  /** Presses since the last move that did not move the deck (replaying `keys` stops with `still`). */
  private still = 0;
  /** For each move of the walk, how many presses before it changed nothing (key-gated build steps). */
  private stillBeforeMove: number[] = [];

  constructor(
    private readonly view: RenderView,
    private readonly say: (msg: string) => void = log,
  ) {}

  private async current(): Promise<number> {
    return (await this.view.detect()).current;
  }

  /**
   * Presses `key` until the deck moves. When trusted input reached the deck but the slide did not change,
   * `onStill` (the walk) collects what the press may have revealed (a key-gated build step) and says whether
   * it found new text; then, unless the deck has ended, this waits (PRESS_RETRY_GAPS_MS) and presses again.
   * A press that revealed new text does not use up a retry, so a slide with many build steps is walked
   * through. `budget` caps the presses that change nothing (the replay knows how many the walk needed).
   */
  private async pressPatiently(
    key: NavKey,
    opts: { onStill?: () => Promise<boolean>; budget?: number } = {},
  ): Promise<Awaited<ReturnType<RenderView['pressKey']>>> {
    let p = await this.view.pressKey(key);
    let misses = 0;
    let stills = 0;
    while (!p.moved && p.via === 'input' && p.delivered !== false) {
      stills++;
      const revealed = opts.onStill ? await opts.onStill() : false;
      if (!revealed) misses++;
      if (opts.budget !== undefined ? stills >= opts.budget : misses > PRESS_RETRY_GAPS_MS.length) break;
      // The last slide: a press that showed nothing new means the deck has ended.
      if (p.from >= this.count - 1 && !revealed && opts.budget === undefined) break;
      if (stills > MAX_PRESSES) break;
      await new Promise((r) => setTimeout(r, PRESS_RETRY_GAPS_MS[Math.min(Math.max(misses - 1, 0), PRESS_RETRY_GAPS_MS.length - 1)]));
      p = await this.view.pressKey(key);
    }
    return p;
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
    this.count = count;
    const reached: boolean[] = new Array(count).fill(false);
    const nodes = new Map<number, { w: WalkNode; slide: number; stop: number }>();
    const blocks = new Map<number, CountedBlock>();
    const stops: WalkStop[] = [];
    const opaqueFrames = new Set<number>();
    let keys: WalkResult['keys'] = null;
    let forwardKey: NavKey | null = null;
    const scrolling = det.kind === 'scroll' || det.kind === 'single';
    /** Document offsets [top, bottom) that a collect has seen (scrolling and single-page documents). */
    const seen: [number, number][] = [];
    let innerH = view.viewport.h;
    /** The scrolling document's blocks as last measured (document offsets). */
    let blockBoxes: { top: number; height: number }[] = [];

    /**
     * A scrolling document's block is reached when its box meets the viewport at a stop (review finding 35);
     * a block with no height counts once the viewport holds its position (it shows nothing of its own).
     */
    const markBlocksInView = async (scrollY: number): Promise<void> => {
      blockBoxes = (await view.scrollBlocks()).blocks.map((b) => ({ top: b.top, height: b.height }));
      blockBoxes.forEach((b, i) => {
        if (i >= count) return;
        const meets = b.height > 0 ? b.top < scrollY + innerH && b.top + b.height > scrollY : b.top >= scrollY && b.top <= scrollY + innerH;
        if (meets) reached[i] = true;
      });
    };

    /** `slide|locator|text` of every counted node: a press that changed nothing reveals only text not in here. */
    const seenText = new Set<string>();
    const textKey = (slide: number, w: WalkNode): string => `${slide}\u0000${w.locator.stamp ?? ''}\u0000${w.locator.cssPath}\u0000${w.locator.childIndex}\u0000${w.node.data}`;
    /**
     * `onlyNew` (a press that changed nothing): count only nodes whose text is new at its place on this slide.
     * A deck that re-renders its counter on every key makes a new text node with the same text each time;
     * that is not a build step, and counting it would count the counter once per press.
     */
    const collectAt = async (nav: StopNav, onlyNew = false): Promise<number> => {
      await view.waitStable();
      const cur = Math.min(Math.max(0, await this.current()), count - 1);
      const stop = stops.push({ slide: cur, nav }) - 1;
      if (scrolling) {
        const scrollY = (await view.current()).scrollY;
        seen.push([scrollY, scrollY + innerH]);
        if (det.kind === 'scroll') await markBlocksInView(scrollY);
        else reached[cur] = true;
      } else reached[cur] = true;
      const res = await view.collect();
      for (const w of res.nodes) {
        if (nodes.has(w.key)) continue;
        // The slide or block that contains the node (review finding 35), else the one current now.
        const own = typeof w.slide === 'number' ? Math.min(w.slide, count - 1) : cur;
        const tk = textKey(own, w);
        if (onlyNew && seenText.has(tk)) continue;
        seenText.add(tk);
        nodes.set(w.key, { w, slide: own, stop });
      }
      for (const b of res.blocks) {
        const had = blocks.get(b.key);
        if (!had) blocks.set(b.key, { key: b.key, hasInline: b.hasInline, nodeKeys: b.nodeKeys.slice() });
        else {
          had.hasInline = had.hasInline || b.hasInline;
          for (const k of b.nodeKeys) if (!had.nodeKeys.includes(k)) had.nodeKeys.push(k);
        }
      }
      for (const k of res.crossOriginFrames ?? []) opaqueFrames.add(k);
      this.say(`slide ${cur + 1}/${count}: ${res.nodes.length} visible text nodes`);
      return cur;
    };

    /**
     * Steps down a scrolling or single-page document from `from`, one viewport height at a time, collecting at
     * every offset no earlier collect has seen, until `to` (or the document's bottom) has been in view
     * (decision D-j, review finding 34). Each stop records its offset, so the probe replays it exactly.
     */
    let steps = 0;
    const scrollThrough = async (from: number, to: number): Promise<void> => {
      let y = Math.max(0, from);
      let last = -1;
      while (steps < MAX_SCROLL_STEPS) {
        if (covers(seen, y, y + innerH)) {
          if (y + innerH >= to) return;
          y += innerH;
          continue;
        }
        steps++;
        const r = await view.scrollTo(y);
        innerH = r.innerHeight > 0 ? r.innerHeight : innerH;
        // The page did not move (it scrolls inside a container, or has ended above `y`): nothing more to show.
        if (r.scrollY <= last) return;
        last = r.scrollY;
        if (!covers(seen, r.scrollY, r.scrollY + innerH)) await collectAt({ kind: 'scroll', y: r.scrollY });
        const end = Math.min(to, r.scrollHeight);
        if (r.scrollY + innerH >= end - 1) return;
        y = r.scrollY + innerH;
      }
      if (steps >= MAX_SCROLL_STEPS) notes.push(`stopped after ${MAX_SCROLL_STEPS} viewport heights`);
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
        // The top of the page first, since content above the first block (a masthead, a contents list) is never
        // in view otherwise (fixtures/README, Open points). Then scrollIntoView on each block (section 10 step 3)
        // and on down through the block until its bottom has been in view; then whatever no stop has shown yet
        // (a tall masthead, text between blocks, a footer).
        const top = await view.scrollTo(0);
        innerH = top.innerHeight > 0 ? top.innerHeight : innerH;
        await collectAt({ kind: 'scroll', y: top.scrollY });
        for (let i = 0; i < det.count; i++) {
          await view.goto(i);
          await collectAt({ kind: 'goto', index: i });
          const b = blockBoxes[i];
          const at = (await view.current()).scrollY;
          if (b && b.height > 0) await scrollThrough(at + innerH, b.top + b.height);
        }
        await scrollThrough(0, Number.MAX_SAFE_INTEGER);
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
          // A press that changes nothing may show a build step on this slide: collect, as a stop of its own.
          let stillHere = 0;
          const onStill = async (): Promise<boolean> => {
            stillHere++;
            const had = nodes.size;
            await collectAt({ kind: 'keys', key, presses, still: stillHere }, true);
            return nodes.size > had;
          };
          let p = await this.pressPatiently(key, { onStill });
          if (!p.moved && presses === 0 && det.count > 1) {
            notes.push('ArrowRight did not move the deck; trying PageDown');
            key = 'PageDown';
            stillHere = 0;
            p = await this.pressPatiently(key, { onStill });
          }
          if (p.moved) this.stillBeforeMove[presses] = stillHere;
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
      default: {
        // Single page: one pass down the whole page, a viewport height at a time.
        const top = await view.scrollTo(0);
        innerH = top.innerHeight > 0 ? top.innerHeight : innerH;
        await collectAt({ kind: 'scroll', y: top.scrollY });
        await scrollThrough(0, Number.MAX_SAFE_INTEGER);
      }
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
      crossOriginFrames: opaqueFrames.size,
    };
  }

  /**
   * After a fresh load: the walk's starting point (probe step 3). A generic deck is brought to slide 1
   * explicitly on every load, by hash or by back keys, whatever the walk's own load did: a deck that restores
   * the slide it was on (or behaves differently on a later visit) may open elsewhere (review finding 30).
   */
  async startReplay(): Promise<void> {
    this.pos = 0;
    this.still = 0;
    if (this.kind === 'scroll' || this.kind === 'single') await this.view.scrollToTop();
    else if (this.kind === 'generic') await this.toStart(await this.view.detect(), null);
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
    } else if (nav.kind === 'scroll') {
      // The same offset is the same stop: which block counts as current there can change with a line the
      // sentinel wrapped, so it is not compared.
      const r = await this.view.scrollTo(nav.y);
      if (Math.abs(r.scrollY - nav.y) > 1) {
        this.say(`replay: stop ${i} needs the document at ${nav.y} px, it is at ${r.scrollY}`);
        return false;
      }
      return true;
    } else {
      while (this.pos < nav.presses) {
        // Every key settles before the next: a slide read mid-transition is unreliable (two slides visible).
        // The walk's own count of presses that changed nothing before this move, plus the usual retries.
        const budget = Math.max(0, (this.stillBeforeMove[this.pos] ?? 0) - this.still) + PRESS_RETRY_GAPS_MS.length;
        const p = await this.pressPatiently(nav.key, { budget });
        if (process.env.BLUELINE_DEBUG === '1') this.say(`replay press ${nav.key}: ${p.from + 1} -> ${p.to + 1} via ${p.via} delivered ${p.delivered}`);
        if (!p.moved) break;
        this.pos++;
        this.still = 0;
      }
      if (this.pos !== nav.presses) {
        this.say(`replay: stop ${i} needs ${nav.presses} ${nav.key} presses, the deck moved ${this.pos} times`);
        return false;
      }
      // A build step on this slide: the same presses that changed nothing in the walk.
      const want = nav.still ?? 0;
      if (this.still > want) {
        this.say(`replay: stop ${i} needs ${want} presses on its slide, ${this.still} were made`);
        return false;
      }
      while (this.still < want) {
        const p = await this.view.pressKey(nav.key);
        if (p.moved) {
          this.say(`replay: stop ${i} expected a build step, the deck moved on`);
          return false;
        }
        this.still++;
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
  // The probe copy answers every docId it was given: each probe load is a fresh origin (review finding 30).
  installDeckProtocol(ses, (id) => (id === doc.docId ? doc : (copy?.servedAs(id) ?? undefined)));

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
      // Text in an open shadow root or a same-origin frame is counted, never written or probed (section 7:
      // text in iframes is pin only; review finding 32).
      match: w.tree === 'shadow' || w.tree === 'frame' ? { ...SUBDOCUMENT_MATCH, candidates: [] } : matcher(w.node),
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
          normalizeConsoleMessage(e.message, { docIds: [doc.docId, ...c.docIds], rename: [[c.fileName, doc.fileName]] });
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
            newDocId: () => newDocumentId(),
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
      reducedMotion: args.reducedMotion === true,
      walk: summary,
      nodes,
      blocks: walk.blocks,
      probe,
      consoleErrors: walk.consoleErrors.length,
      warnings,
      uncounted: { crossOriginFrames: walk.crossOriginFrames },
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
