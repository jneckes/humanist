#!/usr/bin/env node
// Self-test of the Chromium fuzz gate (scripts/fuzz.mjs; P2-16; Phase 2 review findings 25 and 26): a gate that
// cannot fail proves nothing. Each case runs the gate on one synthetic deck of test/fuzz/selftest/decks (never part
// of the gate's corpus) with a fixed seed, and the gate must exit 1 with a failure of the expected kind; the
// control runs a plain committed deck and must exit 0 with nothing failed or left unprobed. The decks and what each
// case shows are in test/fuzz/selftest/README.md; the sorted.html cases must PASS (a gate must not fail a correct
// edit either). Needs `npm run build` first, as the gate does.
//
//   node scripts/fuzz-selftest.mjs [--only name,…] [--work <dir>] [--fuzz <script>]
//
// --fuzz runs another copy of the gate script (to show that these cases pass a gate without the fixes). The seeds
// draw the same edits only for the same deck label, which is the deck's path from the repository root: a deck
// moved elsewhere needs its seeds found again.
//
// Exit 0 when every case behaved as expected, 1 when one did not, 2 on a usage error.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DECKS = 'test/fuzz/selftest/decks';

/**
 * `code` is the gate's exit code; `tag` must match the `what` of at least one failure (and `min` failures at least);
 * `batch`, when set, is the gate's --batch (edits per round; the gate's default otherwise).
 * Seeds were chosen so that the gate before the fixes exits 0 on every failing case (recorded in the README).
 */
const CASES = [
  // Finding 25: the author types in a node the run does not feed; the write lands in the run's other render.
  { name: 'wrongplace-8', deck: `${DECKS}/wrongplace.html`, seed: 8, edits: 2, code: 1, tag: /^\[render\] after the edit the node the author typed in \(#a\) reads "Quarterly total"/ },
  { name: 'wrongplace-6', deck: `${DECKS}/wrongplace.html`, seed: 6, edits: 2, code: 1, tag: /^\[render\] after the edit the node the author typed in \(#a\) reads "Quarterly total"/ },
  { name: 'twofeed-5', deck: `${DECKS}/twofeed.html`, seed: 5, edits: 4, code: 1, tag: /^\[render\] after the edit the node the author typed in \(#calc\) reads "Net revenue grew"/ },
  { name: 'twofeed-1', deck: `${DECKS}/twofeed.html`, seed: 1, edits: 4, code: 1, tag: /^\[render\] after the edit the node the author typed in \(#calc\) reads "Net revenue grew"/ },
  // Finding 25: a render the deck transforms (cut short) is the node the author typed in; the whole one is elsewhere.
  { name: 'trunc-7', deck: `${DECKS}/trunc.html`, seed: 7, edits: 2, code: 1, tag: /^\[render\] after the edit the node the author typed in \(#nav\) reads ".*\.\.\."/ },
  // Finding 26 (b): every edit of the round makes the script throw, so the page shows no text at all; nothing is left
  // to probe, and the round's walk must still be compared with the walk before it.
  { name: 'throw-all-1', deck: `${DECKS}/throw-all.html`, seed: 1, edits: 10, code: 1, tag: /^\[probe\] new console error after the round's edits: Uncaught Error: bad label/, min: 2 },
  { name: 'throw-all-2', deck: `${DECKS}/throw-all.html`, seed: 2, edits: 10, code: 1, tag: /^\[probe\] new console error after the round's edits: Uncaught Error: bad label/, min: 2 },
  { name: 'throw-mixed-1', deck: `${DECKS}/throw-mixed.html`, seed: 1, edits: 10, code: 1, tag: /^\[probe\] new console error after the round's edits: Uncaught Error: bad label/, min: 2 },
  // Finding 26 (a): an edit written correctly whose label the deck then shows nowhere is probed on its own and fails.
  { name: 'vanish2-2', deck: `${DECKS}/vanish2.html`, seed: 2, edits: 20, code: 1, tag: /^\[probe\] the edit shows nowhere: /, min: 2 },
  // Finding 25, re-verification: a deck that sorts the labels it renders moves an edited label to another node; the
  // edit is written right and shows, so the gate must pass (it failed with a false '[render]' before the fix).
  { name: 'sorted-1', deck: `${DECKS}/sorted.html`, seed: 1, edits: 8, code: 0 },
  { name: 'sorted-6', deck: `${DECKS}/sorted.html`, seed: 6, edits: 8, code: 0 },
  // The same, with the labels also listed cut short in a second list: an edit typed in the short list whose label
  // moves shows whole only in the other list. The node the author typed in never shows it, so it fails; the other
  // list's render must not stand in for it (the repair's re-verification). One edit per round (--batch 1).
  { name: 'sortrunc-2', deck: `${DECKS}/sortrunc.html`, seed: 2, edits: 8, batch: 1, code: 1, tag: /^\[render\] after the edit the node the author typed in \(#nav > li:nth-of-type\(\d+\)\) reads "Plan [A-H]", not the new text/ },
  { name: 'sortrunc-7', deck: `${DECKS}/sortrunc.html`, seed: 7, edits: 8, batch: 1, code: 1, tag: /^\[render\] after the edit the node the author typed in \(#nav > li:nth-of-type\(\d+\)\) reads "Plan [A-H]", not the new text/ },
  // The control: the gate passes a deck that renders what is written.
  { name: 'control-single', deck: 'fixtures/decks/single.html', seed: 1, edits: 10, code: 0 },
];

function usage(msg) {
  if (msg) console.error(`fuzz-selftest: ${msg}`);
  console.error('usage: node scripts/fuzz-selftest.mjs [--only name,…] [--work <dir>] [--fuzz <script>]');
  process.exit(2);
}

function parseArgs(argv) {
  const o = { only: null, work: join(ROOT, 'test-results/fuzz-selftest'), fuzz: join(ROOT, 'scripts/fuzz.mjs') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i] ?? usage(`${a} needs a value`);
    if (a === '--only') o.only = val().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--work') o.work = resolve(val());
    else if (a === '--fuzz') o.fuzz = resolve(val());
    else if (a === '-h' || a === '--help') usage();
    else usage(`unknown argument ${a}`);
  }
  return o;
}

function run(script, args) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code, signal) => done({ code: code ?? (signal ? 128 : 1), out }));
  });
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const cases = o.only ? CASES.filter((c) => o.only.includes(c.name)) : CASES;
  if (cases.length === 0) usage('no such case');
  if (!existsSync(o.fuzz)) usage(`${o.fuzz} is missing`);
  mkdirSync(o.work, { recursive: true });
  let bad = 0;
  for (const c of cases) {
    const work = join(o.work, c.name);
    const out = join(o.work, `${c.name}.json`);
    rmSync(out, { force: true });
    const t0 = Date.now();
    const r = await run(o.fuzz, ['--decks', c.deck, '--seed', String(c.seed), '--edits', String(c.edits), ...(c.batch ? ['--batch', String(c.batch)] : []), '--work', work, '--out', out]);
    let result = null;
    try {
      result = JSON.parse(readFileSync(out, 'utf8'));
    } catch {
      result = null;
    }
    const why = [];
    if (r.code !== c.code) why.push(`exit ${r.code}, expected ${c.code}`);
    if (!result) why.push('no result file');
    else if (c.code === 0) {
      if (result.totals.failures !== 0 || result.totals.unprobed !== 0) why.push(`${result.totals.failures} failures, ${result.totals.unprobed} unprobed`);
    } else {
      const hits = result.failures.filter((f) => c.tag.test(String(f.what)));
      if (hits.length < (c.min ?? 1)) why.push(`${hits.length} failure(s) match ${c.tag} (want ${c.min ?? 1}); failures: ${result.failures.map((f) => String(f.what).slice(0, 120)).join(' | ') || 'none'}`);
    }
    const t = result?.totals;
    const line = `${why.length ? 'FAIL' : 'ok  '} ${c.name.padEnd(16)} seed ${String(c.seed).padStart(2)} edits ${String(c.edits).padStart(2)}: exit ${r.code}${t ? `, written ${t.written}, failures ${t.failures}, unprobed ${t.unprobed}, probed alone ${t.probedAlone ?? 0}` : ''} (${Math.round((Date.now() - t0) / 1000)} s)`;
    console.log(line);
    for (const w of why) console.log(`       ${w}`);
    if (why.length) {
      bad++;
      if (r.code === 2 || !result) console.log(r.out.split('\n').slice(-15).map((l) => `       | ${l}`).join('\n'));
    }
  }
  console.log(bad ? `fuzz-selftest: ${bad} of ${cases.length} cases did not behave as expected` : `fuzz-selftest: all ${cases.length} cases behaved as expected`);
  process.exit(bad ? 1 : 0);
}

await main();
