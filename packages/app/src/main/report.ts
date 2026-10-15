// The `blueline map` report (section 10, Phase 0, steps 4–5 and the mutation probe; section 11, Coverage
// baseline). Pure: map-command.ts gathers the walk, the matches and the probe verdicts, and this module
// counts them, formats the text report and builds the JSON (the baseline format plus the detailed report).
//
// Counting rules:
// - Each visible text node is counted once across slides, on the slide where the walk first saw it.
// - `exact`, `ambiguous`, `none` and `total` are the shared matcher's verdicts, per slide and overall.
// - Coverage counts only nodes that are `exact` AND pass the mutation probe (section 10). When the probe
//   could not run (a reader-only build), coverage is the matcher's `exact` count and is marked unverified.
// - The JSON never holds an absolute path, a time or a duration, so a baseline only changes when the
//   mapping does (section 11: "A baseline changes only in a commit that says why").

import type { TrustState } from '@blueline/core/ipc';
import type { Confidence, DomTextNode, MatchReason, MatchResult, Strategy } from '@blueline/core/types';
import type { NodeLocator } from '@blueline/core/ipc';

export type ProbeVerdict = { pass: true } | { pass: false; why: string };

/** One visible text node of the walk, matched (and probed when exact). */
export interface CountedNode {
  /** WalkNode.key of the walk's page load. */
  key: number;
  /** 0-based slide where the walk first counted it. */
  slide: number;
  /** Index into the walk's stops (how to show this node again after a reload). */
  stop: number;
  locator: NodeLocator;
  node: DomTextNode;
  match: MatchResult;
  /** Set for every `exact` node when the probe ran. */
  probe?: ProbeVerdict;
}

/** A visible text block (WalkBlock), merged across slides by its key. */
export interface CountedBlock {
  key: number;
  hasInline: boolean;
  nodeKeys: number[];
}

export interface WalkSummary {
  kind: 'reveal' | 'generic' | 'scroll' | 'single';
  navKind: string;
  count: number;
  titles: string[];
  designSize: { w: number; h: number };
  /** Per slide: the walk showed it. */
  reached: boolean[];
  /** How keys reached the deck in an index walk: trusted input, the synthetic fallback, or no keys pressed. */
  keys: 'input' | 'synthetic' | null;
  /** The forward key that moved the deck (index walks), or null. */
  forwardKey: string | null;
  /** Notes on the walk, e.g. a key that changed nothing. */
  notes: string[];
}

export interface ProbeSummary {
  ran: boolean;
  /** Why the probe did not run (reader-only build, not UTF-8, a stale probe copy), or null. */
  why: string | null;
  /** Runs probed (each run is written once; every node mapped to it is checked). */
  runs: number;
  /** The original's bytes were unchanged at the end (null when not checked). */
  originalUnchanged: boolean | null;
  /** The probe copy was deleted (null when none was made). */
  copyRemoved: boolean | null;
}

export interface MapInputs {
  /** The deck's file name (never a full path: the JSON is a committed baseline). */
  deck: string;
  deckSha: string;
  utf8: boolean;
  trust: TrustState;
  viewport: { w: number; h: number; dpr: number };
  walk: WalkSummary;
  nodes: CountedNode[];
  blocks: CountedBlock[];
  probe: ProbeSummary;
  /** Console errors the page logged during the walk's load. */
  consoleErrors: number;
  warnings: string[];
}

export interface Counts {
  exact: number;
  ambiguous: number;
  none: number;
  total: number;
}

export interface SlideCounts extends Counts {
  slide: number;
  title: string;
  reached: boolean;
}

export interface NonExact {
  slide: number;
  text: string;
  confidence: Exclude<Confidence, 'exact'>;
  reason: MatchReason | null;
  candidates: number;
}

export interface ProbeFailure {
  slide: number;
  text: string;
  runId: string;
  why: string;
}

export interface MapReport {
  deck: string;
  utf8: boolean;
  trust: TrustState;
  viewport: { w: number; h: number; dpr: number };
  slides: {
    kind: WalkSummary['kind'];
    navKind: string;
    count: number;
    reached: number;
    designSize: { w: number; h: number };
    keys: WalkSummary['keys'];
    forwardKey: string | null;
    notes: string[];
  };
  perSlide: SlideCounts[];
  totals: Counts;
  coverage: Counts & {
    /** exact / total (0 when total is 0). */
    share: number;
    /** Nodes reported exact that failed the probe: each is a write to the wrong place (section 10, Exit gate). */
    probeFailed: number;
    /** False when the probe did not run, so `exact` is the matcher's count, not verified. */
    verified: boolean;
  };
  nonExact: NonExact[];
  inline: {
    blocks: number;
    withInline: number;
    /** Of the blocks with inline elements: every run maps exact. */
    allExact: number;
    /** Of the blocks with inline elements: every run maps exact and passed the probe. */
    allPassed: number;
    shareWithInline: number;
    shareAllExact: number;
  };
  probe: ProbeSummary & { nodes: number; passed: number; failed: number; failures: ProbeFailure[] };
  consoleErrors: number;
  warnings: string[];
}

/** One entry of the baseline's `runs` (section 11), one per counted node. */
export interface BaselineRun {
  slide: number;
  text: string;
  strategy: Strategy | null;
  confidence: Confidence;
  /** The source range (UTF-16 offsets into the decoded file) of the run an exact node maps to, else null. */
  start: number | null;
  end: number | null;
  reason?: MatchReason;
  probe?: 'pass' | 'fail';
}

/** What `blueline map --report --json` prints: section 11's baseline format plus the detailed report. */
export interface MapJson {
  deckSha: string;
  coverage: Counts;
  runs: BaselineRun[];
  report: MapReport;
}

function ratio(a: number, b: number): number {
  return b === 0 ? 0 : a / b;
}

function emptyCounts(): Counts {
  return { exact: 0, ambiguous: 0, none: 0, total: 0 };
}

function add(c: Counts, conf: Confidence): void {
  c[conf]++;
  c.total++;
}

/** A node counts toward coverage: exact and passed the probe, or exact when the probe did not run. */
function covered(n: CountedNode, probeRan: boolean): boolean {
  if (n.match.confidence !== 'exact') return false;
  return probeRan ? n.probe?.pass === true : true;
}

export function buildReport(i: MapInputs): MapJson {
  const probeRan = i.probe.ran;
  const perSlide: SlideCounts[] = [];
  for (let s = 0; s < Math.max(1, i.walk.count); s++) {
    perSlide.push({ slide: s, title: i.walk.titles[s] ?? `Slide ${s + 1}`, reached: i.walk.reached[s] === true, ...emptyCounts() });
  }
  const totals = emptyCounts();
  const nonExact: NonExact[] = [];
  const failures: ProbeFailure[] = [];
  let exactCovered = 0;
  let probed = 0;
  let passed = 0;
  const runs: BaselineRun[] = [];
  for (const n of i.nodes) {
    const conf = n.match.confidence;
    add(totals, conf);
    const row = perSlide[n.slide] ?? perSlide[perSlide.length - 1];
    add(row, conf);
    if (covered(n, probeRan)) exactCovered++;
    const entry: BaselineRun = { slide: n.slide, text: n.node.data, strategy: null, confidence: conf, start: null, end: null };
    if (conf === 'exact') {
      const c = n.match.candidates[0];
      entry.strategy = n.match.strategy;
      entry.start = c && c.start >= 0 ? c.start : null;
      entry.end = c && c.end >= 0 ? c.end : null;
      if (n.probe) {
        probed++;
        entry.probe = n.probe.pass ? 'pass' : 'fail';
        if (n.probe.pass) passed++;
        else failures.push({ slide: n.slide, text: n.node.data, runId: n.match.runId ?? '', why: n.probe.why });
      }
    } else {
      if (n.match.reason) entry.reason = n.match.reason;
      nonExact.push({ slide: n.slide, text: n.node.data, confidence: conf, reason: n.match.reason ?? null, candidates: n.match.candidates.length });
    }
    runs.push(entry);
  }

  // Inline blocks (section 10 step 5): blocks with inline elements, and those whose every run maps exact.
  const byKey = new Map(i.nodes.map((n) => [n.key, n] as const));
  let withInline = 0;
  let allExact = 0;
  let allPassed = 0;
  let blocks = 0;
  for (const b of i.blocks) {
    const members = b.nodeKeys.map((k) => byKey.get(k)).filter((n): n is CountedNode => n !== undefined);
    if (members.length === 0) continue;
    blocks++;
    if (!b.hasInline) continue;
    withInline++;
    if (members.every((n) => n.match.confidence === 'exact')) allExact++;
    if (members.every((n) => covered(n, probeRan))) allPassed++;
  }

  const coverage: Counts = { exact: exactCovered, ambiguous: totals.ambiguous, none: totals.none, total: totals.total };
  const report: MapReport = {
    deck: i.deck,
    utf8: i.utf8,
    trust: i.trust,
    viewport: { ...i.viewport },
    slides: {
      kind: i.walk.kind,
      navKind: i.walk.navKind,
      count: i.walk.count,
      reached: i.walk.reached.filter(Boolean).length,
      designSize: { ...i.walk.designSize },
      keys: i.walk.keys,
      forwardKey: i.walk.forwardKey,
      notes: i.walk.notes.slice(),
    },
    perSlide,
    totals,
    coverage: { ...coverage, share: ratio(coverage.exact, coverage.total), probeFailed: failures.length, verified: probeRan },
    nonExact,
    inline: {
      blocks,
      withInline,
      allExact,
      allPassed,
      shareWithInline: ratio(withInline, blocks),
      shareAllExact: ratio(allExact, withInline),
    },
    probe: { ...i.probe, nodes: probed, passed, failed: failures.length, failures },
    consoleErrors: i.consoleErrors,
    warnings: i.warnings.slice(),
  };
  return { deckSha: i.deckSha, coverage, runs, report };
}

/**
 * The exit code of `blueline map` (the report itself was produced; a run that could not walk the deck exits
 * 2 in map-command). 1 when:
 * - the original's bytes changed (section 10 Mutation probe step 1: an assertion);
 * - a node reported exact failed the probe (a write to the wrong place, section 10 Exit gate);
 * - `--min-coverage` is given and coverage is below it, or unverified (no probe), since an unverified
 *   figure cannot pass a gate.
 */
export function exitCodeFor(r: MapReport, minCoverage: number | null): number {
  if (r.probe.originalUnchanged === false) return 1;
  if (r.probe.failed > 0) return 1;
  if (minCoverage !== null) {
    if (!r.coverage.verified) return 1;
    if (r.coverage.share < minCoverage) return 1;
  }
  return 0;
}

// ------------------------------------------------------------------------------------------- text

function pct(x: number): string {
  return `${(Math.round(x * 1000) / 10).toFixed(1)}%`;
}

/** A node's text for one report line: JSON-quoted (control characters and line breaks escaped), cut to `max` characters. */
export function quoteText(s: string, max = 70): string {
  let t = s;
  if (t.length > max) {
    let end = max;
    const c = t.charCodeAt(end - 1);
    if (c >= 0xd800 && c <= 0xdbff) end--;
    t = t.slice(0, end) + '…';
  }
  return JSON.stringify(t);
}

function pad(s: string | number, n: number, right = false): string {
  const v = String(s);
  return right ? v.padEnd(n) : v.padStart(n);
}

function trustWord(t: TrustState): string {
  return t === 'protected' ? 'Protected' : 'Trusted';
}

/** The text report. `detailed` (--report) adds the per-slide table and every non-exact string and probe failure. */
export function formatText(json: MapJson, opts: { detailed: boolean; minCoverage: number | null; exitCode: number }): string {
  const r = json.report;
  const out: string[] = [];
  out.push(`blueline map: ${r.deck}`);
  out.push(`Deck: ${r.deck} · sha256 ${json.deckSha.slice(0, 12)}… · ${r.utf8 ? 'UTF-8' : 'not UTF-8 (read-only)'} · ${trustWord(r.trust)}`);
  const s = r.slides;
  const keys = s.keys === 'input' ? ', keys: trusted input' : s.keys === 'synthetic' ? ', keys: synthetic (trusted input did not reach the deck)' : '';
  out.push(
    `Slides: ${s.kind}, ${s.count} slide${s.count === 1 ? '' : 's'}, navigation ${s.navKind} (${s.reached} of ${s.count} reached${keys}) · ` +
      `viewport ${r.viewport.w}×${r.viewport.h} @${r.viewport.dpr}x · design size ${s.designSize.w}×${s.designSize.h}`,
  );
  const t = r.totals;
  out.push(`Nodes: ${t.total} visible text node${t.total === 1 ? '' : 's'} · exact ${t.exact} · ambiguous ${t.ambiguous} · none ${t.none}`);
  const c = r.coverage;
  if (c.verified) out.push(`Coverage: ${c.exact} of ${c.total} (${pct(c.share)}) map exact and pass the mutation probe`);
  else out.push(`Coverage: ${c.exact} of ${c.total} (${pct(c.share)}) map exact; NOT verified: ${r.probe.why ?? 'the probe did not run'}`);
  const p = r.probe;
  if (p.ran) {
    const orig = p.originalUnchanged === true ? 'original unchanged' : p.originalUnchanged === false ? 'ORIGINAL CHANGED' : 'original not checked';
    const copy = p.copyRemoved === true ? 'probe copy removed' : p.copyRemoved === false ? 'PROBE COPY NOT REMOVED' : '';
    out.push(`Probe: ${p.nodes} node${p.nodes === 1 ? '' : 's'} on ${p.runs} run${p.runs === 1 ? '' : 's'}: ${p.passed} passed, ${p.failed} failed · ${orig}${copy ? ` · ${copy}` : ''}`);
  } else {
    out.push(`Probe: not run (${p.why ?? 'unknown reason'})`);
  }
  const inl = r.inline;
  out.push(
    `Inline blocks: ${inl.withInline} of ${inl.blocks} visible blocks (${pct(inl.shareWithInline)}) contain inline elements; ` +
      `every run maps exact in ${inl.allExact} of ${inl.withInline} (${pct(inl.shareAllExact)})` +
      (c.verified ? `, and passes the probe in ${inl.allPassed}` : ''),
  );
  if (r.consoleErrors > 0) out.push(`Console errors during the walk: ${r.consoleErrors}`);
  if (opts.minCoverage !== null) {
    const ok = c.verified && c.share >= opts.minCoverage;
    out.push(`Minimum coverage ${pct(opts.minCoverage)}: ${ok ? 'met' : 'NOT met'}`);
  }

  if (opts.detailed) {
    out.push('');
    out.push('Per slide');
    out.push(`  ${pad('slide', 5)}  ${pad('exact', 5)}  ${pad('ambiguous', 9)}  ${pad('none', 4)}  ${pad('total', 5)}  title`);
    for (const row of r.perSlide) {
      const title = row.reached ? row.title : `${row.title} (not reached)`;
      out.push(`  ${pad(row.slide + 1, 5)}  ${pad(row.exact, 5)}  ${pad(row.ambiguous, 9)}  ${pad(row.none, 4)}  ${pad(row.total, 5)}  ${title}`);
    }
    out.push(`  ${pad('all', 5)}  ${pad(t.exact, 5)}  ${pad(t.ambiguous, 9)}  ${pad(t.none, 4)}  ${pad(t.total, 5)}`);
    out.push('');
    out.push(`Not exact (${r.nonExact.length})`);
    for (const n of r.nonExact) {
      const cands = n.confidence === 'ambiguous' ? ` (${n.candidates} candidate${n.candidates === 1 ? '' : 's'})` : '';
      out.push(`  slide ${pad(n.slide + 1, 3, true)} ${pad(n.confidence, 9, true)} ${pad(n.reason ?? '-', 12, true)} ${quoteText(n.text)}${cands}`);
    }
    if (p.ran) {
      out.push('');
      out.push(`Probe failures (${p.failures.length})`);
      for (const f of p.failures) out.push(`  slide ${pad(f.slide + 1, 3, true)} ${f.runId} ${quoteText(f.text, 50)}: ${f.why}`);
    }
    if (s.notes.length > 0) {
      out.push('');
      out.push('Navigation');
      for (const n of s.notes) out.push(`  ${n}`);
    }
  }
  if (r.warnings.length > 0) {
    out.push('');
    out.push('Warnings');
    for (const w of r.warnings) out.push(`  ${w}`);
  }
  if (opts.exitCode !== 0) out.push('', `Exit code ${opts.exitCode}.`);
  return out.join('\n');
}
