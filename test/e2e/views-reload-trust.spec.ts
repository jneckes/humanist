// Trust on auto-reload (review finding 0; lead decision D-1; SPEC 6.10 When it applies and Remembered: "A new
// download saved over the same path brings a new marker, so it opens Protected again and the old decision is
// dropped"; 6.6 Reload; 9.2 Watcher). On every external change main decides 6.10 again for the file as it is on
// disk, as an open would (the marker, the folders, trust.json). When the decision differs from the window's, the
// window does not reload in place: the file opens again where it was, with a fresh docId and the partition its
// trust needs, and the new content never runs under the old trust. When nothing differs, the reload stays in
// place. Blueline's own writes never get there (knownHash).
//
// Markers come from BLUELINE_TEST_MARKERS (markers.ts testMarker, read on every call; Linux has no internet
// markers). The sink is an HTTP server on 127.0.0.1 that counts what reaches it.

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { ROOT, Scratch, launchApp, resolveRunAs, sleep, type BlApp } from '../helpers/app';
import { fileGoneText } from '../../packages/core/src/ipc-files';

test.describe.configure({ mode: 'serial' });

const scratch = new Scratch(resolveRunAs());
test.afterAll(() => scratch.cleanup());

let sink: http.Server;
let port = 0;
const hits: string[] = [];
test.beforeAll(async () => {
  sink = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    res.end('pong');
  });
  await new Promise<void>((r) => sink.listen(0, '127.0.0.1', () => r()));
  port = (sink.address() as AddressInfo).port;
});
test.afterAll(async () => {
  await new Promise<void>((r) => sink.close(() => r()));
});

/** The user's own deck: it keeps a value in its (Trusted, persistent) storage. */
const OWN = `<!doctype html><html><head><meta charset="utf-8"><title>Own</title></head><body><h1>Own deck</h1>
<script>try{localStorage.setItem('k','own-value-42')}catch(e){}document.documentElement.dataset.stored='1';</script></body></html>`;

/** What a download saved over it does: read that storage, and call the sink. */
function downloaded(tag: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Downloaded</title></head><body><h1>Downloaded ${tag}</h1>
<script>var v=null;try{v=localStorage.getItem('k')}catch(e){}document.documentElement.dataset.ls=String(v);
fetch('http://127.0.0.1:${port}/beacon-${tag}?ls='+encodeURIComponent(String(v))).then(function(){document.documentElement.dataset.net='ok'},function(){document.documentElement.dataset.net='blocked'});</script></body></html>`;
}

interface Win {
  docId: string;
  fileName: string;
  trust: string;
  trustReason: string | null;
  partition: string;
  networkAllowed: boolean;
  handshakes: number;
  reloads: number;
  state: { trustBarVisible: boolean; banner: string | null };
}

/** A folder for the deck, and a markers file (under test-results/, readable by the app's user). */
function setup(name: string): { file: string; markers: string; mark(v: string | null): void } {
  const dir = scratch.dir(name);
  const file = path.join(dir, 'deck.html');
  fs.writeFileSync(file, OWN);
  scratch.own(dir);
  const mdir = path.join(ROOT, 'test-results', 'views-reload-trust', name);
  fs.mkdirSync(mdir, { recursive: true, mode: 0o755 });
  const markers = path.join(mdir, 'markers.json');
  const real = fs.realpathSync(file);
  const mark = (v: string | null) => {
    fs.writeFileSync(markers, JSON.stringify(v === null ? {} : { [real]: v }), { mode: 0o644 });
    scratch.own(markers);
  };
  mark(null);
  scratch.own(mdir);
  return { file, markers, mark };
}

function renameReplace(file: string, text: string): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.crdownload`);
  fs.writeFileSync(tmp, text);
  scratch.own(tmp);
  fs.renameSync(tmp, file);
}

async function windowsOf(app: BlApp): Promise<Win[]> {
  return (await app.windows()) as unknown as Win[];
}

/** Waits for the file's window with a docId other than `old`, loaded, and returns it. */
async function reopened(app: BlApp, old: string): Promise<Win> {
  let found: Win | undefined;
  await expect
    .poll(
      async () => {
        found = (await windowsOf(app)).find((w) => w.fileName === 'deck.html' && w.docId !== old && w.handshakes >= 1);
        return !!found;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  return found!;
}

const sinkHits = (tag: string) => hits.filter((h) => h.startsWith(`/beacon-${tag}`));

test('an unmarked Trusted deck replaced by a marked download opens again in Protected view; the download never runs Trusted', async () => {
  const { file, markers, mark } = setup('reload-trust-a');
  const app = await launchApp({ files: [file], scratch, env: { BLUELINE_TEST_MARKERS: markers } });
  try {
    const deck = await app.waitForDeck('deck.html');
    await deck.waitFor('document.documentElement.dataset.stored === "1"');
    const before = (await windowsOf(app))[0];
    expect([before.trust, before.partition.startsWith('persist:')]).toEqual(['trusted', true]);

    mark('0083;6720f2b7;Chrome;A1');
    renameReplace(file, downloaded('a'));
    const now = await reopened(app, before.docId);
    expect(now.trust).toBe('protected');
    expect(now.trustReason).toBe('Came from the internet');
    expect(now.partition.startsWith('persist:')).toBe(false);
    expect(now.state.trustBarVisible).toBe(true);
    expect((await windowsOf(app)).map((w) => w.fileName)).toEqual(['deck.html']);
    const nd = await app.waitForDeck('deck.html', { exclude: [before.docId] });
    await nd.waitFor('document.documentElement.dataset.net');
    expect(await nd.eval<string>('document.documentElement.dataset.net')).toBe('blocked');
    // The new document's storage is its own: the old Trusted file's value is not readable.
    expect(await nd.eval<string>('document.documentElement.dataset.ls')).toBe('null');
    await sleep(1000);
    expect(sinkHits('a')).toEqual([]);
    expect(app.logsMatching(/trust changed on disk: deck\.html/).length).toBeGreaterThan(0);
    const shell = await app.shellPage(now.docId);
    await expect(shell.locator('#toast')).toContainText('opened again in Protected view');
  } finally {
    await app.close();
  }
});

test('Allow network remembered on marker A does not carry to a new download with marker B', async () => {
  const { file, markers, mark } = setup('reload-trust-b');
  mark('0083;6720f2b7;Safari;MARKER-A');
  fs.writeFileSync(file, downloaded('b0'));
  const app = await launchApp({ files: [file], scratch, env: { BLUELINE_TEST_MARKERS: markers } });
  try {
    const deck = await app.waitForDeck('deck.html');
    const shell = await app.shellPage(deck.docId);
    await shell.locator('#allow-network').click();
    await expect.poll(async () => (await windowsOf(app))[0]?.networkAllowed).toBe(true);
    const before = (await windowsOf(app))[0];
    await expect.poll(() => sinkHits('b0').length, { timeout: 15_000 }).toBeGreaterThan(0);

    mark('0083;6720f2b7;Safari;MARKER-B');
    renameReplace(file, downloaded('b1'));
    const now = await reopened(app, before.docId);
    expect([now.trust, now.networkAllowed]).toEqual(['protected', false]);
    const nd = await app.waitForDeck('deck.html', { exclude: [before.docId] });
    await nd.waitFor('document.documentElement.dataset.net');
    expect(await nd.eval<string>('document.documentElement.dataset.net')).toBe('blocked');
    await sleep(1000);
    expect(sinkHits('b1')).toEqual([]);
  } finally {
    await app.close();
  }
});

test('a marker set about 300 ms after the rename (the browser marks the file late) still opens it again Protected', async () => {
  const { file, markers, mark } = setup('reload-trust-c');
  const app = await launchApp({ files: [file], scratch, env: { BLUELINE_TEST_MARKERS: markers } });
  try {
    await app.waitForDeck('deck.html');
    const before = (await windowsOf(app))[0];
    renameReplace(file, downloaded('c'));
    await sleep(300);
    mark('0083;6720f2b7;Chrome;LATE');
    const now = await reopened(app, before.docId);
    expect(now.trust).toBe('protected');
    expect(now.trustReason).toBe('Came from the internet');
    expect(now.partition.startsWith('persist:')).toBe(false);
  } finally {
    await app.close();
  }
});

test('a file deleted and then saved again as a marked download opens again Protected', async () => {
  const { file, markers, mark } = setup('reload-trust-d');
  const app = await launchApp({ files: [file], scratch, env: { BLUELINE_TEST_MARKERS: markers } });
  try {
    await app.waitForDeck('deck.html');
    const before = (await windowsOf(app))[0];
    fs.rmSync(file);
    await expect.poll(async () => (await windowsOf(app))[0]?.state.banner, { timeout: 10_000 }).toBe(fileGoneText('deck.html'));
    // The same realpath again, now with a marker.
    mark('0083;6720f2b7;Chrome;BACK');
    fs.writeFileSync(file, downloaded('d'));
    scratch.own(file);
    const now = await reopened(app, before.docId);
    expect(now.trust).toBe('protected');
    expect(now.state.banner).toBeNull();
    await sleep(1000);
    expect(sinkHits('d')).toEqual([]);
  } finally {
    await app.close();
  }
});

test('an overwrite in place (the same inode) with a new marker opens it again Protected', async () => {
  const { file, markers, mark } = setup('reload-trust-e');
  const app = await launchApp({ files: [file], scratch, env: { BLUELINE_TEST_MARKERS: markers } });
  try {
    await app.waitForDeck('deck.html');
    const before = (await windowsOf(app))[0];
    const ino = fs.statSync(file).ino;
    mark('0083;6720f2b7;Chrome;INPLACE');
    fs.writeFileSync(file, downloaded('e'));
    expect(fs.statSync(file).ino).toBe(ino);
    const now = await reopened(app, before.docId);
    expect(now.trust).toBe('protected');
    await sleep(1000);
    expect(sinkHits('e')).toEqual([]);
  } finally {
    await app.close();
  }
});

test('controls: an unmarked file replaced by another unmarked one reloads in place; Blueline\'s own write neither reloads nor reopens', async () => {
  const { file, markers } = setup('reload-trust-control');
  const app = await launchApp({ files: [file], scratch, env: { BLUELINE_TEST_MARKERS: markers } });
  try {
    await app.waitForDeck('deck.html');
    const before = (await windowsOf(app))[0];
    renameReplace(file, OWN.replace('Own deck', 'Own deck, revised'));
    await expect.poll(async () => (await windowsOf(app))[0]?.handshakes, { timeout: 15_000 }).toBe(before.handshakes + 1);
    await sleep(1200);
    const after = await windowsOf(app);
    expect(after.map((w) => [w.docId, w.trust, w.reloads])).toEqual([[before.docId, 'trusted', 1]]);

    await app.electronApp.evaluate(
      async (_e, a) => (globalThis as unknown as { __blTest: { ownWrite(d: string, t: string): Promise<void> } }).__blTest.ownWrite(a.id, a.text),
      { id: before.docId, text: OWN.replace('Own deck', 'Own deck, written by Blueline') },
    );
    await sleep(2000);
    const last = await windowsOf(app);
    expect(last.map((w) => [w.docId, w.handshakes, w.reloads])).toEqual([[before.docId, before.handshakes + 1, 1]]);
  } finally {
    await app.close();
  }
});
