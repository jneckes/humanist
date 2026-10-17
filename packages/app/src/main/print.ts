// Print (6.9, Cmd+P): "Uses the same pipeline [as Save as PDF], then the system print dialog."
//
// - Decks with print CSS and documents: webContents.print() on the render view, with Save as PDF's settings
//   (backgrounds; a document's Letter or A4 page from the locale).
// - Other decks: the raster pages, at the design size and 2x, printed from a print-only document: one image
//   per page, written to <userData>/files/<fileKey>/print/<run>/ and served from there to a hidden window in
//   a partition of its own (no script, no network, nothing but those files), then removed. The composed PDF
//   itself cannot be printed this way in Electron 44: with webPreferences.plugins off, a PDF response renders
//   as an empty page; only with plugins on does Chromium's PDF viewer extension (chrome-extension://mhjf…)
//   show it (Phase 1 finding), and no Blueline window enables that extension renderer.
// - Notes are never included, and render views have no overlay (checked before anything is printed).
// The system dialog cannot be driven in tests; `printWith` lets a test print to PDF in its place.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { BrowserWindow, session, type WebContents } from 'electron';
import type { PdfMode, SlideIndex } from '@blueline/core/ipc-render';
import { readRegularFile } from './atomic-write';
import { newDocumentId } from './documents';
import { DECK_SCHEME } from './protocol';
import { RenderError, rendererFor, renderHost, throwIfCancelled, untilQuiet, type RenderHost, type RenderTarget, type RenderView } from './render-service';
import { INDEX_VIEWPORT, buildSlideIndex, designViewport, isDeck, visitSlides } from './slide-index';
import { RASTER_SCALE, decidePdfMode, documentPageSize, pdfPageCount, pdfTitleOf, printCssOf, type PdfOptions } from './pdf';

/** How a print job is sent: webContents.print by default (the system dialog unless `silent`). */
export type PrintFn = (wc: WebContents, options: Electron.WebContentsPrintOptions) => Promise<{ ok: boolean; why: string }>;

export const systemPrint: PrintFn = (wc, options) =>
  new Promise((resolve) => {
    try {
      wc.print(options, (ok, why) => resolve({ ok, why: ok ? '' : String(why || 'Print job failed') }));
    } catch (e) {
      resolve({ ok: false, why: e instanceof Error ? e.message : String(e) });
    }
  });

export interface PrintOptions extends PdfOptions {
  /** Print to the default printer without the dialog (tests; Electron's `silent`). Default false: the dialog. */
  silent?: boolean;
  /** In place of webContents.print (tests). */
  printWith?: PrintFn;
}

export interface PrintResult {
  ok: boolean;
  /** Electron's failure reason ("Print job canceled", …), or ''. */
  why: string;
  mode: PdfMode;
  pages: number | null;
  /** Raster decks: slides navigation could not show (0-based). */
  missed: number[];
}

// ------------------------------------------------------------------------------------------- the print document

/** Escapes text for HTML content and attribute values (the document's <title> goes into the print document). */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

export function pageFileName(i: number): string {
  if (!Number.isInteger(i) || i < 0 || i > 99_999) throw new RenderError('invalid page number');
  return `page-${i}.png`;
}

/** The print-only document: one image per page, each filling its page; the stylesheet is print.css. */
export function printDocumentHtml(title: string | null, pages: number): string {
  const imgs: string[] = [];
  for (let i = 0; i < pages; i++) imgs.push(`<img src="${pageFileName(i)}" alt="">`);
  return `<!doctype html>\n<html><head><meta charset="utf-8"><title>${escapeHtml(title ?? '')}</title><link rel="stylesheet" href="print.css"></head>\n<body>${imgs.join('\n')}</body></html>\n`;
}

/** Each page the slide's aspect (the design size), no margins, the image scaled to fit (6.9 raster pages). */
export function printDocumentCss(design: { w: number; h: number }): string {
  const w = Math.round(design.w);
  const h = Math.round(design.h);
  return (
    `@page { size: ${w}px ${h}px; margin: 0; }\n` +
    'html, body { margin: 0; padding: 0; background: #fff; }\n' +
    'img { display: block; width: 100vw; height: 100vh; object-fit: contain; break-after: page; page-break-after: always; }\n' +
    'img:last-child { break-after: auto; page-break-after: auto; }\n'
  );
}

/** What the print document's handler serves: the document, its stylesheet and its page images. */
export function printFileFor(pathname: string, pages: number): { name: string; type: string } | null {
  if (pathname === '/print.html') return { name: 'print.html', type: 'text/html; charset=utf-8' };
  if (pathname === '/print.css') return { name: 'print.css', type: 'text/css; charset=utf-8' };
  const m = /^\/page-(\d{1,5})\.png$/.exec(pathname);
  if (m && String(Number(m[1])) === m[1] && Number(m[1]) < pages) return { name: `page-${m[1]}.png`, type: 'image/png' };
  return null;
}

const PRINT_CSP = "default-src 'none'; img-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * Prints the files in `dir` (print.html, print.css, page-N.png) from a hidden window in a fresh partition.
 * The window runs no script, and its partition answers only blueline://<id>/ with those files.
 */
async function printFolder(dir: string, pages: number, design: { w: number; h: number }, print: PrintFn, silent: boolean, log: (m: string) => void): Promise<{ ok: boolean; why: string }> {
  const id = newDocumentId();
  const ses = session.fromPartition(`bl-print-${id}`);
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  const origin = `${DECK_SCHEME}://${id}/`;
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith(origin) }));
  ses.protocol.handle(DECK_SCHEME, async (req) => {
    let u: URL;
    try {
      u = new URL(req.url);
    } catch {
      return new Response('Not found', { status: 404 });
    }
    const f = u.host === id && req.method === 'GET' ? printFileFor(u.pathname, pages) : null;
    if (!f) return new Response('Not found', { status: 404 });
    try {
      const body = await readRegularFile(path.join(dir, f.name), 64 * 1024 * 1024);
      return new Response(body as unknown as BodyInit, {
        status: 200,
        headers: { 'Content-Type': f.type, 'Content-Security-Policy': PRINT_CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
  const win = new BrowserWindow({
    show: false,
    width: Math.min(design.w, 1600),
    height: Math.min(design.h, 1600),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, webSecurity: true, partition: `bl-print-${id}`, spellcheck: false, devTools: false, navigateOnDragDrop: false },
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  try {
    // loadURL resolves on did-finish-load: after the load event, so every page image has arrived.
    await win.webContents.loadURL(`${origin}print.html`);
    return await print(win.webContents, { silent, printBackground: true, landscape: design.w > design.h, margins: { marginType: 'none' } });
  } catch (e) {
    log(`print: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, why: e instanceof Error ? e.message : String(e) };
  } finally {
    if (!win.isDestroyed()) win.destroy();
    try {
      ses.protocol.unhandle(DECK_SCHEME);
    } catch {
      // already gone
    }
  }
}

// ------------------------------------------------------------------------------------------- Print

async function assertNoOverlay(view: RenderView): Promise<void> {
  if (await view.overlayMounted()) throw new RenderError('a render view showed the overlay; nothing is printed from it (6.9: notes are never included)');
}

/** The print folder of one job: <userData>/files/<fileKey>/print/<id>/ (9.7 app data). */
export function printDir(userData: string, fileKey: string, id: string): string {
  if (!/^[0-9a-f]{16}$/.test(fileKey) || !/^[0-9a-f]{16}$/.test(id)) throw new RenderError('invalid print folder');
  return path.join(userData, 'files', fileKey, 'print', id);
}

/**
 * 6.9 Print (Cmd+P): Save as PDF's pipeline, then the system print dialog. Resolves when the job was handed
 * to the printer or the dialog was cancelled ({ ok: false, why: 'Print job canceled' }).
 */
export async function printDocument(doc: RenderTarget, opts: PrintOptions = {}): Promise<PrintResult> {
  const host: RenderHost = opts.host ?? renderHost();
  const signal = opts.signal ?? null;
  const print = opts.printWith ?? systemPrint;
  const silent = opts.silent === true;
  const index: SlideIndex = opts.index ?? (await buildSlideIndex(doc, { signal, host }));
  if (index.version !== doc.version) throw new RenderError('the slide index is of another version');
  await untilQuiet(doc.fileKey, signal);

  // Print CSS and documents: the render view itself.
  const direct = await rendererFor(doc, host).use(
    INDEX_VIEWPORT,
    async (view): Promise<PrintResult | null> => {
      throwIfCancelled(signal);
      await view.load(doc);
      await view.waitStable();
      await assertNoOverlay(view);
      if (!isDeck(index.kind)) {
        const r = await print(view.wc, { silent, printBackground: true, pageSize: documentPageSize(opts.locale) });
        return { ...r, mode: 'document', pages: null, missed: [] };
      }
      const scan = await printCssOf(view, host.log);
      if (!scan.pageRule && !scan.printBreaks) return null;
      // "A @media print that lays out each slide as a page" is checked as Save as PDF checks it.
      const pages = scan.pageRule ? null : await pdfPageCount(await view.printToPDF({ preferCSSPageSize: true, printBackground: true }));
      if (decidePdfMode(index.kind, scan, pages, index.slides.length) !== 'print-css') return null;
      throwIfCancelled(signal);
      const r = await print(view.wc, { silent, printBackground: true });
      return { ...r, mode: 'print-css', pages, missed: [] };
    },
    signal,
  );
  if (direct) return direct;

  // Other decks: the raster pages, from a print-only document in app data.
  const dir = printDir(host.userData, doc.fileKey, newDocumentId());
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    let title: string | null = null;
    let pages = 0;
    const visit = await rendererFor(doc, host).use(
      designViewport(index, RASTER_SCALE),
      (view) =>
        visitSlides(
          view,
          doc,
          index,
          async () => {
            if (pages === 0) title = pdfTitleOf(await view.documentTitle(), doc.title);
            const cap = await view.capture();
            if (cap.empty) throw new RenderError('a slide captured empty');
            await fs.promises.writeFile(path.join(dir, pageFileName(pages)), cap.image.toPNG(), { mode: 0o600 });
            pages++;
          },
          { signal, log: host.log },
        ),
      signal,
    );
    throwIfCancelled(signal);
    if (pages === 0) throw new RenderError(`${doc.fileName}: no slide could be shown`);
    await fs.promises.writeFile(path.join(dir, 'print.html'), printDocumentHtml(title, pages), { mode: 0o600 });
    await fs.promises.writeFile(path.join(dir, 'print.css'), printDocumentCss(index.designSize), { mode: 0o600 });
    const r = await printFolder(dir, pages, index.designSize, print, silent, host.log);
    return { ...r, mode: 'raster', pages, missed: visit.missed };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
