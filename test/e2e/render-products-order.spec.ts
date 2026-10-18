// Raster pages in slide order (6.9 Save as PDF "one PDF page per slide", Print; review finding 33). The skip
// deck's keys pass over slide 3, so the render walk shows it by its hash after slides 4 and 5; the PDF and the
// print must still have slides 1 to 5 in that order. Driven through `__blRenderTest` (pdf-command.ts);
// pdftoppm (poppler) reads the pages.

import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { FIXTURES, Scratch, copyInto, launchApp, resolveRunAs, type BlApp } from '../helpers/app';

test.describe.configure({ mode: 'serial' });
test.skip(process.platform === 'linux' && !process.env.DISPLAY, 'needs a display: run through `npm run test:e2e` (its global setup starts Xvfb)');
test.setTimeout(300_000);

let s: Scratch;
let app: BlApp;
let dir: string;
let outDir: string;

function rt<T>(fn: string, ...args: unknown[]): Promise<T> {
  return app.electronApp.evaluate(
    async (_e, a) => (globalThis as unknown as Record<string, Record<string, (...x: unknown[]) => unknown>>).__blRenderTest[a.fn](...a.args),
    { fn, args },
  ) as Promise<T>;
}

/** The colour at the middle of each page, from pdftoppm's PPM output at a low resolution. */
function pageColours(file: string): [number, number, number][] {
  expect(spawnSync('sh', ['-c', 'command -v pdftoppm']).status, 'pdftoppm (poppler-utils) reads the pages here').toBe(0);
  const out: [number, number, number][] = [];
  for (let page = 1; ; page++) {
    const r = spawnSync('pdftoppm', ['-r', '8', '-f', String(page), '-l', String(page), file], { maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0 || r.stdout.length === 0) break;
    const b = r.stdout;
    const head = b.subarray(0, 64).toString('latin1');
    const m = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(head);
    expect(m, 'a P6 image').not.toBeNull();
    const [w, h] = [Number(m![1]), Number(m![2])];
    const at = m![0].length + (Math.floor(h / 2) * w + Math.floor(w / 2)) * 3;
    out.push([b[at], b[at + 1], b[at + 2]]);
    if (page > 50) break;
  }
  return out;
}

/** The slide whose solid colour a page shows: red, green, blue, yellow, magenta (skip-deck.html), else -1. */
function slideOf(c: [number, number, number]): number {
  const hi = c.map((v) => v > 128);
  const want = [
    [true, false, false],
    [false, true, false],
    [false, false, true],
    [true, true, false],
    [true, false, true],
  ];
  return want.findIndex((w) => w.every((v, i) => v === hi[i]));
}

test.beforeAll(async () => {
  s = new Scratch(resolveRunAs());
  dir = s.dir('order');
  outDir = s.dir('order-out');
  copyInto(path.join(FIXTURES, 'render', 'skip-deck.html'), dir);
  copyInto(path.join(FIXTURES, 'decks', 'single.html'), dir);
  s.own(dir);
  app = await launchApp({ files: [path.join(dir, 'single.html')], scratch: s });
  await app.waitForDeck('single.html');
});

test.afterAll(async () => {
  await app?.close();
  s?.cleanup();
});

test('a slide the keys skip, shown by its hash last, still gets its own page in slide order: Save as PDF and Print', async () => {
  const o = await rt<{ docId: string }>('open', path.join(dir, 'skip-deck.html'));
  const index = await rt<{ slides: unknown[]; navKind: string; complete: boolean }>('index', o.docId);
  expect(index.slides).toHaveLength(5);
  expect(index.navKind).toBe('hash');
  const out = path.join(outDir, 'skip.pdf');
  expect(await rt('pdf', o.docId, out)).toMatchObject({ mode: 'raster', pages: 5, missed: [] });
  expect(pageColours(out).map(slideOf)).toEqual([0, 1, 2, 3, 4]);

  const printed = path.join(outDir, 'skip-print.pdf');
  expect(await rt('print', o.docId, printed)).toMatchObject({ ok: true, mode: 'raster', pages: 5, missed: [] });
  expect(pageColours(printed).map(slideOf)).toEqual([0, 1, 2, 3, 4]);
  await rt('close', o.docId);
});
