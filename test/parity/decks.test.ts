// Which decks the harness runs, and the D-labels that keep Josh's deck names out of everything it writes
// (harness/decks.ts).
import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { committedDecks, localDecks, parseDeckLabels, redactor, selectDecks } from './harness/decks';

const ROOT = path.resolve(__dirname, '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-parity-decks-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('deck lists', () => {
  it('committed decks: fixtures/decks, reveal-hash and fixtures/render, labelled by path', () => {
    const labels = committedDecks(ROOT).map((d) => d.label);
    expect(labels).toContain('decks/generic-index.html');
    expect(labels).toContain('decks/reveal-hash/index.html');
    expect(labels).toContain('render/page-css.html');
    expect(committedDecks(ROOT).every((d) => !d.local && path.isAbsolute(d.file))).toBe(true);
    // The ArrowDown-only fixture carries the keys the visible view would record.
    expect(committedDecks(ROOT).find((d) => d.label === 'render/arrowdown.html')?.deckNav).toEqual({ forward: 'ArrowDown', back: 'ArrowUp' });
  });

  it('local decks get their DECKS.md label, or local-<n>, never their name', () => {
    const root = path.join(tmp, 'repo');
    const local = path.join(root, 'fixtures/local');
    fs.mkdirSync(local, { recursive: true });
    for (const f of ['client-b.html', 'client-a.html', 'unlisted.html']) fs.writeFileSync(path.join(local, f), '<p>x</p>');
    fs.writeFileSync(path.join(local, 'DECKS.md'), '# Labels\n\n- D2: client-b.html\n- D10: client-a.html\n');
    const decks = localDecks(root);
    expect(decks.map((d) => d.label)).toEqual(['D2', 'D10', 'local-1']);
    expect(decks.every((d) => d.local)).toBe(true);
  });

  it('parses DECKS.md lines', () => {
    expect([...parseDeckLabels('- D1: a b.html\n* d12 : x.htm\nnot a line\n- E1: y.html').entries()]).toEqual([
      ['a b.html', 'D1'],
      ['x.htm', 'D12'],
    ]);
  });

  it('redacts local file names and paths in log lines', () => {
    const file = path.join(tmp, 'Secret Client Deck.html');
    fs.writeFileSync(file, '');
    const r = redactor([{ label: 'D7', file, local: true }]);
    expect(r(`slide index: Secret Client Deck.html: generic; ${file}; Secret%20Client%20Deck.html`)).toBe('slide index: D7: generic; D7; D7');
    // Committed decks are left alone.
    expect(redactor([{ label: 'decks/x.html', file: '/r/x.html', local: false }])('x.html')).toBe('x.html');
  });

  it('selects by label or path, and names a deck outside the repository by its base name', () => {
    const all = committedDecks(ROOT);
    expect(selectDecks(all, ['decks/report.html'], ROOT)[0].file).toBe(path.join(ROOT, 'fixtures/decks/report.html'));
    expect(selectDecks(all, [path.join(ROOT, 'fixtures/decks/single.html')], ROOT)[0].label).toBe('decks/single.html');
    const outside = path.join(tmp, 'other.html');
    fs.writeFileSync(outside, '');
    expect(selectDecks(all, [outside], ROOT)[0].label).toBe('other.html');
    expect(() => selectDecks(all, ['no/such.html'], ROOT)).toThrow(/no such deck/);
  });
});
