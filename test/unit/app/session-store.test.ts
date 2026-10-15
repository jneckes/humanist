// session.json (9.7; 6.8 One writer): atomic writes, defensive reads that never lose a note.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Note, Session } from '@blueline/core/types';
import { SessionStore, emptySession, readNote, readSession, sessionFileFor } from '../../../packages/app/src/main/session-store';

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
});
