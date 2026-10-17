// Reading PDF pages back for the PDF gate (harness/pdf-pages.ts): a raster page's image XObject decodes to
// exactly the pixels Save as PDF stored (pdf.ts RasterPdf), PPM parsing, and pdftoppm when the machine has it.
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getLocale: () => 'en-US', getSystemLocale: () => 'en-US', getLocaleCountryCode: () => '', isPackaged: false },
}));

import { PDFDocument, rgb } from 'pdf-lib';
import { RasterPdf, bgraToRgb } from '../../packages/app/src/main/pdf';
import { comparePixels } from './harness/compare';
import { decodePageImage, findPdftoppm, parsePpm, pdfPages, rasterisePage } from './harness/pdf-pages';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-parity-pdf-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A BGRA bitmap with a gradient and a translucent stripe (pdf.ts composites it over white). */
function bitmap(w: number, h: number, seed: number): Uint8Array {
  const b = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      b[o] = (x * 7 + seed) & 255;
      b[o + 1] = (y * 5 + seed) & 255;
      b[o + 2] = (x + y + seed) & 255;
      b[o + 3] = y === 3 ? 128 : 255;
    }
  return b;
}

describe('raster pages', () => {
  it('each page has one image that decodes to the capture as Save as PDF stored it', async () => {
    const [w, h] = [32, 18];
    const pdf = await RasterPdf.create({ w: 16, h: 9 }, 'Deck');
    const shots = [bitmap(w, h, 1), bitmap(w, h, 99)];
    for (const s of shots) await pdf.addPage(s, w, h);
    const pages = await pdfPages(await pdf.save());
    expect(pages.pageCount).toBe(2);
    expect(pages.title).toBe('Deck');
    // design px × 0.75 pt
    expect(pages.sizes[0]).toEqual({ w: 12, h: 6.75 });
    for (let i = 0; i < 2; i++) {
      const img = pages.images[i]!;
      expect(img).toMatchObject({ width: w, height: h, colorSpace: 'DeviceRGB', bitsPerComponent: 8, filter: 'FlateDecode' });
      const rgbData = decodePageImage(img);
      const s = comparePixels(rgbData, bgraToRgb(shots[i], w * h), w, h, { channels: 3, tolerance: 0 });
      expect(s.exact).toBe(0);
    }
    // The other page's capture differs: the comparison sees it.
    expect(comparePixels(decodePageImage(pages.images[0]!), bgraToRgb(shots[1], w * h), w, h, { channels: 3 }).over).toBeGreaterThan(0);
  });

  it('a vector page has no image', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([100, 50]).drawRectangle({ x: 0, y: 0, width: 50, height: 50, color: rgb(1, 0, 0) });
    const pages = await pdfPages(await doc.save());
    expect(pages.images).toEqual([null]);
  });

  it('refuses images it cannot read', () => {
    expect(() => decodePageImage({ width: 1, height: 1, colorSpace: 'DeviceGray', bitsPerComponent: 8, filter: null, data: new Uint8Array(1) })).toThrow(/unsupported/);
    expect(() => decodePageImage({ width: 1, height: 1, colorSpace: 'DeviceRGB', bitsPerComponent: 8, filter: 'DCTDecode', data: new Uint8Array(3) })).toThrow(/filter/);
    expect(() => decodePageImage({ width: 2, height: 2, colorSpace: 'DeviceRGB', bitsPerComponent: 8, filter: null, data: new Uint8Array(3) })).toThrow(/too few/);
  });
});

describe('PPM', () => {
  it('parses P6 with a comment', () => {
    const head = Buffer.from('P6\n# made by a test\n2 1\n255\n', 'latin1');
    const p = parsePpm(new Uint8Array(Buffer.concat([head, Buffer.from([1, 2, 3, 4, 5, 6])])));
    expect(p.width).toBe(2);
    expect(p.height).toBe(1);
    expect([...p.rgb]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('refuses other formats and short data', () => {
    expect(() => parsePpm(new Uint8Array(Buffer.from('P5\n1 1\n255\n\0', 'latin1')))).toThrow();
    expect(() => parsePpm(new Uint8Array(Buffer.from('P6\n2 2\n255\n\0\0\0', 'latin1')))).toThrow(/too few/);
  });
});

describe('pdftoppm', () => {
  it.skipIf(!findPdftoppm())('rasterises a page at an exact pixel size', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([120, 60]);
    page.drawRectangle({ x: 0, y: 0, width: 60, height: 60, color: rgb(1, 0, 0) });
    const file = path.join(tmp, 'v.pdf');
    fs.writeFileSync(file, await doc.save());
    const r = await rasterisePage(file, 1, 320, 160, tmp);
    expect([r.width, r.height]).toEqual([320, 160]);
    // Left half red, right half white (PDF y runs up; the square sits at the left).
    const at = (x: number, y: number) => [...r.rgb.subarray((y * 320 + x) * 3, (y * 320 + x) * 3 + 3)];
    expect(at(40, 80)).toEqual([255, 0, 0]);
    expect(at(280, 80)).toEqual([255, 255, 255]);
    expect(fs.readdirSync(tmp).filter((f) => f.endsWith('.ppm'))).toEqual([]);
  });
});
