// Reading PDF pages back for the PDF exit gate (SPEC 10 Phase 1: "the PDF has the right page count, and each
// page matches its slide render with at most 1% of pixels different"; 6.9 Save as PDF).
//
// - Raster pages (6.9 Other decks) hold one lossless image XObject each: pageImages finds it with pdf-lib and
//   decodePageImage inflates its samples, so a page is compared with a slide render exactly as stored, with no
//   PDF renderer in between.
// - printToPDF pages (print CSS, documents) are vector pages. Electron's PDF viewer cannot be captured
//   reliably, so they are rasterised with poppler's `pdftoppm` when the machine has it (a system tool, not an
//   npm dependency; this container has it, a Mac needs `brew install poppler`), as PPM at an exact pixel size.
//   Without it, only page counts and page sizes are compared, and the report says so.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { inflateSync } from 'node:zlib';
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib';

export interface PageImage {
  width: number;
  height: number;
  colorSpace: string | null;
  bitsPerComponent: number | null;
  filter: string | null;
  /** The stream's bytes as stored (still compressed). */
  data: Uint8Array;
}

export interface PdfPages {
  pageCount: number;
  /** Each page's MediaBox size in points. */
  sizes: { w: number; h: number }[];
  /** Each page's only image XObject, or null (a vector page, or more than one image). */
  images: (PageImage | null)[];
  title: string | null;
}

function nameOf(v: unknown): string | null {
  return v instanceof PDFName ? v.decodeText() : null;
}

function numberOf(v: unknown): number | null {
  return v instanceof PDFNumber ? v.asNumber() : null;
}

/** Page count, page sizes, title and each page's single image XObject. */
export async function pdfPages(bytes: Uint8Array): Promise<PdfPages> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = doc.getPages();
  const images: (PageImage | null)[] = [];
  for (const page of pages) {
    const xo = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    const found: PageImage[] = [];
    for (const [, ref] of xo?.entries() ?? []) {
      const s = doc.context.lookup(ref);
      if (!(s instanceof PDFRawStream) || nameOf(s.dict.get(PDFName.of('Subtype'))) !== 'Image') continue;
      found.push({
        width: numberOf(s.dict.get(PDFName.of('Width'))) ?? 0,
        height: numberOf(s.dict.get(PDFName.of('Height'))) ?? 0,
        colorSpace: nameOf(s.dict.get(PDFName.of('ColorSpace'))),
        bitsPerComponent: numberOf(s.dict.get(PDFName.of('BitsPerComponent'))),
        filter: nameOf(s.dict.get(PDFName.of('Filter'))),
        data: s.contents,
      });
    }
    images.push(found.length === 1 ? found[0] : null);
  }
  return { pageCount: pages.length, sizes: pages.map((p) => p.getSize()).map((s) => ({ w: s.width, h: s.height })), images, title: doc.getTitle() ?? null };
}

/** The RGB samples of a raster page's image (8-bit DeviceRGB, Flate or uncompressed), or an error. */
export function decodePageImage(img: PageImage): Uint8Array {
  if (img.colorSpace !== 'DeviceRGB' || img.bitsPerComponent !== 8) throw new Error(`unsupported page image: ${img.colorSpace ?? '?'} ${img.bitsPerComponent ?? '?'} bpc`);
  let raw: Uint8Array;
  if (img.filter === 'FlateDecode') raw = inflateSync(img.data);
  else if (img.filter === null) raw = img.data;
  else throw new Error(`unsupported page image filter ${img.filter}`);
  if (raw.length < img.width * img.height * 3) throw new Error('page image holds too few samples');
  return raw;
}

// ------------------------------------------------------------------------------------------- pdftoppm

/** A PPM (P6, 8-bit) decoded to RGB. */
export function parsePpm(buf: Uint8Array): { width: number; height: number; rgb: Uint8Array } {
  // Header: P6 <ws> width <ws> height <ws> maxval <one ws> data; comments start with #.
  let i = 0;
  const tokens: string[] = [];
  const isWs = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
  while (tokens.length < 4 && i < buf.length) {
    while (i < buf.length && isWs(buf[i])) i++;
    if (buf[i] === 0x23) {
      while (i < buf.length && buf[i] !== 0x0a) i++;
      continue;
    }
    let t = '';
    while (i < buf.length && !isWs(buf[i])) t += String.fromCharCode(buf[i++]);
    tokens.push(t);
  }
  i++; // the single whitespace after maxval
  const [magic, w, h, max] = tokens;
  const width = Number(w);
  const height = Number(h);
  if (magic !== 'P6' || Number(max) !== 255 || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error('not an 8-bit P6 PPM');
  const rgb = buf.subarray(i, i + width * height * 3);
  if (rgb.length < width * height * 3) throw new Error('PPM holds too few samples');
  return { width, height, rgb };
}

let pdftoppmPath: string | null | undefined;

/** The pdftoppm executable, or null when the machine has none. */
export function findPdftoppm(): string | null {
  if (pdftoppmPath !== undefined) return pdftoppmPath;
  pdftoppmPath = null;
  for (const dir of (process.env.PATH ?? '/usr/bin:/usr/local/bin:/opt/homebrew/bin').split(path.delimiter).concat(['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'])) {
    const p = path.join(dir, 'pdftoppm');
    try {
      fs.accessSync(p, fs.constants.X_OK);
      pdftoppmPath = p;
      break;
    } catch {
      // next
    }
  }
  return pdftoppmPath;
}

/** Rasterises page `page` (1-based) of `pdf` to exactly `width` × `height` pixels of RGB with pdftoppm. */
export async function rasterisePage(pdf: string, page: number, width: number, height: number, workDir: string): Promise<{ width: number; height: number; rgb: Uint8Array }> {
  const exe = findPdftoppm();
  if (!exe) throw new Error('pdftoppm is not installed');
  const prefix = path.join(workDir, `page-${process.pid}-${page}-${Date.now()}`);
  await new Promise<void>((resolve, reject) => {
    execFile(
      exe,
      ['-f', String(page), '-l', String(page), '-singlefile', '-scale-to-x', String(width), '-scale-to-y', String(height), pdf, prefix],
      { timeout: 120_000, maxBuffer: 1024 * 1024 },
      (err) => (err ? reject(err) : resolve()),
    );
  });
  const file = `${prefix}.ppm`;
  try {
    return parsePpm(new Uint8Array(fs.readFileSync(file)));
  } finally {
    fs.rmSync(file, { force: true });
  }
}
