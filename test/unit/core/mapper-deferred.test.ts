// The deferred map (review finding 31; SPEC 10 Phase 1, Speed: "a 2 MB deck reaches first paint in under 1 s"):
// buildMap returns once Strategy 1 is done, and Strategy 2 (script and JSON literals, object keys, their shadow
// values) runs on the first read of any field it completes. The served copy and the content hash need only
// Strategy 1, so the deck view can navigate first. The map must still always be complete when read: toClientMap,
// the served copy, the shadow values and the keys are exactly the eager build's, on every committed fixture.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { buildMap, completeMap, DEFERRED_MAP_FIELDS, isMapComplete, toClientMap } from '@blueline/core/mapper';
import { createMatcher } from '@blueline/core/matcher';
import { buildServedCopy } from '@blueline/core/served';
import { decodeDeck } from '@blueline/core/text';
import type { DeckMap } from '@blueline/core/types';

// Counts Strategy 2 runs, and can make one throw; otherwise the real extractLiterals.
const strategy2 = vi.hoisted(() => ({ calls: 0, fail: null as Error | null }));
vi.mock('@blueline/core/mapper-literals', async (importOriginal) => {
  const real = await importOriginal<typeof import('@blueline/core/mapper-literals')>();
  return {
    ...real,
    extractLiterals: (...args: Parameters<typeof real.extractLiterals>) => {
      strategy2.calls++;
      if (strategy2.fail) throw strategy2.fail;
      return real.extractLiterals(...args);
    },
  };
});

const ROOT = path.resolve(__dirname, '../../..');

/** Every committed HTML fixture (fixtures/**, the parity fixtures and the sample deck), as bytes. */
function committedDecks(): { name: string; bytes: Uint8Array }[] {
  const out: { name: string; bytes: Uint8Array }[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'local' && e.name !== 'out' && e.name !== 'expected') walk(p);
      } else if (/\.html?$/.test(e.name) && !e.name.includes('.bl-probe.')) out.push({ name: path.relative(ROOT, p), bytes: new Uint8Array(fs.readFileSync(p)) });
    }
  };
  walk(path.join(ROOT, 'fixtures'));
  walk(path.join(ROOT, 'test/parity/fixtures'));
  walk(path.join(ROOT, 'packages/app/assets/sample'));
  return out;
}

function both(bytes: Uint8Array): { src: string; utf8: boolean; lazy: DeckMap; eager: DeckMap } {
  const d = decodeDeck(bytes);
  const version = createHash('sha256').update(bytes).digest('hex');
  return { src: d.src, utf8: d.utf8, lazy: buildMap(d.src, { version, utf8: d.utf8 }), eager: buildMap(d.src, { version, utf8: d.utf8, defer: false }) };
}

/** A deck with inline scripts (literals, keys, numbers, a tagged template) and a notes block. */
const SCRIPTED = `<!DOCTYPE html><html><head><title>Q3</title></head><body>
<section class="slide"><h1 id="t">Quarterly review</h1><p data-kpi="Retention">Retention</p><span id="n"></span></section>
<script>
  var KPI = { Retention: 0.92, "Net revenue": 1200 };
  document.getElementById('n').textContent = 'Net revenue';
  var html = String.raw\`<b>Bold claim</b>\`;
  const label = \`Quarter \${3}\`;
</script>
<script type="application/json" id="data">{"title": "Board pack", "rows": [1, 2, 3]}</script>
<script type="application/vnd.blueline+json" id="blueline-notes">{"notes":[]}</script>
</body></html>`;

describe('buildMap: Strategy 2 deferred to the first read', () => {
  it('builds the served copy and reads the Strategy 1 fields without running Strategy 2', () => {
    strategy2.calls = 0;
    const map = buildMap(SCRIPTED, { version: 'v', utf8: true });
    expect(strategy2.calls).toBe(0);
    expect(isMapComplete(map)).toBe(false);
    // What the protocol handler and the content hash read (9.1 Serving; documents.ts contentHashOf).
    const served = buildServedCopy(SCRIPTED, map, { protected: false });
    buildServedCopy(SCRIPTED, map, { protected: true });
    void [map.version, map.utf8, map.bom, map.lineEnding, map.notesBlock, map.stampCount, map.runs, map.parseErrors, map.served];
    expect(map.notesBlock).not.toBeNull();
    expect(served).toContain('data-bl-e="bl-1"');
    expect(strategy2.calls).toBe(0);
    expect(isMapComplete(map)).toBe(false);
  });

  it('completes every deferred field at the first read of any of them, once', () => {
    for (const field of DEFERRED_MAP_FIELDS) {
      strategy2.calls = 0;
      const map = buildMap(SCRIPTED, { version: 'v', utf8: true });
      void map[field];
      expect(strategy2.calls, field).toBe(1);
      expect(isMapComplete(map)).toBe(true);
      for (const k of DEFERRED_MAP_FIELDS) {
        // Plain data properties from then on.
        expect(Object.getOwnPropertyDescriptor(map, k), k).toMatchObject({ writable: true, enumerable: true });
        void map[k];
      }
      expect(strategy2.calls).toBe(1);
    }
  });

  it('is complete for everything that reads a whole map: toClientMap, the matcher, spread, JSON and structuredClone', () => {
    const eager = buildMap(SCRIPTED, { version: 'v', utf8: true, defer: false });
    expect(isMapComplete(eager)).toBe(true);
    expect(toClientMap(buildMap(SCRIPTED, { version: 'v', utf8: true }))).toEqual(toClientMap(eager));
    expect({ ...buildMap(SCRIPTED, { version: 'v', utf8: true }) }).toEqual({ ...eager });
    expect(JSON.parse(JSON.stringify(buildMap(SCRIPTED, { version: 'v', utf8: true })))).toEqual(JSON.parse(JSON.stringify(eager)));
    expect(structuredClone(buildMap(SCRIPTED, { version: 'v', utf8: true }))).toEqual(structuredClone(eager));
    const node = { stamp: null, textIndex: 0, data: 'Net revenue' };
    expect(createMatcher(buildMap(SCRIPTED, { version: 'v', utf8: true }))(node)).toEqual(createMatcher(eager)(node));
    expect(completeMap(buildMap(SCRIPTED, { version: 'v', utf8: true }))).toEqual(eager);
    // The key order is the eager map's too (a map written out as JSON reads the same).
    expect(Object.keys(buildMap(SCRIPTED, { version: 'v', utf8: true }))).toEqual(Object.keys(eager));
  });

  it('keeps a deferred field assigned before the first read', () => {
    const map = buildMap(SCRIPTED, { version: 'v', utf8: true });
    map.keyValues = ['assigned'];
    expect(map.keyValues).toEqual(['assigned']);
    expect(map.literals.length).toBeGreaterThan(0);
    expect(map.keyValues).toEqual(['assigned']);
  });

  it('throws Strategy 2 errors at every read of a deferred field, as the eager build threw them', () => {
    strategy2.fail = new Error('strategy 2 failed');
    try {
      expect(() => buildMap(SCRIPTED, { version: 'v', utf8: true, defer: false })).toThrow('strategy 2 failed');
      const map = buildMap(SCRIPTED, { version: 'v', utf8: true });
      expect(() => map.literals).toThrow('strategy 2 failed');
      expect(() => toClientMap(map)).toThrow('strategy 2 failed');
      expect(isMapComplete(map)).toBe(false);
      // The served copy never needed it.
      expect(buildServedCopy(SCRIPTED, map, { protected: false })).toContain('data-bl-e');
    } finally {
      strategy2.fail = null;
    }
  });

  it('gives a deck that is not UTF-8 the same empty Strategy 2 fields', () => {
    const bytes = new Uint8Array([...new TextEncoder().encode('<p>caf'), 0xe9, ...new TextEncoder().encode('</p><script>var a = "x";</script>')]);
    const { lazy, eager, utf8 } = both(bytes);
    expect(utf8).toBe(false);
    expect(lazy).toEqual(eager);
    expect(lazy.literals).toEqual([]);
    expect(lazy.shadows).toEqual([]);
  });
});

describe('buildMap: the deferred map equals the eager one on every committed fixture', () => {
  const decks = committedDecks();

  it('finds the committed fixtures', () => {
    expect(decks.length).toBeGreaterThan(60);
  });

  it('toClientMap, the served copies, shadow values, keys and the whole map are the same', () => {
    for (const { name, bytes } of decks) {
      const { src, utf8, lazy, eager } = both(bytes);
      // The served copies first, while the deferred map has not run Strategy 2.
      expect(buildServedCopy(src, lazy, { protected: false }), name).toBe(buildServedCopy(src, eager, { protected: false }));
      expect(buildServedCopy(src, lazy, { protected: true }), name).toBe(buildServedCopy(src, eager, { protected: true }));
      expect(isMapComplete(lazy), name).toBe(false);
      if (utf8) expect(toClientMap(lazy), name).toEqual(toClientMap(eager));
      expect(lazy.shadows, name).toEqual(eager.shadows);
      expect(lazy.keys, name).toEqual(eager.keys);
      expect(lazy.keyValues, name).toEqual(eager.keyValues);
      expect(lazy, name).toEqual(eager);
    }
  });
});
