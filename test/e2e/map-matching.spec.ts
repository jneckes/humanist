// `blueline map` on the reproduction decks of the review's matching findings (SPEC section 10, Phase 0 exit
// gate: "a node reported exact that fails the probe is a write to the wrong place, and must be fixed before
// Phase 1"). Each deck shows a text that an unrelated literal also holds, from a source the old matcher did
// not count (findings 0, 1, 3, 4), shifts a stamped element's text nodes (finding 2), or nests a cell run in a
// foster-parented run (finding 6). The real walk, matcher and mutation probe must report none of the named
// nodes `exact`, and no probe may fail.
//
// Stamped nodes are not asserted `exact` here: that depends on the walk's DomTextNode.texts (D-b), which the
// map command fills. Decks are copied to temp folders, so the probe copy never lands in the repository. Run
// with `npm run test:e2e` (global setup starts Xvfb on Linux).

import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const CLI = path.join(ROOT, 'packages/cli/dist/blueline.cjs');
const DECKS = path.join(ROOT, 'fixtures/matching');

test.skip(process.platform === 'linux' && !process.env.DISPLAY, 'needs a display: run through `npm run test:e2e` (its global setup starts Xvfb)');

const tmpDirs: string[] = [];
test.afterAll(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function copyDeck(name: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-map-matching-'));
  tmpDirs.push(d);
  const dst = path.join(d, `${name}.html`);
  fs.copyFileSync(path.join(DECKS, `${name}.html`), dst);
  return dst;
}

function sha256(p: string): string {
  return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

interface MapRun {
  slide: number | null;
  text: string;
  confidence: 'exact' | 'ambiguous' | 'none';
  reason?: string;
  probe?: 'pass' | 'fail';
}

function mapJson(deck: string): { code: number | null; runs: MapRun[]; report: { probe: { ran: boolean; failed: number } }; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, 'map', deck, '--report', '--json'], {
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const j = JSON.parse(r.stdout);
  return { code: r.status, runs: j.runs, report: j.report, stderr: r.stderr };
}

/** The deck's nodes with this exact text (each visible text node is counted once). */
function nodes(runs: MapRun[], text: string): MapRun[] {
  return runs.filter((r) => r.text === text);
}

const CASES: { deck: string; finding: string; notExact: string[]; control: string }[] = [
  {
    deck: 'shadow-sources',
    finding: '0: template clone, <title>, text/x-template, tagged template, aria-label and textarea text vs canvas labels',
    notExact: ['Revenue', 'Board review', 'Churn outlook', 'Hiring plan', 'Gross margin', 'Pipeline health'],
    control: 'Only the script says this',
  },
  { deck: 'adoption', finding: '1: text of an unclosed <em> reconstructed in the next <li>', notExact: ['Ship the beta'], control: 'Only the script says this' },
  { deck: 'unclosed-heading', finding: '1: <h2><em>Plan</h2><p>Details</p> and a contents list', notExact: ['Plan'], control: 'Only the script says this' },
  { deck: 'breadcrumb', finding: '2: a prepended text node shifts the separators’ textIndex', notExact: [' / '], control: 'Only the script says this' },
  { deck: 'numbers', finding: '3: computed numbers vs lone string literals', notExact: ['600', '1', '1,234'], control: '17.5%' },
  { deck: 'member-keys', finding: '4: member-assigned keys and quoted keys read by name', notExact: ['Bookings', 'Retention'], control: 'Only the script says this' },
  { deck: 'foster-table', finding: '6: a cell inside a foster-parented run', notExact: ['Cell one'], control: 'Only the script says this' },
  { deck: 'split-chars', finding: 'real decks with motion: a heading split per letter, and an unrelated literal \'A\' (reason split)', notExact: ['A'], control: 'Only the script says this' },
  { deck: 'chrome-rewrite', finding: 'real decks: the engine rewrites its slide number and label after load (DomTextNode.touched)', notExact: ['01', 'Cover', '/ 03'], control: 'Plan for growth' },
];

for (const c of CASES) {
  test(`${c.deck}.html (finding ${c.finding}): no named node is exact, and no probe fails`, async () => {
    test.setTimeout(300_000);
    const deck = copyDeck(c.deck);
    const before = sha256(deck);
    const r = mapJson(deck);
    expect(r.code, r.stderr.slice(-2000)).toBe(0);
    expect(r.report.probe.ran).toBe(true);
    expect(r.report.probe.failed).toBe(0);
    expect(r.runs.filter((x) => x.probe === 'fail').map((x) => x.text)).toEqual([]);
    for (const text of c.notExact) {
      const found = nodes(r.runs, text);
      expect(found.length, `${JSON.stringify(text)} is on the page`).toBeGreaterThan(0);
      for (const n of found) expect(n.confidence, `${JSON.stringify(text)}: ${n.reason ?? ''}`).not.toBe('exact');
    }
    // Positive control: text only one literal holds is still exact, and the probe wrote and checked it.
    const control = nodes(r.runs, c.control);
    expect(control.length).toBeGreaterThan(0);
    for (const n of control) expect(n).toMatchObject({ confidence: 'exact', probe: 'pass' });
    expect(sha256(deck)).toBe(before);
    expect(fs.readdirSync(path.dirname(deck)).filter((f) => f.includes('.bl-probe.') || f.startsWith('.bl-write-'))).toEqual([]);
  });
}
