// Thumbnails for the rail (6.9 Navigation: "The thumbnail rail is filled by background renders, cached by
// (sha256, slide index, width)"; 6.7 Background renders; 9.7 thumbs/).
//
// - One capture per slide at the design size and 2x (the render view's viewport is the design size, with
//   deviceScaleFactor 2), scaled to `width` CSS px wide at 2x, keeping the aspect, as PNG.
// - Written atomically to <userData>/files/<fileKey>/thumbs/<sha256>-<slide>-<width>.png and reported as each
//   is written (or found in the cache).
// - One run per document at a time: a run for a newer version cancels the older one; a run for the same
//   version and width waits for the one in flight and then reports from the cache.
// - When a run completes, thumbnails and index files of other versions are deleted.
// - At most one render window pair per document (render-service DocumentRenderer).

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SlideIndex, ThumbReady } from '@blueline/core/ipc-render';
import { atomicWriteFile } from './atomic-write';
import { RenderCancelled, RenderError, rendererFor, renderHost, throwIfCancelled, untilQuiet, type RenderHost, type RenderTarget } from './render-service';
import { designViewport, forgetOtherIndexes, thumbsDir, visitSlides } from './slide-index';

export { thumbsDir } from './slide-index';

/** Thumbnails are PNGs at twice their CSS width (the rail on a 2x display). */
export const THUMB_SCALE = 2;
export const THUMB_MIN_WIDTH = 32;
export const THUMB_MAX_WIDTH = 1024;
/** A thumbnail file is never larger than this (THUMB_MAX_WIDTH at 2x, any aspect the design size allows). */
const THUMB_MAX_BYTES = 32 * 1024 * 1024;

const VERSION = /^[0-9a-f]{64}$/;
const THUMB_NAME = /^([0-9a-f]{64})-(\d{1,5})-(\d{2,4})\.png$/;
const INDEX_NAME = /^index-([0-9a-f]{64})\.json$/;

/** `<sha256>-<slide>-<width>.png` (6.9: cached by (sha256, slide index, width)). */
export function thumbFileName(version: string, slide: number, width: number): string {
  if (!VERSION.test(version)) throw new RenderError('invalid version');
  if (!Number.isInteger(slide) || slide < 0 || slide > 99_999) throw new RenderError('invalid slide index');
  if (!validThumbWidth(width)) throw new RenderError('invalid thumbnail width');
  return `${version}-${slide}-${width}.png`;
}

export function parseThumbFileName(name: string): { version: string; slide: number; width: number } | null {
  const m = THUMB_NAME.exec(name);
  if (!m) return null;
  const slide = Number(m[2]);
  const width = Number(m[3]);
  if (String(slide) !== m[2] || String(width) !== m[3] || !validThumbWidth(width)) return null;
  return { version: m[1], slide, width };
}

export function validThumbWidth(width: number): boolean {
  return Number.isInteger(width) && width >= THUMB_MIN_WIDTH && width <= THUMB_MAX_WIDTH;
}

/** The PNG's pixel size for a design size and a CSS width: `width` wide at 2x, keeping the design's aspect. */
export function thumbPixelSize(design: { w: number; h: number }, width: number): { width: number; height: number } {
  const h = Math.max(1, Math.round((width * design.h) / design.w));
  return { width: width * THUMB_SCALE, height: h * THUMB_SCALE };
}

/**
 * The path of thumbnail `name` of file `fileKey`, for the views item's app://shell/thumbs/… route: only a
 * well-formed thumbnail name, only in that file's thumbnails folder; null otherwise.
 */
export function thumbPathFor(userData: string, fileKey: string, name: string): string | null {
  if (typeof name !== 'string' || !parseThumbFileName(name)) return null;
  let dir: string;
  try {
    dir = thumbsDir(userData, fileKey);
  } catch {
    return null;
  }
  return path.join(dir, name);
}

/**
 * Reads thumbnail `name` for the shell route: a regular file (never a link) in the thumbnails folder, at most
 * 32 MB. Null when it is missing or anything is off.
 */
export async function readThumb(userData: string, fileKey: string, name: string): Promise<Uint8Array | null> {
  const p = thumbPathFor(userData, fileKey, name);
  if (!p) return null;
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(p, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const st = await fh.stat();
    if (!st.isFile() || st.size > THUMB_MAX_BYTES) return null;
    const buf = await fh.readFile();
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

/** Names in a thumbnails folder that belong to versions other than `keep` (thumbnails and index files). */
export function staleThumbFiles(names: readonly string[], keep: string): string[] {
  const out: string[] = [];
  for (const n of names) {
    const t = parseThumbFileName(n);
    if (t && t.version !== keep) {
      out.push(n);
      continue;
    }
    const m = INDEX_NAME.exec(n);
    if (m && m[1] !== keep) out.push(n);
  }
  return out;
}

/** Deletes the thumbnails and index files of other versions (6.9 cache); returns how many went. */
export async function pruneThumbs(userData: string, fileKey: string, keepVersion: string): Promise<number> {
  const dir = thumbsDir(userData, fileKey);
  let names: string[];
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of staleThumbFiles(names, keepVersion)) {
    try {
      await fs.promises.unlink(path.join(dir, name));
      n++;
    } catch {
      // gone already, or in use (Windows): the next run tries again
    }
  }
  forgetOtherIndexes(fileKey, keepVersion);
  return n;
}

async function cachedThumb(p: string): Promise<boolean> {
  try {
    const st = await fs.promises.lstat(p);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------------------------------- runs

export interface ThumbRunResult {
  version: string;
  width: number;
  rendered: number;
  cached: number;
  /** Slides navigation could not show (6.7: navOk false). */
  missed: number[];
}

interface Run {
  version: string;
  width: number;
  controller: AbortController;
  done: Promise<unknown>;
}

const runs = new Map<string, Run>();

/** Cancels the document's thumbnail run (a newer version, or the window closed). */
export function cancelThumbnails(fileKey: string): void {
  const r = runs.get(fileKey);
  if (r) r.controller.abort();
}

/**
 * Renders the thumbnails of every slide of `index` at `width` CSS px (6.9 Navigation), reporting each as it
 * is written: `onThumb(slide, file, info)`, `file` an absolute path in thumbsDir. Resolves when every slide
 * was reported or could not be shown; rejects with RenderCancelled when a newer version cancelled it.
 */
export async function renderThumbnails(
  doc: RenderTarget,
  index: SlideIndex,
  width: number,
  onThumb: (slide: number, file: string, info: ThumbReady) => void,
  opts: { signal?: AbortSignal | null; host?: RenderHost } = {},
): Promise<ThumbRunResult> {
  if (index.version !== doc.version) throw new RenderError('the slide index is of another version');
  if (!validThumbWidth(width)) throw new RenderError('invalid thumbnail width');
  const host = opts.host ?? renderHost();
  for (;;) {
    const prev = runs.get(doc.fileKey);
    if (!prev) break;
    if (prev.version !== doc.version) {
      // 6.9 cache by version: a newer version's run cancels the older one.
      prev.controller.abort();
    }
    await prev.done.catch(() => undefined);
    if (runs.get(doc.fileKey) === prev) runs.delete(doc.fileKey);
  }
  const controller = new AbortController();
  const signal = opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal;
  const run: Run = { version: doc.version, width, controller, done: Promise.resolve() };
  const job = runThumbs(doc, index, width, onThumb, signal, host);
  run.done = job;
  runs.set(doc.fileKey, run);
  try {
    return await job;
  } finally {
    if (runs.get(doc.fileKey) === run) runs.delete(doc.fileKey);
  }
}

async function runThumbs(
  doc: RenderTarget,
  index: SlideIndex,
  width: number,
  onThumb: (slide: number, file: string, info: ThumbReady) => void,
  signal: AbortSignal,
  host: RenderHost,
): Promise<ThumbRunResult> {
  const dir = thumbsDir(host.userData, doc.fileKey);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const px = thumbPixelSize(index.designSize, width);
  const report = (slide: number, file: string, cached: boolean) => {
    const info: ThumbReady = { version: index.version, slide, width, file: path.basename(file), pixelWidth: px.width, pixelHeight: px.height, cached };
    try {
      onThumb(slide, file, info);
    } catch (e) {
      host.log(`thumbnails: onThumb failed (${e instanceof Error ? e.message : String(e)})`);
    }
  };
  const missing = new Set<number>();
  let cached = 0;
  for (const s of index.slides) {
    throwIfCancelled(signal);
    const file = path.join(dir, thumbFileName(index.version, s.index, width));
    if (await cachedThumb(file)) {
      cached++;
      report(s.index, file, true);
    } else missing.add(s.index);
  }
  let rendered = 0;
  let missed: number[] = [];
  if (missing.size > 0) {
    await untilQuiet(doc.fileKey, signal);
    const r = await rendererFor(doc, host).use(
      designViewport(index, THUMB_SCALE),
      (view) =>
        visitSlides(
          view,
          doc,
          index,
          async (slide) => {
            const cap = await view.capture();
            if (cap.empty) {
              host.log(`thumbnails: slide ${slide + 1} captured empty`);
              return;
            }
            const png = cap.image.resize({ width: px.width, height: px.height, quality: 'best' }).toPNG();
            throwIfCancelled(signal);
            const file = path.join(dir, thumbFileName(index.version, slide, width));
            await atomicWriteFile(file, new Uint8Array(png.buffer, png.byteOffset, png.byteLength), { newFileMode: 0o600 });
            rendered++;
            report(slide, file, false);
          },
          { signal, only: missing, log: host.log },
        ),
      signal,
    );
    missed = r.missed;
  }
  if (signal.aborted) throw new RenderCancelled('the thumbnail run was cancelled');
  // The run completed: what other versions left behind goes (the index of this version stays).
  const pruned = await pruneThumbs(host.userData, doc.fileKey, index.version);
  if (pruned) host.log(`thumbnails: removed ${pruned} files of older versions`);
  return { version: index.version, width, rendered, cached, missed };
}
