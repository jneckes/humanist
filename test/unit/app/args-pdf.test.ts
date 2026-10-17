// `blueline pdf deck.html [-o out.pdf]`, the app side (6.1): `--bl-cmd=pdf`, `--bl-args=<base64url JSON
// PdfArgs>` and `--bl-out`, parsed like map's; and the command's result text. The end-to-end run is
// test/e2e/render-products-cli.spec.ts.
import { describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getLocale: () => 'en-US', getSystemLocale: () => 'en-US', getLocaleCountryCode: () => '', on() {}, once() {}, removeListener() {}, isPackaged: false },
  BrowserWindow: class {},
  ipcMain: { on() {}, handle() {} },
  session: { fromPartition: () => ({}) },
}));

import { encodeArgs, parseAppArgs, validatePdfArgs } from '../../../packages/app/src/main/args';
import { resultText } from '../../../packages/app/src/main/pdf-command';

const DEV = { defaultApp: true };

describe('--bl-cmd=pdf', () => {
  it('decodes PdfArgs and --bl-out', () => {
    const a = encodeArgs({ file: '/d/deck.html', out: '/d/out.pdf' });
    expect(parseAppArgs(['e', 'app', '--bl-cmd=pdf', `--bl-args=${a}`, '--bl-out=/tmp/r.json'], DEV)).toEqual({
      cmd: 'pdf',
      pdf: { file: '/d/deck.html', out: '/d/out.pdf' },
      out: '/tmp/r.json',
      errors: [],
    });
  });

  it('out null means the default; protected is kept only when true', () => {
    expect(validatePdfArgs({ file: '/d/deck.html', out: null })).toEqual({ file: '/d/deck.html', out: null });
    expect(validatePdfArgs({ file: '/d/deck.html', out: null, protected: true })).toEqual({ file: '/d/deck.html', out: null, protected: true });
    expect(validatePdfArgs({ file: '/d/deck.html', out: null, protected: false })).toEqual({ file: '/d/deck.html', out: null });
  });

  it('refuses relative paths, missing fields, extra fields, wrong types and NUL', () => {
    for (const bad of [
      { file: 'deck.html', out: null },
      { file: '/d/deck.html', out: 'out.pdf' },
      { file: '/d/deck.html' },
      { out: null },
      { file: '/d/deck.html', out: null, extra: 1 },
      { file: '/d/deck.html', out: null, protected: 'yes' },
      { file: '/d/de\0ck.html', out: null },
      { file: 42, out: null },
      ['/d/deck.html'],
      null,
    ]) {
      expect(validatePdfArgs(bad)).toBeNull();
    }
    // A JSON "__proto__" key is an own field like any other: an unknown one, refused.
    expect(validatePdfArgs(JSON.parse('{"file":"/d/x.html","out":null,"__proto__":{"protected":true}}'))).toBeNull();
  });

  it('invalid arguments are reported, never guessed; no arguments is pdf null', () => {
    const bad = encodeArgs({ file: 'rel.html', out: null });
    const r = parseAppArgs(['e', 'app', '--bl-cmd=pdf', `--bl-args=${bad}`, '--bl-out=/o'], DEV);
    expect(r).toMatchObject({ cmd: 'pdf', pdf: null, out: '/o' });
    expect(r.errors).toEqual(['--bl-args: not valid pdf arguments']);
    expect(parseAppArgs(['e', 'app', '--bl-cmd=pdf'], DEV)).toEqual({ cmd: 'pdf', pdf: null, out: null, errors: [] });
    expect(parseAppArgs(['e', 'app', '--bl-cmd=pdf', '--bl-args=***'], DEV).errors).toEqual(['--bl-args: not base64url']);
  });

  it('a plain path after --bl-cmd=pdf is not read as a file to open', () => {
    const r = parseAppArgs(['e', 'app', '--bl-cmd=pdf', '/d/deck.html'], DEV);
    expect(r.cmd).toBe('pdf');
    expect('files' in r).toBe(false);
  });
});

describe('the command’s text', () => {
  it('says where, how many pages and how; lists slides that could not be shown', () => {
    expect(resultText({ out: '/d/deck.pdf', pages: 1, mode: 'print-css', title: null, missed: [] })).toBe("blueline pdf: wrote /d/deck.pdf (1 page, the deck's print CSS)");
    expect(resultText({ out: '/d/deck.pdf', pages: 6, mode: 'raster', title: 'T', missed: [] })).toBe('blueline pdf: wrote /d/deck.pdf (6 pages, one page per slide)');
    expect(resultText({ out: '/d/r.pdf', pages: 2, mode: 'document', title: 'T', missed: [] })).toBe('blueline pdf: wrote /d/r.pdf (2 pages, document pages)');
    expect(resultText({ out: '/d/deck.pdf', pages: 1, mode: 'raster', title: 'T', missed: [1, 2] })).toBe('blueline pdf: wrote /d/deck.pdf (1 page, one page per slide); 2 slides could not be shown: 2, 3');
  });
});
