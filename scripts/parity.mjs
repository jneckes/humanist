#!/usr/bin/env node
// Render parity and PDF parity: the Phase 1 exit gate (SPEC 10 Phase 1; 11 Render parity and PDF), measured on
// this machine. Needs `npm run build` first (it uses the built deck preload); it compiles only its own harness
// (test/parity/harness), into the work folder.
//
//   node scripts/parity.mjs [--committed] [--local] [--perf] [--decks <label|path>,…]
//                           [--trust protected|trusted|both] [--pdf]
//                           [--tolerance 8] [--dwell 2000] [--out <file.json>] [--work <dir>] [--max-saved 6] [--save-all]
//                           [--seed-random] [--self-check] [--network]   (diagnosis, never the gate)
//   node scripts/parity.mjs --summarize <result.json> [--markdown]
//
// Decks: --committed (the default when nothing is chosen) is every committed fixture (fixtures/decks/*.html,
// reveal-hash, fixtures/render/*.html); --local adds Josh's decks from fixtures/local (named D1–D12 only, from
// fixtures/local/DECKS.md); --perf adds the generated 2 MB deck; --decks picks some by label or path.
// Prints one row per deck and trust state and writes every slide's figures to --out (default
// test-results/parity/parity.json). Diff images of failing slides go to <work>/diff/. Exit 0 when every deck
// passes, 1 when a gate fails, 2 on a usage or harness error.
//
// Diagnosis of a failure (the gate is always measured without these): --seed-random gives both renders the
// same seeded Math.random before any page script, so a deck's random decoration cannot be what differs;
// --self-check walks a second plain render and compares the two plain renders, which measures the deck's own
// variance between loads (clocks, timers, randomness). The gate runs offline (no proxy variables):
// Protected view sends its CDN allowlist DIRECT, never through a proxy from the environment, so behind such a
// proxy only the plain and Trusted renders could load web fonts; --network keeps the variables.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { bundleHarness, offlineEnv, PRELOAD, ROOT, runElectron } from '../test/parity/harness/bundle.mjs';

const DEFAULT_TOLERANCE = 8;
const RENDER_GATE = 0.005;
const PDF_GATE = 0.01;

function usage(msg) {
  if (msg) console.error(`parity: ${msg}`);
  console.error('usage: node scripts/parity.mjs [--committed] [--local] [--perf] [--decks a,b] [--trust protected|trusted|both] [--pdf] [--tolerance 8] [--out f.json] [--work dir] [--max-saved 6]');
  process.exit(2);
}

function parseArgs(argv) {
  const o = { committed: false, local: false, perf: false, decks: [], trust: ['protected'], pdf: false, tolerance: DEFAULT_TOLERANCE, out: null, work: null, maxSaved: 6, dwellMs: 2000, deckTimeoutMs: 15 * 60_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) usage(`${a} needs a value`);
      return v;
    };
    if (a === '--committed') o.committed = true;
    else if (a === '--local') o.local = true;
    else if (a === '--perf') o.perf = true;
    else if (a === '--decks') o.decks.push(...val().split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--trust') {
      const t = val();
      if (t === 'both') o.trust = ['protected', 'trusted'];
      else if (t === 'protected' || t === 'trusted') o.trust = [t];
      else usage(`--trust ${t}`);
    } else if (a === '--pdf') o.pdf = true;
    else if (a === '--tolerance') {
      o.tolerance = Number(val());
      if (!Number.isInteger(o.tolerance) || o.tolerance < 0 || o.tolerance > 255) usage('--tolerance takes 0..255');
    } else if (a === '--out') o.out = resolve(val());
    else if (a === '--work') o.work = resolve(val());
    else if (a === '--max-saved') o.maxSaved = Number(val());
    else if (a === '--save-all') o.saveAll = true;
    else if (a === '--seed-random') o.seedRandom = true;
    else if (a === '--network') o.network = true;
    else if (a === '--self-check') o.selfCheck = true;
    else if (a === '--deck-timeout') o.deckTimeoutMs = Number(val()) * 1000;
    else if (a === '--dwell') {
      o.dwellMs = Number(val());
      if (!Number.isInteger(o.dwellMs) || o.dwellMs < 0 || o.dwellMs > 60_000) usage('--dwell takes 0..60000 ms');
    }
    else if (a === '-h' || a === '--help') usage();
    else usage(`unknown argument ${a}`);
  }
  return o;
}

/** The harness's deck helpers, compiled with the harness (decks.ts is TypeScript). */
async function deckList(o, workDir) {
  const esbuild = await import('esbuild');
  const out = join(workDir, 'decks.mjs');
  await esbuild.build({ entryPoints: [join(ROOT, 'test/parity/harness/decks.ts')], outfile: out, bundle: true, platform: 'node', format: 'esm', logLevel: 'warning' });
  const d = await import(`file://${out}?t=${Date.now()}`);
  const all = [...d.committedDecks(ROOT), ...d.localDecks(ROOT)];
  const perf = d.perfDeck(ROOT);
  if (perf) all.push(perf);
  const chosen = [];
  const add = (x) => {
    if (!chosen.some((c) => c.file === x.file)) chosen.push(x);
  };
  if (o.committed || (!o.local && !o.perf && o.decks.length === 0)) for (const x of d.committedDecks(ROOT)) add(x);
  if (o.local) for (const x of d.localDecks(ROOT)) add(x);
  if (o.perf) {
    if (!perf) usage('the perf deck is not generated: node fixtures/perf/generate.mjs');
    add(perf);
  }
  for (const x of d.selectDecks(all, o.decks, ROOT)) add(x);
  return chosen;
}

function pct(x) {
  return typeof x === 'number' ? `${(x * 100).toFixed(3)}%` : '–';
}

function table(rows, head, markdown = false) {
  if (markdown) {
    const esc = (c) => String(c).replace(/\|/g, '\\|');
    return [`| ${head.map(esc).join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n');
  }
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => r.map((c, i) => String(c).padEnd(w[i])).join('  ');
  return [line(head), line(w.map((n) => '-'.repeat(n))), ...rows.map(line)].join('\n');
}

/** One row per deck and trust state: the gate's figures (and the PDF's when it was made). */
export function summarize(result, markdown = false) {
  const rows = [];
  for (const d of result.decks) {
    const maxDelta = Math.max(0, ...d.results.filter((r) => r.stats).map((r) => r.stats.maxDelta));
    let pdf = '';
    if (d.pdf) {
      if ('error' in d.pdf) pdf = `error: ${d.pdf.error.slice(0, 40)}`;
      else {
        const worst = Math.max(0, ...d.pdf.pageStats.map((p) => p.stats.overShare));
        pdf = `${d.pdf.mode} ${d.pdf.pages}/${d.pdf.expectedPages}${d.pdf.plainPages !== null ? ` (plain ${d.pdf.plainPages})` : ''} worst ${pct(worst)} ${d.pdf.pass ? 'ok' : 'FAIL'}`;
      }
    }
    rows.push([
      d.label,
      d.trust === d.trustAsked ? d.trust : `${d.trust} (asked ${d.trustAsked})`,
      d.kind,
      d.slides,
      d.compared,
      d.worstSlide === null ? '–' : `${pct(d.worstOver)} (s${d.worstSlide + 1})`,
      pct(d.worstExact),
      maxDelta,
      d.failures + (d.errors.length ? ` +${d.errors.length} err` : ''),
      d.pass ? 'pass' : 'FAIL',
      pdf,
      `${Math.round(d.ms / 1000)} s`,
    ]);
  }
  return table(rows, ['Deck', 'Trust', 'Kind', 'Slides', 'Compared', `Worst >${result.tolerance}`, 'Worst exact', 'Max Δ', 'Failures', 'Render', 'PDF', 'Time'], markdown);
}

async function main() {
  // --summarize <result.json> [--markdown]: print the table of an earlier run, run nothing.
  const si = process.argv.indexOf('--summarize');
  if (si >= 0) {
    const file = process.argv[si + 1] ?? usage('--summarize needs a result file');
    console.log(summarize(JSON.parse(readFileSync(resolve(file), 'utf8')), process.argv.includes('--markdown')));
    process.exit(0);
  }
  const o = parseArgs(process.argv.slice(2));
  if (!existsSync(PRELOAD)) usage(`${PRELOAD} is missing: run \`npm run build\` first`);
  const workDir = o.work ?? join(ROOT, 'test-results/parity/run');
  mkdirSync(workDir, { recursive: true });
  for (const sub of ['diff', 'pdf', 'tmp']) rmSync(join(workDir, sub), { recursive: true, force: true });
  const out = o.out ?? join(ROOT, 'test-results/parity/parity.json');
  mkdirSync(resolve(out, '..'), { recursive: true });
  const decks = await deckList(o, workDir);
  if (decks.length === 0) usage('no decks');
  const { main: harness, probe } = await bundleHarness(join(workDir, 'harness'));
  const job = {
    kind: 'parity',
    decks: decks.map((d) => ({ label: d.label, file: d.file, local: d.local, ...(d.deckNav ? { deckNav: d.deckNav } : {}) })),
    trust: o.trust,
    tolerance: o.tolerance,
    gate: RENDER_GATE,
    pdfGate: PDF_GATE,
    pdf: o.pdf,
    preload: PRELOAD,
    probeFile: probe,
    workDir,
    out,
    maxSaved: o.maxSaved,
    dwellMs: o.dwellMs,
    saveAll: o.saveAll === true,
    seedRandom: o.seedRandom === true,
    selfCheck: o.selfCheck === true,
    deckTimeoutMs: o.deckTimeoutMs,
  };
  const jobFile = join(workDir, 'job.json');
  writeFileSync(jobFile, JSON.stringify(job, null, 1));
  rmSync(out, { force: true });
  console.error(`parity: ${decks.length} decks × ${o.trust.join('+')}, tolerance ${o.tolerance}/255, dwell ${o.dwellMs} ms, gate ${RENDER_GATE * 100}%${o.pdf ? `, PDF gate ${PDF_GATE * 100}%` : ''}${o.seedRandom ? ', DIAGNOSIS: seeded Math.random' : ''}${o.network ? ', DIAGNOSIS: proxy variables kept' : ''}${o.selfCheck ? ', DIAGNOSIS: second plain render' : ''}`);
  const code = await runElectron(harness, [`--bl-parity-job=${jobFile}`], {
    // Offline by default: every render sees the same network (offlineEnv); --network keeps the proxy variables.
    env: o.network ? process.env : offlineEnv(process.env),
    onLine: (l) => {
      // Only the harness's own lines; Chromium's diagnostics on stderr are noise here.
      if (l.startsWith('[parity]')) console.error(l);
    },
  });
  // The job names the local decks' files: it stays in the (gitignored) work folder only while the run lasts.
  // So do the harness's private userData folders (Chromium profiles, persist: partitions of Trusted renders).
  rmSync(jobFile, { force: true });
  for (const f of readdirSync(workDir)) if (f.startsWith('userdata-')) rmSync(join(workDir, f), { recursive: true, force: true });
  if (!existsSync(out)) {
    console.error(`parity: the harness wrote no result (exit ${code})`);
    process.exit(2);
  }
  const result = JSON.parse(readFileSync(out, 'utf8'));
  console.log(summarize(result));
  const decksPass = result.decks.every((d) => d.pass);
  const pdfPass = result.decks.every((d) => !d.pdf || d.pdf.pass);
  console.log(
    `\nRender parity: ${result.decks.filter((d) => d.pass).length}/${result.decks.length} decks pass (≤ ${RENDER_GATE * 100}% of pixels over a per-channel tolerance of ${result.tolerance}/255, every slide).` +
      (o.pdf ? `\nPDF: ${result.decks.filter((d) => d.pdf && d.pdf.pass).length}/${result.decks.filter((d) => d.pdf).length} decks pass (right page count, every page ≤ ${PDF_GATE * 100}%).` : '') +
      `\nResults: ${out}`,
  );
  if (code !== 0) {
    console.error(`parity: the harness exited with ${code}`);
    process.exit(2);
  }
  process.exit(decksPass && pdfPass ? 0 : 1);
}

await main();
