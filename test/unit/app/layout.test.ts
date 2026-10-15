// Window layout (6.0 The window): main owns the numbers; the deck view fills the content area.
import { describe, expect, it } from 'vitest';
import { computeLayout, deckBounds } from '../../../packages/app/src/main/layout';

describe('computeLayout / deckBounds', () => {
  it('Read: toolbar, rail, status bar; no panel; no bars', () => {
    const l = computeLayout({ width: 1440, height: 900, appMode: 'read', trustBarVisible: false, bannerVisible: false });
    expect(l).toEqual({ toolbar: 44, trustBar: 0, banner: 0, statusBar: 26, leftRail: 200, rightPanel: 0 });
    expect(deckBounds(l, { width: 1440, height: 900 })).toEqual({ x: 200, y: 44, width: 1240, height: 830 });
  });

  it('Review and Edit show the notes panel (6.0 Right panel)', () => {
    for (const appMode of ['review', 'edit'] as const) {
      const l = computeLayout({ width: 1440, height: 900, appMode, trustBarVisible: false, bannerVisible: false });
      expect(l.rightPanel).toBe(300);
      expect(deckBounds(l, { width: 1440, height: 900 })).toEqual({ x: 200, y: 44, width: 940, height: 830 });
    }
  });

  it('the trust bar and the banner push the deck down', () => {
    const l = computeLayout({ width: 1440, height: 900, appMode: 'read', trustBarVisible: true, bannerVisible: true });
    expect(l.trustBar).toBe(40);
    expect(l.banner).toBe(32);
    expect(deckBounds(l, { width: 1440, height: 900 })).toEqual({ x: 200, y: 116, width: 1240, height: 758 });
  });

  it('narrow windows give up the rail, then narrow and drop the panel; sizes never go negative', () => {
    expect(computeLayout({ width: 800, height: 600, appMode: 'review', trustBarVisible: false, bannerVisible: false })).toMatchObject({ leftRail: 0, rightPanel: 240 });
    expect(computeLayout({ width: 600, height: 600, appMode: 'review', trustBarVisible: false, bannerVisible: false })).toMatchObject({ leftRail: 0, rightPanel: 0 });
    const l = computeLayout({ width: 10, height: 10, appMode: 'read', trustBarVisible: true, bannerVisible: true });
    expect(deckBounds(l, { width: 10, height: 10 })).toEqual({ x: 0, y: 116, width: 10, height: 0 });
  });
});
