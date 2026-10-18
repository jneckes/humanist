// A print sheet is read with its media list (6.9 Save as PDF, decks with print CSS; review finding 13): the
// media-*.html decks put the same print layout (one 720 × 932 slide per Letter page, no @page rule) behind
// `@import … print`, `<link media=print>`, `<style media=print>`, a linked sheet that imports it with print,
// and an @media print rule (the control). Each prints its own CSS: print-css, 4 pages, the slides' text
// selectable. A print layout and an @page rule in a sheet linked with media="screen" apply to no print: that
// deck is rendered slide by slide. Driven through `__blRenderTest` (pdf-command.ts); pdftotext reads the text.

import { expect, test } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PDFDocument } from 'pdf-lib';
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

test.beforeAll(async () => {
  s = new Scratch(resolveRunAs());
  dir = s.dir('media');
  outDir = s.dir('media-out');
  for (const f of fs.readdirSync(path.join(FIXTURES, 'render')).filter((n) => /^media-(import|link|style|wrapper|atmedia|screen|sheet)\./.test(n))) copyInto(path.join(FIXTURES, 'render', f), dir);
  copyInto(path.join(FIXTURES, 'decks', 'single.html'), dir);
  s.own(dir);
  app = await launchApp({ files: [path.join(dir, 'single.html')], scratch: s });
  await app.waitForDeck('single.html');
});

test.afterAll(async () => {
  await app?.close();
  s?.cleanup();
});

for (const file of ['media-import.html', 'media-link.html', 'media-style.html', 'media-wrapper.html', 'media-atmedia.html']) {
  test(`${file}: the print sheet behind its media list is the deck’s print CSS (4 pages, text selectable)`, async () => {
    expect(spawnSync('sh', ['-c', 'command -v pdftotext']).status, 'pdftotext (poppler-utils) reads the text here').toBe(0);
    const o = await rt<{ docId: string }>('open', path.join(dir, file));
    const out = path.join(outDir, file.replace(/\.html$/, '.pdf'));
    expect(await rt('pdf', o.docId, out)).toMatchObject({ mode: 'print-css', pages: 4, missed: [] });
    const pages = (await PDFDocument.load(fs.readFileSync(out))).getPages().map((p) => p.getSize());
    // Letter, the slide's aspect (decision D-6).
    for (const p of pages) expect(p.width / p.height).toBeCloseTo(720 / 932, 2);
    const text = spawnSync('pdftotext', ['-enc', 'UTF-8', out, '-'], { encoding: 'utf8' }).stdout;
    for (const t of ['Media one', 'Media two', 'Media three', 'Media four']) expect(text, file).toContain(t);
    await rt('close', o.docId);
  });
}

test('media-screen.html: a print layout in a media="screen" sheet is no print CSS, so the slides are rendered', async () => {
  const o = await rt<{ docId: string }>('open', path.join(dir, 'media-screen.html'));
  const out = path.join(outDir, 'media-screen.pdf');
  expect(await rt('pdf', o.docId, out)).toMatchObject({ mode: 'raster', pages: 4, missed: [] });
  await rt('close', o.docId);
});
