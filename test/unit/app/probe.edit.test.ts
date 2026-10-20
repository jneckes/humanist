// The mutation probe's loads and batches through the real patcher (SPEC section 10, Mutation probe steps 3-4;
// review finding 30; PHASE0-FINDINGS F13): every load gets a fresh origin, and one load checks many runs, each with
// its own sentinel. Split from probe.test.ts so the reader-only unit suite (P2-15), which has no @blueline/editor,
// keeps probe.test.ts's editor-free cases: *.edit.test.ts files are left out of it. Electron is mocked.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

vi.mock('electron', () => ({
  app: { getName: () => 'Blueline', getVersion: () => '0.0.0', getPath: () => os.tmpdir(), on() {}, once() {}, removeListener() {} },
  BrowserWindow: class {},
  WebContentsView: class {},
  ipcMain: { on() {}, handle() {} },
  protocol: { registerSchemesAsPrivileged() {} },
  session: { fromPartition: () => ({}) },
  nativeTheme: { shouldUseDarkColors: false },
  Menu: {},
  dialog: {},
  shell: {},
}));

import type { EditorModule } from '@blueline/core/capabilities';
import type { FindResult, LocateResult, NodeLocator } from '@blueline/core/ipc';
import { buildMap } from '@blueline/core/mapper';
import { createMatcher } from '@blueline/core/matcher';
import { decodeDeck, encodeDeck } from '@blueline/core/text';
import { createWriteQueue } from '@blueline/editor';
import { sha256Hex } from '../../../packages/app/src/main/atomic-write';
import { ProbeCopy, SENTINEL, batchSentinel, locatorKey, normalizeConsoleMessage, runProbe } from '../../../packages/app/src/main/probe';
import type { CountedNode } from '../../../packages/app/src/main/report';
import type { RenderView } from '../../../packages/app/src/main/render-service';

// ------------------------------------------------------------------------------------------- fresh origins

describe('every probe load gets a fresh origin (review finding 30; PHASE0-FINDINGS F13)', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-probe-origin-'));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const SRC = '<!doctype html>\n<html><head><title>T</title></head><body>\n<h1>One</h1>\n<p>Two</p>\n<p>Three</p>\n</body></html>\n';
  const bytes = encodeDeck(SRC);
  const version = sha256Hex(bytes);
  const editor: EditorModule = { editorVersion: 'test', createWriteQueue };

  it('loads the copy under a new docId for every run, each one served by the copy and normalized in console messages', async () => {
    const copy = await ProbeCopy.create({ folderReal: dir, fileName: 'deck.html', bytes, trust: () => 'trusted', networkAllowed: () => false, servedProtected: () => false }, '0123456789abcdef');
    const map = buildMap(decodeDeck(bytes).src, { version, utf8: true });
    const matcher = createMatcher(map, { fileName: 'deck.html' });
    const nodes: CountedNode[] = map.runs.map((r, i) => {
      const dn = { stamp: r.stamp, textIndex: r.textIndex, data: r.value, texts: [r.value] };
      return { key: i + 1, slide: 0, stop: 0, locator: { stamp: r.stamp, cssPath: `[data-bl-e="${r.stamp}"]`, childIndex: 0 }, node: dn, match: matcher(dn) };
    });
    const loads: string[] = [];
    let runs: { loc: NodeLocator; data: string }[] = [];
    const view = {
      async load(t: { docId: string; fileName: string }) {
        loads.push(t.docId);
        const m = buildMap(decodeDeck(await copy.read()).src, { version: 'x', utf8: true });
        runs = m.runs.map((r) => ({ loc: { stamp: r.stamp, cssPath: `[data-bl-e="${r.stamp}"]`, childIndex: 0 }, data: r.value }));
      },
      async waitStable() {
        return { fontsReady: true, stillRunning: 0 };
      },
      async detect() {
        return { kind: 'single', count: 1, current: 0, titles: ['T'], navKind: 'none', designSize: { w: 1600, h: 900 } };
      },
      async find(needle: string): Promise<FindResult> {
        return { truncated: false, matches: runs.filter((r) => r.data.includes(needle)).map((r, i) => ({ key: i, locator: r.loc, node: { stamp: r.loc.stamp, textIndex: 0, data: r.data }, visible: true, slide: 0 })) };
      },
      async locate(loc: NodeLocator): Promise<LocateResult> {
        const r = runs.find((x) => locatorKey(x.loc) === locatorKey(loc));
        return r ? { found: true, node: { key: 1, locator: loc, node: { stamp: loc.stamp, textIndex: 0, data: r.data }, rect: { x: 0, y: 0, w: 1, h: 1 } }, visible: true, slide: 0 } : { found: false, node: null, visible: false, slide: null };
      },
      consoleErrors() {
        return [];
      },
    } as unknown as RenderView;
    try {
      const r = await runProbe({
        view,
        editor,
        copy,
        original: { bytes, version },
        nodes,
        slideCount: 1,
        baselineErrors: new Set(),
        normalize: (e) => e.message,
        start: async () => undefined,
        replay: async () => true,
        log: () => undefined,
        interrupted: () => false,
        newDocId: () => randomBytes(8).toString('hex'),
        batchSize: 1,
      });
      expect(r.runs).toBe(3);
      expect(nodes.every((n) => n.probe?.pass === true)).toBe(true);
      // One load per run, each on its own origin: no localStorage, sessionStorage or IndexedDB carries over.
      expect(loads).toHaveLength(3);
      expect(new Set(loads).size).toBe(3);
      expect(loads).not.toContain(copy.docId);
      for (const id of loads) expect(copy.servesDocId(id)).toBe(true);
      expect(copy.servesDocId('fedcba9876543210')).toBe(false);
      // The protocol handler serves a document only under its own docId: each load id gets a view of the copy.
      for (const id of loads) expect(copy.servedAs(id)).toMatchObject({ docId: id, fileName: copy.fileName, folderReal: copy.folderReal });
      expect(copy.servedAs(copy.docId)).toBe(copy);
      expect(copy.servedAs('fedcba9876543210')).toBeUndefined();
      expect(new TextDecoder().decode((await copy.servedAs(loads[0])!.documentBody()).body)).toContain('data-bl-e="bl-1"');
      expect(copy.docIds).toEqual([copy.docId, ...loads]);
      const msg = (id: string) => `Uncaught TypeError at blueline://${id}/.deck.bl-probe.html:3`;
      const norm = (s: string) => normalizeConsoleMessage(s, { docIds: copy.docIds, rename: [[copy.fileName, 'deck.html']] });
      expect(new Set(loads.map((id) => norm(msg(id)))).size).toBe(1);
    } finally {
      copy.removeSync();
    }
  });
});

// ------------------------------------------------------------------------------------------- batches

describe('probe batches: one load for many runs, each run with its own sentinel', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-probe-batch-'));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const SRC = '<!doctype html>\n<html><head><title>T</title></head><body>\n<h1>One</h1>\n<p>Two</p>\n<p>Three</p>\n</body></html>\n';
  const bytes = encodeDeck(SRC);
  const version = sha256Hex(bytes);
  const editor: EditorModule = { editorVersion: 'test', createWriteQueue };

  /** A fake render view over the copy; `mangle` changes what the page shows after a load. */
  async function probe(name: string, mangle: (runs: { loc: NodeLocator; data: string }[]) => void) {
    const copy = await ProbeCopy.create({ folderReal: dir, fileName: `${name}.html`, bytes, trust: () => 'trusted', networkAllowed: () => false, servedProtected: () => false }, randomBytes(8).toString('hex'));
    const map = buildMap(decodeDeck(bytes).src, { version, utf8: true });
    const matcher = createMatcher(map, { fileName: `${name}.html` });
    const nodes: CountedNode[] = map.runs.map((r, i) => {
      const dn = { stamp: r.stamp, textIndex: r.textIndex, data: r.value, texts: [r.value] };
      return { key: i + 1, slide: 0, stop: 0, locator: { stamp: r.stamp, cssPath: `[data-bl-e="${r.stamp}"]`, childIndex: 0 }, node: dn, match: matcher(dn) };
    });
    const loads: string[] = [];
    let runs: { loc: NodeLocator; data: string }[] = [];
    const view = {
      async load(t: { docId: string; fileName: string }) {
        loads.push(t.docId);
        const m = buildMap(decodeDeck(await copy.read()).src, { version: 'x', utf8: true });
        runs = m.runs.map((r) => ({ loc: { stamp: r.stamp, cssPath: `[data-bl-e="${r.stamp}"]`, childIndex: 0 }, data: r.value }));
        mangle(runs);
      },
      async waitStable() {
        return { fontsReady: true, stillRunning: 0 };
      },
      async detect() {
        return { kind: 'single', count: 1, current: 0, titles: ['T'], navKind: 'none', designSize: { w: 1600, h: 900 } };
      },
      async find(needle: string): Promise<FindResult> {
        return { truncated: false, matches: runs.filter((r) => r.data.includes(needle)).map((r, i) => ({ key: i, locator: r.loc, node: { stamp: r.loc.stamp, textIndex: 0, data: r.data }, visible: true, slide: 0 })) };
      },
      async locate(loc: NodeLocator): Promise<LocateResult> {
        const r = runs.find((x) => locatorKey(x.loc) === locatorKey(loc));
        return r ? { found: true, node: { key: 1, locator: loc, node: { stamp: loc.stamp, textIndex: 0, data: r.data }, rect: { x: 0, y: 0, w: 1, h: 1 } }, visible: true, slide: 0 } : { found: false, node: null, visible: false, slide: null };
      },
      consoleErrors() {
        return [];
      },
    } as unknown as RenderView;
    try {
      const r = await runProbe({
        view,
        editor,
        copy,
        original: { bytes, version },
        nodes,
        slideCount: 1,
        baselineErrors: new Set(),
        normalize: (e) => e.message,
        start: async () => undefined,
        replay: async () => true,
        log: () => undefined,
        interrupted: () => false,
        newDocId: () => randomBytes(8).toString('hex'),
      });
      const after = await copy.read();
      return { r, nodes, loads, restored: Buffer.from(after).equals(Buffer.from(bytes)) };
    } finally {
      copy.removeSync();
    }
  }

  it('gives each run of a batch a sentinel no other contains', () => {
    const s = Array.from({ length: 30 }, (_, j) => batchSentinel(j));
    expect(new Set(s).size).toBe(30);
    for (const a of s) for (const b of s) if (a !== b) expect(b.includes(a)).toBe(false);
    for (const a of s) expect(a.includes(SENTINEL)).toBe(false);
  });

  it('checks three runs on one load, then undoes every write', async () => {
    const { r, nodes, loads, restored } = await probe('batch-pass', () => undefined);
    expect(nodes.every((n) => n.probe?.pass === true)).toBe(true);
    expect(loads).toHaveLength(1);
    expect(r.runs).toBe(3);
    expect(restored).toBe(true);
  });

  it('a write that lands in another node fails on the batch and again on its own', async () => {
    // The page shows the first two runs' texts swapped: each sentinel lands in the other node.
    const { nodes, loads, restored } = await probe('batch-swap', (runs) => {
      if (runs.length >= 2) [runs[0].data, runs[1].data] = [runs[1].data, runs[0].data];
    });
    expect(nodes[0].probe?.pass).toBe(false);
    expect(nodes[1].probe?.pass).toBe(false);
    expect(nodes[2].probe?.pass).toBe(true);
    // One batch load, then one load for each run that failed on it.
    expect(loads).toHaveLength(3);
    const v0 = nodes[0].probe;
    expect(v0 && !v0.pass ? v0.why : '').toMatch(/sentinel/);
    expect(restored).toBe(true);
  });
});
