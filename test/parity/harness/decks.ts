// Which decks the exit-gate harnesses run on, and what they are called in anything written (SPEC 10 Phase 1
// Render parity: "every slide of 20 decks"; docs/PHASE1-PLAN.md: the committed fixtures and Josh's decks).
//
// - Committed fixtures: fixtures/decks/*.html, fixtures/decks/reveal-hash/index.html, fixtures/render/*.html,
//   and the generated first-paint deck when it exists. Their label is their path under fixtures/.
// - Josh's decks: fixtures/local/*.html (gitignored). Their file names and titles identify clients, so they are
//   only ever called by their labels D1–D12 from fixtures/local/DECKS.md; a local deck that file does not
//   name gets `local-<n>`, never its name.

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface DeckSpec {
  /** What every table, file name and log line calls the deck. */
  label: string;
  /** Absolute path of the deck. */
  file: string;
  local: boolean;
  /**
   * The keys the visible view would have recorded for this deck (Session.deckNav, 6.7 Index replay). Only
   * fixtures that move on other keys than the 6.7 defaults carry one.
   */
  deckNav?: { forward: string; back: string };
}

/** Fixtures whose engine needs Session.deckNav (fixtures/render/README.md). */
const DECK_NAV: Readonly<Record<string, { forward: string; back: string }>> = Object.freeze({
  'render/arrowdown.html': { forward: 'ArrowDown', back: 'ArrowUp' },
});

function htmlIn(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /\.html?$/i.test(f) && fs.statSync(path.join(dir, f)).isFile())
      .sort();
  } catch {
    return [];
  }
}

/** The committed fixture decks, in a stable order. */
export function committedDecks(root: string): DeckSpec[] {
  const fx = path.join(root, 'fixtures');
  const out: DeckSpec[] = [];
  const add = (rel: string) => {
    const file = path.join(fx, rel);
    if (!fs.existsSync(file)) return;
    const d: DeckSpec = { label: rel, file, local: false };
    if (DECK_NAV[rel]) d.deckNav = { ...DECK_NAV[rel] };
    out.push(d);
  };
  for (const f of htmlIn(path.join(fx, 'decks'))) add(`decks/${f}`);
  add('decks/reveal-hash/index.html');
  for (const f of htmlIn(path.join(fx, 'render'))) add(`render/${f}`);
  return out;
}

/** The generated first-paint deck (fixtures/perf/generate.mjs), when it has been generated. */
export function perfDeck(root: string): DeckSpec | null {
  const file = path.join(root, 'fixtures/perf/out/perf-2mb.html');
  return fs.existsSync(file) ? { label: 'perf/perf-2mb.html', file, local: false } : null;
}

/** `- D3: name.html` lines of DECKS.md: file name → label. */
export function parseDeckLabels(md: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of md.split(/\r?\n/)) {
    const m = /^\s*[-*]\s*(D\d{1,3})\s*:\s*(.+?\.html?)\s*$/i.exec(line);
    if (m) out.set(m[2].trim(), m[1].toUpperCase());
  }
  return out;
}

/** Josh's decks in fixtures/local, labelled, in label order (D1, D2, … D12, then unlabelled ones). */
export function localDecks(root: string): DeckSpec[] {
  const dir = path.join(root, 'fixtures/local');
  let labels = new Map<string, string>();
  try {
    labels = parseDeckLabels(fs.readFileSync(path.join(dir, 'DECKS.md'), 'utf8'));
  } catch {
    // No key: every deck is local-<n>.
  }
  let n = 0;
  const out = htmlIn(dir).map((f) => ({ label: labels.get(f) ?? `local-${++n}`, file: path.join(dir, f), local: true }) as DeckSpec);
  const num = (l: string) => (/^D(\d+)$/.exec(l) ? Number(/^D(\d+)$/.exec(l)![1]) : 1000);
  return out.sort((a, b) => num(a.label) - num(b.label) || a.label.localeCompare(b.label));
}

/**
 * Replaces every local deck's file name (and its path) in `text` with its label: render-service and
 * slide-index log lines name the file, and nothing a harness prints may name Josh's decks.
 */
export function redactor(decks: readonly DeckSpec[]): (text: string) => string {
  const pairs: [string, string][] = [];
  for (const d of decks) {
    if (!d.local) continue;
    pairs.push([d.file, d.label], [path.basename(d.file), d.label]);
    try {
      const real = fs.realpathSync(d.file);
      pairs.push([real, d.label]);
    } catch {
      // gone
    }
  }
  // Longest first, so a path is replaced before its basename.
  pairs.sort((a, b) => b[0].length - a[0].length);
  return (text: string) => {
    let t = text;
    for (const [from, to] of pairs) if (from) t = t.split(from).join(to);
    for (const [from, to] of pairs) if (from) t = t.split(encodeURIComponent(from)).join(to);
    return t;
  };
}

/** Picks decks by label or path ("decks/generic-index.html", "D3", or a file path). */
export function selectDecks(all: readonly DeckSpec[], wanted: readonly string[], root: string): DeckSpec[] {
  const out: DeckSpec[] = [];
  for (const w of wanted) {
    const hit = all.find((d) => d.label === w || d.file === path.resolve(root, w) || d.file === path.resolve(w));
    if (hit) out.push(hit);
    else if (fs.existsSync(path.resolve(w))) {
      const rel = path.relative(root, path.resolve(w));
      out.push({ label: rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : path.basename(w), file: path.resolve(w), local: false });
    }
    else throw new Error(`no such deck: ${w}`);
  }
  return out;
}
