// `blueline map` through the real command (SPEC section 10, Phase 0: map steps 1–5 and the mutation probe;
// section 11, Coverage baseline). The CLI launches the app headless; the app walks the deck in an offscreen
// render view and probes every exact node through the real patcher on a hidden copy.
//
// Decks are copied to temp folders first, so the probe copy (`.<name>.bl-probe.html`) never lands in the
// repository and runs never collide. Run with `npm run test:e2e` (global setup starts Xvfb on Linux).

import { expect, test } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const CLI = path.join(ROOT, 'packages/cli/dist/blueline.cjs');
const APP_DIST = path.join(ROOT, 'packages/app/dist');
const DECKS = path.join(ROOT, 'fixtures/decks');
const EXPECTED = path.join(ROOT, 'fixtures/expected');

test.skip(process.platform === 'linux' && !process.env.DISPLAY, 'needs a display: run through `npm run test:e2e` (its global setup starts Xvfb)');

const tmpDirs: string[] = [];
test.afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/** Copies a fixture deck (a file, or reveal-hash's folder) to a fresh temp folder; returns the deck's path there. */
function copyDeck(name: string): string {
  const d = tmp('bl-map-e2e-');
  if (name === 'reveal-hash') {
    fs.cpSync(path.join(DECKS, 'reveal-hash'), d, { recursive: true });
    fs.rmSync(path.join(d, 'index.expect.json'), { force: true });
    return path.join(d, 'index.html');
  }
  const dst = path.join(d, `${name}.html`);
  fs.copyFileSync(path.join(DECKS, `${name}.html`), dst);
  // A deck's own sibling script (csp-self-inline.js, csp-nonce-strict-dynamic.js): what the fixture tests.
  const js = path.join(DECKS, `${name}.js`);
  if (fs.existsSync(js)) fs.copyFileSync(js, path.join(d, `${name}.js`));
  return dst;
}

function sha256(p: string): string {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function map(args: string[], env: Record<string, string> = {}): Run {
  const r = spawnSync(process.execPath, [CLI, 'map', ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 600_000, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Files in a deck's folder that the probe may leave behind (its copy, or the atomic writer's temp files). */
function leftovers(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => f.includes('.bl-probe.') || f.startsWith('.bl-write-'));
}

test('entities.html: every exact node passes the probe, the copy is removed and the original is untouched', async () => {
  test.setTimeout(300_000);
  const deck = copyDeck('entities');
  const before = sha256(deck);
  const r = map([deck, '--report', '--json']);
  expect(r.code, r.stderr.slice(-2000)).toBe(0);
  const j = JSON.parse(r.stdout);
  expect(j.deckSha).toBe(before);
  expect(j.coverage).toEqual({ exact: 38, ambiguous: 0, none: 6, total: 44 });
  expect(j.runs).toHaveLength(44);
  expect(j.runs[0]).toEqual(expect.objectContaining({ slide: 0, confidence: 'exact', strategy: 'html-text', probe: 'pass' }));
  expect(typeof j.runs[0].start).toBe('number');
  expect(j.report.probe).toMatchObject({ ran: true, passed: 38, failed: 0, originalUnchanged: true, copyRemoved: true });
  expect(j.report.slides).toMatchObject({ kind: 'generic', count: 6, reached: 6, keys: 'input' });
  expect(j.report.nonExact.every((n: { reason: string }) => n.reason === 'computed')).toBe(true);
  expect(sha256(deck)).toBe(before);
  expect(leftovers(path.dirname(deck))).toEqual([]);

  const t = map([deck, '--report']);
  expect(t.code).toBe(0);
  expect(t.stdout).toContain('Coverage: 38 of 44 (86.4%) map exact and pass the mutation probe');
  expect(t.stdout).toContain('Per slide');
  expect(t.stdout).toMatch(/Not exact \(6\)/);
});

test('--min-coverage sets the exit code', async () => {
  test.setTimeout(300_000);
  const single = map([copyDeck('single'), '--min-coverage', '0.95']);
  expect(single.code, single.stderr.slice(-2000)).toBe(0);
  expect(single.stdout).toContain('Minimum coverage 95.0%: met');
  const js = map([copyDeck('js-templates'), '--min-coverage', '0.95']);
  expect(js.code).toBe(1);
  expect(js.stdout).toContain('Minimum coverage 95.0%: NOT met');
});

test('a windows-1252 deck: every node none (not-utf8), no probe, never written', async () => {
  test.setTimeout(120_000);
  const deck = copyDeck('windows-1252');
  const before = sha256(deck);
  const r = map([deck, '--report', '--json']);
  expect(r.code, r.stderr.slice(-2000)).toBe(0);
  const j = JSON.parse(r.stdout);
  expect(j.coverage.exact).toBe(0);
  expect(j.coverage.total).toBeGreaterThan(0);
  expect(j.runs.every((x: { confidence: string; reason: string }) => x.confidence === 'none' && x.reason === 'not-utf8')).toBe(true);
  expect(j.report.probe.ran).toBe(false);
  expect(j.report.probe.why).toContain('not UTF-8');
  expect(sha256(deck)).toBe(before);
  expect(leftovers(path.dirname(deck))).toEqual([]);
});

test('a probe copy already next to the deck is never overwritten', async () => {
  test.setTimeout(120_000);
  const deck = copyDeck('single');
  const stale = path.join(path.dirname(deck), '.single.bl-probe.html');
  fs.writeFileSync(stale, 'someone else’s file');
  const r = map([deck, '--json']);
  const j = JSON.parse(r.stdout);
  expect(j.report.probe.ran).toBe(false);
  expect(j.report.probe.why).toContain('already exists');
  expect(j.report.coverage.verified).toBe(false);
  expect(fs.readFileSync(stale, 'utf8')).toBe('someone else’s file');
  // Unverified coverage cannot pass a gate.
  expect(map([deck, '--min-coverage', '0.5']).code).toBe(1);
});

test('Ctrl+C during the probe removes the probe copy and leaves the original untouched', async () => {
  test.setTimeout(180_000);
  const deck = copyDeck('reveal-hash');
  const dir = path.dirname(deck);
  const before = sha256(deck);
  // Its own process group, as a terminal's foreground job: Ctrl+C reaches every process in it.
  const child = spawn(process.execPath, [CLI, 'map', deck, '--report'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  let out = '';
  child.stdout.on('data', (b: Buffer) => (out += b.toString('utf8')));
  const exited = new Promise<number | null>((r) => child.once('close', (code) => r(code)));
  const copy = path.join(dir, '.index.bl-probe.html');
  const end = Date.now() + 120_000;
  while (!fs.existsSync(copy) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  expect(fs.existsSync(copy)).toBe(true);
  await new Promise((r) => setTimeout(r, 1500));
  process.kill(-child.pid!, 'SIGINT');
  const code = await exited;
  expect(code).not.toBe(0);
  expect(out).toContain('interrupted (SIGINT)');
  expect(fs.existsSync(copy)).toBe(false);
  expect(leftovers(dir)).toEqual([]);
  expect(sha256(deck)).toBe(before);
});

test('a reader-only build (no editor.cjs) reports without the probe and says so', async () => {
  test.setTimeout(180_000);
  // A copy of the built app without the Edit capability, launched through the CLI's BLUELINE_APP_DIR.
  const app = tmp('bl-reader-only-');
  fs.copyFileSync(path.join(ROOT, 'packages/app/package.json'), path.join(app, 'package.json'));
  fs.cpSync(APP_DIST, path.join(app, 'dist'), { recursive: true, filter: (src) => !/editor\.cjs(\.map)?$/.test(src) });
  const electron = spawnSync(process.execPath, ['-e', "process.stdout.write(require('electron'))"], { cwd: path.join(ROOT, 'packages/app'), encoding: 'utf8' }).stdout;
  const deck = copyDeck('single');
  const r = map([deck, '--json'], { BLUELINE_ELECTRON: electron, BLUELINE_APP_DIR: app });
  expect(r.code, r.stderr.slice(-2000)).toBe(0);
  const j = JSON.parse(r.stdout);
  expect(j.report.probe.ran).toBe(false);
  expect(j.report.probe.why).toContain('reader-only build');
  expect(j.report.coverage.verified).toBe(false);
  expect(j.coverage.exact).toBe(21);
  expect(leftovers(path.dirname(deck))).toEqual([]);
  const t = map([deck], { BLUELINE_ELECTRON: electron, BLUELINE_APP_DIR: app });
  expect(t.stdout).toContain('NOT verified: reader-only build');
});

interface Expect {
  kind?: string;
  slides?: number;
  navKind?: string;
  titles?: string[];
  expect: { text: string; confidence: string; strategy?: string | null; reason?: string; slide?: number; candidates?: number; hiddenUntil?: string }[];
}

interface MapJson {
  coverage: { exact: number; ambiguous: number; none: number; total: number };
  runs: { slide: number; text: string; strategy: string | null; confidence: string; reason?: string; probe?: string }[];
  report: {
    slides: { kind: string; navKind: string; count: number; reached: number };
    perSlide: { title: string }[];
    nonExact: { slide: number; text: string; candidates: number }[];
    probe: { failures?: { slide: number; text: string; why: string }[] };
  };
}

/**
 * What a fixture is meant to test (fixtures/README.md, The .expect.json format) against a `map --json`
 * result (section 10 Exit gate: the synthetic and CSP fixtures' confidences are checked against their
 * intent). An entry applies to every counted node whose data equals its text (on its slide, when given).
 */
function intentProblems(ex: Expect, j: MapJson): string[] {
  const out: string[] = [];
  const s = j.report.slides;
  if (ex.kind && s.kind !== ex.kind) out.push(`kind ${s.kind}, expected ${ex.kind}`);
  if (ex.slides !== undefined && s.count !== ex.slides) out.push(`${s.count} slides, expected ${ex.slides}`);
  if (ex.navKind && s.navKind !== ex.navKind) out.push(`navigation ${s.navKind}, expected ${ex.navKind}`);
  if (s.reached !== s.count) out.push(`the walk reached ${s.reached} of ${s.count} slides`);
  const titles = j.report.perSlide.map((p) => p.title);
  if (ex.titles && JSON.stringify(titles) !== JSON.stringify(ex.titles)) out.push(`titles ${JSON.stringify(titles)}`);
  for (const e of ex.expect) {
    const hits = j.runs.filter((r) => r.text === e.text && (e.slide === undefined || r.slide === e.slide));
    const label = JSON.stringify(e.text.slice(0, 60));
    if (e.hiddenUntil) {
      if (hits.length > 0) out.push(`${label} is counted, but should be hidden (${e.hiddenUntil})`);
      continue;
    }
    if (hits.length === 0) {
      out.push(`${label}: no counted node`);
      continue;
    }
    for (const h of hits) {
      const bad: string[] = [];
      if (h.confidence !== e.confidence) bad.push(`${h.confidence}, expected ${e.confidence}`);
      if (e.confidence === 'exact' && e.strategy && h.strategy !== e.strategy) bad.push(`strategy ${h.strategy}, expected ${e.strategy}`);
      if (e.reason && h.reason !== e.reason) bad.push(`reason ${h.reason}, expected ${e.reason}`);
      if (h.confidence === 'exact' && h.probe !== 'pass') bad.push(`probe ${h.probe}`);
      if (e.candidates !== undefined) {
        const ne = j.report.nonExact.find((x) => x.text === e.text && x.slide === h.slide);
        if (!ne || ne.candidates !== e.candidates) bad.push(`${ne?.candidates} candidates, expected ${e.candidates}`);
      }
      if (bad.length > 0) out.push(`${label} on slide ${h.slide + 1}: ${bad.join('; ')}`);
    }
  }
  // Section 10 Exit gate: a node reported exact that fails the probe is a write to the wrong place.
  for (const f of j.report.probe.failures ?? []) out.push(`probe failure on slide ${f.slide + 1}, ${JSON.stringify(f.text)}: ${f.why}`);
  return out;
}

test('coverage baselines and fixture intents: no committed deck drops more than 1 point below fixtures/expected, and every .expect.json entry holds', async () => {
  test.setTimeout(1_800_000);
  const failures: string[] = [];
  for (const f of fs.readdirSync(EXPECTED).filter((x) => x.endsWith('.json')).sort()) {
    const name = f.slice(0, -'.json'.length);
    const base = JSON.parse(fs.readFileSync(path.join(EXPECTED, f), 'utf8'));
    const src = name === 'reveal-hash' ? path.join(DECKS, 'reveal-hash/index.html') : path.join(DECKS, `${name}.html`);
    if (sha256(src) !== base.deckSha) {
      failures.push(`${name}: the deck changed since its baseline; regenerate fixtures/expected/${f} in a commit that says why`);
      continue;
    }
    const r = map([copyDeck(name), '--json']);
    let j: MapJson;
    try {
      j = JSON.parse(r.stdout);
    } catch {
      failures.push(`${name}: no JSON (exit ${r.code}) ${r.stderr.slice(-500)}`);
      continue;
    }
    const share = (c: { exact: number; total: number }) => (c.total === 0 ? 0 : c.exact / c.total);
    const now = share(j.coverage);
    const was = share(base.coverage);
    if (now < was - 0.01) failures.push(`${name}: coverage ${(now * 100).toFixed(1)}% is more than 1 point below its baseline ${(was * 100).toFixed(1)}%`);
    const exFile = name === 'reveal-hash' ? path.join(DECKS, 'reveal-hash/index.expect.json') : path.join(DECKS, `${name}.expect.json`);
    if (fs.existsSync(exFile)) {
      for (const p of intentProblems(JSON.parse(fs.readFileSync(exFile, 'utf8')) as Expect, j)) failures.push(`${name}: ${p}`);
    } else failures.push(`${name}: no ${path.relative(ROOT, exFile)}`);
  }
  expect(failures).toEqual([]);
});

test('a deck that calls alert() and confirm() and holds beforeunload neither hangs the run nor fails the probe', async () => {
  test.setTimeout(120_000);
  // Hidden render windows turn dialogs off (they would block the page, and app.exit, forever), and a load's
  // console errors start at its commit (the previous page's blocked beforeunload prompt is not a new error).
  const d = tmp('bl-map-dialogs-');
  const deck = path.join(d, 'dialogs.html');
  fs.writeFileSync(
    deck,
    '<!doctype html><html><head><meta charset="utf-8"><title>Dialogs</title></head><body><h1>Hello dialogs</h1><p>Body text.</p>' +
      "<script>alert('hi'); confirm('sure?'); addEventListener('beforeunload', function (e) { e.preventDefault(); e.returnValue = 'stay'; });</script></body></html>",
  );
  const t0 = Date.now();
  const r = map([deck, '--json']);
  expect(r.code, r.stderr.slice(-2000)).toBe(0);
  expect(Date.now() - t0).toBeLessThan(60_000);
  const j = JSON.parse(r.stdout);
  expect(j.coverage).toEqual({ exact: 2, ambiguous: 0, none: 0, total: 2 });
  expect(j.report.probe).toMatchObject({ passed: 2, failed: 0, originalUnchanged: true, copyRemoved: true });
});
