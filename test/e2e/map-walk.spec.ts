// `blueline map` on the reproduction decks of the review's walk and probe findings (SPEC section 10, Phase 0:
// map steps 3-5, the mutation probe and the exit gate; section 11 Coverage baseline; PHASE0-FINDINGS F13,
// F17). Each deck is a copy of the reviewer's deck in fixtures/map/ (see fixtures/README.md):
//   - builds: a walk that stops on slide 1 is incomplete coverage, never a met gate (finding 28, D-j);
//   - resume, firstvisit: every probe load gets a fresh origin and starts from slide 1 (finding 30);
//   - hiddendup, reveal-fragment: a sentinel in a hidden node the walk never counted fails the node, while
//     reveal.js's clipped live region is still skipped (finding 31, F17);
//   - shadow, sentinel-shadow, sentinel-frame, crossframe: open shadow roots and same-origin frames are
//     walked and searched, their text is none (subdocument), and cross-origin frames are listed (finding 32);
//   - stopimm: a page window-capture listener cannot hide trusted keys from the walk (finding 33);
//   - longscroll, longsingle: scrolling and single-page walks cover the whole document height (finding 34);
//   - shortend, manyshort: short blocks are reached and their nodes counted on their own block (finding 35).
//
// Decks are copied to temp folders, so the probe copy never lands in the repository. Run with
// `npm run test:e2e` (global setup starts Xvfb on Linux). BL_E2E_APP_DIR runs the maps with another build of
// the app (a folder with package.json and dist/), e.g. a copy of the build before a fix.

import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const CLI = path.join(ROOT, 'packages/cli/dist/blueline.cjs');
const MAP_DECKS = path.join(ROOT, 'fixtures/map');
const DECKS = path.join(ROOT, 'fixtures/decks');

test.skip(process.platform === 'linux' && !process.env.DISPLAY, 'needs a display: run through `npm run test:e2e` (its global setup starts Xvfb)');
test.describe.configure({ mode: 'parallel' });

const tmpDirs: string[] = [];
test.afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A fixtures/map deck in a fresh temp folder (with reveal.js's vendor folder when the deck needs it). */
function copyDeck(name: string, from = MAP_DECKS): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-map-walk-'));
  tmpDirs.push(d);
  const dst = path.join(d, `${name}.html`);
  fs.copyFileSync(path.join(from, `${name}.html`), dst);
  if (fs.readFileSync(dst, 'utf8').includes('vendor/reveal.js')) fs.cpSync(path.join(DECKS, 'reveal-hash/vendor'), path.join(d, 'vendor'), { recursive: true });
  return dst;
}

function sha256(p: string): string {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function appEnv(): Record<string, string> {
  const dir = process.env.BL_E2E_APP_DIR;
  if (!dir) return {};
  const electron = spawnSync(process.execPath, ['-e', "process.stdout.write(require('electron'))"], { cwd: path.join(ROOT, 'packages/app'), encoding: 'utf8' }).stdout;
  return { BLUELINE_APP_DIR: dir, BLUELINE_ELECTRON: electron };
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function map(args: string[]): Run {
  // An empty app-data folder per run: the command reads config.json for Settings › Trust (command-trust.ts), and
  // the runner's own Blueline settings must not change what is tested.
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-map-walk-ud-'));
  try {
    const r = spawnSync(process.execPath, [CLI, 'map', ...args], { encoding: 'utf8', env: { ...process.env, ...appEnv(), BLUELINE_USER_DATA: userData }, timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

interface MapJson {
  coverage: { exact: number; ambiguous: number; none: number; total: number; slides?: { count: number; reached: number } };
  runs: { slide: number; text: string; confidence: string; reason?: string; probe?: string }[];
  report: {
    slides: { kind: string; count: number; reached: number; keys: string | null; notes: string[] };
    perSlide: { slide: number; total: number; reached: boolean }[];
    totals: { exact: number; ambiguous: number; none: number; total: number };
    coverage: { complete?: boolean };
    probe: { ran: boolean; nodes: number; passed: number; failed: number; failures: { slide: number; text: string; why: string }[]; originalUnchanged: boolean | null; copyRemoved: boolean | null };
    uncounted?: { crossOriginFrames: number };
  };
}

/** `map <copy of deck> --report --json`: the exit code, the JSON, and the original left untouched. */
function mapJson(deck: string): { code: number | null; j: MapJson; stderr: string } {
  const before = sha256(deck);
  const r = map([deck, '--report', '--json']);
  let j: MapJson;
  try {
    j = JSON.parse(r.stdout) as MapJson;
  } catch {
    throw new Error(`no JSON (exit ${r.code}): ${r.stderr.slice(-2000)}`);
  }
  expect(sha256(deck)).toBe(before);
  expect(fs.readdirSync(path.dirname(deck)).filter((f) => f.includes('.bl-probe.') || f.startsWith('.bl-write-'))).toEqual([]);
  return { code: r.code, j, stderr: r.stderr };
}

const failureFor = (j: MapJson, text: string) => j.report.probe.failures.find((f) => f.text === text);

// ------------------------------------------------------------------------------------------- finding 28

test('builds.html: key-gated build steps are walked through and counted, and the probe replays them (D-j; real decks)', async () => {
  // Slide 1 shows two build points, one per key press, before ArrowRight moves the deck. The walk collects
  // after every press that changes nothing (it may show a build step), presses again, and reaches all five
  // slides; the probe's replay makes the same presses, so the build points are checked like any text.
  test.setTimeout(300_000);
  const deck = copyDeck('builds');
  const { code, j, stderr } = mapJson(deck);
  expect(j.report.slides).toMatchObject({ kind: 'generic', count: 5, reached: 5 });
  expect(j.coverage.slides).toEqual({ count: 5, reached: 5 });
  expect(j.report.coverage.complete).toBe(true);
  for (const text of ['First build point', 'Second build point']) {
    const n = j.runs.filter((r) => r.text === text);
    expect(n.length, `${text} is counted`).toBe(1);
    expect(n[0]).toMatchObject({ slide: 0, confidence: 'exact', probe: 'pass' });
  }
  expect(j.report.probe.failures).toEqual([]);
  expect(code, stderr.slice(-2000)).toBe(0);
});

// ------------------------------------------------------------------------------------------- finding 30

for (const [name, nodes] of [
  ['resume', 8],
  ['firstvisit', 3],
] as const) {
  test(`${name}.html: every probe load gets a fresh origin and starts on slide 1, so every exact node passes (finding 30)`, async () => {
    test.setTimeout(300_000);
    const { code, j, stderr } = mapJson(copyDeck(name));
    expect(j.report.probe.failures).toEqual([]);
    expect(j.report.probe).toMatchObject({ ran: true, nodes, passed: nodes, failed: 0, originalUnchanged: true, copyRemoved: true });
    expect(j.report.slides.reached).toBe(j.report.slides.count);
    expect(code, stderr.slice(-2000)).toBe(0);
  });
}

// ------------------------------------------------------------------------------------------- finding 31

test('hiddendup.html: the sentinel also lands in a display:none copy the walk never counted, so the heading fails the probe (finding 31)', async () => {
  test.setTimeout(300_000);
  const { code, j } = mapJson(copyDeck('hiddendup'));
  const f = failureFor(j, 'Quarterly results for the board');
  expect(f?.why).toContain('does not count');
  expect(f?.why).toContain('Quarterly results for the board⟦bl⟧');
  expect(j.report.probe.failed).toBe(1);
  expect(code).toBe(1);
});

test('reveal-fragment.html: a sentinel in an opacity-0 fragment fails the heading, while reveal-hash (clipped live region) still passes (finding 31, F17)', async () => {
  test.setTimeout(400_000);
  const frag = mapJson(copyDeck('reveal-fragment'));
  expect(failureFor(frag.j, 'Grow revenue by forty percent')?.why).toContain('does not count');
  expect(frag.j.report.probe.failed).toBe(1);
  expect(frag.code).toBe(1);
  // The committed reveal.js fixture: .aria-status repeats every slide's text, clipped to a zero area.
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-map-walk-'));
  tmpDirs.push(d);
  fs.cpSync(path.join(DECKS, 'reveal-hash'), d, { recursive: true });
  fs.rmSync(path.join(d, 'index.expect.json'), { force: true });
  const rh = mapJson(path.join(d, 'index.html'));
  expect(rh.j.report.probe.failures).toEqual([]);
  expect(rh.j.report.probe.passed).toBe(rh.j.report.probe.nodes);
  expect(rh.code, rh.stderr.slice(-2000)).toBe(0);
});

// ------------------------------------------------------------------------------------------- finding 32

test('shadow.html: open shadow-root and srcdoc-frame text is counted as none (subdocument), never probed (finding 32)', async () => {
  test.setTimeout(300_000);
  const { code, j, stderr } = mapJson(copyDeck('shadow'));
  const sub = j.runs.filter((r) => r.reason === 'subdocument').map((r) => r.text);
  expect(sub.sort()).toEqual(['$48M', 'Annual recurring revenue', 'Second iframe paragraph.', 'Shadow paragraph written by a component', 'Text inside a srcdoc iframe, visible to the reader.']);
  expect(j.runs.filter((r) => r.reason === 'subdocument').every((r) => r.confidence === 'none' && r.probe === undefined)).toBe(true);
  expect(j.report.totals).toEqual({ exact: 2, ambiguous: 0, none: 5, total: 7 });
  expect(j.report.probe).toMatchObject({ nodes: 2, passed: 2, failed: 0 });
  expect(code, stderr.slice(-2000)).toBe(0);
});

for (const [name, where] of [
  ['sentinel-shadow', 'shadow root'],
  ['sentinel-frame', 'frame'],
] as const) {
  test(`${name}.html: a sentinel that lands in a ${where} fails the probed node (finding 32)`, async () => {
    test.setTimeout(300_000);
    const { code, j } = mapJson(copyDeck(name));
    expect(j.runs.find((r) => r.text === 'Quarterly revenue grew this year')).toMatchObject({ confidence: 'none', reason: 'subdocument' });
    const f = failureFor(j, 'Quarterly revenue grew');
    expect(f?.why).toContain(where);
    expect(f?.why).toContain('Quarterly revenue grew⟦bl⟧ this year');
    expect(code).toBe(1);
  });
}

test('crossframe.html: a visible cross-origin frame is listed as uncounted visible content (finding 32)', async () => {
  test.setTimeout(300_000);
  const deck = copyDeck('crossframe');
  const { code, j, stderr } = mapJson(deck);
  expect(j.report.uncounted).toEqual({ crossOriginFrames: 1 });
  expect(j.report.totals.total).toBe(2);
  expect(code, stderr.slice(-2000)).toBe(0);
  expect(map([deck]).stdout).toContain('Uncounted visible content: 1 cross-origin frame');
});

// ------------------------------------------------------------------------------------------- finding 33

test('stopimm.html: a page window-capture listener that stops every keydown cannot make the walk fall back to synthetic keys (finding 33)', async () => {
  test.setTimeout(300_000);
  const { code, j, stderr } = mapJson(copyDeck('stopimm'));
  expect(j.report.slides).toMatchObject({ count: 5, reached: 5, keys: 'input' });
  expect(j.report.probe).toMatchObject({ nodes: 5, passed: 5, failed: 0 });
  expect(code, stderr.slice(-2000)).toBe(0);
});

// ------------------------------------------------------------------------------------------- finding 34

for (const [name, kind, total] of [
  ['longscroll', 'scroll', 83],
  ['longsingle', 'single', 81],
] as const) {
  test(`${name}.html: the ${kind} walk scrolls through the whole document and counts all ${total} text nodes once (finding 34, D-j)`, async () => {
    test.setTimeout(600_000);
    const { code, j, stderr } = mapJson(copyDeck(name));
    expect(j.report.slides.kind).toBe(kind);
    expect(j.report.totals).toEqual({ exact: total, ambiguous: 0, none: 0, total });
    expect(new Set(j.runs.map((r) => r.text)).size).toBe(total);
    expect(j.report.probe).toMatchObject({ nodes: total, passed: total, failed: 0 });
    expect(code, stderr.slice(-2000)).toBe(0);
  });
}

// ------------------------------------------------------------------------------------------- finding 35

for (const [name, blocks] of [
  ['shortend', 5],
  ['manyshort', 12],
] as const) {
  test(`${name}.html: every short block is reached and its nodes are counted on its own block (finding 35)`, async () => {
    test.setTimeout(300_000);
    const { code, j, stderr } = mapJson(copyDeck(name));
    expect(j.report.slides).toMatchObject({ kind: 'scroll', count: blocks, reached: blocks });
    expect(j.report.perSlide.map((s) => [s.total, s.reached])).toEqual(Array.from({ length: blocks }, () => [2, true]));
    expect(j.report.slides.notes.filter((n) => n.includes('never shown'))).toEqual([]);
    expect(code, stderr.slice(-2000)).toBe(0);
  });
}
