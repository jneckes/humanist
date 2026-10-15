// FSL-1.1-ALv2 (packages/editor/LICENSE.md)
//
// The one way the patcher changes source text (9.2 rule 5): magic-string on src at the original offsets.
// Offsets are UTF-16 indices into the decoded file string (9.2 rule 2), never byte offsets.

import MagicString from 'magic-string';

/** One raw splice in src: replace [start, end) with `text`. start === end is a pure insertion. */
export interface Splice {
  start: number;
  end: number;
  text: string;
}

/**
 * Applies one splice with magic-string (9.2 rule 5): `appendLeft` for a pure insertion, `remove` for a pure
 * deletion, `update` otherwise (update throws on a zero-length range). The result is checked against plain
 * string slicing, so a library surprise can never place text wrongly.
 */
export function applySplice(src: string, start: number, end: number, text: string): string {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > src.length) {
    throw new RangeError(`splice [${start}, ${end}) outside 0..${src.length}`);
  }
  const ms = new MagicString(src);
  if (start === end) {
    if (text === '') return src;
    ms.appendLeft(start, text);
  } else if (text === '') {
    ms.remove(start, end);
  } else {
    ms.update(start, end, text);
  }
  const out = ms.toString();
  if (out !== src.slice(0, start) + text + src.slice(end)) throw new Error('magic-string splice disagrees with the slice');
  return out;
}

/**
 * True if s has no lone surrogate. TextEncoder writes a lone surrogate as U+FFFD, so such text cannot be
 * written byte-exactly and is refused (9.2 rule 1: the file must stay valid UTF-8 that decodes to src).
 */
export function isWellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}
