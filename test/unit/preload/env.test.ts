import { describe, expect, it } from 'vitest';
import { parsePreloadArgs } from '../../../packages/app/src/preload/env';
import { parseKeyLogSeq, ALLOWED_INPUT_TYPES } from '../../../packages/app/src/preload/diagnostics-hooks';
import { isSameDocumentFragment } from '../../../packages/app/src/preload/link-reporter';

describe('preload arguments', () => {
  it('reads --bl-mode and --bl-test', () => {
    expect(parsePreloadArgs(['electron', '--bl-mode=render'])).toEqual({ mode: 'render', test: false });
    expect(parsePreloadArgs(['--bl-mode=diagnostics', '--bl-test=1'])).toEqual({ mode: 'diagnostics', test: true });
  });
  it('falls back to deck for a missing or unknown mode, and never turns the test hook on by accident', () => {
    expect(parsePreloadArgs([])).toEqual({ mode: 'deck', test: false });
    expect(parsePreloadArgs(['--bl-mode=shell', '--bl-test=0', '--bl-test=true'])).toEqual({ mode: 'deck', test: false });
  });
});

describe('diagnostics helpers', () => {
  it('parses the fixture key log', () => {
    expect(parseKeyLogSeq('12:ArrowRight:true')).toBe(12);
    expect(parseKeyLogSeq(undefined)).toBeNull();
    expect(parseKeyLogSeq('x:y')).toBeNull();
  });
  it('allows exactly the 9.2 input types', () => {
    expect([...ALLOWED_INPUT_TYPES].sort()).toEqual(
      [
        'insertText',
        'insertReplacementText',
        'insertFromPaste',
        'insertFromDrop',
        'deleteContentBackward',
        'deleteContentForward',
        'deleteWordBackward',
        'deleteWordForward',
        'deleteByCut',
        // E-10 (Phase 2 review, finding 12): a drag-move inside the field, confined as deleteByCut is and only
        // when its drop lands inside the field (edit-input.ts classifyInput and affectedRanges).
        'deleteByDrag',
      ].sort(),
    );
    expect(ALLOWED_INPUT_TYPES.has('insertParagraph')).toBe(false);
    expect(ALLOWED_INPUT_TYPES.has('insertLineBreak')).toBe(false);
    expect(ALLOWED_INPUT_TYPES.has('formatBold')).toBe(false);
  });
});

describe('link reporter', () => {
  it('skips links that only change the fragment of this document', () => {
    expect(isSameDocumentFragment('blueline://abc/deck.html#two', 'blueline://abc/deck.html')).toBe(true);
    expect(isSameDocumentFragment('blueline://abc/deck.html', 'blueline://abc/deck.html#one')).toBe(true);
    expect(isSameDocumentFragment('blueline://abc/other.html#two', 'blueline://abc/deck.html')).toBe(false);
    expect(isSameDocumentFragment('https://example.com/#x', 'blueline://abc/deck.html')).toBe(false);
    expect(isSameDocumentFragment('not a url', 'blueline://abc/deck.html')).toBe(false);
  });
});
