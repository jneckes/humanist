// Render products follow the trust policy (review finding 15; 6.7: background renders use the visible view's
// trust policy; 6.9 Navigation and Find; 6.10 Allow network). The thumbnails and the slide index are cached by
// version, and a Protected render without the network misses what the deck loads from a host off the allowlist.
// After Allow network, Blueline drops the current version's products and builds them again under the new
// policy: Find finds the fetched word and the thumbnail shows the photo; a later open that remembers Allow
// network uses those fresh products.

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { ROOT, Scratch, launchApp, resolveRunAs, sleep, type BlApp } from '../helpers/app';
import { BIND_HOST } from '../helpers/servers';

test.describe.configure({ mode: 'serial' });

const scratch = new Scratch(resolveRunAs());
test.afterAll(() => scratch.cleanup());

const GREEN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="500"><rect width="1200" height="500" fill="#00c853"/></svg>';

/** Slide 1 shows a photo from the server; slide 2 sets its heading from data it fetches there. */
function deckHtml(base: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Net deck</title><style>
html, body { margin: 0; height: 100%; background: #fff; overflow: hidden; font-family: sans-serif; }
.stage { position: absolute; left: 50%; top: 50%; width: 1600px; height: 900px; transform: translate(-50%, -50%); overflow: hidden; }
[data-slide] { position: absolute; inset: 0; padding: 80px; opacity: 0; visibility: hidden; }
[data-slide].is-active { opacity: 1; visibility: visible; }
h2 { font-size: 64px; margin: 0 0 40px; }
#photo { display: block; width: 1200px; height: 500px; }
</style></head><body><div class="stage" id="stage">
<article data-slide><h2>Photo slide</h2><img id="photo" alt="" src="${base}/photo.svg"></article>
<article data-slide><h2 id="chart">Loading chart</h2></article>
<article data-slide><h2>Closing slide</h2></article>
</div><script>
(function () {
  var slides = Array.prototype.slice.call(document.querySelectorAll('[data-slide]')), index = 0;
  function show(i) { index = Math.max(0, Math.min(slides.length - 1, i)); slides.forEach(function (s, k) { s.classList.toggle('is-active', k === index); }); }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight') { e.preventDefault(); show(index + 1); } else if (e.key === 'ArrowLeft') { e.preventDefault(); show(index - 1); }
  });
  show(0);
  fetch('${base}/data', { cache: 'no-store' }).then(function (r) { return r.text(); }).then(function (t) {
    document.getElementById('chart').textContent = 'Revenue by region ' + t;
  }, function () { document.getElementById('chart').textContent = 'Chart data unavailable'; });
})();
</script></body></html>`;
}

let server: http.Server;
let base = '';
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
    if ((req.url ?? '').startsWith('/photo.svg')) {
      res.writeHead(200, { ...cors, 'Content-Type': 'image/svg+xml' });
      res.end(GREEN_SVG);
    } else if ((req.url ?? '').startsWith('/data')) {
      res.writeHead(200, { ...cors, 'Content-Type': 'text/plain' });
      res.end('ZEBRACHART');
    } else {
      res.writeHead(404, cors);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, BIND_HOST, () => r()));
  base = `http://${BIND_HOST}:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function thumbsDirOf(userData: string): string {
  const files = path.join(userData, 'files');
  const keys = fs.existsSync(files) ? fs.readdirSync(files).filter((k) => /^[0-9a-f]{16}$/.test(k)) : [];
  if (keys.length !== 1) throw new Error(`expected one fileKey, got ${keys.join(',')}`);
  return path.join(files, keys[0], 'thumbs');
}

/** The share of a PNG's pixels that are the photo's green. */
async function greenShare(app: BlApp, file: string): Promise<number> {
  return await app.electronApp.evaluate(
    ({ nativeImage }, f) => {
      const img = nativeImage.createFromPath(f);
      const { width, height } = img.getSize();
      const bmp = img.toBitmap(); // BGRA
      let n = 0;
      for (let i = 0; i < width * height; i++) {
        const b = bmp[i * 4];
        const g = bmp[i * 4 + 1];
        const r = bmp[i * 4 + 2];
        if (g > 150 && r < 80 && b < 140) n++;
      }
      return width * height > 0 ? n / (width * height) : 0;
    },
    file,
  );
}

async function find(app: BlApp, docId: string, q: string): Promise<{ pending: boolean; hits: unknown[] }> {
  return (await app.electronApp.evaluate((_e, a) => (globalThis as unknown as { __blTest: { find(d: string, q: string): unknown } }).__blTest.find(a.id, a.q), { id: docId, q })) as {
    pending: boolean;
    hits: unknown[];
  };
}

/** The slide index is ready, and slide 1's thumbnail is on disk: returns its green share. */
async function products(app: BlApp, docId: string): Promise<number> {
  await expect.poll(async () => ((await app.win(docId)) as unknown as { state: { index: { ready: boolean } | null } }).state.index?.ready ?? false, { timeout: 90_000 }).toBe(true);
  let file = '';
  await expect
    .poll(
      () => {
        try {
          const dir = thumbsDirOf(app.userData);
          const n = fs.readdirSync(dir).find((x) => /-0-\d+\.png$/.test(x));
          file = n ? path.join(dir, n) : '';
        } catch {
          file = '';
        }
        return file !== '';
      },
      { timeout: 90_000 },
    )
    .toBe(true);
  await sleep(300);
  return await greenShare(app, file);
}

test('after Allow network the thumbnails and the slide index are made again under the new policy, and kept for the next open', async () => {
  const dir = scratch.dir('views-products-policy');
  const file = path.join(dir, 'net-deck.html');
  fs.writeFileSync(file, deckHtml(base));
  const mdir = path.join(ROOT, 'test-results', 'views-products-policy');
  fs.mkdirSync(mdir, { recursive: true, mode: 0o755 });
  const markers = path.join(mdir, 'markers.json');
  fs.writeFileSync(markers, JSON.stringify({ [fs.realpathSync(file)]: '0083;66f0a1b2;Safari;8C4E9C1E-0000-4000-8000-000000000001' }), { mode: 0o644 });
  scratch.own(dir);
  scratch.own(mdir);
  const env = { BLUELINE_TEST_MARKERS: markers };

  // Protected (the marker): the walk cannot reach the server.
  let app = await launchApp({ files: [file], scratch, env });
  const userData = app.userData;
  try {
    const deck = await app.waitForDeck('net-deck.html');
    expect((await app.win(deck.docId)).trust).toBe('protected');
    expect(await products(app, deck.docId)).toBeLessThan(0.05);
    expect((await find(app, deck.docId, 'ZEBRACHART')).hits.length).toBe(0);
    expect((await find(app, deck.docId, 'unavailable')).hits.length).toBe(1);

    const shell = await app.shellPage(deck.docId);
    await shell.locator('#allow-network').click();
    await expect.poll(async () => (await app.win(deck.docId)).networkAllowed).toBe(true);
    await expect.poll(() => deck.eval<string>("document.getElementById('chart').textContent"), { timeout: 15_000 }).toBe('Revenue by region ZEBRACHART');
    // The products are made again: Find finds the fetched word, the photo is in the thumbnail.
    await expect.poll(async () => (await find(app, deck.docId, 'ZEBRACHART')).hits.length, { timeout: 90_000 }).toBe(1);
    expect((await find(app, deck.docId, 'unavailable')).hits.length).toBe(0);
    await expect.poll(() => products(app, deck.docId), { timeout: 90_000 }).toBeGreaterThan(0.2);
  } finally {
    await app.close();
  }

  // The next open remembers Allow network (trust.json): the fresh products are the ones it uses.
  app = await launchApp({ files: [file], scratch, env, userData });
  try {
    const deck = await app.waitForDeck('net-deck.html');
    expect([(await app.win(deck.docId)).trust, (await app.win(deck.docId)).networkAllowed]).toEqual(['protected', true]);
    expect(await products(app, deck.docId)).toBeGreaterThan(0.2);
    await expect.poll(async () => (await find(app, deck.docId, 'ZEBRACHART')).hits.length, { timeout: 30_000 }).toBe(1);
  } finally {
    await app.close();
  }
});

test('a deck first built Protected, then opened Trusted at a later launch (its marker gone), has products made again under the Trusted policy (review finding 15 re-verification)', async () => {
  const dir = scratch.dir('views-products-policy-launch');
  const file = path.join(dir, 'net-deck2.html');
  fs.writeFileSync(file, deckHtml(base));
  const mdir = path.join(ROOT, 'test-results', 'views-products-policy-launch');
  fs.mkdirSync(mdir, { recursive: true, mode: 0o755 });
  const marked = path.join(mdir, 'marked.json');
  fs.writeFileSync(marked, JSON.stringify({ [fs.realpathSync(file)]: '0083;66f0a1b2;Safari;8C4E9C1E-0000-4000-8000-000000000002' }), { mode: 0o644 });
  const unmarked = path.join(mdir, 'unmarked.json');
  fs.writeFileSync(unmarked, JSON.stringify({}), { mode: 0o644 });
  scratch.own(dir);
  scratch.own(mdir);

  // Launch 1: the file carries an internet marker → Protected. The walk cannot reach the server, so the index
  // and thumbnails miss the fetched word and the photo, and they are cached by the file's bytes (sha256).
  let app = await launchApp({ files: [file], scratch, env: { BLUELINE_TEST_MARKERS: marked } });
  const userData = app.userData;
  try {
    const deck = await app.waitForDeck('net-deck2.html');
    expect((await app.win(deck.docId)).trust).toBe('protected');
    expect(await products(app, deck.docId)).toBeLessThan(0.05);
    expect((await find(app, deck.docId, 'ZEBRACHART')).hits.length).toBe(0);
    expect((await find(app, deck.docId, 'unavailable')).hits.length).toBe(1);
  } finally {
    await app.close();
  }

  // Launch 2: same userData and bytes, but the marker is gone (as after the quarantine attribute was cleared),
  // so the file opens Trusted. The cached products were made under Protected; they must not be reused. Find
  // finds the fetched word and the thumbnail shows the photo.
  app = await launchApp({ files: [file], scratch, env: { BLUELINE_TEST_MARKERS: unmarked }, userData });
  try {
    const deck = await app.waitForDeck('net-deck2.html');
    expect((await app.win(deck.docId)).trust).toBe('trusted');
    await expect.poll(async () => (await find(app, deck.docId, 'ZEBRACHART')).hits.length, { timeout: 90_000 }).toBe(1);
    expect((await find(app, deck.docId, 'unavailable')).hits.length).toBe(0);
    expect(await products(app, deck.docId)).toBeGreaterThan(0.2);
  } finally {
    await app.close();
  }
});
