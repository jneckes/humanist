// The Phase 2 fuzz test, Node half (section 10 Phase 2 exit gate; section 11; P2-16): seeded, reproducible random
// edits across every UTF-8 deck in fixtures/decks/ (and fixtures/local/ when present) plus generated documents.
// Each edit takes the same path as a typed edit, literally the same code: an edit field is built from the map's
// runs (the element's text nodes, sometimes with unmapped white space between them), the "user" changes it,
// core/edit-commit commitField makes the commit (clean-up, smart punctuation, the run boundary and caret rule),
// a picked substring or normalized candidate is lifted with liftPick, and the write queue runs the full write
// protocol over an in-memory DeckIO with the atomic writer's conflict contract.
//
// Each commit's text is judged by the clean-up oracle (test/fuzz/harness/cleanup-oracle.ts), which re-derives 9.2
// step 3 and 6.3 and shares no code with core/edit-cleanup: the field's own NBSPs, line breaks, zero-width spaces
// and straight quotes stay, and only what was inserted is cleaned (the "user"'s record of what it inserted names
// the units in a failure).
//
// After each written edit: the file decodes and parses with no new parse errors; the diff touches only the
// target run's range; re-mapping finds the new text at the target and every other run unchanged; undo restores
// the bytes exactly, and redo restores the edit's bytes exactly. Notes count only when they are notes BY RULE:
// commitField's typed reasons, and the queue's typed refusal codes other than internal, conflict, verify and
// refused, which are failures; such a note must leave the file byte-identical and hold the exact before and
// after text (after a conflicting write landed inside the atomic write: byte-identical to what that write left).
// No-ops (nothing changed after the clean-up) are counted apart. An edit made inside one run with the caret in it
// must be that run's edit (or a no-op, or structural). Some edits go in against a stale version, after an
// external change (or while a conflicting write lands), and the external change must survive. Zero failures.
//
// Reproduce with BL_FUZZ_SEED=<n> BL_FUZZ_EDITS=<n> npx vitest run test/unit/editor/fuzz.test.ts --silent=false
// (the report goes to stderr). The Chromium half (each written edit through the mutation probe, P2-16) is the
// gate's harness (test/fuzz/), on the committed fixtures and Josh's decks.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWriteQueue } from '@blueline/editor';
import { commitField, liftPick, type CommitResult, type FieldRun } from '@blueline/core/edit-commit';
import { buildMap } from '@blueline/core/mapper';
import { normalizeForMatch } from '@blueline/core/matcher';
import { decodeDeck } from '@blueline/core/text';
import type { DeckMap, EditPick, EditRequest, HtmlRun, LiteralRun, RefusalCode } from '@blueline/core/types';
import { judgeCleanup } from '../../fuzz/harness/cleanup-oracle';
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

/**
 * What the edit field holds at commit: one or two edits, the way a person or a dictation tool makes them, with
 * the record of which UTF-16 units the "user" put there (`inserted`, for the clean-up oracle). The record draws
 * nothing from the seeded source: the same seed gives the same edits as without it.
 */
function browserEdit(r: Rng, before: string): { text: string; inserted: boolean[] } {
  let s = before;
  let inserted: boolean[] = new Array<boolean>(before.length).fill(false);
  const put = (i: number, j: number, text: string): void => {
    s = s.slice(0, i) + text + s.slice(j);
    inserted = [...inserted.slice(0, i), ...new Array<boolean>(text.length).fill(true), ...inserted.slice(j)];
  };
  const ops = 1 + (r.chance(0.2) ? 1 : 0);
  for (let k = 0; k < ops; k++) {
    const b = boundaries(s);
    const i = r.pick(b);
    const j = r.pick(b.filter((x) => x >= i));
    switch (r.int(7)) {
      case 0: // insert
        put(i, i, randomText(r));
        break;
      case 1: // delete
        put(i, j, '');
        break;
      case 2: // replace a selection
        put(i, j, randomText(r));
        break;
      case 3: // the mutation probe's append (section 10)
        put(s.length, s.length, '\u27E6bl\u27E7');
        break;
      case 4: // type at the end; Chrome writes a trailing space as NBSP
        put(s.length, s.length, r.chance(0.5) ? ' ' + randomText(r) : '\u00A0');
        break;
      case 5: // a dictated sentence pasted with a line break
        put(i, i, 'Dictated text\r\nwith a break');
        break;
      default: // retype the whole run (select all, type): every unit is typed, the run's first 8 included
        put(0, s.length, r.chance(0.5) ? randomText(r) + ' ' + before.slice(0, 8) : 'Rewritten ' + randomText(r));
    }
  }
  return { text: s, inserted };
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


// ------------------------------------------------------------------------------------------ edit fields

/** The queue's codes for notes BY RULE; anything else (internal, conflict, verify, refused) is a failure. */
const RULE_CODES = new Set<RefusalCode>(['not-utf8', 'structural', 'stale', 'ambiguous', 'placeholder', 'markup', 'escape', 'unaligned']);

interface Field {
  text: string;
  runs: FieldRun[];
  /** The target's place in the field. */
  at: FieldRun;
}

/**
 * The edit field around a target run, as the overlay records it (9.2 step 1): for parsed text, the runs of the
 * target's element in source order, with the runs of inline elements between them (an element's textContent);
 * for a literal of an HTML fragment, the fragment's runs around it; otherwise the run alone. White space that is
 * no run sometimes sits between two runs (a white-space-only text node).
 */
function fieldFor(r: Rng, map: DeckMap, target: HtmlRun | LiteralRun): Field {
  let members: (HtmlRun | LiteralRun)[] = [target];
  if (target.strategy === 'html-text') {
    const own = map.runs.filter((x) => x.stamp === (target as HtmlRun).stamp);
    const lo = Math.min(...own.map((x) => x.start));
    const hi = Math.max(...own.map((x) => x.end));
    members = map.runs.filter((x) => x.start >= lo && x.end <= hi).sort((a, b) => a.start - b.start);
  } else if ((target as LiteralRun).html && map.units[(target as LiteralRun).unit]?.html) {
    members = map.literals.filter((x) => x.unit === (target as LiteralRun).unit && x.html).sort((a, b) => a.runIndex - b.runIndex);
  }
  // A field is one element: keep a few runs on each side of the target.
  const k = members.indexOf(target);
  members = members.slice(Math.max(0, k - 3), k + 4);
  let text = '';
  const runs: FieldRun[] = [];
  let at: FieldRun | null = null;
  for (const m of members) {
    if (runs.length > 0 && r.chance(0.25)) text += r.pick([' ', '\n  ', ' \t']);
    const fr: FieldRun = { runId: m.id, start: text.length, end: text.length + m.value.length, value: m.value };
    runs.push(fr);
    if (m === target) at = fr;
    text += m.value;
  }
  return { text, runs, at: at! };
}

/** Whether a text already uses curly double and single quotes (6.3: then smart punctuation curls typed ones). */
function curlyIn(s: string): { double: boolean; single: boolean } {
  return { double: /[\u201C\u201D]/.test(s), single: /[\u2018\u2019]/.test(s) };
}

/** A node the picker would offer for this run, and how it relates (P2-8): a unique piece of it, or its normalized text. */
function pickedNode(r: Rng, run: HtmlRun | LiteralRun): { node: string; kind: EditPick['kind'] } | null {
  const norm = normalizeForMatch(run.value);
  if (norm.length > 0 && norm !== run.value && r.chance(0.5)) return { node: norm, kind: 'normalized' };
  const b = boundaries(run.value);
  if (b.length < 4) return null;
  for (let tries = 0; tries < 4; tries++) {
    const i = r.pick(b.slice(0, -2));
    const j = r.pick(b.filter((x) => x > i + 1));
    if (j === undefined) continue;
    const piece = run.value.slice(i, j);
    if (piece.trim() === '' || piece === run.value) continue;
    if (run.value.indexOf(piece) === i && run.value.indexOf(piece, i + 1) < 0) return { node: piece, kind: 'substring' };
  }
  return null;
}

interface Stats {
  edits: number;
  written: number;
  /** Notes by rule: commitField's typed reasons and the queue's rule codes. */
  notes: number;
  noops: number;
  picks: number;
  pickWritten: number;
  stale: number;
  staleWritten: number;
  merged: number;
  conflicts: number;
  undoCase2: number;
  undoCase2Refused: number;
  reasons: Map<string, number>;
}

describe('fuzz: seeded random edits through commitField and the write protocol', () => {
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
      noops: 0,
      picks: 0,
      pickWritten: 0,
      stale: 0,
      staleWritten: 0,
      merged: 0,
      conflicts: 0,
      undoCase2: 0,
      undoCase2Refused: 0,
      reasons: new Map(),
    };
    const reason = (k: string) => stats.reasons.set(k, (stats.reasons.get(k) ?? 0) + 1);
    const failures: string[] = [];

    for (let e = 0; e < EDITS; e++) {
      const d = r.pick(state);
      const map = await d.q.refresh(); // the version the overlay holds
      const runs = allRuns(map);
      const good = runs.filter((x) => editable(map, x));
      if (good.length === 0) continue;
      // Mostly runs the overlay would offer; sometimes any run (placeholder, unaligned, shadow) to test refusals.
      const target = r.chance(0.9) ? r.pick(good) : r.pick(runs);
      const smart = r.chance(0.8);
      // How the author edits: inside the target's own text node (the caret there), anywhere in the field (a
      // selection across runs, unmapped text, a caret elsewhere), or in a node picked in the picker (P2-8).
      const roll = r.next();
      const picked = roll < 0.06 ? pickedNode(r, target) : null;
      const inTarget = !picked && roll < 0.82;
      let commit: CommitResult;
      let pick: EditPick | undefined;
      let fieldText = '';
      let fieldRaw = '';
      /** Which units of fieldRaw the author put there (browserEdit's record). */
      let inserted: boolean[] = [];
      let caret: string | null = null;
      let fieldInfo: Field | null = null;
      if (picked) {
        // The field holds the node; its FieldRun names the picked run but carries the node's text.
        fieldText = picked.node;
        ({ text: fieldRaw, inserted } = browserEdit(r, picked.node));
        caret = target.id;
        commit = commitField({ before: fieldText, after: fieldRaw, runs: [{ runId: target.id, start: 0, end: fieldText.length, value: fieldText }], caretRunId: caret }, { smartPunctuation: smart });
      } else {
        const f = fieldFor(r, map, target);
        fieldInfo = f;
        fieldText = f.text;
        if (inTarget) {
          const inner = browserEdit(r, target.value);
          fieldRaw = f.text.slice(0, f.at.start) + inner.text + f.text.slice(f.at.end);
          inserted = [...new Array<boolean>(f.at.start).fill(false), ...inner.inserted, ...new Array<boolean>(f.text.length - f.at.end).fill(false)];
          caret = r.chance(0.9) ? target.id : null;
        } else {
          ({ text: fieldRaw, inserted } = browserEdit(r, f.text));
          caret = r.chance(0.7) ? r.pick(f.runs).runId : null;
        }
        commit = commitField({ before: f.text, after: fieldRaw, runs: f.runs, caretRunId: caret }, { smartPunctuation: smart });
      }
      const ctx = () =>
        `seed=${SEED} edit=${e} doc=${d.name} run=${target.id} field=${JSON.stringify(fieldText)} raw=${JSON.stringify(fieldRaw)} caret=${caret} commit=${JSON.stringify(commit)}`;
      stats.edits++;

      // The commit path's own oracle.
      try {
        if (commit.kind === 'verbatim') {
          expect(commit.before, `${ctx()} [verbatim before]`).toBe(fieldText);
          // The note's text after is the field cleaned as 9.2 step 3 says, with the field's quotes deciding (6.3).
          // A note for text with a lone surrogate holds U+FFFD in its place ('invalid'): no clean-up to judge.
          if (commit.why !== 'invalid') {
            expect(judgeCleanup({ before: fieldText, raw: fieldRaw, result: commit.after, inserted, smart, curly: curlyIn(fieldText) }), `${ctx()} [verbatim after]`).toBeNull();
          }
          // An edit inside one run with the caret in it is that run's edit, a no-op, or structural.
          if (inTarget && caret === target.id) expect(['emptied', 'run-emptied', 'invalid'], `${ctx()} [in-run verbatim]`).toContain(commit.why);
        } else if (commit.kind === 'edit') {
          // A picked node is a field of its own: one run, the node's text (P2-8).
          const fieldRuns = fieldInfo ? fieldInfo.runs : [{ runId: target.id, start: 0, end: fieldText.length, value: fieldText }];
          const fr = fieldRuns.find((x) => x.runId === commit.runId);
          expect(fr, `${ctx()} [unknown run]`).toBeTruthy();
          expect(commit.beforeText, ctx()).toBe(fr!.value);
          if (inTarget && caret === target.id) expect(commit.runId, `${ctx()} [caret run]`).toBe(target.id);
          // The field with the run's new text is the field cleaned as 9.2 step 3 says; the run's own quotes decide
          // which typed quotes smart punctuation curled (6.3).
          const owners = fieldRuns.filter((x) => x.runId === commit.runId);
          const whys = owners.map((o) => judgeCleanup({ before: fieldText, raw: fieldRaw, result: fieldText.slice(0, o.start) + commit.afterText + fieldText.slice(o.end), inserted, smart, curly: curlyIn(o.value) }));
          expect(whys.some((w) => w === null) ? null : whys[0], `${ctx()} [rebuilt field]`).toBeNull();
        }
      } catch (err) {
        failures.push(err instanceof Error ? err.message.split('\n')[0] : String(err));
        if (failures.length > 20) break;
        continue;
      }
      if (commit.kind === 'noop') {
        stats.noops++;
        reason('commit: noop');
        continue;
      }
      if (commit.kind === 'verbatim') {
        // A note by rule: nothing reaches the queue, so the file is untouched.
        stats.notes++;
        reason(`commit: ${commit.why}`);
        continue;
      }
      let req: EditRequest;
      if (picked) {
        stats.picks++;
        pick = { kind: picked.kind, nodeBefore: commit.beforeText, nodeAfter: commit.afterText };
        const lifted = liftPick(target.value, pick);
        if (!lifted) {
          // Main makes a verbatim note before the queue (P2-8): a note by rule.
          stats.notes++;
          reason(`pick: ${picked.kind} not liftable`);
          continue;
        }
        req = { version: map.version, runId: target.id, beforeText: lifted.beforeText, afterText: lifted.afterText, pick };
      } else {
        req = { version: map.version, runId: commit.runId, beforeText: commit.beforeText, afterText: commit.afterText };
      }
      const editRun = runs.find((x) => x.id === req.runId) ?? target;

      // Some edits race an external change (the request then names a stale version), or a write that lands
      // between the queue's read and its rename.
      let marker: string | null = null;
      let externalKind = '';
      let fired = false; // the conflicting write landed (the queue reached its atomic write)
      let extBytes: Uint8Array | null = null; // the file as that write left it
      const mode = r.int(10);
      if (mode === 0) {
        const ext = externalChange(r, decodeDeck(d.io.bytes).src, map, editRun);
        d.io.external(ext.text);
        marker = ext.marker;
        externalKind = ext.kind;
        stats.stale++;
      } else if (mode === 1) {
        const src = decodeDeck(d.io.bytes).src;
        const ext = externalChange(r, src, map, editRun);
        d.io.beforeWrite = () => {
          d.io.external(ext.text);
          extBytes = d.io.bytes.slice();
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
      const qctx = () => `${ctx()} req=${JSON.stringify(req)}`;

      try {
        if (!out.ok) {
          if (process.env.BL_FUZZ_TRACE && new RegExp(process.env.BL_FUZZ_TRACE).test(out.why)) process.stderr.write(`TRACE ${qctx()} :: ${out.why}\n`);
          expect(out.verbatim, `${qctx()} [note text]`).toEqual({ before: req.beforeText, after: req.afterText });
          // Byte-identical: to the file before the edit, or to exactly what the external write that raced it left
          // (SPEC 10 Phase 2: "the file is byte-identical afterwards"; a refusal's own splice must not land).
          const now = decodeDeck(d.io.bytes).src;
          if (mode === 1 && fired) {
            expect(extBytes !== null && bytesEqual(d.io.bytes, extBytes), `${qctx()} [note: not the external write's bytes] ${out.why}`).toBe(true);
          } else {
            expect(bytesEqual(d.io.bytes, before), `${qctx()} [note: not byte-identical] ${out.why}`).toBe(true);
          }
          if (marker) expect(now.includes(marker), `${qctx()} [note: external change lost] ${externalKind}`).toBe(true);
          if (out.code === 'noop') {
            stats.noops++;
            reason('queue: noop');
          } else {
            expect(RULE_CODES.has(out.code), `${qctx()} [not a note by rule: ${out.code}] ${out.why}`).toBe(true);
            stats.notes++;
            reason(`queue ${out.code}: ${reasonKey(out.why)}`);
          }
          continue;
        }
        stats.written++;
        if (picked) stats.pickWritten++;
        if (mode === 0) stats.staleWritten++;
        if (out.merged) stats.merged++;
        expect(out.merged, qctx()).toBe(out.record.versionBefore !== req.version);
        const newBytes = d.io.bytes.slice();
        const dec = decodeDeck(newBytes);
        expect(dec.utf8, qctx()).toBe(true);
        expect(out.version, qctx()).toBe(sha256(newBytes));
        // The source the write was planned on: the record's versionBefore.
        const oldSrc = mode === 1 && sha256(before) !== out.record.versionBefore ? null : beforeSrc;
        const rec = out.record;
        const base = oldSrc ?? dec.src.slice(0, rec.start) + rec.rawBefore + dec.src.slice(rec.start + rec.rawAfter.length);
        expect(sha256(new TextEncoder().encode(base)), qctx()).toBe(rec.versionBefore);
        // The diff is exactly the record's splice.
        expect(dec.src, qctx()).toBe(base.slice(0, rec.start) + rec.rawAfter + base.slice(rec.start + rec.rawBefore.length));
        const oldMap = buildMap(base, { version: rec.versionBefore, utf8: true });
        const newMap = buildMap(dec.src, { version: out.version, utf8: true });
        // The diff touches only the target run's range.
        const oldRun = allRuns(oldMap).find((x) => x.id === out.runId);
        expect(oldRun, qctx()).toBeTruthy();
        expect(rec.start >= oldRun!.start && rec.start + rec.rawBefore.length <= oldRun!.end, qctx()).toBe(true);
        // Re-mapping finds the new text at the target, and every other run is as it was.
        const newRun = allRuns(newMap).find((x) => x.id === out.runId);
        expect(newRun?.value, qctx()).toBe(req.afterText);
        const others = (m: DeckMap) =>
          allRuns(m)
            .filter((x) => x.id !== out.runId && !(x.strategy !== 'html-text' && (x as LiteralRun).html && !m.units[(x as LiteralRun).unit].html))
            .map((x) => `${x.id}\u0000${x.value}`);
        expect(others(newMap), qctx()).toEqual(others(oldMap));
        // No new parse errors (by code).
        const oc = codeCounts(oldMap);
        for (const [code, n] of codeCounts(newMap)) expect(n <= (oc.get(code) ?? 0), `${qctx()} new ${code}`).toBe(true);
        // The external change survived (whether it came before the edit or raced its write).
        if (marker) expect(dec.src.includes(marker), `${qctx()} [external change lost] ${externalKind}`).toBe(true);

        // Undo restores the bytes exactly; redo restores the edit's bytes exactly.
        const u = await d.q.undo(rec);
        expect(u.ok, `${qctx()} undo ${u.ok ? '' : u.why}`).toBe(true);
        expect(decodeDeck(d.io.bytes).src, qctx()).toBe(base);
        expect(sha256(d.io.bytes), qctx()).toBe(rec.versionBefore);
        if (r.chance(0.7)) {
          const re = await d.q.redo(rec);
          expect(re.ok, `${qctx()} redo ${re.ok ? '' : re.why}`).toBe(true);
          expect(bytesEqual(d.io.bytes, newBytes), qctx()).toBe(true);
          if (r.chance(0.3)) {
            // Undo in a changed file (case 2): an external change away from the edit. Case 2 is placed by position
            // and written only where the text on both sides of the write confirms it (E-1, the hardening round):
            // a change inside that text refuses it by rule (case 3, the file untouched), never a write elsewhere.
            const src = decodeDeck(d.io.bytes).src;
            const body = /<body[^>]*>/i.exec(src);
            const at = body ? body.index + body[0].length : 0;
            if (rec.start - at > 64) {
              const ins = '<p>Later external change</p>';
              d.io.external(src.slice(0, at) + ins + src.slice(at));
              const extBytes = d.io.bytes.slice();
              const u2 = await d.q.undo(rec);
              if (u2.ok) {
                expect(decodeDeck(d.io.bytes).src, qctx()).toBe(base.slice(0, at) + ins + base.slice(at));
                stats.undoCase2++;
              } else {
                expect(u2, `${qctx()} undo case 2 refused ${u2.why}`).toMatchObject({ code: 'stale', canMakeNote: true });
                expect(bytesEqual(d.io.bytes, extBytes), `${qctx()} undo case 2 refused but the file changed`).toBe(true);
                // Refused only when the change is near the write: within the floor of what must stay unchanged.
                expect(rec.start - at, `${qctx()} undo case 2 refused with the change ${rec.start - at} characters away`).toBeLessThan(2048);
                stats.undoCase2Refused++;
              }
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
      `  written ${stats.written} (${pct(stats.written)}), notes by rule ${stats.notes} (${pct(stats.notes)}), no-ops ${stats.noops} (${pct(stats.noops)})`,
      `  picked candidates ${stats.picks} (written ${stats.pickWritten}), stale-version edits ${stats.stale} (written ${stats.staleWritten}), merged writes ${stats.merged}, conflicting writes ${stats.conflicts}, undo case 2 ${stats.undoCase2} (refused by rule ${stats.undoCase2Refused})`,
      '  why edits became notes or no-ops:',
      ...[...stats.reasons.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `    ${String(n).padStart(4)}  ${k}`),
      `  failures: ${failures.length}`,
      ...failures.slice(0, 20).map((f) => `    ${f}`),
    ];
    process.stderr.write(lines.join('\n') + '\n');
    expect(failures).toEqual([]);
    expect(stats.edits).toBeGreaterThanOrEqual(Math.min(EDITS, 1000));
    expect(stats.written + stats.notes + stats.noops).toBe(stats.edits);
    // A fuzz that only produced notes would test nothing.
    expect(stats.written).toBeGreaterThan(stats.edits / 3);
  }, 600_000);
});

function reasonKey(why: string): string {
  return why.replace(/ \d+/g, ' N').replace(/ at N.*/, '').replace(/\(.*?\)/g, '').replace(/U\+[0-9A-F]+/g, 'U+X').slice(0, 90).trim();
}
