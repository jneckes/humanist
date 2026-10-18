// scripts/first-paint.mjs, the Speed gate's measurement (SPEC 10 Phase 1: "A 2 MB deck reaches first paint in
// under 1 s"): the pure helpers that decide which page is the deck view, which navigation main started for it,
// and whether a case meets the gate (review finding 36). The script itself needs a built app and a display; it
// runs main() only when started as a script, so importing it here runs nothing.

import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

interface Summary {
  counted: number;
  measured: number;
  failed: number;
  errors: string[];
  median: Record<string, number | null>;
}

interface Nav {
  id: number;
  at: number;
  sameDocument: boolean;
  mainFrame?: boolean;
  url?: string;
}

interface FirstPaint {
  GATE_MS: number;
  isDeckUrlFor(url: unknown, name: string): boolean;
  withoutFragment(url: string): string;
  documentNavAt(navs: Nav[], id: number, fcp: number | null): number | null;
  summarize(runs: Record<string, unknown>[]): Summary;
  caseMeets(summary: Summary | undefined, key: string): boolean;
  runsLabel(summary: Summary | undefined): string;
  perMb(ms: number | undefined, bytes: number): number | null;
}

const ROOT = path.resolve(__dirname, '../../..');
let fp: FirstPaint;

beforeAll(async () => {
  // Plain ESM with no types: imported by URL, so the typechecker does not resolve it.
  fp = (await import(pathToFileURL(path.join(ROOT, 'scripts/first-paint.mjs')).href)) as FirstPaint;
});

describe('isDeckUrlFor: the deck view is found by its URL without the fragment', () => {
  const name = 'perf-warm-trusted-1.html';

  it('matches the deck URL whether or not the deck has written its slide into the hash', () => {
    // 10 of Josh's 12 decks write location.hash on load (#1, #/1): the whole-URL comparison never found them.
    for (const url of [`blueline://9f2c/${name}`, `blueline://9f2c/${name}#1`, `blueline://9f2c/${name}#/1`, `blueline://9f2c/${name}#/12?x=1`, `blueline://9f2c/${name}?v=2#3`]) {
      expect(fp.isDeckUrlFor(url, name), url).toBe(true);
    }
  });

  it('decodes the path, and refuses other files, other schemes and malformed URLs', () => {
    expect(fp.isDeckUrlFor('blueline://9f2c/my%20deck.html#/2', 'my deck.html')).toBe(true);
    expect(fp.isDeckUrlFor('blueline://9f2c/perf-warm-trusted-11.html#/1', name)).toBe(false);
    expect(fp.isDeckUrlFor(`blueline://9f2c/x${name}`, name)).toBe(false);
    expect(fp.isDeckUrlFor(`file:///tmp/${name}`, name)).toBe(false);
    expect(fp.isDeckUrlFor('app://shell/shell.html', name)).toBe(false);
    expect(fp.isDeckUrlFor(`blueline://9f2c/%E0%A4%A/${name}`, name)).toBe(false);
    expect(fp.isDeckUrlFor(undefined, name)).toBe(false);
    expect(fp.withoutFragment('blueline://a/b.html#/1#2')).toBe('blueline://a/b.html');
  });
});

describe("documentNavAt: main's navigation of the painted document", () => {
  it('takes the last cross-document main-frame navigation at or before the paint, never a same-document one', () => {
    const navs: Nav[] = [
      { id: 7, at: 1000, sameDocument: false },
      { id: 7, at: 1300, sameDocument: true }, // the deck writes '#/1' before it paints
      { id: 8, at: 1350, sameDocument: false }, // another page (a render window)
      { id: 7, at: 1600, sameDocument: true }, // ... and again after its first paint (finding 36: 649 > 642)
    ];
    expect(fp.documentNavAt(navs, 7, 1500)).toBe(1000);
    expect(fp.documentNavAt(navs, 7, null)).toBe(1000);
    expect(fp.documentNavAt(navs, 8, 1500)).toBe(1350);
    expect(fp.documentNavAt(navs, 9, 1500)).toBeNull();
  });

  it('a reload before the paint is the navigation of the painted document; one after the paint is not', () => {
    const navs: Nav[] = [
      { id: 7, at: 1000, sameDocument: false },
      { id: 7, at: 1200, sameDocument: false },
      { id: 7, at: 2000, sameDocument: false },
      { id: 7, at: 1100, sameDocument: false, mainFrame: false },
    ];
    expect(fp.documentNavAt(navs, 7, 1500)).toBe(1200);
  });
});

describe('summarize and caseMeets: a failed run counts against the gate', () => {
  const ok = (fromOpen: number) => ({ fromOpen });
  const failed = { error: 'no first contentful paint within 30 s' };

  it('keeps every counted run: 3 of 5 failing is NOT met, though the 2 measured runs are fast', () => {
    // The verifier's hash-some run: warm [err, err, err, 520, 591] printed "median of 5 runs 556" and "met".
    const s = fp.summarize([failed, failed, failed, ok(520), ok(591)]);
    expect(s).toMatchObject({ counted: 5, measured: 2, failed: 3, errors: ['no first contentful paint within 30 s'] });
    expect(s.median.fromOpen).toBe(555.5);
    expect(fp.caseMeets(s, 'fromOpen')).toBe(false);
    expect(fp.runsLabel(s)).toBe('2 of 5 (3 failed)');
  });

  it('one failed run of five is enough to miss the gate', () => {
    const s = fp.summarize([ok(500), ok(510), failed, ok(520), ok(530)]);
    expect(s.median.fromOpen).toBe(515);
    expect(fp.caseMeets(s, 'fromOpen')).toBe(false);
  });

  it('meets the gate only when every counted run painted and the median is under GATE_MS', () => {
    expect(fp.GATE_MS).toBe(1000);
    const fast = fp.summarize([ok(500), ok(700), ok(999)]);
    expect(fp.caseMeets(fast, 'fromOpen')).toBe(true);
    expect(fp.runsLabel(fast)).toBe('3 of 3');
    expect(fp.caseMeets(fp.summarize([ok(900), ok(1000), ok(1100)]), 'fromOpen')).toBe(false);
    expect(fp.caseMeets(fp.summarize([failed, failed]), 'fromOpen')).toBe(false);
    expect(fp.caseMeets(fp.summarize([]), 'fromOpen')).toBe(false);
    expect(fp.caseMeets(undefined, 'fromOpen')).toBe(false);
    // A run measured without the key (no open request seen) does not pass for it.
    expect(fp.caseMeets(fp.summarize([{ fromOpen: null }]), 'fromOpen')).toBe(false);
  });

  it('gives the main-process share in ms per MB', () => {
    expect(fp.perMb(200, 2 * 1024 * 1024)).toBe(100);
    expect(fp.perMb(undefined, 1024)).toBeNull();
  });
});
