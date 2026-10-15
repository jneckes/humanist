// The blueline:// and app:// schemes (9.1 Protocol, Shell view).
//
// blueline://<docId>/<file name>        the document's served (stamped) copy, and nothing else
// blueline://<docId>-files/<path>       its folder's display files: a second origin the page cannot read
// app://shell/<file>                    the shell UI from the app bundle
//
// The request→response logic is plain functions over a minimal request shape (handleDeckRequest,
// handleShellRequest) that return a standard `Response`, so unit tests drive them with fake lookups and
// real temp folders. Electron is only touched by registerPrivilegedSchemes and the install functions.

import * as fs from 'node:fs';
import * as electron from 'electron';
import type { Session } from 'electron';
import type { TrustState } from '@blueline/core/ipc';
import { FILES_EXTENSIONS, extOf, resolveConfined } from './confine';

export const DECK_SCHEME = 'blueline';
export const SHELL_SCHEME = 'app';
export const SHELL_HOST = 'shell';
export const SHELL_ORIGIN = 'app://shell';
/** 9.1 Shell view: the shell's CSP, verbatim. */
export const SHELL_CSP = "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'";
/** 9.9 Network policy, Protected: sent with the document so fetch, XHR, EventSource, WebSocket and sendBeacon fail. */
export const PROTECTED_CSP = "connect-src 'none'";
const FILES_SUFFIX = '-files';

/**
 * Registers `blueline` and `app` as privileged schemes. Must run before `app.whenReady()` resolves.
 * 9.1 Registration: `blueline` is standard, secure, fetch-capable, streamable (media) and CORS-enabled
 * (for the font CORS header); `bypassCSP` is never set, so a deck's own CSP and ours both apply.
 */
export function registerPrivilegedSchemes(): void {
  electron.protocol.registerSchemesAsPrivileged([
    {
      scheme: DECK_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
    },
    { scheme: SHELL_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

/** One document as a partition's handler sees it (docs/ARCHITECTURE.md, Document serving). */
export interface ServedDoc {
  /** Lowercase hex (isDocId). A standard scheme lowercases hosts, so an uppercase id could never match. */
  docId: string;
  /** Basename; the document is served at `deckUrl(docId, fileName)`. */
  fileName: string;
  /** realpath of the document's folder. */
  folderReal: string;
  /** Current trust. Protected adds `connect-src 'none'` and `X-DNS-Prefetch-Control: off`. */
  trust(): TrustState;
  /**
   * Added by app-security: true after **Allow network** (6.10), which turns on the Trusted network
   * policy, so the Protected headers are not sent. Absent means false.
   */
  networkAllowed?(): boolean;
  /** The served copy (stamps, notes block removed). `utf8: false` serves `text/html` with no charset (9.1 Charset). */
  documentBody(): Promise<{ body: Uint8Array; utf8: boolean }>;
}

/** Only documents of the calling partition; undefined for anything else (9.1 Refusals step 1). */
export type DocLookup = (docId: string) => ServedDoc | undefined;

/** The parts of a `Request` the handlers read (Electron passes a real `Request`). */
export interface RequestLike {
  url: string;
  method: string;
  headers: { get(name: string): string | null };
}

const DOC_ID = /^[0-9a-f]{8,64}$/;

/** A docId is 8–64 lowercase hex digits. */
export function isDocId(s: string): boolean {
  return typeof s === 'string' && DOC_ID.test(s);
}

/** A fresh random docId (128 bits, lowercase hex) for a newly opened document. */
export function newDocId(): string {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The URL a document loads at: `blueline://<docId>/<percent-encoded file name>` (9.1 URLs). */
export function deckUrl(docId: string, fileName: string): string {
  if (!isDocId(docId)) throw new Error('invalid docId');
  return `${DECK_SCHEME}://${docId}/${encodeURIComponent(fileName)}`;
}

/** The origin of a document's page, as `WebFrameMain.origin` reports it. */
export function deckOrigin(docId: string): string {
  return `${DECK_SCHEME}://${docId}`;
}

// 9.1 Serving: "the right MIME type". CSS and JS carry no charset, so (as for file://) the browser falls
// back to the referring document's encoding; a windows-1252 deck keeps working with windows-1252 scripts.
const MIME: Readonly<Record<string, string>> = {
  css: 'text/css',
  js: 'text/javascript',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  webm: 'video/webm',
  mp4: 'video/mp4',
};
const FONT_EXTENSIONS: ReadonlySet<string> = new Set(['woff', 'woff2', 'ttf', 'otf']);
const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set(['mp3', 'm4a', 'wav', 'ogg', 'webm', 'mp4']);

/** MIME type for an extension served by the `-files` host, or undefined. */
export function mimeFor(ext: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(MIME, ext) ? MIME[ext] : undefined;
}

/** Every refusal is the same bare 404: no body, no details (9.1 Refusals). */
function notFound(): Response {
  return new Response(null, {
    status: 404,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox' },
  });
}

/**
 * The blueline:// request→response logic for one partition (9.1 Refusals 1–4 and Serving). Never throws;
 * every failure is a 404.
 */
export async function handleDeckRequest(req: RequestLike, lookup: DocLookup): Promise<Response> {
  try {
    return await routeDeckRequest(req, lookup);
  } catch {
    return notFound();
  }
}

async function routeDeckRequest(req: RequestLike, lookup: DocLookup): Promise<Response> {
  const method = String(req.method).toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return notFound();
  // Step 1: parse with new URL(); the query and the fragment are ignored from here on.
  let u: URL;
  try {
    u = new URL(req.url);
  } catch {
    return notFound();
  }
  if (u.protocol !== `${DECK_SCHEME}:` || u.username !== '' || u.password !== '' || u.port !== '') return notFound();
  const host = u.hostname;
  const files = host.endsWith(FILES_SUFFIX);
  const docId = files ? host.slice(0, -FILES_SUFFIX.length) : host;
  if (!isDocId(docId)) return notFound();
  const doc = lookup(docId);
  if (!doc || doc.docId !== docId) return notFound();

  if (!files) {
    // Only the document's own path, matched exactly, is served on the <docId> host. The single segment is
    // decoded once and compared with the file name, so Chromium's choice of which characters to
    // percent-encode cannot make the exact match fail. A name starting with `.` (the probe copy) loads.
    if (isDocumentPath(u.pathname, doc.fileName)) return serveDocument(doc, method);
    // A CORS-mode request (it carries Origin) for anything but a font is refused here rather than
    // redirected: Electron drops the Origin header on the redirected leg, so the -files host could not
    // tell it apart from an <img>. See corsReadRefused.
    if (corsReadRefused(req, lastSegmentExt(u.pathname))) return notFound();
    // 9.1 Serving: every other path is redirected to the second origin, which serves raw files.
    return new Response(null, {
      status: 307,
      headers: { Location: `${DECK_SCHEME}://${docId}${FILES_SUFFIX}${u.pathname}`, 'Cache-Control': 'no-store' },
    });
  }

  // Steps 2–4 on every -files path, with the extension allowlist.
  const file = resolveConfined(doc.folderReal, u.pathname, { allowedExtensions: FILES_EXTENSIONS });
  if (!file) return notFound();
  if (corsReadRefused(req, file.ext)) {
    closeQuietly(file.fd);
    return notFound();
  }
  return serveFile(file, docId, method, req.headers.get('range'));
}

/**
 * Electron 44 does not apply CORS to protocol.handle responses (Phase 0 finding): a module script, an
 * `import()`, a CSS module import or a `crossorigin` image or stylesheet would get a readable response from
 * the second origin, defeating 9.1 Serving ("the page can show them … but cannot read them"). Those are
 * exactly the requests that carry an `Origin` header, so the handler refuses them, except fonts (which
 * 9.1 gives a CORS header so `@font-face` works). This matches Chrome's file://, where module scripts and
 * crossorigin loads of local files fail. fetch() and XHR send no Origin here; onBeforeRequest cancels
 * them by type (network-policy, 'files-read').
 */
function corsReadRefused(req: RequestLike, ext: string): boolean {
  return req.headers.get('origin') !== null && !FONT_EXTENSIONS.has(ext);
}

function lastSegmentExt(pathname: string): string {
  const seg = pathname.slice(pathname.lastIndexOf('/') + 1);
  try {
    return extOf(decodeURIComponent(seg));
  } catch {
    return '';
  }
}

function isDocumentPath(pathname: string, fileName: string): boolean {
  if (pathname.charCodeAt(0) !== 0x2f) return false;
  const seg = pathname.slice(1);
  if (seg.length === 0 || seg.includes('/')) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(seg);
  } catch {
    return false;
  }
  return decoded === fileName;
}

async function serveDocument(doc: ServedDoc, method: string): Promise<Response> {
  const { body, utf8 } = await doc.documentBody();
  const headers: Record<string, string> = {
    // 9.1 Charset: a deck that failed the UTF-8 check is sent with no charset so its own <meta charset> applies.
    'Content-Type': utf8 ? 'text/html; charset=utf-8' : 'text/html',
    'Content-Length': String(body.byteLength),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (doc.trust() === 'protected' && !(doc.networkAllowed?.() ?? false)) {
    // 9.9 Network policy, Protected: connect-src 'none' (enforced alongside the deck's own CSP), and no DNS
    // prefetching (Channels that onBeforeRequest does not see).
    headers['Content-Security-Policy'] = PROTECTED_CSP;
    headers['X-DNS-Prefetch-Control'] = 'off';
  }
  return new Response(method === 'HEAD' ? null : (body as Uint8Array<ArrayBuffer>), { status: 200, headers });
}

/**
 * Parses a single `bytes=` range against a file size. Returns the inclusive range, 'unsatisfiable', or
 * null to ignore the header and send the whole file (allowed by RFC 9110; multi-ranges are ignored).
 */
export function parseRange(header: string | null, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (header === null) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (!Number.isSafeInteger(suffix)) return null;
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  let end = m[2] === '' ? Math.max(start, size - 1) : Number(m[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return null;
  if (start >= size) return 'unsatisfiable';
  if (end >= size) end = size - 1;
  return { start, end };
}

function serveFile(
  file: { fd: number; size: number; ext: string },
  docId: string,
  method: string,
  range: string | null,
): Response {
  const mime = mimeFor(file.ext);
  if (!mime) {
    closeQuietly(file.fd);
    return notFound();
  }
  const headers: Record<string, string> = {
    'Content-Type': mime,
    'Cache-Control': 'no-store',
    // 9.1 Serving: every -files response, so a file opened as a frame (an SVG, say) runs no script and is
    // never sniffed into something else.
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox',
  };
  // Only fonts get a CORS header, so @font-face works; everything else stays unreadable to the page.
  if (FONT_EXTENSIONS.has(file.ext)) headers['Access-Control-Allow-Origin'] = deckOrigin(docId);

  let start = 0;
  let end = file.size - 1;
  let status = 200;
  if (MEDIA_EXTENSIONS.has(file.ext)) {
    headers['Accept-Ranges'] = 'bytes';
    const r = parseRange(range, file.size);
    if (r === 'unsatisfiable') {
      closeQuietly(file.fd);
      headers['Content-Range'] = `bytes */${file.size}`;
      return new Response(null, { status: 416, headers });
    }
    if (r) {
      start = r.start;
      end = r.end;
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${file.size}`;
    }
  }
  const length = Math.max(0, end - start + 1);
  headers['Content-Length'] = String(length);
  if (method === 'HEAD' || length === 0) {
    closeQuietly(file.fd);
    return new Response(null, { status, headers });
  }
  return new Response(fdStream(file.fd, start, start + length), { status, headers });
}

function closeQuietly(fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {
    // already closed
  }
}

const CHUNK = 64 * 1024;

// Backstop: a stream that is dropped without being read to the end or cancelled still closes its
// descriptor when it is collected, so an aborted request can never leak one.
const fdFinalizer = new FinalizationRegistry<{ fd: number; closed: boolean }>((state) => {
  if (!state.closed) {
    state.closed = true;
    fs.close(state.fd, () => {});
  }
});

/**
 * Streams [start, endExclusive) of an open descriptor and closes it at the end, on error, or when the
 * consumer cancels (a media element seeking away). Reads by position from the verified descriptor, never
 * by path, so the bytes are those of the file that passed step 4.
 */
function fdStream(fd: number, start: number, endExclusive: number): ReadableStream<Uint8Array> {
  let pos = start;
  const state = { fd, closed: false };
  const close = () => {
    if (!state.closed) {
      state.closed = true;
      fs.close(fd, () => {});
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const want = Math.min(CHUNK, endExclusive - pos);
      if (want <= 0) {
        close();
        controller.close();
        return;
      }
      const buf = new Uint8Array(want);
      let n: number;
      try {
        n = await new Promise<number>((resolve, reject) =>
          fs.read(fd, buf, 0, want, pos, (err, bytesRead) => (err ? reject(err) : resolve(bytesRead))),
        );
      } catch (err) {
        close();
        controller.error(err);
        return;
      }
      if (n === 0) {
        // The file shrank after the fstat: end early rather than pad.
        close();
        controller.close();
        return;
      }
      pos += n;
      controller.enqueue(n === want ? buf : buf.subarray(0, n));
    },
    cancel() {
      close();
    },
  });
  fdFinalizer.register(stream, state);
  return stream;
}

/**
 * Installs the blueline:// handler on one deck partition (9.1 Per-partition handler). `lookup` returns only
 * documents that belong to this partition. Calling it again for the same session replaces the handler
 * (for example a Trusted file's persistent partition reopened with a new docId).
 */
export function installDeckProtocol(ses: Session, lookup: DocLookup): void {
  if (ses.protocol.isProtocolHandled(DECK_SCHEME)) ses.protocol.unhandle(DECK_SCHEME);
  ses.protocol.handle(DECK_SCHEME, (request) => handleDeckRequest(request, lookup));
}

/** Files the shell may load from its bundle folder. */
export const SHELL_EXTENSIONS: ReadonlySet<string> = new Set(['html', 'js', 'css', 'svg', 'png', 'woff2', 'map']);
const SHELL_MIME: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  woff2: 'font/woff2',
  map: 'application/json; charset=utf-8',
};

/**
 * The app:// request→response logic (9.1 Shell view): only `app://shell/<file>` for files inside
 * `shellDirReal` (same confinement as the deck handler), each with the shell CSP. Never throws.
 */
export async function handleShellRequest(req: RequestLike, shellDirReal: string): Promise<Response> {
  try {
    const method = String(req.method).toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return notFound();
    let u: URL;
    try {
      u = new URL(req.url);
    } catch {
      return notFound();
    }
    if (u.protocol !== `${SHELL_SCHEME}:` || u.hostname !== SHELL_HOST) return notFound();
    if (u.username !== '' || u.password !== '' || u.port !== '') return notFound();
    const file = resolveConfined(shellDirReal, u.pathname, { allowedExtensions: SHELL_EXTENSIONS });
    if (!file) return notFound();
    const mime = Object.prototype.hasOwnProperty.call(SHELL_MIME, file.ext) ? SHELL_MIME[file.ext] : undefined;
    if (!mime) {
      closeQuietly(file.fd);
      return notFound();
    }
    const headers: Record<string, string> = {
      'Content-Type': mime,
      'Content-Length': String(file.size),
      'Content-Security-Policy': SHELL_CSP,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    };
    if (method === 'HEAD' || file.size === 0) {
      closeQuietly(file.fd);
      return new Response(null, { status: 200, headers });
    }
    return new Response(fdStream(file.fd, 0, file.size), { status: 200, headers });
  } catch {
    return notFound();
  }
}

/**
 * Installs app:// on the shell's own session (never a deck partition). `shellDir` is the bundled shell
 * folder (dist/shell); it is resolved to its realpath once here.
 */
export function installShellProtocol(ses: Session, shellDir: string): void {
  const dirReal = fs.realpathSync.native(shellDir);
  if (ses.protocol.isProtocolHandled(SHELL_SCHEME)) ses.protocol.unhandle(SHELL_SCHEME);
  ses.protocol.handle(SHELL_SCHEME, (request) => handleShellRequest(request, dirReal));
}
