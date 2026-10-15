// FSL-1.1-ALv2 (packages/editor/LICENSE.md)
//
// Write records and undo/redo planning (9.2 "Undo and redo"). A record stores the raw splice, never decoded
// text: rawBefore and rawAfter are the exact source slices the write removed and inserted at `start`,
// already encoded and escaped, with up to 32 source characters of context on each side. Undo puts rawBefore
// back in place of rawAfter, and redo is the same operation with the two swapped. Neither ever re-encodes or
// re-escapes, so an undo restores the previous bytes exactly. Cmd+Z never restores a whole-file snapshot
// (that is the separate "Restore deck to <time>" command, Phase 2 history list).

import type { WriteRecord } from '@blueline/core/types';

/** Characters of source context kept on each side of a write (9.2 Undo and redo). */
export const CONTEXT = 32;

function isHigh(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

function isLow(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}

/**
 * The 32 source characters before `start`. When the 32nd would be the low half of a surrogate pair, the
 * whole pair is kept (33 code units): the record may be stored as UTF-8, which cannot hold a lone surrogate.
 * So a context shorter than 32 always means the write was within 32 characters of the start of the file.
 */
export function contextBefore(src: string, start: number): string {
  let from = Math.max(0, start - CONTEXT);
  if (from > 0 && isLow(src.charCodeAt(from)) && isHigh(src.charCodeAt(from - 1))) from--;
  return src.slice(from, start);
}

/** The 32 source characters from `end`, likewise keeping a surrogate pair whole at the far end. */
export function contextAfter(src: string, end: number): string {
  let to = Math.min(src.length, end + CONTEXT);
  if (to < src.length && isHigh(src.charCodeAt(to - 1)) && isLow(src.charCodeAt(to))) to++;
  return src.slice(end, to);
}

/** The record of a write that replaced src[start, start + rawBefore.length) with rawAfter. */
export function makeRecord(
  src: string,
  splice: { start: number; rawBefore: string; rawAfter: string },
  versionBefore: string,
  versionAfter: string,
): WriteRecord {
  return {
    versionBefore,
    versionAfter,
    start: splice.start,
    rawBefore: splice.rawBefore,
    rawAfter: splice.rawAfter,
    prefix: contextBefore(src, splice.start),
    suffix: contextAfter(src, splice.start + splice.rawBefore.length),
  };
}

/** Redo is undo with rawBefore and rawAfter (and the two versions) swapped (9.2 Undo and redo). */
export function swapRecord(r: WriteRecord): WriteRecord {
  return { ...r, versionBefore: r.versionAfter, versionAfter: r.versionBefore, rawBefore: r.rawAfter, rawAfter: r.rawBefore };
}

/** A planned undo: replace src[start, start + rawBefore.length), which holds the write's rawAfter, with rawAfter (the write's rawBefore). */
export interface UndoPlan {
  ok: true;
  /** 1: the file is unchanged since the write; 2: it changed, and the context found the place once. */
  case: 1 | 2;
  start: number;
  /** What the undo removes now (the write's rawAfter). */
  rawBefore: string;
  /** What the undo puts back (the write's rawBefore). */
  rawAfter: string;
}

export interface UndoRefusal {
  ok: false;
  why: string;
  /** Offer "Make a note", which keeps the change as a verbatim note (9.2 Undo and redo case 3). */
  canMakeNote: boolean;
}

export const CANT_UNDO = "Can't undo in place: the deck changed since this edit";

/** True if a value is a structurally valid WriteRecord (records come back from session storage). */
export function isWriteRecord(r: unknown): r is WriteRecord {
  if (!r || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  return (
    typeof o.versionBefore === 'string' &&
    typeof o.versionAfter === 'string' &&
    typeof o.start === 'number' &&
    Number.isInteger(o.start) &&
    (o.start as number) >= 0 &&
    typeof o.rawBefore === 'string' &&
    typeof o.rawAfter === 'string' &&
    typeof o.prefix === 'string' &&
    typeof o.suffix === 'string' &&
    (o.prefix as string).length <= CONTEXT + 1 &&
    (o.suffix as string).length <= CONTEXT + 1
  );
}

/**
 * Plans the undo of `record` in the current source (9.2 Undo and redo):
 *  1. the file's hash equals versionAfter: the write's rawAfter is at `start`; replace it there;
 *  2. otherwise search for prefix + rawAfter + suffix; if it occurs exactly once, replace that rawAfter;
 *  3. otherwise refuse with "Can't undo in place", and offer Make a note.
 * A context shorter than 32 characters reached the start (or end) of the file when the write was made, so
 * the match must too: that keeps a short context from matching somewhere it never was.
 * For redo, pass swapRecord(record).
 */
export function planUndo(src: string, record: WriteRecord, currentVersion: string): UndoPlan | UndoRefusal {
  if (!isWriteRecord(record)) return { ok: false, why: 'not a write record', canMakeNote: false };
  const { start, rawBefore, rawAfter, prefix, suffix } = record;
  if (currentVersion === record.versionAfter) {
    if (start + rawAfter.length <= src.length && src.slice(start, start + rawAfter.length) === rawAfter) {
      return { ok: true, case: 1, start, rawBefore: rawAfter, rawAfter: rawBefore };
    }
    // The hash says unchanged but the text disagrees: the record does not belong to this file.
    return { ok: false, why: CANT_UNDO, canMakeNote: true };
  }
  const needle = prefix + rawAfter + suffix;
  const atFileStart = prefix.length < CONTEXT;
  const atFileEnd = suffix.length < CONTEXT;
  let found = -1;
  let count = 0;
  for (let i = src.indexOf(needle); i >= 0; i = src.indexOf(needle, i + 1)) {
    // Overlapping occurrences count: each is a different place the text could be.
    if (atFileStart && i !== 0) continue;
    if (atFileEnd && i + needle.length !== src.length) continue;
    found = i;
    count++;
    if (count > 1) break;
  }
  if (count !== 1) return { ok: false, why: CANT_UNDO, canMakeNote: true };
  return { ok: true, case: 2, start: found + prefix.length, rawBefore: rawAfter, rawAfter: rawBefore };
}
