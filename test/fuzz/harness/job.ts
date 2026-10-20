// What scripts/fuzz.mjs hands the fuzz harness (--bl-fuzz-job=<job.json>) and what the harness writes back
// (job.out). The result is the gate's report: docs/PHASE2-RESULTS.md cites it. Nothing in it names or quotes one
// of Josh's decks: local decks are called by their labels (D1–D12), and their failures carry no text.

export interface FuzzDeck {
  /** What every table, log line and file name calls the deck (fixtures path, or D1–D12 for Josh's decks). */
  label: string;
  /** The deck's copy in the work folder; the fuzz writes only to a probe copy next to it. */
  file: string;
  local: boolean;
  /** sha256 of the deck as the corpus holds it (the work copy starts identical). */
  sha256: string;
}

export interface FuzzJob {
  seed: number;
  /** Edits to make across the corpus (SPEC 10 Phase 2: 1,000). */
  edits: number;
  /** Edits written and probed per deck version (one walk and one probe load per round); also the probe's batch size. */
  batch: number;
  decks: FuzzDeck[];
  /** Share of edits made on a picked candidate when the walk offers one (P2-8). */
  pickShare: number;
  /** Share of edits sent with the version the walk saw although the deck has moved on (the stale-version path). */
  staleShare: number;
  /** Share of edits with an external write just before them (the request then names a stale version). */
  externalBeforeShare: number;
  /** Share of edits with an external write inside the atomic write, after the temp file and before the re-hash. */
  externalInsideShare: number;
  /** Share of written edits undone and redone through the queue (bytes compared exactly both times). */
  undoShare: number;
  workDir: string;
  out: string;
  /** dist/preload-deck.cjs */
  preload: string;
  /** The folder of dist/editor.cjs (the shipped Edit capability, loaded through the seam). */
  editorDir: string;
  /** The bundled field probe (harness/field-probe.ts, an IIFE). */
  fieldProbe: string;
  verbose: boolean;
  /**
   * The negative control: after some written edits the harness changes the run once more behind the oracle's back
   * (its text plus "X"), and the probe must catch each of them (the node then does not read the edited text). A gate
   * that cannot fail proves nothing; this shows the Chromium stage is not vacuous. Never part of the gate run.
   */
  negativeControl: boolean;
}

export type EditKind = 'written' | 'note' | 'noop' | 'failure';

/** One edit as the report lists it: no text (Josh's decks), only what it was and what happened. */
export interface EditRecord {
  i: number;
  deck: string;
  round: number;
  kind: EditKind;
  /** html-text, script-literal or json-literal (the target run's strategy), or null for a commit that wrote nothing. */
  strategy: string | null;
  /** commitField's reason (`commit: emptied`), the queue's code (`queue: markup`), or `pick: not liftable`. */
  reason?: string;
  pick?: 'equal' | 'substring' | 'normalized';
  stale?: boolean;
  merged?: boolean;
  external?: 'before' | 'inside';
  /** The external write inside the atomic write happened (the queue reached it). */
  fired?: boolean;
  undoRedo?: boolean;
  /** For a written edit: the mutation probe's verdict on its run (P2-16), or `unprobed` when no node showed the run. */
  probe?: 'pass' | 'fail' | 'unprobed';
  unprobed?: string;
}

export interface FuzzFailure {
  edit: number;
  deck: string;
  round: number;
  /** sha256 of the probe copy right before the edit (or before the probe load that failed). */
  version: string;
  what: string;
  /**
   * How to see it again: the seed and corpus replay the whole run; `bytes` is the probe copy as it was right before
   * the edit (in the work folder), and `request` the EditRequest sent, so the write alone can be replayed on it.
   * For Josh's decks the texts are left out (lengths only); the bytes stay in the gitignored work folder.
   */
  repro: {
    seed: number;
    bytes?: string;
    request?: unknown;
    field?: unknown;
    raw?: unknown;
    caret?: string | null;
    smartPunctuation?: boolean;
    commit?: unknown;
    outcome?: unknown;
  };
}

export interface DeckResult {
  label: string;
  local: boolean;
  sha256: string;
  bytes: number;
  utf8: boolean;
  trust: string;
  kind: string | null;
  slides: number | null;
  budget: number;
  edits: number;
  written: number;
  notes: number;
  noops: number;
  failures: number;
  /** Rounds of edits (each drawn from one walk). */
  rounds: number;
  /** Walks: one per version (the edits of a round are probed on the walk of the version they produced). */
  walks: number;
  /** Written edits the probe could not check (no node showed the run after the edit). */
  unprobed: number;
  /** Exact and pickable nodes the last walk offered. */
  exactNodes: number;
  pickableNodes: number;
  probeLoads: number;
  walkMs: number;
  editMs: number;
  probeMs: number;
  ms: number;
  /** The deck itself (its work copy) was never written: its bytes at the end are the ones read at the start. */
  originalUnchanged: boolean | null;
  skipped?: string;
  errors: string[];
}

export interface FuzzResult {
  kind: 'fuzz';
  seed: number;
  editsRequested: number;
  batch: number;
  local: boolean;
  startedAt: string;
  ms: number;
  environment: { electron: string; chrome: string; node: string; platform: string; arch: string; editorVersion: string; reducedMotion: true };
  corpus: { label: string; sha256: string; bytes: number }[];
  totals: {
    edits: number;
    written: number;
    notes: number;
    noops: number;
    failures: number;
    picks: number;
    pickWritten: number;
    stale: number;
    merged: number;
    externalBefore: number;
    externalInside: number;
    externalFired: number;
    undoRedo: number;
    probedRuns: number;
    unprobed: number;
    probeLoads: number;
    rounds: number;
    walks: number;
    /** --negative-control: changes planted behind the oracle, and how many the probe caught. */
    controlsPlanted: number;
    controlsCaught: number;
  };
  shares: { written: number; notes: number; noops: number };
  /** Notes by rule, by where the rule sits: commitField's reasons, the picker lift, and the queue's codes. */
  notesByCode: Record<string, number>;
  /** The queue's free-text reasons behind its codes, folded (fuzz-core reasonKey). */
  notesByReason: Record<string, number>;
  /** Written edits the mutation probe could not check, by why. */
  unprobedByReason: Record<string, number>;
  byStrategy: Record<string, { written: number; notes: number }>;
  /** SPEC 10 Phase 2 Inputs: how often each was typed into a field, and how often it reached the file in a written edit. */
  inputs: Record<string, { typed: number; written: number }>;
  decks: DeckResult[];
  failures: FuzzFailure[];
  edits: EditRecord[];
  method: Record<string, string>;
}
