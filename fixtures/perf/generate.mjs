#!/usr/bin/env node
// Generates the first-paint deck of the Phase 1 exit gate (SPEC 10 Phase 1, Speed: "a 2 MB deck reaches first
// paint in under 1 s"): one self-contained HTML file of about 2 MB, built like the real decks Blueline opens
// (PHASE0-FINDINGS, Josh's real decks): 30 slides, inline CSS, an inline JavaScript slide engine (keys, hash
// routing, scale to fit, a progress bar), inline SVG charts, and inline base64 PNG images that bring it to
// 2 MB. Deterministic: the same bytes on every run and every machine (a seeded PRNG, no dates, no Math.random).
//
//   node fixtures/perf/generate.mjs [--out <file>] [--bytes <n>]
//
// Default output: fixtures/perf/out/perf-2mb.html (gitignored by fixtures/perf/.gitignore; 2 MB is too large
// to commit, and the generator reproduces it exactly). Prints the path, size and sha256.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));

/** The size the exit gate names: 2 MB (2 × 1024 × 1024 bytes; the deck is at least this large). */
export const TARGET_BYTES = 2 * 1024 * 1024;
export const SLIDES = 30;
const DEFAULT_OUT = join(here, 'out', 'perf-2mb.html');

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

// ------------------------------------------------------------------------------------------- content

const TOPICS = ['Market', 'Product', 'Customers', 'Operations', 'Finance', 'Hiring', 'Roadmap', 'Risks', 'Partners', 'Platform'];
const WORDS =
  'growth retention pipeline margin velocity onboarding activation churn cohort quarter forecast revenue capacity latency coverage adoption expansion renewal backlog throughput launch pricing segment channel workflow quality'.split(
    ' ',
  );

function sentence(r, n) {
  const w = Array.from({ length: n }, () => WORDS[Math.floor(r() * WORDS.length)]);
  w[0] = w[0][0].toUpperCase() + w[0].slice(1);
  return `${w.join(' ')}.`;
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function barChart(r, title) {
  const bars = Array.from({ length: 6 }, (_, i) => ({ label: `Q${(i % 4) + 1} ${2024 + Math.floor(i / 4)}`, v: Math.round(20 + r() * 80) }));
  const rows = bars
    .map((b, i) => `<g transform="translate(0 ${i * 70})"><text x="0" y="40">${b.label}</text><rect x="180" y="12" width="${b.v * 9}" height="40" rx="6"/><text class="amount" x="${190 + b.v * 9 + 70}" y="42">${b.v}%</text></g>`)
    .join('');
  return `<figure class="chart"><svg viewBox="0 0 1200 420" width="1200" height="420" role="img" aria-label="${esc(title)}">${rows}</svg><figcaption>${esc(title)}: share of target reached</figcaption></figure>`;
}

/** The kind of slide `i` (the same rotation slideHtml uses). */
function kindOf(i) {
  return i === 0 ? 'title' : i === SLIDES - 1 ? 'end' : ['bullets', 'image', 'chart', 'table', 'quote', 'kpis', 'split'][i % 7];
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
  let body;
  switch (kind) {
    case 'title':
      body = `<p class="kicker">Quarterly review</p><h1>Northwind platform, Q3</h1><p class="sub">Synthetic deck for the Blueline first-paint measurement · ${SLIDES} slides</p><img class="hero" alt="" src="${img}">`;
      break;
    case 'end':
      body = `<h1>Thank you</h1><p class="sub">Questions and next steps</p><img class="hero" alt="" src="${img}">`;
      break;
    case 'bullets':
      body = `<h2>${esc(h2)}</h2><ul>${Array.from({ length: 5 }, () => `<li>${esc(sentence(r, 7 + Math.floor(r() * 5)))}</li>`).join('')}</ul>`;
      break;
    case 'image':
      body = `<h2>${esc(h2)}</h2><div class="media"><img alt="Illustration ${n}" src="${img}"><p>${esc(sentence(r, 18))} ${esc(sentence(r, 14))}</p></div>`;
      break;
    case 'chart':
      body = `<h2>${esc(h2)}</h2>${barChart(r, `${topic} by quarter`)}`;
      break;
    case 'table': {
      const rows = Array.from({ length: 5 }, (_, k) => `<tr><td>${esc(TOPICS[(i + k) % TOPICS.length])}</td><td>${Math.round(r() * 900 + 100)}</td><td>${(r() * 40 - 10).toFixed(1)}%</td><td>${esc(sentence(r, 4))}</td></tr>`).join('');
      body = `<h2>${esc(h2)}</h2><table><thead><tr><th>Area</th><th>Accounts</th><th>Change</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table>`;
      break;
    }
    case 'quote':
      body = `<blockquote>“${esc(sentence(r, 16).slice(0, -1))}.”</blockquote><cite>Customer interview, ${esc(topic.toLowerCase())} track</cite><img class="thumb" alt="" src="${img}">`;
      break;
    case 'kpis':
      body = `<h2>${esc(h2)}</h2><div class="kpis">${Array.from({ length: 4 }, () => `<div class="kpi"><b>${Math.round(r() * 99)}%</b><span>${esc(sentence(r, 3).slice(0, -1))}</span></div>`).join('')}</div>`;
      break;
    default:
      body = `<h2>${esc(h2)}</h2><div class="split"><div><p>${esc(sentence(r, 22))}</p><p>${esc(sentence(r, 16))}</p></div><img alt="Figure ${n}" src="${img}"></div>`;
  }
  return `<section class="slide ${kind}" data-title="${esc(topic)}" aria-label="Slide ${n}">${body}<footer><span>Northwind · Q3 review</span><span class="num">${n} / ${SLIDES}</span></footer></section>`;
}

const CSS = `
:root { --bg: #0b1020; --paper: #f7f7fb; --ink: #121528; --muted: #5d6178; --accent: #e4572e; --accent-2: #2e86ab; --line: #dfe1ea; font-family: "Inter", "Helvetica Neue", Arial, system-ui, sans-serif; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); overflow: hidden; }
.deck { position: absolute; left: 50%; top: 50%; width: 1600px; height: 900px; margin: -450px 0 0 -800px; background: var(--paper); overflow: hidden; transform-origin: 50% 50%; }
.slide { position: absolute; inset: 0; padding: 88px 112px 120px; color: var(--ink); visibility: hidden; opacity: 0; transition: opacity .4s ease, visibility .4s; }
.slide.active { visibility: visible; opacity: 1; }
@media (prefers-reduced-motion: reduce) { .slide { transition: none; } }
h1 { font-size: 112px; line-height: 1; letter-spacing: -.03em; margin: 120px 0 28px; max-width: 1100px; }
h2 { font-size: 60px; line-height: 1.1; letter-spacing: -.015em; margin: 0 0 48px; max-width: 1300px; }
.kicker { font-size: 22px; text-transform: uppercase; letter-spacing: .16em; color: var(--accent); margin: 40px 0 0; font-weight: 700; }
.sub { font-size: 30px; color: var(--muted); max-width: 900px; }
.hero { position: absolute; right: 0; bottom: 0; width: 640px; height: 900px; object-fit: cover; }
.title .hero, .end .hero { clip-path: polygon(22% 0, 100% 0, 100% 100%, 0 100%); }
ul { margin: 0; padding-left: 44px; font-size: 36px; line-height: 1.5; max-width: 1280px; }
li::marker { color: var(--accent); }
.media { display: grid; grid-template-columns: 820px 1fr; gap: 48px; align-items: start; }
.media img, .split img { width: 100%; border-radius: 18px; box-shadow: 0 18px 40px rgba(18, 21, 40, .18); }
.media p, .split p { font-size: 28px; line-height: 1.5; color: var(--muted); margin: 0 0 20px; }
.split { display: grid; grid-template-columns: 1fr 640px; gap: 64px; }
.chart { margin: 0; }
.chart rect { fill: var(--accent-2); }
.chart text { font: 26px "Inter", Arial, sans-serif; fill: var(--ink); }
.chart text.amount { font-weight: 700; text-anchor: end; }
.chart figcaption { font-size: 22px; color: var(--muted); margin-top: 16px; }
table { border-collapse: collapse; width: 100%; font-size: 26px; }
th { text-align: left; font-size: 18px; text-transform: uppercase; letter-spacing: .1em; color: var(--muted); border-bottom: 2px solid var(--ink); padding: 14px 12px; }
td { border-bottom: 1px solid var(--line); padding: 18px 12px; }
td:nth-child(2), td:nth-child(3) { font-variant-numeric: tabular-nums; }
blockquote { margin: 120px 0 28px; font: italic 60px/1.2 Georgia, "Times New Roman", serif; max-width: 1050px; }
cite { font-size: 26px; color: var(--muted); font-style: normal; }
.thumb { position: absolute; right: 112px; top: 120px; width: 260px; height: 260px; border-radius: 50%; object-fit: cover; }
.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 28px; }
.kpi { background: #fff; border: 1px solid var(--line); border-radius: 20px; padding: 36px 30px; }
.kpi b { display: block; font-size: 84px; letter-spacing: -.03em; color: var(--accent); }
.kpi span { font-size: 22px; color: var(--muted); }
footer { position: absolute; left: 112px; right: 112px; bottom: 40px; display: flex; justify-content: space-between; font-size: 18px; color: var(--muted); }
.progress { position: absolute; left: 0; bottom: 0; height: 6px; background: var(--accent); width: 0; z-index: 2; }
`;

// The slide engine: one slide shown at a time; ArrowRight/ArrowLeft, PageDown/PageUp, Space, Home and End;
// the slide in the hash (#/1 … #/30, so a reload stays put); scaled to fit the window; a progress bar.
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
  function show(i, push) {
    i = Math.max(0, Math.min(slides.length - 1, i));
    if (i === cur) return;
    if (cur >= 0) slides[cur].classList.remove('active');
    slides[i].classList.add('active');
    cur = i;
    bar.style.width = ((i + 1) / slides.length * 100) + '%';
    if (push !== false && location.hash !== '#/' + (i + 1)) history.replaceState(null, '', '#/' + (i + 1));
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
  window.addEventListener('hashchange', function () { show(fromHash(), false); });
  window.addEventListener('resize', fit);
  fit();
  show(fromHash(), false);
})();
`;

/** The deck's HTML for a given image grain (the knob that sets the file size). */
function build(grain, imageCount, w, h) {
  const images = Array.from({ length: imageCount }, (_, k) => `data:image/png;base64,${encodePng(w, h, photo(1000 + k, w, h, grain)).toString('base64')}`);
  const r = prng(42);
  const slides = Array.from({ length: SLIDES }, (_, i) => slideHtml(i, r, images)).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Northwind platform, Q3 (perf deck)</title>
<style>${CSS}</style>
</head>
<body>
<div class="deck">
${slides}
<div class="progress"></div>
</div>
<script>${ENGINE}</script>
</body>
</html>
`;
}

/** Grain of the images: enough detail that they compress like photographs, not like flat colour. */
const GRAIN = 12;
/** One distinct image per picture slide (14 of the 30). */
const IMAGES = imageSlides().length;

/**
 * The deck at TARGET_BYTES: one distinct photo-like image (16:10) per picture slide, their width found by bisection so the file
 * is at least `target` bytes, as small as that allows. Integers only, so the result is deterministic.
 */
export function generate(target = TARGET_BYTES) {
  const size = (w) => {
    const html = build(GRAIN, IMAGES, w, Math.round(w * 0.625));
    return { html, w, size: Buffer.byteLength(html, 'utf8') };
  };
  let lo = 32;
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
  console.log(JSON.stringify({ out, bytes: size, slides: SLIDES, images: IMAGES, imageSize: [w, Math.round(w * 0.625)], grain, sha256: sha }));
}
