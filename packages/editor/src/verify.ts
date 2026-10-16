// FSL-1.1-ALv2 (packages/editor/LICENSE.md)
//
// verifyEdit and verifyUndo: the Write protocol's step 5 (9.2) and Strategy 2's extra checks (step 5.4),
// run on the exact text that is about to be written, re-parsed from scratch (buildMap). The edit is
// accepted only if all of these hold:
//   - the new source is the old one with exactly the planned splice, and it is valid UTF-16 for UTF-8;
//   - the same run holds afterText: for html-text the run of the element with the same stamp site (its
//     source position) and the same textIndex; for literals the same literal (same content start) and
//     run index, whose cooked value equals the expected value;
//   - nothing else moved: every other run, literal, script, stamp site, stripped attribute, resource hint,
//     key and shadow value is unchanged, shifted by the splice's delta when it lies after it. A text edit
//     cannot change the tree, so any difference means the edit did, and it is refused;
//   - parse5 reports no new parse errors: every error of the new parse is an old one, by code, at its old
//     position mapped through the splice (so the multiset of codes never grows);
//   - literals: acorn parses the whole edited script with the mapper's options and the edited literal cooks
//     to the expected value; a JSON block passes JSON.parse and the edited value equals the expected string;
//     the file has the same <script> elements, with their ranges outside the splice unchanged.

import { parse as acornParse, type Node as AcornNode } from 'acorn';
import { PLACEHOLDER } from '@blueline/core/js-literals';
import type { DeckMap, EditRequest } from '@blueline/core/types';
import type { EditPlan } from './plan';
import { isWellFormed } from './splice';

export type VerifyResult = { ok: true } | { ok: false; why: string };

/** One splice, as verify sees it. */
export interface SpliceSpan {
  start: number;
  /** End of the replaced range in the old source. */
  endOld: number;
  /** End of the inserted text in the new source. */
  endNew: number;
  delta: number;
}

export function spanOf(start: number, rawBefore: string, rawAfter: string): SpliceSpan {
  return {
    start,
    endOld: start + rawBefore.length,
    endNew: start + rawAfter.length,
    delta: rawAfter.length - rawBefore.length,
  };
}

const OK: VerifyResult = { ok: true };

function fail(why: string): VerifyResult {
  return { ok: false, why };
}

/** Where an old range lies in the new source when the splice does not touch it; null if it does. */
function mapRange(a: number, b: number, s: SpliceSpan): { start: number; end: number } | null {
  if (b <= s.start) return { start: a, end: b };
  if (a >= s.endOld) return { start: a + s.delta, end: b + s.delta };
  return null;
}

/** An old point (a stamp site) in the new source; null if the splice replaced it. */
function mapPoint(p: number, s: SpliceSpan): number | null {
  if (p <= s.start) return p;
  if (p >= s.endOld) return p + s.delta;
  return null;
}

/** True if [a, b) contains the whole splice, so it grows or shrinks by delta. */
function contains(a: number, b: number, s: SpliceSpan): boolean {
  return a <= s.start && b >= s.endOld;
}

/** True if [a, b) touches or overlaps the splice (closed at both ends: an insertion at a boundary touches). */
function touches(a: number, b: number, s: SpliceSpan): boolean {
  return a <= s.endOld && b >= s.start;
}

/** What the comparison expects at the target. `raw` (undo and redo): anything touching the splice may change. */
type Target =
  | { kind: 'html'; runId: string; stampOffset: number; stamp: string; textIndex: number; afterText: string }
  | { kind: 'literal'; runId: string; unitIndex: number; scriptIndex: number; expectedCooked: string; afterText: string }
  | { kind: 'raw' };

/**
 * Every error of the new parse must be an old error with the same code, at its old position mapped through
 * the splice (an old error at or inside the splice may now sit anywhere in the inserted text). With
 * `allowInside` (undo, which restores text the file held before), errors inside the inserted text are also
 * accepted. Returns why it failed, or null.
 */
export function checkParseErrors(
  oldErrs: DeckMap['parseErrors'],
  newErrs: DeckMap['parseErrors'],
  s: SpliceSpan,
  allowInside: boolean,
): string | null {
  const pool = oldErrs.map((e) => {
    if (e.offset < s.start) return { code: e.code, lo: e.offset, hi: e.offset, used: false };
    if (e.offset > s.endOld) return { code: e.code, lo: e.offset + s.delta, hi: e.offset + s.delta, used: false };
    return { code: e.code, lo: s.start, hi: s.endNew, used: false };
  });
  for (const e of newErrs) {
    let best = -1;
    for (let k = 0; k < pool.length; k++) {
      const p = pool[k];
      if (p.used || p.code !== e.code || e.offset < p.lo || e.offset > p.hi) continue;
      // Prefer an exact position, so an error that can sit anywhere in the splice is kept for the others.
      if (best < 0 || (p.lo === p.hi && pool[best].lo !== pool[best].hi)) best = k;
    }
    if (best >= 0) {
      pool[best].used = true;
      continue;
    }
    if (allowInside && e.offset >= s.start && e.offset <= s.endNew) continue;
    return `new parse error ${e.code} at ${e.offset}`;
  }
  return null;
}

/** True if a literal run is a shadow run (the innerHTML reading of a plain literal; mapper-literals). */
function isShadow(map: DeckMap, run: DeckMap['literals'][number]): boolean {
  const unit = map.units[run.unit];
  return run.html && !!unit && !unit.html;
}

/**
 * Compares the maps of the old and new source through the splice. Returns why they disagree, or null.
 */
function compareMaps(oldMap: DeckMap, newMap: DeckMap, s: SpliceSpan, target: Target): string | null {
  const raw = target.kind === 'raw';
  if (!newMap.utf8) return 'the new file is not UTF-8';
  if (newMap.bom !== oldMap.bom) return 'the BOM changed';

  // ------------------------------------------------------------ notes block
  if ((oldMap.notesBlock === null) !== (newMap.notesBlock === null)) return 'the notes block appeared or disappeared';
  if (oldMap.notesBlock && newMap.notesBlock) {
    const m = mapRange(oldMap.notesBlock.start, oldMap.notesBlock.end, s);
    if (!m || m.start !== newMap.notesBlock.start || m.end !== newMap.notesBlock.end) return 'the notes block moved';
  }

  // ------------------------------------------------------------ Strategy 1 runs and stamps
  if (newMap.stampCount !== oldMap.stampCount) return 'the number of stamped elements changed';
  if (newMap.runs.length !== oldMap.runs.length) return 'the number of text runs changed';
  let sawTarget = false;
  for (let i = 0; i < oldMap.runs.length; i++) {
    const o = oldMap.runs[i];
    const n = newMap.runs[i];
    if (o.id !== n.id || o.stamp !== n.stamp || o.textIndex !== n.textIndex || o.tagName !== n.tagName) {
      return `text runs were renumbered at ${o.id}`;
    }
    if (target.kind === 'html' && o.id === target.runId) {
      sawTarget = true;
      if (n.value !== target.afterText) return 'the run does not hold afterText';
      if (!n.aligned) return 'the edited run is no longer aligned';
      if (n.start !== o.start || n.end !== o.end + s.delta) return 'the edited run moved';
      continue;
    }
    const m = mapRange(o.start, o.end, s);
    if (!m) {
      if (raw && touches(o.start, o.end, s)) continue; // undo: the run the splice restores
      return `the splice reaches into another run (${o.id})`;
    }
    if (raw && touches(o.start, o.end, s)) continue;
    if (n.start !== m.start || n.end !== m.end) return `run ${o.id} moved`;
    if (n.value !== o.value || n.aligned !== o.aligned || n.usesNbspRef !== o.usesNbspRef) return `run ${o.id} changed`;
  }
  if (target.kind === 'html' && !sawTarget) return 'the edited run is gone';

  const os = oldMap.served;
  const ns = newMap.served;
  if (!os || !ns) return 'a map has no served plan';
  if (ns.srcLength !== os.srcLength + s.delta) return 'the served plan does not fit the new source';
  if (os.stamps.length !== ns.stamps.length) return 'the stamp sites changed';
  for (let i = 0; i < os.stamps.length; i++) {
    if (os.stamps[i].stamp !== ns.stamps[i].stamp || mapPoint(os.stamps[i].offset, s) !== ns.stamps[i].offset) {
      return `stamp site ${os.stamps[i].stamp} moved`;
    }
  }
  for (const [name, a, b] of [
    ['stripped attribute', os.strip, ns.strip],
    ['resource hint', os.hints, ns.hints],
  ] as const) {
    if (a.length !== b.length) return `the ${name}s changed`;
    for (let i = 0; i < a.length; i++) {
      const m = mapRange(a[i].start, a[i].end, s);
      if (!m || m.start !== b[i].start || m.end !== b[i].end) return `a ${name} moved`;
    }
  }
  // ------------------------------------------------------------ Strategy 1: the run by element position
  if (target.kind === 'html') {
    // 9.2 Write protocol step 5: the same run is the same element (its source position) and textIndex.
    const site = ns.stamps.find((st) => st.offset === mapPoint(target.stampOffset, s));
    const run = site ? newMap.runs.find((r) => r.stamp === site.stamp && r.textIndex === target.textIndex) : undefined;
    if (!run || run.value !== target.afterText) return 'the element at the same position does not hold afterText';
  }

  // ------------------------------------------------------------ scripts
  if (newMap.scripts.length !== oldMap.scripts.length) return 'the number of <script> elements changed';
  for (let i = 0; i < oldMap.scripts.length; i++) {
    const o = oldMap.scripts[i];
    const n = newMap.scripts[i];
    if (o.kind !== n.kind || o.type !== n.type || o.hasSrc !== n.hasSrc) return `script ${i} changed kind`;
    if (o.parsed && !n.parsed) return `script ${i} no longer parses`;
    if (!raw && o.parsed !== n.parsed) return `script ${i} changed`;
    // The script that holds the splice grows by delta; for undo, any script whose text holds the splice.
    const inside = (target.kind === 'literal' && i === target.scriptIndex) || (raw && contains(o.contentStart, o.contentEnd, s));
    if (inside) {
      if (!contains(o.contentStart, o.contentEnd, s)) return 'the splice is not inside its script';
      if (n.start !== o.start || n.contentStart !== o.contentStart || n.contentEnd !== o.contentEnd + s.delta || n.end !== o.end + s.delta) {
        return `script ${i} range changed`;
      }
      continue;
    }
    const m = mapRange(o.start, o.end, s);
    const mc = mapRange(o.contentStart, o.contentEnd, s);
    if (!m || !mc) return `the splice reaches into script ${i}`;
    if (n.start !== m.start || n.end !== m.end || n.contentStart !== mc.start || n.contentEnd !== mc.end) return `script ${i} moved`;
  }

  // ------------------------------------------------------------ Strategy 2 units
  if (newMap.units.length !== oldMap.units.length) return 'the number of literals changed';
  for (let i = 0; i < oldMap.units.length; i++) {
    const o = oldMap.units[i];
    const n = newMap.units[i];
    if (o.kind !== n.kind || o.quote !== n.quote || o.scriptIndex !== n.scriptIndex || o.html !== n.html) return `literal ${i} changed kind`;
    const isTarget = target.kind === 'literal' && i === target.unitIndex;
    if (isTarget || (raw && touches(o.start, o.end, s))) {
      if (!contains(o.start, o.end, s)) return `the splice is not inside literal ${i}`;
      if (n.start !== o.start || n.end !== o.end + s.delta) return `literal ${i} moved`;
      if (isTarget && (n.cooked !== target.expectedCooked || !n.aligned)) return 'the literal does not cook to the expected value';
      if (!placeholdersMapped(o.placeholders, n.placeholders, s)) return `the \${…} of literal ${i} changed`;
      continue;
    }
    const m = mapRange(o.start, o.end, s);
    if (!m) return `the splice reaches into literal ${i}`;
    if (n.start !== m.start || n.end !== m.end || n.cooked !== o.cooked || n.aligned !== o.aligned) return `literal ${i} changed`;
    if (!placeholdersMapped(o.placeholders, n.placeholders, s)) return `the \${…} of literal ${i} moved`;
  }

  // ------------------------------------------------------------ Strategy 2 runs
  // A shadow run exists only while its literal reads differently as HTML, so shadow runs of the edited
  // literal may come and go; every other run must be there, in order.
  const touchedUnit = (unit: number): boolean => {
    if (target.kind === 'literal') return unit === target.unitIndex;
    if (raw) {
      const u = oldMap.units[unit];
      return !!u && touches(u.start, u.end, s);
    }
    return false;
  };
  const oldLits = oldMap.literals.filter((l) => !(touchedUnit(l.unit) && isShadow(oldMap, l)));
  const newLits = newMap.literals.filter((l) => !(touchedUnit(l.unit) && isShadow(newMap, l)));
  if (oldLits.length !== newLits.length) return 'the number of literal runs changed';
  let sawLit = false;
  for (let i = 0; i < oldLits.length; i++) {
    const o = oldLits[i];
    const n = newLits[i];
    if (o.id !== n.id || o.unit !== n.unit || o.runIndex !== n.runIndex || o.strategy !== n.strategy || o.html !== n.html) {
      return `literal runs were renumbered at ${o.id}`;
    }
    if (o.placeholder !== n.placeholder) return `literal run ${o.id} changed`;
    if (target.kind === 'literal' && o.id === target.runId) {
      sawLit = true;
      if (n.value !== target.afterText) return 'the literal run does not hold afterText';
      if (n.aligned === false) return 'the edited literal run is no longer aligned';
      if (n.start !== o.start || n.end !== o.end + s.delta) return 'the edited literal run moved';
      continue;
    }
    const m = mapRange(o.start, o.end, s);
    if (!m) {
      // Runs that cover their whole literal (unaligned or shadow runs) contain the splice of their literal.
      if (touchedUnit(o.unit) && contains(o.start, o.end, s) && n.start === o.start && n.end === o.end + s.delta) {
        if (raw || n.value === o.value) continue;
      }
      if (raw && touchedUnit(o.unit)) continue;
      return `the splice reaches into literal run ${o.id}`;
    }
    if (raw && touchedUnit(o.unit) && touches(o.start, o.end, s)) continue;
    if (n.start !== m.start || n.end !== m.end || n.value !== o.value || (n.aligned ?? true) !== (o.aligned ?? true)) {
      return `literal run ${o.id} changed`;
    }
  }
  if (target.kind === 'literal' && !sawLit) return 'the edited literal run is gone';

  // ------------------------------------------------------------ keys
  // Last, so a script that no longer parses (and so lost its object keys) reports that first.
  if (oldMap.keyValues.length !== newMap.keyValues.length || oldMap.keyValues.some((k, i) => newMap.keyValues[i] !== k)) {
    return 'the key values changed (attribute values or object keys)';
  }

  // ------------------------------------------------------------ shadow values (D-a)
  // Text from sources Blueline never writes (templates, raw text, attributes, handlers, data blocks, tagged
  // templates, dropped Strategy 1 text, numbers) cannot change with a text edit. `repeated-number` shadows
  // are left out: they count occurrences of a literal's text in the whole file, which an edit may change.
  const fixed = (m: DeckMap) => (m.shadows ?? []).filter((x) => x.kind !== 'repeated-number');
  const os2 = fixed(oldMap);
  const ns2 = fixed(newMap);
  if (os2.length !== ns2.length || os2.some((x, i) => ns2[i].kind !== x.kind || ns2[i].value !== x.value)) {
    return 'the shadow values changed (text the page may show that Blueline never writes)';
  }
  return null;
}

function placeholdersMapped(
  o: { start: number; end: number }[] | undefined,
  n: { start: number; end: number }[] | undefined,
  s: SpliceSpan,
): boolean {
  const a = o ?? [];
  const b = n ?? [];
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const m = mapRange(a[i].start, a[i].end, s);
    if (!m || m.start !== b[i].start || m.end !== b[i].end) return false;
  }
  return true;
}

/** Finds the string Literal or untagged TemplateLiteral spanning exactly [start, end) of a script's AST. */
function findLiteralNode(ast: AcornNode, start: number, end: number): AcornNode | null {
  const stack: { node: AcornNode; parent: AcornNode | null }[] = [{ node: ast, parent: null }];
  while (stack.length > 0) {
    const { node, parent } = stack.pop()!;
    if (node.start === start && node.end === end) {
      const n = node as unknown as { type: string; value?: unknown };
      if (n.type === 'Literal' && typeof n.value === 'string') return node;
      if (n.type === 'TemplateLiteral') {
        const p = parent as unknown as { type: string; quasi?: unknown } | null;
        if (!(p && p.type === 'TaggedTemplateExpression' && p.quasi === node)) return node;
      }
    }
    // Every child node (keys included: the mapper treats string keys as literals too), pruned to the range.
    for (const key of Object.keys(node)) {
      if (key === 'loc') continue;
      const v = (node as unknown as Record<string, unknown>)[key];
      const kids = Array.isArray(v) ? v : [v];
      for (const k of kids) {
        if (k && typeof k === 'object' && typeof (k as { type?: unknown }).type === 'string') {
          const c = k as AcornNode;
          if (c.start <= start && c.end >= end) stack.push({ node: c, parent: node });
        }
      }
    }
  }
  return null;
}

/** Strategy 2 step 5.4: the whole edited script parses, and the edited literal cooks to the expected value. */
function checkLiteral(newSrc: string, newMap: DeckMap, plan: EditPlan, s: SpliceSpan): string | null {
  const lit = plan.literal!;
  const script = newMap.scripts[lit.scriptIndex];
  if (!script) return 'the script is gone';
  const content = newSrc.slice(script.contentStart, script.contentEnd);
  const unitStart = lit.unitStart;
  const unitEnd = lit.unitEnd + s.delta;
  if (script.kind === 'json') {
    try {
      JSON.parse(content);
    } catch {
      return 'the JSON block no longer parses';
    }
    let value: unknown;
    try {
      value = JSON.parse(newSrc.slice(unitStart - 1, unitEnd + 1));
    } catch {
      return 'the edited JSON string does not parse';
    }
    return value === lit.expectedCooked ? null : 'the edited JSON value differs from the expected string';
  }
  if (script.kind !== 'classic' && script.kind !== 'module') return 'the literal is not in a JS script';
  let ast: AcornNode;
  try {
    // The same options as the mapper (9.2 Strategy 2 step 1).
    ast = acornParse(content, { ecmaVersion: 'latest', sourceType: script.kind === 'module' ? 'module' : 'script', locations: true });
  } catch {
    return 'the edited script no longer parses';
  }
  const node = findLiteralNode(ast, unitStart - 1 - script.contentStart, unitEnd + 1 - script.contentStart);
  if (!node) return 'the edited literal is not in the script';
  let cooked: string;
  const n = node as unknown as { type: string; value?: unknown; quasis?: { value: { cooked?: string | null } }[] };
  if (n.type === 'Literal') {
    cooked = n.value as string;
  } else {
    const parts: string[] = [];
    for (const q of n.quasis ?? []) {
      if (typeof q.value.cooked !== 'string') return 'the edited template has an invalid escape';
      parts.push(q.value.cooked);
    }
    cooked = parts.join(PLACEHOLDER);
  }
  return cooked === lit.expectedCooked ? null : 'the edited literal cooks to a different value';
}

/**
 * Verifies a planned edit against the re-parsed new source (9.2 Write protocol step 5, Strategy 2 step
 * 5.4). `newMap` must be buildMap(newSrc). `req` is the request as sent (its afterText is what the page must
 * now show).
 */
export function verifyEdit(
  oldSrc: string,
  newSrc: string,
  oldMap: DeckMap,
  newMap: DeckMap,
  plan: EditPlan,
  req: Pick<EditRequest, 'afterText'>,
): VerifyResult {
  if (plan.afterText !== req.afterText) return fail('the plan is for another text');
  if (oldSrc.slice(plan.start, plan.end) !== plan.rawBefore) return fail('the plan does not fit the old source');
  if (newSrc !== oldSrc.slice(0, plan.start) + plan.rawAfter + oldSrc.slice(plan.end)) {
    return fail('the new source is not the old one with exactly the planned splice');
  }
  if (!isWellFormed(newSrc)) return fail('the new source has a lone surrogate');
  if (!oldMap.utf8 || !newMap.utf8) return fail('not UTF-8');
  const s = spanOf(plan.start, plan.rawBefore, plan.rawAfter);
  let target: Target;
  if (plan.strategy === 'html-text') {
    if (!plan.html) return fail('the plan has no element identity');
    target = { kind: 'html', runId: plan.runId, ...plan.html, afterText: req.afterText };
  } else {
    if (!plan.literal) return fail('the plan has no literal identity');
    target = {
      kind: 'literal',
      runId: plan.runId,
      unitIndex: plan.literal.unitIndex,
      scriptIndex: plan.literal.scriptIndex,
      expectedCooked: plan.literal.expectedCooked,
      afterText: req.afterText,
    };
  }
  // The splice must lie inside the run (9.2 Committing an edit step 4).
  if (plan.start < plan.runStart || plan.end > plan.runEnd) return fail('the splice is not inside the run');
  const why = compareMaps(oldMap, newMap, s, target) ?? checkParseErrors(oldMap.parseErrors, newMap.parseErrors, s, false);
  if (why) return fail(why);
  if (plan.literal) {
    const lw = checkLiteral(newSrc, newMap, plan, s);
    if (lw) return fail(lw);
  }
  return OK;
}

/**
 * Verifies an undo or redo splice (9.2 Undo and redo): the new source is the old one with exactly that
 * splice, the range now holds the restored raw text, parse5 reports no new errors outside the restored
 * text, no script stops parsing, and nothing away from the splice moved or changed.
 */
export function verifyUndo(
  oldSrc: string,
  newSrc: string,
  oldMap: DeckMap,
  newMap: DeckMap,
  splice: { start: number; rawBefore: string; rawAfter: string },
): VerifyResult {
  const { start, rawBefore, rawAfter } = splice;
  if (oldSrc.slice(start, start + rawBefore.length) !== rawBefore) return fail('the range does not hold the text to replace');
  if (newSrc !== oldSrc.slice(0, start) + rawAfter + oldSrc.slice(start + rawBefore.length)) {
    return fail('the new source is not the old one with exactly the undo splice');
  }
  if (newSrc.slice(start, start + rawAfter.length) !== rawAfter) return fail('the range does not hold the restored text');
  if (!isWellFormed(newSrc)) return fail('the new source has a lone surrogate');
  if (!oldMap.utf8 || !newMap.utf8) return fail('not UTF-8');
  const s = spanOf(start, rawBefore, rawAfter);
  const why = compareMaps(oldMap, newMap, s, { kind: 'raw' }) ?? checkParseErrors(oldMap.parseErrors, newMap.parseErrors, s, true);
  return why ? fail(why) : OK;
}
