// blueline:// and app:// request routing (9.1 Protocol: Refusals, Serving, Charset; Shell view).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TrustState } from '@blueline/core/ipc';
import {
  PROTECTED_CSP,
  SHELL_CSP,
  deckOrigin,
  deckUrl,
  handleDeckRequest,
  handleShellRequest,
  isDocId,
  mimeFor,
  newDocId,
  parseRange,
  type RequestLike,
  type ServedDoc,
} from '../../../packages/app/src/main/protocol';

const ID = '0123456789abcdef0123456789abcdef';
const OTHER = 'fedcba9876543210fedcba9876543210';
let root: string;
let folder: string;
let shellDir: string;
const DOC_BYTES = new TextEncoder().encode('<!doctype html><p>served copy</p>');

interface DocState {
  trust: TrustState;
  network: boolean;
  utf8: boolean;
  fileName: string;
  fail: boolean;
}
const state: DocState = { trust: 'protected', network: false, utf8: true, fileName: 'deck.html', fail: false };

function doc(): ServedDoc {
  return {
    docId: ID,
    get fileName() {
      return state.fileName;
    },
    folderReal: folder,
    trust: () => state.trust,
    networkAllowed: () => state.network,
    documentBody: async () => {
      if (state.fail) throw new Error('boom: /secret/path');
      return { body: DOC_BYTES, utf8: state.utf8 };
    },
  };
}
const lookup = (id: string) => (id === ID ? doc() : undefined);

function req(url: string, method = 'GET', headers: Record<string, string> = {}): RequestLike {
  const h = new Headers(headers);
  return { url, method, headers: { get: (n: string) => h.get(n) } };
}

async function get(url: string, method = 'GET', headers: Record<string, string> = {}) {
  const res = await handleDeckRequest(req(url, method, headers), lookup);
  const body = new Uint8Array(await res.arrayBuffer());
  return { res, body, text: new TextDecoder().decode(body) };
}

beforeAll(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bl-proto-')));
  folder = path.join(root, 'decks');
  fs.mkdirSync(path.join(folder, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(folder, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'deck.html'), 'RAW FILE ON DISK');
  fs.writeFileSync(path.join(folder, 'img.png'), 'PNGBYTES');
  fs.writeFileSync(path.join(folder, 'sub', 'a.css'), 'p{color:red}');
  fs.writeFileSync(path.join(folder, 'f.woff2'), 'FONT');
  fs.writeFileSync(path.join(folder, 'Font.TTF'), 'TTF');
  fs.writeFileSync(path.join(folder, 'secret.txt'), 'SECRET');
  fs.writeFileSync(path.join(folder, '.ssh', 'id_rsa'), 'KEY');
  fs.writeFileSync(path.join(folder, 'empty.css'), '');
  fs.writeFileSync(path.join(folder, 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const wav = Buffer.alloc(1000);
  for (let i = 0; i < wav.length; i++) wav[i] = i & 0xff;
  fs.writeFileSync(path.join(folder, 'a.wav'), wav);
  fs.writeFileSync(path.join(root, 'outside.png'), 'OUTSIDE');
  fs.symlinkSync(path.join(root, 'outside.png'), path.join(folder, 'out.png'));
  shellDir = path.join(root, 'shell');
  fs.mkdirSync(shellDir);
  fs.writeFileSync(path.join(shellDir, 'index.html'), '<!doctype html><title>shell</title>');
  fs.writeFileSync(path.join(shellDir, 'shell.js'), 'void 0;');
  fs.writeFileSync(path.join(shellDir, 'notes.txt'), 'no');
  fs.writeFileSync(path.join(root, 'shell-secret.js'), 'secret');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function reset() {
  Object.assign(state, { trust: 'protected', network: false, utf8: true, fileName: 'deck.html', fail: false });
}

describe('ids and URLs', () => {
  it('docIds are lowercase hex', () => {
    expect(isDocId(ID)).toBe(true);
    expect(isDocId(newDocId())).toBe(true);
    expect(newDocId()).not.toBe(newDocId());
    expect(isDocId('ABCDEF0123')).toBe(false);
    expect(isDocId('xyz12345')).toBe(false);
    expect(isDocId('abc')).toBe(false);
    expect(isDocId(ID + '-files')).toBe(false);
  });
  it('deckUrl encodes the file name as one segment', () => {
    expect(deckUrl(ID, 'my deck (v2).html')).toBe(`blueline://${ID}/my%20deck%20(v2).html`);
    expect(deckUrl(ID, 'a/b#?.html')).toBe(`blueline://${ID}/a%2Fb%23%3F.html`);
    expect(() => deckUrl('NOPE', 'x.html')).toThrow();
    expect(deckOrigin(ID)).toBe(`blueline://${ID}`);
  });
});

describe('the document host', () => {
  it('serves the served copy at the exact path, Protected headers on', async () => {
    reset();
    const { res, text } = await get(`blueline://${ID}/deck.html`);
    expect(res.status).toBe(200);
    expect(text).toBe('<!doctype html><p>served copy</p>');
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-security-policy')).toBe(PROTECTED_CSP);
    expect(PROTECTED_CSP).toBe("connect-src 'none'");
    expect(res.headers.get('x-dns-prefetch-control')).toBe('off');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('drops the Protected headers when Trusted or after Allow network', async () => {
    reset();
    state.trust = 'trusted';
    let r = await get(`blueline://${ID}/deck.html`);
    expect(r.res.headers.get('content-security-policy')).toBeNull();
    expect(r.res.headers.get('x-dns-prefetch-control')).toBeNull();
    reset();
    state.network = true;
    r = await get(`blueline://${ID}/deck.html`);
    expect(r.res.headers.get('content-security-policy')).toBeNull();
  });

  it('serves a non-UTF-8 deck as text/html with no charset (9.1 Charset)', async () => {
    reset();
    state.utf8 = false;
    const { res } = await get(`blueline://${ID}/deck.html`);
    expect(res.headers.get('content-type')).toBe('text/html');
  });

  it('ignores the query and the fragment', async () => {
    reset();
    expect((await get(`blueline://${ID}/deck.html?x=1#slide-3`)).res.status).toBe(200);
    expect((await get(`blueline://${ID}/deck.html#/2/1`)).res.status).toBe(200);
  });

  it('matches encoded names exactly after one decode', async () => {
    reset();
    state.fileName = 'my deck (v2).html';
    expect((await get(`blueline://${ID}/my%20deck%20(v2).html`)).res.status).toBe(200);
    expect((await get(`blueline://${ID}/my%20deck%20%28v2%29.html`)).res.status).toBe(200);
    expect((await get(`blueline://${ID}/My%20deck%20(v2).html`)).res.status).toBe(307);
    state.fileName = '.deck.bl-probe.html'; // the map probe copy starts with a dot and still loads
    expect((await get(`blueline://${ID}/.deck.bl-probe.html`)).res.status).toBe(200);
    expect((await get(`blueline://${ID}/%2Edeck.bl-probe.html`)).res.status).toBe(200);
    state.fileName = 'café.html';
    expect((await get(`blueline://${ID}/caf%C3%A9.html`)).res.status).toBe(200);
    expect((await get(`blueline://${ID}/cafe%CC%81.html`)).res.status).toBe(307); // NFD is another name
  });

  it('redirects every other path to the -files host with 307, path kept, query dropped', async () => {
    reset();
    for (const [p, loc] of [
      ['/img.png', '/img.png'],
      ['/sub/a.css?v=2', '/sub/a.css'],
      ['/sub/deck.html', '/sub/deck.html'],
      ['/.ssh/id_rsa', '/.ssh/id_rsa'],
      ['/', '/'],
      ['/deck.html/x', '/deck.html/x'],
      // The URL parser resolves dot segments (also when percent-encoded) before the handler sees them,
      // and a path can never rise above the root.
      ['/%2e%2e/x.png', '/x.png'],
      ['/sub/%2E%2e/%2e%2e/img.png', '/img.png'],
    ]) {
      const { res, body } = await get(`blueline://${ID}${p}`);
      expect(res.status, p).toBe(307);
      expect(res.headers.get('location'), p).toBe(`blueline://${ID}-files${loc}`);
      expect(body.byteLength).toBe(0);
    }
  });

  it('returns a bare 404 when the served copy fails', async () => {
    reset();
    state.fail = true;
    const { res, text } = await get(`blueline://${ID}/deck.html`);
    expect(res.status).toBe(404);
    expect(text).toBe('');
  });

  it('answers HEAD without a body and refuses other methods', async () => {
    reset();
    const head = await get(`blueline://${ID}/deck.html`, 'HEAD');
    expect(head.res.status).toBe(200);
    expect(head.body.byteLength).toBe(0);
    for (const m of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      expect((await get(`blueline://${ID}/deck.html`, m)).res.status, m).toBe(404);
      expect((await get(`blueline://${ID}-files/img.png`, m)).res.status, m).toBe(404);
    }
  });
});

describe('host refusals (step 1)', () => {
  it.each([
    [`blueline://xyz/deck.html`, 'non-hex host'],
    [`blueline://${ID.toUpperCase()}/deck.html`, 'upper-case host'],
    [`blueline://${OTHER}/deck.html`, 'another partition'],
    [`blueline://${OTHER}-files/img.png`, "another partition's files"],
    [`blueline://${ID}-files-files/img.png`, 'double suffix'],
    [`blueline://-files/img.png`, 'empty id'],
    [`blueline://${ID}:8080/deck.html`, 'port'],
    [`blueline://user:pw@${ID}/deck.html`, 'credentials'],
    [`http://${ID}/deck.html`, 'other scheme'],
    [`app://shell/index.html`, 'shell scheme'],
    [`not a url`, 'unparseable'],
    [`blueline:///deck.html`, 'no host'],
  ])('%s → 404 (%s)', async (url) => {
    reset();
    const { res, text } = await get(url);
    expect(res.status).toBe(404);
    expect(text).toBe('');
    expect(res.headers.get('location')).toBeNull();
  });

  it('refuses a lookup that returns another docId', async () => {
    const wrong = (id: string) => (id === ID ? { ...doc(), docId: OTHER } : undefined);
    const res = await handleDeckRequest(req(`blueline://${ID}/deck.html`), wrong);
    expect(res.status).toBe(404);
  });
});

describe('the -files host', () => {
  it('serves raw files with the right MIME, nosniff, CSP sandbox and no CORS', async () => {
    reset();
    const { res, text } = await get(`blueline://${ID}-files/img.png`);
    expect(res.status).toBe(200);
    expect(text).toBe('PNGBYTES');
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe('sandbox');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('content-length')).toBe('8');
    const css = await get(`blueline://${ID}-files/sub/a.css?x#y`);
    expect(css.res.headers.get('content-type')).toBe('text/css');
    expect(css.text).toBe('p{color:red}');
    const svg = await get(`blueline://${ID}-files/pic.svg`);
    expect(svg.res.headers.get('content-type')).toBe('image/svg+xml');
    expect(svg.res.headers.get('content-security-policy')).toBe('sandbox');
  });

  it('gives fonts (only) the CORS header for the document origin', async () => {
    reset();
    const f = await get(`blueline://${ID}-files/f.woff2`);
    expect(f.res.headers.get('access-control-allow-origin')).toBe(`blueline://${ID}`);
    expect(f.res.headers.get('content-type')).toBe('font/woff2');
    const t = await get(`blueline://${ID}-files/Font.TTF`);
    expect(t.res.headers.get('access-control-allow-origin')).toBe(`blueline://${ID}`);
    expect(t.res.headers.get('content-type')).toBe('font/ttf');
  });

  it('refuses CORS-mode requests (with Origin) for anything but fonts, on both hosts', async () => {
    // Electron applies no CORS to protocol.handle responses, so module scripts, import(), CSS modules and
    // crossorigin elements would otherwise read the files. Fonts keep their CORS header.
    reset();
    const o = { Origin: `blueline://${ID}` };
    for (const p of ['/img.png', '/sub/a.css', '/m.js', '/a.wav']) {
      const files = await get(`blueline://${ID}-files${p}`, 'GET', o);
      expect(files.res.status, p).toBe(404);
      const docHost = await get(`blueline://${ID}${p}`, 'GET', o);
      expect(docHost.res.status, p).toBe(404);
      expect(docHost.res.headers.get('location')).toBeNull();
    }
    const nullOrigin = await get(`blueline://${ID}-files/img.png`, 'GET', { Origin: 'null' });
    expect(nullOrigin.res.status).toBe(404);
    const font = await get(`blueline://${ID}-files/f.woff2`, 'GET', o);
    expect(font.res.status).toBe(200);
    expect(font.res.headers.get('access-control-allow-origin')).toBe(`blueline://${ID}`);
    const fontRedirect = await get(`blueline://${ID}/Font.TTF`, 'GET', o);
    expect(fontRedirect.res.status).toBe(307);
    // The document itself is same-origin and served as usual.
    expect((await get(`blueline://${ID}/deck.html`, 'GET', o)).res.status).toBe(200);
    // Without Origin (an <img>, a classic <script>, a stylesheet) the files are served.
    expect((await get(`blueline://${ID}-files/img.png`)).res.status).toBe(200);
  });

  it('serves only allowlisted extensions', async () => {
    reset();
    for (const p of ['/secret.txt', '/deck.html', '/.ssh/id_rsa', '/%2essh/id_rsa', '/out.png', '/missing.png', '/sub', '/']) {
      const { res, text } = await get(`blueline://${ID}-files${p}`);
      expect(res.status, p).toBe(404);
      expect(text, p).toBe('');
    }
    const exts = ['css', 'js', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp', 'woff', 'woff2', 'ttf', 'otf', 'mp3', 'm4a', 'wav', 'ogg', 'webm', 'mp4'];
    for (const e of exts) expect(mimeFor(e), e).toBeTruthy();
    for (const e of ['html', 'htm', 'txt', 'json', 'pdf', 'xml', 'mjs', 'wasm', 'toString', '__proto__']) expect(mimeFor(e), e).toBeUndefined();
  });

  it('serves an empty file', async () => {
    reset();
    const { res, body } = await get(`blueline://${ID}-files/empty.css`);
    expect(res.status).toBe(200);
    expect(body.byteLength).toBe(0);
  });

  it('supports single byte ranges for media', async () => {
    reset();
    const all = fs.readFileSync(path.join(folder, 'a.wav'));
    let r = await get(`blueline://${ID}-files/a.wav`);
    expect(r.res.status).toBe(200);
    expect(r.res.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(r.body).equals(all)).toBe(true);
    r = await get(`blueline://${ID}-files/a.wav`, 'GET', { Range: 'bytes=10-19' });
    expect(r.res.status).toBe(206);
    expect(r.res.headers.get('content-range')).toBe('bytes 10-19/1000');
    expect(r.res.headers.get('content-length')).toBe('10');
    expect(Buffer.from(r.body).equals(all.subarray(10, 20))).toBe(true);
    r = await get(`blueline://${ID}-files/a.wav`, 'GET', { Range: 'bytes=-5' });
    expect(Buffer.from(r.body).equals(all.subarray(995))).toBe(true);
    r = await get(`blueline://${ID}-files/a.wav`, 'GET', { Range: 'bytes=990-' });
    expect(r.res.headers.get('content-range')).toBe('bytes 990-999/1000');
    r = await get(`blueline://${ID}-files/a.wav`, 'GET', { Range: 'bytes=0-999999' });
    expect(r.res.status).toBe(206);
    expect(r.body.byteLength).toBe(1000);
    r = await get(`blueline://${ID}-files/a.wav`, 'GET', { Range: 'bytes=2000-' });
    expect(r.res.status).toBe(416);
    expect(r.res.headers.get('content-range')).toBe('bytes */1000');
    r = await get(`blueline://${ID}-files/a.wav`, 'GET', { Range: 'bytes=0-1,5-9' });
    expect(r.res.status).toBe(200); // multi-range ignored
    r = await get(`blueline://${ID}-files/img.png`, 'GET', { Range: 'bytes=0-1' });
    expect(r.res.status).toBe(200); // not media: Range ignored
    expect(r.text).toBe('PNGBYTES');
  });

  it('parseRange', () => {
    expect(parseRange(null, 10)).toBeNull();
    expect(parseRange('bytes=0-4', 10)).toEqual({ start: 0, end: 4 });
    expect(parseRange('bytes=5-', 10)).toEqual({ start: 5, end: 9 });
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange('bytes=-30', 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=4-2', 10)).toBeNull();
    expect(parseRange('bytes=10-', 10)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 10)).toBe('unsatisfiable');
    expect(parseRange('bytes=-', 10)).toBeNull();
    expect(parseRange('items=0-4', 10)).toBeNull();
    expect(parseRange('bytes=99999999999999999999-', 10)).toBeNull();
  });
});

describe('app://shell', () => {
  async function shellGet(url: string, method = 'GET') {
    const res = await handleShellRequest(req(url, method), fs.realpathSync.native(shellDir));
    return { res, text: await res.text() };
  }
  it('serves bundle files with the shell CSP', async () => {
    const { res, text } = await shellGet('app://shell/index.html');
    expect(res.status).toBe(200);
    expect(text).toContain('<title>shell</title>');
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toBe(SHELL_CSP);
    expect(SHELL_CSP).toBe("default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'");
    expect((await shellGet('app://shell/shell.js')).res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  });
  it.each([
    'app://shell/../shell-secret.js',
    'app://shell/%2e%2e/shell-secret.js',
    'app://shell/notes.txt',
    'app://other/index.html',
    'app://shell:1/index.html',
    `blueline://${ID}/deck.html`,
    'app://shell/',
    'app://shell/missing.js',
  ])('refuses %s', async (url) => {
    const { res, text } = await shellGet(url);
    expect(res.status).toBe(404);
    expect(text).toBe('');
  });
  it('refuses POST', async () => {
    expect((await shellGet('app://shell/index.html', 'POST')).res.status).toBe(404);
  });
});
