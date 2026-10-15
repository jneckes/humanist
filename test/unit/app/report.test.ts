// `blueline map` (section 10, Phase 0 steps 4–5 and the mutation probe; section 11 Coverage baseline), the
// render service's pure parts (6.7) and the Diagnostics helpers. Electron is mocked: these are the parts
// that run without a window. The real-Electron runs are test/e2e/map.spec.ts and diagnostics.spec.ts.
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

import type { EditorModule } from '@blueline/core/capabilities';
import type { FindResult, LocateResult, NodeLocator } from '@blueline/core/ipc';
import { buildMap } from '@blueline/core/mapper';
import { createMatcher } from '@blueline/core/matcher';
import { decodeDeck, encodeDeck } from '@blueline/core/text';
import type { MatchResult } from '@blueline/core/types';
import { createWriteQueue } from '@blueline/editor';
import { sha256Hex } from '../../../packages/app/src/main/atomic-write';
import {
  buildReport,
  exitCodeFor,
  formatText,
  quoteText,
  type CountedBlock,
  type CountedNode,
  type MapInputs,
  type ProbeSummary,
} from '../../../packages/app/src/main/report';
import {
  ProbeCopy,
  ProbeRefused,
  SENTINEL,
  judgeNode,
  locatorKey,
  normalizeConsoleMessage,
  probeCopyName,
  runProbe,
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
function node(slide: number, data: string, match: MatchResult, probe?: CountedNode['probe']): CountedNode {
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
    expect(json.coverage).toEqual({ exact: 2, ambiguous: 1, none: 1, total: 5 });
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
  const ok = buildReport(inputs([node(0, 'a', exact('h:bl-1:0'), { pass: true }), node(0, 'b', none('computed'))])).report;
  it('is 0 for a clean run without --min-coverage', () => expect(exitCodeFor(ok, null)).toBe(0));
  it('is 1 below --min-coverage, 0 at or above it', () => {
    expect(exitCodeFor(ok, 0.95)).toBe(1);
    expect(exitCodeFor(ok, 0.5)).toBe(0);
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
    expect(t).toContain('Minimum coverage 95.0%: NOT met');
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
  it('skips a node that is neither visible nor reported (a clipped live region), but not a hidden reported one', () => {
    const live: NodeLocator = { stamp: null, cssPath: 'div.aria-status', childIndex: 0 };
    expect(judgeNode({ ...base, found: { matches: [match(self, `T${SENTINEL}`), match(live, `T${SENTINEL} more`, false)], truncated: false } })).toEqual({ pass: true });
    expect(judgeNode({ ...base, found: { matches: [match(self, `T${SENTINEL}`), match(other, `T${SENTINEL}`, false)], truncated: false } }).pass).toBe(false);
    expect(judgeNode({ ...base, found: { matches: [match(self, `T${SENTINEL}`), match(live, `T${SENTINEL}`, true)], truncated: false } }).pass).toBe(false);
  });
  it('fails on a truncated search and on a new console error', () => {
    expect(judgeNode({ ...base, found: { ...base.found, truncated: true } }).pass).toBe(false);
    expect(judgeNode({ ...base, newErrors: ['Uncaught SyntaxError'] })).toMatchObject({ pass: false, why: expect.stringContaining('console error') });
  });
});

describe('ProbeCopy and runProbe (through the real patcher)', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-probe-test-'));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  // A BOM, CRLF, character references and a JSON block: undo must restore every byte (9.2 Undo and redo).
  const SRC =
    '﻿<!doctype html>\r\n<html><head><title>T</title></head><body>\r\n' +
    '<h1>R&amp;D &mdash; plan</h1>\r\n<p>Costs&nbsp;rose 4&nbsp;%.</p>\r\n<p>Same</p>\r\n' +
    '<script type="application/json" id="d">{"label": "Caf\\u00e9 \\u2014 menu"}</script>\r\n</body></html>\r\n';
  const bytes = encodeDeck(SRC);
  const version = sha256Hex(bytes);

  function original() {
    return { folderReal: dir, fileName: 'deck.html', bytes, trust: () => 'trusted' as const, networkAllowed: () => false, servedProtected: () => false };
  }

  it('creates the hidden copy next to the deck, private, and refuses to overwrite one', async () => {
    const c = await ProbeCopy.create(original(), '0123456789abcdef');
    expect(c.path).toBe(path.join(dir, '.deck.bl-probe.html'));
    expect(Buffer.compare(fs.readFileSync(c.path), Buffer.from(bytes))).toBe(0);
    if (process.platform !== 'win32') expect(fs.statSync(c.path).mode & 0o777).toBe(0o600);
    await expect(ProbeCopy.create(original(), 'fedcba9876543210')).rejects.toBeInstanceOf(ProbeRefused);
    const served = new TextDecoder().decode((await c.documentBody()).body);
    expect(served).toContain('data-bl-e="bl-');
    expect(c.trust()).toBe('trusted');
    expect(c.removeSync()).toBe(true);
    expect(fs.existsSync(c.path)).toBe(false);
    expect(c.removeSync()).toBe(true);
  });

  it('refuses a symlink planted at the copy path and never writes through it', async () => {
    if (process.platform === 'win32') return;
    const target = path.join(dir, 'victim.txt');
    fs.writeFileSync(target, 'keep');
    fs.symlinkSync(target, path.join(dir, '.deck.bl-probe.html'));
    await expect(ProbeCopy.create(original(), '0123456789abcdef')).rejects.toBeInstanceOf(ProbeRefused);
    expect(fs.readFileSync(target, 'utf8')).toBe('keep');
    fs.unlinkSync(path.join(dir, '.deck.bl-probe.html'));
  });

  /**
   * A stand-in render view whose "DOM" is the probe copy as the mapper reads it: one text node per run,
   * located by {stamp or literal id, textIndex}. Enough to drive runProbe end to end with the real patcher.
   */
  function fakeView(copy: ProbeCopy): RenderView {
    let runs: { loc: NodeLocator; data: string }[] = [];
    const v = {
      async load() {
        const d = decodeDeck(await copy.read());
        const m = buildMap(d.src, { version: 'x', utf8: d.utf8 });
        runs = [
          ...m.runs.map((r) => ({ loc: { stamp: r.stamp, cssPath: `[data-bl-e="${r.stamp}"]`, childIndex: r.textIndex }, data: r.value })),
          ...m.literals.map((l) => ({ loc: { stamp: null, cssPath: `#lit-${l.unit}`, childIndex: l.runIndex }, data: l.value })),
        ];
      },
      async waitStable() {
        return { fontsReady: true, stillRunning: 0 };
      },
      async detect() {
        return { kind: 'single', count: 1, current: 0, titles: ['T'], navKind: 'none', designSize: { w: 1600, h: 900 } };
      },
      async find(needle: string): Promise<FindResult> {
        return { truncated: false, matches: runs.filter((r) => r.data.includes(needle)).map((r, i) => ({ key: i, locator: r.loc, node: { stamp: r.loc.stamp, textIndex: r.loc.childIndex, data: r.data }, visible: true, slide: 0 })) };
      },
      async locate(loc: NodeLocator): Promise<LocateResult> {
        const r = runs.find((x) => locatorKey(x.loc) === locatorKey(loc));
        return r ? { found: true, node: { key: 1, locator: loc, node: { stamp: loc.stamp, textIndex: loc.childIndex, data: r.data }, rect: { x: 0, y: 0, w: 1, h: 1 } }, visible: true, slide: 0 } : { found: false, node: null, visible: false, slide: null };
      },
      consoleErrors() {
        return [];
      },
    };
    return v as unknown as RenderView;
  }

  function countedNodes(): CountedNode[] {
    const map = buildMap(decodeDeck(bytes).src, { version, utf8: true });
    const matcher = createMatcher(map, { fileName: 'deck.html' });
    const out: CountedNode[] = [];
    let key = 1;
    for (const r of map.runs) {
      const dn = { stamp: r.stamp, textIndex: r.textIndex, data: r.value };
      out.push({ key: key++, slide: 0, stop: 0, locator: { stamp: r.stamp, cssPath: `[data-bl-e="${r.stamp}"]`, childIndex: r.textIndex }, node: dn, match: matcher(dn) });
    }
    for (const l of map.literals) {
      const dn = { stamp: null, textIndex: 0, data: l.value };
      out.push({ key: key++, slide: 0, stop: 0, locator: { stamp: null, cssPath: `#lit-${l.unit}`, childIndex: l.runIndex }, node: dn, match: matcher(dn) });
    }
    return out;
  }

  const editor: EditorModule = { editorVersion: 'test', createWriteQueue };

  async function probe(nodes: CountedNode[]) {
    const copy = await ProbeCopy.create(original(), '0123456789abcdef');
    try {
      const r = await runProbe({
        view: fakeView(copy),
        editor,
        copy,
        original: { bytes, version },
        nodes,
        slideCount: 1,
        baselineErrors: new Set(),
        normalize: (e) => e.message,
        start: async () => undefined,
        replay: async () => true,
        log: () => undefined,
        interrupted: () => false,
      });
      const after = new Uint8Array(fs.readFileSync(copy.path));
      return { r, after };
    } finally {
      copy.removeSync();
    }
  }

  it('appends the sentinel to every exact run, checks it, and undoes to the original bytes', async () => {
    const nodes = countedNodes();
    const exactNodes = nodes.filter((n) => n.match.confidence === 'exact');
    expect(exactNodes.length).toBeGreaterThanOrEqual(4);
    const { r, after } = await probe(nodes);
    expect(r.aborted).toBeNull();
    expect(r.runs).toBe(new Set(exactNodes.map((n) => n.match.runId)).size);
    for (const n of exactNodes) expect(n.probe).toEqual({ pass: true });
    expect(Buffer.compare(Buffer.from(after), Buffer.from(bytes))).toBe(0);
    expect(fs.readdirSync(dir).filter((f) => f.includes('bl-probe') || f.startsWith('.bl-write-'))).toEqual([]);
  });

  it('fails a node whose reported run is not where its text lives (a write to the wrong place)', async () => {
    const nodes = countedNodes();
    const h1 = nodes.find((n) => n.node.data.startsWith('R&D'))!;
    const p = nodes.find((n) => n.node.data.startsWith('Costs'))!;
    // Pretend the matcher mapped the heading to the paragraph's run.
    const lie: CountedNode = { ...h1, key: 999, node: { ...h1.node, data: p.node.data }, match: p.match };
    const { after } = await probe([...nodes, lie]);
    expect(lie.probe).toMatchObject({ pass: false, why: expect.stringContaining('not in the node') });
    expect(p.probe).toEqual({ pass: true });
    expect(Buffer.compare(Buffer.from(after), Buffer.from(bytes))).toBe(0);
  });

  it('fails every node of a run the patcher refuses, and leaves the copy as it was', async () => {
    const nodes = countedNodes().filter((n) => n.match.confidence === 'exact').slice(0, 1);
    // A beforeText that is not the run's text: the patcher's re-check refuses (9.2 Write protocol step 3).
    nodes[0] = { ...nodes[0], node: { ...nodes[0].node, data: 'not the run text' } };
    const { after } = await probe(nodes);
    expect(nodes[0].probe).toMatchObject({ pass: false, why: expect.stringContaining('patcher did not write') });
    expect(Buffer.compare(Buffer.from(after), Buffer.from(bytes))).toBe(0);
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
