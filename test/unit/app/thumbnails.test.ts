// Thumbnails' cache (6.9: cached by (sha256, slide index, width); 9.7 thumbs/): names, sizes, the shell
// route's path checks, reading, and pruning of other versions. Rendering runs in
// test/e2e/render-products-index.spec.ts.
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), on() {}, once() {}, removeListener() {}, isPackaged: false },
  BrowserWindow: class {},
  ipcMain: { on() {}, handle() {} },
  session: { fromPartition: () => ({}) },
}));

import type { SlideIndex } from '@blueline/core/ipc-render';
import { setRenderHost } from '../../../packages/app/src/main/render-service';
import {
  parseThumbFileName,
  pruneThumbs,
  readThumb,
  renderThumbnails,
  staleThumbFiles,
  thumbFileName,
  thumbPathFor,
  thumbPixelSize,
  thumbsDir,
  validThumbWidth,
} from '../../../packages/app/src/main/thumbnails';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const KEY = '0123456789abcdef';
const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
});
function userData(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-thumbs-'));
  tmp.push(d);
  return d;
}

describe('thumbnail names (sha256, slide index, width)', () => {
  it('round-trips', () => {
    const n = thumbFileName(A, 12, 240);
    expect(n).toBe(`${A}-12-240.png`);
    expect(parseThumbFileName(n)).toEqual({ version: A, slide: 12, width: 240 });
  });

  it('refuses anything else', () => {
    for (const bad of [`${A}-01-240.png`, `${A}-1-0240.png`, `${A}-1-8.png`, `${A}-1-2000.png`, `${A.slice(1)}-1-240.png`, `${A}-1-240.png.exe`, `../${A}-1-240.png`, `${A}-1-240.PNG`, `index-${A}.json`]) {
      expect(parseThumbFileName(bad)).toBeNull();
    }
    expect(() => thumbFileName('x', 1, 240)).toThrow();
    expect(() => thumbFileName(A, -1, 240)).toThrow();
    expect(() => thumbFileName(A, 1, 16)).toThrow();
    expect(validThumbWidth(32)).toBe(true);
    expect(validThumbWidth(1024)).toBe(true);
    expect(validThumbWidth(1025)).toBe(false);
    expect(validThumbWidth(100.5)).toBe(false);
  });

  it('a thumbnail is `width` CSS px at 2x, keeping the design aspect', () => {
    expect(thumbPixelSize({ w: 1600, h: 900 }, 240)).toEqual({ width: 480, height: 270 });
    expect(thumbPixelSize({ w: 960, h: 700 }, 200)).toEqual({ width: 400, height: 292 });
    expect(thumbPixelSize({ w: 900, h: 1600 }, 120)).toEqual({ width: 240, height: 426 });
  });
});

describe('the shell route (app://shell/thumbs/…): only files in that file’s thumbnails folder', () => {
  it('thumbPathFor maps a well-formed name into the folder and nothing else', () => {
    const name = thumbFileName(A, 0, 240);
    expect(thumbPathFor('/ud', KEY, name)).toBe(path.join('/ud', 'files', KEY, 'thumbs', name));
    expect(thumbPathFor('/ud', KEY, '../../trust.json')).toBeNull();
    expect(thumbPathFor('/ud', KEY, `index-${A}.json`)).toBeNull();
    expect(thumbPathFor('/ud', '../x', name)).toBeNull();
  });

  it('readThumb reads a regular file and refuses links and folders', async () => {
    const ud = userData();
    const dir = thumbsDir(ud, KEY);
    fs.mkdirSync(dir, { recursive: true });
    const name = thumbFileName(A, 1, 240);
    fs.writeFileSync(path.join(dir, name), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(Array.from((await readThumb(ud, KEY, name))!)).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const secret = path.join(ud, 'secret.txt');
    fs.writeFileSync(secret, 'secret');
    const link = thumbFileName(A, 2, 240);
    fs.symlinkSync(secret, path.join(dir, link));
    expect(await readThumb(ud, KEY, link)).toBeNull();
    const folder = thumbFileName(A, 3, 240);
    fs.mkdirSync(path.join(dir, folder));
    expect(await readThumb(ud, KEY, folder)).toBeNull();
    expect(await readThumb(ud, KEY, thumbFileName(A, 4, 240))).toBeNull();
  });
});

describe('pruning other versions', () => {
  it('staleThumbFiles lists other versions’ thumbnails and index files only', () => {
    const names = [thumbFileName(A, 0, 240), thumbFileName(B, 0, 240), thumbFileName(B, 3, 120), `index-${A}.json`, `index-${B}.json`, 'notes.txt', '.bl-write-1.tmp'];
    expect(staleThumbFiles(names, A).sort()).toEqual([thumbFileName(B, 0, 240), thumbFileName(B, 3, 120), `index-${B}.json`].sort());
  });

  it('pruneThumbs deletes them on disk', async () => {
    const ud = userData();
    const dir = thumbsDir(ud, KEY);
    fs.mkdirSync(dir, { recursive: true });
    for (const n of [thumbFileName(A, 0, 240), thumbFileName(B, 0, 240), `index-${A}.json`, `index-${B}.json`, 'keep.txt']) fs.writeFileSync(path.join(dir, n), 'x');
    expect(await pruneThumbs(ud, KEY, A)).toBe(2);
    expect(fs.readdirSync(dir).sort()).toEqual([thumbFileName(A, 0, 240), `index-${A}.json`, 'keep.txt'].sort());
    expect(await pruneThumbs(userData(), KEY, A)).toBe(0);
  });
});

describe('renderThumbnails from the cache', () => {
  it('reports every cached thumbnail without opening a render window, and checks its inputs', async () => {
    const ud = userData();
    setRenderHost({ preload: '/nope', userData: ud, log: () => undefined });
    const index: SlideIndex = {
      version: A,
      kind: 'generic',
      navKind: 'index',
      slides: [0, 1, 2].map((i) => ({ index: i, title: `S${i}`, nav: { kind: 'index' as const, value: i }, text: [] })),
      designSize: { w: 1600, h: 900 },
      complete: true,
    };
    const dir = thumbsDir(ud, KEY);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(dir, thumbFileName(A, i, 200)), 'png');
    fs.writeFileSync(path.join(dir, thumbFileName(B, 0, 200)), 'old');
    const doc = {
      docId: 'fedcba9876543210',
      fileName: 'd.html',
      partition: 'p',
      folderReal: '/d',
      realpath: '/d/d.html',
      fileKey: KEY,
      version: A,
      title: '',
      marker: null,
      isProtected: () => false,
      networkOpen: () => true,
      renderPolicyTag: () => 'test-policy',
      reducedMotion: true,
    };
    const got: [number, string, boolean][] = [];
    const r = await renderThumbnails(doc, index, 200, (s, f, info) => got.push([s, path.basename(f), info.cached]));
    expect(r).toEqual({ version: A, width: 200, rendered: 0, cached: 3, missed: [] });
    expect(got).toEqual([0, 1, 2].map((i) => [i, thumbFileName(A, i, 200), true]));
    // The completed run pruned the older version.
    expect(fs.existsSync(path.join(dir, thumbFileName(B, 0, 200)))).toBe(false);
    await expect(renderThumbnails(doc, { ...index, version: B }, 200, () => undefined)).rejects.toThrow(/another version/);
    await expect(renderThumbnails(doc, index, 7, () => undefined)).rejects.toThrow(/width/);
  });
});
