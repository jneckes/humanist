// session.json (9.7; 6.8 One writer): atomic writes, defensive reads that never lose a note.
// Phase 2: SourceLoc on targets, locked spans checked field by field, the last known version (P2-12).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Note, Session } from '@blueline/core/types';
import { NotesStore } from '../../../packages/app/src/main/notes';
import { SessionStore, emptySession, learnDeckNav, readLocked, readNote, readSession, readSource, sessionFileFor } from '../../../packages/app/src/main/session-store';

let ud: string;
const DECK: Session['deck'] = { path: '/d/deck.html', realpath: '/d/deck.html', fileKey: '0123456789abcdef', sha256: 'f'.repeat(64), title: 'Deck' };
const note = (over: Partial<Note> = {}): Note => ({
  id: 'n-0001',
  kind: 'markup',
  status: 'open',
  author: 'josh-ab12',
  createdAt: '2026-10-15T10:00:00.000Z',
  updatedAt: '2026-10-15T10:00:00.000Z',
  pass: null,
  slide: { index: 0, id: null, title: 'Intro', nav: { kind: 'reveal', value: [0, 0] } },
  targets: [{ ref: 't1', selectors: [{ type: 'CssSelector', value: '#h' }], box: { x: 0, y: 0, w: 1, h: 1 }, role: 'heading', text: 'H' }],
  marks: [{ n: 1, tool: 'pen', shape: 'ellipse', path: 'M0 0', targets: ['t1'] }],
  text: 'tighten',
  recordings: [],
  thread: [],
  ...over,
});

beforeAll(() => {
  ud = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-session-'));
});
afterAll(() => fs.rmSync(ud, { recursive: true, force: true }));

describe('sessionFileFor', () => {
  it('<userData>/files/<fileKey>/session.json, fileKey checked', () => {
    expect(sessionFileFor('/ud', '0123456789abcdef')).toBe(path.join('/ud', 'files', '0123456789abcdef', 'session.json'));
    expect(() => sessionFileFor('/ud', '../../etc')).toThrow();
  });
});

describe('readSession', () => {
  it('round-trips a full session', () => {
    const s: Session = {
      ...emptySession(DECK),
      people: [{ id: 'josh-ab12', name: 'Josh', color: '#2563eb' }],
      notes: [note({ verbatim: { before: 'a', after: 'b' }, instruction: 'i', summary: 's', thread: [{ from: 'agent', text: 'q?', at: 't' }] })],
      locked: [{ start: 1, end: 4, text: 'abc', noteId: 'n-0001', state: 'ok' }],
      passes: [{ n: 1, sentAt: 't', snapshot: 'passes/1/snapshot.html' }],
      tombstones: ['n-0002'],
      deckNav: { forward: 'ArrowRight', back: 'ArrowLeft' },
      viewport: { w: 1600, h: 900, dpr: 2 },
      settings: { inkFilter: 'all' },
    };
    const r = readSession(JSON.parse(JSON.stringify(s)), DECK);
    expect(r.lossy).toBe(false);
    expect(r.session).toEqual(s);
  });

  it('drops what it cannot read and says so; the deck is always the current one', () => {
    const r = readSession(
      { version: 2, deck: { path: '/elsewhere' }, notes: [note(), { id: 'bad id' }, note({ id: 'n-0002', status: 'nope' as never })], people: 'x', tombstones: ['n-0003', '../x'] },
      DECK,
    );
    expect(r.lossy).toBe(true);
    expect(r.session.notes.map((n) => n.id)).toEqual(['n-0001']);
    expect(r.session.people).toEqual([]);
    expect(r.session.tombstones).toEqual(['n-0003']);
    expect(r.session.deck).toEqual(DECK);
  });

  it('another version or junk gives an empty session marked lossy', () => {
    expect(readSession({ version: 3, notes: [note()] }, DECK)).toMatchObject({ lossy: true, session: { notes: [] } });
    expect(readSession(null, DECK).lossy).toBe(true);
  });

  it('readNote rebuilds field by field and drops unknown fields', () => {
    const n = readNote({ ...note(), extra: 'x', targets: [{ ...note().targets[0], evil: 1 }] }) as Note & { extra?: string };
    expect(n.extra).toBeUndefined();
    expect((n.targets[0] as unknown as Record<string, unknown>).evil).toBeUndefined();
  });
});

describe('SessionStore', () => {
  it('starts empty without touching the disk, saves atomically, and reads back', async () => {
    const file = sessionFileFor(ud, 'aaaaaaaaaaaaaaaa');
    const events: string[] = [];
    const s = await SessionStore.open(file, DECK, (e) => events.push(e.state));
    expect(fs.existsSync(file)).toBe(false);
    s.session.notes.push(note());
    await s.save();
    expect(events).toEqual(['saved']);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const again = await SessionStore.open(file, { ...DECK, title: 'New title' });
    expect(again.session.notes).toEqual([note()]);
    expect(again.session.deck.title).toBe('New title');
  });

  it('keeps an unreadable file aside before writing over it', async () => {
    const file = sessionFileFor(ud, 'bbbbbbbbbbbbbbbb');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"version": 2, "notes": [{"id": "broken"}]');
    const s = await SessionStore.open(file, DECK);
    expect(s.session.notes).toEqual([]);
    await s.save();
    const aside = fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith('session.json.unreadable-'));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(file), aside[0]), 'utf8')).toBe('{"version": 2, "notes": [{"id": "broken"}]');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).version).toBe(2);
  });

  // Finding 24 (6.8 One writer): a window reopened while the closed window's write of the same session.json is in
  // flight must read the file after that write lands, or its next save drops the note and reuses its id.
  it('a store opened while another store is writing the same file reads after that write lands', async () => {
    const file = sessionFileFor(ud, 'cccccccccccccccc');
    const me = { id: 'josh-ab12', name: 'Josh', color: '#2563eb' };
    const deps = { me: () => me, now: () => new Date().toISOString(), version: () => 'f'.repeat(64), slides: () => null };
    const a = await SessionStore.open(file, DECK);
    const notesA = new NotesStore(a.session, deps);
    expect(notesA.apply({ op: 'create', clientId: 'a1', text: 'first', marks: [], slide: null })).toMatchObject({ ok: true, created: { id: 'n-0001' } });
    const aSaved = a.save(); // the closing window's write, not awaited
    const b = await SessionStore.open(file, DECK);
    await aSaved;
    const notesB = new NotesStore(b.session, deps);
    const r = notesB.apply({ op: 'create', clientId: 'b1', text: 'second', marks: [], slide: null });
    expect(r.ok && r.created?.id, 'the reopened window must not reuse n-0001').toBe('n-0002');
    await b.save();
    const disk = JSON.parse(fs.readFileSync(file, 'utf8')) as Session;
    expect(disk.notes.map((n) => [n.id, n.text])).toEqual([
      ['n-0001', 'first'],
      ['n-0002', 'second'],
    ]);
  });
});

// Finding 10/14 (6.7 Index replay): Session.deckNav is learned as soon as the forward key is known.
describe('learnDeckNav', () => {
  it('stores forward as soon as it is known, back defaulting to its counterpart', () => {
    expect(learnDeckNav(undefined, { forward: 'ArrowRight' })).toEqual({ forward: 'ArrowRight', back: 'ArrowLeft' });
    expect(learnDeckNav(undefined, { forward: 'PageDown' })).toEqual({ forward: 'PageDown', back: 'PageUp' });
    expect(learnDeckNav(undefined, { forward: 'ArrowDown' })).toEqual({ forward: 'ArrowDown', back: 'ArrowUp' });
    // No counterpart: the 6.7 default back key.
    expect(learnDeckNav(undefined, { forward: ' ' })).toEqual({ forward: ' ', back: 'ArrowLeft' });
    expect(learnDeckNav(undefined, { forward: 'PageDown', back: 'ArrowLeft' })).toEqual({ forward: 'PageDown', back: 'ArrowLeft' });
  });

  it('keeps an observed back key, and changes nothing it does not know', () => {
    const stored = { forward: 'PageDown', back: 'ArrowUp' };
    // Same forward seen again in a new page load (back not seen yet): the stored back stays.
    expect(learnDeckNav(stored, { forward: 'PageDown' })).toBeNull();
    // Only back seen: it updates the stored back; with nothing stored there is no forward to keep.
    expect(learnDeckNav(stored, { back: 'PageUp' })).toEqual({ forward: 'PageDown', back: 'PageUp' });
    expect(learnDeckNav(undefined, { back: 'PageUp' })).toBeNull();
    expect(learnDeckNav(stored, undefined)).toBeNull();
    expect(learnDeckNav(stored, {})).toBeNull();
    expect(learnDeckNav(stored, { forward: 'PageDown', back: 'ArrowUp' })).toBeNull();
    // A different forward key: its own counterpart.
    expect(learnDeckNav(stored, { forward: 'ArrowRight' })).toEqual({ forward: 'ArrowRight', back: 'ArrowLeft' });
  });
});

// ------------------------------------------------------------------------------------------- Phase 2

const V2 = 'c'.repeat(64);
const source = {
  file: 'deck.html',
  version: V2,
  start: 100,
  end: 115,
  line: 12,
  col: 5,
  strategy: 'html-text' as const,
  confidence: 'exact' as const,
};
const withSource = (src: unknown): Note =>
  note({ kind: 'edit', status: 'done', marks: [], targets: [{ ...note().targets[0], source: src as never }], verbatim: { before: 'a', after: 'b' }, summary: 'Edited: a → b' });

describe('SourceLoc (section 8) on targets', () => {
  it('round-trips, candidates and key warnings included', () => {
    const s: Session = { ...emptySession(DECK), notes: [withSource({ ...source, strategy: 'agent', confidence: 'ambiguous', candidates: [{ start: 1, end: 2, line: 1, context: 'x' }, { start: 5, end: 9, line: 2, context: 'y', keyWarning: 'This text is also used as a key at deck.html:2' }] })] };
    const r = readSession(JSON.parse(JSON.stringify(s)), DECK);
    expect(r.lossy).toBe(false);
    expect(r.session.notes).toEqual(s.notes);
  });

  it('a SourceLoc that cannot be read is left out; the note stays and the file is kept aside', () => {
    for (const bad of [
      { ...source, version: 'abc' },
      { ...source, start: 20, end: 10 },
      { ...source, start: -1 },
      { ...source, start: 1.5 },
      { ...source, line: 0 },
      { ...source, col: 0 },
      { ...source, strategy: 'guess' },
      { ...source, confidence: 'sure' },
      { ...source, file: 3 },
      { ...source, candidates: [{ start: 3, end: 1, line: 1, context: '' }] },
      { ...source, candidates: 'x' },
      { ...source, candidates: Array.from({ length: 201 }, () => ({ start: 0, end: 0, line: 1, context: '' })) },
      'x',
    ]) {
      const r = readSession({ version: 2, notes: [withSource(bad)] }, DECK);
      expect(r.lossy, JSON.stringify(bad).slice(0, 80)).toBe(true);
      expect(r.session.notes).toHaveLength(1);
      expect(r.session.notes[0].targets[0].source).toBeUndefined();
      expect(r.session.notes[0].verbatim).toEqual({ before: 'a', after: 'b' });
    }
    expect(readSource(source)).toEqual(source);
    expect(() => readSource({ ...source, extra: 1, candidates: [{ start: 0, end: 0, line: 1, context: '', evil: 1 }] })).not.toThrow();
    expect(readSource({ ...source, candidates: [{ start: 0, end: 0, line: 1, context: '', evil: 1 }] }).candidates).toEqual([{ start: 0, end: 0, line: 1, context: '' }]);
  });
});

describe('locked spans (section 8) round-trip and are checked', () => {
  const span = { start: 100, end: 115, text: 'Revenue grew 5%', noteId: 'n-0001', state: 'ok' as const };

  it('round-trip through session.json, a violated one with its change', () => {
    const s: Session = {
      ...emptySession(DECK),
      notes: [withSource(source), withSource(source)].map((n, i) => ({ ...n, id: `n-000${i + 1}` })),
      locked: [span, { ...span, noteId: 'n-0002', state: 'violated', change: { before: 'Revenue grew 5%', after: 'Revenue fell' } }],
    };
    const r = readSession(JSON.parse(JSON.stringify(s)), DECK);
    expect(r.lossy).toBe(false);
    expect(r.session.locked).toEqual(s.locked);
  });

  it('malformed spans are dropped (and the file kept aside); a span whose note is gone protects nothing', () => {
    for (const bad of [
      { ...span, start: 20, end: 10 },
      { ...span, start: -5 },
      { ...span, end: 1.5 },
      { ...span, start: '100' },
      { ...span, noteId: 'n-1' },
      { ...span, noteId: '../n-0001' },
      { ...span, state: 'broken' },
      { ...span, text: null },
      { ...span, change: { before: 'x' } },
      [],
    ]) {
      expect(() => readLocked(bad), JSON.stringify(bad)).toThrow();
      const r = readSession({ version: 2, notes: [withSource(source)], locked: [span, bad] }, DECK);
      expect(r.lossy).toBe(true);
      expect(r.session.locked).toEqual([span]);
    }
    // An orphan span is not a read failure: nothing is lost by dropping it.
    const orphan = readSession({ version: 2, notes: [withSource(source)], locked: [span, { ...span, noteId: 'n-0009' }] }, DECK);
    expect(orphan.lossy).toBe(false);
    expect(orphan.session.locked).toEqual([span]);
    expect(readLocked({ ...span, noteId: 'anna-x7k2:n-0003', extra: 1 })).toEqual({ ...span, noteId: 'anna-x7k2:n-0003' });
  });

  it('a second note with an id already read is dropped (undo must delete the right one)', () => {
    const r = readSession({ version: 2, notes: [note({ text: 'first' }), note({ text: 'second' })] }, DECK);
    expect(r.lossy).toBe(true);
    expect(r.session.notes.map((n) => n.text)).toEqual(['first']);
  });

  it('settings.smartPunctuation (the per-document override, 6.3) round-trips', () => {
    const r = readSession({ version: 2, settings: { smartPunctuation: false, inkFilter: 'nope' } }, DECK);
    expect(r.session.settings).toEqual({ smartPunctuation: false });
    expect(readSession({ version: 2, settings: { smartPunctuation: 'off' } }, DECK).session.settings).toEqual({});
  });
});

describe('the last known version (P2-12) and the stored deck fields', () => {
  it('known() and deck.sha256 follow noteVersion, are saved, and come back with the deck fields the file had', async () => {
    const file = sessionFileFor(ud, 'dddddddddddddddd');
    const s = await SessionStore.open(file, DECK);
    expect(s.known()).toBeNull();
    expect(s.storedDeck).toBeNull();
    s.noteVersion({ version: V2, contentHash: 'e'.repeat(64), title: 'Deck v2' });
    expect(s.known()).toEqual({ version: V2 });
    expect(s.session.deck).toEqual({ ...DECK, sha256: 'e'.repeat(64), title: 'Deck v2' });
    await s.save();
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(disk.known).toEqual({ version: V2 });
    expect(disk.deck.sha256).toBe('e'.repeat(64));

    // Reopened for the deck as it is now (changed while no window showed it): the deck fields are the current
    // document's, the stored ones and the known version say what the session last saw.
    const again = await SessionStore.open(file, { ...DECK, sha256: '1'.repeat(64) });
    expect(again.session.deck.sha256).toBe('1'.repeat(64));
    expect(again.storedDeck).toEqual({ ...DECK, sha256: 'e'.repeat(64), title: 'Deck v2' });
    expect(again.known()).toEqual({ version: V2 });
    // known() is a copy.
    again.known()!.version = 'x';
    expect(again.known()).toEqual({ version: V2 });
    expect(() => again.noteVersion({ version: 'abc', contentHash: V2 })).toThrow();
    expect(() => again.noteVersion({ version: V2, contentHash: 'abc' })).toThrow();
    expect(again.known()).toEqual({ version: V2 });
  });

  it('an unreadable known version is dropped and the file kept aside', () => {
    const r = readSession({ version: 2, known: { version: 'not a hash' } }, DECK);
    expect(r.known).toBeNull();
    expect(r.lossy).toBe(true);
    expect(readSession({ version: 2, known: { version: V2, extra: 1 } }, DECK).known).toEqual({ version: V2 });
    expect(readSession({ version: 2 }, DECK)).toMatchObject({ known: null, storedDeck: null, lossy: false });
    expect(readSession({ version: 2, deck: { path: 1 } }, DECK).storedDeck).toBeNull();
  });
});
