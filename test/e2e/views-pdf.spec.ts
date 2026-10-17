// Save as PDF (6.9, Cmd+Shift+E): the save dialog defaults to <name>.pdf next to the file; render-products'
// saveAsPdf writes one page per slide; the status bar shows the task while it runs; it works in Protected view.
// The dialog is answered by the test (a system dialog cannot be driven here).

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { FIXTURES, Scratch, copyInto, launchApp, resolveRunAs, type BlApp } from '../helpers/app';

test.describe.configure({ mode: 'serial' });

const scratch = new Scratch(resolveRunAs());
test.afterAll(() => scratch.cleanup());

/** The save dialog answers `out` and records the options it was shown with. */
async function answerSaveDialog(app: BlApp, out: string): Promise<void> {
  await app.electronApp.evaluate(({ dialog }, p) => {
    const g = globalThis as unknown as { __saveDialogs: unknown[] };
    g.__saveDialogs = [];
    (dialog as unknown as Record<string, unknown>).showSaveDialog = async (...a: unknown[]) => {
      g.__saveDialogs.push(a.find((x) => x && typeof x === 'object' && 'defaultPath' in (x as object)));
      return { canceled: false, filePath: p };
    };
  }, out);
}

async function saveDialogs(app: BlApp): Promise<{ defaultPath: string; filters: { extensions: string[] }[] }[]> {
  return (await app.electronApp.evaluate(() => (globalThis as unknown as { __saveDialogs: unknown[] }).__saveDialogs)) as never;
}

test('Cmd+Shift+E writes a PDF with one page per slide, in Protected view too', async () => {
  const dir = scratch.dir('views-pdf');
  const file = copyInto(path.join(FIXTURES, 'decks/generic-index.html'), dir);
  scratch.own(dir);
  const app = await launchApp({ files: [file], scratch, protected: true });
  try {
    const deck = await app.waitForDeck('generic-index.html');
    const w = await app.win(deck.docId);
    expect(w.trust).toBe('protected');
    const out = path.join(dir, 'exported.pdf');
    await answerSaveDialog(app, out);
    // The app chord, from the deck (6.2).
    await deck.chord('E', ['shift']);
    await expect.poll(() => fs.existsSync(out), { timeout: 90_000 }).toBe(true);
    const shown = await saveDialogs(app);
    expect(shown[0].defaultPath).toBe(path.join(dir, 'generic-index.pdf'));
    expect(shown[0].filters[0].extensions).toEqual(['pdf']);
    const pdf = await PDFDocument.load(fs.readFileSync(out));
    expect(pdf.getPageCount()).toBe(6);
    // A raster deck: pages at the slide's aspect (1600×900 px → 1200×675 pt).
    const { width, height } = pdf.getPage(0).getSize();
    expect(Math.round(width)).toBe(1200);
    expect(Math.round(height)).toBe(675);
    await expect.poll(() => app.logsMatching(/pdf: .*exported\.pdf 6 pages \(raster\)/).length).toBe(1);
    const shell = await app.shellPage(deck.docId);
    await expect(shell.locator('#toast')).toContainText('exported.pdf · 6 pages');
  } finally {
    await app.close();
  }
});

test('the status bar shows the task while the PDF is made; a cancelled dialog writes nothing', async () => {
  const dir = scratch.dir('views-pdf-status');
  const file = copyInto(path.join(FIXTURES, 'decks/generic-hash.html'), dir);
  scratch.own(dir);
  const app = await launchApp({ files: [file], scratch });
  try {
    const deck = await app.waitForDeck('generic-hash.html');
    const shell = await app.shellPage(deck.docId);
    // The harness's own save dialog answers Cancel: nothing happens.
    await app.run('save-pdf', deck.docId);
    await expect.poll(async () => (await app.harness()).dialogs.filter((d) => d.kind === 'save').length).toBe(1);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.pdf'))).toEqual([]);
    const out = path.join(dir, 'deck copy.pdf');
    await answerSaveDialog(app, out);
    await app.run('save-pdf', deck.docId);
    await expect(shell.locator('#status-right')).toContainText('Saving PDF…', { timeout: 15_000 });
    await expect.poll(() => fs.existsSync(out), { timeout: 90_000 }).toBe(true);
    await expect(shell.locator('#status-right')).not.toContainText('Saving PDF…', { timeout: 15_000 });
    const pdf = await PDFDocument.load(fs.readFileSync(out));
    expect(pdf.getPageCount()).toBe(5);
  } finally {
    await app.close();
  }
});
