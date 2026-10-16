// The IPC guard (9.1 "Main treats every message from a deck view as written by the page").
import { describe, expect, it } from 'vitest';
import { DeckToMain, ShellToMain } from '@blueline/core/ipc';
import {
  DECK_CHANNEL_KINDS,
  DECK_VALIDATORS,
  DeckIpc,
  IPC_LIMITS,
  NOTE_ID,
  RateLimiter,
  ShellIpc,
  isMainFrameOf,
  sanitizeJson,
  utf8Length,
  validateCollectResult,
  validateDetectResult,
  validateDiag,
  validateDiagRecord,
  validateFocus,
  validateLink,
  validateMode,
  validateNoArgs,
  validateNote,
  validateReady,
  validateRenderReply,
  validateSetMode,
  validateSlides,
  type DropInfo,
  type FrameLike,
  type IpcMainLike,
  type WebContentsLike,
} from '../../../packages/app/src/main/ipc-guard';
import { slideRefFor } from '../../../packages/app/src/main/notes';

const DOC = '0123456789abcdef';
const OTHER = 'fedcba9876543210';

function frame(over: Partial<FrameLike> = {}): FrameLike {
  return { processId: 7, routingId: 1, origin: `blueline://${DOC}`, parent: null, detached: false, ...over };
}

class FakeWc implements WebContentsLike {
  destroyed = false;
  private listeners: (() => void)[] = [];
  constructor(
    readonly id: number,
    public mainFrame: FrameLike = frame(),
  ) {}
  isDestroyed() {
    return this.destroyed;
  }
  once(_e: 'destroyed', l: () => void) {
    this.listeners.push(l);
    return this;
  }
  destroy() {
    this.destroyed = true;
    for (const l of this.listeners) l();
  }
}

class FakeIpcMain implements IpcMainLike {
  on_ = new Map<string, (e: never, ...a: unknown[]) => void>();
  handle_ = new Map<string, (e: never, ...a: unknown[]) => unknown>();
  on(c: string, l: (e: never, ...a: unknown[]) => void) {
    this.on_.set(c, l);
  }
  handle(c: string, l: (e: never, ...a: unknown[]) => unknown) {
    this.handle_.set(c, l);
  }
  send(c: string, event: unknown, ...args: unknown[]) {
    this.on_.get(c)!(event as never, ...args);
  }
  invoke(c: string, event: unknown, ...args: unknown[]) {
    return this.handle_.get(c)!(event as never, ...args) as Promise<unknown>;
  }
}

function deckSetup(now?: () => number) {
  const ipc = new FakeIpcMain();
  const drops: DropInfo[] = [];
  const router = new DeckIpc({ ipcMain: ipc, onDrop: (d) => drops.push(d), now });
  const got: { channel: string; docId: string; kind: string; payload: unknown }[] = [];
  for (const [channel, v] of Object.entries(DECK_VALIDATORS)) {
    router.on(channel, v as never, (from, payload) => got.push({ channel, docId: from.docId, kind: from.kind, payload }));
  }
  return { ipc, router, drops, got };
}

const ev = (wc: FakeWc, f: FrameLike | null = wc.mainFrame) => ({ sender: wc, senderFrame: f });

const validCreate = () => ({
  op: 'create',
  clientId: 'c-1',
  text: 'start the axis at zero',
  marks: [{ tool: 'pen', shape: 'ellipse', path: 'M 10 10 C 20 20, 40 20, 50 10 Z', targets: [{ css: '#chart', text: 'Revenue', role: 'chart', stamp: 'bl-12' }] }],
  slide: 3,
});

describe('sender checks', () => {
  it('accepts a registered deck main frame with origin blueline://<docId>, and takes the docId from the registration', () => {
    const { ipc, router, got, drops } = deckSetup();
    const wc = new FakeWc(1);
    router.registerDeckView(wc, { docId: DOC, kind: 'deck' });
    ipc.send(DeckToMain.focus, ev(wc), { textField: true, docId: OTHER });
    expect(drops).toEqual([]);
    expect(got).toEqual([{ channel: DeckToMain.focus, docId: DOC, kind: 'deck', payload: { textField: true } }]);
  });

  it('drops messages from unregistered or destroyed webContents', () => {
    const { ipc, router, got, drops } = deckSetup();
    const wc = new FakeWc(2);
    ipc.send(DeckToMain.focus, ev(wc), { textField: true });
    router.registerDeckView(wc, { docId: DOC, kind: 'deck' });
    wc.destroy();
    ipc.send(DeckToMain.focus, ev(wc), { textField: true });
    expect(got).toEqual([]);
    expect(drops.map((d) => d.reason)).toEqual(['unregistered', 'unregistered']);
  });

  it('drops a different webContents that reuses a registered id', () => {
    const { ipc, router, got } = deckSetup();
    router.registerDeckView(new FakeWc(3), { docId: DOC, kind: 'deck' });
    ipc.send(DeckToMain.focus, ev(new FakeWc(3)), { textField: true });
    expect(got).toEqual([]);
  });

  it('drops messages from subframes, other frames, detached frames, or no frame', () => {
    const { ipc, router, got, drops } = deckSetup();
    const wc = new FakeWc(4);
    router.registerDeckView(wc, { docId: DOC, kind: 'deck' });
    ipc.send(DeckToMain.focus, ev(wc, frame({ parent: wc.mainFrame, routingId: 2 })), { textField: true });
    ipc.send(DeckToMain.focus, ev(wc, frame({ routingId: 9 })), { textField: true });
    ipc.send(DeckToMain.focus, ev(wc, frame({ processId: 8 })), { textField: true });
    ipc.send(DeckToMain.focus, ev(wc, frame({ detached: true })), { textField: true });
    ipc.send(DeckToMain.focus, ev(wc, null), { textField: true });
    expect(got).toEqual([]);
    expect(drops.every((d) => d.reason === 'frame')).toBe(true);
    // An equal-but-distinct wrapper of the main frame (same process and routing id) is accepted.
    ipc.send(DeckToMain.focus, ev(wc, frame()), { textField: false });
    expect(got).toHaveLength(1);
  });

  it('drops messages whose frame origin is not blueline://<docId>', () => {
    const { ipc, router, got, drops } = deckSetup();
    const wc = new FakeWc(5);
    router.registerDeckView(wc, { docId: DOC, kind: 'deck' });
    for (const origin of [`blueline://${OTHER}`, `blueline://${DOC}-files`, 'null', 'https://attacker.example', 'app://shell', '']) {
      wc.mainFrame = frame({ origin });
      ipc.send(DeckToMain.focus, ev(wc), { textField: true });
    }
    expect(got).toEqual([]);
    expect(drops.every((d) => d.reason === 'origin')).toBe(true);
  });

  it('restricts channels by view kind', () => {
    const { ipc, router, got, drops } = deckSetup();
    const deck = new FakeWc(6);
    const render = new FakeWc(7);
    const diag = new FakeWc(8);
    router.registerDeckView(deck, { docId: DOC, kind: 'deck' });
    router.registerDeckView(render, { docId: DOC, kind: 'render' });
    router.registerDeckView(diag, { docId: DOC, kind: 'diagnostics' });
    const d = { event: 'paste', data: { length: 3 } };
    ipc.send(DeckToMain.diag, ev(deck), d);
    ipc.send(DeckToMain.diag, ev(render), d);
    ipc.send(DeckToMain.diag, ev(diag), d);
    ipc.send(DeckToMain.renderReply, ev(deck), { reqId: 1, ok: true });
    ipc.send(DeckToMain.renderReply, ev(render), { reqId: 1, ok: true });
    ipc.send(DeckToMain.note, ev(render), validCreate());
    ipc.send(DeckToMain.ready, ev(render));
    expect(got.map((g) => `${g.channel}:${g.kind}`)).toEqual([`${DeckToMain.diag}:diagnostics`, `${DeckToMain.renderReply}:render`, `${DeckToMain.ready}:render`]);
    expect(drops.filter((x) => x.reason === 'kind')).toHaveLength(4);
    expect(DECK_CHANNEL_KINDS[DeckToMain.diag]).toEqual(['diagnostics']);
  });

  it('drops extra arguments and refuses double declaration', () => {
    const { ipc, router, got, drops } = deckSetup();
    const wc = new FakeWc(9);
    router.registerDeckView(wc, { docId: DOC, kind: 'deck' });
    ipc.send(DeckToMain.focus, ev(wc), { textField: true }, 'extra');
    expect(got).toEqual([]);
    expect(drops[0].reason).toBe('args');
    expect(() => router.on(DeckToMain.focus, validateFocus, () => {})).toThrow();
  });

  it('validates registration', () => {
    const { router } = deckSetup();
    expect(() => router.registerDeckView(new FakeWc(10), { docId: 'NOT-HEX', kind: 'deck' })).toThrow();
    expect(() => router.registerDeckView(new FakeWc(10), { docId: DOC, kind: 'shell' as never })).toThrow();
  });

  it('isMainFrameOf compares ids, not object identity', () => {
    const wc = new FakeWc(11);
    expect(isMainFrameOf(wc.mainFrame, wc)).toBe(true);
    expect(isMainFrameOf({ ...wc.mainFrame }, wc)).toBe(true);
    expect(isMainFrameOf({ ...wc.mainFrame, parent: wc.mainFrame }, wc)).toBe(false);
    expect(isMainFrameOf(null, wc)).toBe(false);
  });

  it('a handler that throws is contained', () => {
    const ipc = new FakeIpcMain();
    const drops: DropInfo[] = [];
    const router = new DeckIpc({ ipcMain: ipc, onDrop: (d) => drops.push(d) });
    router.on(DeckToMain.focus, validateFocus, () => {
      throw new Error('boom');
    });
    const wc = new FakeWc(12);
    router.registerDeckView(wc, { docId: DOC, kind: 'deck' });
    expect(() => ipc.send(DeckToMain.focus, ev(wc), { textField: true })).not.toThrow();
    expect(drops[0].reason).toBe('handler');
  });
});

describe('rate limiting', () => {
  it('RateLimiter: 1,000 per second, refilled continuously, per key', () => {
    let now = 0;
    const r = new RateLimiter(1000, () => now);
    let n = 0;
    for (let i = 0; i < 1500; i++) if (r.allow(1)) n++;
    expect(n).toBe(1000);
    expect(r.allow(2)).toBe(true); // other senders unaffected
    now += 1;
    expect(r.allow(1)).toBe(true);
    expect(r.allow(1)).toBe(false);
    now += 1000;
    n = 0;
    for (let i = 0; i < 1500; i++) if (r.allow(1)) n++;
    expect(n).toBe(1000);
  });

  it('the router drops excess messages, valid or not', () => {
    let now = 0;
    const { ipc, router, got, drops } = deckSetup(() => now);
    const wc = new FakeWc(20);
    router.registerDeckView(wc, { docId: DOC, kind: 'deck' });
    for (let i = 0; i < 500; i++) ipc.send(DeckToMain.focus, ev(wc), 'junk');
    for (let i = 0; i < 1000; i++) ipc.send(DeckToMain.focus, ev(wc), { textField: true });
    expect(got).toHaveLength(500);
    expect(drops.filter((d) => d.reason === 'rate')).toHaveLength(500);
    expect(drops.filter((d) => d.reason === 'invalid')).toHaveLength(500);
    now += 1000;
    ipc.send(DeckToMain.focus, ev(wc), { textField: true });
    expect(got).toHaveLength(501);
  });
});

describe('validators', () => {
  it('have one entry per DeckToMain channel', () => {
    expect(Object.keys(DECK_VALIDATORS).sort()).toEqual(Object.values(DeckToMain).sort());
    expect(Object.keys(DECK_CHANNEL_KINDS).sort()).toEqual(Object.values(DeckToMain).sort());
  });

  it('ready ignores its payload', () => {
    expect(validateReady(undefined)).toEqual({ ok: true, value: {} });
    expect(validateReady({ mode: 'deck', anything: 1 })).toEqual({ ok: true, value: {} });
    expect(validateReady('x').ok).toBe(false);
    expect(validateReady(JSON.parse('{"__proto__": {"polluted": true}}')).ok).toBe(false);
  });

  it('focus, mode and link', () => {
    expect(validateFocus({ textField: false })).toEqual({ ok: true, value: { textField: false } });
    expect(validateFocus({ textField: 'yes' }).ok).toBe(false);
    expect(validateFocus(null).ok).toBe(false);
    expect(validateFocus([true]).ok).toBe(false);
    expect(validateMode({ mode: 'read' })).toEqual({ ok: true, value: { mode: 'read' } });
    expect(validateMode({ mode: 'edit' }).ok).toBe(false);
    expect(validateMode({ mode: 'review' }).ok).toBe(false);
    expect(validateLink({ href: 'https://example.com/a', target: '_blank' })).toEqual({ ok: true, value: { href: 'https://example.com/a' } });
    expect(validateLink({ href: 'not a url' }).ok).toBe(false);
    expect(validateLink({ href: 'https://e.com/' + 'a'.repeat(IPC_LIMITS.url) }).ok).toBe(false);
    expect(validateLink({ href: 42 }).ok).toBe(false);
  });

  it('slides', () => {
    // Unknown fields are dropped; the base fields come back rebuilt (the optional ones: next tests).
    const s = { kind: 'reveal', count: 3, current: 1, titles: ['A', 'B', 'C'], navKind: 'reveal', extra: 1 };
    expect(validateSlides(s)).toEqual({ ok: true, value: { kind: 'reveal', count: 3, current: 1, titles: ['A', 'B', 'C'], navKind: 'reveal' } });
    expect(validateSlides({ ...s, kind: 'carousel' }).ok).toBe(false);
    expect(validateSlides({ ...s, count: -1 }).ok).toBe(false);
    expect(validateSlides({ ...s, count: 1.5 }).ok).toBe(false);
    expect(validateSlides({ ...s, current: Infinity }).ok).toBe(false);
    expect(validateSlides({ ...s, titles: [1] }).ok).toBe(false);
    expect(validateSlides({ ...s, titles: new Array(IPC_LIMITS.slides + 1).fill('t') }).ok).toBe(false);
    expect(validateSlides({ ...s, titles: ['x'.repeat(IPC_LIMITS.slideTitle + 1)] }).ok).toBe(false);
  });

  // Finding 10/14: the optional fields the preload sends (slide-watcher.ts report()) are what main builds every
  // note's SlideRef from (section 8, 9.4) and what Session.deckNav is learned from (6.7 Index replay).
  it('slides: hashes, revealIndices, ids and deckNav are validated and kept, field by field', () => {
    const base = { kind: 'generic', count: 3, current: 0, titles: ['A', 'B', 'C'], navKind: 'hash' };
    const full = {
      ...base,
      hashes: ['#a', '#b', '#c'],
      revealIndices: [
        [0, 0],
        [1, 0],
        [1, 1],
      ],
      ids: ['a', null, 'c'],
      deckNav: { forward: 'ArrowRight', back: 'ArrowLeft' },
    };
    const v = validateSlides(full);
    expect(v).toEqual({ ok: true, value: full });
    // Rebuilt, never the payload's own objects.
    expect(v.ok && v.value.hashes).not.toBe(full.hashes);
    expect(v.ok && v.value.revealIndices?.[0]).not.toBe(full.revealIndices[0]);
    expect(v.ok && v.value.deckNav).not.toBe(full.deckNav);
    // deckNav with one key (the preload reports forward before the user ever goes back).
    expect(validateSlides({ ...base, deckNav: { forward: 'PageDown', extra: 'x' } })).toEqual({ ok: true, value: { ...base, deckNav: { forward: 'PageDown' } } });
    expect(validateSlides({ ...base, deckNav: { forward: ' ' } }).ok).toBe(true);
    // An empty deckNav carries nothing.
    expect(validateSlides({ ...base, deckNav: {} })).toEqual({ ok: true, value: base });

    // Values of the wrong type refuse the message.
    expect(validateSlides({ ...base, hashes: ['#a', 2, '#c'] }).ok).toBe(false);
    expect(validateSlides({ ...base, hashes: '#a' }).ok).toBe(false);
    expect(validateSlides({ ...base, revealIndices: [[0, 0], [1], [1, 1]] }).ok).toBe(false);
    expect(validateSlides({ ...base, revealIndices: [[0, 0], [1, -1], [1, 1]] }).ok).toBe(false);
    expect(validateSlides({ ...base, revealIndices: [[0, 0], [1, 0.5], [1, 1]] }).ok).toBe(false);
    expect(validateSlides({ ...base, revealIndices: [[0, 0], [1, 0, 2], [1, 1]] }).ok).toBe(false);
    expect(validateSlides({ ...base, ids: ['a', 1, 'c'] }).ok).toBe(false);
    expect(validateSlides({ ...base, ids: 'a' }).ok).toBe(false);
    // A page's own id or hash that cannot be kept (too long, a lone surrogate, not a hash) is not a forgery:
    // that id is null, and the hashes are dropped as a whole (hash navigation needs every one).
    expect(validateSlides({ ...base, ids: ['a', 'x'.repeat(IPC_LIMITS.slideTitle + 1), 'c'] })).toEqual({ ok: true, value: { ...base, ids: ['a', null, 'c'] } });
    expect(validateSlides({ ...base, ids: ['a', '\uD800', 'c'] })).toEqual({ ok: true, value: { ...base, ids: ['a', null, 'c'] } });
    expect(validateSlides({ ...base, hashes: ['#a', 'b', '#c'] })).toEqual({ ok: true, value: base });
    expect(validateSlides({ ...base, hashes: ['#a', '#' + 'x'.repeat(IPC_LIMITS.slideTitle), '#c'] })).toEqual({ ok: true, value: base });
    expect(validateSlides({ ...base, deckNav: { forward: 'KeyQ' } }).ok).toBe(false);
    expect(validateSlides({ ...base, deckNav: { forward: 'ArrowRight'.repeat(4) } }).ok).toBe(false);
    expect(validateSlides({ ...base, deckNav: { forward: 1 } }).ok).toBe(false);
    expect(validateSlides({ ...base, deckNav: ['ArrowRight'] }).ok).toBe(false);
    expect(validateSlides({ ...base, deckNav: JSON.parse('{"__proto__": {"forward": "ArrowRight"}}') }).ok).toBe(false);

    // A per-slide array that does not match count (or exceeds the slide cap) is dropped, not trusted.
    expect(validateSlides({ ...base, hashes: ['#a', '#b'] })).toEqual({ ok: true, value: base });
    expect(validateSlides({ ...base, ids: ['a', null, 'c', 'd'] })).toEqual({ ok: true, value: base });
    expect(validateSlides({ ...base, revealIndices: [[0, 0]] })).toEqual({ ok: true, value: base });
    expect(validateSlides({ ...base, ids: new Array(IPC_LIMITS.slides + 1).fill(null) })).toEqual({ ok: true, value: base });
  });

  it('slides: a preload-shaped SlideState through the guard gives slideRefFor the id and nav (section 8 SlideRef, 9.4)', () => {
    // As slide-watcher.ts report() builds it for fixtures/decks/reveal-hash at Reveal.slide(2, 1) after one
    // ArrowRight, after IPC (structured clone).
    const reveal = structuredClone({
      kind: 'reveal',
      count: 8,
      current: 3,
      titles: ['Northwind 2027', 'Where we are', 'Three bets for 2027', 'Bet one: self-serve', 'Bet two: partners', 'Bet three: platform', 'What we will stop doing', 'Questions'],
      navKind: 'reveal',
      hashes: ['#/title', '#/where-we-are', '#/bets', '#/bet-one', '#/bet-two', '#/bet-three', '#/stop', '#/questions'],
      revealIndices: [
        [0, 0],
        [1, 0],
        [2, 0],
        [2, 1],
        [2, 2],
        [2, 3],
        [3, 0],
        [4, 0],
      ],
      ids: ['title', 'where-we-are', 'bets', 'bet-one', 'bet-two', 'bet-three', 'stop', 'questions'],
      deckNav: { forward: 'ArrowRight' },
    });
    const rv = validateSlides(reveal);
    expect(rv.ok).toBe(true);
    if (!rv.ok) return;
    expect(slideRefFor(3, rv.value)).toEqual({ index: 3, id: 'bet-one', title: 'Bet one: self-serve', nav: { kind: 'reveal', value: [2, 1] } });
    expect(slideRefFor(6, rv.value)).toEqual({ index: 6, id: 'stop', title: 'What we will stop doing', nav: { kind: 'reveal', value: [3, 0] } });
    expect(rv.value.deckNav).toEqual({ forward: 'ArrowRight' });

    // A generic deck that updates the hash (generic-hash.html, '#n1' format): nav is the hash.
    const hash = structuredClone({
      kind: 'generic',
      count: 3,
      current: 1,
      titles: ['One', 'Two', 'Three'],
      navKind: 'hash',
      hashes: ['#one', '#two', '#three'],
      ids: ['one', 'two', 'three'],
    });
    const hv = validateSlides(hash);
    expect(hv.ok).toBe(true);
    if (!hv.ok) return;
    expect(slideRefFor(1, hv.value)).toEqual({ index: 1, id: 'two', title: 'Two', nav: { kind: 'hash', value: '#two' } });
  });

  it('note create: rebuilt, extra fields dropped', () => {
    const p = { ...validCreate(), status: 'done', author: 'someone-else', docId: OTHER, path: '/etc/passwd' };
    (p.marks[0] as Record<string, unknown>).evil = 'x';
    (p.marks[0].targets[0] as Record<string, unknown>).html = '<img onerror=alert(1)>';
    const v = validateNote(p);
    expect(v.ok).toBe(true);
    expect(v.ok && v.value).toEqual(validCreate());
    expect(v.ok && v.value).not.toBe(p);
    expect(v.ok && (v.value as { marks: unknown[] }).marks[0]).not.toBe(p.marks[0]);
  });

  it('note text limit is 64 KB of UTF-8', () => {
    expect(validateNote({ ...validCreate(), text: 'a'.repeat(64 * 1024) }).ok).toBe(true);
    expect(validateNote({ ...validCreate(), text: 'a'.repeat(64 * 1024 + 1) }).ok).toBe(false);
    // 3 bytes each: 21,845 chars fit, 21,846 do not.
    expect(validateNote({ ...validCreate(), text: '€'.repeat(21845) }).ok).toBe(true);
    expect(validateNote({ ...validCreate(), text: '€'.repeat(21846) }).ok).toBe(false);
    expect(validateNote({ ...validCreate(), text: 'bad \ud800 surrogate' }).ok).toBe(false);
    expect(validateNote({ ...validCreate(), text: 'emoji 😀 ok' }).ok).toBe(true);
    expect(utf8Length('aé€😀')).toBe(1 + 2 + 3 + 4);
  });

  it('marks: at most 200, path at most 16 KB of SVG path data', () => {
    const mark = validCreate().marks[0];
    expect(validateNote({ ...validCreate(), marks: new Array(200).fill(mark) }).ok).toBe(true);
    expect(validateNote({ ...validCreate(), marks: new Array(201).fill(mark) }).ok).toBe(false);
    expect(validateNote({ ...validCreate(), marks: [{ ...mark, path: 'M0 0 ' + 'L1 1 '.repeat(3275) }] }).ok).toBe(true);
    expect(validateNote({ ...validCreate(), marks: [{ ...mark, path: 'M0 0' + ' L1 1'.repeat(3300) }] }).ok).toBe(false);
    expect(validateNote({ ...validCreate(), marks: [{ ...mark, path: 'M0 0 <script>' }] }).ok).toBe(false);
    expect(validateNote({ ...validCreate(), marks: [{ ...mark, tool: 'laser' }] }).ok).toBe(false);
    expect(validateNote({ ...validCreate(), marks: [{ ...mark, shape: 'star' }] }).ok).toBe(false);
    const { shape: _s, ...noShape } = mark;
    expect(validateNote({ ...validCreate(), marks: [noShape] }).ok).toBe(true);
    expect(validateNote({ ...validCreate(), marks: [{ ...mark, targets: new Array(51).fill(mark.targets[0]) }] }).ok).toBe(false);
    expect(validateNote({ ...validCreate(), marks: [{ ...mark, targets: [{ ...mark.targets[0], stamp: 'bl-x' }] }] }).ok).toBe(false);
    expect(validateNote({ ...validCreate(), marks: [{ ...mark, targets: [{ ...mark.targets[0], stamp: null }] }] }).ok).toBe(true);
    expect(validateNote({ ...validCreate(), marks: [{ ...mark, targets: [{ ...mark.targets[0], role: 'Heading!' }] }] }).ok).toBe(false);
    expect(validateNote({ ...validCreate(), marks: 'many' }).ok).toBe(false);
  });

  it('note ops and ids', () => {
    expect(validateNote({ op: 'update', id: 'n-0007', text: 'x' })).toEqual({ ok: true, value: { op: 'update', id: 'n-0007', text: 'x' } });
    expect(validateNote({ op: 'update', id: 'anna-x7k2:n-0003' }).ok).toBe(true);
    expect(validateNote({ op: 'close', id: 'n-0007', text: 'ignored' })).toEqual({ ok: true, value: { op: 'close', id: 'n-0007' } });
    expect(validateNote({ op: 'delete', id: 'n-000123' }).ok).toBe(true);
    for (const id of ['n-7', 'n-0000001', '../n-0001', 'N-0001', 'anna:x:n-0001', 'n-0001\n', 7]) {
      expect(validateNote({ op: 'delete', id }).ok, String(id)).toBe(false);
    }
    expect(NOTE_ID.test('a'.repeat(40) + ':n-0001')).toBe(true);
    expect(NOTE_ID.test('a'.repeat(41) + ':n-0001')).toBe(false);
    expect(validateNote({ op: 'send', id: 'n-0001' }).ok).toBe(false);
    expect(validateNote({ op: 'accept', id: 'n-0001' }).ok).toBe(false);
    expect(validateNote({ ...validCreate(), clientId: 'bad id' }).ok).toBe(false);
    expect(validateNote({ ...validCreate(), slide: -1 }).ok).toBe(false);
    expect(validateNote({ ...validCreate(), slide: null }).ok).toBe(true);
  });

  it('refuses __proto__, constructor and prototype keys anywhere', () => {
    const bad = [
      JSON.parse('{"__proto__": {"x": 1}, "textField": true}'),
      JSON.parse('{"constructor": {"prototype": {"x": 1}}, "textField": true}'),
      JSON.parse('{"prototype": 1, "textField": true}'),
    ];
    for (const b of bad) expect(validateFocus(b).ok).toBe(false);
    const nested = validCreate() as unknown as { marks: { targets: object[] }[] };
    nested.marks[0].targets[0] = JSON.parse('{"css":"a","text":"b","role":"chart","stamp":null,"__proto__":{"polluted":1}}');
    expect(validateNote(nested).ok).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const arr = ['A'] as unknown as Record<string, unknown>;
    Object.defineProperty(arr, '__proto__', { value: 1, enumerable: true });
    expect(validateSlides({ kind: 'single', count: 1, current: 0, titles: arr, navKind: 'none' }).ok).toBe(false);
  });

  it('refuses non-plain objects and accessors', () => {
    class Focus {
      textField = true;
    }
    expect(validateFocus(new Focus()).ok).toBe(false);
    expect(validateFocus(new Map([['textField', true]])).ok).toBe(false);
    expect(validateFocus(Object.assign(Object.create(null), { textField: true })).ok).toBe(true);
    const acc = {};
    Object.defineProperty(acc, 'textField', { get: () => true, enumerable: true });
    expect(validateFocus(acc).ok).toBe(false);
    const sym = { textField: true, [Symbol('x')]: 1 };
    expect(validateFocus(sym).ok).toBe(false);
    // Inherited properties are never read.
    expect(validateFocus(Object.create({ textField: true })).ok).toBe(false);
  });

  it('diag keeps only primitive data under simple keys', () => {
    expect(validateDiag({ event: 'paste', data: { length: 3, inputType: 'insertFromPaste', ok: true, n: null } })).toEqual({
      ok: true,
      value: { event: 'paste', data: { length: 3, inputType: 'insertFromPaste', ok: true, n: null } },
    });
    expect(validateDiag({ event: 'exfiltrate', data: {} }).ok).toBe(false);
    expect(validateDiag({ event: 'paste', data: { nested: { a: 1 } } }).ok).toBe(false);
    expect(validateDiag({ event: 'paste', data: { list: [1] } }).ok).toBe(false);
    expect(validateDiag({ event: 'paste', data: { 'bad key': 1 } }).ok).toBe(false);
    expect(validateDiag({ event: 'paste', data: { v: 'x'.repeat(IPC_LIMITS.diagString + 1) } }).ok).toBe(false);
    expect(validateDiag({ event: 'paste', data: { v: NaN } }).ok).toBe(false);
    const many: Record<string, number> = {};
    for (let i = 0; i < 33; i++) many[`k${i}`] = i;
    expect(validateDiag({ event: 'paste', data: many }).ok).toBe(false);
  });

  it('renderReply sanitizes its result as plain JSON', () => {
    expect(validateRenderReply({ reqId: 3, ok: true, result: { a: [1, 'x', null, { b: false }] } })).toEqual({
      ok: true,
      value: { reqId: 3, ok: true, result: { a: [1, 'x', null, { b: false }] } },
    });
    expect(validateRenderReply({ reqId: 3, ok: false, error: 'timeout' }).ok).toBe(true);
    expect(validateRenderReply({ reqId: -1, ok: true }).ok).toBe(false);
    expect(validateRenderReply({ reqId: 1, ok: 'yes' }).ok).toBe(false);
    for (const bad of [new Date(), new Map(), new Uint8Array(4), new Error('x'), /re/, NaN, Infinity]) {
      expect(validateRenderReply({ reqId: 1, ok: true, result: { x: bad } }).ok).toBe(false);
    }
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = [deep];
    expect(validateRenderReply({ reqId: 1, ok: true, result: deep }).ok).toBe(false);
    expect(validateRenderReply({ reqId: 1, ok: true, result: JSON.parse('{"__proto__": 1}') }).ok).toBe(false);
    expect(sanitizeJson(new Array(11).fill(0), { values: 10 }).ok).toBe(false);
    expect(sanitizeJson(['abcdef', 'abcdef'], { chars: 10 }).ok).toBe(false);
  });

  it('detect and collect results', () => {
    const det = { kind: 'reveal', count: 2, current: 0, titles: ['a', 'b'], navKind: 'reveal', designSize: { w: 1600, h: 900 }, revealIndices: [[0, 0], [1, 0]] };
    expect(validateDetectResult(det)).toEqual({ ok: true, value: det });
    expect(validateDetectResult({ ...det, designSize: { w: 0, h: 900 } }).ok).toBe(false);
    expect(validateDetectResult({ ...det, revealIndices: [[0, 0, 0]] }).ok).toBe(false);
    const col = {
      nodes: [{ key: 1, locator: { stamp: 'bl-1', cssPath: 'body > h1:nth-of-type(1)', childIndex: 0 }, node: { stamp: 'bl-1', textIndex: 0, data: 'Title' }, rect: { x: 0, y: 0, w: 10, h: 10 } }],
      blocks: [{ key: 1, hasInline: false, nodeKeys: [1] }],
    };
    expect(validateCollectResult(col)).toEqual({ ok: true, value: col });
    expect(validateCollectResult({ ...col, nodes: [{ ...col.nodes[0], rect: { x: NaN, y: 0, w: 1, h: 1 } }] }).ok).toBe(false);
    expect(validateCollectResult({ ...col, blocks: [{ key: 1, hasInline: 1, nodeKeys: [] }] }).ok).toBe(false);
  });
});

describe('shell channels', () => {
  function shellSetup() {
    const ipc = new FakeIpcMain();
    const drops: DropInfo[] = [];
    const router = new ShellIpc({ ipcMain: ipc, onDrop: (d) => drops.push(d) });
    const calls: unknown[] = [];
    router.handle(ShellToMain.setMode, validateSetMode, (from, mode) => {
      calls.push([from.windowKey, mode]);
      return 'ok';
    });
    router.handle(ShellToMain.allowNetwork, validateNoArgs, (from) => {
      calls.push([from.windowKey, 'allow']);
    });
    return { ipc, router, drops, calls };
  }
  const shellFrame = (over: Partial<FrameLike> = {}) => frame({ origin: 'app://shell', ...over });

  it('accepts only a registered shell main frame with origin app://shell', async () => {
    const { ipc, router, calls } = shellSetup();
    const shell = new FakeWc(30, shellFrame());
    router.registerShell(shell, { windowKey: 'w1' });
    expect(await ipc.invoke(ShellToMain.setMode, ev(shell), 'review')).toBe('ok');
    const deck = new FakeWc(31);
    await expect(ipc.invoke(ShellToMain.allowNetwork, ev(deck))).rejects.toThrow('Refused');
    const sub = shellFrame({ parent: shell.mainFrame, routingId: 5 });
    await expect(ipc.invoke(ShellToMain.allowNetwork, ev(shell, sub))).rejects.toThrow('Refused');
    shell.mainFrame = shellFrame({ origin: `blueline://${DOC}` });
    await expect(ipc.invoke(ShellToMain.allowNetwork, ev(shell))).rejects.toThrow('Refused');
    expect(calls).toEqual([['w1', 'review']]);
  });

  it('validates shell arguments', async () => {
    const { ipc, router } = shellSetup();
    const shell = new FakeWc(32, shellFrame());
    router.registerShell(shell, { windowKey: 'w1' });
    await expect(ipc.invoke(ShellToMain.setMode, ev(shell), 'admin')).rejects.toThrow('Refused');
    await expect(ipc.invoke(ShellToMain.allowNetwork, ev(shell), 'extra')).rejects.toThrow('Refused');
    expect(validateDiagRecord(['wispr-card', 'pass'])).toEqual({ ok: true, value: { stepId: 'wispr-card', result: 'pass' } });
    expect(validateDiagRecord(['wispr-card', 'fail', 'no text'])).toEqual({ ok: true, value: { stepId: 'wispr-card', result: 'fail', detail: 'no text' } });
    expect(validateDiagRecord(['../x', 'pass']).ok).toBe(false);
    expect(validateDiagRecord(['a', 'maybe']).ok).toBe(false);
    expect(validateNoArgs([]).ok).toBe(true);
  });

  it('unregisters on destroy', async () => {
    const { ipc, router } = shellSetup();
    const shell = new FakeWc(33, shellFrame());
    router.registerShell(shell, { windowKey: 'w1' });
    shell.destroy();
    await expect(ipc.invoke(ShellToMain.setMode, ev(shell), 'read')).rejects.toThrow('Refused');
  });
});
