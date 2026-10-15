import { describe, expect, it } from 'vitest';
import {
  decodeDeck,
  detectLineEnding,
  encodeDeck,
  encodeLatin1,
  isHtmlWhitespace,
  isWhitespaceOnly,
  latin1,
  LineIndex,
} from '@blueline/core/text';

const utf8 = (s: string) => new TextEncoder().encode(s);

describe('decodeDeck (9.2 rule 1)', () => {
  it('decodes UTF-8 and keeps the BOM in src (9.2 rule 3)', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('<p>é😀</p>')]);
    const d = decodeDeck(bytes);
    expect(d.utf8).toBe(true);
    expect(d.bom).toBe(true);
    expect(d.src).toBe('\uFEFF<p>é😀</p>');
    // UTF-16 offsets: the emoji is two code units.
    expect(d.src.indexOf('</p>')).toBe(7);
    expect(encodeDeck(d.src)).toEqual(bytes);
  });

  it('falls back to latin1, one character per byte, for invalid UTF-8', () => {
    // windows-1252: “quoted” café
    const bytes = new Uint8Array([0x93, 0x71, 0x94, 0x20, 0x63, 0x61, 0x66, 0xe9]);
    const d = decodeDeck(bytes);
    expect(d.utf8).toBe(false);
    expect(d.bom).toBe(false);
    expect(d.src.length).toBe(bytes.length);
    expect(d.src).toBe('\x93q\x94 caf\xe9');
    expect(encodeLatin1(d.src)).toEqual(bytes);
  });

  it('round-trips every byte through latin1', () => {
    const bytes = new Uint8Array(70000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    expect(encodeLatin1(latin1(bytes))).toEqual(bytes);
  });

  it('rejects overlong and surrogate encodings', () => {
    expect(decodeDeck(new Uint8Array([0xc0, 0xaf])).utf8).toBe(false);
    expect(decodeDeck(new Uint8Array([0xed, 0xa0, 0x80])).utf8).toBe(false);
  });

  it('reports the dominant line ending', () => {
    expect(decodeDeck(utf8('a\r\nb\r\nc\n')).lineEnding).toBe('\r\n');
    expect(decodeDeck(utf8('a\nb\r\nc\n')).lineEnding).toBe('\n');
    expect(decodeDeck(utf8('a\rb\rc\n')).lineEnding).toBe('\r');
    expect(decodeDeck(utf8('no breaks')).lineEnding).toBe('\n');
  });
});

describe('detectLineEnding', () => {
  it('counts CRLF as one break, not a CR and an LF', () => {
    expect(detectLineEnding('a\r\nb\r\nc\r\n')).toBe('\r\n');
    expect(detectLineEnding('a\r\nb\nc')).toBe('\r\n'); // tie goes to CRLF
    expect(detectLineEnding('a\rb\r\nc')).toBe('\r\n');
  });
});

describe('whitespace (9.2 Strategy 1)', () => {
  it('is only U+0020, tab, LF, CR and FF', () => {
    expect(isWhitespaceOnly('')).toBe(true);
    expect(isWhitespaceOnly(' \t\n\r\f')).toBe(true);
    expect(isWhitespaceOnly('\u00A0')).toBe(false);
    expect(isWhitespaceOnly(' \u00A0 ')).toBe(false);
    expect(isWhitespaceOnly('\v')).toBe(false);
    expect(isWhitespaceOnly('\u2003')).toBe(false);
    expect(isWhitespaceOnly('\uFEFF')).toBe(false);
    expect([0x20, 0x09, 0x0a, 0x0d, 0x0c].every(isHtmlWhitespace)).toBe(true);
  });
});

describe('LineIndex', () => {
  it('counts LF, CRLF and lone CR as one break each, columns in UTF-16 units', () => {
    const src = 'ab\r\ncd\ref\n😀g\n';
    const li = new LineIndex(src);
    expect(li.lineCount).toBe(5);
    expect(li.at(0)).toEqual({ line: 1, col: 1 });
    expect(li.at(2)).toEqual({ line: 1, col: 3 }); // the CR
    expect(li.at(3)).toEqual({ line: 1, col: 4 }); // the LF of CRLF
    expect(li.at(4)).toEqual({ line: 2, col: 1 });
    expect(li.at(6)).toEqual({ line: 2, col: 3 }); // lone CR
    expect(li.at(7)).toEqual({ line: 3, col: 1 });
    expect(li.at(10)).toEqual({ line: 4, col: 1 });
    expect(li.at(12)).toEqual({ line: 4, col: 3 }); // after the surrogate pair
    expect(li.at(src.length)).toEqual({ line: 5, col: 1 });
    expect([1, 2, 3, 4, 5].map((l) => li.lineStart(l))).toEqual([0, 4, 7, 10, 14]);
  });

  it('counts a BOM as a column', () => {
    const li = new LineIndex('\uFEFF<p>x</p>');
    expect(li.at(4)).toEqual({ line: 1, col: 5 });
  });

  it('clamps lineStart', () => {
    const li = new LineIndex('a\nb');
    expect(li.lineStart(0)).toBe(0);
    expect(li.lineStart(99)).toBe(2);
  });
});
