// `blueline map` (section 10, Phase 0 steps 4–5 and the mutation probe; section 11 Coverage baseline), the
// render service's pure parts (6.7) and the Diagnostics helpers. Electron is mocked: these are the parts
// that run without a window. The real-Electron runs are test/e2e/map.spec.ts and diagnostics.spec.ts. The probe
// through the real patcher is in report-probe.edit.test.ts (it needs the editor, P2-15).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({
  app: { getName: () => 'Blueline', getVersion: () => '0.0.0', getPath: () => os.tmpdir(), on() {}, once() {}, removeListener() {} },
  BrowserWindow: class {},
  WebContentsView: class {},
  ipcMain: { on() {}, handle() {} },
  protocol: { registerSchemesAsPrivileged() {} },
  session: { fromPartition: () => ({}) },
  nativeTheme: { shouldUseDarkColors: false },
  Menu: {},
  dialog: {},
  shell: {},
}));

import type { FindResult, LocateResult, NodeLocator } from '@blueline/core/ipc';
import type { MatchResult } from '@blueline/core/types';
import {
  buildReport,
  exitCodeFor,
  formatText,
  quoteText,
  SUBDOCUMENT_MATCH,
  type CountedBlock,
  type CountedNode,
  type MapInputs,
  type ProbeSummary,
} from '../../../packages/app/src/main/report';
import {
  SENTINEL,
  judgeNode,
  locatorKey,
  normalizeConsoleMessage,
  probeCopyName,
  type NodeCheck,
} from '../../../packages/app/src/main/probe';
import {
  ACCELERATOR_KEY,
  DEFAULT_VIEWPORT,
  POOL_LIMIT,
  RenderPool,
  acceleratorKeyFor,
  expectedCaptureSize,
  resultCheck,
  validViewport,
  type RenderView,
} from '../../../packages/app/src/main/render-service';
import { DIAG_STEPS, differingShare, evidenceFor } from '../../../packages/app/src/main/diagnostics';

// ------------------------------------------------------------------------------------------- helpers

const exact = (runId: string, start = 10, end = 20, strategy: MatchResult['strategy'] = 'html-text'): MatchResult => ({
  confidence: 'exact',
  runId,
  strategy,
  candidates: [{ runId, strategy: strategy ?? 'html-text', start, end, line: 1 }],
});
const ambiguous = (reason: MatchResult['reason'], runIds: string[]): MatchResult => ({
  confidence: 'ambiguous',
  runId: null,
  strategy: null,
  candidates: runIds.map((r) => ({ runId: r, strategy: 'html-text', start: 0, end: 1, line: 1 })),
  reason,
});
const none = (reason: MatchResult['reason']): MatchResult => ({ confidence: 'none', runId: null, strategy: null, candidates: [], reason });

let nextKey = 1;
function node(slide: number, data: string, match: CountedNode['match'], probe?: CountedNode['probe']): CountedNode {
  const key = nextKey++;
  return { key, slide, stop: slide, locator: { stamp: `bl-${key}`, cssPath: `p:nth-of-type(${key})`, childIndex: 0 }, node: { stamp: `bl-${key}`, textIndex: 0, data }, match, probe };
}

function inputs(nodes: CountedNode[], blocks: CountedBlock[] = [], probe: Partial<ProbeSummary> = {}): MapInputs {
  return {
    deck: 'deck.html',
    deckSha: 'a'.repeat(64),
    utf8: true,
    trust: 'trusted',
    viewport: { w: 1600, h: 900, dpr: 2 },
    walk: {
      kind: 'generic',
      navKind: 'index',
      count: 2,
      titles: ['One', 'Two'],
      designSize: { w: 1600, h: 900 },
      reached: [true, true],
      keys: 'input',
      forwardKey: 'ArrowRight',
      notes: [],
    },
    nodes,
    blocks,
    probe: { ran: true, why: null, runs: 2, originalUnchanged: true, copyRemoved: true, ...probe },
    consoleErrors: 0,
    warnings: [],
  };
}

// ------------------------------------------------------------------------------------------- report

describe('buildReport (section 10 step 5, section 11 baseline)', () => {
  const pass = { pass: true } as const;
  const a = node(0, 'Title', exact('h:bl-1:0', 100, 105), pass);
  const b = node(0, 'Body ', exact('h:bl-2:0', 120, 125), pass);
  const c = node(1, 'Owner', ambiguous('duplicate', ['h:bl-3:0', 'h:bl-4:0']));
  const d = node(1, '1 / 2', none('computed'));
  const e = node(1, 'Wrong', exact('l:3:0', 300, 305, 'json-literal'), { pass: false, why: 'the sentinel is not in the node' });
  const nodes = [a, b, c, d, e];
  const blocks: CountedBlock[] = [
    { key: 900, hasInline: true, nodeKeys: [a.key, b.key] },
    { key: 901, hasInline: true, nodeKeys: [c.key] },
    { key: 902, hasInline: false, nodeKeys: [d.key] },
    { key: 903, hasInline: true, nodeKeys: [e.key] },
    { key: 904, hasInline: true, nodeKeys: [99999] }, // no counted node: not a visible block of the report
  ];
  const json = buildReport(inputs(nodes, blocks));
  const r = json.report;

  it('counts exact, ambiguous, none and total per slide and overall', () => {
    expect(r.totals).toEqual({ exact: 3, ambiguous: 1, none: 1, total: 5 });
    expect(r.perSlide.map((s) => [s.slide, s.exact, s.ambiguous, s.none, s.total])).toEqual([
      [0, 2, 0, 0, 2],
      [1, 1, 1, 1, 3],
    ]);
    expect(r.perSlide[1].title).toBe('Two');
  });

  it('coverage counts only exact nodes that passed the probe', () => {
    expect(json.coverage).toEqual({ exact: 2, ambiguous: 1, none: 1, total: 5, slides: { count: 2, reached: 2 }, wording: { exact: 2, total: 4 } });
    expect(r.coverage.probeFailed).toBe(1);
    expect(r.coverage.verified).toBe(true);
    expect(r.coverage.share).toBeCloseTo(0.4);
    expect(r.probe).toMatchObject({ nodes: 3, passed: 2, failed: 1 });
    expect(r.probe.failures).toEqual([{ slide: 1, text: 'Wrong', runId: 'l:3:0', why: 'the sentinel is not in the node' }]);
  });

  it('lists every non-exact string with its slide, reason and candidate count', () => {
    expect(r.nonExact).toEqual([
      { slide: 1, text: 'Owner', confidence: 'ambiguous', reason: 'duplicate', candidates: 2 },
      { slide: 1, text: '1 / 2', confidence: 'none', reason: 'computed', candidates: 0 },
    ]);
  });

  it('writes the baseline runs: {slide, text, strategy, confidence, start, end}', () => {
    expect(json.runs[0]).toEqual({ slide: 0, text: 'Title', strategy: 'html-text', confidence: 'exact', start: 100, end: 105, probe: 'pass' });
    expect(json.runs[2]).toEqual({ slide: 1, text: 'Owner', strategy: null, confidence: 'ambiguous', start: null, end: null, reason: 'duplicate' });
    expect(json.runs[4]).toMatchObject({ strategy: 'json-literal', start: 300, end: 305, probe: 'fail' });
    expect(json.deckSha).toBe('a'.repeat(64));
  });

  it('reports the share of blocks with inline elements and of those the share mapping every run exact', () => {
    expect(r.inline).toMatchObject({ blocks: 4, withInline: 3, allExact: 2, allPassed: 1 });
    expect(r.inline.shareWithInline).toBeCloseTo(0.75);
    expect(r.inline.shareAllExact).toBeCloseTo(2 / 3);
  });

  it('holds no absolute path, so a baseline only changes with the mapping', () => {
    expect(JSON.stringify(json)).not.toMatch(/\/home\/|\/Users\/|[A-Z]:\\\\/);
    expect(r.deck).toBe('deck.html');
  });

  it('marks coverage unverified when the probe did not run (reader-only build)', () => {
    const n = [node(0, 'x', exact('h:bl-9:0')), node(0, 'y', exact('h:bl-10:0'))];
    const j = buildReport(inputs(n, [], { ran: false, why: 'reader-only build', runs: 0, originalUnchanged: true, copyRemoved: null }));
    expect(j.coverage.exact).toBe(2);
    expect(j.report.coverage.verified).toBe(false);
    expect(j.runs.every((x) => x.probe === undefined)).toBe(true);
  });
});

describe('exitCodeFor', () => {
  const ok = buildReport(inputs([node(0, 'Alpha', exact('h:bl-1:0'), { pass: true }), node(0, 'Beta', none('no-match'))])).report;
  it('is 0 for a clean run without --min-coverage', () => expect(exitCodeFor(ok, null)).toBe(0));
  it('is 1 below --min-coverage, 0 at or above it', () => {
    expect(exitCodeFor(ok, 0.95)).toBe(1);
    expect(exitCodeFor(ok, 0.5)).toBe(0);
  });
  it('gates on the wording: numbers and glyphs that are not exact do not count against it (Josh, 2026-10-17)', () => {
    const r = buildReport(inputs([node(0, 'Alpha', exact('h:bl-1:0'), { pass: true }), node(0, '1,234', none('computed')), node(0, '·', none('no-match'))])).report;
    expect(r.coverage.share).toBeCloseTo(1 / 3);
    expect(r.coverage.wording).toEqual({ exact: 1, total: 1, share: 1 });
    expect(exitCodeFor(r, 0.95)).toBe(0);
  });
  it('is 1 when a node reported exact failed the probe (a write to the wrong place)', () => {
    const r = buildReport(inputs([node(0, 'a', exact('h:bl-1:0'), { pass: false, why: 'x' })])).report;
    expect(exitCodeFor(r, null)).toBe(1);
  });
  it("is 1 when the original's bytes changed", () => {
    const r = buildReport(inputs([node(0, 'a', exact('h:bl-1:0'), { pass: true })], [], { originalUnchanged: false })).report;
    expect(exitCodeFor(r, null)).toBe(1);
  });
  it('is 1 with --min-coverage when coverage is unverified', () => {
    const r = buildReport(inputs([node(0, 'a', exact('h:bl-1:0'))], [], { ran: false, why: 'reader-only build' })).report;
    expect(exitCodeFor(r, 0)).toBe(1);
    expect(exitCodeFor(r, null)).toBe(0);
  });
  it('treats an empty deck as 0% coverage', () => {
    const r = buildReport(inputs([])).report;
    expect(r.coverage.share).toBe(0);
    expect(exitCodeFor(r, 0.1)).toBe(1);
  });
});

describe('formatText', () => {
  const nodes = [node(0, 'Title', exact('h:bl-1:0'), { pass: true }), node(1, 'Line\nbreak', none('no-match'))];
  const json = buildReport(inputs(nodes));
  it('summarises without --report', () => {
    const t = formatText(json, { detailed: false, minCoverage: null, exitCode: 0 });
    expect(t).toContain('blueline map: deck.html');
    expect(t).toContain('Coverage: 1 of 2 (50.0%) map exact and pass the mutation probe');
    expect(t).toContain('Probe: 1 node on 2 runs: 1 passed, 0 failed · original unchanged · probe copy removed');
    expect(t).not.toContain('Per slide');
  });
  it('adds the per-slide table and every non-exact string with --report', () => {
    const t = formatText(json, { detailed: true, minCoverage: 0.95, exitCode: 1 });
    expect(t).toContain('Per slide');
    expect(t).toMatch(/slide 2\s+none\s+no-match\s+"Line\\nbreak"/);
    expect(t).toContain('Minimum coverage 95.0% of the wording: NOT met');
    expect(t).toContain('Exit code 1.');
  });
  it('says when coverage is not verified', () => {
    const j = buildReport(inputs(nodes, [], { ran: false, why: 'reader-only build: no patcher' }));
    expect(formatText(j, { detailed: false, minCoverage: null, exitCode: 0 })).toContain('NOT verified: reader-only build: no patcher');
  });
  it('quoteText escapes control characters and never splits a surrogate pair', () => {
    expect(quoteText('a\tb')).toBe('"a\\tb"');
    const s = 'x'.repeat(69) + '\u{1F680}';
    expect(quoteText(s, 70)).toBe(JSON.stringify('x'.repeat(69) + '…'));
  });
});

describe('an incomplete walk (review finding 28, decision D-j)', () => {
  const walkOf = (count: number, reached: number): MapInputs['walk'] => ({
    kind: 'generic',
    navKind: 'index',
    count,
    titles: Array.from({ length: count }, (_, i) => `Slide ${i + 1}`),
    designSize: { w: 1600, h: 900 },
    reached: Array.from({ length: count }, (_, i) => i < reached),
    keys: 'input',
    forwardKey: 'ArrowRight',
    notes: [],
  });

  it('builds.html: 1 of 5 slides reached is incomplete coverage, so map exits 1 with or without --min-coverage', () => {
    const j = buildReport({ ...inputs([node(0, 'Opening slide', exact('h:bl-1:0'), { pass: true })]), walk: walkOf(5, 1) });
    expect(j.coverage).toEqual({ exact: 1, ambiguous: 0, none: 0, total: 1, slides: { count: 5, reached: 1 }, wording: { exact: 1, total: 1 } });
    expect(j.report.coverage.complete).toBe(false);
    expect(exitCodeFor(j.report, null)).toBe(1);
    expect(exitCodeFor(j.report, 0.95)).toBe(1);
    const t = formatText(j, { detailed: false, minCoverage: 0.95, exitCode: 1 });
    expect(t).toContain('Coverage: 1 of 1 (100.0%) map exact and pass the mutation probe; INCOMPLETE: the walk reached 1 of 5 slides');
    expect(t).toContain('Minimum coverage 95.0% of the wording: NOT met (the walk reached 1 of 5 slides)');
    expect(t).not.toMatch(/: met\b/);
  });

  it('the 200-press cap: 201 of 300 slides reached is not a met gate, even at 100% of what was seen', () => {
    const nodes = Array.from({ length: 201 }, (_, i) => node(i, `Slide ${i + 1} title`, exact(`h:bl-${i + 1}:0`), { pass: true }));
    const j = buildReport({ ...inputs(nodes), walk: { ...walkOf(300, 201), notes: ['stopped after 200 keys'] } });
    expect(j.report.coverage.share).toBe(1);
    expect(j.coverage.slides).toEqual({ count: 300, reached: 201 });
    expect(exitCodeFor(j.report, 0.95)).toBe(1);
    expect(exitCodeFor(j.report, null)).toBe(1);
    expect(formatText(j, { detailed: true, minCoverage: 0.95, exitCode: 1 })).toContain('INCOMPLETE: the walk reached 201 of 300 slides');
  });

  it('a complete walk keeps exit 0 and records slides in the baseline coverage', () => {
    const j = buildReport(inputs([node(0, 'a', exact('h:bl-1:0'), { pass: true })]));
    expect(j.coverage.slides).toEqual({ count: 2, reached: 2 });
    expect(j.report.coverage.complete).toBe(true);
    expect(exitCodeFor(j.report, null)).toBe(0);
    expect(formatText(j, { detailed: false, minCoverage: null, exitCode: 0 })).not.toContain('INCOMPLETE');
  });
});

describe('text the walk counts but Blueline never writes (review finding 32)', () => {
  it('shadow-root and frame text is none (subdocument), and cross-origin frames are listed as uncounted', () => {
    const sub = { ...SUBDOCUMENT_MATCH, candidates: [] };
    const j = buildReport({ ...inputs([node(0, 'Light', exact('h:bl-1:0'), { pass: true }), node(0, 'In a shadow root', sub)]), uncounted: { crossOriginFrames: 2 } });
    expect(j.coverage).toMatchObject({ exact: 1, none: 1, total: 2 });
    expect(j.report.nonExact).toEqual([{ slide: 0, text: 'In a shadow root', confidence: 'none', reason: 'subdocument', candidates: 0 }]);
    expect(j.runs[1]).toMatchObject({ confidence: 'none', reason: 'subdocument' });
    expect(j.report.uncounted).toEqual({ crossOriginFrames: 2 });
    const t = formatText(j, { detailed: true, minCoverage: null, exitCode: 0 });
    expect(t).toContain('Uncounted visible content: 2 cross-origin frames');
    expect(t).toMatch(/slide 1\s+none\s+subdocument\s+"In a shadow root"/);
    expect(formatText(buildReport(inputs([])), { detailed: false, minCoverage: null, exitCode: 0 })).not.toContain('Uncounted');
  });
});

// ------------------------------------------------------------------------------------------- probe

describe('probe helpers', () => {
  it('uses the sentinel ⟦bl⟧', () => expect(SENTINEL).toBe('⟦bl⟧'));

  it('names the copy .<name>.bl-probe.html', () => {
    expect(probeCopyName('deck.html')).toBe('.deck.bl-probe.html');
    expect(probeCopyName('Q4 plan.htm')).toBe('.Q4 plan.bl-probe.html');
    expect(probeCopyName('.hidden.html')).toBe('..hidden.bl-probe.html');
  });

  it('normalizes docIds and the copy name so the same console error compares equal', () => {
    const o = { docIds: ['0123456789abcdef', 'fedcba9876543210'], rename: [['.deck.bl-probe.html', 'deck.html']] as [string, string][] };
    const a = normalizeConsoleMessage('Uncaught TypeError at blueline://0123456789abcdef/deck.html:12 (blueline://0123456789abcdef-files/app.js)', o);
    const b = normalizeConsoleMessage('Uncaught TypeError at blueline://fedcba9876543210/.deck.bl-probe.html:12 (blueline://fedcba9876543210-files/app.js)', o);
    expect(a).toBe(b);
    expect(a).toContain('blueline://DOC-files/app.js');
    expect(normalizeConsoleMessage('x %2Edeck.bl-probe.html', { docIds: [], rename: [['.deck.bl-probe.html', 'deck.html']] })).toBe('x %2Edeck.bl-probe.html');
    expect(normalizeConsoleMessage('x .deck%20b.bl-probe.html', { docIds: [], rename: [['.deck b.bl-probe.html', 'deck b.html']] })).toBe('x deck b.html');
  });

  it('locator keys tell locators apart', () => {
    const l = (stamp: string | null, css: string, i: number): NodeLocator => ({ stamp, cssPath: css, childIndex: i });
    expect(locatorKey(l('bl-1', 'p', 0))).not.toBe(locatorKey(l('bl-1', 'p', 1)));
    expect(locatorKey(l(null, 'p', 0))).not.toBe(locatorKey(l('bl-1', 'p', 0)));
    expect(locatorKey(l('bl-1', 'p', 0))).toBe(locatorKey(l('bl-1', 'p', 0)));
  });
});

describe('judgeNode (section 10 Mutation probe step 4)', () => {
  const self: NodeLocator = { stamp: 'bl-1', cssPath: '#t', childIndex: 0 };
  const other: NodeLocator = { stamp: 'bl-2', cssPath: '#u', childIndex: 0 };
  const located = (data: string): LocateResult => ({ found: true, node: { key: 1, locator: self, node: { stamp: 'bl-1', textIndex: 0, data }, rect: { x: 0, y: 0, w: 1, h: 1 } }, visible: true, slide: 0 });
  const match = (loc: NodeLocator, data: string, visible = true): FindResult['matches'][number] => ({ key: 2, locator: loc, node: { stamp: loc.stamp, textIndex: 0, data }, visible, slide: 0 });
  const base: NodeCheck = {
    reached: true,
    slideCountBefore: 3,
    slideCountAfter: 3,
    located: located(`Title${SENTINEL}`),
    found: { matches: [match(self, `Title${SENTINEL}`)], truncated: false },
    self,
    sameRun: new Set(),
    reported: new Set([locatorKey(self), locatorKey(other)]),
    newErrors: [],
  };
  it('passes when the sentinel is in that node and nowhere else', () => expect(judgeNode(base)).toEqual({ pass: true }));
  it('fails when the slide could not be shown again', () => expect(judgeNode({ ...base, reached: false }).pass).toBe(false));
  it('fails when the slide count changed', () => expect(judgeNode({ ...base, slideCountAfter: 4 })).toMatchObject({ pass: false, why: expect.stringContaining('slide count') }));
  it('fails when the node is gone', () => expect(judgeNode({ ...base, located: { found: false, node: null, visible: false, slide: null } }).pass).toBe(false));
  it('fails when the sentinel is not in that node', () => expect(judgeNode({ ...base, located: located('Title') })).toMatchObject({ pass: false, why: expect.stringContaining('not in the node') }));
  it('fails when the sentinel also appears in another reported node', () => {
    const v = judgeNode({ ...base, found: { matches: [match(self, `T${SENTINEL}`), match(other, `Agenda: T${SENTINEL}`)], truncated: false } });
    expect(v).toMatchObject({ pass: false, why: expect.stringContaining('another node') });
  });
  it('allows reported renders of the same run', () => {
    const v = judgeNode({ ...base, sameRun: new Set([locatorKey(other)]), found: { matches: [match(self, `T${SENTINEL}`), match(other, `T${SENTINEL}`)], truncated: false } });
    expect(v).toEqual({ pass: true });
  });
  it('skips an unreported node only when it is clipped to a zero area (the F17 live region), never a hidden reported one', () => {
    const live: NodeLocator = { stamp: null, cssPath: 'div.aria-status', childIndex: 0 };
    const clipped = (loc: NodeLocator, data: string) => ({ ...match(loc, data, false), clipped: true });
    expect(judgeNode({ ...base, found: { matches: [match(self, `T${SENTINEL}`), clipped(live, `T${SENTINEL} more`)], truncated: false } })).toEqual({ pass: true });
    expect(judgeNode({ ...base, found: { matches: [match(self, `T${SENTINEL}`), match(other, `T${SENTINEL}`, false)], truncated: false } }).pass).toBe(false);
    expect(judgeNode({ ...base, found: { matches: [match(self, `T${SENTINEL}`), match(live, `T${SENTINEL}`, true)], truncated: false } }).pass).toBe(false);
    // Review finding 31: a hidden node the walk never counted (display: none, opacity 0, off-viewport, an
    // unreached slide) is not a reported render of the run; its text would change unseen, so the node fails.
    expect(judgeNode({ ...base, found: { matches: [match(self, `T${SENTINEL}`), match(live, `T${SENTINEL} more`, false)], truncated: false } }).pass).toBe(false);
  });
  it('fails on a truncated search and on a new console error', () => {
    expect(judgeNode({ ...base, found: { ...base.found, truncated: true } }).pass).toBe(false);
    expect(judgeNode({ ...base, newErrors: ['Uncaught SyntaxError'] })).toMatchObject({ pass: false, why: expect.stringContaining('console error') });
  });
});


// ------------------------------------------------------------------------------------------- render service

describe('render service (6.7)', () => {
  it('maps stored deckNav keys to Electron Accelerator names', () => {
    expect(ACCELERATOR_KEY).toEqual({ ArrowRight: 'Right', ArrowLeft: 'Left', PageDown: 'PageDown', PageUp: 'PageUp', ' ': 'Space' });
    expect(acceleratorKeyFor('ArrowRight')).toBe('Right');
    expect(acceleratorKeyFor(' ')).toBe('Space');
    expect(acceleratorKeyFor('Space')).toBe('Space');
    expect(acceleratorKeyFor('Enter')).toBeNull();
    expect(acceleratorKeyFor('__proto__')).toBeNull();
  });

  it('expects a 1600×900 capture at 2x to be 3200×1800', () => {
    expect(DEFAULT_VIEWPORT).toEqual({ w: 1600, h: 900, dpr: 2 });
    expect(expectedCaptureSize(DEFAULT_VIEWPORT)).toEqual({ width: 3200, height: 1800 });
    expect(expectedCaptureSize(DEFAULT_VIEWPORT, { width: 100, height: 50 })).toEqual({ width: 200, height: 100 });
    expect(validViewport({ w: 1600, h: 900, dpr: 2 })).toBe(true);
    expect(validViewport({ w: 0, h: 900, dpr: 2 })).toBe(false);
    expect(validViewport({ w: 1600.5, h: 900, dpr: 2 })).toBe(false);
    expect(validViewport({ w: 1600, h: 900, dpr: Number.NaN })).toBe(false);
  });

  it('checks the shape of render results (page-controlled data)', () => {
    expect(resultCheck.current({ current: 1, count: 3, hash: '#a', scrollY: 0, reveal: [1, 0] })).toEqual({ current: 1, count: 3, hash: '#a', scrollY: 0, reveal: [1, 0] });
    expect(() => resultCheck.current({ current: -1, count: 3, hash: '', scrollY: 0, reveal: null })).toThrow();
    expect(() => resultCheck.find({ truncated: false, matches: [{ key: 1, locator: { stamp: 'evil', cssPath: 'p', childIndex: 0 }, node: { stamp: null, textIndex: 0, data: 'x' }, visible: true, slide: 0 }] })).toThrow();
    expect(resultCheck.locate({ found: false, node: null, visible: false, slide: null })).toEqual({ found: false, node: null, visible: false, slide: null });
    expect(() => resultCheck.goto({ navigated: 'yes', current: 0, navKind: 'reveal' })).toThrow();
    expect(resultCheck.key({ dispatched: true, current: 2 })).toEqual({ dispatched: true, current: 2 });
  });

  it('pools at most 2 render views per document', async () => {
    expect(POOL_LIMIT).toBe(2);
    let made = 0;
    const factory = () => {
      made++;
      let dead = false;
      return { isDestroyed: () => dead, close: () => (dead = true) } as unknown as RenderView;
    };
    const pool = new RenderPool(factory);
    const a = await pool.acquire();
    const b = await pool.acquire();
    let third: RenderView | null = null;
    const waiting = pool.acquire().then((v) => (third = v));
    await new Promise((r) => setTimeout(r, 10));
    expect(made).toBe(2);
    expect(third).toBeNull();
    pool.release(a);
    await waiting;
    expect(third).toBe(a);
    expect(made).toBe(2);
    pool.release(b);
    pool.release(a);
    expect(pool.size).toBe(2);
    pool.close();
    await expect(pool.acquire()).rejects.toThrow(/closed/);
    expect(() => new RenderPool(factory, 3)).toThrow(RangeError);
  });
});

// ------------------------------------------------------------------------------------------- diagnostics

describe('Diagnostics', () => {
  it('has the automatic checks and the guided steps of section 10', () => {
    const auto = DIAG_STEPS.filter((s) => s.auto).map((s) => s.id);
    const guided = DIAG_STEPS.filter((s) => !s.auto).map((s) => s.id);
    expect(auto).toEqual(['key-order', 'stop-propagation', 'app-chords', 'offscreen-keys', 'capture-size', 'fit-zoom']);
    expect(guided).toEqual(['wispr-card', 'wispr-heading', 'dictate-body-read', 'dictate-body-review', 'dictate-body-edit', 'dictate-strokes']);
  });

  it('records evidence from the log for guided steps', () => {
    const at = new Date().toISOString();
    const log = [
      { at, event: 'beforeinput', data: { inputType: 'insertFromPaste' } },
      { at, event: 'paste', data: { length: 12 } },
      { at, event: 'heading-input', data: { value: 'x' } },
      { at, event: 'shortcut', data: { key: 'v' } },
    ];
    expect(evidenceFor('wispr-heading', log, { mode: 'read', lastNote: null })).toBe('beforeinput: insertFromPaste; 1 paste, 1 heading-input event(s)');
    expect(evidenceFor('dictate-body-review', log, { mode: 'review', lastNote: null })).toContain('1 shortcut(s)');
    // The user's own setup keys (the mode chord, a tool key) are not the dictation's doing.
    const setup = [
      { at, event: 'app-chord', data: { action: 'mode-review' } },
      { at, event: 'shortcut', data: { action: 'tool-select' } },
      { at, event: 'paste', data: { length: 30 } },
    ];
    expect(evidenceFor('dictate-body-review', setup, { mode: 'review', lastNote: null })).toBe('mode review; after the setup keys: 0 mode change(s), 0 shortcut(s), 0 deck move(s), 1 paste');
    expect(evidenceFor('dictate-body-edit', setup, { mode: 'review', lastNote: null })).toContain('mode review, NOT edit');
    expect(evidenceFor('dictate-strokes', [], { mode: 'review', lastNote: { text: 20, marks: 2 } })).toContain('20 characters, 2 mark(s)');
  });

  it('compares bitmaps for the Fit check', () => {
    const a = new Uint8Array([0, 0, 0, 255, 10, 10, 10, 255]);
    expect(differingShare(a, a)).toBe(0);
    expect(differingShare(a, new Uint8Array([0, 0, 0, 255, 200, 10, 10, 255]))).toBe(0.5);
    expect(differingShare(a, new Uint8Array([0, 0, 0, 255]))).toBe(1);
  });
});
