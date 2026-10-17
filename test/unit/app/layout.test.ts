// Window layout (6.0 The window): main owns the numbers; the deck view goes in the content area (views.ts
// places it inside). Phase 1 adds the Find bar, the collapsible rail and Present.
import { describe, expect, it } from 'vitest';
import { FIND_BAR_HEIGHT, computeLayout, deckBounds } from '../../../packages/app/src/main/layout';

const base = { width: 1440, height: 900, trustBarVisible: false, bannerVisible: false } as const;

describe('computeLayout / deckBounds', () => {
  it('Read: toolbar, rail, status bar; no panel; no bars', () => {
    const l = computeLayout({ ...base, appMode: 'read' });
    expect(l).toEqual({ toolbar: 44, trustBar: 0, banner: 0, findBar: 0, statusBar: 26, leftRail: 200, rightPanel: 0 });
    expect(deckBounds(l, { width: 1440, height: 900 })).toEqual({ x: 200, y: 44, width: 1240, height: 830 });
  });

  it('Review and Edit show the notes panel (6.0 Right panel)', () => {
    for (const appMode of ['review', 'edit'] as const) {
      const l = computeLayout({ ...base, appMode });
      expect(l.rightPanel).toBe(300);
      expect(deckBounds(l, { width: 1440, height: 900 })).toEqual({ x: 200, y: 44, width: 940, height: 830 });
    }
  });

  it('the trust bar, the banner and the Find bar push the deck down', () => {
    const l = computeLayout({ ...base, appMode: 'read', trustBarVisible: true, bannerVisible: true });
    expect(l.trustBar).toBe(40);
    expect(l.banner).toBe(32);
    expect(deckBounds(l, { width: 1440, height: 900 })).toEqual({ x: 200, y: 116, width: 1240, height: 758 });
    const f = computeLayout({ ...base, appMode: 'read', trustBarVisible: true, findBarVisible: true });
    expect(f.findBar).toBe(FIND_BAR_HEIGHT);
    expect(deckBounds(f, { width: 1440, height: 900 })).toEqual({ x: 200, y: 44 + 40 + FIND_BAR_HEIGHT, width: 1240, height: 900 - 44 - 40 - FIND_BAR_HEIGHT - 26 });
  });

  it('narrow windows give up the rail, then narrow and drop the panel; sizes never go negative', () => {
    expect(computeLayout({ ...base, width: 800, height: 600, appMode: 'review' })).toMatchObject({ leftRail: 0, rightPanel: 240 });
    expect(computeLayout({ ...base, width: 600, height: 600, appMode: 'review' })).toMatchObject({ leftRail: 0, rightPanel: 0 });
    const l = computeLayout({ width: 10, height: 10, appMode: 'read', trustBarVisible: true, bannerVisible: true });
    expect(deckBounds(l, { width: 10, height: 10 })).toEqual({ x: 0, y: 116, width: 10, height: 0 });
  });

  it('View › Hide Slides collapses the rail; an open Find bar brings it back for its results', () => {
    expect(computeLayout({ ...base, appMode: 'read', railHidden: true }).leftRail).toBe(0);
    expect(computeLayout({ ...base, appMode: 'read', railHidden: true, findBarVisible: true }).leftRail).toBe(200);
    expect(deckBounds(computeLayout({ ...base, appMode: 'read', railHidden: true }), { width: 1440, height: 900 })).toEqual({ x: 0, y: 44, width: 1440, height: 830 });
  });

  it('Present: no chrome at all, the content area is the whole window (6.9)', () => {
    const l = computeLayout({ ...base, appMode: 'review', trustBarVisible: true, bannerVisible: true, findBarVisible: true, presenting: true });
    expect(l).toEqual({ toolbar: 0, trustBar: 0, banner: 0, findBar: 0, statusBar: 0, leftRail: 0, rightPanel: 0 });
    expect(deckBounds(l, { width: 1921, height: 1081 })).toEqual({ x: 0, y: 0, width: 1921, height: 1081 });
  });
});
