import { describe, expect, it } from 'vitest';
import { buildMap } from '@blueline/core/mapper';
import { emulatedMediaCommand, readsMotionInScript, wantsReducedMotion } from '../../../packages/app/src/main/motion';

describe('reduced motion in Review and Edit (Josh, 2026-10-17)', () => {
  it('reduces motion in Review and Edit, never in Read', () => {
    expect(wantsReducedMotion('read')).toBe(false);
    expect(wantsReducedMotion('review')).toBe(true);
    expect(wantsReducedMotion('edit')).toBe(true);
  });

  it('reloads only decks whose inline scripts mention the media feature', () => {
    const js = "<!doctype html><body><script>var rm = matchMedia('(prefers-reduced-motion: reduce)').matches;</script></body>";
    const css = '<!doctype html><head><style>@media (prefers-reduced-motion: reduce) { * { animation: none } }</style></head><body></body>';
    const data = '<!doctype html><body><script type="application/json">{"note": "prefers-reduced-motion"}</script></body>';
    for (const [src, want] of [[js, true], [css, false], [data, false]] as const) {
      expect(readsMotionInScript(src, buildMap(src, { version: 'v', utf8: true }))).toBe(want);
    }
  });

  it('sets and clears the emulated media feature', () => {
    expect(emulatedMediaCommand(true)).toEqual({ features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    expect(emulatedMediaCommand(false)).toEqual({ features: [{ name: 'prefers-reduced-motion', value: '' }] });
  });
});
