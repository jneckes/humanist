// Render products (6.7 Background renders; 6.9 Navigation, Find, Save as PDF, Print): the slide index,
// thumbnails, Find hits and `blueline pdf`. Types only (core is environment-neutral); main builds them in
// packages/app/src/main/{slide-index,thumbnails,find,pdf,print,pdf-command}.ts.

import type { SlideRef } from './types';

// ----------------------------------------------------------------------------------------- slide index

/** What 9.4 detected. reveal and generic are decks (deck view); scroll and single are documents (6.9). */
export type SlideIndexKind = 'reveal' | 'generic' | 'scroll' | 'single';

/** One slide of a deck, or one h1–h3 section of a document. */
export interface SlideIndexEntry {
  /** Position in `SlideIndex.slides`: the detected slide (decks) or the section (documents). */
  index: number;
  /**
   * Decks: the slide's title (9.4: the first h1–h3, else data-title), else its first line of text, else
   * "Slide N". Documents: the section's heading, else (text before the first heading) its first line.
   */
  title: string;
  /**
   * How to show it (SlideRef.nav, 9.4): reveal `[h, v]`, a hash, a slide index for index replay. Document
   * sections have `{ kind: 'none', value: 0 }`: a document is one page, and Find highlights with findInPage
   * over the whole page (`heading` tells the outline which heading the section starts at).
   */
  nav: SlideRef['nav'];
  /** The visible text strings of the slide or section, in document order, whitespace collapsed. */
  text: string[];
  /** Documents: the heading this section starts at, by position among the page's h1–h3 (0-based); null before the first. */
  heading?: number | null;
  /** Documents: the heading's level (1–3); absent for the text before the first heading. */
  level?: 1 | 2 | 3;
}

export interface SlideIndex {
  /** The document version (sha256 of the bytes served) the index was built from. */
  version: string;
  kind: SlideIndexKind;
  /** 9.4 navigation kind of the deck (documents: 'scroll' or 'none'). */
  navKind: SlideRef['nav']['kind'];
  slides: SlideIndexEntry[];
  /** 6.9 design size: reveal.js width/height, else the slide element's box at a 1600×900 viewport, else 1600×900. */
  designSize: { w: number; h: number };
  /** Every slide was shown by the walk (decks); documents are always complete. */
  complete: boolean;
}

// ----------------------------------------------------------------------------------------- thumbnails

/**
 * One thumbnail was written (or found in the cache): `<userData>/files/<fileKey>/thumbs/<file>`, a PNG
 * `width` CSS px wide at 2x (so `pixelWidth` is 2 × `width`), cached by (sha256, slide index, width) (6.9).
 */
export interface ThumbReady {
  version: string;
  slide: number;
  width: number;
  /** The file's name in the thumbnails folder: `<sha256>-<slide>-<width>.png`. */
  file: string;
  pixelWidth: number;
  pixelHeight: number;
  cached: boolean;
}

// ----------------------------------------------------------------------------------------- Find

/** One Find result (6.9 Find): listed by slide. */
export interface FindHit {
  /** The slide (decks) or section (documents) index in the SlideIndex. */
  slide: number;
  title: string;
  /** A short extract of the slide's text around the match, in the original spelling. */
  snippet: string;
  /** The match inside `snippet` (UTF-16 offsets, end exclusive). */
  snippetMatch: { start: number; end: number };
  /**
   * Which match this is on its slide (0-based): the occurrence findInPage must reach after navigating
   * (main/find.ts findOnSlide). Documents count across the whole page instead, since a document is one page.
   */
  matchIndex: number;
  /** The matched text in its original spelling (what findInPage is asked for). */
  text: string;
}

/** The shell asks main for Find results (main/find.ts validateFindArgs). */
export interface FindResponse {
  query: string;
  /** The index version the hits come from. */
  version: string | null;
  hits: FindHit[];
  /** More hits exist than FIND_MAX_HITS. */
  truncated: boolean;
  /** The index is still being built: the shell asks again when it is ready. */
  pending: boolean;
}

/** Find queries longer than this are refused (UTF-16 units). */
export const FIND_MAX_QUERY = 256;
/** At most this many hits are returned. */
export const FIND_MAX_HITS = 500;

// ----------------------------------------------------------------------------------------- PDF

/** How a PDF was made (6.9 Save as PDF). */
export type PdfMode = 'print-css' | 'raster' | 'document';

/** `--bl-args` of `blueline pdf deck.html [-o out.pdf]` (6.1; the CLI side builds exactly this). */
export interface PdfArgs {
  /** Absolute path of the document. */
  file: string;
  /** Absolute path of the PDF to write, or null for `<deck basename>.pdf` next to the deck. */
  out: string | null;
  /** Open the document in Protected view whatever its marker says (6.10 `--protected`). */
  protected?: boolean;
}

export interface PdfResult {
  /** Absolute path of the PDF written. */
  out: string;
  pages: number;
  mode: PdfMode;
  /** The PDF's title (from `<title>`), or null when the document has none. */
  title: string | null;
  /** Raster decks: slides navigation could not show (0-based), which have no page; empty when every slide has one. */
  missed: number[];
}

/**
 * What `--bl-cmd=pdf` writes to `--bl-out` (as core/ipc.ts CommandResult for map and check). `json` is a
 * PdfResult on success, else `{ error, message }`.
 */
export interface PdfCommandResult {
  command: 'pdf';
  exitCode: number;
  text: string;
  json: PdfResult | { error: 'usage' | 'failed' | 'interrupted'; message: string };
}

// ----------------------------------------------------------------------------------------- shell channels
// Declared by the views item through shellRouter() (main/channels.ts); names and payloads are fixed here.

export const RenderShellChannels = Object.freeze({
  /** main → shell: a thumbnail is ready (ShellThumb). */
  thumb: 'bl:render:thumb',
  /** main → shell: the slide index of the current version is ready (ShellIndexReady). */
  indexReady: 'bl:render:index-ready',
  /** shell → main (invoke): Find across slides; args [query: string] → FindResponse. */
  find: 'bl:render:find',
  /** shell → main (invoke): show a Find hit; args [slide: number, matchIndex: number] → boolean. */
  findShow: 'bl:render:find-show',
});

/** A thumbnail for the rail: `src` is the app://shell/thumbs/… URL the views item serves it at. */
export interface ShellThumb {
  version: string;
  slide: number;
  width: number;
  src: string;
}

export interface ShellIndexReady {
  version: string;
  kind: SlideIndexKind;
  count: number;
  titles: string[];
  designSize: { w: number; h: number };
}
