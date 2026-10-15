// Findings about modules other agents own, found while fuzzing the patcher. Each was safe (the run was
// refused, never misplaced); `it.fails` documented the wrong behaviour until it was fixed.

import { describe, expect, it } from 'vitest';
import { buildMap } from '@blueline/core/mapper';

describe('mapper-html (core-mapper): <pre> text starting with an astral character after the dropped newline', () => {
  // parse5 8 reports the text node's start one code unit late (on the low surrogate) when <pre> or <listing>
  // drops its leading newline and the text then starts with a character outside the BMP. mapper-html steps
  // back onto the high surrogate (a text node never starts inside a surrogate pair).
  it('maps <pre>\\n<emoji>text as an aligned run that starts after the dropped newline', () => {
    for (const [src, raw] of [
      ['<!doctype html><body><pre>\n\u{1F600} text</pre></body>', '\u{1F600} text'],
      ['<!doctype html><body><pre>\r\n\u{1F600} text</pre></body>', '\u{1F600} text'],
      ['<!doctype html><body><listing>\n\u{1F600}</listing></body>', '\u{1F600}'],
      ['<!doctype html><body><pre>\n\n\u{1F600} text</pre></body>', '\n\n\u{1F600} text'],
    ] as const) {
      const run = buildMap(src, { version: 'x', utf8: true }).runs[0];
      expect(src.slice(run.start, run.end), JSON.stringify(src)).toBe(raw);
      expect(run.aligned).toBe(true);
    }
  });
});
