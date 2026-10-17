// 6.9 Print's print-only document for raster decks: escaping of the document's title, one image per page at
// the slide's aspect, and the handler that serves only those files. The print itself runs in
// test/e2e/render-products-pdf.spec.ts (with printToPDF in place of the system dialog).
import { describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getLocale: () => 'en-US', getSystemLocale: () => 'en-US', getLocaleCountryCode: () => '', on() {}, once() {}, removeListener() {}, isPackaged: false },
  BrowserWindow: class {},
  ipcMain: { on() {}, handle() {} },
  session: { fromPartition: () => ({}) },
}));

import { escapeHtml, pageFileName, printDir, printDocumentCss, printDocumentHtml, printFileFor } from '../../../packages/app/src/main/print';

describe('the print-only document', () => {
  it('escapes the title, so a <title> with markup characters stays text', () => {
    expect(escapeHtml(`a&b <i>"x"</i> 'y'`)).toBe('a&amp;b &lt;i&gt;&quot;x&quot;&lt;/i&gt; &#39;y&#39;');
    const html = printDocumentHtml('</title><script>alert(1)</script>', 2);
    expect(html).toContain('<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>');
    expect(html.match(/<script/g)).toBeNull();
    expect(html.match(/<img /g)).toHaveLength(2);
    expect(html).toContain('<img src="page-0.png" alt="">');
    expect(html).toContain('<img src="page-1.png" alt="">');
    expect(printDocumentHtml(null, 1)).toContain('<title></title>');
  });

  it('each page has the slide’s size and no margin, and the last page no break after it', () => {
    const css = printDocumentCss({ w: 1280, h: 720 });
    expect(css).toContain('@page { size: 1280px 720px; margin: 0; }');
    expect(css).toContain('break-after: page');
    expect(css).toContain('img:last-child { break-after: auto');
  });

  it('serves the document, its sheet and its pages, nothing else', () => {
    expect(printFileFor('/print.html', 3)).toEqual({ name: 'print.html', type: 'text/html; charset=utf-8' });
    expect(printFileFor('/print.css', 3)?.name).toBe('print.css');
    expect(printFileFor('/page-2.png', 3)).toEqual({ name: 'page-2.png', type: 'image/png' });
    for (const bad of ['/page-3.png', '/page-02.png', '/page-1.png/x', '/../trust.json', '/page-%31.png', '/', '/print.htm', '/index.json']) {
      expect(printFileFor(bad, 3)).toBeNull();
    }
  });

  it('names and folders are checked', () => {
    expect(pageFileName(4)).toBe('page-4.png');
    expect(() => pageFileName(-1)).toThrow();
    expect(printDir('/u', '0123456789abcdef', 'fedcba9876543210')).toBe('/u/files/0123456789abcdef/print/fedcba9876543210');
    expect(() => printDir('/u', '..', 'fedcba9876543210')).toThrow();
    expect(() => printDir('/u', '0123456789abcdef', '../x')).toThrow();
  });
});
