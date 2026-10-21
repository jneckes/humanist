#!/usr/bin/env node
// The Chromium fuzz gate (SPEC 10 Phase 2 exit gate "Fuzz test"; 11 Fuzz test; P2-16): seeded random edits through
// the typed-edit path, the real write queue and the app's DeckIO on a probe copy, each written edit checked in Node
// and through the mutation probe in Chromium. Needs `npm run build` first (the deck preload and dist/editor.cjs);
// it compiles only its own harness (test/fuzz/harness) into the work folder. The method is in
// test/fuzz/harness/main.ts; the results go to docs/PHASE2-RESULTS.md.
//
//   node scripts/fuzz.mjs [--seed n] [--edits 1000] [--batch 24] [--committed] [--local] [--decks <label|path>,…]
//                         [--out <file.json>] [--work <dir>] [--verbose] [--negative-control]
//   node scripts/fuzz.mjs --summarize <result.json>
//
// Decks: --committed (the default when nothing is chosen) is every committed fixture deck, as the Phase 1 gate
// harnesses take them (fixtures/decks/*.html, decks/reveal-hash, fixtures/render/*.html); --local is Josh's decks
// from fixtures/local (the extra run; named D1–D12 only, from fixtures/local/DECKS.md); --decks picks some by label
// or path. Every deck is copied into the work folder first, and the fuzz writes only to a hidden probe copy next to
// that copy: nothing under fixtures/ is ever written. The same seed and corpus give the same edits (the report
// records every deck's sha256); a deck whose walk differs between runs (an animation that ends at another moment)
// draws its targets from what that walk saw.
//
// --negative-control (never the gate): after every fifth written edit the run's text changes once more behind the
// oracle's back, and the run passes only if the mutation probe catches every such change.
//
// Exit 0 when every edit passed, every written edit was probed and the requested number was made; 1 when an edit
// failed, a written edit could not be probed (SPEC 10 Phase 2: the probe passes after EACH written edit, so one it
// never reached is not a pass; E-12), a deck had an error, or too few edits could be made; 2 on a usage or harness
// error. scripts/fuzz-selftest.mjs checks that the gate fails the edits it must fail (test/fuzz/selftest).

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { bundleHarness, EDITOR_DIR, offlineEnv, PRELOAD, ROOT, runElectron } from '../test/fuzz/harness/bundle.mjs';

const DEFAULTS = Object.freeze({
  seed: 0x5eed2026,
  edits: 1000,
  batch: 24,
  pickShare: 0.1,
  staleShare: 0.1,
  externalBeforeShare: 0.04,
  externalInsideShare: 0.04,
  undoShare: 0.25,
});

function usage(msg) {
  if (msg) console.error(`fuzz: ${msg}`);
  console.error('usage: node scripts/fuzz.mjs [--seed n] [--edits 1000] [--batch 24] [--committed] [--local] [--decks a,b] [--out f.json] [--work dir] [--verbose]\n       node scripts/fuzz.mjs --summarize <result.json>');
  process.exit(2);
}

function parseArgs(argv) {
  const o = { seed: DEFAULTS.seed, edits: DEFAULTS.edits, batch: DEFAULTS.batch, committed: false, local: false, decks: [], out: null, work: null, verbose: false, negativeControl: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) usage(`${a} needs a value`);
      return v;
    };
    const int = (lo, hi) => {
      const n = Number(val());
      if (!Number.isInteger(n) || n < lo || n > hi) usage(`${a} takes an integer ${lo}..${hi}`);
      return n;
    };
    if (a === '--seed') o.seed = int(0, 0xffffffff);
    else if (a === '--edits') o.edits = int(1, 1_000_000);
    else if (a === '--batch') o.batch = int(1, 200);
    else if (a === '--committed') o.committed = true;
    else if (a === '--local') o.local = true;
    else if (a === '--decks') o.decks.push(...val().split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--out') o.out = resolve(val());
    else if (a === '--work') o.work = resolve(val());
    else if (a === '--verbose') o.verbose = true;
    else if (a === '--negative-control') o.negativeControl = true;
    else if (a === '-h' || a === '--help') usage();
    else usage(`unknown argument ${a}`);
  }
  return o;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The parity harness's deck list (decks.ts is TypeScript; compiled into the work folder, as parity.mjs does). */
async function deckModule(workDir) {
  const esbuild = await import('esbuild');
  const out = join(workDir, 'decks.mjs');
  await esbuild.build({ entryPoints: [join(ROOT, 'test/parity/harness/decks.ts')], outfile: out, bundle: true, platform: 'node', format: 'esm', logLevel: 'warning' });
  return import(`file://${out}?t=${Date.now()}`);
}

/**
 * Copies the chosen decks into <work>/corpus: a committed deck with its whole folder (relative scripts, styles and
 * vendor files keep working), one of Josh's decks as <label>.html (its file name names a client).
 */
function copyCorpus(decks, corpusDir) {
  rmSync(corpusDir, { recursive: true, force: true });
  mkdirSync(corpusDir, { recursive: true });
  const fixtures = join(ROOT, 'fixtures');
  const copiedDirs = new Set();
  const skipProbeCopies = (src) => !/\.bl-probe\.html$/.test(basename(src)) && !/^\.bl-write-/.test(basename(src));
  return decks.map((d) => {
    if (d.local) {
      const file = join(corpusDir, 'local', `${d.label}.html`);
      mkdirSync(dirname(file), { recursive: true });
      cpSync(d.file, file);
      return { label: d.label, file, local: true, sha256: sha256(readFileSync(file)) };
    }
    const rel = d.file.startsWith(fixtures + '/') ? d.file.slice(fixtures.length + 1) : basename(d.file);
    const dir = dirname(rel);
    if (dir !== '.' && ![...copiedDirs].some((c) => dir === c || dir.startsWith(c + '/'))) {
      cpSync(join(fixtures, dir), join(corpusDir, dir), { recursive: true, filter: skipProbeCopies });
      copiedDirs.add(dir);
    }
    const file = join(corpusDir, rel);
    if (!existsSync(file)) cpSync(d.file, file);
    return { label: d.label, file, local: false, sha256: sha256(readFileSync(file)) };
  });
}

function pct(x) {
  return `${(100 * x).toFixed(1)}%`;
}

/** The text summary of a result (also `--summarize`). */
export function summarize(r) {
  const t = r.totals;
  const lines = [];
  lines.push(`Fuzz gate (P2-16): seed ${r.seed}, ${r.corpus.length} decks, ${t.edits} edits of ${r.editsRequested} requested, batch ${r.batch}, ${Math.round(r.ms / 1000)} s`);
  lines.push(`  Electron ${r.environment.electron} (Chromium ${r.environment.chrome}), ${r.environment.platform}-${r.environment.arch}, editor ${r.environment.editorVersion}, reduced motion`);
  lines.push(`  written ${t.written} (${pct(r.shares.written)}), notes by rule ${t.notes} (${pct(r.shares.notes)}), no-ops ${t.noops} (${pct(r.shares.noops)}), failures ${t.failures}`);
  lines.push(`  picked candidates ${t.picks} (written ${t.pickWritten}); stale-version requests ${t.stale}; merged writes ${t.merged}; external writes before ${t.externalBefore}, inside the atomic write ${t.externalInside} (landed ${t.externalFired}); undo+redo ${t.undoRedo}`);
  lines.push(`  mutation probe: ${t.probedRuns} edited runs in ${t.probeLoads} probe loads (${t.probedAlone ?? 0} probed on their own, their node not in the round's walk); ${t.unprobed} written edits not probed${t.unprobed ? ` (${Object.entries(r.unprobedByReason).map(([k, n]) => `${n} ${k}`).join('; ')}: each fails the run)` : ''}; ${t.rounds} rounds, ${t.walks} walks`);
  if (t.controlsPlanted) lines.push(`  NEGATIVE CONTROL: ${t.controlsCaught} of ${t.controlsPlanted} planted changes caught by the probe (not a gate run)`);
  const by = Object.entries(r.byStrategy).map(([k, v]) => `${k} ${v.written} written / ${v.notes} notes`);
  if (by.length) lines.push(`  by strategy: ${by.join('; ')}`);
  lines.push('  notes by rule:');
  for (const [k, n] of Object.entries(r.notesByCode).sort((a, b) => b[1] - a[1])) lines.push(`    ${String(n).padStart(5)}  ${k}`);
  lines.push('  SPEC 10 Phase 2 inputs (typed into a field / reached the file in a written edit):');
  lines.push(`    ${Object.entries(r.inputs).map(([k, v]) => `${k} ${v.typed}/${v.written}`).join('  ')}`);
  lines.push('  decks:');
  for (const d of r.decks) {
    const why = d.skipped ? ` skipped: ${d.skipped}` : '';
    const errs = d.errors.length ? ` ERRORS: ${d.errors.join(' | ').slice(0, 200)}` : '';
    lines.push(`    ${d.label.padEnd(36)} ${String(d.edits).padStart(4)} edits ${String(d.written).padStart(4)} written ${String(d.notes).padStart(4)} notes ${String(d.failures).padStart(3)} fail  ${String(d.rounds).padStart(3)} rounds ${String(d.walks).padStart(3)} walks ${String(d.probeLoads).padStart(3)} probe loads ${String(d.probedAlone ?? 0).padStart(2)} alone ${String(d.unprobed).padStart(2)} unprobed  ${Math.round(d.ms / 1000)} s${why}${errs}`);
  }
  lines.push(`  failures: ${r.failures.length}; written edits not probed: ${t.unprobed} (the run passes only when both are 0)`);
  for (const f of r.failures.slice(0, 40)) lines.push(`    edit ${f.edit} ${f.deck} (round ${f.round}): ${String(f.what).slice(0, 300)}`);
  return lines.join('\n');
}

async function main() {
  const si = process.argv.indexOf('--summarize');
  if (si >= 0) {
    const file = process.argv[si + 1] ?? usage('--summarize needs a result file');
    console.log(summarize(JSON.parse(readFileSync(resolve(file), 'utf8'))));
    process.exit(0);
  }
  const o = parseArgs(process.argv.slice(2));
  if (!existsSync(PRELOAD)) usage(`${PRELOAD} is missing: run \`npm run build\` first`);
  if (!existsSync(join(EDITOR_DIR, 'editor.cjs'))) usage('packages/app/dist/editor.cjs is missing: the fuzz gate needs a full build (npm run build), not a reader-only one');
  const onlyLocal = o.local && !o.committed && o.decks.length === 0;
  const workDir = o.work ?? join(ROOT, 'test-results/fuzz', onlyLocal ? 'run-local' : 'run');
  mkdirSync(workDir, { recursive: true });
  for (const sub of ['failures']) rmSync(join(workDir, sub), { recursive: true, force: true });
  for (const f of readdirSync(workDir)) if (f.startsWith('userdata-')) rmSync(join(workDir, f), { recursive: true, force: true });
  const out = o.out ?? join(ROOT, 'test-results/fuzz', onlyLocal ? 'fuzz-local.json' : 'fuzz.json');
  mkdirSync(dirname(out), { recursive: true });

  const d = await deckModule(workDir);
  const all = [...d.committedDecks(ROOT), ...d.localDecks(ROOT)];
  const chosen = [];
  const add = (x) => {
    if (!chosen.some((c) => c.file === x.file)) chosen.push(x);
  };
  if (o.committed || (!o.local && o.decks.length === 0)) for (const x of d.committedDecks(ROOT)) add(x);
  if (o.local) {
    const local = d.localDecks(ROOT);
    if (local.length === 0) usage('--local: fixtures/local holds no decks');
    for (const x of local) add(x);
  }
  for (const x of d.selectDecks(all, o.decks, ROOT)) add(x);
  if (chosen.length === 0) usage('no decks');
  const decks = copyCorpus(chosen, join(workDir, 'corpus'));

  const { main: harness, fieldProbe } = await bundleHarness(join(workDir, 'harness'));
  const job = {
    seed: o.seed,
    edits: o.edits,
    batch: o.batch,
    decks,
    pickShare: DEFAULTS.pickShare,
    staleShare: DEFAULTS.staleShare,
    externalBeforeShare: DEFAULTS.externalBeforeShare,
    externalInsideShare: DEFAULTS.externalInsideShare,
    undoShare: DEFAULTS.undoShare,
    workDir,
    out,
    preload: PRELOAD,
    editorDir: EDITOR_DIR,
    fieldProbe,
    verbose: o.verbose,
    negativeControl: o.negativeControl,
  };
  const jobFile = join(workDir, 'job.json');
  writeFileSync(jobFile, JSON.stringify(job, null, 1));
  rmSync(out, { force: true });
  console.error(`fuzz: seed ${o.seed}, ${o.edits} edits over ${decks.length} decks, batch ${o.batch}${o.local ? ', with Josh\'s decks (labels only)' : ''}`);
  const t0 = Date.now();
  const code = await runElectron(harness, [`--bl-fuzz-job=${jobFile}`], {
    env: offlineEnv(process.env),
    onLine: (l) => {
      if (l.startsWith('[fuzz]')) console.error(l);
    },
  });
  rmSync(jobFile, { force: true });
  for (const f of readdirSync(workDir)) if (f.startsWith('userdata-')) rmSync(join(workDir, f), { recursive: true, force: true });
  // Josh's decks never stay outside fixtures/local longer than the run (the failures' bytes stay, gitignored).
  rmSync(join(workDir, 'corpus', 'local'), { recursive: true, force: true });
  if (!existsSync(out)) {
    console.error(`fuzz: the harness wrote no result (exit ${code})`);
    process.exit(2);
  }
  const result = JSON.parse(readFileSync(out, 'utf8'));
  console.log(summarize(result));
  console.log(`\nWall time ${Math.round((Date.now() - t0) / 1000)} s. Results: ${out}`);
  if (code !== 0) {
    console.error(`fuzz: the harness exited with ${code}`);
    process.exit(2);
  }
  const deckErrors = result.decks.some((x) => x.errors.length > 0);
  const short = result.totals.edits < result.editsRequested;
  if (short) console.error(`fuzz: only ${result.totals.edits} of ${result.editsRequested} edits could be made`);
  const controls = result.totals.controlsCaught === result.totals.controlsPlanted && (!o.negativeControl || result.totals.controlsPlanted > 0);
  // A written edit the probe never reached has not passed it (SPEC 10 Phase 2 "Checks after each written edit").
  const unprobed = result.totals.unprobed;
  if (unprobed > 0) console.error(`fuzz: ${unprobed} written edit${unprobed === 1 ? '' : 's'} could not be probed: the run fails`);
  process.exit(result.totals.failures === 0 && unprobed === 0 && !deckErrors && !short && controls ? 0 : 1);
}

await main();
