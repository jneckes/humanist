// The mutation probe of `blueline map` through the real patcher (section 10, Phase 0 mutation probe; 9.2 Undo
// and redo): ProbeCopy and runProbe with the editor's write queue. Split from report.test.ts so the reader-only
// unit suite (P2-15), which has no @blueline/editor, keeps report.test.ts's editor-free cases: *.edit.test.ts files
// are left out of it. Electron is mocked: the real-Electron runs are test/e2e/map*.spec.ts.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
import { ProbeCopy, ProbeRefused, locatorKey, runProbe } from '../../../packages/app/src/main/probe';
import type { CountedNode } from '../../../packages/app/src/main/report';
import type { RenderView } from '../../../packages/app/src/main/render-service';

describe('ProbeCopy and runProbe (through the real patcher)', () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-probe-test-'));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  // A BOM, CRLF, character references and a JSON block: undo must restore every byte (9.2 Undo and redo).
  const SRC =
    '﻿<!doctype html>\r\n<html><head><title>T</title></head><body>\r\n' +
    '<h1>R&amp;D &mdash; plan</h1>\r\n<p>Costs&nbsp;rose 4&nbsp;%.</p>\r\n<p>Same</p>\r\n' +
    '<script type="application/json" id="d">{"label": "Caf\\u00e9 \\u2014 menu"}</script>\r\n</body></html>\r\n';
  const bytes = encodeDeck(SRC);
  const version = sha256Hex(bytes);

  function original() {
    return { folderReal: dir, fileName: 'deck.html', bytes, trust: () => 'trusted' as const, networkAllowed: () => false, servedProtected: () => false };
  }

  it('creates the hidden copy next to the deck, private, and refuses to overwrite one', async () => {
    const c = await ProbeCopy.create(original(), '0123456789abcdef');
    expect(c.path).toBe(path.join(dir, '.deck.bl-probe.html'));
    expect(Buffer.compare(fs.readFileSync(c.path), Buffer.from(bytes))).toBe(0);
    if (process.platform !== 'win32') expect(fs.statSync(c.path).mode & 0o777).toBe(0o600);
    await expect(ProbeCopy.create(original(), 'fedcba9876543210')).rejects.toBeInstanceOf(ProbeRefused);
    const served = new TextDecoder().decode((await c.documentBody()).body);
    expect(served).toContain('data-bl-e="bl-');
    expect(c.trust()).toBe('trusted');
    expect(c.removeSync()).toBe(true);
    expect(fs.existsSync(c.path)).toBe(false);
    expect(c.removeSync()).toBe(true);
  });

  it('refuses a symlink planted at the copy path and never writes through it', async () => {
    if (process.platform === 'win32') return;
    const target = path.join(dir, 'victim.txt');
    fs.writeFileSync(target, 'keep');
    fs.symlinkSync(target, path.join(dir, '.deck.bl-probe.html'));
    await expect(ProbeCopy.create(original(), '0123456789abcdef')).rejects.toBeInstanceOf(ProbeRefused);
    expect(fs.readFileSync(target, 'utf8')).toBe('keep');
    fs.unlinkSync(path.join(dir, '.deck.bl-probe.html'));
  });

  /**
   * A stand-in render view whose "DOM" is the probe copy as the mapper reads it: one text node per run,
   * located by {stamp or literal id, textIndex}. Enough to drive runProbe end to end with the real patcher.
   */
  function fakeView(copy: ProbeCopy): RenderView {
    let runs: { loc: NodeLocator; data: string }[] = [];
    const v = {
      async load() {
        const d = decodeDeck(await copy.read());
        const m = buildMap(d.src, { version: 'x', utf8: d.utf8 });
        runs = [
          ...m.runs.map((r) => ({ loc: { stamp: r.stamp, cssPath: `[data-bl-e="${r.stamp}"]`, childIndex: r.textIndex }, data: r.value })),
          ...m.literals.map((l) => ({ loc: { stamp: null, cssPath: `#lit-${l.unit}`, childIndex: l.runIndex }, data: l.value })),
        ];
      },
      async waitStable() {
        return { fontsReady: true, stillRunning: 0 };
      },
      async detect() {
        return { kind: 'single', count: 1, current: 0, titles: ['T'], navKind: 'none', designSize: { w: 1600, h: 900 } };
      },
      async find(needle: string): Promise<FindResult> {
        return { truncated: false, matches: runs.filter((r) => r.data.includes(needle)).map((r, i) => ({ key: i, locator: r.loc, node: { stamp: r.loc.stamp, textIndex: r.loc.childIndex, data: r.data }, visible: true, slide: 0 })) };
      },
      async locate(loc: NodeLocator): Promise<LocateResult> {
        const r = runs.find((x) => locatorKey(x.loc) === locatorKey(loc));
        return r ? { found: true, node: { key: 1, locator: loc, node: { stamp: loc.stamp, textIndex: loc.childIndex, data: r.data }, rect: { x: 0, y: 0, w: 1, h: 1 } }, visible: true, slide: 0 } : { found: false, node: null, visible: false, slide: null };
      },
      consoleErrors() {
        return [];
      },
    };
    return v as unknown as RenderView;
  }

  function countedNodes(): CountedNode[] {
    const map = buildMap(decodeDeck(bytes).src, { version, utf8: true });
    const matcher = createMatcher(map, { fileName: 'deck.html' });
    const out: CountedNode[] = [];
    let key = 1;
    for (const r of map.runs) {
      // The walk sends the element's live non-whitespace text nodes (DomTextNode.texts, decision D-b); here
      // they are the stamp's source runs, as the served copy shows them.
      const texts = map.runs.filter((x) => x.stamp === r.stamp).sort((a, b) => a.textIndex - b.textIndex).map((x) => x.value);
      const dn = { stamp: r.stamp, textIndex: r.textIndex, data: r.value, texts };
      out.push({ key: key++, slide: 0, stop: 0, locator: { stamp: r.stamp, cssPath: `[data-bl-e="${r.stamp}"]`, childIndex: r.textIndex }, node: dn, match: matcher(dn) });
    }
    for (const l of map.literals) {
      const dn = { stamp: null, textIndex: 0, data: l.value };
      out.push({ key: key++, slide: 0, stop: 0, locator: { stamp: null, cssPath: `#lit-${l.unit}`, childIndex: l.runIndex }, node: dn, match: matcher(dn) });
    }
    return out;
  }

  const editor: EditorModule = { editorVersion: 'test', createWriteQueue };

  async function probe(nodes: CountedNode[]) {
    const copy = await ProbeCopy.create(original(), '0123456789abcdef');
    try {
      const r = await runProbe({
        view: fakeView(copy),
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
      });
      const after = new Uint8Array(fs.readFileSync(copy.path));
      return { r, after };
    } finally {
      copy.removeSync();
    }
  }

  it('appends the sentinel to every exact run, checks it, and undoes to the original bytes', async () => {
    const nodes = countedNodes();
    const exactNodes = nodes.filter((n) => n.match.confidence === 'exact');
    expect(exactNodes.length).toBeGreaterThanOrEqual(4);
    const { r, after } = await probe(nodes);
    expect(r.aborted).toBeNull();
    expect(r.runs).toBe(new Set(exactNodes.map((n) => n.match.runId)).size);
    for (const n of exactNodes) expect(n.probe).toEqual({ pass: true });
    expect(Buffer.compare(Buffer.from(after), Buffer.from(bytes))).toBe(0);
    expect(fs.readdirSync(dir).filter((f) => f.includes('bl-probe') || f.startsWith('.bl-write-'))).toEqual([]);
  });

  it('fails a node whose reported run is not where its text lives (a write to the wrong place)', async () => {
    const nodes = countedNodes();
    const h1 = nodes.find((n) => n.node.data.startsWith('R&D'))!;
    const p = nodes.find((n) => n.node.data.startsWith('Costs'))!;
    // Pretend the matcher mapped the heading to the paragraph's run.
    const lie: CountedNode = { ...h1, key: 999, node: { ...h1.node, data: p.node.data }, match: p.match };
    const { after } = await probe([...nodes, lie]);
    expect(lie.probe).toMatchObject({ pass: false, why: expect.stringContaining('not in the node') });
    expect(p.probe).toEqual({ pass: true });
    expect(Buffer.compare(Buffer.from(after), Buffer.from(bytes))).toBe(0);
  });

  it('fails every node of a run the patcher refuses, and leaves the copy as it was', async () => {
    const nodes = countedNodes().filter((n) => n.match.confidence === 'exact').slice(0, 1);
    // A beforeText that is not the run's text: the patcher's re-check refuses (9.2 Write protocol step 3).
    nodes[0] = { ...nodes[0], node: { ...nodes[0].node, data: 'not the run text' } };
    const { after } = await probe(nodes);
    expect(nodes[0].probe).toMatchObject({ pass: false, why: expect.stringContaining('patcher did not write') });
    expect(Buffer.compare(Buffer.from(after), Buffer.from(bytes))).toBe(0);
  });
});
