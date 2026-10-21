// The Chromium fuzz gate (P2-16; SPEC 10 Phase 2 exit gate "Fuzz test"; 11 "each edit is also run through the
// mutation probe in Chromium"): an Electron main of its own (bundled by harness/bundle.mjs), started by
// scripts/fuzz.mjs with --bl-fuzz-job=<job.json>. Nothing here is part of the app: no app file imports it.
//
// For each deck of the corpus, in rounds; each round is one version of the deck:
//   1. The deck's probe copy (probe.ts ProbeCopy: a hidden file next to the deck's work copy, served under the
//      deck's trust state, a fresh origin per load) is walked as `blueline map --reduced-motion` walks a deck
//      (map-command DeckWalker, in an offscreen render view with the shipped deck preload, Edit's reduced motion),
//      and every visible text node is matched with the shared matcher against the copy's current map. While the
//      walk collects a node, the harness reads its edit field in the page (field-probe.ts): the innermost element
//      that holds it, that element's textContent, and every text node in it, as the overlay records them when the
//      author clicks the node (9.2 Committing an edit step 1).
//   2. Up to `batch` targets are drawn: matcher-exact nodes, and sometimes an ambiguous node whose candidate the
//      author picks (P2-8), each in a field that shares no run with another target of the round. For each, the
//      "author" changes the field (fuzz-core browserEdit, SPEC 10 Phase 2 Inputs), and the commit is built exactly
//      as a typed one: core commitField (clean-up, smart punctuation, the run boundary and caret rule), core
//      liftPick for a picked substring or normalized candidate, then the real write queue from the shipped
//      dist/editor.cjs (loaded through the capability seam, editor-loader.ts) over the app's DeckIO
//      (atomic-write.ts createDeckIO: temp file, mode bits, extended attributes, fsync, re-hash, rename) on the
//      probe copy. Some edits are sent with the version the walk saw after the deck moved on, some after an
//      external write, and some with an external write landing inside the atomic write before its re-hash.
//   3. Every outcome is judged at once (fuzz-core): a note must be a note BY RULE with the exact before and after
//      text and a byte-identical file; a no-op is counted apart; a written edit must decode, add no parse error,
//      change only its run's raw range, re-map to the new text at its run with every other run unchanged, keep an
//      external change, and land on the run it was made on. Some are undone and redone through the queue, with
//      the bytes compared exactly both times.
//   4. The written edits of the round go through the mutation probe on the edited text (probe.ts probeTargets,
//      batched as `map` batches, each run alone on doubt; which nodes: probe-select.ts): a sentinel is appended to
//      each edited run, the copy is reloaded and each stop replayed, and the node the author typed in must read
//      exactly its new text plus its sentinel, as must the run's other renders, the sentinel must appear in no
//      other node except reported renders of the run, the page must log no new console error and keep its slide
//      count; the sentinels are undone and the copy must be byte-identical to the round's edits. A picked run is
//      judged only on where else its sentinel lands (the author chose it). An edit whose node the walk does not
//      show is probed on its own over every stop of the walk, and fails when nothing shows it; the walk itself
//      must log no new console error and keep the slide count for every round that wrote anything. Then the next
//      round walks the new version.
// The deck's own work copy is never written; at the end its bytes are compared with the ones read at the start.

import { app, session } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EditorModule, WriteQueue } from '@blueline/core/capabilities';
import { commitField, liftPick, pickKindFor, type CommitResult, type FieldRun } from '@blueline/core/edit-commit';
import type { NodeLocator } from '@blueline/core/ipc';
import { buildMap } from '@blueline/core/mapper';
import { createMatcher } from '@blueline/core/matcher';
import { decodeDeck, encodeDeck } from '@blueline/core/text';
import type { DeckMap, EditPick, EditRequest, HtmlRun, LiteralRun, WriteOutcome } from '@blueline/core/types';
import { readRegularFile, sha256Hex } from '../../../packages/app/src/main/atomic-write';
import { loadDocument, newDocumentId, type BlDocument } from '../../../packages/app/src/main/documents';
import { loadEditorDetailed } from '../../../packages/app/src/main/editor-loader';
import { DeckWalker, type WalkResult } from '../../../packages/app/src/main/map-command';
import { DEFAULT_ALLOWLIST, pickClosedLoopbackPort } from '../../../packages/app/src/main/network-policy';
import { judgeNode, locatorKey, normalizeConsoleMessage, onInterrupt, probeTargets, ProbeCopy, SENTINEL, type ProbeContext, type ProbeTarget } from '../../../packages/app/src/main/probe';
import { installDeckProtocol, registerPrivilegedSchemes } from '../../../packages/app/src/main/protocol';
import { DEFAULT_VIEWPORT, RenderView } from '../../../packages/app/src/main/render-service';
import { QUIET_SETTLE, SCRIPTED_SETTLE } from '../../../packages/app/src/main/slide-index';
import { SUBDOCUMENT_MATCH, type CountedNode } from '../../../packages/app/src/main/report';
import { installDeckSessionPolicy, type DeckSessionHandle } from '../../../packages/app/src/main/trust-hooks';
import { redactor } from '../../parity/harness/decks';
import {
  PICKED_REASONS,
  SPEC_INPUTS,
  browserEdit,
  bytesEqual,
  checkCommit,
  checkNote,
  checkWritten,
  externalComment,
  fieldRuns,
  reasonKey,
  rng,
  type CapturedField,
  type Rng,
} from './fuzz-core';
import type { DeckResult, EditRecord, FuzzDeck, FuzzFailure, FuzzJob, FuzzResult } from './job';
import { judgeAlone, roundCheck, selectNodes, type AloneStop, type AloneVerdict, type AuthorNode, type SeenNode, type WrittenEdit } from './probe-select';

// ------------------------------------------------------------------------------------------- startup

/** The isolated world the field probe runs in (RenderView uses 1029 for its own reads). */
const FIELD_WORLD_ID = 1031;
/** A field longer than this is not a target: a whole slide's text is not "the innermost element". */
const MAX_FIELD_CHARS = 20_000;
/** Rounds per deck at most (a deck whose targets keep being refused cannot loop forever). */
const MAX_ROUNDS = 400;

const jobArg = process.argv.find((a) => a.startsWith('--bl-fuzz-job='));
const job: FuzzJob | null = jobArg ? (JSON.parse(fs.readFileSync(jobArg.slice('--bl-fuzz-job='.length), 'utf8')) as FuzzJob) : null;
const redact = job ? redactor(job.decks.map((d) => ({ label: d.label, file: d.file, local: d.local }))) : (t: string) => t;

function log(msg: string): void {
  process.stderr.write(`[fuzz] ${redact(msg)}\n`);
}

function detail(msg: string): void {
  if (job?.verbose) log(msg);
}

// Before ready, as the app does (index.ts): the privileged schemes, a private userData, reduced motion (Edit
// renders with reduced motion, Josh's decision 1; `map --reduced-motion` sets this same switch), and the sandbox
// for every renderer unless running as root with --no-sandbox.
registerPrivilegedSchemes();
if (job) {
  const ud = path.join(job.workDir, `userdata-${process.pid}`);
  fs.mkdirSync(ud, { recursive: true, mode: 0o700 });
  app.setPath('userData', ud);
  app.setPath('sessionData', path.join(ud, 'session'));
}
app.commandLine.appendSwitch('force-prefers-reduced-motion');
if (!app.commandLine.hasSwitch('no-sandbox')) app.enableSandbox();
app.on('window-all-closed', () => undefined);

const startPpid = process.ppid;
setInterval(() => {
  if (process.ppid !== startPpid) {
    log('the command that started the harness went away: stopping');
    app.exit(130);
  }
}, 1000).unref();

let interrupted = false;
let currentCopy: ProbeCopy | null = null;
const unsignal = onInterrupt(
  () => currentCopy,
  (sig) => {
    if (interrupted) return;
    interrupted = true;
    log(`${sig}: stopping`);
    void (async () => {
      if (currentCopy) await currentCopy.closeWrites(3000);
      currentCopy?.removeSync();
      app.exit(130);
    })();
  },
);

void app.whenReady().then(async () => {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  let code = 0;
  try {
    if (!job) throw new Error('usage: electron fuzz-main.cjs --bl-fuzz-job=<job.json>');
    code = await runFuzz(job);
  } catch (e) {
    log(`failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    code = 2;
  }
  unsignal();
  app.exit(code);
});

// ------------------------------------------------------------------------------------------- helpers

function allRuns(map: DeckMap): (HtmlRun | LiteralRun)[] {
  return [...map.runs, ...map.literals];
}

function runOf(map: DeckMap, id: string): HtmlRun | LiteralRun | undefined {
  return allRuns(map).find((r) => r.id === id);
}

/** A seed of its own for each deck, so one deck's walk never changes another deck's edits. */
function deckSeed(seed: number, label: string): number {
  let h = seed >>> 0;
  for (let i = 0; i < label.length; i++) h = Math.imul(h ^ label.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

function count(m: Record<string, number>, k: string, n = 1): void {
  m[k] = (m[k] ?? 0) + n;
}

function msSince(t: number): number {
  return Date.now() - t;
}

/** Text of a failure for the report: verbatim for committed fixtures; only its length for Josh's decks. */
function shown(local: boolean, v: unknown): unknown {
  if (!local) return v;
  if (typeof v === 'string') return `<${v.length} chars>`;
  if (v && typeof v === 'object') return '<withheld: local deck>';
  return v;
}

/** A probe verdict's reason for the report: the deck's text it quotes is withheld for Josh's decks. */
function whyShown(local: boolean, why: string): string {
  return local ? why.replace(/"(?:[^"\\]|\\.)*"/g, '<text withheld: local deck>') : why;
}

/**
 * Reads the edit field of each collected node in the page (field-probe.ts), in an isolated world of the harness's
 * own: the element's textContent and its text nodes, with locator keys. Null for a node the page no longer shows as
 * the walk saw it.
 */
async function readFields(view: RenderView, iife: string, nodes: { key: number; locator: NodeLocator; data: string }[]): Promise<Map<number, CapturedField | null>> {
  const out = new Map<number, CapturedField | null>();
  if (nodes.length === 0) return out;
  const code = `(function(){if(!globalThis.__blFuzzField){${iife}}return globalThis.__blFuzzField.fields(${JSON.stringify(nodes)},${MAX_FIELD_CHARS});})()`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = (await Promise.race([
      view.wc.executeJavaScriptInIsolatedWorld(FIELD_WORLD_ID, [{ code }]),
      new Promise<null>((r) => {
        timer = setTimeout(() => r(null), 15_000);
      }),
    ])) as { key: number; field: { text: string; parts: { start: number; end: number; data: string; locator: NodeLocator | null }[] } | null }[] | null;
    for (const r of reply ?? []) {
      out.set(r.key, r.field ? { text: r.field.text, parts: r.field.parts.map((p) => ({ start: p.start, end: p.end, data: p.data, key: p.locator ? locatorKey(p.locator) : null })) } : null);
    }
  } catch (e) {
    detail(`field probe failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
  return out;
}

/**
 * Whether a load of this deck needs the full scripted settle (slide-index SettleMemory, decision D-5): learned on
 * its first load, where the full settle runs; a deck whose DOM changed again after a pause there (a timer's reveal)
 * keeps it, any other gets the quiet wait.
 */
interface SettleState {
  full: boolean;
  learned: boolean;
}

/** The wait after a load (`fresh`) or a move: see SettleState. */
async function settleAfterLoad(v: RenderView, st: SettleState, fresh: boolean): Promise<void> {
  if (!fresh || !st.full) {
    await v.waitScripted({ ...QUIET_SETTLE, watchFrames: false });
    return;
  }
  const r = await v.waitScripted({ ...SCRIPTED_SETTLE, watchFrames: false });
  if (!st.learned) {
    st.learned = true;
    st.full = r.late;
  }
}

// ------------------------------------------------------------------------------------------- the run

interface Tally {
  result: FuzzResult;
  edits: EditRecord[];
  failures: FuzzFailure[];
}

async function runFuzz(j: FuzzJob): Promise<number> {
  const t0 = Date.now();
  const loaded = loadEditorDetailed(j.editorDir);
  if (!loaded.editor) throw new Error(`no editor bundle (${loaded.why ?? 'not loaded'}): the fuzz gate needs a full build (npm run build), not a reader-only one`);
  const editor = loaded.editor;
  const iife = fs.readFileSync(j.fieldProbe, 'utf8');
  const result: FuzzResult = {
    kind: 'fuzz',
    seed: j.seed,
    editsRequested: j.edits,
    batch: j.batch,
    local: j.decks.some((d) => d.local),
    startedAt: new Date(t0).toISOString(),
    ms: 0,
    environment: {
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      editorVersion: editor.editorVersion,
      reducedMotion: true,
    },
    corpus: [],
    totals: { edits: 0, written: 0, notes: 0, noops: 0, failures: 0, picks: 0, pickWritten: 0, stale: 0, merged: 0, externalBefore: 0, externalInside: 0, externalFired: 0, undoRedo: 0, probedRuns: 0, probedAlone: 0, unprobed: 0, probeLoads: 0, rounds: 0, walks: 0, controlsPlanted: 0, controlsCaught: 0 },
    shares: { written: 0, notes: 0, noops: 0 },
    notesByCode: {},
    notesByReason: {},
    unprobedByReason: {},
    byStrategy: {},
    inputs: Object.fromEntries(SPEC_INPUTS.map((s) => [s.name, { typed: 0, written: 0 }])),
    decks: [],
    failures: [],
    edits: [],
    method: methodText(j),
  };
  const tally: Tally = { result, edits: result.edits, failures: result.failures };
  // The edits are spread over the decks by the seed; a deck that cannot take its share (no editable text, not
  // UTF-8) hands it on to the decks after it, and what is left at the end goes round again.
  const master = rng(j.seed);
  const budget = new Array<number>(j.decks.length).fill(0);
  for (let i = 0; i < j.edits; i++) budget[master.int(j.decks.length)]++;
  let carry = 0;
  const usable: number[] = [];
  for (let d = 0; d < j.decks.length && !interrupted; d++) {
    const want = budget[d] + carry;
    const r = await runDeck(j, j.decks[d], want, rng(deckSeed(j.seed, j.decks[d].label)), editor, iife, tally);
    carry = want - r.edits;
    if (r.edits > 0 && !r.skipped) usable.push(d);
  }
  for (let pass = 1; carry > 0 && usable.length > 0 && pass <= 3 && !interrupted; pass++) {
    const per = Math.ceil(carry / usable.length);
    for (const d of usable) {
      if (carry <= 0 || interrupted) break;
      const r = await runDeck(j, j.decks[d], Math.min(per, carry), rng(deckSeed(j.seed + pass, j.decks[d].label)), editor, iife, tally, pass);
      carry -= r.edits;
    }
  }
  const t = result.totals;
  result.shares = { written: t.written / Math.max(1, t.edits), notes: t.notes / Math.max(1, t.edits), noops: t.noops / Math.max(1, t.edits) };
  result.ms = msSince(t0);
  fs.mkdirSync(path.dirname(j.out), { recursive: true });
  fs.writeFileSync(j.out, JSON.stringify(result, null, 1) + '\n');
  log(`done: ${t.edits} edits, ${t.written} written, ${t.notes} notes by rule, ${t.noops} no-ops, ${t.failures} failures in ${Math.round(result.ms / 1000)} s`);
  return 0;
}

function methodText(j: FuzzJob): Record<string, string> {
  return {
    path:
      'each edit takes the typed path (SPEC 10 Phase 2 "Path"): the field the overlay records (the innermost element holding the clicked node, read in the page during the walk), core commitField (clean-up, smart punctuation on 80% of edits, the run boundary and caret rule), core liftPick for picked substring and normalized candidates, then the write queue of the shipped dist/editor.cjs over the app\'s DeckIO (atomic-write createDeckIO) on a probe copy',
    targets: `matcher-exact visible nodes of a walk of the current version (map-command DeckWalker, reduced motion), and with a share of ${j.pickShare} an ambiguous node whose candidate is picked (reasons ${[...PICKED_REASONS].join(', ')}); targets of one round share no run`,
    concurrency: `stale-version requests ${j.staleShare}, an external write (an HTML comment at the end of the body) just before the edit ${j.externalBeforeShare}, and one inside the atomic write after the temp file and before the re-hash ${j.externalInsideShare}`,
    notes: 'a note passes only by rule (commitField reasons; liftPick refusals; queue codes not-utf8, structural, stale, ambiguous, placeholder, markup, escape, unaligned), with the exact before and after text and a byte-identical file (or exactly the external write that raced it); internal, conflict, verify and refused are failures; no-ops are counted apart',
    written:
      'the file decodes, the outcome version is its hash, the diff is exactly the record\'s splice inside the target run, re-mapping finds the new text at that run and every other run unchanged, no parse5 error code is new, an external change survives, the edit lands on the run it was made on; a share is undone and redone with the bytes compared exactly',
    probe:
      `the mutation probe on the written text (probe.ts probeTargets, batches of up to ${j.batch} like blueline map, each run alone on doubt), on the walk of the version the round's edits produced (nodes chosen by probe-select.ts): the node the author typed in (the clicked node when the commit landed on its run, else the field's node of the commit's run), found by its locator, reads exactly the new text plus the sentinel, and so does every other render of the run (its exact nodes, and the nodes where the walk before the edits saw it that read the new text); the author's node showing other text fails ('[render]'), whatever other renders show; the sentinel is in no other node except reported renders of the run, no console error the version before the edits did not log, that version's slide count, and the copy is byte-identical after the undo; a picked run is judged on everything but its own node; an edit whose node the walk does not show is probed on its own (a load with its sentinel alone, every stop of the walk replayed and settled as the walk settles) and fails when no stop shows it ('[probe] the edit shows nowhere'); for every round that wrote anything, the walk of the new version must log no console error the walk before did not and keep its slide count, whether or not a node is left to probe; an edit the probe could not reach at all (the walk failed) is counted as not probed, and scripts/fuzz.mjs exits 1 on it as on a failure`,
    settle:
      'the walk and the probe wait for what the deck\'s scripts reveal (render-service waitScripted): the full scripted settle (1.5 s, then 400 ms without a DOM change) after a load while the deck is known to reveal text late, else the quiet wait (400 ms without a change), and the quiet wait after every move',
  };
}

// ------------------------------------------------------------------------------------------- one deck

interface Target {
  node: CountedNode;
  field: CapturedField;
  runs: FieldRun[];
  /** The run the node is edited as: its exact run, or the picked candidate. */
  runId: string;
  /** The node's place in the field. */
  part: { start: number; end: number; data: string };
  pick: { kind: EditPick['kind'] } | null;
}

interface Written {
  target: Target;
  req: EditRequest;
  out: Extract<WriteOutcome, { ok: true }>;
  record: EditRecord;
  /** --negative-control: the run's text after the change planted behind the oracle (the probe must catch it). */
  planted?: string;
}

async function servePartition(doc: BlDocument, copyRef: { copy: ProbeCopy | null }): Promise<DeckSessionHandle> {
  const ses = session.fromPartition(doc.partition);
  const policy = installDeckSessionPolicy(ses, {
    trust: () => doc.trust(),
    networkAllowed: () => doc.networkAllowed(),
    strict: () => false,
    allowlist: () => DEFAULT_ALLOWLIST,
    blockPort: await pickClosedLoopbackPort(),
    sourcePath: () => doc.realpath,
  });
  try {
    await policy.ready;
  } catch (e) {
    policy.dispose();
    throw e;
  }
  // The copy answers every docId it was given: each load is a fresh origin (probe.ts, review finding 30).
  installDeckProtocol(ses, (id) => (id === doc.docId ? doc : (copyRef.copy?.servedAs(id) ?? undefined)));
  return policy;
}

async function runDeck(j: FuzzJob, spec: FuzzDeck, want: number, r: Rng, editor: EditorModule, iife: string, tally: Tally, pass = 0): Promise<DeckResult> {
  const t0 = Date.now();
  const res: DeckResult = {
    label: pass ? `${spec.label} (pass ${pass + 1})` : spec.label,
    local: spec.local,
    sha256: spec.sha256,
    bytes: 0,
    utf8: true,
    trust: '',
    kind: null,
    slides: null,
    budget: want,
    edits: 0,
    written: 0,
    notes: 0,
    noops: 0,
    failures: 0,
    rounds: 0,
    walks: 0,
    unprobed: 0,
    probedAlone: 0,
    exactNodes: 0,
    pickableNodes: 0,
    probeLoads: 0,
    walkMs: 0,
    editMs: 0,
    probeMs: 0,
    ms: 0,
    originalUnchanged: null,
    errors: [],
  };
  tally.result.decks.push(res);
  if (want <= 0) {
    res.skipped = 'no edits to make';
    return res;
  }
  let doc: BlDocument;
  try {
    doc = await loadDocument(spec.file, { protectedRequested: false });
  } catch (e) {
    res.errors.push(`could not open: ${e instanceof Error ? e.message : String(e)}`);
    res.skipped = 'could not open';
    return res;
  }
  res.bytes = doc.bytes.length;
  res.utf8 = doc.utf8;
  res.trust = doc.trust();
  if (!pass) tally.result.corpus.push({ label: spec.label, sha256: doc.version, bytes: doc.bytes.length });
  if (doc.version !== spec.sha256) res.errors.push('the work copy is not the corpus deck (hash differs)');
  if (!doc.utf8) {
    // 9.2 rule 1: a deck that is not UTF-8 opens read-only and Edit is off, so no edit can start on it.
    res.skipped = 'not UTF-8: Edit is off for it (9.2 rule 1)';
    return res;
  }
  log(`${spec.label}: ${want} edits`);
  const copyRef: { copy: ProbeCopy | null } = { copy: null };
  let policy: DeckSessionHandle | null = null;
  let view: RenderView | null = null;
  try {
    policy = await servePartition(doc, copyRef);
    view = RenderView.create({
      partition: doc.partition,
      preload: j.preload,
      viewport: { ...DEFAULT_VIEWPORT },
      folderReal: doc.folderReal,
      isProtected: () => doc.trust() === 'protected',
      networkOpen: () => doc.trust() === 'trusted' || doc.networkAllowed(),
      log: detail,
    });
    const copy = await ProbeCopy.create(doc, newDocumentId());
    copyRef.copy = copy;
    currentCopy = copy;
    // An external writer that lands inside the atomic write: after the temp file has the new bytes and before the
    // re-hash (atomic-write.ts prepareTemp), once (9.2 Atomic write step 4.3 must catch it and requeue).
    let inside: (() => Promise<void>) | null = null;
    const io = copy.io({
      write: {
        prepareTemp: async () => {
          const f = inside;
          inside = null;
          if (f) await f();
        },
      },
    });
    // The bare queue, as the probe uses it: no history snapshots and no session (the subject is the patcher).
    const queue = editor.createWriteQueue(io);
    const fields = new Map<number, CapturedField | null>();
    const settle: SettleState = { full: true, learned: false };
    const v = view;
    const collect = v.collect.bind(v);
    let settledLoad: string | null = null;
    v.collect = async () => {
      // What the deck's scripts reveal on a timer is part of what the author sees: a node collected before a timer
      // fills it is not the text the page shows, and a probe that reloads later sees the timer's text instead. So,
      // as the render products do (render-service waitScripted, slide-index SettleMemory): after a load, the full
      // scripted settle (at least 1.5 s, then 400 ms without a DOM change) while the deck is known to reveal text
      // late, else the quiet wait; and the quiet wait at every later stop.
      const fresh = v.loaded?.docId !== settledLoad;
      settledLoad = v.loaded?.docId ?? null;
      await settleAfterLoad(v, settle, fresh);
      const got = await collect();
      const ask = got.nodes.filter((w) => (w.tree ?? 'document') === 'document' && !fields.has(w.key)).map((w) => ({ key: w.key, locator: w.locator, data: w.node.data }));
      for (const [k, f] of await readFields(v, iife, ask)) fields.set(k, f);
      return got;
    };
    const normalize = (m: string) => normalizeConsoleMessage(m, { docIds: copy.docIds, rename: [] });

    // One walk per version. The walk of the version a round's edits produced is also what the mutation probe checks
    // them against (its nodes, stops and replay belong to that version's layout), and the next round draws its
    // targets from it. The probe's baseline (console errors, slide count) is the walk of the version before the
    // edits, so an edit that breaks a script or the slide count fails.
    let pending: Written[] = [];
    let before: { walk: WalkResult; nodes: CountedNode[]; round: number } | null = null;
    for (;;) {
      if (interrupted) break;
      const moreEdits = res.edits < want && res.rounds < MAX_ROUNDS;
      if (!moreEdits && pending.length === 0) break;
      const bytes = await copy.read();
      const version = sha256Hex(bytes);
      const src = decodeDeck(bytes).src;
      const map = buildMap(src, { version, utf8: true, defer: false });
      // P2-3: the queue knows the version the page holds, so a stale edit made on it is placed by position through
      // a diff (9.2 step 2, E-1). Pinned for the round, as main pins a version a page or field holds: a round
      // writes up to `batch` versions after it, more than the queue keeps unpinned, and the round's stale-version
      // requests name this one. (An editor bundle built before pins existed ignores the option and has no unpin.)
      queue.know(version, src, map, { pin: true });
      fields.clear();
      const tw = Date.now();
      const walker = new DeckWalker(v, detail);
      let walk: WalkResult;
      try {
        walk = await walker.walk({ docId: copy.addDocId(newDocumentId()), fileName: copy.fileName });
      } catch (e) {
        res.errors.push(`the walk of version ${version.slice(0, 12)} failed: ${e instanceof Error ? e.message : String(e)}`);
        for (const w of pending) unprobed(tally, res, w, 'the walk after the edits failed');
        break;
      }
      res.walkMs += msSince(tw);
      res.walks++;
      tally.result.totals.walks++;
      res.kind = walk.detect.kind;
      res.slides = walk.detect.count;
      const matcher = createMatcher(map, { fileName: copy.fileName });
      const nodes: CountedNode[] = walk.nodes.map(({ w, slide, stop }) => ({
        key: w.key,
        slide,
        stop,
        locator: w.locator,
        node: w.node,
        match: w.tree === 'shadow' || w.tree === 'frame' ? { ...SUBDOCUMENT_MATCH, candidates: [] } : matcher(w.node),
      }));

      // 4. The mutation probe on the text the last round wrote, batched like `map`.
      if (pending.length > 0 && before) {
        const tp = Date.now();
        await probeWritten({ j, spec, tally, res, editor, v, copy, queue, walker, walk, nodes, before, pending, version, bytes, normalize, settle });
        res.probeMs += msSince(tp);
        pending = [];
      }
      if (!moreEdits) break;

      // 1–3. The next round: targets from this walk, then the edits.
      res.rounds++;
      tally.result.totals.rounds++;
      const round = res.rounds;
      const targets = drawTargets(r, nodes, fields, map, Math.min(j.batch, want - res.edits), j.pickShare, res);
      if (targets.length === 0) {
        detail(`${spec.label}: round ${round}: nothing left to edit`);
        break;
      }
      const te = Date.now();
      const written: Written[] = [];
      // The version the page holds: the walk's, then each of its own writes (P2-6: html-text writes advance it). A
      // note leaves it as it was, also when an external write landed: the page has not seen that one.
      let known = version;
      for (const t of targets) {
        if (interrupted) break;
        const w = await oneEdit({ j, spec, r, t, map, walkVersion: version, known, copy, queue, round, tally, res, setInside: (f) => (inside = f) });
        inside = null;
        if (w) {
          written.push(w);
          known = w.out.version;
          if (j.negativeControl && !w.req.pick && tally.result.totals.written % 5 === 0) {
            // Behind the oracle's back: the run changes once more, so its node no longer reads the edited text.
            const planted = w.req.afterText + 'X';
            const c = await queue.edit({ version: known, runId: w.out.runId, beforeText: w.req.afterText, afterText: planted });
            if (c.ok) {
              w.planted = planted;
              known = c.version;
              tally.result.totals.controlsPlanted++;
            }
          }
        }
      }
      res.editMs += msSince(te);
      // The round is over: no later request names its walk's version (the probe writes on the newest one).
      if (typeof queue.unpin === 'function') queue.unpin(version);
      pending = written;
      before = { walk, nodes, round };
    }
    // The deck itself was never written (only its probe copy).
    try {
      res.originalUnchanged = bytesEqual(await readRegularFile(doc.realpath), doc.bytes);
    } catch {
      res.originalUnchanged = false;
    }
    if (res.originalUnchanged === false) res.errors.push('the deck changed during the run');
  } catch (e) {
    res.errors.push(`harness: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  } finally {
    copyRef.copy?.removeSync();
    currentCopy = null;
    view?.close();
    policy?.dispose();
    res.ms = msSince(t0);
  }
  for (const e of res.errors) log(`${spec.label}: ${e}`);
  log(`${spec.label}: ${res.edits} edits (${res.written} written, ${res.notes} notes, ${res.noops} no-ops, ${res.failures} failures) in ${res.rounds} rounds, ${Math.round(res.ms / 1000)} s`);
  return res;
}

/**
 * A written edit the mutation probe could not reach at all (the walk of the version after it failed): counted and
 * reported apart, and scripts/fuzz.mjs exits 1 on it as on a failure (E-12: an edit that cannot be probed fails
 * unless it is probed on its own, which needs that walk).
 */
function unprobed(tally: Tally, res: DeckResult, w: Written, why: string): void {
  w.record.probe = 'unprobed';
  w.record.unprobed = why;
  tally.result.totals.unprobed++;
  res.unprobed++;
  count(tally.result.unprobedByReason, why);
}

type ProbeArgs = {
  j: FuzzJob;
  spec: FuzzDeck;
  tally: Tally;
  res: DeckResult;
  editor: EditorModule;
  v: RenderView;
  copy: ProbeCopy;
  queue: WriteQueue;
  walker: DeckWalker;
  walk: WalkResult;
  nodes: CountedNode[];
  before: { walk: WalkResult; nodes: CountedNode[]; round: number };
  pending: Written[];
  version: string;
  bytes: Uint8Array;
  normalize(m: string): string;
  settle: SettleState;
};

/** A walk's node as probe-select.ts reads it. */
type Seen = SeenNode & { node: CountedNode };

function seenOf(n: CountedNode): Seen {
  return { key: locatorKey(n.locator), data: n.node.data, exact: n.match.confidence === 'exact' ? (n.match.runId ?? null) : null, node: n };
}

/** A written edit as probe-select.ts reads it: the run it went to, the clicked node and the field's mapped nodes. */
function editOf(w: Written): WrittenEdit {
  const t = w.target;
  const field = t.runs.flatMap((r) => {
    const p = t.field.parts.find((x) => x.start === r.start && x.end === r.end && x.key !== null);
    return p?.key ? [{ key: p.key, data: p.data, runId: r.runId }] : [];
  });
  return {
    runId: w.out.runId,
    text: w.planted ?? w.req.afterText,
    pick: !!w.req.pick,
    target: { key: locatorKey(t.node.locator), data: t.node.node.data, runId: t.runId },
    field,
  };
}

/** A node handed to probeTargets: a copy, so a verdict written onto it belongs to this edit's run alone. */
function probeNode(n: CountedNode): CountedNode {
  const c = { ...n };
  delete c.probe;
  return c;
}

/**
 * The mutation probe on the text a round wrote (P2-16; SPEC 10 Phase 0 probe step 4, which SPEC 10 Phase 2 reuses:
 * the sentinel in that DOM text node and in no other node except reported renders of the run, no new console
 * error, the same slide count), on the walk of the version those edits produced. "That node" is the node the
 * author typed in (probe-select.ts authorNodes; review finding 25): found by its locator, it must read exactly the
 * new text plus the sentinel, and it showing other text is a failure ('[render]') whatever the run's other renders
 * show; those renders (its exact nodes, and the nodes where the walk before the edits saw it that now read the new
 * text) are judged with it. A picked run is judged on its picked node, on where else its sentinel lands. An edit
 * whose node the walk does not show (the walk counts only what is in view) is probed on its own (probeAlone) and
 * fails when nothing shows it (review finding 26). Whatever is left to probe, the walk of the new version must log
 * no console error the walk before the edits did not log and keep its slide count: the walk is a load of that
 * version too, so an edit that breaks a script or the slide count fails even when it leaves no node to probe.
 */
async function probeWritten(o: ProbeArgs): Promise<void> {
  const { j, spec, tally, res, v, nodes } = o;
  const totals = tally.result.totals;
  /**
   * A written edit the probe failed. Under --negative-control a planted change is caught by any verdict the probe
   * reached (`judged`); one it could not judge (an aborted probe, a load that threw) is a control that failed.
   */
  const failed = (w: Written, what: string, judged = true): void => {
    w.record.probe = 'fail';
    if (w.planted !== undefined && judged) {
      totals.controlsCaught++;
      return;
    }
    demote(tally, res, w);
    fail(tally, res, {
      edit: w.record.i,
      deck: spec.label,
      round: o.before.round,
      version: o.version,
      what: w.planted !== undefined ? `[control] the probe did not catch a planted change (${what})` : what,
      repro: { seed: j.seed, request: shown(spec.local, w.req), outcome: { runId: w.out.runId, line: w.out.line, merged: w.out.merged } },
    });
  };
  const before = o.before.nodes.map(seenOf);
  const after = nodes.map(seenOf);
  const checked: { w: Written; target: ProbeTarget }[] = [];
  const alone: { w: Written; author: AuthorNode[] }[] = [];
  for (const w of o.pending) {
    const text = w.planted ?? w.req.afterText;
    const sel = selectNodes(editOf(w), before, after);
    if (sel.kind === 'render') {
      // The page shows other text in the node the author typed in: the edit does not render as written there.
      const where = spec.local ? '' : ` (${sel.node.node.locator.cssPath})`;
      failed(w, `[render] after the edit the node the author typed in${where} reads ${JSON.stringify(shown(spec.local, sel.node.data))}, not the new text`);
    } else if (sel.kind === 'lost') failed(w, '[probe] the field holds no node of the run the edit was written to');
    else if (sel.kind === 'picked') checked.push({ w, target: { runId: w.out.runId, nodes: [probeNode(sel.node.node)], before: text, picked: true } });
    else if (sel.kind === 'probe') {
      checked.push({ w, target: { runId: w.out.runId, nodes: [...sel.author, ...sel.extra].map((x) => probeNode(x.node)), before: text, expect: w.req.afterText } });
    } else alone.push({ w, author: sel.author });
  }
  const baseline = new Set(o.before.walk.consoleErrors.map((e) => o.normalize(e.message)));
  const roundWhy = roundCheck({ baseline, errors: o.walk.consoleErrors.map((e) => o.normalize(e.message)), slidesBefore: o.before.walk.detect.count, slidesAfter: o.walk.detect.count });
  if (roundWhy) {
    // The walk cannot tell which edit of the round did it, nor can a probe load of this version (each holds every
    // edit of the round): every edit of the round not failed already fails, as a batch probe's runs do.
    for (const c of [...checked.map((x) => x.w), ...alone.map((x) => x.w)]) failed(c, `[probe] ${whyShown(spec.local, roundWhy)}`);
    return;
  }
  let aborted: string | null = null;
  if (checked.length > 0) {
    const ctx: ProbeContext = {
      view: v,
      editor: o.editor,
      copy: o.copy,
      original: { bytes: o.bytes, version: o.version },
      queue: o.queue,
      nodes,
      slideCount: o.before.walk.detect.count,
      baselineErrors: baseline,
      normalize: (e) => o.normalize(e.message),
      start: async () => {
        // After the probe's reload: the same settle as the walk's first stop.
        await settleAfterLoad(v, o.settle, true);
        await o.walker.startReplay();
      },
      replay: async (i) => {
        const ok = await o.walker.replay(i);
        await v.waitScripted({ ...QUIET_SETTLE, watchFrames: false });
        return ok;
      },
      newDocId: () => newDocumentId(),
      log: detail,
      interrupted: () => interrupted,
      batchSize: j.batch,
    };
    try {
      const pr = await probeTargets(ctx, checked.map((c) => c.target));
      res.probeLoads += pr.loads ?? 0;
      totals.probeLoads += pr.loads ?? 0;
      aborted = pr.aborted;
    } catch (e) {
      aborted = `the probe threw: ${e instanceof Error ? e.message : String(e)}`;
    }
    totals.probedRuns += checked.length;
    if (!bytesEqual(await o.copy.read(), o.bytes)) aborted = aborted ?? 'the copy is not byte-identical to the edits after the probe';
    for (const { w, target } of checked) {
      const bad = target.nodes.map((n) => n.probe).find((p) => !p || !p.pass);
      if (!bad && !aborted) {
        if (w.planted !== undefined) {
          // A planted change must fail the probe; one that passes means the Chromium stage cannot see a wrong text.
          failed(w, 'it passed', false);
          continue;
        }
        w.record.probe = 'pass';
        continue;
      }
      failed(w, `[probe] ${whyShown(spec.local, aborted ?? (bad && !bad.pass ? bad.why : 'the probe could not check it'))}`, !aborted);
    }
  }
  for (const { w, author } of alone) {
    w.record.alone = true;
    totals.probedAlone++;
    res.probedAlone++;
    if (aborted || interrupted) {
      failed(w, `[probe] not probed: ${aborted ?? 'interrupted'}`, false);
      continue;
    }
    const r = await probeAlone(o, w, author);
    totals.probedRuns++;
    if ('aborted' in r) {
      aborted = r.aborted;
      failed(w, `[probe] ${r.aborted}`, false);
      continue;
    }
    if (r.verdict.pass) {
      if (w.planted !== undefined) failed(w, 'it passed', false);
      else w.record.probe = 'pass';
      continue;
    }
    const why = r.verdict.render
      ? `[render] after the edit the node the author typed in reads ${JSON.stringify(shown(spec.local, r.verdict.reads))}, not the new text (probed on its own)`
      : `[probe] ${whyShown(spec.local, r.verdict.why)}${r.verdict.why.startsWith('the edit shows nowhere') ? '' : ' (probed on its own)'}`;
    failed(w, why, r.judged);
  }
}

/**
 * Review finding 26 (a): a written edit whose node the round's walk does not show, probed on its own. Its run
 * alone gets the sentinel, the copy is reloaded (a fresh origin, as every probe load) and settled as the walk's
 * first stop, and every stop of the walk is shown again in order and settled as the walk settles; at each stop
 * the sentinel must be in no node other than reported renders of the run, with no new console error and the same
 * slide count (judgeNode, everything but the node itself), and the node the author typed in must be visible at
 * some stop reading exactly the new text plus the sentinel (a picked node need only be visible). The sentinel is
 * undone and the copy must be byte-identical to the round's edits; one that cannot be restored stops the deck's
 * probing (`aborted`).
 */
async function probeAlone(o: ProbeArgs, w: Written, author: AuthorNode[]): Promise<{ verdict: AloneVerdict; judged: boolean } | { aborted: string }> {
  const { v, copy, queue } = o;
  const text = w.planted ?? w.req.afterText;
  const runId = w.out.runId;
  // The author's locators: the walk before the edit counted each of them (the field's nodes map exactly there).
  const locOf = new Map(o.before.nodes.map((n) => [locatorKey(n.locator), n.locator] as const));
  locOf.set(locatorKey(w.target.node.locator), w.target.node.locator);
  const locs = author.flatMap((a) => {
    const l = locOf.get(a.key);
    return l ? [{ key: a.key, locator: l }] : [];
  });
  if (locs.length !== author.length) return { verdict: { pass: false, render: false, why: 'the node the author typed in has no locator the walk counted' }, judged: false };
  const reported = new Set(o.nodes.map((n) => locatorKey(n.locator)));
  const sameRun = new Set([
    ...o.nodes.filter((n) => n.match.runId === runId || (n.match.confidence === 'ambiguous' && n.match.candidates.some((c) => c.runId === runId))).map((n) => locatorKey(n.locator)),
    ...locs.map((l) => l.key),
  ]);
  const baseline = new Set(o.before.walk.consoleErrors.map((e) => o.normalize(e.message)));
  let written: WriteOutcome;
  try {
    written = await queue.edit({ version: o.version, runId, beforeText: text, afterText: text + SENTINEL });
  } catch (e) {
    written = { ok: false, verbatim: { before: text, after: text + SENTINEL }, why: e instanceof Error ? e.message : String(e), code: 'internal' };
  }
  if (!written.ok) {
    if (!bytesEqual(await copy.read(), o.bytes)) return { aborted: 'the refused sentinel write changed the copy' };
    return { verdict: { pass: false, render: false, why: `the patcher did not write the sentinel: ${written.why}` }, judged: false };
  }
  const stops: AloneStop[] = [];
  let trouble: string | null = null;
  try {
    await v.load({ docId: copy.addDocId(newDocumentId()), fileName: copy.fileName });
    o.res.probeLoads++;
    o.tally.result.totals.probeLoads++;
    await v.waitStable(300);
    const slideCountAfter = (await v.detect()).count;
    await settleAfterLoad(v, o.settle, true);
    await o.walker.startReplay();
    for (let i = 0; i < o.walk.stops.length && !interrupted; i++) {
      const reached = await o.walker.replay(i);
      await v.waitScripted({ ...QUIET_SETTLE, watchFrames: false });
      await v.waitStable(300);
      if (!reached) {
        detail(`probe alone ${runId} stop ${i + 1}/${o.walk.stops.length}: not reached`);
        stops.push({ reached: false, nodes: [], rest: { pass: true } });
        continue;
      }
      const found = await v.find(SENTINEL);
      const newErrors = v
        .consoleErrors()
        .map((e) => o.normalize(e.message))
        .filter((m) => !baseline.has(m));
      const at: AloneStop['nodes'][number][] = [];
      for (const l of locs) {
        const r = await v.locate(l.locator).catch(() => null);
        if (!r?.found || !r.node) continue;
        const b = r.node.rect;
        const laidOut = b.w > 0 && b.h > 0;
        const inView = laidOut && b.x < v.viewport.w && b.x + b.w > 0 && b.y < v.viewport.h && b.y + b.h > 0;
        at.push({ key: l.key, data: r.node.node.data, visible: r.visible, laidOut, inView, ...(r.slide === null ? {} : { onSlide: r.slide === o.walk.stops[i].slide }) });
      }
      const rest = judgeNode({
        reached: true,
        slideCountBefore: o.before.walk.detect.count,
        slideCountAfter,
        located: null,
        found,
        self: locs[0].locator,
        sameRun,
        reported,
        newErrors,
        sentinel: SENTINEL,
        pickedRun: true,
      });
      stops.push({ reached: true, nodes: at, rest });
      // --verbose: what each stop showed, as counts only (no deck text).
      const want = text + SENTINEL;
      detail(`probe alone ${runId} stop ${i + 1}/${o.walk.stops.length}: author node found ${at.length}, visible ${at.filter((n) => n.visible).length}, laid out ${at.filter((n) => n.laidOut).length}, in the viewport ${at.filter((n) => n.inView).length}, on this stop's slide ${at.filter((n) => n.onSlide !== false).length}, with the new text ${at.filter((n) => n.data === want).length}; sentinel in ${found.matches.length} nodes; ${rest.pass ? 'rules kept' : 'a rule broken'}`);
    }
    if (interrupted) trouble = 'interrupted';
  } catch (e) {
    trouble = `the probe could not check it: ${e instanceof Error ? e.message : String(e)}`;
  }
  // Undo the sentinel through the patcher; the copy must be the round's edits again, byte for byte.
  let undoWhy: string | null = null;
  try {
    const u = await queue.undo(written.record);
    if (!u.ok) undoWhy = `undo failed: ${u.why}`;
  } catch (e) {
    undoWhy = `undo failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (!bytesEqual(await copy.read(), o.bytes)) {
    try {
      await copy.restore(o.bytes);
    } catch {
      // judged below
    }
    if (!bytesEqual(await copy.read(), o.bytes)) return { aborted: 'the probe copy could not be restored' };
    undoWhy = undoWhy ?? "undo did not restore the copy's bytes exactly";
  }
  if (trouble ?? undoWhy) return { verdict: { pass: false, render: false, why: (trouble ?? undoWhy)! }, judged: false };
  return { verdict: judgeAlone(stops, { author, want: w.req.pick ? null : w.req.afterText + SENTINEL }), judged: true };
}

/** A written edit that failed in Chromium: no longer counted as written. */
function demote(tally: Tally, res: DeckResult, w: Written): void {
  w.record.kind = 'failure';
  res.written--;
  tally.result.totals.written--;
}

/**
 * Up to `n` targets for one round: exact nodes, and with `pickShare` an ambiguous node whose candidate the author
 * picks. Each target's field shares no run with another's, so every edit of the round is made on the text the
 * walk saw (an edit field never holds text an earlier edit of the round changed).
 */
function drawTargets(r: Rng, nodes: CountedNode[], fields: Map<number, CapturedField | null>, map: DeckMap, n: number, pickShare: number, res: DeckResult): Target[] {
  const byKey = new Map<string, CountedNode[]>();
  for (const c of nodes) {
    const k = locatorKey(c.locator);
    const list = byKey.get(k);
    if (list) list.push(c);
    else byKey.set(k, [c]);
  }
  const exactOf = (key: string, data: string) => {
    const c = byKey.get(key)?.find((x) => x.node.data === data && x.match.confidence === 'exact' && x.match.runId);
    return c?.match.runId ? { runId: c.match.runId } : null;
  };
  const exact: Target[] = [];
  const picks: Target[] = [];
  for (const c of nodes) {
    const field = fields.get(c.key);
    if (!field) continue;
    const key = locatorKey(c.locator);
    const part = field.parts.find((p) => p.key === key && p.data === c.node.data);
    if (!part) continue;
    if (c.match.confidence === 'exact' && c.match.runId) {
      if (!runOf(map, c.match.runId)) continue;
      const runs = fieldRuns(field, exactOf);
      if (runs?.some((x) => x.runId === c.match.runId && x.start === part.start)) exact.push({ node: c, field, runs, runId: c.match.runId, part, pick: null });
    } else if (c.match.confidence === 'ambiguous' && c.match.reason && c.match.reason !== 'subdocument' && PICKED_REASONS.has(c.match.reason)) {
      const kind = pickKindFor(c.match.reason);
      const cands = c.match.candidates.filter((x) => runOf(map, x.runId));
      if (!kind || cands.length === 0) continue;
      const runId = r.pick(cands).runId;
      const runs = fieldRuns(field, exactOf, { key, runId });
      if (runs?.some((x) => x.runId === runId && x.start === part.start)) picks.push({ node: c, field, runs, runId, part, pick: { kind } });
    }
  }
  res.exactNodes = exact.length;
  res.pickableNodes = picks.length;
  const a = r.shuffle(exact);
  const b = r.shuffle(picks);
  const used = new Set<string>();
  const out: Target[] = [];
  while (out.length < n && (a.length > 0 || b.length > 0)) {
    const t = (b.length > 0 && (a.length === 0 || r.chance(pickShare)) ? b : a).shift()!;
    const ids = [t.runId, ...t.runs.map((x) => x.runId)];
    if (ids.some((id) => used.has(id))) continue;
    for (const id of ids) used.add(id);
    out.push(t);
  }
  return out;
}

function fail(tally: Tally, res: DeckResult, f: FuzzFailure): void {
  tally.failures.push(f);
  tally.result.totals.failures++;
  res.failures++;
  log(`FAILURE edit ${f.edit} on ${f.deck}: ${f.what}`);
}

/** Introduced occurrences of each SPEC input: how many more times `after` holds it than `before`. */
function introduced(before: string, after: string, s: string): number {
  const n = (t: string) => t.split(s).length - 1;
  return Math.max(0, n(after) - n(before));
}

/** One edit, start to end. Returns the written edit (for the probe), or null for anything else. */
async function oneEdit(o: {
  j: FuzzJob;
  spec: FuzzDeck;
  r: Rng;
  t: Target;
  map: DeckMap;
  walkVersion: string;
  known: string;
  copy: ProbeCopy;
  queue: WriteQueue;
  round: number;
  tally: Tally;
  res: DeckResult;
  setInside(f: (() => Promise<void>) | null): void;
}): Promise<Written | null> {
  const { j, spec, r, t, tally, res, copy, queue } = o;
  const totals = tally.result.totals;
  const i = totals.edits++;
  res.edits++;
  const run = runOf(o.map, t.runId)!;
  const rec: EditRecord = { i, deck: spec.label, round: o.round, kind: 'noop', strategy: run.strategy };
  if (t.pick) rec.pick = t.pick.kind;
  tally.edits.push(rec);
  const smart = r.chance(0.8);
  // How the author edits: inside the clicked node with the caret there (mostly), or anywhere in the field (a
  // selection across runs, a change in unmapped text, the caret elsewhere). A picked node is edited inside itself.
  const inTarget = t.pick !== null || r.chance(0.85);
  const text = t.field.text;
  let raw: string;
  let caret: string | null;
  if (inTarget) {
    raw = text.slice(0, t.part.start) + browserEdit(r, t.part.data) + text.slice(t.part.end);
    caret = t.pick || r.chance(0.9) ? t.runId : null;
  } else {
    raw = browserEdit(r, text);
    caret = t.runs.length > 0 && r.chance(0.7) ? r.pick(t.runs).runId : null;
  }
  for (const s of SPEC_INPUTS) if (introduced(text, raw, s.text) > 0) tally.result.inputs[s.name].typed++;
  const commit: CommitResult = commitField({ before: text, after: raw, runs: t.runs, caretRunId: caret }, { smartPunctuation: smart });
  const repro = (extra: Partial<FuzzFailure['repro']> = {}): FuzzFailure['repro'] => ({
    seed: j.seed,
    field: shown(spec.local, { text, runs: t.runs }),
    raw: shown(spec.local, raw),
    caret,
    smartPunctuation: smart,
    commit: shown(spec.local, commit),
    ...extra,
  });
  const failure = async (what: string, extra: Partial<FuzzFailure['repro']> = {}, bytes?: Uint8Array) => {
    rec.kind = 'failure';
    let saved: string | undefined;
    if (bytes) {
      saved = path.join(j.workDir, 'failures', `edit-${i}.html`);
      fs.mkdirSync(path.dirname(saved), { recursive: true });
      fs.writeFileSync(saved, bytes);
    }
    fail(tally, res, { edit: i, deck: spec.label, round: o.round, version: o.known, what, repro: repro({ ...extra, ...(saved ? { bytes: path.relative(j.workDir, saved) } : {}) }) });
  };

  const cwhy = checkCommit({ commit, fieldText: text, raw, runs: t.runs, inTarget, caret, targetRunId: t.runId });
  if (cwhy) {
    await failure(`[commit] ${cwhy}`);
    return null;
  }
  if (commit.kind === 'noop') {
    rec.kind = 'noop';
    rec.reason = 'commit: noop';
    res.noops++;
    totals.noops++;
    return null;
  }
  const note = (reason: string) => {
    rec.kind = 'note';
    rec.reason = reason;
    res.notes++;
    totals.notes++;
    count(tally.result.notesByCode, reason);
    const s = (tally.result.byStrategy[rec.strategy ?? 'none'] ??= { written: 0, notes: 0 });
    s.notes++;
  };
  if (commit.kind === 'verbatim') {
    // A note by rule: nothing reaches the queue, so the file is untouched.
    note(`commit: ${commit.why}`);
    return null;
  }

  // The request, as main builds it from the commit (P2-8 for a picked candidate).
  const editRun = runOf(o.map, commit.runId);
  if (!editRun) {
    await failure(`[commit] the commit names ${commit.runId}, which is not in the map`);
    return null;
  }
  rec.strategy = editRun.strategy;
  const stale = r.chance(j.staleShare);
  const version = stale ? o.walkVersion : o.known;
  let req: EditRequest;
  if (t.pick && commit.runId === t.runId) {
    totals.picks++;
    const pick: EditPick = { kind: t.pick.kind, nodeBefore: commit.beforeText, nodeAfter: commit.afterText };
    const lifted = liftPick(editRun.value, pick);
    if (!lifted) {
      // Main makes a verbatim note from the node's texts before the queue (P2-8): a note by rule.
      note(`pick: ${t.pick.kind} not liftable`);
      return null;
    }
    req = { version, runId: commit.runId, beforeText: lifted.beforeText, afterText: lifted.afterText, pick };
  } else {
    delete rec.pick;
    req = { version, runId: commit.runId, beforeText: commit.beforeText, afterText: commit.afterText };
  }
  if (version !== o.known) {
    rec.stale = true;
    totals.stale++;
  }

  // Concurrency: an external write just before the edit, or one landing inside its atomic write.
  let marker: string | null = null;
  let external: Uint8Array | null = null;
  let fired = false;
  const roll = r.next();
  if (roll < j.externalBeforeShare) {
    const cur = decodeDeck(await copy.read()).src;
    const ext = externalComment(cur, `before-${i}`);
    await fs.promises.writeFile(copy.path, encodeDeck(ext.text));
    marker = ext.marker;
    rec.external = 'before';
    totals.externalBefore++;
  } else if (roll < j.externalBeforeShare + j.externalInsideShare) {
    rec.external = 'inside';
    totals.externalInside++;
    o.setInside(async () => {
      const cur = decodeDeck(await copy.read()).src;
      const ext = externalComment(cur, `inside-${i}`);
      const b = encodeDeck(ext.text);
      // In place, as an editor that writes into the file would: the queue re-hashes the file next.
      await fs.promises.writeFile(copy.path, b);
      marker = ext.marker;
      external = b;
      fired = true;
    });
  }
  const before = await copy.read();
  let out: WriteOutcome;
  try {
    out = await queue.edit(req);
  } catch (e) {
    o.setInside(null);
    await failure(`[queue] edit() threw: ${e instanceof Error ? e.message : String(e)}`, { request: shown(spec.local, req) }, before);
    return null;
  }
  o.setInside(null);
  if (rec.external === 'inside') {
    rec.fired = fired;
    if (fired) totals.externalFired++;
  }
  const now = await copy.read();
  if (!out.ok) {
    const why = checkNote({ out, req, before, now, external: fired ? external : null });
    if (why) {
      await failure(`[note] ${why}`, { request: shown(spec.local, req), outcome: { code: out.code, why: shown(spec.local, out.why) } }, before);
      return null;
    }
    if (marker !== null && !decodeDeck(now).src.includes(marker)) {
      await failure('[note] the external change was lost', { request: shown(spec.local, req) }, before);
      return null;
    }
    if (out.code === 'noop') {
      rec.kind = 'noop';
      rec.reason = 'queue: noop';
      res.noops++;
      totals.noops++;
    } else {
      note(`queue: ${out.code}`);
      count(tally.result.notesByReason, `${out.code}: ${reasonKey(out.why)}`);
    }
    return null;
  }
  const check = checkWritten({ out, req, before, now, raced: fired, marker, sha256: sha256Hex });
  if (check.failures.length > 0) {
    await failure(`[write] ${check.failures.join('; ')}`, { request: shown(spec.local, req), outcome: { runId: out.runId, merged: out.merged, record: shown(spec.local, out.record) } }, before);
    return null;
  }
  rec.kind = 'written';
  rec.merged = out.merged;
  if (out.merged) totals.merged++;
  res.written++;
  totals.written++;
  if (t.pick && req.pick) totals.pickWritten++;
  const s = (tally.result.byStrategy[rec.strategy ?? 'none'] ??= { written: 0, notes: 0 });
  s.written++;
  for (const x of SPEC_INPUTS) if (introduced(req.beforeText, req.afterText, x.text) > 0) tally.result.inputs[x.name].written++;

  // Undo and redo through the queue: the bytes must come back exactly, both ways (9.2 Undo and redo).
  if (r.chance(j.undoShare)) {
    rec.undoRedo = true;
    totals.undoRedo++;
    const u = await queue.undo(out.record);
    const back = await copy.read();
    if (!u.ok || !bytesEqual(back, encodeDeck(check.base!))) {
      await failure(`[undo] ${u.ok ? 'the bytes are not the ones the edit replaced' : `${u.code}: ${u.why}`}`, { request: shown(spec.local, req) }, before);
      return null;
    }
    const re = await queue.redo(out.record);
    const again = await copy.read();
    if (!re.ok || !bytesEqual(again, now)) {
      await failure(`[redo] ${re.ok ? 'the bytes are not the edit\'s' : `${re.code}: ${re.why}`}`, { request: shown(spec.local, req) }, before);
      return null;
    }
  }
  return { target: t, req, out, record: rec };
}
