// The IPC guard (9.1 Preload: "Main treats every message from a deck view as written by the page").
//
// A renderer exploit can send any message the preload can, so for every deck channel main:
// - accepts it only from a webContents it registered as a deck, render or diagnostics view, only from that
//   view's main frame, and only while the frame's origin is `blueline://<docId>`;
// - takes the document from the sender's registration, never from the payload;
// - rate-limits per document, view kind and channel: a token bucket per channel with a fixed rate and burst,
//   refilled by the clock (1,000 messages a second, note operations 50 a second with a burst of 100; excess is
//   dropped, invalid messages count too);
// - validates the payload with a strict validator that rebuilds every object field by field (never
//   spreading or assigning the parsed object), drops unknown fields, refuses `__proto__`, `constructor`
//   and `prototype` keys anywhere, and enforces size limits;
// - drops anything that fails, silently to the page.
// Shell channels get the same treatment with their own registration (only a window's shell webContents,
// main frame, origin `app://shell`).
//
// Electron objects are reached through the small *Like interfaces below so unit tests can drive the
// router with fakes.

import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import {
  DeckToMain,
  type AppMode,
  type DetectResult,
  type CollectResult,
  type DiagEvent,
  type FocusState,
  type LinkClick,
  type NodeLocator,
  type NoteOp,
  type NoteOpMark,
  type PreloadMode,
  type RenderReply,
  type SlideState,
  type WalkBlock,
  type WalkNode,
} from '@blueline/core/ipc';
import type { EditPick, MarkShape, MarkTool, SlideNavKind } from '@blueline/core/types';
import {
  COMMIT_KINDS,
  EDIT_LIMITS,
  EDIT_TOKEN_RE,
  EditDeckToMain,
  PICK_KINDS,
  RUN_ID_RE,
  VERBATIM_WHYS,
  VERSION_RE,
  type EditBegin,
  type EditBusy,
  type EditCandidatesRequest,
  type EditCommit,
  type EditTarget,
  type EditUndoRequest,
} from '@blueline/core/ipc-edit';
import type { CommitResult, VerbatimWhy } from '@blueline/core/edit-commit';
import { SHELL_EDIT_LIMITS } from '@blueline/core/ipc';

// ---------------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------------

/** Size and rate limits (9.1: "for example 64 KB of note text, 200 marks per note, 1,000 messages a second"). */
export const IPC_LIMITS = Object.freeze({
  messagesPerSecond: 1000,
  /** UTF-8 bytes. */
  noteText: 64 * 1024,
  marksPerNote: 200,
  /** UTF-8 bytes of one mark's SVG path. */
  markPath: 16 * 1024,
  targetsPerMark: 50,
  targetCss: 2 * 1024,
  targetText: 2 * 1024,
  url: 16 * 1024,
  clientId: 64,
  slides: 10_000,
  slideTitle: 1024,
  diagKeys: 32,
  diagString: 4 * 1024,
  renderError: 4 * 1024,
  /** Generic JSON (a render reply's result): nesting depth, values, and total string length. */
  jsonDepth: 16,
  jsonValues: 1_000_000,
  jsonChars: 64 * 1024 * 1024,
  jsonString: 4 * 1024 * 1024,
  walkNodes: 200_000,
  walkText: 1024 * 1024,
  cssPath: 8 * 1024,
});

// ---------------------------------------------------------------------------------------------------
// Validation primitives
// ---------------------------------------------------------------------------------------------------

export type Validated<T> = { ok: true; value: T } | { ok: false; why: string };
/** Validates one deck message payload and returns a freshly built value. */
export type Validator<T> = (payload: unknown) => Validated<T>;

/** Thrown inside validators to abort; caught by run(). Never escapes this module. */
class Invalid extends Error {}

function fail(why: string): never {
  throw new Invalid(why);
}

function run<T>(build: () => T): Validated<T> {
  try {
    return { ok: true, value: build() };
  } catch (e) {
    if (e instanceof Invalid) return { ok: false, why: e.message };
    return { ok: false, why: 'invalid' };
  }
}

const POISON = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * A plain record from the payload, with every own key checked. Refuses anything that is not a plain
 * object (arrays, Maps, Dates, class instances), any poisoned key, and accessor properties. Returns a
 * reader that gives own data values only, so prototype properties are never read.
 */
function record(v: unknown, what: string): (key: string) => unknown {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) fail(`${what}: not an object`);
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) fail(`${what}: not a plain object`);
  for (const k of Reflect.ownKeys(v as object)) {
    if (typeof k !== 'string') fail(`${what}: symbol key`);
    if (POISON.has(k)) fail(`${what}: forbidden key ${k}`);
  }
  return (key: string) => {
    const d = Object.getOwnPropertyDescriptor(v, key);
    if (!d) return undefined;
    if (!('value' in d)) fail(`${what}.${key}: accessor`);
    return d.value;
  };
}

function list(v: unknown, max: number, what: string): readonly unknown[] {
  if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype) fail(`${what}: not an array`);
  if (v.length > max) fail(`${what}: more than ${max} items`);
  for (const k of Reflect.ownKeys(v)) {
    if (typeof k !== 'string') fail(`${what}: symbol key`);
    if (POISON.has(k)) fail(`${what}: forbidden key ${k}`);
  }
  return v;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** UTF-8 byte length without allocating, for limits in bytes. */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

/** A string of at most `maxBytes` UTF-8 bytes, well-formed (no lone surrogates). */
function str(v: unknown, maxBytes: number, what: string): string {
  if (typeof v !== 'string') fail(`${what}: not a string`);
  // Every UTF-16 unit is at least one UTF-8 byte: a cheap first cut before counting.
  if (v.length > maxBytes || utf8Length(v) > maxBytes) fail(`${what}: longer than ${maxBytes} bytes`);
  if (LONE_SURROGATE.test(v)) fail(`${what}: lone surrogate`);
  return v;
}

/** A string `str` would accept: at most `maxBytes` UTF-8 bytes, no lone surrogates. */
function keepable(v: string, maxBytes: number): boolean {
  return v.length <= maxBytes && utf8Length(v) <= maxBytes && !LONE_SURROGATE.test(v);
}

function int(v: unknown, min: number, max: number, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) fail(`${what}: not an integer in ${min}..${max}`);
  return v;
}

function num(v: unknown, what: string, min = -1e9, max = 1e9): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(`${what}: not a finite number`);
  return v;
}

function bool(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') fail(`${what}: not a boolean`);
  return v;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) fail(`${what}: not one of ${allowed.join(', ')}`);
  return v as T;
}

function matching(v: unknown, re: RegExp, maxLen: number, what: string): string {
  if (typeof v !== 'string' || v.length > maxLen || !re.test(v)) fail(`${what}: bad format`);
  return v;
}

// ---------------------------------------------------------------------------------------------------
// Deck channel validators (one per DeckToMain channel)
// ---------------------------------------------------------------------------------------------------

/** `^([a-z0-9-]{1,40}:)?n-[0-9]{4,6}$` (section 8, Notes inside the file: Ids). */
export const NOTE_ID = /^(?:[a-z0-9-]{1,40}:)?n-[0-9]{4,6}$/;
const CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const STAMP = /^bl-[0-9]{1,9}$/;
/** SVG path data uses only commands, numbers, separators and whitespace. */
const SVG_PATH = /^[MmZzLlHhVvCcSsQqTtAa0-9eE.,+\- \t\r\n]*$/;
const ROLE = /^[a-z-]{1,32}$/;

const MARK_TOOLS: readonly MarkTool[] = ['pen', 'highlighter', 'arrow', 'pin', 'box'];
const MARK_SHAPES: readonly MarkShape[] = ['ellipse', 'freehand', 'underline', 'strike', 'rect'];
const SLIDE_KINDS: readonly SlideState['kind'][] = ['reveal', 'generic', 'scroll', 'single'];
const NAV_KINDS: readonly SlideNavKind[] = ['hash', 'reveal', 'index', 'scroll', 'none'];
const DIAG_EVENTS: readonly DiagEvent['event'][] = [
  'key-order',
  'stop-propagation',
  'beforeinput',
  'paste',
  'card-input',
  'heading-input',
  'mark-added',
  'shortcut',
  'mode-change',
  'deck-moved',
];

/** DeckToMain.ready: carries nothing main uses. Accepts no payload, null, or a plain object (ignored). */
export const validateReady: Validator<Record<string, never>> = (p) =>
  run(() => {
    if (p !== undefined && p !== null) record(p, 'ready');
    return {};
  });

/** DeckToMain.focus: FocusState. */
export const validateFocus: Validator<FocusState> = (p) =>
  run(() => {
    const r = record(p, 'focus');
    return { textField: bool(r('textField'), 'focus.textField') };
  });

/** DeckToMain.link: LinkClick. The href must parse as a URL; main still shows its own dialog. */
export const validateLink: Validator<LinkClick> = (p) =>
  run(() => {
    const r = record(p, 'link');
    const href = str(r('href'), IPC_LIMITS.url, 'link.href');
    if (!URL.canParse(href)) fail('link.href: not a URL');
    return { href };
  });

/**
 * The DOM `key` values the deck preload reports as having moved the deck (slide-watcher.ts NAV_KEYS; 6.7 Index
 * replay). Anything else in SlideState.deckNav refuses the message.
 */
export const DECK_NAV_KEYS: readonly string[] = Object.freeze(['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', ' ']);

/**
 * One optional per-slide array of SlideState (hashes, revealIndices, ids). The preload builds each from the
 * slide list, so its length is `count`: an array of another length (or past the slide cap) is dropped
 * without reading it. A matching array is rebuilt item by item; a malformed item refuses the message.
 */
function perSlide<T>(v: unknown, count: number, what: string, item: (x: unknown, what: string) => T): T[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype) fail(`${what}: not an array`);
  if (v.length !== count || v.length > IPC_LIMITS.slides) return undefined;
  return list(v, IPC_LIMITS.slides, what).map((x, i) => item(x, `${what}[${i}]`));
}

/**
 * DeckToMain.slides: SlideState. The optional fields are what main builds each note's SlideRef from (section 8:
 * the element id or hash, and nav.value as the hash or reveal's [h, v]; 9.4) and what it learns Session.deckNav
 * from (6.7 Index replay), so they are kept, rebuilt field by field like the rest.
 */
export const validateSlides: Validator<SlideState> = (p) =>
  run(() => {
    const r = record(p, 'slides');
    const titles = list(r('titles'), IPC_LIMITS.slides, 'slides.titles').map((t, i) => str(t, IPC_LIMITS.slideTitle, `slides.titles[${i}]`));
    const out: SlideState = {
      kind: oneOf(r('kind'), SLIDE_KINDS, 'slides.kind'),
      count: int(r('count'), 0, IPC_LIMITS.slides, 'slides.count'),
      current: int(r('current'), 0, IPC_LIMITS.slides, 'slides.current'),
      titles,
      navKind: oneOf(r('navKind'), NAV_KINDS, 'slides.navKind'),
    };
    // Element ids and hashes come from the page's own markup, so a string the guard cannot keep (longer than a
    // title, a lone surrogate) is not a forgery: that id becomes null, and hashes are dropped as a whole (hash
    // navigation needs every slide's hash, 9.4 step 2). A value of another type refuses the message.
    const hashes = perSlide(r('hashes'), out.count, 'slides.hashes', (h, w) => {
      if (typeof h !== 'string') fail(`${w}: not a string`);
      return keepable(h, IPC_LIMITS.slideTitle) && h.startsWith('#') ? h : null;
    });
    if (hashes && hashes.every((h): h is string => h !== null)) out.hashes = hashes;
    const revealIndices = perSlide(r('revealIndices'), out.count, 'slides.revealIndices', (pair, w) => {
      const a = list(pair, 2, w);
      if (a.length !== 2) fail(`${w}: not a pair`);
      return [int(a[0], 0, IPC_LIMITS.slides, `${w}[0]`), int(a[1], 0, IPC_LIMITS.slides, `${w}[1]`)] as [number, number];
    });
    if (revealIndices) out.revealIndices = revealIndices;
    const ids = perSlide(r('ids'), out.count, 'slides.ids', (id, w) => {
      if (id === null) return null;
      if (typeof id !== 'string') fail(`${w}: not a string or null`);
      return keepable(id, IPC_LIMITS.slideTitle) ? id : null;
    });
    if (ids) out.ids = ids;
    const navRaw = r('deckNav');
    if (navRaw !== undefined) {
      const nr = record(navRaw, 'slides.deckNav');
      const nav: { forward?: string; back?: string } = {};
      const forward = nr('forward');
      if (forward !== undefined) nav.forward = oneOf(forward, DECK_NAV_KEYS, 'slides.deckNav.forward');
      const back = nr('back');
      if (back !== undefined) nav.back = oneOf(back, DECK_NAV_KEYS, 'slides.deckNav.back');
      if (nav.forward !== undefined || nav.back !== undefined) out.deckNav = nav;
    }
    return out;
  });

/** DeckToMain.mode: `{ mode: 'read' }`, the only mode a deck may ask for (6.2). */
export const validateMode: Validator<{ mode: 'read' }> = (p) =>
  run(() => {
    const r = record(p, 'mode');
    return { mode: oneOf(r('mode'), ['read'] as const, 'mode.mode') };
  });

function noteOpMark(v: unknown, i: number): NoteOpMark {
  const what = `marks[${i}]`;
  const r = record(v, what);
  const tool = oneOf(r('tool'), MARK_TOOLS, `${what}.tool`);
  const shapeRaw = r('shape');
  const path = str(r('path'), IPC_LIMITS.markPath, `${what}.path`);
  if (!SVG_PATH.test(path)) fail(`${what}.path: not SVG path data`);
  const targets = list(r('targets'), IPC_LIMITS.targetsPerMark, `${what}.targets`).map((t, j) => {
    const tw = `${what}.targets[${j}]`;
    const tr = record(t, tw);
    const stamp = tr('stamp');
    return {
      css: str(tr('css'), IPC_LIMITS.targetCss, `${tw}.css`),
      text: str(tr('text'), IPC_LIMITS.targetText, `${tw}.text`),
      role: matching(tr('role'), ROLE, 32, `${tw}.role`),
      stamp: stamp === null ? null : matching(stamp, STAMP, 12, `${tw}.stamp`),
    };
  });
  const mark: NoteOpMark = { tool, path, targets };
  if (shapeRaw !== undefined) mark.shape = oneOf(shapeRaw, MARK_SHAPES, `${what}.shape`);
  return mark;
}

function marks(v: unknown): NoteOpMark[] {
  return list(v, IPC_LIMITS.marksPerNote, 'marks').map(noteOpMark);
}

/**
 * DeckToMain.note: NoteOp. Ids must match the note id format; main decides whether the note is this
 * document's own and whether the transition is allowed (6.6). The deck never sets status, author or time.
 */
export const validateNote: Validator<NoteOp> = (p) =>
  run((): NoteOp => {
    const r = record(p, 'note');
    const op = oneOf(r('op'), ['create', 'update', 'close', 'delete'] as const, 'note.op');
    switch (op) {
      case 'create': {
        const slide = r('slide');
        return {
          op,
          clientId: matching(r('clientId'), CLIENT_ID, IPC_LIMITS.clientId, 'note.clientId'),
          text: str(r('text'), IPC_LIMITS.noteText, 'note.text'),
          marks: marks(r('marks')),
          slide: slide === null ? null : int(slide, 0, IPC_LIMITS.slides, 'note.slide'),
        };
      }
      case 'update': {
        const out: { op: 'update'; id: string; text?: string; marks?: NoteOpMark[] } = {
          op,
          id: matching(r('id'), NOTE_ID, 48, 'note.id'),
        };
        const text = r('text');
        if (text !== undefined) out.text = str(text, IPC_LIMITS.noteText, 'note.text');
        const m = r('marks');
        if (m !== undefined) out.marks = marks(m);
        return out;
      }
      case 'close':
      case 'delete':
        return { op, id: matching(r('id'), NOTE_ID, 48, 'note.id') };
    }
  });

/** DeckToMain.diag: DiagEvent. `data` keeps only primitive values under simple keys. */
export const validateDiag: Validator<DiagEvent> = (p) =>
  run(() => {
    const r = record(p, 'diag');
    const event = oneOf(r('event'), DIAG_EVENTS, 'diag.event');
    const raw = r('data');
    const dr = record(raw, 'diag.data');
    const keys = Object.keys(raw as object);
    if (keys.length > IPC_LIMITS.diagKeys) fail('diag.data: too many keys');
    const data: Record<string, unknown> = {};
    for (const k of keys) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k)) fail('diag.data: bad key');
      const v = dr(k);
      if (v === null || typeof v === 'boolean') data[k] = v;
      else if (typeof v === 'number') data[k] = num(v, `diag.data.${k}`, -Number.MAX_VALUE, Number.MAX_VALUE);
      else if (typeof v === 'string') data[k] = str(v, IPC_LIMITS.diagString, `diag.data.${k}`);
      else fail(`diag.data.${k}: not a primitive`);
    }
    return { event, data };
  });

/**
 * A JSON-like value rebuilt from scratch: null, booleans, finite numbers, strings, arrays and plain
 * objects only, with depth, count and size budgets. Anything else (functions cannot arrive over IPC, but
 * Dates, Maps, typed arrays and Errors can) is refused.
 */
export function sanitizeJson(v: unknown, limits: { depth?: number; values?: number; chars?: number; string?: number } = {}): Validated<unknown> {
  const maxDepth = limits.depth ?? IPC_LIMITS.jsonDepth;
  const maxString = limits.string ?? IPC_LIMITS.jsonString;
  let values = limits.values ?? IPC_LIMITS.jsonValues;
  let chars = limits.chars ?? IPC_LIMITS.jsonChars;
  const walk = (x: unknown, depth: number, what: string): unknown => {
    if (--values < 0) fail('json: too many values');
    if (x === null || typeof x === 'boolean') return x;
    if (typeof x === 'number') return num(x, what, -Number.MAX_VALUE, Number.MAX_VALUE);
    if (typeof x === 'string') {
      if (x.length > maxString) fail(`${what}: string too long`);
      chars -= x.length;
      if (chars < 0) fail('json: too much text');
      return x;
    }
    if (depth >= maxDepth) fail('json: too deep');
    if (Array.isArray(x)) {
      const a = list(x, values, what);
      const out: unknown[] = new Array(a.length);
      for (let i = 0; i < a.length; i++) out[i] = walk(a[i], depth + 1, `${what}[${i}]`);
      return out;
    }
    const r = record(x, what);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(x as object)) {
      chars -= k.length;
      if (chars < 0) fail('json: too much text');
      // record() refused poisoned keys, so plain assignment cannot reach a prototype.
      out[k] = walk(r(k), depth + 1, `${what}.${k}`);
    }
    return out;
  };
  return run(() => walk(v, 0, 'json'));
}

/**
 * DeckToMain.renderReply: RenderReply. `result` is sanitized as generic JSON here; the render service
 * then applies the validator for the command it asked (validateDetectResult, validateCollectResult).
 */
export const validateRenderReply: Validator<RenderReply> = (p) =>
  run(() => {
    const r = record(p, 'renderReply');
    const out: RenderReply = {
      reqId: int(r('reqId'), 0, Number.MAX_SAFE_INTEGER, 'renderReply.reqId'),
      ok: bool(r('ok'), 'renderReply.ok'),
    };
    const error = r('error');
    if (error !== undefined) out.error = str(error, IPC_LIMITS.renderError, 'renderReply.error');
    const result = r('result');
    if (result !== undefined) {
      const s = sanitizeJson(result);
      if (!s.ok) fail(`renderReply.result: ${s.why}`);
      out.result = s.value;
    }
    return out;
  });

function rect(v: unknown, what: string): { x: number; y: number; w: number; h: number } {
  const r = record(v, what);
  return { x: num(r('x'), `${what}.x`), y: num(r('y'), `${what}.y`), w: num(r('w'), `${what}.w`), h: num(r('h'), `${what}.h`) };
}

function stampOrNull(v: unknown, what: string): string | null {
  return v === null ? null : matching(v, STAMP, 12, what);
}

function locator(v: unknown, what: string): NodeLocator {
  const r = record(v, what);
  return {
    stamp: stampOrNull(r('stamp'), `${what}.stamp`),
    cssPath: str(r('cssPath'), IPC_LIMITS.cssPath, `${what}.cssPath`),
    childIndex: int(r('childIndex'), 0, 1_000_000, `${what}.childIndex`),
  };
}

/** The `detect` command's result (DetectResult). */
export const validateDetectResult: Validator<DetectResult> = (p) =>
  run(() => {
    const r = record(p, 'detect');
    const ds = record(r('designSize'), 'detect.designSize');
    const out: DetectResult = {
      kind: oneOf(r('kind'), SLIDE_KINDS, 'detect.kind'),
      count: int(r('count'), 0, IPC_LIMITS.slides, 'detect.count'),
      current: int(r('current'), 0, IPC_LIMITS.slides, 'detect.current'),
      titles: list(r('titles'), IPC_LIMITS.slides, 'detect.titles').map((t, i) => str(t, IPC_LIMITS.slideTitle, `detect.titles[${i}]`)),
      navKind: oneOf(r('navKind'), NAV_KINDS, 'detect.navKind'),
      designSize: { w: num(ds('w'), 'detect.designSize.w', 1, 100_000), h: num(ds('h'), 'detect.designSize.h', 1, 100_000) },
    };
    const ri = r('revealIndices');
    if (ri !== undefined) {
      out.revealIndices = list(ri, IPC_LIMITS.slides, 'detect.revealIndices').map((pair, i) => {
        const a = list(pair, 2, `detect.revealIndices[${i}]`);
        if (a.length !== 2) fail(`detect.revealIndices[${i}]: not a pair`);
        return [int(a[0], 0, IPC_LIMITS.slides, 'h'), int(a[1], 0, IPC_LIMITS.slides, 'v')] as [number, number];
      });
    }
    return out;
  });

/** The `collect` command's result (CollectResult). */
export const validateCollectResult: Validator<CollectResult> = (p) =>
  run(() => {
    const r = record(p, 'collect');
    const nodes: WalkNode[] = list(r('nodes'), IPC_LIMITS.walkNodes, 'collect.nodes').map((n, i) => {
      const w = `collect.nodes[${i}]`;
      const nr = record(n, w);
      const dn = record(nr('node'), `${w}.node`);
      return {
        key: int(nr('key'), 0, Number.MAX_SAFE_INTEGER, `${w}.key`),
        locator: locator(nr('locator'), `${w}.locator`),
        node: {
          stamp: stampOrNull(dn('stamp'), `${w}.node.stamp`),
          textIndex: int(dn('textIndex'), -1, 1_000_000, `${w}.node.textIndex`),
          data: str(dn('data'), IPC_LIMITS.walkText, `${w}.node.data`),
        },
        rect: rect(nr('rect'), `${w}.rect`),
      };
    });
    const blocks: WalkBlock[] = list(r('blocks'), IPC_LIMITS.walkNodes, 'collect.blocks').map((b, i) => {
      const w = `collect.blocks[${i}]`;
      const br = record(b, w);
      return {
        key: int(br('key'), 0, Number.MAX_SAFE_INTEGER, `${w}.key`),
        hasInline: bool(br('hasInline'), `${w}.hasInline`),
        nodeKeys: list(br('nodeKeys'), IPC_LIMITS.walkNodes, `${w}.nodeKeys`).map((k, j) => int(k, 0, Number.MAX_SAFE_INTEGER, `${w}.nodeKeys[${j}]`)),
      };
    });
    return { nodes, blocks };
  });

// ---------------------------------------------------------------------------------------------------
// Edit channels (Phase 2; core/ipc-edit.ts; P2-7)
// ---------------------------------------------------------------------------------------------------
//
// None of them names a path, a write record or a file offset (9.1): a field id the preload counts, the version its
// page shows, run ids of that version's map (format only: the handler checks they exist in that version and were
// the field's), texts with the EDIT_LIMITS byte limits, a token main issued. Whether a message is taken at all
// (Edit mode, editing allowed, capabilities.edit, trusted input) is the handler's decision, made at that moment.

function fieldId(v: unknown, what: string): number {
  return int(v, 0, EDIT_LIMITS.fieldId, what);
}

function version(v: unknown, what: string): string {
  return matching(v, VERSION_RE, 64, what);
}

function runId(v: unknown, what: string): string {
  return matching(v, RUN_ID_RE, EDIT_LIMITS.runId, what);
}

/** A list of distinct run ids (duplicates are dropped; the order is kept). */
function runIds(v: unknown, max: number, what: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  list(v, max, what).forEach((x, i) => {
    const id = runId(x, `${what}[${i}]`);
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  });
  return out;
}

function editText(v: unknown, what: string): string {
  return str(v, EDIT_LIMITS.text, what);
}

function editTarget(v: unknown, what: string): EditTarget {
  const r = record(v, what);
  const stamp = r('stamp');
  return {
    // The overlay sends '' when the element's path is too long to keep (dom-walk cssPath).
    css: str(r('css'), EDIT_LIMITS.targetCss, `${what}.css`),
    text: str(r('text'), EDIT_LIMITS.targetText, `${what}.text`),
    role: matching(r('role'), ROLE, EDIT_LIMITS.targetRole, `${what}.role`),
    stamp: stamp === null ? null : matching(stamp, STAMP, 12, `${what}.stamp`),
  };
}

function commitResult(v: unknown, what: string): CommitResult {
  const r = record(v, what);
  const kind = oneOf(r('kind'), COMMIT_KINDS, `${what}.kind`);
  if (kind === 'noop') return { kind };
  if (kind === 'verbatim') {
    return {
      kind,
      before: editText(r('before'), `${what}.before`),
      after: editText(r('after'), `${what}.after`),
      why: oneOf(r('why'), VERBATIM_WHYS as readonly VerbatimWhy[], `${what}.why`),
    };
  }
  return {
    kind,
    runId: runId(r('runId'), `${what}.runId`),
    beforeText: editText(r('beforeText'), `${what}.beforeText`),
    afterText: editText(r('afterText'), `${what}.afterText`),
  };
}

/** EditDeckToMain.begin: EditBegin. */
export const validateEditBegin: Validator<EditBegin> = (p) =>
  run(() => {
    const r = record(p, 'begin');
    return {
      fieldId: fieldId(r('fieldId'), 'begin.fieldId'),
      version: version(r('version'), 'begin.version'),
      runIds: runIds(r('runIds'), EDIT_LIMITS.runIds, 'begin.runIds'),
    };
  });

/** EditDeckToMain.commit: EditCommit. A pick goes only with an edit (it says how that edit's run was chosen). */
export const validateEditCommit: Validator<EditCommit> = (p) =>
  run(() => {
    const r = record(p, 'commit');
    const result = commitResult(r('result'), 'commit.result');
    const slide = r('slide');
    const out: EditCommit = {
      fieldId: fieldId(r('fieldId'), 'commit.fieldId'),
      version: version(r('version'), 'commit.version'),
      result,
      target: editTarget(r('target'), 'commit.target'),
      slide: slide === null ? null : int(slide, 0, EDIT_LIMITS.slide - 1, 'commit.slide'),
      alsoPlaces: int(r('alsoPlaces'), 0, EDIT_LIMITS.alsoPlaces, 'commit.alsoPlaces'),
    };
    const pick = r('pick');
    if (pick !== undefined) {
      if (result.kind !== 'edit') fail('commit.pick: only with an edit');
      const pr = record(pick, 'commit.pick');
      const kind: EditPick['kind'] = oneOf(pr('kind'), PICK_KINDS, 'commit.pick.kind');
      out.pick = { kind, nodeBefore: editText(pr('nodeBefore'), 'commit.pick.nodeBefore'), nodeAfter: editText(pr('nodeAfter'), 'commit.pick.nodeAfter') };
    }
    return out;
  });

/** EditDeckToMain.candidates: EditCandidatesRequest. */
export const validateEditCandidates: Validator<EditCandidatesRequest> = (p) =>
  run(() => {
    const r = record(p, 'candidates');
    return {
      fieldId: fieldId(r('fieldId'), 'candidates.fieldId'),
      version: version(r('version'), 'candidates.version'),
      runIds: runIds(r('runIds'), EDIT_LIMITS.candidates, 'candidates.runIds'),
    };
  });

/** EditDeckToMain.undo: EditUndoRequest (a token main issued; the record stays in main, P2-7). */
export const validateEditUndo: Validator<EditUndoRequest> = (p) =>
  run(() => {
    const r = record(p, 'undo');
    return { token: matching(r('token'), EDIT_TOKEN_RE, EDIT_LIMITS.token, 'undo.token') };
  });

/** EditDeckToMain.busy: EditBusy. */
export const validateEditBusy: Validator<EditBusy> = (p) =>
  run(() => {
    const r = record(p, 'busy');
    return { edit: bool(r('edit'), 'busy.edit'), committing: bool(r('committing'), 'busy.committing') };
  });

/** The validator for each DeckToMain channel (the edit channels included, Phase 2). */
export const DECK_VALIDATORS = Object.freeze({
  [DeckToMain.ready]: validateReady,
  [DeckToMain.focus]: validateFocus,
  [DeckToMain.link]: validateLink,
  [DeckToMain.slides]: validateSlides,
  [DeckToMain.mode]: validateMode,
  [DeckToMain.note]: validateNote,
  [DeckToMain.diag]: validateDiag,
  [DeckToMain.renderReply]: validateRenderReply,
  [EditDeckToMain.begin]: validateEditBegin,
  [EditDeckToMain.commit]: validateEditCommit,
  [EditDeckToMain.candidates]: validateEditCandidates,
  [EditDeckToMain.undo]: validateEditUndo,
  [EditDeckToMain.busy]: validateEditBusy,
} as const);

/**
 * Which view kinds may use each DeckToMain channel by default. The edit channels are the visible deck's: a render
 * view has no UI, and the Diagnostics deck may only ask (its commit and picker requests are answered "refused" and
 * "nothing", never written: diagnostics.ts).
 */
export const DECK_CHANNEL_KINDS: Readonly<Record<string, readonly PreloadMode[]>> = Object.freeze({
  [DeckToMain.ready]: ['deck', 'render', 'diagnostics'],
  [DeckToMain.focus]: ['deck', 'diagnostics'],
  [DeckToMain.link]: ['deck', 'diagnostics'],
  [DeckToMain.slides]: ['deck', 'diagnostics'],
  [DeckToMain.mode]: ['deck', 'diagnostics'],
  [DeckToMain.note]: ['deck', 'diagnostics'],
  [DeckToMain.diag]: ['diagnostics'],
  [DeckToMain.renderReply]: ['render'],
  [EditDeckToMain.begin]: ['deck'],
  [EditDeckToMain.commit]: ['deck', 'diagnostics'],
  [EditDeckToMain.candidates]: ['deck', 'diagnostics'],
  [EditDeckToMain.undo]: ['deck'],
  [EditDeckToMain.busy]: ['deck'],
});

// ---------------------------------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------------------------------

/** A token bucket's fixed refill rate (tokens a second) and burst (the most it holds). */
export interface RateSpec {
  perSecond: number;
  burst: number;
}

/** Deck channels without an entry in DECK_CHANNEL_RATES: 9.1's 1,000 messages a second, a second's worth of burst. */
export const DEFAULT_DECK_RATE: Readonly<RateSpec> = Object.freeze({ perSecond: IPC_LIMITS.messagesPerSecond, burst: IPC_LIMITS.messagesPerSecond });

/**
 * Per channel limits (DeckIpc), each per document and view kind. A note operation is the one deck message that
 * grows what main keeps (a note in session.json) and costs main more as the notes add up, so it has a limit of
 * its own, far above what a person does: card text is sent at most every 300 ms (preload notes.ts
 * SAVE_DEBOUNCE_MS, about 3 a second however fast the typing), and a drawing sends one operation per finished
 * stroke (about 10 a second at most); 50 a second with a burst of 100 leaves five times that, and a flood of
 * note creates gets at most 100 plus 50 a second through, however slowly main gets to the messages.
 */
export const DECK_CHANNEL_RATES: Readonly<Record<string, Readonly<RateSpec>>> = Object.freeze({
  [DeckToMain.note]: Object.freeze({ perSecond: 50, burst: 100 }),
});

/** Milliseconds from a monotonic clock (a wall-clock step back or forward neither stalls nor refills a bucket). */
function monotonicMs(): number {
  const p = (globalThis as { performance?: { now(): number } }).performance;
  return p && typeof p.now === 'function' ? p.now() : Date.now();
}

/**
 * A token bucket per key: `burst` tokens (default `perSecond`), refilled continuously at `perSecond` tokens a
 * second of the clock `now` (monotonic by default). A message without a token is dropped (9.1). The refill is
 * by the time on the clock between two messages, so how many pass in a flood is `burst` plus `perSecond` times
 * the flood's length; a bucket left long enough is full, the same as a new one (forget() loses nothing).
 */
export class RateLimiter {
  private readonly buckets = new Map<string | number, { tokens: number; at: number }>();
  private readonly burst: number;
  constructor(
    private readonly perSecond: number = IPC_LIMITS.messagesPerSecond,
    private readonly now: () => number = monotonicMs,
    burst: number = perSecond,
  ) {
    if (!(Number.isFinite(perSecond) && perSecond > 0)) throw new RangeError('perSecond must be a positive number');
    if (!(Number.isFinite(burst) && burst >= 1)) throw new RangeError('burst must be at least 1');
    this.burst = burst;
  }

  allow(key: string | number): boolean {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.burst, at: t };
      this.buckets.set(key, b);
    } else {
      const elapsed = Math.max(0, t - b.at);
      b.tokens = Math.min(this.burst, b.tokens + (elapsed * this.perSecond) / 1000);
      b.at = t;
    }
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  forget(key: string | number): void {
    this.buckets.delete(key);
  }

  /** Keys with a bucket (tests). */
  get size(): number {
    return this.buckets.size;
  }
}

// ---------------------------------------------------------------------------------------------------
// Routers
// ---------------------------------------------------------------------------------------------------

/** The parts of WebFrameMain the guard reads. */
export interface FrameLike {
  readonly processId: number;
  readonly routingId: number;
  readonly origin: string;
  readonly parent: FrameLike | null;
  readonly detached?: boolean;
}

/** The parts of WebContents the guard reads. */
export interface WebContentsLike {
  readonly id: number;
  readonly mainFrame: FrameLike;
  isDestroyed(): boolean;
  once(event: 'destroyed', listener: () => void): unknown;
}

export interface IpcEventLike {
  sender: WebContentsLike;
  senderFrame: FrameLike | null;
}

/** The parts of ipcMain the routers use (pass Electron's `ipcMain`). */
export interface IpcMainLike {
  on(channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void): unknown;
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown): unknown;
}

export type DeckViewKind = PreloadMode;

/** Who sent a deck message: always from the registration, never from the payload. */
export interface DeckSender {
  docId: string;
  kind: DeckViewKind;
  webContentsId: number;
}

export type DropReason = 'unregistered' | 'frame' | 'origin' | 'kind' | 'rate' | 'args' | 'invalid' | 'handler';

export interface DropInfo {
  channel: string;
  reason: DropReason;
  why?: string;
  webContentsId: number | null;
}

export interface RouterOptions {
  ipcMain: IpcMainLike;
  /**
   * Messages per second: per shell (ShellIpc), and per document, view kind and channel for a deck channel without
   * an entry in `rates` (DeckIpc; default 1,000, with a burst of as many).
   */
  perSecond?: number;
  /** DeckIpc: per channel limits (default DECK_CHANNEL_RATES). */
  rates?: Readonly<Record<string, Readonly<RateSpec>>>;
  /** The clock the buckets refill by, in milliseconds (default monotonic). */
  now?: () => number;
  /** Called for each dropped message (log it, rate-limited by the caller). Never sees payload contents. */
  onDrop?: (d: DropInfo) => void;
}

/**
 * True when `frame` is `wc`'s main frame. WebFrameMain wrappers are not guaranteed to be the same JS
 * object for one frame, so it compares process and routing ids (as Electron documents), and requires a
 * top-level, attached frame.
 */
export function isMainFrameOf(frame: FrameLike | null, wc: WebContentsLike): boolean {
  if (!frame || frame.detached === true || frame.parent !== null) return false;
  const main = wc.mainFrame;
  if (!main) return false;
  return frame === main || (frame.processId === main.processId && frame.routingId === main.routingId);
}

/** The rate-limit key of a document's views of one kind. */
function bucketKey(docId: string, kind: DeckViewKind): string {
  return `${kind}:${docId}`;
}

/**
 * The deck IPC router. main creates one, registers every deck, render and diagnostics webContents right
 * after creating it (before loading), and declares each DeckToMain channel once with `on`.
 */
export class DeckIpc {
  private readonly views = new Map<number, { wc: WebContentsLike; docId: string; kind: DeckViewKind }>();
  /**
   * One token bucket per document, view kind and channel (a limiter per channel, keyed by document and kind): the
   * render views of one document share theirs, and a flood on one channel takes no token from another.
   */
  private readonly limiters = new Map<string, RateLimiter>();
  private readonly rates: Readonly<Record<string, Readonly<RateSpec>>>;
  private readonly fallbackRate: Readonly<RateSpec>;
  private readonly now?: () => number;
  private readonly ipcMain: IpcMainLike;
  private readonly onDrop?: (d: DropInfo) => void;
  private readonly channels = new Set<string>();

  constructor(opts: RouterOptions) {
    this.ipcMain = opts.ipcMain;
    this.rates = opts.rates ?? DECK_CHANNEL_RATES;
    this.fallbackRate = opts.perSecond !== undefined ? { perSecond: opts.perSecond, burst: opts.perSecond } : DEFAULT_DECK_RATE;
    this.now = opts.now;
    this.onDrop = opts.onDrop;
  }

  /** The channel's limit (DECK_CHANNEL_RATES, else 1,000 a second). */
  rateOf(channel: string): Readonly<RateSpec> {
    return Object.prototype.hasOwnProperty.call(this.rates, channel) ? this.rates[channel] : this.fallbackRate;
  }

  private limiterFor(channel: string): RateLimiter {
    let l = this.limiters.get(channel);
    if (!l) {
      const r = this.rateOf(channel);
      l = new RateLimiter(r.perSecond, this.now, r.burst);
      this.limiters.set(channel, l);
    }
    return l;
  }

  /**
   * Registers a webContents main created as a deck, render or diagnostics view of document `docId`.
   * Registering again (for example after the view follows a saved copy) replaces the document.
   */
  registerDeckView(wc: WebContentsLike, info: { docId: string; kind: DeckViewKind }): void {
    if (!/^[0-9a-f]{8,64}$/.test(info.docId)) throw new Error('invalid docId');
    if (!['deck', 'render', 'diagnostics'].includes(info.kind)) throw new Error('invalid kind');
    const before = this.views.get(wc.id);
    const fresh = !before;
    this.views.set(wc.id, { wc, docId: info.docId, kind: info.kind });
    if (before && (before.docId !== info.docId || before.kind !== info.kind)) this.forgetIfUnused(before.docId, before.kind);
    if (fresh) wc.once('destroyed', () => this.unregisterDeckView(wc));
  }

  unregisterDeckView(wc: WebContentsLike): void {
    const v = this.views.get(wc.id);
    if (!v || v.wc !== wc) return;
    this.views.delete(wc.id);
    this.forgetIfUnused(v.docId, v.kind);
  }

  /** Drops the buckets of a document's view kind once no registered view of it is left (a full bucket is a new one). */
  private forgetIfUnused(docId: string, kind: DeckViewKind): void {
    for (const v of this.views.values()) if (v.docId === docId && v.kind === kind) return;
    const key = bucketKey(docId, kind);
    for (const l of this.limiters.values()) l.forget(key);
  }

  /**
   * The registered sender of an event, if it passes every sender check: a registered, live webContents;
   * its main frame; origin `blueline://<docId>`. Null otherwise (with the reason in `out`).
   */
  check(event: IpcEventLike, out?: { reason?: DropReason }): DeckSender | null {
    const wc = event.sender;
    const v = wc ? this.views.get(wc.id) : undefined;
    if (!v || v.wc !== wc || wc.isDestroyed()) {
      if (out) out.reason = 'unregistered';
      return null;
    }
    const frame = event.senderFrame;
    if (!isMainFrameOf(frame, wc)) {
      if (out) out.reason = 'frame';
      return null;
    }
    if (frame!.origin !== `blueline://${v.docId}`) {
      if (out) out.reason = 'origin';
      return null;
    }
    return { docId: v.docId, kind: v.kind, webContentsId: wc.id };
  }

  /**
   * Declares a deck channel. A message reaches `handler` only if the sender passes check(), its view kind
   * is in `kinds` (default DECK_CHANNEL_KINDS[channel], else deck and diagnostics), it is within the rate
   * limit, it has at most one argument, and `validate` accepts that argument.
   */
  on<T>(channel: string, validate: Validator<T>, handler: (from: DeckSender, payload: T) => void, opts: { kinds?: readonly DeckViewKind[] } = {}): void {
    if (this.channels.has(channel)) throw new Error(`deck channel ${channel} declared twice`);
    this.channels.add(channel);
    const kinds =
      opts.kinds ??
      (Object.prototype.hasOwnProperty.call(DECK_CHANNEL_KINDS, channel) ? DECK_CHANNEL_KINDS[channel] : (['deck', 'diagnostics'] as const));
    this.ipcMain.on(channel, (event: IpcMainEvent, ...args: unknown[]) => {
      this.dispatch(channel, kinds, validate, handler, event as unknown as IpcEventLike, args);
    });
  }

  /** The listener body, exposed for tests. */
  dispatch<T>(
    channel: string,
    kinds: readonly DeckViewKind[],
    validate: Validator<T>,
    handler: (from: DeckSender, payload: T) => void,
    event: IpcEventLike,
    args: readonly unknown[],
  ): void {
    const wcId = event?.sender?.id ?? null;
    const out: { reason?: DropReason } = {};
    const from = this.check(event, out);
    if (!from) return this.drop(channel, out.reason ?? 'unregistered', wcId);
    // Count every message from a registered sender, valid or not, so a flood of junk is throttled too.
    if (!this.limiterFor(channel).allow(bucketKey(from.docId, from.kind))) return this.drop(channel, 'rate', wcId);
    if (!kinds.includes(from.kind)) return this.drop(channel, 'kind', wcId);
    if (args.length > 1) return this.drop(channel, 'args', wcId);
    const v = validate(args[0]);
    if (!v.ok) return this.drop(channel, 'invalid', wcId, v.why);
    try {
      handler(from, v.value);
    } catch (e) {
      this.drop(channel, 'handler', wcId, e instanceof Error ? e.message : 'error');
    }
  }

  private drop(channel: string, reason: DropReason, webContentsId: number | null, why?: string): void {
    try {
      this.onDrop?.({ channel, reason, why, webContentsId });
    } catch {
      // logging never decides
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// Shell channels
// ---------------------------------------------------------------------------------------------------

/** Validates the argument list of one shell call (`ipcRenderer.invoke(channel, ...args)`). */
export type ArgsValidator<T> = (args: readonly unknown[]) => Validated<T>;

/** A shell call with no arguments. */
export const validateNoArgs: ArgsValidator<null> = (args) => (args.length === 0 ? { ok: true, value: null } : { ok: false, why: 'unexpected arguments' });

/** ShellToMain.setMode(mode). */
export const validateSetMode: ArgsValidator<AppMode> = (args) =>
  run(() => {
    if (args.length !== 1) fail('one argument');
    return oneOf(args[0], ['read', 'review', 'edit'] as const, 'mode');
  });

/** ShellToMain.diagRecord(stepId, result, detail?). */
export const validateDiagRecord: ArgsValidator<{ stepId: string; result: 'pass' | 'fail' | 'skip'; detail?: string }> = (args) =>
  run(() => {
    if (args.length < 2 || args.length > 3) fail('two or three arguments');
    const out: { stepId: string; result: 'pass' | 'fail' | 'skip'; detail?: string } = {
      stepId: matching(args[0], /^[A-Za-z0-9_-]{1,64}$/, 64, 'stepId'),
      result: oneOf(args[1], ['pass', 'fail', 'skip'] as const, 'result'),
    };
    if (args.length === 3 && args[2] !== undefined) out.detail = str(args[2], IPC_LIMITS.diagString, 'detail');
    return out;
  });

/** ShellToMain.toastAction(token, actionId) (Phase 2, P2-14). */
export const validateToastAction: ArgsValidator<{ token: string; actionId: string }> = (args) =>
  run(() => {
    if (args.length !== 2) fail('two arguments');
    return {
      token: matching(args[0], SHELL_EDIT_LIMITS.toastToken, 32, 'token'),
      actionId: matching(args[1], SHELL_EDIT_LIMITS.toastAction, 32, 'actionId'),
    };
  });

/** ShellToMain.copyNote(noteId) (P2-13). */
export const validateNoteIdArg: ArgsValidator<string> = (args) =>
  run(() => {
    if (args.length !== 1) fail('one argument');
    return matching(args[0], NOTE_ID, 48, 'noteId');
  });

/** ShellToMain.historyRestore(id) (P2-11). */
export const validateHistoryId: ArgsValidator<string> = (args) =>
  run(() => {
    if (args.length !== 1) fail('one argument');
    return matching(args[0], SHELL_EDIT_LIMITS.historyId, 32, 'id');
  });

export interface ShellSender {
  /** The key app-shell registered the shell under (its window or document). */
  windowKey: string;
  webContentsId: number;
}

/**
 * The shell IPC router. Shell calls are accepted only from a webContents registered as a window's shell,
 * from its main frame, with origin `app://shell`. Main accepts trust changes only through these (9.1).
 */
export class ShellIpc {
  private readonly shells = new Map<number, { wc: WebContentsLike; windowKey: string }>();
  private readonly limiter: RateLimiter;
  private readonly ipcMain: IpcMainLike;
  private readonly onDrop?: (d: DropInfo) => void;
  private readonly channels = new Set<string>();

  constructor(opts: RouterOptions & { origin?: string }) {
    this.ipcMain = opts.ipcMain;
    this.limiter = new RateLimiter(opts.perSecond ?? IPC_LIMITS.messagesPerSecond, opts.now);
    this.onDrop = opts.onDrop;
    this.origin = opts.origin ?? 'app://shell';
  }

  private readonly origin: string;

  registerShell(wc: WebContentsLike, info: { windowKey: string }): void {
    const fresh = !this.shells.has(wc.id);
    this.shells.set(wc.id, { wc, windowKey: info.windowKey });
    if (fresh) wc.once('destroyed', () => this.unregisterShell(wc));
  }

  unregisterShell(wc: WebContentsLike): void {
    const s = this.shells.get(wc.id);
    if (s && s.wc === wc) this.shells.delete(wc.id);
    this.limiter.forget(wc.id);
  }

  /** The registered shell that sent `event`, or null. */
  check(event: IpcEventLike, out?: { reason?: DropReason }): ShellSender | null {
    const wc = event.sender;
    const s = wc ? this.shells.get(wc.id) : undefined;
    if (!s || s.wc !== wc || wc.isDestroyed()) {
      if (out) out.reason = 'unregistered';
      return null;
    }
    if (!isMainFrameOf(event.senderFrame, wc)) {
      if (out) out.reason = 'frame';
      return null;
    }
    if (event.senderFrame!.origin !== this.origin) {
      if (out) out.reason = 'origin';
      return null;
    }
    return { windowKey: s.windowKey, webContentsId: wc.id };
  }

  /**
   * Declares an invoke channel (`ipcMain.handle`). A refused call rejects with a bare "Refused" error.
   */
  handle<T, R>(channel: string, validate: ArgsValidator<T>, handler: (from: ShellSender, payload: T) => R | Promise<R>): void {
    if (this.channels.has(channel)) throw new Error(`shell channel ${channel} declared twice`);
    this.channels.add(channel);
    this.ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) =>
      this.invoke(channel, validate, handler, event as unknown as IpcEventLike, args),
    );
  }

  /** The handle body, exposed for tests. */
  async invoke<T, R>(
    channel: string,
    validate: ArgsValidator<T>,
    handler: (from: ShellSender, payload: T) => R | Promise<R>,
    event: IpcEventLike,
    args: readonly unknown[],
  ): Promise<R> {
    const wcId = event?.sender?.id ?? null;
    const out: { reason?: DropReason } = {};
    const from = this.check(event, out);
    if (!from) {
      this.drop(channel, out.reason ?? 'unregistered', wcId);
      throw new Error('Refused');
    }
    if (!this.limiter.allow(from.webContentsId)) {
      this.drop(channel, 'rate', wcId);
      throw new Error('Refused');
    }
    const v = validate(args);
    if (!v.ok) {
      this.drop(channel, 'invalid', wcId, v.why);
      throw new Error('Refused');
    }
    return await handler(from, v.value);
  }

  private drop(channel: string, reason: DropReason, webContentsId: number | null, why?: string): void {
    try {
      this.onDrop?.({ channel, reason, why, webContentsId });
    } catch {
      // ignore
    }
  }
}
