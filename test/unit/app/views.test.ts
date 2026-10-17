// The deck and document views (6.9 Reading): where the deck view goes and at what zoom (Fit, 100%, Fill width,
// Reading Width, Present), the design size the visible view may report, rail navigation, the deck and shell
// message validators, and the app://shell/thumbs/ route that serves the rail's thumbnails (9.1 Shell view).
import { describe, expect, it } from 'vitest';
import type { SlideState } from '@blueline/core/ipc';
import type { SlideIndex } from '@blueline/core/ipc-render';
import { READING_WIDTH, SCROLLBAR_SIZE, ZOOM_LIMITS, zoomLabel } from '@blueline/core/ipc-views';
import { SHELL_CSP, handleShellRequest, handleThumbRequest, type RequestLike } from '../../../packages/app/src/main/protocol';
import {
  acceptDesignReport,
  computeViewLayout,
  maxReplayPresses,
  navPlanFor,
  railThumbWidth,
  safeDesign,
  shellIndexOf,
  snapToDevice,
  stepTarget,
  thumbUrl,
  validateDesignReport,
  validatePageStep,
  validateScrollArgs,
  validateShellCommand,
  validateShowEntry,
  validateWheelPan,
  viewKindOf,
  zoomStatus,
  type ViewLayoutInput,
} from '../../../packages/app/src/main/views';

const AREA = { x: 200, y: 44, width: 1240, height: 863 };

function input(p: Partial<ViewLayoutInput>): ViewLayoutInput {
  return { area: AREA, kind: 'deck', design: { w: 1600, h: 900 }, zoomMode: 'fit', readingWidth: false, presenting: false, scroll: { x: 0, y: 0 }, dpr: 1, ...p };
}

/** The page's viewport for a deck view of this size at this zoom (Chromium: DIP / zoom). */
function viewport(l: { deck: { width: number; height: number }; zoom: number }): { w: number; h: number } {
  return { w: l.deck.width / l.zoom, h: l.deck.height / l.zoom };
}

describe('computeViewLayout: Fit (6.9, the default)', () => {
  it('scales the design size to fit the content area, centred, letterboxed (Read: width-limited)', () => {
    const l = computeViewLayout(input({}));
    expect(l.zoom).toBeCloseTo(1240 / 1600, 10);
    expect(l.container).toEqual(AREA);
    expect(l.deck).toEqual({ x: 0, y: Math.floor((863 - 698) / 2), width: 1240, height: 698 });
    expect(l.scroll).toBeNull();
    // The page keeps the design size as its viewport: exactly on the limiting side.
    expect(viewport(l).w).toBe(1600);
    expect(Math.abs(viewport(l).h - 900)).toBeLessThan(1);
  });

  it('Review: the narrower area is height- or width-limited, and the limiting side is exact', () => {
    const l = computeViewLayout(input({ area: { x: 200, y: 44, width: 940, height: 863 } }));
    expect(l.deck.width).toBe(940);
    expect(l.zoom).toBeCloseTo(940 / 1600, 10);
    const tall = computeViewLayout(input({ area: { x: 0, y: 0, width: 2000, height: 600 } }));
    expect(tall.deck.height).toBe(600);
    expect(tall.zoom).toBeCloseTo(600 / 900, 10);
    expect(tall.deck.x).toBe(Math.floor((2000 - tall.deck.width) / 2));
    expect(viewport(tall).h).toBe(900);
  });

  it('odd window sizes: whole DIPs, never larger than the area, centred within one pixel', () => {
    for (const [w, h] of [
      [1241, 863],
      [1239, 777],
      [641, 333],
      [1001, 1001],
      [3839, 2157],
    ]) {
      const l = computeViewLayout(input({ area: { x: 7, y: 13, width: w, height: h } }));
      expect(Number.isInteger(l.deck.width) && Number.isInteger(l.deck.height)).toBe(true);
      expect(l.deck.width).toBeLessThanOrEqual(w);
      expect(l.deck.height).toBeLessThanOrEqual(h);
      expect(Math.abs(w - l.deck.width - 2 * l.deck.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(h - l.deck.height - 2 * l.deck.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(viewport(l).w - 1600)).toBeLessThan(2);
      expect(Math.abs(viewport(l).h - 900)).toBeLessThan(2);
      expect(l.scroll).toBeNull();
    }
  });

  it('a fractional display scale gets a deck view of whole device pixels', () => {
    for (const dpr of [1.25, 1.5, 1.75, 2, 3]) {
      const l = computeViewLayout(input({ area: { x: 0, y: 0, width: 1241, height: 900 }, dpr }));
      const dev = l.deck.width * dpr;
      expect(Math.abs(dev - Math.round(dev)), `dpr ${dpr}`).toBeLessThan(1e-6);
      expect(l.deck.width).toBeLessThanOrEqual(1241);
      expect(1241 - l.deck.width).toBeLessThanOrEqual(3);
    }
    expect(snapToDevice(1241, 1.5)).toBe(1240);
    expect(snapToDevice(1241, 2)).toBe(1241);
    expect(snapToDevice(1243, 1.25)).toBe(1240);
    // No whole size within three DIPs: the size stays.
    expect(snapToDevice(5, 1.3)).toBe(5);
  });

  it('the zoom stays within what Chromium shows (0.25..5); a tiny window then scrolls', () => {
    const tiny = computeViewLayout(input({ area: { x: 0, y: 0, width: 200, height: 100 } }));
    expect(tiny.zoom).toBe(ZOOM_LIMITS.min);
    expect(tiny.deck.width).toBe(400);
    expect(tiny.scroll).not.toBeNull();
    const big = computeViewLayout(input({ design: { w: 100, h: 50 }, area: { x: 0, y: 0, width: 3000, height: 3000 } }));
    expect(big.zoom).toBe(ZOOM_LIMITS.max);
    expect(big.deck.width).toBe(500);
  });

  it('an empty area (a minimized window) shows nothing and keeps a valid zoom', () => {
    const l = computeViewLayout(input({ area: { x: 0, y: 0, width: 0, height: 0 } }));
    expect(l.deck.width).toBe(0);
    expect(l.deck.height).toBe(0);
    expect(l.zoom).toBeGreaterThan(0);
  });

  it('an unknown kind lays out as a deck at the design size given (the deck view starts at 1600×900)', () => {
    const l = computeViewLayout(input({ kind: null }));
    expect(viewport(l).w).toBe(1600);
  });

  it('a nonsense design size falls back to 1600×900 (6.9)', () => {
    expect(safeDesign({ w: 0, h: 900 })).toEqual({ w: 1600, h: 900 });
    expect(safeDesign({ w: NaN, h: 1 })).toEqual({ w: 1600, h: 900 });
    expect(safeDesign({ w: 100_000, h: 900 })).toEqual({ w: 1600, h: 900 });
    expect(safeDesign({ w: 1280.4, h: 719.6 })).toEqual({ w: 1280, h: 720 });
    expect(computeViewLayout(input({ design: { w: -5, h: 9 } })).zoom).toBeCloseTo(1240 / 1600, 10);
  });
});

describe('computeViewLayout: 100% and Fill width', () => {
  it('100% is the design size at zoom 1, centred when it fits', () => {
    const l = computeViewLayout(input({ zoomMode: 'actual', design: { w: 800, h: 450 } }));
    expect(l.zoom).toBe(1);
    expect(l.deck).toEqual({ x: (1240 - 800) / 2, y: Math.floor((863 - 450) / 2), width: 800, height: 450 });
    expect(l.scroll).toBeNull();
  });

  it('100% larger than the area: the container leaves room for both scroll bars, and the deck view scrolls', () => {
    const l = computeViewLayout(input({ zoomMode: 'actual' }));
    expect(l.zoom).toBe(1);
    expect(l.container).toEqual({ x: 200, y: 44, width: 1240 - SCROLLBAR_SIZE, height: 863 - SCROLLBAR_SIZE });
    expect(l.deck).toEqual({ x: 0, y: 0, width: 1600, height: 900 });
    expect(l.scroll).toEqual({ width: 1600, height: 900, x: 0, y: 0 });
    // Scrolled: the deck view moves left and up inside the clipping container, never past its end.
    const s = computeViewLayout(input({ zoomMode: 'actual', scroll: { x: 100, y: 5000 } }));
    expect(s.deck.x).toBe(-100);
    expect(s.deck.y).toBe(-(900 - (863 - SCROLLBAR_SIZE)));
    expect(s.scroll).toEqual({ width: 1600, height: 900, x: 100, y: 900 - (863 - SCROLLBAR_SIZE) });
    expect(computeViewLayout(input({ zoomMode: 'actual', scroll: { x: -50, y: NaN } })).deck).toMatchObject({ x: 0, y: 0 });
  });

  it('one axis overflowing gets one scroll bar; the other axis stays centred', () => {
    const l = computeViewLayout(input({ zoomMode: 'actual', design: { w: 1000, h: 1200 } }));
    expect(l.container.width).toBe(1240 - SCROLLBAR_SIZE);
    expect(l.container.height).toBe(863);
    expect(l.deck.x).toBe(Math.floor((1240 - SCROLLBAR_SIZE - 1000) / 2));
    expect(l.scroll).toEqual({ width: 1000, height: 1200, x: 0, y: 0 });
  });

  it('Fill width: the width is exact; a taller deck scrolls vertically, its bar taken from the width', () => {
    const wide = computeViewLayout(input({ zoomMode: 'fill', area: { x: 0, y: 0, width: 1600, height: 600 } }));
    expect(wide.deck.width).toBe(1600 - SCROLLBAR_SIZE);
    expect(wide.zoom).toBeCloseTo((1600 - SCROLLBAR_SIZE) / 1600, 10);
    expect(wide.container.width).toBe(1600 - SCROLLBAR_SIZE);
    expect(wide.scroll?.height).toBe(wide.deck.height);
    expect(wide.deck.x).toBe(0);
    // No horizontal bar: the deck view is exactly the container's width.
    expect(wide.container.height).toBe(600);
    const fits = computeViewLayout(input({ zoomMode: 'fill' }));
    expect(fits.deck.width).toBe(1240);
    expect(fits.scroll).toBeNull();
  });

  it('documents have no zoom; Reading Width narrows the view to 960 px, centred', () => {
    const doc = computeViewLayout(input({ kind: 'document', zoomMode: 'actual' }));
    expect(doc).toEqual({ container: AREA, deck: { x: 0, y: 0, width: 1240, height: 863 }, zoom: 1, scroll: null });
    const rw = computeViewLayout(input({ kind: 'document', readingWidth: true }));
    expect(rw.deck).toEqual({ x: (1240 - READING_WIDTH) / 2, y: 0, width: READING_WIDTH, height: 863 });
    // Narrower than 960: the whole width.
    expect(computeViewLayout(input({ kind: 'document', readingWidth: true, area: { x: 0, y: 0, width: 700, height: 500 } })).deck.width).toBe(700);
  });

  it('Present: decks at Fit over the whole window whatever the zoom mode; documents at reading width', () => {
    const area = { x: 0, y: 0, width: 1920, height: 1080 };
    const p = computeViewLayout(input({ area, zoomMode: 'actual', presenting: true }));
    expect(p.zoom).toBeCloseTo(1.2, 10);
    expect(p.deck).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(p.scroll).toBeNull();
    const d = computeViewLayout(input({ area, kind: 'document', presenting: true }));
    expect(d.deck).toEqual({ x: (1920 - READING_WIDTH) / 2, y: 0, width: READING_WIDTH, height: 1080 });
    expect(d.zoom).toBe(1);
  });
});

describe('the design size the visible view reports (6.9)', () => {
  it('a generic deck counts only when measured at a 1600×900 viewport, so a vw-sized slide cannot shrink its view', () => {
    expect(acceptDesignReport({ kind: 'generic', w: 1280, h: 720, viewportW: 1600, viewportH: 900 })).toEqual({ w: 1280, h: 720 });
    expect(acceptDesignReport({ kind: 'generic', w: 1280, h: 720, viewportW: 1601, viewportH: 899 })).toEqual({ w: 1280, h: 720 });
    expect(acceptDesignReport({ kind: 'generic', w: 1024, h: 576, viewportW: 1280, viewportH: 720 })).toBeNull();
    // reveal.js's configured size holds at any viewport.
    expect(acceptDesignReport({ kind: 'reveal', w: 960, h: 700, viewportW: 1240, viewportH: 863 })).toEqual({ w: 960, h: 700 });
    expect(acceptDesignReport({ kind: 'reveal', w: 5, h: 700, viewportW: 1600, viewportH: 900 })).toBeNull();
  });

  it('the kinds map to the two views, and the status bar shows the zoom of decks only', () => {
    expect(viewKindOf('reveal')).toBe('deck');
    expect(viewKindOf('generic')).toBe('deck');
    expect(viewKindOf('scroll')).toBe('document');
    expect(viewKindOf('single')).toBe('document');
    expect(viewKindOf(undefined)).toBeNull();
    expect(zoomStatus('deck', 'fit', 0.8512)).toBe('Fit · 85%');
    expect(zoomStatus(null, 'actual', 1)).toBe('100% · 100%');
    expect(zoomStatus('deck', 'fill', 1.2)).toBe('Fill width · 120%');
    expect(zoomStatus('document', 'fit', 1)).toBeNull();
    expect(zoomLabel('fill')).toBe('Fill width');
  });
});

describe('navigation (6.9: the rail navigates through slide.nav; the outline scrolls to its heading)', () => {
  const slides = (p: Partial<SlideState>): SlideState => ({ kind: 'generic', count: 5, current: 0, titles: [], navKind: 'index', ...p });
  const index = (p: Partial<SlideIndex>): SlideIndex => ({ version: 'v', kind: 'generic', navKind: 'index', slides: [], designSize: { w: 1600, h: 900 }, complete: true, ...p });
  const entry = (i: number, nav: SlideIndex['slides'][number]['nav'], more: Partial<SlideIndex['slides'][number]> = {}) => ({ index: i, title: `S${i}`, nav, text: [], ...more });

  it('from the slide index: reveal, hash and scroll navigate in the page; index decks replay keys', () => {
    expect(navPlanFor(1, index({ kind: 'reveal', slides: [entry(0, { kind: 'reveal', value: [0, 0] }), entry(1, { kind: 'reveal', value: [1, 2] })] }), null)).toEqual({ goto: { kind: 'reveal', h: 1, v: 2 } });
    expect(navPlanFor(0, index({ slides: [entry(0, { kind: 'hash', value: '#/intro' })] }), null)).toEqual({ goto: { kind: 'hash', hash: '#/intro' } });
    expect(navPlanFor(0, index({ slides: [entry(0, { kind: 'scroll', value: 0 })] }), null)).toEqual({ goto: { kind: 'scroll', index: 0 } });
    expect(navPlanFor(0, index({ slides: [entry(0, { kind: 'index', value: 3 })] }), null)).toEqual({ keys: 3 });
    // Values that are not what the kind says are refused, not interpolated anywhere.
    expect(navPlanFor(0, index({ slides: [entry(0, { kind: 'reveal', value: '1;alert(1)' as unknown as [number, number] })] }), null)).toBeNull();
    expect(navPlanFor(0, index({ slides: [entry(0, { kind: 'hash', value: 'javascript:x' })] }), null)).toBeNull();
  });

  it('documents: an outline entry scrolls to its heading; the text before the first heading to the top', () => {
    const doc = index({ kind: 'scroll', slides: [entry(0, { kind: 'none', value: 0 }, { heading: null }), entry(1, { kind: 'none', value: 0 }, { heading: 4, level: 2 })] });
    expect(navPlanFor(1, doc, null)).toEqual({ goto: { kind: 'heading', index: 4 } });
    expect(navPlanFor(0, doc, null)).toEqual({ goto: { kind: 'top' } });
    expect(navPlanFor(2, doc, null)).toBeNull();
  });

  it('before the index: what the visible view reported', () => {
    expect(navPlanFor(2, null, slides({ navKind: 'reveal', kind: 'reveal', revealIndices: [[0, 0], [1, 0], [1, 1]] }))).toEqual({ goto: { kind: 'reveal', h: 1, v: 1 } });
    expect(navPlanFor(1, null, slides({ navKind: 'hash', hashes: ['#a', '#b'] }))).toEqual({ goto: { kind: 'hash', hash: '#b' } });
    expect(navPlanFor(3, null, slides({}))).toEqual({ keys: 3 });
    expect(navPlanFor(9, null, slides({}))).toBeNull();
    expect(navPlanFor(-1, null, slides({}))).toBeNull();
    expect(navPlanFor(1.5, null, slides({}))).toBeNull();
    expect(navPlanFor(0, null, null)).toBeNull();
  });

  it('PageUp and PageDown step one slide and stop at either end; replays are bounded', () => {
    expect(stepTarget(0, 5, 1)).toBe(1);
    expect(stepTarget(4, 5, 1)).toBeNull();
    expect(stepTarget(0, 5, -1)).toBeNull();
    expect(stepTarget(3, 5, -1)).toBe(2);
    expect(maxReplayPresses(1)).toBe(24);
    expect(maxReplayPresses(-3)).toBe(40);
    expect(maxReplayPresses(1000)).toBe(400);
  });

  it('the rail and the outline get titles and h1–h3 entries; thumbnails are 152 px in the 200 px rail', () => {
    const doc = index({
      kind: 'scroll',
      slides: [entry(0, { kind: 'none', value: 0 }, { heading: null, title: 'Intro' }), entry(1, { kind: 'none', value: 0 }, { heading: 0, level: 1, title: 'One' })],
    });
    expect(shellIndexOf(doc, false)).toEqual({ version: 'v', building: false, ready: true, kind: 'scroll', titles: ['Intro', 'One'], outline: [{ entry: 1, level: 1, title: 'One' }] });
    expect(shellIndexOf(index({ slides: [entry(0, { kind: 'index', value: 0 })] }), true).outline).toEqual([]);
    expect(railThumbWidth(200)).toBe(152);
    expect(railThumbWidth(10)).toBe(32);
    expect(thumbUrl('0123456789abcdef', `${'a'.repeat(64)}-1-152.png`)).toBe(`app://shell/thumbs/0123456789abcdef/${'a'.repeat(64)}-1-152.png`);
  });
});

describe('validators (9.1: every message as written by its sender)', () => {
  it('the design report: kind, sizes and viewport, plain objects only', () => {
    expect(validateDesignReport({ kind: 'generic', w: 1600, h: 900, viewportW: 1600, viewportH: 900 }).ok).toBe(true);
    for (const bad of [
      null,
      [],
      { kind: 'scroll', w: 1, h: 1, viewportW: 1, viewportH: 1 },
      { kind: 'generic', w: Infinity, h: 1, viewportW: 1, viewportH: 1 },
      { kind: 'generic', w: '1600', h: 900, viewportW: 1, viewportH: 1 },
      { kind: 'generic', w: 1600, h: 900, viewportW: -1, viewportH: 1 },
      JSON.parse('{"__proto__": {"x": 1}, "kind": "generic", "w": 1, "h": 1, "viewportW": 1, "viewportH": 1}'),
      Object.defineProperty({ kind: 'generic', h: 1, viewportW: 1, viewportH: 1 }, 'w', { get: () => 1, enumerable: true }),
    ]) {
      expect(validateDesignReport(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('page steps and wheel pans', () => {
    expect(validatePageStep({ dir: 1 })).toEqual({ ok: true, value: { dir: 1 } });
    expect(validatePageStep({ dir: 2 }).ok).toBe(false);
    expect(validatePageStep({ dir: '1' }).ok).toBe(false);
    expect(validateWheelPan({ dx: -3.5, dy: 120 })).toEqual({ ok: true, value: { dx: -3.5, dy: 120 } });
    expect(validateWheelPan({ dx: 1e9, dy: 0 }).ok).toBe(false);
    expect(validateWheelPan({ dx: NaN, dy: 0 }).ok).toBe(false);
  });

  it('shell calls: a known command, a rail entry, scroll positions', () => {
    expect(validateShellCommand(['present'])).toEqual({ ok: true, value: 'present' });
    expect(validateShellCommand(['allow-network']).ok).toBe(false);
    expect(validateShellCommand(['present', 'x']).ok).toBe(false);
    expect(validateShowEntry([3])).toEqual({ ok: true, value: 3 });
    for (const bad of [[-1], [1.5], ['2'], [10_000], []]) expect(validateShowEntry(bad).ok, JSON.stringify(bad)).toBe(false);
    expect(validateScrollArgs([10.4, 0])).toEqual({ ok: true, value: { x: 10, y: 0 } });
    expect(validateScrollArgs([-1, 0]).ok).toBe(false);
    expect(validateScrollArgs([1]).ok).toBe(false);
  });
});

describe('app://shell/thumbs/<windowKey>/<name> (6.9 the rail; 9.1 Shell view)', () => {
  const KEY = '0123456789abcdef';
  const NAME = `${'b'.repeat(64)}-3-152.png`;
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const calls: [string, string][] = [];
  const resolve = async (k: string, n: string): Promise<Uint8Array | null> => {
    calls.push([k, n]);
    return k === KEY && n === NAME ? PNG : null;
  };
  const req = (url: string, method = 'GET'): RequestLike => ({ url, method, headers: new Headers() }) as unknown as RequestLike;

  it("serves only what main's resolver returns for that window, as a PNG with nosniff and no-store", async () => {
    const res = await handleShellRequest(req(`app://shell/thumbs/${KEY}/${NAME}`), '/nonexistent-shell-dir', resolve);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-security-policy')).toBe(SHELL_CSP);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect(calls.at(-1)).toEqual([KEY, NAME]);
    const head = await handleShellRequest(req(`app://shell/thumbs/${KEY}/${NAME}`, 'HEAD'), '/nonexistent-shell-dir', resolve);
    expect(head.status).toBe(200);
  });

  it('refuses everything else under /thumbs/ with a 404, before asking main', async () => {
    const before = calls.length;
    for (const url of [
      `app://shell/thumbs/${KEY}/../index.html`,
      `app://shell/thumbs/${KEY}/..%2Findex.html`,
      `app://shell/thumbs/${KEY}/${NAME}/x`,
      `app://shell/thumbs/${KEY}`,
      `app://shell/thumbs/`,
      `app://shell/thumbs/${KEY.toUpperCase()}/${NAME}`,
      `app://shell/thumbs/settings/${NAME}`,
      `app://shell/thumbs/${KEY}/index-${'b'.repeat(64)}.json`,
      `app://shell/thumbs/${KEY}/${'b'.repeat(64)}-3-152.png%00`,
      `app://shell/thumbs/${KEY}/%2e%2e%2f%2e%2e%2fsession.json`,
      `app://shell/Thumbs/${KEY}/..%2F..%2Fx.png`,
      `app://shell/th%75mbs/${KEY}/x.png`,
      `app://shell/thumbs/${KEY}/${'b'.repeat(64)}-3-152.PNG`,
    ]) {
      const res = await handleShellRequest(req(url), '/nonexistent-shell-dir', resolve);
      expect(res.status, url).toBe(404);
    }
    expect(calls.length).toBe(before);
    // A wrong method, or a resolver that has nothing.
    expect((await handleShellRequest(req(`app://shell/thumbs/${KEY}/${NAME}`, 'POST'), '/x', resolve)).status).toBe(404);
    expect((await handleShellRequest(req(`app://shell/thumbs/fedcba9876543210/${NAME}`), '/x', resolve)).status).toBe(404);
    // No resolver (the route is off): 404.
    expect((await handleThumbRequest([KEY, NAME], 'GET', null)).status).toBe(404);
    // A resolver that throws: 404, never an error page.
    expect((await handleThumbRequest([KEY, NAME], 'GET', async () => Promise.reject(new Error('boom')))).status).toBe(404);
  });
});
