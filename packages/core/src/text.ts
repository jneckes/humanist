// Text units, encoding and line endings (9.2, "Text units, encoding and line endings").
// Environment-neutral: no Node or DOM APIs beyond TextDecoder/TextEncoder.

import type { LineEnding } from './types';

export interface DecodedDeck {
  /** True when the bytes passed the fatal UTF-8 decode (9.2 rule 1). */
  utf8: boolean;
  /**
   * The decoded string: the only coordinate space (9.2 rule 2). For a deck that failed UTF-8 this is
   * the latin1 decoding (one character per byte); such a deck opens read-only and is never written.
   */
  src: string;
  /** src starts with U+FEFF (9.2 rule 3). */
  bom: boolean;
  lineEnding: LineEnding;
}

export function decodeDeck(bytes: Uint8Array): DecodedDeck {
  let src: string;
  let utf8 = true;
  try {
    src = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    utf8 = false;
    src = latin1(bytes);
  }
  return { utf8, src, bom: src.charCodeAt(0) === 0xfeff, lineEnding: detectLineEnding(src) };
}

/** One character per byte (ISO-8859-1), for decks that are not UTF-8 (9.1 Charset). */
export function latin1(bytes: Uint8Array): string {
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return out;
}

export function encodeDeck(src: string): Uint8Array {
  return new TextEncoder().encode(src);
}

/** HTML whitespace for "whitespace-only" text nodes: U+0020, tab, LF, CR and FF only. NBSP is not whitespace (9.2 Strategy 1). */
export function isHtmlWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c;
}

export function isWhitespaceOnly(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (!isHtmlWhitespace(s.charCodeAt(i))) return false;
  return true;
}

/** The file's dominant existing line ending; new line breaks are written with it (9.2 rule 4). */
export function detectLineEnding(src: string): LineEnding {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c === 0x0d) {
      if (src.charCodeAt(i + 1) === 0x0a) {
        crlf++;
        i++;
      } else cr++;
    } else if (c === 0x0a) lf++;
  }
  if (crlf >= lf && crlf >= cr && crlf > 0) return '\r\n';
  if (cr > lf) return '\r';
  return '\n';
}

/**
 * Maps UTF-16 offsets to 1-based line and column (col in UTF-16 code units, SourceLoc).
 * A line break is LF, CRLF or a lone CR, as editors count them.
 */
export class LineIndex {
  private readonly starts: number[];

  constructor(src: string) {
    const starts = [0];
    for (let i = 0; i < src.length; i++) {
      const c = src.charCodeAt(i);
      if (c === 0x0d) {
        if (src.charCodeAt(i + 1) === 0x0a) i++;
        starts.push(i + 1);
      } else if (c === 0x0a) starts.push(i + 1);
    }
    this.starts = starts;
  }

  /** 1-based line and column of a UTF-16 offset. */
  at(offset: number): { line: number; col: number } {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: offset - this.starts[lo] + 1 };
  }

  /** UTF-16 offset of the start of a 1-based line. */
  lineStart(line: number): number {
    return this.starts[Math.max(0, Math.min(line - 1, this.starts.length - 1))];
  }

  get lineCount(): number {
    return this.starts.length;
  }
}
