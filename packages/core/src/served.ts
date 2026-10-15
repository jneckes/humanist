// The served copy (9.1 Protocol › Serving; 9.2 Strategy 1 step 3; 9.9 Protected network policy). What the
// deck view loads in place of the file: the notes block removed, every data-bl-e already in the source
// removed, ` data-bl-e="bl-<n>"` inserted right after each stamped element's tag name, and in Protected
// view the resource hints removed. Every change comes from the map's own parse (DeckMap.served), so the
// stamps in the page are exactly the map's. Only the deck view sees this copy; the file is never written
// from it.

import { mapHtmlText, STAMP_ATTR } from './mapper-html';
import { LineIndex } from './text';
import type { DeckMap, ServedPlan } from './types';

interface Op {
  start: number;
  end: number;
  text: string;
}

/**
 * Builds the served copy of src from its map. For a deck that is not UTF-8 (map.utf8 false) src is the
 * latin1 decoding: the copy has no stamps, everything inserted is ASCII, and the caller encodes it with
 * encodeLatin1 (9.1 Charset).
 */
export function buildServedCopy(src: string, map: DeckMap, opts: { protected: boolean }): string {
  const plan: ServedPlan =
    map.served ?? mapHtmlText(src, { notesBlock: map.notesBlock, lines: new LineIndex(src), utf8: map.utf8 }).served;
  if (plan.srcLength !== src.length) throw new Error('buildServedCopy: the map was built from another version of the file');
  const ops: Op[] = [];
  if (map.notesBlock) ops.push({ start: map.notesBlock.start, end: map.notesBlock.end, text: '' });
  for (const r of plan.strip) ops.push({ start: r.start, end: r.end, text: '' });
  if (map.utf8) for (const st of plan.stamps) ops.push({ start: st.offset, end: st.offset, text: ` ${STAMP_ATTR}="${st.stamp}"` });
  if (opts.protected) for (const h of plan.hints) ops.push({ start: h.start, end: h.end, text: h.text });
  // Insertions sort before a replacement that starts at the same offset.
  ops.sort((a, b) => a.start - b.start || a.end - a.start - (b.end - b.start));
  let out = '';
  let pos = 0;
  for (const op of ops) {
    // The plan's ranges come from distinct attributes and tags, so they never overlap; if they do, the
    // plan is wrong and serving it could misplace a stamp.
    if (op.start < pos || op.end < op.start || op.end > src.length) throw new Error('buildServedCopy: overlapping edits');
    out += src.slice(pos, op.start) + op.text;
    pos = op.end;
  }
  return out + src.slice(pos);
}
