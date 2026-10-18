#!/usr/bin/env node
// Generates the first-paint deck of the Phase 1 exit gate (SPEC 10 Phase 1, Speed: "a 2 MB deck reaches first
// paint in under 1 s"): one self-contained HTML file of 2 MB made like Josh's twelve real decks
// (fixtures/perf/README.md has their measured composition; review finding 31: the first version was 98.8%
// base64 images, the cheapest kind of 2 MB file to open). Like the real decks: @font-face fonts inline as base64
// woff2 in a <style> in the head (font-display: swap, the median share of the file), 30 slides of text, tables,
// lists and inline SVG (about 1,800 elements), inline library code (a quarter of the file, in several blocks at
// the end of the body, as the decks that inline GSAP do), a slide engine that writes the slide into the hash on
// load (as 10 of the 12 do), and photo-like PNGs for the rest. Deterministic: the same bytes on every run and every machine (a
// seeded PRNG, no dates, no Math.random); fonts, library code and text are synthetic (no client text, no
// third-party code).
//
//   node fixtures/perf/generate.mjs [--out <file>] [--bytes <n>]
//
// Default output: fixtures/perf/out/perf-2mb.html (gitignored by fixtures/perf/.gitignore; 2 MB is too large
// to commit, and the generator reproduces it exactly). Prints the path, size, composition and sha256.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { brotliCompressSync, constants as zc, deflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));

/** The size the exit gate names: 2 MB (2 × 1024 × 1024 bytes; the deck is at least this large). */
export const TARGET_BYTES = 2 * 1024 * 1024;
export const SLIDES = 30;
const DEFAULT_OUT = join(here, 'out', 'perf-2mb.html');

/**
 * The composition (README: what D1–D12 are made of). Library code: a quarter of the file, the share of the decks
 * that inline an animation library; fonts: the median share (34%), which the faces' glyph data (glyphOutline)
 * gives at 12 faces; CSS and markup at the size the larger real decks have (a deck grows by its images and fonts,
 * not by its stylesheet); images fill the rest.
 */
export const LIBRARY_SHARE = 0.25;
/** Font faces: two families and a mono (the decks with the most font data embed 14 faces). */
const FACES = [
  ['Northwind Sans', 300, 'normal'],
  ['Northwind Sans', 400, 'normal'],
  ['Northwind Sans', 400, 'italic'],
  ['Northwind Sans', 500, 'normal'],
  ['Northwind Sans', 600, 'normal'],
  ['Northwind Sans', 700, 'normal'],
  ['Northwind Display', 400, 'normal'],
  ['Northwind Display', 500, 'normal'],
  ['Northwind Display', 600, 'normal'],
  ['Northwind Display', 700, 'normal'],
  ['Northwind Display', 800, 'normal'],
  ['Northwind Mono', 400, 'normal'],
];
/** Library blocks, as shares of the library code (the GSAP decks: a 71 KB core, then plugins of 4 to 22 KB). */
const LIBRARY_BLOCKS = [0.46, 0.2, 0.12, 0.09, 0.07, 0.04, 0.02];

// ------------------------------------------------------------------------------------------- PRNG and PNG

/** mulberry32: a small seeded PRNG, so the images are the same everywhere. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** An 8-bit RGB PNG (filter 0 on every row), deflated at level 9 so the size does not depend on zlib defaults. */
export function encodePng(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * A photo-like image: two-colour gradient, a few soft discs (a "subject"), and grain. The grain is what keeps
 * it from compressing to nothing, as a photograph's detail does; `grain` (0..64) sets how much.
 */
export function photo(seed, width, height, grain) {
  const r = prng(seed);
  const c1 = [r() * 255, r() * 255, r() * 255];
  const c2 = [r() * 255, r() * 255, r() * 255];
  const discs = Array.from({ length: 5 }, () => ({ x: r() * width, y: r() * height, rad: (0.1 + r() * 0.3) * height, c: [r() * 255, r() * 255, r() * 255] }));
  const out = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = (x / width + y / height) / 2;
      let px = [c1[0] + (c2[0] - c1[0]) * t, c1[1] + (c2[1] - c1[1]) * t, c1[2] + (c2[2] - c1[2]) * t];
      for (const d of discs) {
        const dist = Math.hypot(x - d.x, y - d.y) / d.rad;
        if (dist < 1) {
          const k = (1 - dist) * 0.6;
          px = [px[0] + (d.c[0] - px[0]) * k, px[1] + (d.c[1] - px[1]) * k, px[2] + (d.c[2] - px[2]) * k];
        }
      }
      const n = (r() - 0.5) * grain;
      const o = (y * width + x) * 3;
      for (let k = 0; k < 3; k++) out[o + k] = Math.max(0, Math.min(255, Math.round(px[k] + n)));
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------- fonts

/** Big-endian table writer. */
class Bin {
  constructor() {
    this.parts = [];
  }
  u8(v) {
    this.parts.push(Buffer.from([v & 0xff]));
    return this;
  }
  u16(v) {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(v & 0xffff);
    this.parts.push(b);
    return this;
  }
  i16(v) {
    const b = Buffer.alloc(2);
    b.writeInt16BE(v);
    this.parts.push(b);
    return this;
  }
  u32(v) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v >>> 0);
    this.parts.push(b);
    return this;
  }
  bytes(b) {
    this.parts.push(Buffer.from(b));
    return this;
  }
  done() {
    return Buffer.concat(this.parts);
  }
}

/** The characters each face maps: printable ASCII, Latin-1 and Latin Extended-A, as a subsetted web font has. */
const FONT_RANGES = [
  [0x20, 0x7e],
  [0xa0, 0xff],
  [0x100, 0x17f],
];

/**
 * One glyph outline: `contours` closed contours of quadratic points (on- and off-curve) inside the em box, with
 * the point count of a real Latin glyph. Synthetic shapes (the deck's text renders as blobs once the face swaps
 * in), but a valid TrueType glyph the browser's sanitizer accepts and rasterises.
 */
function glyphOutline(r, advance) {
  const contours = 1 + Math.floor(r() * 3);
  const out = [];
  for (let c = 0; c < contours; c++) {
    const cx = 60 + r() * (advance - 120);
    const cy = 80 + r() * 520;
    const rad = 40 + r() * 180;
    const n = 17 + Math.floor(r() * 32);
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const k = 0.55 + r() * 0.45;
      pts.push({ x: Math.round(Math.max(0, Math.min(advance, cx + Math.cos(a) * rad * k))), y: Math.round(Math.max(-180, Math.min(760, cy + Math.sin(a) * rad * k))), on: i % 3 !== 1 });
    }
    pts[0].on = true;
    out.push(pts);
  }
  return out;
}

/** A simple TrueType glyph (glyf entry) from its contours, padded to 4 bytes. */
function glyfEntry(contours) {
  const all = contours.flat();
  const xs = all.map((p) => p.x);
  const ys = all.map((p) => p.y);
  const b = new Bin().i16(contours.length).i16(Math.min(...xs)).i16(Math.min(...ys)).i16(Math.max(...xs)).i16(Math.max(...ys));
  let end = -1;
  for (const c of contours) b.u16((end += c.length));
  b.u16(0); // no instructions
  for (const p of all) b.u8(p.on ? 1 : 0); // ON_CURVE; x and y as int16 deltas
  let px = 0;
  for (const p of all) {
    b.i16(p.x - px);
    px = p.x;
  }
  let py = 0;
  for (const p of all) {
    b.i16(p.y - py);
    py = p.y;
  }
  const g = b.done();
  return g.length % 4 ? Buffer.concat([g, Buffer.alloc(4 - (g.length % 4))]) : g;
}

/** A cmap with a format 4 subtable (BMP), for platform 0 (Unicode) and platform 3 encoding 1 (Windows). */
function cmapTable() {
  const segs = [];
  let gid = 1;
  for (const [a, z] of FONT_RANGES) {
    segs.push({ start: a, end: z, delta: (gid - a) & 0xffff });
    gid += z - a + 1;
  }
  segs.push({ start: 0xffff, end: 0xffff, delta: 1 });
  const n = segs.length;
  const sr = 2 * 2 ** Math.floor(Math.log2(n));
  const sub = new Bin().u16(4).u16(16 + 8 * n).u16(0).u16(2 * n).u16(sr).u16(Math.log2(sr / 2)).u16(2 * n - sr);
  for (const s of segs) sub.u16(s.end);
  sub.u16(0);
  for (const s of segs) sub.u16(s.start);
  for (const s of segs) sub.u16(s.delta);
  for (let i = 0; i < n; i++) sub.u16(0);
  const subtable = sub.done();
  return new Bin().u16(0).u16(2).u16(0).u16(3).u32(20).u16(3).u16(1).u32(20).bytes(subtable).done();
}

function nameTable(family, style, ps) {
  const recs = [
    [1, family],
    [2, style],
    [3, `${ps};synthetic`],
    [4, `${family} ${style}`],
    [5, 'Version 1.000'],
    [6, ps],
  ];
  const strs = recs.map(([, s]) => Buffer.from(s, 'utf16le').swap16());
  const b = new Bin().u16(0).u16(recs.length).u16(6 + 12 * recs.length);
  let off = 0;
  recs.forEach(([id], i) => {
    b.u16(3).u16(1).u16(0x409).u16(id).u16(strs[i].length).u16(off);
    off += strs[i].length;
  });
  for (const s of strs) b.bytes(s);
  return b.done();
}

/**
 * A complete TrueType font (sfnt tables) for one face: .notdef plus one glyph per character of FONT_RANGES,
 * `seed` making every face's outlines different.
 */
function trueTypeTables(seed, family, weight, italic) {
  const r = prng(seed);
  const codes = FONT_RANGES.flatMap(([a, z]) => Array.from({ length: z - a + 1 }, (_, i) => a + i));
  const numGlyphs = codes.length + 1;
  const advances = [500, ...codes.map((c) => (c === 0x20 ? 260 : 380 + Math.round(r() * 320)))];
  const outlines = advances.map((adv, g) => (g === 0 ? [[{ x: 50, y: 0, on: true }, { x: 450, y: 0, on: true }, { x: 450, y: 700, on: true }, { x: 50, y: 700, on: true }]] : codes[g - 1] === 0x20 ? [] : glyphOutline(r, adv)));
  const glyphs = outlines.map((c) => (c.length ? glyfEntry(c) : Buffer.alloc(0)));
  const glyf = Buffer.concat(glyphs);
  const loca = new Bin();
  let off = 0;
  for (const g of glyphs) {
    loca.u32(off);
    off += g.length;
  }
  loca.u32(off);
  const pts = outlines.map((c) => c.flat().length);
  const lsb = outlines.map((c) => (c.length ? Math.min(...c.flat().map((p) => p.x)) : 0));
  const hmtx = new Bin();
  advances.forEach((a, i) => hmtx.u16(a).i16(lsb[i]));
  const all = outlines.flat(2);
  const xMin = Math.min(...all.map((p) => p.x));
  const yMin = Math.min(...all.map((p) => p.y));
  const xMax = Math.max(...all.map((p) => p.x));
  const yMax = Math.max(...all.map((p) => p.y));
  const style = `${weight}${italic ? ' Italic' : ''}`;
  const ps = `${family.replace(/\s+/g, '')}-${weight}${italic ? 'Italic' : ''}`;
  const head = new Bin()
    .u32(0x00010000)
    .u32(0x00010000)
    .u32(0) // checkSumAdjustment: the WOFF2 decoder recomputes it
    .u32(0x5f0f3cf5)
    .u16(0x000b)
    .u16(1000)
    .u32(0)
    .u32(0) // created: no dates
    .u32(0)
    .u32(0) // modified
    .i16(xMin)
    .i16(yMin)
    .i16(xMax)
    .i16(yMax)
    .u16((weight >= 700 ? 1 : 0) | (italic ? 2 : 0))
    .u16(8)
    .i16(2)
    .i16(1) // long loca
    .i16(0)
    .done();
  const hhea = new Bin()
    .u32(0x00010000)
    .i16(800)
    .i16(-200)
    .i16(0)
    .u16(Math.max(...advances))
    .i16(Math.min(...lsb))
    .i16(0)
    .i16(xMax)
    .i16(1)
    .i16(0)
    .i16(0)
    .i16(0)
    .i16(0)
    .i16(0)
    .i16(0)
    .i16(0)
    .u16(numGlyphs)
    .done();
  const maxp = new Bin().u32(0x00010000).u16(numGlyphs).u16(Math.max(...pts)).u16(Math.max(...outlines.map((c) => c.length))).u16(0).u16(0).u16(2).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).u16(0).done();
  const os2 = new Bin()
    .u16(4)
    .i16(Math.round(advances.reduce((a, b) => a + b, 0) / advances.length))
    .u16(weight)
    .u16(5)
    .u16(0) // fsType: installable
    .i16(650)
    .i16(600)
    .i16(0)
    .i16(75)
    .i16(650)
    .i16(600)
    .i16(0)
    .i16(350)
    .i16(50)
    .i16(258)
    .i16(0)
    .bytes(Buffer.from([2, 11, 5, 3, 3, 4, 3, 2, 2, 4]))
    .u32(0x00000003)
    .u32(0)
    .u32(0)
    .u32(0)
    .bytes(Buffer.from('NWND', 'ascii'))
    .u16(italic ? 0x0001 : weight >= 700 ? 0x0020 : 0x0040)
    .u16(0x20)
    .u16(0x17f)
    .i16(800)
    .i16(-200)
    .i16(0)
    .u16(Math.max(800, yMax))
    .u16(Math.max(200, -yMin))
    .u32(0x00000001)
    .u32(0)
    .i16(500)
    .i16(700)
    .u16(0)
    .u16(0x20)
    .u16(1)
    .done();
  const post = new Bin().u32(0x00030000).u32(italic ? 0xfff40000 : 0).i16(-100).i16(50).u32(0).u32(0).u32(0).u32(0).u32(0).done();
  return [
    ['OS/2', os2],
    ['cmap', cmapTable()],
    ['glyf', glyf],
    ['head', head],
    ['hhea', hhea],
    ['hmtx', hmtx.done()],
    ['loca', loca.done()],
    ['maxp', maxp],
    ['name', nameTable(family, style, ps)],
    ['post', post],
  ];
}

/** UIntBase128 (WOFF2): big-endian base 128, the high bit set on every byte but the last. */
function base128(n) {
  const out = [n & 0x7f];
  for (n >>>= 7; n > 0; n >>>= 7) out.unshift(0x80 | (n & 0x7f));
  return Buffer.from(out);
}

const WOFF2_KNOWN = { cmap: 0, head: 1, hhea: 2, hmtx: 3, maxp: 4, name: 5, 'OS/2': 6, post: 7, glyf: 10, loca: 11 };

/**
 * A WOFF2 file of the tables (in tag order). glyf and loca use the null transform (version 3), which the
 * format allows; one brotli stream at quality 11 (deterministic for a given brotli, as level-9 deflate is).
 */
function woff2(tables) {
  const dir = new Bin();
  for (const [tag, data] of tables) {
    const version = tag === 'glyf' || tag === 'loca' ? 3 : 0;
    dir.u8((version << 6) | WOFF2_KNOWN[tag]).bytes(base128(data.length));
  }
  const directory = dir.done();
  const stream = Buffer.concat(tables.map(([, d]) => d));
  const compressed = brotliCompressSync(stream, { params: { [zc.BROTLI_PARAM_QUALITY]: 11, [zc.BROTLI_PARAM_LGWIN]: 22, [zc.BROTLI_PARAM_SIZE_HINT]: stream.length } });
  const sfntSize = 12 + 16 * tables.length + tables.reduce((a, [, d]) => a + ((d.length + 3) & ~3), 0);
  const unpadded = 48 + directory.length + compressed.length;
  const length = (unpadded + 3) & ~3;
  const header = new Bin().u32(0x774f4632).u32(0x00010000).u32(length).u16(tables.length).u16(0).u32(sfntSize).u32(compressed.length).u16(1).u16(0).u32(0).u32(0).u32(0).u32(0).u32(0).done();
  return Buffer.concat([header, directory, compressed, Buffer.alloc(length - unpadded)]);
}

/** One face as a base64 woff2 data URL. */
export function fontFace(index) {
  const [family, weight, style] = FACES[index];
  return `data:font/woff2;base64,${woff2(trueTypeTables(7000 + index, family, weight, style === 'italic')).toString('base64')}`;
}

// ------------------------------------------------------------------------------------------- library code

const RESERVED = new Set(
  'do if in for let new try var case else enum eval null this true void with await break catch class const false super throw while yield delete export import public return static switch typeof default extends finally package private continue debugger function arguments interface protected implements instanceof undefined NaN Infinity of as get set async'.split(
    ' ',
  ),
);
const PROPS =
  'duration ease delay repeat yoyo stagger onComplete onUpdate onStart progress totalTime timeScale paused reversed invalidate kill render vars targets parent labels ratio time data id x y z rotation scale scaleX scaleY skewX skewY opacity autoAlpha transform transformOrigin width height left top xPercent yPercent color backgroundColor borderRadius filter clipPath strokeDashoffset length snap modifiers immediateRender overwrite inherit lazy callbackScope startAt keyframes defaults smoothChildTiming autoRemoveChildren'.split(
    ' ',
  );
const EASES = ['none', 'power1.out', 'power2.inOut', 'power3.in', 'power4.out', 'back.out(1.7)', 'elastic.out(1, 0.3)', 'bounce.out', 'circ.inOut', 'expo.out', 'sine.inOut', 'steps(12)'];
const MESSAGES = ['Invalid property', 'not found', 'Missing plugin? register it first', 'cannot tween a null target', 'is not a function', 'Invalid scope', 'requires a target', 'unsupported unit', 'Timeline already contains this child', 'Expected an element'];

/** Short minified identifiers (a, b, …, aa, ab, …), none of them a reserved word. */
function idents() {
  const out = [];
  const L = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$';
  for (const a of L) out.push(a);
  for (const a of L) for (const b of L + '0123456789') out.push(a + b);
  return out.filter((n) => !RESERVED.has(n));
}
const IDENTS = idents();

/**
 * Library code like the minified animation libraries Josh's decks inline (GSAP and its plugins): a UMD
 * wrapper around many small functions and prototype methods, object literals of defaults, string tables of
 * property names, easing maths, regular expressions, error messages, template literals, and a few HTML
 * strings. It defines a global namespace and does a little set-up work when it runs, as such a library does;
 * nothing in it touches the page. Valid JavaScript whose load-time code runs without an error (checked with
 * node:vm before it is used).
 */
export function libraryCode(seed, target, ns) {
  const r = prng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const id = () => pick(IDENTS.slice(0, 400));
  const num = () => pick(['0', '1', '2', '.5', '.25', '1e3', '360', '180', '1e-8', '.001', '100', '255', String(Math.round(r() * 1000)), (r() * 10).toFixed(3), '-1', '2*Math.PI']);
  const str = () => JSON.stringify(pick([pick(PROPS), pick(EASES), pick(MESSAGES), `${pick(PROPS)}:${pick(PROPS)}`, `px`, `%`, `deg`, `rgba(0,0,0,0)`, `${pick(MESSAGES)}: ${pick(PROPS)}`]));
  const expr = (d = 0) => {
    const k = Math.floor(r() * (d > 2 ? 4 : 12));
    switch (k) {
      case 0:
        return id();
      case 1:
        return num();
      case 2:
        return str();
      case 3:
        return `${id()}.${pick(PROPS)}`;
      case 4: {
        // A minifier writes `a- -1`, never `a--1`.
        const op = pick(['+', '-', '*', '/', '|', '&&', '||', '===', '<', '>']);
        const rhs = expr(d + 1);
        return `${expr(d + 1)}${op}${(op === '-' || op === '+') && /^[-+]/.test(rhs) ? ' ' : ''}${rhs}`;
      }
      case 5:
        return `${id()}(${expr(d + 1)},${expr(d + 1)})`;
      case 6:
        return `${expr(d + 1)}?${expr(d + 1)}:${expr(d + 1)}`;
      case 7:
        return `Math.${pick(['max', 'min', 'round', 'abs', 'pow', 'sin', 'cos', 'sqrt'])}(${expr(d + 1)},${expr(d + 1)})`;
      case 8:
        return `{${pick(PROPS)}:${expr(d + 1)},${pick(PROPS)}:${expr(d + 1)}}`;
      case 9:
        return `[${expr(d + 1)},${expr(d + 1)},${expr(d + 1)}]`;
      case 10:
        return `\`${pick(PROPS)}(\${${expr(d + 1)}}${pick(['px', 'deg', '%', ''])})\``;
      default:
        return `function(${id()}){return ${expr(d + 1)}}`;
    }
  };
  // What runs when the library loads (object literals of defaults) uses constants and functions only, so it
  // never reads a name that is not defined; the expressions inside function bodies never run.
  const constant = () => {
    const k = Math.floor(r() * 5);
    return k === 0 ? num() : k === 1 ? str() : k === 2 ? `[${num()},${num()},${str()}]` : k === 3 ? `function(t){return ${expr(1)}}` : `!${Math.floor(r() * 2)}`;
  };
  const stmt = () => {
    const k = Math.floor(r() * 10);
    switch (k) {
      case 0:
        return `var ${id()}=${expr()},${id()}=${expr()};`;
      case 1:
        return `if(${expr()}){${id()}=${expr()};${id()}.${pick(PROPS)}=${expr()}}else ${id()}=${expr()};`;
      case 2:
        return `for(var ${id()}=0;${id()}<${expr()};${id()}++)${id()}[${id()}]=${expr()};`;
      case 3:
        return `if(!${id()})throw new Error(${str()}+${id()});`;
      case 4:
        return `${id()}.${pick(PROPS)}=${expr()};`;
      case 5:
        return `switch(${id()}){case ${num()}:${id()}=${expr()};break;case ${str()}:return ${expr()};default:${id()}=${expr()}}`;
      case 6:
        return `while(${id()}){${id()}.${pick(PROPS)}(${expr()});${id()}=${id()}._next}`;
      default:
        return `${id()}=${expr()};`;
    }
  };
  const fn = (name) => {
    const args = Array.from({ length: 1 + Math.floor(r() * 3) }, (_, i) => 'tenr'[i]);
    const body = Array.from({ length: 2 + Math.floor(r() * 6) }, stmt).join('');
    return `function ${name}(${args.join(',')}){${body}return ${expr()}}`;
  };
  const parts = [];
  let size = 0;
  const add = (s) => {
    parts.push(s);
    size += s.length;
  };
  add(`/*! ${ns} 3.${seed % 13}.${seed % 7} | synthetic animation library for the Blueline first-paint deck | no third-party code */\n`);
  add(`!function(t,e){"object"==typeof exports&&"undefined"!=typeof module?e(exports):"function"==typeof define&&define.amd?define(["exports"],e):e((t=t||self).${ns}={})}(this,function(e){"use strict";`);
  add(`var _r={},_d={${PROPS.slice(0, 12).map((p) => `${p}:${num()}`).join(',')}},_props=${JSON.stringify(PROPS)},_eases=${JSON.stringify(EASES)},_num=/(?:-?\\.?\\d|\\.)+/gi,_rel=/^[+-]=/,_tpl="<div class=\\"${ns.toLowerCase()}-marker\\"><span>start</span></div>";`);
  let n = 0;
  while (size < target - 600) {
    const k = r();
    const name = `${pick(['_', '', '', ''])}${id()}${n++}`;
    if (k < 0.55) add(fn(name));
    else if (k < 0.75) add(`${name}.prototype.${pick(PROPS)}=function(t,e){var n=this;${stmt()}${stmt()}return n};`.replace(/^/, `function ${name}(t){this.vars=t||{};this._dur=+this.vars.duration||.5}`));
    else if (k < 0.85) add(`var ${name}={${Array.from({ length: 4 + Math.floor(r() * 8) }, () => `${pick(PROPS)}:${constant()}`).join(',')}};`);
    else if (k < 0.92) add(`var ${name}=function(t){return t<.5?${num()}*t*t:1-Math.pow(-2*t+2,${num()})/2};_r[${JSON.stringify(pick(EASES) + n)}]=${name};`);
    else add(`class ${name.replace(/^_/, 'C')}{constructor(t){this.vars=t||{};this._t=0}get ${pick(PROPS)}(){return this._t/${num()}}${pick(PROPS)}(t){this._t=t;return this}}`);
  }
  // The set-up work a library does when it loads: a registry of its eases and defaults.
  add(`for(var _k in _r)_d[_k]=typeof _r[_k];e.version="3.${seed % 13}.${seed % 7}";e.registry=_r;e.defaults=_d;e.parse=function(t){return String(t).match(_num)};Object.defineProperty(e,"__esModule",{value:!0})});\n`);
  const code = parts.join('');
  // Valid, and its load-time code runs without an error (a library that threw would stop at its first line).
  const sandbox = {};
  new Script(code, { filename: `${ns}.js` }).runInNewContext(sandbox);
  if (typeof sandbox[ns]?.version !== 'string') throw new Error(`${ns}: the library did not load`);
  return code;
}

// ------------------------------------------------------------------------------------------- content

const TOPICS = ['Market', 'Product', 'Customers', 'Operations', 'Finance', 'Hiring', 'Roadmap', 'Risks', 'Partners', 'Platform'];
const WORDS =
  'growth retention pipeline margin velocity onboarding activation churn cohort quarter forecast revenue capacity latency coverage adoption expansion renewal backlog throughput launch pricing segment channel workflow quality'.split(
    ' ',
  );
const PEOPLE = ['Avery Lane', 'Jordan Pike', 'Riley Stone', 'Morgan Hale', 'Casey Ford', 'Quinn Ash', 'Drew Vale', 'Sasha Reed'];

function sentence(r, n) {
  const w = Array.from({ length: n }, () => WORDS[Math.floor(r() * WORDS.length)]);
  w[0] = w[0][0].toUpperCase() + w[0].slice(1);
  return `${w.join(' ')}.`;
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function barChart(r, title) {
  const bars = Array.from({ length: 8 }, (_, i) => ({ label: `Q${(i % 4) + 1} ${2024 + Math.floor(i / 4)}`, v: Math.round(20 + r() * 80) }));
  const grid = [0, 25, 50, 75, 100].map((g) => `<line class="grid" x1="180" x2="1180" y1="${560 - g * 5}" y2="${560 - g * 5}"/><text class="tick" x="170" y="${566 - g * 5}">${g}%</text>`).join('');
  const rows = bars
    .map((b, i) => `<g class="bar" transform="translate(${200 + i * 120} 0)"><rect x="0" y="${560 - b.v * 5}" width="80" height="${b.v * 5}" rx="6"/><text class="amount" x="40" y="${548 - b.v * 5}">${b.v}%</text><text class="label" x="40" y="596">${b.label}</text></g>`)
    .join('');
  return `<figure class="chart"><svg viewBox="0 0 1200 620" width="1200" height="620" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title>${grid}${rows}</svg><figcaption>${esc(title)}: share of target reached</figcaption></figure>`;
}

function lineChart(r, title) {
  const pts = Array.from({ length: 12 }, (_, i) => [100 + i * 90, Math.round(500 - r() * 360)]);
  const dots = pts.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="7"/>`).join('');
  return `<figure class="chart"><svg viewBox="0 0 1200 560" width="1200" height="560" role="img" aria-label="${esc(title)}"><title>${esc(title)}</title><polyline class="line" points="${pts.map((p) => p.join(',')).join(' ')}"/>${dots}<text class="tick" x="100" y="540">Jan</text><text class="tick" x="1090" y="540">Dec</text></svg><figcaption>${esc(title)}, monthly</figcaption></figure>`;
}

/** A small inline SVG icon (real decks carry dozens: 14 to 53 inline SVGs each). */
function icon(r) {
  const k = Math.floor(r() * 4);
  const shape = [`<circle cx="12" cy="12" r="${4 + Math.floor(r() * 6)}"/>`, `<rect x="4" y="4" width="16" height="16" rx="${Math.floor(r() * 6)}"/>`, `<path d="M4 ${12 + Math.floor(r() * 6)}l5 5L20 ${4 + Math.floor(r() * 6)}"/>`, `<polygon points="12,3 21,20 3,20"/>`][k];
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${shape}<circle class="dot" cx="20" cy="4" r="2"/></svg>`;
}

/** A slide's decorative background: a few soft shapes in an inline SVG, different on every slide. */
function deco(r) {
  const shapes = Array.from({ length: 16 }, (_, k) =>
    k % 3 === 0
      ? `<circle cx="${Math.round(r() * 400)}" cy="${Math.round(r() * 400)}" r="${Math.round(10 + r() * 60)}" opacity="${(0.05 + r() * 0.15).toFixed(2)}"/>`
      : k % 3 === 1
        ? `<rect x="${Math.round(r() * 360)}" y="${Math.round(r() * 360)}" width="${Math.round(20 + r() * 80)}" height="${Math.round(4 + r() * 20)}" rx="4" opacity="${(0.05 + r() * 0.15).toFixed(2)}"/>`
        : `<path d="M${Math.round(r() * 400)} ${Math.round(r() * 400)}q${Math.round(r() * 80 - 40)} ${Math.round(r() * 80 - 40)} ${Math.round(r() * 120)} 0" fill="none" stroke-width="3" opacity="${(0.1 + r() * 0.2).toFixed(2)}"/>`,
  ).join('');
  return `<svg class="deco" viewBox="0 0 400 400" aria-hidden="true">${shapes}</svg>`;
}

/** A KPI's sparkline. */
function sparkline(r) {
  const pts = Array.from({ length: 6 }, (_, i) => [i * 40, Math.round(36 - r() * 32)]);
  return `<svg class="spark" viewBox="0 0 200 40" aria-hidden="true"><polyline points="${pts.map((p) => p.join(',')).join(' ')}"/>${pts.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="3"/>`).join('')}</svg>`;
}

/** The kind of slide `i`. */
function kindOf(i) {
  return i === 0 ? 'title' : i === SLIDES - 1 ? 'end' : ['bullets', 'image', 'chart', 'table', 'quote', 'kpis', 'split', 'timeline', 'team', 'compare', 'agenda', 'line'][i % 12];
}

/** Slide kinds that show a picture. */
const IMAGE_KINDS = new Set(['title', 'end', 'image', 'quote', 'split']);

/** The slides that show a picture, in order: each gets a distinct image. */
function imageSlides() {
  return Array.from({ length: SLIDES }, (_, i) => i).filter((i) => IMAGE_KINDS.has(kindOf(i)));
}

function slideHtml(i, r, images) {
  const n = i + 1;
  const topic = TOPICS[i % TOPICS.length];
  const kind = kindOf(i);
  // Each slide that shows a picture gets its own image (IMAGE_KINDS), in slide order.
  const img = images[imageSlides().indexOf(i)] ?? images[0];
  const h2 = `${topic}: ${sentence(r, 3).slice(0, -1)}`;
  const head = `<header class="slide-head"><span class="eyebrow">${esc(topic)}</span><h2>${esc(h2)}</h2></header>`;
  let body;
  switch (kind) {
    case 'title':
      body = `<p class="kicker">Quarterly review</p><h1>Northwind platform, Q3</h1><p class="sub">Synthetic deck for the Blueline first-paint measurement · <span class="count">${SLIDES}</span> slides</p><img class="hero" alt="" src="${img}">`;
      break;
    case 'end':
      body = `<h1>Thank you</h1><p class="sub">Questions and next steps</p><ul class="contacts">${PEOPLE.slice(0, 3).map((p) => `<li><strong>${p}</strong> <span>${esc(sentence(r, 2).slice(0, -1).toLowerCase())}</span></li>`).join('')}</ul><img class="hero" alt="" src="${img}">`;
      break;
    case 'bullets':
      body = `${head}<ul class="points">${Array.from({ length: 6 }, () => `<li>${icon(r)}<strong>${esc(sentence(r, 2).slice(0, -1))}</strong> <span>${esc(sentence(r, 7 + Math.floor(r() * 5)))}</span></li>`).join('')}</ul>`;
      break;
    case 'image':
      body = `${head}<div class="media"><img alt="Illustration ${n}" src="${img}"><div class="copy"><p>${esc(sentence(r, 18))} ${esc(sentence(r, 14))}</p><p class="note"><em>${esc(sentence(r, 6))}</em></p></div></div>`;
      break;
    case 'chart':
      body = `${head}${barChart(r, `${topic} by quarter`)}`;
      break;
    case 'line':
      body = `${head}${lineChart(r, `${topic} trend`)}`;
      break;
    case 'table': {
      const rows = Array.from({ length: 8 }, (_, k) => `<tr><td>${esc(TOPICS[(i + k) % TOPICS.length])}</td><td>${Math.round(r() * 900 + 100)}</td><td>${(r() * 40 - 10).toFixed(1)}%</td><td><span class="pill">${esc(WORDS[Math.floor(r() * WORDS.length)])}</span></td><td>${esc(sentence(r, 4))}</td></tr>`).join('');
      body = `${head}<table><thead><tr><th>Area</th><th>Accounts</th><th>Change</th><th>Status</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table>`;
      break;
    }
    case 'quote':
      body = `<blockquote><p>“${esc(sentence(r, 16).slice(0, -1))}.”</p></blockquote><cite>Customer interview, ${esc(topic.toLowerCase())} track</cite><img class="thumb" alt="" src="${img}">`;
      break;
    case 'kpis':
      body = `${head}<div class="kpis">${Array.from({ length: 4 }, () => `<div class="kpi">${icon(r)}<b>${Math.round(r() * 99)}%</b><span>${esc(sentence(r, 3).slice(0, -1))}</span>${sparkline(r)}<small>${esc(sentence(r, 4))}</small></div>`).join('')}</div>`;
      break;
    case 'timeline':
      body = `${head}<ol class="timeline">${Array.from({ length: 8 }, (_, k) => `<li>${icon(r)}<time>Week ${k + 1}</time><strong>${esc(sentence(r, 2).slice(0, -1))}</strong><span>${esc(sentence(r, 5))}</span></li>`).join('')}</ol>`;
      break;
    case 'team':
      body = `${head}<div class="team">${PEOPLE.map((p) => `<div class="person">${icon(r)}<i aria-hidden="true">${p.split(' ').map((w) => w[0]).join('')}</i><strong>${p}</strong><span>${esc(sentence(r, 2).slice(0, -1))}</span></div>`).join('')}</div>`;
      break;
    case 'compare':
      body = `${head}<div class="compare">${['Today', 'Next quarter'].map((t) => `<section><h3>${t}</h3><ul>${Array.from({ length: 5 }, () => `<li>${icon(r)}${esc(sentence(r, 6))}</li>`).join('')}</ul></section>`).join('')}</div>`;
      break;
    case 'agenda':
      body = `${head}<ol class="agenda">${TOPICS.slice(0, 7).map((t, k) => `<li>${icon(r)}<span class="num">${String(k + 1).padStart(2, '0')}</span><strong>${t}</strong><em>${esc(sentence(r, 4))}</em></li>`).join('')}</ol>`;
      break;
    default:
      body = `${head}<div class="split"><div><p>${esc(sentence(r, 22))}</p><p>${esc(sentence(r, 16))}</p><p class="note">${esc(sentence(r, 8))}</p></div><img alt="Figure ${n}" src="${img}"></div>`;
  }
  // The layout as a class of its own (k-…): `.kpis` and `.split` style the slide's content, not the slide.
  return `<section class="slide k-${kind}" data-title="${esc(topic)}" aria-label="Slide ${n}">${deco(r)}${body}<footer><span>Northwind · Q3 review</span><span class="conf">Internal</span><span class="num">${n} / ${SLIDES}</span></footer></section>`;
}

const FONT_SANS = '"Northwind Sans", "Helvetica Neue", Arial, system-ui, sans-serif';
const FONT_DISPLAY = '"Northwind Display", Georgia, "Times New Roman", serif';

const CSS_BASE = `
:root { --bg: #0b1020; --paper: #f7f7fb; --ink: #121528; --muted: #5d6178; --accent: #e4572e; --accent-2: #2e86ab; --line: #dfe1ea; font-family: ${FONT_SANS}; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); overflow: hidden; }
.deck { position: absolute; left: 50%; top: 50%; width: 1600px; height: 900px; margin: -450px 0 0 -800px; background: var(--paper); overflow: hidden; transform-origin: 50% 50%; }
.slide { position: absolute; inset: 0; padding: 88px 112px 120px; color: var(--ink); visibility: hidden; opacity: 0; transition: opacity .4s ease, visibility .4s; }
.slide.active { visibility: visible; opacity: 1; }
@media (prefers-reduced-motion: reduce) { .slide { transition: none; } }
h1 { font: 800 112px/1 ${FONT_DISPLAY}; letter-spacing: -.03em; margin: 120px 0 28px; max-width: 1100px; }
h2 { font: 700 56px/1.1 ${FONT_DISPLAY}; letter-spacing: -.015em; margin: 0 0 40px; max-width: 1300px; }
h3 { font: 600 30px/1.2 ${FONT_DISPLAY}; margin: 0 0 16px; }
.eyebrow { display: block; font: 600 18px/1 ${FONT_SANS}; text-transform: uppercase; letter-spacing: .16em; color: var(--accent); margin-bottom: 14px; }
.kicker { font-size: 22px; text-transform: uppercase; letter-spacing: .16em; color: var(--accent); margin: 40px 0 0; font-weight: 700; }
.sub { font-size: 30px; color: var(--muted); max-width: 900px; font-weight: 300; }
.hero { position: absolute; right: 0; bottom: 0; width: 640px; height: 900px; object-fit: cover; }
.k-title .hero, .k-end .hero { clip-path: polygon(22% 0, 100% 0, 100% 100%, 0 100%); }
ul, ol { margin: 0; padding-left: 44px; font-size: 32px; line-height: 1.45; max-width: 1280px; }
li::marker { color: var(--accent); }
.points strong { font-weight: 600; }
.media { display: grid; grid-template-columns: 820px 1fr; gap: 48px; align-items: start; }
.media img, .split img { width: 100%; border-radius: 18px; box-shadow: 0 18px 40px rgba(18, 21, 40, .18); }
.media p, .split p { font-size: 28px; line-height: 1.5; color: var(--muted); margin: 0 0 20px; }
.note { font-style: italic; font-size: 22px; }
.split { display: grid; grid-template-columns: 1fr 640px; gap: 64px; }
.chart { margin: 0; }
.chart rect { fill: var(--accent-2); }
.chart text { font: 24px ${FONT_SANS}; fill: var(--ink); text-anchor: middle; }
.chart .tick { text-anchor: end; fill: var(--muted); font-size: 18px; }
.chart .grid { stroke: var(--line); stroke-width: 2; }
.chart .line { fill: none; stroke: var(--accent); stroke-width: 6; }
.chart circle { fill: var(--accent); }
.chart text.amount { font-weight: 700; }
.chart figcaption { font-size: 22px; color: var(--muted); margin-top: 16px; }
table { border-collapse: collapse; width: 100%; font-size: 24px; }
th { text-align: left; font-size: 16px; text-transform: uppercase; letter-spacing: .1em; color: var(--muted); border-bottom: 2px solid var(--ink); padding: 14px 12px; }
td { border-bottom: 1px solid var(--line); padding: 14px 12px; }
td:nth-child(2), td:nth-child(3) { font: 400 22px ${'"Northwind Mono", ui-monospace, monospace'}; }
.pill { display: inline-block; padding: 4px 12px; border-radius: 999px; background: #eef0f6; font-size: 18px; }
blockquote { margin: 120px 0 28px; font: italic 400 60px/1.2 ${FONT_SANS}; max-width: 1050px; }
blockquote p { margin: 0; }
cite { font-size: 26px; color: var(--muted); font-style: normal; }
.thumb { position: absolute; right: 112px; top: 120px; width: 260px; height: 260px; border-radius: 50%; object-fit: cover; }
.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 28px; }
.kpi { background: #fff; border: 1px solid var(--line); border-radius: 20px; padding: 36px 30px; }
.kpi b { display: block; font: 800 84px/1 ${FONT_DISPLAY}; letter-spacing: -.03em; color: var(--accent); }
.kpi span { display: block; font-size: 22px; font-weight: 500; margin: 12px 0 8px; }
.kpi small { font-size: 18px; color: var(--muted); }
.timeline { list-style: none; padding: 0; display: grid; grid-template-columns: repeat(4, 1fr); gap: 24px 32px; }
.timeline li { border-top: 4px solid var(--accent-2); padding-top: 14px; font-size: 22px; }
.timeline time, .timeline strong, .timeline span { display: block; }
.timeline time { font: 500 16px ${'"Northwind Mono", ui-monospace, monospace'}; color: var(--muted); }
.team { display: grid; grid-template-columns: repeat(4, 1fr); gap: 32px; }
.person { display: grid; gap: 6px; font-size: 22px; }
.person i { width: 96px; height: 96px; border-radius: 50%; background: var(--accent-2); color: #fff; display: grid; place-items: center; font: normal 600 32px ${FONT_DISPLAY}; }
.person span { color: var(--muted); font-size: 18px; }
.compare { display: grid; grid-template-columns: 1fr 1fr; gap: 48px; }
.compare section { background: #fff; border-radius: 20px; padding: 32px; border: 1px solid var(--line); }
.compare ul { font-size: 22px; }
.agenda { list-style: none; padding: 0; font-size: 28px; }
.agenda li { display: grid; grid-template-columns: 80px 260px 1fr; gap: 24px; padding: 12px 0; border-bottom: 1px solid var(--line); }
.agenda .num { font: 600 28px ${'"Northwind Mono", ui-monospace, monospace'}; color: var(--accent); }
.agenda em { color: var(--muted); font-size: 22px; }
.contacts { list-style: none; padding: 0; font-size: 24px; margin-top: 40px; }
footer { position: absolute; left: 112px; right: 112px; bottom: 40px; display: flex; justify-content: space-between; font-size: 18px; color: var(--muted); }
.progress { position: absolute; left: 0; bottom: 0; height: 6px; background: var(--accent); width: 0; z-index: 2; }
.deco { position: absolute; right: -40px; top: -40px; width: 420px; height: 420px; fill: var(--accent-2); stroke: var(--accent); pointer-events: none; }
.icon { width: 28px; height: 28px; vertical-align: -4px; margin-right: 12px; fill: none; stroke: var(--accent-2); stroke-width: 2; }
.icon .dot { fill: var(--accent); stroke: none; }
.spark { display: block; width: 100%; height: 40px; margin: 8px 0; fill: var(--accent); }
.spark polyline { fill: none; stroke: var(--accent-2); stroke-width: 2; }
`;

/**
 * The rest of the stylesheet: utility and theme rules a design tool emits, most of them unused by the slides,
 * as in the real decks (55 KB of CSS in the median deck). Deterministic.
 */
function utilityCss(r, bytes) {
  const props = ['margin', 'padding', 'gap', 'font-size', 'line-height', 'letter-spacing', 'border-radius', 'opacity', 'width', 'max-width', 'top', 'left'];
  const colors = ['#e4572e', '#2e86ab', '#121528', '#5d6178', '#f7f7fb', '#dfe1ea', '#a23b72', '#f18f01', '#c73e1d', '#3b1f2b'];
  let out = '';
  for (let i = 0; out.length < bytes; i++) {
    const p = props[i % props.length];
    const v = p === 'opacity' ? (r() * 1).toFixed(2) : p === 'letter-spacing' ? `${(r() * 0.2 - 0.05).toFixed(3)}em` : `${Math.round(r() * 120)}px`;
    out += `.u-${p.replace(/-/g, '')}-${i} { ${p}: ${v}; }\n`;
    if (i % 5 === 0) out += `.theme-${i} .slide-head h2, .theme-${i} .kpi b { color: ${colors[i % colors.length]}; border-color: ${colors[(i + 3) % colors.length]}; }\n`;
    if (i % 17 === 0) out += `@media (max-width: ${600 + (i % 7) * 100}px) { .u-${p.replace(/-/g, '')}-${i} { ${p}: ${Math.round(r() * 40)}px; } }\n`;
  }
  return out;
}

// The slide engine: one slide shown at a time; ArrowRight/ArrowLeft, PageDown/PageUp, Space, Home and End;
// the slide in the hash (#/1 … #/30), written on the first show too, as most real decks do, so a reload stays
// put; scaled to fit the window; a progress bar.
const ENGINE = `
(function () {
  var deck = document.querySelector('.deck');
  var slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
  var bar = document.querySelector('.progress');
  var cur = -1;
  function fromHash() {
    var m = /^#\\/(\\d+)$/.exec(location.hash);
    var n = m ? parseInt(m[1], 10) - 1 : 0;
    return Math.max(0, Math.min(slides.length - 1, n));
  }
  function show(i) {
    i = Math.max(0, Math.min(slides.length - 1, i));
    if (i === cur) return;
    if (cur >= 0) slides[cur].classList.remove('active');
    slides[i].classList.add('active');
    cur = i;
    bar.style.width = ((i + 1) / slides.length * 100) + '%';
    if (location.hash !== '#/' + (i + 1)) history.replaceState(null, '', '#/' + (i + 1));
  }
  function fit() {
    var s = Math.min(window.innerWidth / 1600, window.innerHeight / 900);
    deck.style.transform = 'scale(' + s + ')';
  }
  document.addEventListener('keydown', function (e) {
    var k = e.key;
    if (k === 'ArrowRight' || k === 'PageDown' || k === ' ') { show(cur + 1); e.preventDefault(); }
    else if (k === 'ArrowLeft' || k === 'PageUp') { show(cur - 1); e.preventDefault(); }
    else if (k === 'Home') { show(0); e.preventDefault(); }
    else if (k === 'End') { show(slides.length - 1); e.preventDefault(); }
  });
  window.addEventListener('hashchange', function () { show(fromHash()); });
  window.addEventListener('resize', fit);
  fit();
  show(fromHash());
})();
`;

/** The parts that do not depend on the image size: fonts, CSS, slides' text, library code. Built once. */
function fixedParts(target) {
  const fonts = FACES.map((f, i) => `@font-face { font-family: "${f[0]}"; font-weight: ${f[1]}; font-style: ${f[2]}; font-display: swap; src: url(${fontFace(i)}) format("woff2"); }`).join('\n');
  const css = CSS_BASE + utilityCss(prng(7), 56 * 1024 - CSS_BASE.length);
  const lib = Math.round(target * LIBRARY_SHARE);
  const libraries = LIBRARY_BLOCKS.map((share, k) => libraryCode(101 + k, Math.round(lib * share), `Nw${k}`));
  return { fonts, css, libraries };
}

/** The deck's HTML for a given image width (the knob that sets the file size). */
function build(parts, grain, imageCount, w, h) {
  const images = Array.from({ length: imageCount }, (_, k) => `data:image/png;base64,${encodePng(w, h, photo(1000 + k, w, h, grain)).toString('base64')}`);
  const r = prng(42);
  const slides = Array.from({ length: SLIDES }, (_, i) => slideHtml(i, r, images)).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Northwind platform, Q3 (perf deck)</title>
<style>
${parts.fonts}
${parts.css}</style>
</head>
<body>
<div class="deck">
${slides}
<div class="progress"></div>
</div>
${parts.libraries.map((code) => `<script>${code}</script>`).join('\n')}
<script>${ENGINE}</script>
</body>
</html>
`;
}

/** Grain of the images: enough detail that they compress like photographs, not like flat colour. */
const GRAIN = 12;
/** One distinct image per picture slide. */
const IMAGES = imageSlides().length;

/**
 * The deck at `target` bytes: fonts, CSS, text and library code fixed, then one distinct photo-like image
 * (16:10) per picture slide, their width found by bisection so the file is at least `target` bytes, as small
 * as that allows. Integers only, so the result is deterministic.
 */
export function generate(target = TARGET_BYTES) {
  const parts = fixedParts(target);
  const size = (w) => {
    const html = build(parts, GRAIN, IMAGES, w, Math.round(w * 0.625));
    return { html, w, size: Buffer.byteLength(html, 'utf8') };
  };
  let lo = 16;
  let hi = 640;
  let best = size(hi);
  if (best.size < target) return { ...best, grain: GRAIN };
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const r = size(mid);
    if (r.size >= target) {
      best = r;
      hi = mid;
    } else lo = mid + 1;
  }
  return { ...best, grain: GRAIN };
}

/** Bytes of each part of the deck (the README's composition table), measured on the output. */
export function composition(html) {
  const b = (s) => Buffer.byteLength(s, 'utf8');
  const total = b(html);
  const fonts = [...html.matchAll(/data:font\/woff2;base64,[A-Za-z0-9+/=]+/g)].reduce((a, m) => a + m[0].length, 0);
  const images = [...html.matchAll(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g)].reduce((a, m) => a + m[0].length, 0);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => b(m[1]));
  const style = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].reduce((a, m) => a + b(m[1]), 0);
  // Elements as the parser counts them: the tags outside script and style text, and those elements themselves.
  const elements = (html.replace(/<(script|style)>[\s\S]*?<\/\1>/g, '<$1>').match(/<[a-zA-Z][^>]*>/g) || []).length;
  const pct = (x) => Math.round((x / total) * 1000) / 10;
  return {
    bytes: total,
    library: { bytes: scripts.slice(0, -1).reduce((a, x) => a + x, 0), pct: pct(scripts.slice(0, -1).reduce((a, x) => a + x, 0)), blocks: scripts.length - 1 },
    engine: scripts.at(-1),
    fonts: { bytes: fonts, pct: pct(fonts), faces: FACES.length },
    css: style - fonts,
    images: { bytes: images, pct: pct(images), count: IMAGES },
    markup: total - style - scripts.reduce((a, x) => a + x, 0) - images,
    elements,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const out = resolve(opt('--out') ?? DEFAULT_OUT);
  const target = opt('--bytes') ? Number(opt('--bytes')) : TARGET_BYTES;
  const { html, grain, size, w } = generate(target);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  const sha = createHash('sha256').update(html).digest('hex');
  console.log(JSON.stringify({ out, bytes: size, slides: SLIDES, images: IMAGES, imageSize: [w, Math.round(w * 0.625)], grain, composition: composition(html), sha256: sha }));
}
