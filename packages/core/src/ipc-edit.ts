// IPC contract of Edit mode (Phase 2; 6.3, 9.2 Committing an edit, Write protocol, Undo and redo; P2-5 to P2-14).
// Types, channel names, limits and formats only: environment-neutral, so the deck preload and main import it by
// subpath (`@blueline/core/ipc-edit`). Validators live in main (packages/app/src/main/ipc-guard.ts).
//
// Main treats every message from the deck view as written by the page (9.1). None of these messages names a
// path, a write record or a file offset: the deck names a field it opened, the version its page shows, run ids
// of that version's map, what the field held, and a token main issued for an undo. Main accepts a commit only
// from the deck view's main frame, in Edit, with editing allowed and capabilities.edit on at that moment, and
// only after it saw trusted input in that view since the field opened (P2-7); anything else is dropped silently,
// before the queue: no note, no snapshot, no session write.

import type { CommitResult, VerbatimWhy } from './edit-commit';
import type { EditPick, RefusalCode } from './types';

// ----------------------------------------------------------------------------------------- deck preload → main

/** Deck preload → main (`ipcRenderer.send`). */
export const EditDeckToMain = {
  /** EditBegin: a field opened on a click (main checks it saw the trusted mouse down that opened it, P2-7). */
  begin: 'bl:edit:begin',
  /** EditCommit: the field closed with Enter, blur or a page change (6.3 Ending an edit, 9.2 step 5). */
  commit: 'bl:edit:commit',
  /** EditCandidatesRequest: the picker of an ambiguous node asks for its candidates' context (6.3, P2-8). */
  candidates: 'bl:edit:candidates',
  /** EditUndoRequest: the toast's Undo (6.3 Saving); main checks the token is the document's latest undoable write. */
  undo: 'bl:edit:undo',
  /** EditBusy: a field is open (reloads wait, 6.6) and whether its commit is in flight. */
  busy: 'bl:edit:busy',
} as const;

/** The field's id: the preload's counter, unique per page load. */
export interface EditBegin {
  fieldId: number;
  /** The map version the page shows (DeckInit.pageVersion, advanced by its own html-text writes). */
  version: string;
  /** The runs of the field's text nodes, of that version (FieldRun.runId). */
  runIds: string[];
}

/** What the field was over, for the note's target (8 Target; the same shape as a mark's targets). */
export interface EditTarget {
  /** CSS path of the field element (dom-walk cssPath). */
  css: string;
  /** Its visible text, trimmed to EDIT_LIMITS.targetText. */
  text: string;
  /** 'heading' | 'paragraph' | 'list-item' | … (8 Target.role). */
  role: string;
  /** The field element's stamp, or null. */
  stamp: string | null;
}

export interface EditCommit {
  fieldId: number;
  /** The version recorded when the field opened (P2-5): the queue resolves a stale one by beforeText and context. */
  version: string;
  /**
   * commitField's result. For a picked substring or normalized candidate (`pick`), an `edit` result carries the
   * NODE's text (its FieldRun.value was the node's text) and main lifts it to the run with liftPick; for an equal
   * pick and for exact nodes it carries the run's whole text.
   */
  result: CommitResult;
  /** Set when the author picked the run in the picker (P2-8). */
  pick?: EditPick;
  target: EditTarget;
  /** The slide the field is on (SlideState index), or null. */
  slide: number | null;
  /** How many other visible nodes the run feeds (6.3 "· also changes N other places"). */
  alsoPlaces: number;
}

export interface EditCandidatesRequest {
  fieldId: number;
  version: string;
  /** The candidates the matcher listed for the node (MatchResult.candidates), of that version. */
  runIds: string[];
}

export interface EditUndoRequest {
  /** The token of the write, from EditResult.token. */
  token: string;
}

export interface EditBusy {
  /** A field is open. */
  edit: boolean;
  /** Its commit was sent and its result has not come back. */
  committing: boolean;
}

// ----------------------------------------------------------------------------------------- main → deck preload

/** Main → deck preload (`webContents.send`). */
export const MainToDeckEdit = {
  /** EditCandidatesReply: the picker's candidates, built by main from the DeckMap of the field's version (P2-8). */
  candidates: 'bl:edit:candidates',
  /** EditResult: what happened to a commit. Sent after MainToDeck.map with the new version (9.2 step 6). */
  result: 'bl:edit:result',
  /** EditApplied: after an app undo or redo, the text the page must show, or a reload (P2-10). */
  applied: 'bl:edit:applied',
} as const;

/** One candidate in the picker (6.3: ±40 characters of context; 9.2 Strategy 2 step 3: the key warning). */
export interface PickerCandidate {
  runId: string;
  /** 1-based line of the run in the file. */
  line: number;
  /** PICKER_CONTEXT source characters on each side of the run's text (candidateContext). */
  context: string;
  /** "This text is also used as a key at deck.html:<line>". */
  keyWarning?: string;
}

export interface EditCandidatesReply {
  fieldId: number;
  /** Only what can be written: `split` and `short` matches are never offered (P2-8). */
  candidates: PickerCandidate[];
}

export type EditResultOutcome = 'written' | 'verbatim' | 'noop' | 'refused';

export interface EditResult {
  fieldId: number;
  /**
   * written: the run holds the text (toast "Saved · deck.html:<line>"); verbatim: the text was kept as a verbatim
   * note (6.3 "When a write fails"); noop: nothing changed; refused: the commit was not taken (the field reverts).
   */
  outcome: EditResultOutcome;
  /** written: the run's new text, which the field shows (html-text writes need no reload). */
  text?: string;
  /** written: the run's 1-based line. */
  line?: number;
  /** written: 'html-text' | 'script-literal' | 'json-literal'. */
  strategy?: string;
  /** The page reloads once the field is closed (a literal write, 9.2 Strategy 2 step 5.5; an absorbed change, P2-4). */
  reload: boolean;
  /** The edit or verbatim note made. */
  noteId?: string;
  /** written: names the write for the toast's Undo (EditUndoRequest). */
  token?: string;
  /** verbatim, refused: why, for the toast. */
  why?: string;
}

/** After an app undo or redo of an html-text write: the node's text; otherwise a reload (P2-10). */
export type EditApplied = { stamp: string; textIndex: number; text: string } | { reload: true };

// ----------------------------------------------------------------------------------------- formats and limits

/** A map version: sha256 hex. */
export const VERSION_RE = /^[0-9a-f]{64}$/;
/** A run id: `h:<stamp>:<textIndex>` (Strategy 1) or `l:<unit>:<runIndex>` (Strategy 2), docs/ARCHITECTURE.md. */
export const RUN_ID_RE = /^(?:h:bl-[0-9]{1,9}:[0-9]{1,6}|l:[0-9]{1,7}:[0-9]{1,6})$/;
/** A write token main issues (EditResult.token). */
export const EDIT_TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;

export const COMMIT_KINDS: readonly CommitResult['kind'][] = Object.freeze(['edit', 'verbatim', 'noop']);
export const PICK_KINDS: readonly EditPick['kind'][] = Object.freeze(['equal', 'substring', 'normalized']);
export const RESULT_OUTCOMES: readonly EditResultOutcome[] = Object.freeze(['written', 'verbatim', 'noop', 'refused']);
export { VERBATIM_WHYS } from './edit-commit';
export type { VerbatimWhy };

/** Every RefusalCode (types.ts), for validators and reports. Only `noop` is not a note. */
export const REFUSAL_CODES: readonly RefusalCode[] = Object.freeze([
  'noop',
  'not-utf8',
  'structural',
  'stale',
  'ambiguous',
  'placeholder',
  'markup',
  'escape',
  'unaligned',
  'conflict',
  'verify',
  'refused',
  'internal',
]);

/** Source characters of context on each side of a picker candidate (6.3, 9.2 Strategy 2 step 3). */
export const PICKER_CONTEXT = 40;

/**
 * Size limits for the edit channels. Strings in UTF-8 bytes (as ipc-guard's `str` counts them); every string must
 * also be well-formed (no lone surrogate).
 */
export const EDIT_LIMITS = Object.freeze({
  /**
   * One text of a commit: the field's text before or after (verbatim), a run's text (edit), a picked node's text.
   * dom-walk keeps an element's texts up to 256 K UTF-16 units (TEXTS_MAX_CHARS); a field larger than this is
   * refused rather than truncated, since a note must hold the exact text.
   */
  text: 256 * 1024,
  /** Text nodes of one field (EditBegin.runIds) and candidates of one node (MAX_SEARCH_CANDIDATES is 50). */
  runIds: 512,
  candidates: 50,
  /** A run id (RUN_ID_RE), a token (EDIT_TOKEN_RE). */
  runId: 32,
  token: 64,
  /** EditTarget fields (the note's target; IPC_LIMITS.cssPath, targetText). */
  targetCss: 8 * 1024,
  targetText: 2 * 1024,
  targetRole: 32,
  /** Field ids are the preload's counter. */
  fieldId: 2 ** 31 - 1,
  /** Slide indexes (IPC_LIMITS.slides) and "also changes N other places". */
  slide: 10_000,
  alsoPlaces: 10_000,
  /** main → deck: a candidate's context (PICKER_CONTEXT on each side and the run's text, shortened). */
  context: 2 * 1024,
  /** main → deck: EditResult.why and a key warning. */
  why: 1024,
});

/**
 * A picker candidate's context (6.3: "±40 characters of context"): PICKER_CONTEXT source characters on each side of
 * the run's raw range [start, end) of `src`, with the run's own text in the middle, shortened with "…" to stay
 * within EDIT_LIMITS.context. Line breaks and tabs become spaces so the picker shows one line; a surrogate pair is
 * never cut.
 */
export function candidateContext(src: string, start: number, end: number): string {
  if (typeof src !== 'string' || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > src.length) return '';
  const clamp = (i: number, forward: boolean): number => {
    // Never cut a surrogate pair: move a cut that lands between the halves outward.
    if (i > 0 && i < src.length && src.charCodeAt(i) >= 0xdc00 && src.charCodeAt(i) <= 0xdfff) return forward ? i + 1 : i - 1;
    return i;
  };
  const from = clamp(Math.max(0, start - PICKER_CONTEXT), false);
  const to = clamp(Math.min(src.length, end + PICKER_CONTEXT), true);
  let mid = src.slice(start, end);
  // At most 3 UTF-8 bytes per UTF-16 unit; a few units of slack for the ellipses and pair-safe cuts.
  const room = Math.floor(EDIT_LIMITS.context / 3) - 2 * PICKER_CONTEXT - 8;
  if (mid.length > room) {
    const head = clamp(start + Math.floor(room / 2), false) - start;
    const tail = end - clamp(end - Math.floor(room / 2), true);
    mid = mid.slice(0, head) + '…' + mid.slice(mid.length - tail);
  }
  const text = (from > 0 ? '…' : '') + src.slice(from, start) + mid + src.slice(end, to) + (to < src.length ? '…' : '');
  return text.replace(/[\r\n\t\f]/g, ' ');
}
