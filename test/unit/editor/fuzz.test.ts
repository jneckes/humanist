// The Phase 2 fuzz test (section 10 Phase 2 exit gate; section 11): seeded, reproducible random edits across
// every UTF-8 deck in fixtures/decks/ (and fixtures/local/ when present) plus generated documents. Each edit
// takes the same path as a typed edit: the commit clean-up, then the write queue (the full write protocol)
// over an in-memory DeckIO with the atomic writer's conflict contract.
//
// After each written edit: the file decodes and parses with no new parse errors; the diff touches only the
// target run's range; re-mapping finds the new text at the target and every other run unchanged; undo
// restores the bytes exactly, and redo restores the edit's bytes exactly. An edit that becomes a verbatim note
// must leave the file byte-identical, and the note must hold the exact before and after text. Some edits go
// in against a stale version, after an external change (or while a conflicting write lands), and the external
// change must survive. Zero failures.
//
// Reproduce with BL_FUZZ_SEED=<n> BL_FUZZ_EDITS=<n> npx vitest run test/unit/editor/fuzz.test.ts --silent=false
// (the report goes to stderr). The Chromium half of the probe (section 11: "each edit is also run through the
// mutation probe in Chromium") runs in `blueline map`'s probe (app-render), not here.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWriteQueue } from '@blueline/editor';
import { cleanupCommit } from '@blueline/core/edit-cleanup';
import { buildMap } from '@blueline/core/mapper';
import { decodeDeck } from '@blueline/core/text';
import type { DeckMap, EditRequest, HtmlRun, LiteralRun } from '@blueline/core/types';
import { bytesEqual, MemIO, sha256 } from './helpers';

const SEED = Number(process.env.BL_FUZZ_SEED ?? 0x5eed2026) >>> 0;
const EDITS = Number(process.env.BL_FUZZ_EDITS ?? 1200);
const GENERATED = 14;
const ROOT = join(__dirname, '../../..');

/** mulberry32: small, fast, seedable. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
    chance: (p: number) => next() < p,
  };
}
type Rng = ReturnType<typeof rng>;

// ------------------------------------------------------------------------------------------ inputs

/** Section 10 Phase 2: & < > " ' \ ` ${ } </script> <!-- emoji NBSP tabs \r\n, plus the usual text. */
const TOKENS = [
  '&', '<', '>', '"', "'", '\\', '`', '${', '}', '{', '$', '</script>', '<!--', '-->', '</SCRIPT', '<script',
  '\u{1F680}', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}', '\u{1F1EF}\u{1F1F5}', '\u2764\uFE0F',
  '\u00A0', '\t', '\r\n', '\n', '\r', ' ', '  ',
  'a', 'Z', 'word', 'Hello', 'x', '0', '42', '\u00E9', 'e\u0301', '\u2014', '\u201C', '\u2019', '\u4E2D\u6587',
  '&amp;', '&nbsp;', '&not', 'in;', '&#', '#x41;', '&lt;b&gt;', '<b>', '</p>', '<br/>',
  '\u200B', '\uFEFF', '\u2028', '\u2029', '\\n', '\\u0041', '\\x3C', '${x}', '\u0007', '\u0000', '\uE000',
];

function randomText(r: Rng): string {
  let s = '';
  const n = 1 + r.int(4);
  for (let i = 0; i < n; i++) s += r.pick(TOKENS);
  return s;
}

/** Offsets that do not split a surrogate pair (a caret never sits inside one). */
function boundaries(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i <= s.length; i++) {
    const c = s.charCodeAt(i);
    if (i > 0 && c >= 0xdc00 && c <= 0xdfff && s.charCodeAt(i - 1) >= 0xd800 && s.charCodeAt(i - 1) <= 0xdbff) continue;
    out.push(i);
  }
  return out;
}

/** What the edit field holds at commit: one or two edits, the way a person or a dictation tool makes them. */
function browserEdit(r: Rng, before: string): string {
  let s = before;
  const ops = 1 + (r.chance(0.2) ? 1 : 0);
  for (let k = 0; k < ops; k++) {
    const b = boundaries(s);
    const i = r.pick(b);
    const j = r.pick(b.filter((x) => x >= i));
    switch (r.int(7)) {
      case 0: // insert
        s = s.slice(0, i) + randomText(r) + s.slice(i);
        break;
      case 1: // delete
        s = s.slice(0, i) + s.slice(j);
        break;
      case 2: // replace a selection
        s = s.slice(0, i) + randomText(r) + s.slice(j);
        break;
      case 3: // the mutation probe's append (section 10)
        s = s + '\u27E6bl\u27E7';
        break;
      case 4: // type at the end; Chrome writes a trailing space as NBSP
        s = s + (r.chance(0.5) ? ' ' + randomText(r) : '\u00A0');
        break;
      case 5: // a dictated sentence pasted with a line break
        s = s.slice(0, i) + 'Dictated text\r\nwith a break' + s.slice(i);
        break;
      default: // retype the whole run (select all, type)
        s = r.chance(0.5) ? randomText(r) + ' ' + before.slice(0, 8) : 'Rewritten ' + randomText(r);
    }
  }
  return s;
}

// ------------------------------------------------------------------------------------------ documents

function corpus(): { name: string; bytes: Uint8Array }[] {
  const out: { name: string; bytes: Uint8Array }[] = [];
  const walk = (dir: string, rel: string): void => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).sort()) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) {
        if (f !== 'vendor') walk(p, `${rel}${f}/`);
      } else if (/\.html?$/i.test(f)) {
        const bytes = new Uint8Array(readFileSync(p));
        if (decodeDeck(bytes).utf8) out.push({ name: rel + f, bytes });
      }
    }
  };
  walk(join(ROOT, 'fixtures/decks'), 'decks/');
  walk(join(ROOT, 'fixtures/local'), 'local/');
  return out;
}

const WORDS = ['Revenue', 'grew', 'across', 'every', 'region', 'Plan', 'Owner', 'Next', 'steps', 'Q3', 'team', 'risk', 'on', 'track'];
const ENTITIES = ['&amp;', '&lt;', '&gt;', '&nbsp;', '&mdash;', '&copy', '&#169;', '&#xA9;', '&#x1F680;', '&notit;', '&quot;', '&eacute;', '&#150;'];

function phrase(r: Rng, html: boolean): string {
  let s = '';
  const n = 1 + r.int(6);
  for (let i = 0; i < n; i++) {
    if (i > 0) s += r.chance(0.1) ? '\u00A0' : ' ';
    s += r.pick(WORDS);
    if (html && r.chance(0.25)) s += r.pick(ENTITIES);
    if (r.chance(0.1)) s += r.pick(['\u{1F680}', '\u2014', '\u201Cq\u201D', 'caf\u00E9', 'e\u0301']);
  }
  return s;
}

function jsString(r: Rng, quote: "'" | '"'): string {
  let s = '';
  const n = 1 + r.int(5);
  for (let i = 0; i < n; i++) {
    if (i > 0) s += ' ';
    s += r.pick(WORDS);
    if (r.chance(0.2)) s += r.pick(['\\u2014', '\\n', '\\t', '\\x41', '\\u{1F680}', "\\'", '\\"', '\\\\', '\\\r\n']);
  }
  return quote + s + quote;
}

/** A random deck with every construct the patcher handles (and some it refuses). */
function generate(r: Rng, k: number): { name: string; bytes: Uint8Array } {
  const nl = r.chance(0.35) ? '\r\n' : '\n';
  const bom = r.chance(0.25) ? '\uFEFF' : '';
  const parts: string[] = [];
  parts.push(`${bom}<!doctype html>`, '<html lang="en">', '<head>', '<meta charset="utf-8">', `<title>Generated ${k}</title>`);
  parts.push('<style>.slide{padding:1em}</style>', '</head>', '<body>');
  const slides = 2 + r.int(4);
  for (let s = 0; s < slides; s++) {
    parts.push(`<section class="slide" id="s${s}" data-title="${r.pick(WORDS)}">`);
    parts.push(`  <h2>${phrase(r, true)}</h2>`);
    parts.push(`  <p>${phrase(r, true)} <b>${phrase(r, true)}</b> ${phrase(r, true)}</p>`);
    if (r.chance(0.5)) parts.push(`  <ul><li>${phrase(r, true)}</li><li>${phrase(r, true)} <a href=https://x.example/>${phrase(r, false)}</a></li></ul>`);
    if (r.chance(0.3)) parts.push(`  <pre>${nl}${phrase(r, true)}${nl}  ${phrase(r, false)}</pre>`);
    if (r.chance(0.3)) parts.push(`  <p>${phrase(r, true)}${nl}    ${phrase(r, true)}</p>`);
    if (r.chance(0.3)) parts.push(`  <table><tr><td>${phrase(r, true)}</td><th>${phrase(r, false)}</th></tr></table>`);
    if (r.chance(0.25)) parts.push(`  <svg width="10" height="10"><text x="0" y="9">${phrase(r, false)}</text></svg>`);
    if (r.chance(0.2)) parts.push(`  <p>Dup</p><p>Dup</p>`);
    parts.push('</section>');
  }
  const q1 = r.chance(0.5) ? "'" : '"';
  const lines = [
    '<div id="app"></div>',
    `<script${r.chance(0.3) ? ' type="module"' : ''}>`,
    `  const labels = [${jsString(r, q1)}, ${jsString(r, q1 === "'" ? '"' : "'")}, ${jsString(r, "'")}];`,
    `  const tpl = \`${phrase(r, false)}\`;`,
    `  const card = \`<h3>${phrase(r, true)}</h3><p>\${labels[0]} ${phrase(r, true)}</p>\`;`,
    `  const html = '<li>${phrase(r, true).replace(/'/g, "\\'")}</li><li><em>${phrase(r, false)}</em> tail</li>';`,
    `  const keyed = { 'Quoted key': ${jsString(r, '"')}, count: 3 };`,
    `  document.getElementById('app').innerHTML = card + html + tpl + labels.join(' ') + keyed['Quoted key'];`,
    '</script>',
    '<script type="application/json" id="data">',
    `{"title": "${phrase(r, false)}", "items": ["${phrase(r, false)}", "esc \\u2014 \\"q\\" \\u003C/script>"], "html": "<b>${phrase(r, false)}</b> ${phrase(r, false)}"}`,
    '</script>',
  ];
  parts.push(...lines);
  if (r.chance(0.3)) {
    parts.push('<script type="application/vnd.blueline+json" id="blueline-notes" data-version="1">{"format":"blueline-notes","notes":[]}</script>');
  }
  parts.push('</body>', '</html>', '');
  return { name: `generated-${k}${bom ? '-bom' : ''}${nl === '\r\n' ? '-crlf' : ''}`, bytes: new TextEncoder().encode(parts.join(nl)) };
}

// ------------------------------------------------------------------------------------------ checks

function codeCounts(map: DeckMap): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of map.parseErrors) m.set(e.code, (m.get(e.code) ?? 0) + 1);
  return m;
}

function allRuns(map: DeckMap): (HtmlRun | LiteralRun)[] {
  return [...map.runs, ...map.literals];
}

/** A run the overlay could send an edit for (exact-style): aligned, not pin-only, not a shadow reading. */
function editable(map: DeckMap, r: HtmlRun | LiteralRun): boolean {
  if (r.strategy === 'html-text') return r.aligned;
  const l = r as LiteralRun;
  return l.aligned !== false && !l.placeholder && !(l.html && !map.units[l.unit].html);
}

/** Splices an external change into src (the agent, another editor): returns the new text and a marker that must survive. */
function externalChange(r: Rng, src: string, map: DeckMap, target: HtmlRun | LiteralRun): { text: string; marker: string; kind: string } {
  const body = /<body[^>]*>/i.exec(src);
  const at = body ? body.index + body[0].length : 0;
  switch (r.int(4)) {
    case 0: {
      const marker = `<p>External ${r.int(1e6)}</p>`;
      return { text: src.slice(0, at) + marker + src.slice(at), marker, kind: 'insert-before' };
    }
    case 1: {
      const end = src.lastIndexOf('</body>');
      const pos = end >= 0 && (!map.notesBlock || end < map.notesBlock.start) ? end : src.length;
      const marker = `<!-- external ${r.int(1e6)} -->`;
      return { text: src.slice(0, pos) + marker + src.slice(pos), marker, kind: 'insert-after' };
    }
    case 2: {
      // Rewrite the target's own text: the edit must not land on it.
      const marker = `Agent rewrote this ${r.int(1e6)}`;
      if (target.strategy !== 'html-text') {
        const marker2 = `<!-- external ${r.int(1e6)} -->`;
        return { text: src.slice(0, at) + marker2 + src.slice(at), marker: marker2, kind: 'insert-before' };
      }
      return { text: src.slice(0, target.start) + marker + src.slice(target.end), marker, kind: 'rewrite-target' };
    }
    default: {
      // Duplicate the target's element right before it (html) or append the same text elsewhere.
      const marker = `<p>${target.value.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`;
      return { text: src.slice(0, at) + marker + src.slice(at), marker, kind: 'duplicate' };
    }
  }
}

interface Stats {
  edits: number;
  written: number;
  notes: number;
  stale: number;
  staleWritten: number;
  conflicts: number;
  undoCase2: number;
  reasons: Map<string, number>;
  perDoc: Map<string, { written: number; notes: number }>;
}

function reasonKey(why: string): string {
  return why.replace(/ \d+/g, ' N').replace(/ at N.*/, '').replace(/\(.*?\)/g, '').slice(0, 90).trim();
}

describe('fuzz: seeded random edits through the commit clean-up and the write protocol', () => {
  it(`${EDITS} edits, seed ${SEED}: zero failures`, async () => {
    const r = rng(SEED);
    const docs = corpus();
    expect(docs.length).toBeGreaterThan(0);
    for (let k = 0; k < GENERATED; k++) docs.push(generate(r, k));
    const state = docs.map((d) => {
      const io = new MemIO(d.bytes);
      return { name: d.name, io, q: createWriteQueue(io, { keepVersions: 8 }) };
    });
    const stats: Stats = {
      edits: 0,
      written: 0,
      notes: 0,
      stale: 0,
      staleWritten: 0,
      conflicts: 0,
      undoCase2: 0,
      reasons: new Map(),
      perDoc: new Map(),
    };
    const failures: string[] = [];

    for (let e = 0; e < EDITS; e++) {
      const d = r.pick(state);
      const map = await d.q.refresh(); // the version the overlay holds
      const runs = allRuns(map);
      const good = runs.filter((x) => editable(map, x));
      if (good.length === 0) continue;
      // Mostly runs the overlay would offer; sometimes any run (placeholder, unaligned, shadow) to test refusals.
      const target = r.chance(0.9) ? r.pick(good) : r.pick(runs);
      const raw = browserEdit(r, target.value);
      const after = cleanupCommit(target.value, raw);
      const req: EditRequest = { version: map.version, runId: target.id, beforeText: target.value, afterText: after };
      const ctx = () => `seed=${SEED} edit=${e} doc=${d.name} run=${target.id} before=${JSON.stringify(target.value)} after=${JSON.stringify(after)}`;

      // Some edits race an external change (the request then names a stale version), or a write that lands
      // between the queue's read and its rename.
      let marker: string | null = null;
      let externalKind = '';
      let fired = false; // the conflicting write landed (the queue reached its atomic write)
      const mode = r.int(10);
      if (mode === 0) {
        const ext = externalChange(r, decodeDeck(d.io.bytes).src, map, target);
        d.io.external(ext.text);
        marker = ext.marker;
        externalKind = ext.kind;
        stats.stale++;
      } else if (mode === 1) {
        const src = decodeDeck(d.io.bytes).src;
        const ext = externalChange(r, src, map, target);
        d.io.beforeWrite = () => {
          d.io.external(ext.text);
          fired = true;
        };
        marker = ext.marker;
        externalKind = ext.kind;
        stats.conflicts++;
      }
      const before = d.io.bytes.slice();
      const beforeSrc = decodeDeck(before).src;
      const out = await d.q.edit(req);
      d.io.beforeWrite = null;
      if (mode === 1 && !fired) {
        marker = null; // refused before writing: nothing raced it
        externalKind = '';
      }
      stats.edits++;
      const per = stats.perDoc.get(d.name) ?? { written: 0, notes: 0 };
      stats.perDoc.set(d.name, per);

      try {
        if (!out.ok) {
          stats.notes++;
          per.notes++;
          const key = reasonKey(out.why);
          if (process.env.BL_FUZZ_TRACE && new RegExp(process.env.BL_FUZZ_TRACE).test(out.why)) process.stderr.write(`TRACE ${ctx()} :: ${out.why}\n`);
          stats.reasons.set(key, (stats.reasons.get(key) ?? 0) + 1);
          expect(out.verbatim, `${ctx()} [note text]`).toEqual({ before: req.beforeText, after: req.afterText });
          // Byte-identical: to the file before the edit, or to the external write that raced it.
          const now = decodeDeck(d.io.bytes).src;
          if (mode === 1 && fired) {
            // Byte-identical to the external write that raced it: the queue wrote nothing.
            expect(marker !== null && now.includes(marker), `${ctx()} [note: file changed]`).toBe(true);
          } else {
            expect(bytesEqual(d.io.bytes, before), `${ctx()} [note: not byte-identical] ${out.why}`).toBe(true);
          }
          if (marker) expect(now.includes(marker), `${ctx()} [note: external change lost] ${externalKind}`).toBe(true);
          continue;
        }
        stats.written++;
        per.written++;
        if (mode === 0) stats.staleWritten++;
        const newBytes = d.io.bytes.slice();
        const dec = decodeDeck(newBytes);
        expect(dec.utf8, ctx()).toBe(true);
        expect(out.version, ctx()).toBe(sha256(newBytes));
        // The source the write was planned on: the record's versionBefore.
        const oldSrc = mode === 1 && sha256(before) !== out.record.versionBefore ? null : beforeSrc;
        const rec = out.record;
        const base = oldSrc ?? dec.src.slice(0, rec.start) + rec.rawBefore + dec.src.slice(rec.start + rec.rawAfter.length);
        expect(sha256(new TextEncoder().encode(base)), ctx()).toBe(rec.versionBefore);
        // The diff is exactly the record's splice.
        expect(dec.src, ctx()).toBe(base.slice(0, rec.start) + rec.rawAfter + base.slice(rec.start + rec.rawBefore.length));
        const oldMap = buildMap(base, { version: rec.versionBefore, utf8: true });
        const newMap = buildMap(dec.src, { version: out.version, utf8: true });
        // The diff touches only the target run's range.
        const oldRun = allRuns(oldMap).find((x) => x.id === out.runId);
        expect(oldRun, ctx()).toBeTruthy();
        expect(rec.start >= oldRun!.start && rec.start + rec.rawBefore.length <= oldRun!.end, ctx()).toBe(true);
        // Re-mapping finds the new text at the target, and every other run is as it was.
        const newRun = allRuns(newMap).find((x) => x.id === out.runId);
        expect(newRun?.value, ctx()).toBe(after);
        const others = (m: DeckMap) =>
          allRuns(m)
            .filter((x) => x.id !== out.runId && !(x.strategy !== 'html-text' && (x as LiteralRun).html && !m.units[(x as LiteralRun).unit].html))
            .map((x) => `${x.id}\u0000${x.value}`);
        expect(others(newMap), ctx()).toEqual(others(oldMap));
        // No new parse errors (by code).
        const oc = codeCounts(oldMap);
        for (const [code, n] of codeCounts(newMap)) expect(n <= (oc.get(code) ?? 0), `${ctx()} new ${code}`).toBe(true);
        // The external change survived (whether it came before the edit or raced its write).
        if (marker) expect(dec.src.includes(marker), `${ctx()} [external change lost] ${externalKind}`).toBe(true);

        // Undo restores the bytes exactly; redo restores the edit's bytes exactly.
        const u = await d.q.undo(rec);
        expect(u.ok, `${ctx()} undo ${u.ok ? '' : u.why}`).toBe(true);
        expect(decodeDeck(d.io.bytes).src, ctx()).toBe(base);
        expect(sha256(d.io.bytes), ctx()).toBe(rec.versionBefore);
        if (r.chance(0.7)) {
          const re = await d.q.redo(rec);
          expect(re.ok, `${ctx()} redo ${re.ok ? '' : re.why}`).toBe(true);
          expect(bytesEqual(d.io.bytes, newBytes), ctx()).toBe(true);
          if (r.chance(0.3)) {
            // Undo in a changed file (case 2): an external change far from the edit.
            const src = decodeDeck(d.io.bytes).src;
            const body = /<body[^>]*>/i.exec(src);
            const at = body ? body.index + body[0].length : 0;
            if (rec.start - at > 64) {
              const ins = '<p>Later external change</p>';
              d.io.external(src.slice(0, at) + ins + src.slice(at));
              const u2 = await d.q.undo(rec);
              expect(u2.ok, `${ctx()} undo case 2 ${u2.ok ? '' : u2.why}`).toBe(true);
              expect(decodeDeck(d.io.bytes).src, ctx()).toBe(base.slice(0, at) + ins + base.slice(at));
              stats.undoCase2++;
            }
          }
        }
      } catch (err) {
        failures.push(err instanceof Error ? err.message.split('\n')[0] : String(err));
        if (failures.length > 20) break;
      }
    }

    const pct = (n: number) => `${((100 * n) / Math.max(1, stats.edits)).toFixed(1)}%`;
    const lines = [
      `fuzz seed=${SEED} docs=${state.length} edits=${stats.edits}`,
      `  written ${stats.written} (${pct(stats.written)}), verbatim notes ${stats.notes} (${pct(stats.notes)})`,
      `  stale-version edits ${stats.stale} (written ${stats.staleWritten}), conflicting writes ${stats.conflicts}, undo case 2 ${stats.undoCase2}`,
      '  why edits became notes:',
      ...[...stats.reasons.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `    ${String(n).padStart(4)}  ${k}`),
      `  failures: ${failures.length}`,
      ...failures.slice(0, 20).map((f) => `    ${f}`),
    ];
    process.stderr.write(lines.join('\n') + '\n');
    expect(failures).toEqual([]);
    expect(stats.edits).toBeGreaterThanOrEqual(Math.min(EDITS, 1000));
    // A fuzz that only produced notes would test nothing.
    expect(stats.written).toBeGreaterThan(stats.edits / 3);
  }, 600_000);
});
