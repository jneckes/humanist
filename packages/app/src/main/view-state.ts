// Reload in place (6.6 Reload when the file changes on disk; 6.1 Auto-reload; 9.2 Watcher step 3).
//
// - The view state the deck view saves before a reload and restores after it: scroll position, URL hash,
//   current slide index and the open card (core/ipc-files.ts DeckViewState). The deck preload reports it and
//   applies it (the views item wires the preload side), so main treats it as written by the page (9.1): every
//   field is rebuilt from a validated value, with bounded numbers, a hash of at most 2 KB, a note id of the
//   section 8 pattern and at most 64 KB of draft text. Anything else refuses the message.
// - ReloadCoordinator: "the deck view reloads at once only if no edit is active and no card has unsaved
//   input. Otherwise it shows 'Deck changed · reloads when you finish' and reloads when the edit commits or
//   cancels, or when the card closes." Before reloading it asks the deck for its view state; after the new
//   page has loaded it sends it back. Present and Find live in the window and the shell, not in the page, so a
//   reload leaves them as they are (the views item re-runs Find on the new version). Re-anchoring and
//   animating changed pins after the restore is Phase 3.
// - A restore takes time (the page waits for its layout; main replays an index deck's keys, about 120 ms a
//   slide). A reload that starts before the page confirmed the restore (FilesDeckToMain.viewStateApplied) and
//   before main's replay ended saves the state being restored again, never the half-restored page's (review
//   finding 20: two saves a second apart lost an index deck's slide).
// - Trust on reload (review finding 0, lead decision D-1): window.ts decides 6.10 again on every external
//   change; trustDifferences and reopenForTrust say whether the reload may happen in place.

import {
  VIEW_STATE_LIMITS,
  type CaptureViewState,
  type DeckBusy,
  type DeckViewState,
  type ViewStateReply,
} from '@blueline/core/ipc-files';
import type { TrustState } from '@blueline/core/ipc';
import type { OpenDecision } from './documents';
import { NOTE_ID, utf8Length, type Validated, type Validator } from './ipc-guard';

// ------------------------------------------------------------------------------------------- validation

class Invalid extends Error {}

function fail(why: string): never {
  throw new Invalid(why);
}

function run<T>(build: () => T): Validated<T> {
  try {
    return { ok: true, value: build() };
  } catch (e) {
    return { ok: false, why: e instanceof Invalid ? e.message : 'invalid' };
  }
}

const POISON = new Set(['__proto__', 'constructor', 'prototype']);
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A plain object's own data values (as ipc-guard's record(): no arrays, class instances, accessors or poisoned keys). */
function record(v: unknown, what: string): (key: string) => unknown {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) fail(`${what}: not an object`);
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) fail(`${what}: not a plain object`);
  for (const k of Reflect.ownKeys(v as object)) {
    if (typeof k !== 'string') fail(`${what}: symbol key`);
    if (POISON.has(k)) fail(`${what}: forbidden key ${k}`);
  }
  return (key) => {
    const d = Object.getOwnPropertyDescriptor(v, key);
    if (!d) return undefined;
    if (!('value' in d)) fail(`${what}.${key}: accessor`);
    return d.value;
  };
}

function bounded(v: unknown, max: number, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < -max || v > max) fail(`${what}: not a number within ±${max}`);
  return v;
}

function int(v: unknown, min: number, max: number, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) fail(`${what}: not an integer in ${min}..${max}`);
  return v;
}

function text(v: unknown, maxBytes: number, what: string): string {
  if (typeof v !== 'string') fail(`${what}: not a string`);
  if (v.length > maxBytes || utf8Length(v) > maxBytes) fail(`${what}: longer than ${maxBytes} bytes`);
  if (LONE_SURROGATE.test(v)) fail(`${what}: lone surrogate`);
  return v;
}

function buildViewState(p: unknown, what: string): DeckViewState {
  const r = record(p, what);
  const s = record(r('scroll'), `${what}.scroll`);
  const hash = text(r('hash'), VIEW_STATE_LIMITS.hash, `${what}.hash`);
  if (hash !== '' && !hash.startsWith('#')) fail(`${what}.hash: not a URL hash`);
  if (CONTROL.test(hash)) fail(`${what}.hash: control character`);
  const slideRaw = r('slide');
  const cardRaw = r('card');
  let card: DeckViewState['card'] = null;
  if (cardRaw !== null && cardRaw !== undefined) {
    const c = record(cardRaw, `${what}.card`);
    const noteId = c('noteId');
    if (typeof noteId !== 'string' || noteId.length > 64 || !NOTE_ID.test(noteId)) fail(`${what}.card.noteId: not a note id`);
    card = { noteId, draft: text(c('draft'), VIEW_STATE_LIMITS.draft, `${what}.card.draft`) };
  }
  return {
    scroll: { x: bounded(s('x'), VIEW_STATE_LIMITS.scroll, `${what}.scroll.x`), y: bounded(s('y'), VIEW_STATE_LIMITS.scroll, `${what}.scroll.y`) },
    hash,
    slide: slideRaw === null || slideRaw === undefined ? null : int(slideRaw, 0, VIEW_STATE_LIMITS.slides - 1, `${what}.slide`),
    card,
  };
}

/** A DeckViewState from the page (MainToDeckFiles.applyViewState carries the same shape back). */
export const validateViewState: Validator<DeckViewState> = (p) => run(() => buildViewState(p, 'viewState'));

/** FilesDeckToMain.viewState: ViewStateReply. */
export const validateViewStateReply: Validator<ViewStateReply> = (p) =>
  run(() => {
    const r = record(p, 'viewStateReply');
    return { reqId: int(r('reqId'), 0, 2 ** 31 - 1, 'viewStateReply.reqId'), state: buildViewState(r('state'), 'viewStateReply.state') };
  });

const CARD_STATES: readonly DeckBusy['card'][] = ['none', 'open', 'dirty'];

/** FilesDeckToMain.busy: DeckBusy. */
export const validateDeckBusy: Validator<DeckBusy> = (p) =>
  run(() => {
    const r = record(p, 'busy');
    const edit = r('edit');
    const card = r('card');
    if (typeof edit !== 'boolean') fail('busy.edit: not a boolean');
    if (typeof card !== 'string' || !(CARD_STATES as readonly string[]).includes(card)) fail('busy.card: not none, open or dirty');
    return { edit, card: card as DeckBusy['card'] };
  });

/** FilesDeckToMain.viewStateApplied carries nothing. */
export const validateViewStateApplied: Validator<null> = (p) => (p === undefined || p === null ? { ok: true, value: null } : { ok: false, why: 'unexpected payload' });

// ------------------------------------------------------------------------------------------- capture requests

/** How long a reload waits for the page to report its view state; a page that does not answer reloads without it. */
export const CAPTURE_TIMEOUT_MS = 1000;

/**
 * The capture round trip of one deck view: MainToDeckFiles.captureViewState out, FilesDeckToMain.viewState
 * back, matched by reqId. A reply with an unknown or stale reqId is dropped.
 */
export class ViewStateRequests {
  private next = 1;
  private readonly waiting = new Map<number, { resolve: (s: DeckViewState | null) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly send: (req: CaptureViewState) => void,
    private readonly timeoutMs = CAPTURE_TIMEOUT_MS,
  ) {}

  capture(): Promise<DeckViewState | null> {
    const reqId = this.next;
    this.next = this.next >= 2 ** 31 - 1 ? 1 : this.next + 1;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(reqId);
        resolve(null);
      }, this.timeoutMs);
      timer.unref?.();
      this.waiting.set(reqId, { resolve, timer });
      try {
        this.send({ reqId });
      } catch {
        clearTimeout(timer);
        this.waiting.delete(reqId);
        resolve(null);
      }
    });
  }

  /** A validated FilesDeckToMain.viewState. */
  onReply(r: ViewStateReply): void {
    const w = this.waiting.get(r.reqId);
    if (!w) return;
    this.waiting.delete(r.reqId);
    clearTimeout(w.timer);
    w.resolve(r.state);
  }

  dispose(): void {
    for (const w of this.waiting.values()) {
      clearTimeout(w.timer);
      w.resolve(null);
    }
    this.waiting.clear();
  }
}

// ------------------------------------------------------------------------------------------- trust on reload

/**
 * A window's trust as it stands (review finding 0, lead decision D-1): what its document opened with, and the
 * switches on in it now.
 */
export interface WindowTrust {
  trust: TrustState;
  reason: string | null;
  marker: string | null;
  markerUncertain: boolean;
  networkAllowed: boolean;
  editingAllowed: boolean;
}

/**
 * What differs between a window's trust and 6.10's decision for the file as it is on disk now (the same
 * decision an open makes: folders.ts resolveOpenTrust). [] when nothing does. The whole decision counts: the
 * state, the reason, the marker (a new download brings a new one, 6.10 Remembered), whether it could be read,
 * and in Protected view the remembered Allow network and Enable editing. Trusted view has both by definition.
 */
export function trustDifferences(
  now: WindowTrust,
  d: Pick<OpenDecision, 'trust' | 'allowNetwork' | 'editing' | 'markerUncertain'>,
  opts: { requested?: boolean } = {},
): string[] {
  const out: string[] = [];
  if (now.trust !== d.trust.trust) out.push('trust');
  if (now.reason !== d.trust.reason) out.push('reason');
  if (now.marker !== d.trust.marker) out.push('marker');
  if (now.markerUncertain !== d.markerUncertain) out.push('markerUncertain');
  // A window opened Protected on request never remembers Allow network or Enable editing (6.10; D-3), so those
  // switches are the user's within-session choice, not a trust input: an unmarked change that does not alter
  // the state, reason or marker must not reopen the window and drop them (review finding 0 re-verification).
  if (!opts.requested && now.trust === 'protected' && d.trust.trust === 'protected') {
    if (now.networkAllowed !== d.allowNetwork) out.push('allowNetwork');
    if (now.editingAllowed !== d.editing) out.push('editing');
  }
  return out;
}

/**
 * Whether an external change must reopen the document instead of reloading it in place (D-1): any difference,
 * except between two Trusted states. A Trusted file keeps its docId and its persist: partition on every open
 * (documents.ts trustedDocumentId), and Trusted view has network and editing on, so a reopen would give the
 * same window again; only the marker it records would change, and a Trusted window never remembers anything
 * against it (the trust bar is Protected only). Every other difference needs a new docId or partition, or
 * drops a switch, which a reload in place cannot do (a persist: partition cannot be downgraded in place).
 */
export function reopenForTrust(
  now: WindowTrust,
  d: Pick<OpenDecision, 'trust' | 'allowNetwork' | 'editing' | 'markerUncertain'>,
  opts: { requested?: boolean } = {},
): boolean {
  const diff = trustDifferences(now, d, opts);
  if (diff.length === 0) return false;
  return !(now.trust === 'trusted' && d.trust.trust === 'trusted');
}

// ------------------------------------------------------------------------------------------- the coordinator

export interface ReloadCoordinatorDeps {
  /** Asks the deck view for its view state (ViewStateRequests.capture); null when it does not answer. */
  capture(): Promise<DeckViewState | null>;
  /**
   * Reloads the deck view with the document at `version` (the views item swaps in the new bytes and map and
   * loads the deck URL, with `state.hash` when there is one). Resolves once the new page has completed its
   * handshake (ready → init), so it can take the state back.
   */
  reload(version: string, state: DeckViewState | null): Promise<void>;
  /** Sends the state to the reloaded page (MainToDeckFiles.applyViewState). */
  apply(state: DeckViewState): void;
  /** 6.6: show RELOAD_DEFERRED_TEXT while true (the status bar). */
  onDeferred(deferred: boolean): void;
  log?(msg: string): void;
  now?(): number;
}

/**
 * A restore the page never confirms (a hung page, a renderer that went away without a report) stops holding
 * the saved state back after this long; until then a reload reuses it (review finding 20).
 */
export const RESTORE_MAX_MS = 30_000;

/** What holds a deferred reload back: an active edit (until it commits or cancels), a card (until it closes). */
export type ReloadBlocker = 'edit' | 'card';

export type ReloadPhase = 'idle' | 'deferred' | 'reloading';

export class ReloadCoordinator {
  private busy: DeckBusy = { edit: false, card: 'none' };
  /** The newest version waiting to be shown, or null. */
  private pending: string | null = null;
  private readonly blockers = new Set<ReloadBlocker>();
  private running = false;
  private deferredShown = false;
  private disposed = false;
  /** The version the deck view shows (or is loading). */
  private shown: string;
  /** The pending request reloads even when it names the version shown (a trust change, D-1). */
  private forced = false;
  /**
   * The state sent to the reloaded page and not yet restored there (the page has not confirmed it, or main's
   * key replay of an index deck's slide is still running): a reload that starts meanwhile saves this state
   * again instead of the half-restored page's (review finding 20).
   */
  private restore: { state: DeckViewState; until: number } | null = null;
  /** Reloads done (tests and logs). */
  reloads = 0;

  constructor(
    private readonly deps: ReloadCoordinatorDeps,
    opts: { version: string },
  ) {
    this.shown = opts.version;
  }

  /**
   * The watcher saw an external change (9.2 step 3): show `version`, at once or when the user is done (6.6).
   * `force`: reload even if `version` is the one shown (the trust decision changed, D-1: the window reopens).
   */
  requestReload(version: string, o: { force?: boolean } = {}): void {
    if (this.disposed) return;
    // A newer request replaces an older one still waiting: one reload shows the latest version.
    this.pending = version;
    if (o.force) this.forced = true;
    this.evaluate();
  }

  /**
   * The view state to save before a reload (6.6): the page's own, or, while the page is still restoring the
   * last one, that one again, so a reload never saves an intermediate slide (review finding 20).
   */
  async saveState(): Promise<DeckViewState | null> {
    if (this.restore && this.now() < this.restore.until) return this.restore.state;
    this.restore = null;
    try {
      return await this.deps.capture();
    } catch (e) {
      this.deps.log?.(`view state not saved: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /** Sends `state` to the reloaded page (deps.apply); it counts as restoring until restoreDone(). */
  applyState(state: DeckViewState): void {
    if (this.disposed) return;
    this.restore = { state, until: this.now() + RESTORE_MAX_MS };
    this.deps.apply(state);
  }

  /** The page confirmed the restore, and main's own key replay (an index deck) is done. */
  restoreDone(): void {
    this.restore = null;
  }

  /** A restore is still running (tests and logs). */
  get restoring(): boolean {
    return this.restore !== null && this.now() < this.restore.until;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** The deck preload's FilesDeckToMain.busy (validated). */
  setBusy(b: DeckBusy): void {
    if (this.disposed) return;
    this.busy = { edit: b.edit, card: b.card };
    this.evaluate();
  }

  /**
   * The page went away (a crash, or a load main started for another reason): it holds no edit and no card now,
   * and restores nothing any more (the state it was restoring stays the one to save until the next capture).
   */
  resetBusy(): void {
    this.setBusy({ edit: false, card: 'none' });
  }

  get phase(): ReloadPhase {
    if (this.running) return 'reloading';
    return this.pending !== null ? 'deferred' : 'idle';
  }

  /** What a deferred reload waits for. */
  waitingFor(): ReloadBlocker[] {
    return [...this.blockers].sort();
  }

  /** The window closed: nothing reloads after this. */
  dispose(): void {
    this.disposed = true;
    this.pending = null;
    this.blockers.clear();
  }

  private setDeferred(on: boolean): void {
    if (this.deferredShown === on || this.disposed) return;
    this.deferredShown = on;
    try {
      this.deps.onDeferred(on);
    } catch (e) {
      this.deps.log?.(`reload notice: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * The deferral rules (6.6). A blocker is taken when it is there: an active edit, or a card with unsaved
   * input. The edit blocker clears when the edit ends (commit or cancel); the card blocker clears only when
   * the card closes, not when its input is sent, so a reload never closes a card the user is still in.
   */
  private evaluate(): void {
    if (this.disposed || this.running) return;
    if (this.pending === null) {
      this.blockers.clear();
      this.setDeferred(false);
      return;
    }
    if (this.pending === this.shown && !this.forced) {
      // Already showing it (a duplicate notice, or the file went back to what is shown).
      this.pending = null;
      this.blockers.clear();
      this.setDeferred(false);
      return;
    }
    if (this.busy.edit) this.blockers.add('edit');
    else this.blockers.delete('edit');
    if (this.busy.card === 'dirty') this.blockers.add('card');
    else if (this.busy.card === 'none') this.blockers.delete('card');
    if (this.blockers.size > 0) {
      this.setDeferred(true);
      return;
    }
    this.setDeferred(false);
    void this.reloadNow(this.pending);
  }

  private async reloadNow(version: string): Promise<void> {
    this.running = true;
    this.pending = null;
    this.forced = false;
    try {
      const state = await this.saveState();
      if (this.disposed) return;
      await this.deps.reload(version, state);
      this.shown = version;
      this.reloads++;
      // The new page has no edit and no card of its own yet; the restored card reports itself (busy) again.
      this.busy = { edit: false, card: 'none' };
      if (this.disposed) return;
      if (state) this.applyState(state);
    } catch (e) {
      this.deps.log?.(`reload failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.running = false;
      // A version that arrived during the reload is shown next, under the same rules.
      this.evaluate();
    }
  }
}
