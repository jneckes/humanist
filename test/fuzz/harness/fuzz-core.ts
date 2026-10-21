// The pure parts of the Chromium fuzz gate (P2-16; SPEC 10 Phase 2 exit gate, 11 Fuzz test): the seeded random
// source, the inputs SPEC 10 Phase 2 names, the "user" who edits a field, the edit field as the overlay records it
// (9.2 Committing an edit step 1), and the oracle every written edit and every note must pass. The Electron main
// (main.ts) draws the targets from the walk, runs the writes and the mutation probe; everything here is plain
// TypeScript, so test/fuzz/unit tests it in Node.
//
// The oracle is the Node fuzz's (test/unit/editor/fuzz.test.ts), taken over check for check so the two halves of
// the gate judge alike: notes count only BY RULE (commitField's typed reasons and the queue's rule codes), a note
// leaves the file byte-identical and holds the exact before and after text, no-ops are counted apart, and a
// written edit decodes, adds no parse error, changes only the target run's range, and re-maps to the new text at
// the target with every other run as it was. The commit's text is judged by the clean-up oracle
// (cleanup-oracle.ts), which re-derives 9.2 step 3 and shares no code with core/edit-cleanup.

import type { CommitResult, FieldRun } from '@blueline/core/edit-commit';
import { buildMap } from '@blueline/core/mapper';
import { findNotesBlock } from '@blueline/core/notes-block';
import { decodeDeck, encodeDeck } from '@blueline/core/text';
import type { DeckMap, EditRequest, HtmlRun, LiteralRun, MatchReason, RefusalCode, WriteOutcome } from '@blueline/core/types';
import { judgeCleanup } from './cleanup-oracle';

// ------------------------------------------------------------------------------------------- randomness

/** mulberry32: small, fast and seedable; the same seed and corpus give the same edits. */
export function rng(seed: number) {
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
    shuffle: <T>(xs: readonly T[]): T[] => {
      const out = xs.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
}
export type Rng = ReturnType<typeof rng>;

// ------------------------------------------------------------------------------------------- inputs

/**
 * SPEC 10 Phase 2 Inputs: & < > " ' \ ` ${ } </script> <!-- emoji NBSP tabs \r\n, plus ordinary words, character
 * references spelled as text, the characters the clean-up removes, line and paragraph separators, and the
 * characters the patcher refuses by rule (NUL and BEL in HTML text, U+E000 in a literal).
 */
export const TOKENS: readonly string[] = Object.freeze([
  '&', '<', '>', '"', "'", '\\', '`', '${', '}', '{', '$', '</script>', '<!--', '-->', '</SCRIPT', '<script',
  '\u{1F680}', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}', '\u{1F1EF}\u{1F1F5}', '\u2764\uFE0F',
  '\u00A0', '\t', '\r\n', '\n', '\r', ' ', '  ',
  'a', 'Z', 'word', 'Hello', 'x', '0', '42', '\u00E9', 'e\u0301', '\u2014', '\u201C', '\u2019', '\u4E2D\u6587',
  '&amp;', '&nbsp;', '&not', 'in;', '&#', '#x41;', '&lt;b&gt;', '<b>', '</p>', '<br/>',
  '\u200B', '\uFEFF', '\u2028', '\u2029', '\\n', '\\u0041', '\\x3C', '${x}', '\u0007', '\u0000', '\uE000',
]);

/**
 * The SPEC's named inputs, with the names the report gives them: how often each was typed into a field, and how often
 * a written edit put it in the file (a pasted line break never is: the clean-up makes it a space, 9.2 step 2).
 */
export const SPEC_INPUTS: readonly { name: string; text: string }[] = Object.freeze([
  { name: '&', text: '&' },
  { name: '<', text: '<' },
  { name: '>', text: '>' },
  { name: '"', text: '"' },
  { name: "'", text: "'" },
  { name: '\\', text: '\\' },
  { name: '`', text: '`' },
  { name: '${', text: '${' },
  { name: '}', text: '}' },
  { name: '</script>', text: '</script>' },
  { name: '<!--', text: '<!--' },
  { name: 'emoji', text: '\u{1F680}' },
  { name: 'NBSP', text: '\u00A0' },
  { name: 'tab', text: '\t' },
  { name: 'CRLF', text: '\r\n' },
]);

export function randomText(r: Rng): string {
  let s = '';
  const n = 1 + r.int(4);
  for (let i = 0; i < n; i++) s += r.pick(TOKENS);
  return s;
}

/** Offsets that do not split a surrogate pair (a caret never sits inside one). */
export function boundaries(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i <= s.length; i++) {
    const c = s.charCodeAt(i);
    if (i > 0 && c >= 0xdc00 && c <= 0xdfff && s.charCodeAt(i - 1) >= 0xd800 && s.charCodeAt(i - 1) <= 0xdbff) continue;
    out.push(i);
  }
  return out;
}

/** What the edit field holds at commit: one or two changes, the way a person or a dictation tool makes them. */
export function browserEdit(r: Rng, before: string): string {
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
      case 1: // delete a selection
        s = s.slice(0, i) + s.slice(j);
        break;
      case 2: // replace a selection
        s = s.slice(0, i) + randomText(r) + s.slice(j);
        break;
      case 3: // an append like the mutation probe's (section 10), but never its sentinel: the probe of this very
        // edit looks for its sentinel in every node, and a deck that holds one already would fail it
        s = s + '\u27E6fz\u27E7';
        break;
      case 4: // type at the end; Chrome writes a trailing space as NBSP
        s = s + (r.chance(0.5) ? ' ' + randomText(r) : '\u00A0');
        break;
      case 5: // a dictated sentence pasted with a line break
        s = s.slice(0, i) + 'Dictated text\r\nwith a break' + s.slice(i);
        break;
      default: // retype the whole text (select all, type)
        s = r.chance(0.5) ? randomText(r) + ' ' + before.slice(0, 8) : 'Rewritten ' + randomText(r);
    }
  }
  return s;
}

// ------------------------------------------------------------------------------------------- the edit field

/** One text node of a captured field: its place in the element's textContent and its locator key. */
export interface FieldPart {
  start: number;
  end: number;
  data: string;
  /** probe.locatorKey of the node, or null when it has no locator (no parent element). */
  key: string | null;
}

/** The innermost element holding a text node, as the walk saw it: its textContent and every text node in it. */
export interface CapturedField {
  text: string;
  parts: FieldPart[];
}

/**
 * What a field's text node (by locator key and text) maps to: an exact run, or nothing (an unmapped stretch of the
 * field). The text matters: a deck that re-renders a container shows other text at the same locator on another
 * slide, and that node's match says nothing about this one.
 */
export type RunOfKey = (key: string, data: string) => { runId: string } | null;

/**
 * The FieldRuns the overlay records when the field opens (9.2 step 1): each text node of the element that maps
 * exactly gets its run; the others (white space, unmapped or ambiguous text) are unmapped stretches. `override`
 * names the run of one node itself: the run the author picked for the clicked node (P2-8), whose FieldRun then
 * carries the node's text. Null when the parts do not fit the field's text.
 */
export function fieldRuns(field: CapturedField, runOf: RunOfKey, override?: { key: string; runId: string }): FieldRun[] | null {
  const runs: FieldRun[] = [];
  let at = 0;
  for (const p of field.parts) {
    if (p.start !== at || p.end - p.start !== p.data.length || field.text.slice(p.start, p.end) !== p.data) return null;
    at = p.end;
    if (p.data.length === 0 || p.key === null) continue;
    const runId = override && p.key === override.key ? override.runId : runOf(p.key, p.data)?.runId;
    if (runId) runs.push({ runId, start: p.start, end: p.end, value: p.data });
  }
  return at === field.text.length ? runs : null;
}

/**
 * The ambiguity reasons whose candidates the fuzz picks (P2-8). `split` and `short` are never offered (core
 * pickKindFor); `key` and `shadow` are offered with a warning that the deck also uses the text elsewhere ("This
 * text is also used as a key"), so editing one may change what the deck does by the author's own choice, and a
 * random author who ignores the warning is not a test of the writer.
 */
export const PICKED_REASONS: ReadonlySet<MatchReason> = new Set<MatchReason>(['duplicate', 'stamp-other', 'not-equal', 'substring']);

/** Whether a text already uses curly double and single quotes (6.3: then smart punctuation curls typed ones). */
export function curlyIn(s: string): { double: boolean; single: boolean } {
  return { double: /[\u201C\u201D]/.test(s), single: /[\u2018\u2019]/.test(s) };
}

/**
 * The commit path's own oracle (the Node fuzz's): a verbatim note holds the field's exact text before, and after
 * it the field's text as the clean-up oracle (cleanup-oracle.ts) allows it; an edit names a run of the field with
 * its whole text before, and putting its new text into the field gives a text the clean-up oracle allows; an edit
 * made inside one run with the caret there is that run's (or a no-op, or structural). Its caller passes neither
 * what the author inserted nor the smart punctuation setting, so the clean-up oracle tells the field's own units
 * from inserted ones by the diff alone and accepts either setting. Returns why it fails, or null.
 */
export function checkCommit(o: {
  commit: CommitResult;
  fieldText: string;
  raw: string;
  runs: readonly FieldRun[];
  inTarget: boolean;
  caret: string | null;
  targetRunId: string;
}): string | null {
  const c = o.commit;
  if (c.kind === 'noop') return null;
  if (c.kind === 'verbatim') {
    if (c.before !== o.fieldText) return '[verbatim before] the note does not hold the field text';
    // A note made for text that holds a lone surrogate holds U+FFFD in its place ('invalid'): no clean-up to judge.
    if (c.why !== 'invalid') {
      const why = judgeCleanup({ before: o.fieldText, raw: o.raw, result: c.after, curly: curlyIn(o.fieldText) });
      if (why) return `[verbatim after] ${why}`;
    }
    if (o.inTarget && o.caret === o.targetRunId && !['emptied', 'run-emptied', 'invalid'].includes(c.why)) return `[in-run verbatim] an edit inside one run with the caret in it became ${c.why}`;
    return null;
  }
  const owners = o.runs.filter((x) => x.runId === c.runId);
  if (owners.length === 0) return `[unknown run] ${c.runId} is no run of the field`;
  if (!owners.some((x) => x.value === c.beforeText)) return '[beforeText] the edit does not carry its run\'s whole text';
  if (o.inTarget && o.caret === o.targetRunId && c.runId !== o.targetRunId) return `[caret run] the edit went to ${c.runId}, not the caret's run ${o.targetRunId}`;
  // Smart punctuation curls by the run's own text (6.3), so the run decides which curly quotes the field may gain.
  let why: string | null = null;
  for (const x of owners) {
    why = judgeCleanup({ before: o.fieldText, raw: o.raw, result: o.fieldText.slice(0, x.start) + c.afterText + o.fieldText.slice(x.end), curly: curlyIn(x.value) });
    if (!why) return null;
  }
  return `[rebuilt field] ${why}`;
}

// ------------------------------------------------------------------------------------------- the write oracle

/** The queue's codes for notes BY RULE; anything else (internal, conflict, verify, refused) is a failure. */
export const RULE_CODES: ReadonlySet<RefusalCode> = new Set<RefusalCode>(['not-utf8', 'structural', 'stale', 'ambiguous', 'placeholder', 'markup', 'escape', 'unaligned']);

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function allRuns(map: DeckMap): (HtmlRun | LiteralRun)[] {
  return [...map.runs, ...map.literals];
}

function codeCounts(map: DeckMap): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of map.parseErrors) m.set(e.code, (m.get(e.code) ?? 0) + 1);
  return m;
}

/** Run ids and texts of every run but `except`; a shadow reading (an HTML literal of a non-HTML unit) is no run of its own. */
function otherRuns(m: DeckMap, except: string): string[] {
  return allRuns(m)
    .filter((x) => x.id !== except && !(x.strategy !== 'html-text' && (x as LiteralRun).html && !m.units[(x as LiteralRun).unit].html))
    .map((x) => `${x.id}\u0000${x.value}`);
}

/**
 * A refused edit (a note): it must be a note by rule, hold the exact before and after text, and leave the file
 * byte-identical (to the file before the edit, or to the external write that raced it). Returns why it fails, or
 * null; `noop` is not a note and is the caller's to count.
 */
export function checkNote(o: {
  out: Extract<WriteOutcome, { ok: false }>;
  req: EditRequest;
  before: Uint8Array;
  now: Uint8Array;
  /** The bytes an external write that raced the edit left (the file must then be exactly those). */
  external: Uint8Array | null;
}): string | null {
  if (o.out.verbatim.before !== o.req.beforeText || o.out.verbatim.after !== o.req.afterText) return '[note text] the note does not hold the request\'s exact before and after';
  const want = o.external ?? o.before;
  if (!bytesEqual(o.now, want)) return `[note: not byte-identical] ${o.out.code}: ${o.out.why}`;
  if (o.out.code !== 'noop' && !RULE_CODES.has(o.out.code)) return `[not a note by rule: ${o.out.code}] ${o.out.why}`;
  return null;
}

/**
 * The checks after each written edit (SPEC 10 Phase 2): the file decodes, the outcome's version is its hash, the
 * diff is exactly the record's splice and lies inside the target run's range, re-mapping finds the new text at the
 * target with every other run unchanged, no parse error code is new, an external change that raced it survives,
 * and the edit landed on the run it was made on. Returns the failures (empty when it passes) and the source the
 * write was planned on.
 */
export function checkWritten(o: {
  out: Extract<WriteOutcome, { ok: true }>;
  req: EditRequest;
  /** The file before the edit was sent. */
  before: Uint8Array;
  /** The file now. */
  now: Uint8Array;
  /** An external write landed inside the atomic write (the base is then the external version, not `before`). */
  raced: boolean;
  /** Text an external change put in the file, which must still be there. */
  marker: string | null;
  sha256(bytes: Uint8Array): string;
}): { failures: string[]; base: string | null } {
  const f: string[] = [];
  const { out, req } = o;
  const dec = decodeDeck(o.now);
  if (!dec.utf8) return { failures: ['[decode] the written file is not UTF-8'], base: null };
  if (out.version !== o.sha256(o.now)) f.push('[version] the outcome\'s version is not the file\'s hash');
  const rec = out.record;
  // The source the write was planned on: the record's versionBefore, rebuilt from the file and the record.
  const base = dec.src.slice(0, rec.start) + rec.rawBefore + dec.src.slice(rec.start + rec.rawAfter.length);
  if (o.sha256(encodeDeck(base)) !== rec.versionBefore) f.push('[record] the file with the record undone is not versionBefore');
  if (!o.raced && !bytesEqual(encodeDeck(base), o.before)) f.push('[record] the write was not planned on the file as it was');
  if (dec.src !== base.slice(0, rec.start) + rec.rawAfter + base.slice(rec.start + rec.rawBefore.length)) f.push('[splice] the diff is not the record\'s splice');
  if (out.merged !== (rec.versionBefore !== req.version)) f.push(`[merged] merged is ${out.merged} but versionBefore ${rec.versionBefore === req.version ? 'is' : 'is not'} the request's version`);
  if (out.runId !== req.runId) f.push(`[target] the edit was made on ${req.runId} and written to ${out.runId}`);
  const oldMap = buildMap(base, { version: rec.versionBefore, utf8: true, defer: false });
  const newMap = buildMap(dec.src, { version: out.version, utf8: true, defer: false });
  const oldRun = allRuns(oldMap).find((x) => x.id === out.runId);
  if (!oldRun) f.push(`[target] ${out.runId} is no run of the version written on`);
  else if (!(rec.start >= oldRun.start && rec.start + rec.rawBefore.length <= oldRun.end)) f.push('[range] the splice is not inside the target run');
  const newRun = allRuns(newMap).find((x) => x.id === out.runId);
  if (newRun?.value !== req.afterText) f.push(`[remap] the target now reads ${JSON.stringify(newRun?.value?.slice(0, 80) ?? null)}, not the new text`);
  const before = otherRuns(oldMap, out.runId);
  const after = otherRuns(newMap, out.runId);
  if (before.length !== after.length || before.some((x, i) => x !== after[i])) f.push('[others] another run changed');
  const oc = codeCounts(oldMap);
  for (const [code, n] of codeCounts(newMap)) if (n > (oc.get(code) ?? 0)) f.push(`[parse] new parse error ${code}`);
  if (o.marker !== null && !dec.src.includes(o.marker)) f.push('[external] the external change was lost');
  return { failures: f, base };
}

/** A refusal's free text with numbers and positions folded, for the report's reason counts. */
export function reasonKey(why: string): string {
  return why.replace(/ \d+/g, ' N').replace(/ at N.*/, '').replace(/\(.*?\)/g, '').replace(/U\+[0-9A-F]+/g, 'U+X').slice(0, 90).trim();
}

/**
 * An external change that touches no run, no element and no text node: a comment at the end of the body, or at
 * the end of the file when the deck's notes block ends the body (it must stay the body's last element, section 8).
 * So stamps, locators and the walk's stops stay valid, and the change can only survive or be lost.
 */
export function externalComment(src: string, tag: string): { text: string; marker: string } {
  const marker = `<!-- external ${tag} -->`;
  const notes = findNotesBlock(src);
  const end = src.lastIndexOf('</body>');
  const at = end >= 0 && (!notes || end < notes.start) ? end : src.length;
  return { text: src.slice(0, at) + marker + src.slice(at), marker };
}
