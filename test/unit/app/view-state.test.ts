// 6.6 Reload: the view state the deck reports (validated as written by the page, 9.1) and the reload
// coordinator's deferral rules ("reloads at once only if no edit is active and no card has unsaved input;
// otherwise … reloads when the edit commits or cancels, or when the card closes").
import { describe, expect, it } from 'vitest';
import { RELOAD_DEFERRED_TEXT, VIEW_STATE_LIMITS, type DeckBusy, type DeckViewState } from '../../../packages/core/src/ipc-files';
import {
  ReloadCoordinator,
  ViewStateRequests,
  validateDeckBusy,
  validateViewState,
  validateViewStateReply,
  type ReloadCoordinatorDeps,
} from '../../../packages/app/src/main/view-state';

const good: DeckViewState = { scroll: { x: 0, y: 1234.5 }, hash: '#/3', slide: 3, card: { noteId: 'n-0007', draft: 'start the axis at zero' } };

describe('validateViewState (the page wrote it, 9.1)', () => {
  it('accepts a state and rebuilds it field by field', () => {
    const extra = { ...good, extra: 'dropped', scroll: { ...good.scroll, z: 1 } };
    const v = validateViewState(extra);
    expect(v).toEqual({ ok: true, value: good });
    if (v.ok) {
      expect(v.value).not.toBe(extra);
      expect(Object.keys(v.value.scroll)).toEqual(['x', 'y']);
    }
  });

  it('accepts no slide, no card, an empty hash, a negative x (right-to-left pages), and an author-prefixed note id', () => {
    expect(validateViewState({ scroll: { x: -300, y: 0 }, hash: '', slide: null, card: null }).ok).toBe(true);
    expect(validateViewState({ scroll: { x: 0, y: 0 }, hash: '', card: { noteId: 'anna-x2k9:n-0012', draft: '' } }).ok).toBe(true);
  });

  it('bounds the numbers', () => {
    for (const y of [Number.NaN, Infinity, -Infinity, VIEW_STATE_LIMITS.scroll + 1, '10', null]) {
      expect(validateViewState({ ...good, scroll: { x: 0, y } }).ok).toBe(false);
    }
    for (const slide of [-1, 1.5, VIEW_STATE_LIMITS.slides, '3']) expect(validateViewState({ ...good, slide }).ok).toBe(false);
    expect(validateViewState({ ...good, slide: VIEW_STATE_LIMITS.slides - 1 }).ok).toBe(true);
  });

  it('a hash is "" or "#…", at most 2 KB, without control characters or lone surrogates', () => {
    expect(validateViewState({ ...good, hash: '#' + 'a'.repeat(VIEW_STATE_LIMITS.hash - 1) }).ok).toBe(true);
    expect(validateViewState({ ...good, hash: '#' + 'a'.repeat(VIEW_STATE_LIMITS.hash) }).ok).toBe(false);
    // 2 KB of UTF-8, not of UTF-16 units.
    expect(validateViewState({ ...good, hash: '#' + 'é'.repeat(1024) }).ok).toBe(false);
    for (const hash of ['/3', 'javascript:alert(1)', '#a\nb', '#\u0000', '#\uD800']) expect(validateViewState({ ...good, hash }).ok).toBe(false);
  });

  it('the card: a note id of the section 8 pattern and at most 64 KB of draft text', () => {
    for (const noteId of ['n-12', 'N-0001', 'note', '../n-0001', 'a:b:n-0001', 'n-0001\n', 7]) {
      expect(validateViewState({ ...good, card: { noteId, draft: '' } }).ok).toBe(false);
    }
    expect(validateViewState({ ...good, card: { noteId: 'n-0001', draft: 'x'.repeat(VIEW_STATE_LIMITS.draft) } }).ok).toBe(true);
    expect(validateViewState({ ...good, card: { noteId: 'n-0001', draft: 'x'.repeat(VIEW_STATE_LIMITS.draft + 1) } }).ok).toBe(false);
    expect(validateViewState({ ...good, card: { noteId: 'n-0001', draft: '\uDC00' } }).ok).toBe(false);
    expect(validateViewState({ ...good, card: { noteId: 'n-0001' } }).ok).toBe(false);
  });

  it('refuses non-plain objects, poisoned keys and accessors', () => {
    expect(validateViewState(null).ok).toBe(false);
    expect(validateViewState([good]).ok).toBe(false);
    expect(validateViewState(JSON.parse('{"__proto__":{"x":1},"scroll":{"x":0,"y":0},"hash":""}')).ok).toBe(false);
    const accessor = { scroll: { x: 0, y: 0 }, slide: null, card: null } as Record<string, unknown>;
    Object.defineProperty(accessor, 'hash', { get: () => '#x', enumerable: true });
    expect(validateViewState(accessor).ok).toBe(false);
    class S {
      scroll = { x: 0, y: 0 };
      hash = '';
    }
    expect(validateViewState(new S()).ok).toBe(false);
    expect(validateViewState({ ...good, scroll: new Map() }).ok).toBe(false);
  });

  it('the reply carries a reqId and a state; busy carries edit and the card', () => {
    expect(validateViewStateReply({ reqId: 4, state: good })).toEqual({ ok: true, value: { reqId: 4, state: good } });
    expect(validateViewStateReply({ reqId: -1, state: good }).ok).toBe(false);
    expect(validateViewStateReply({ reqId: 1.5, state: good }).ok).toBe(false);
    expect(validateViewStateReply({ reqId: 1, state: { ...good, hash: 'x' } }).ok).toBe(false);
    expect(validateDeckBusy({ edit: true, card: 'dirty' })).toEqual({ ok: true, value: { edit: true, card: 'dirty' } });
    for (const b of [{ edit: 1, card: 'none' }, { edit: false, card: 'closed' }, { edit: false }, 'busy', null]) expect(validateDeckBusy(b).ok).toBe(false);
  });
});

describe('ViewStateRequests (capture round trip)', () => {
  it('matches replies by reqId, drops unknown ones, and times out to null', async () => {
    const sent: number[] = [];
    const r = new ViewStateRequests((q) => sent.push(q.reqId), 50);
    const p = r.capture();
    r.onReply({ reqId: sent[0] + 100, state: good });
    r.onReply({ reqId: sent[0], state: good });
    expect(await p).toEqual(good);
    const late = r.capture();
    expect(await late).toBeNull();
    r.onReply({ reqId: sent[1], state: good }); // after the timeout: dropped
    const disposed = r.capture();
    r.dispose();
    expect(await disposed).toBeNull();
  });
});

/** A coordinator over recording deps; `reload` resolves when the test says so. */
function harness(o: { capture?: DeckViewState | null; reloadFails?: boolean } = {}) {
  const calls: string[] = [];
  const deferred: boolean[] = [];
  const applied: DeckViewState[] = [];
  let finishReload: (() => void) | null = null;
  const deps: ReloadCoordinatorDeps = {
    capture: async () => {
      calls.push('capture');
      return o.capture === undefined ? good : o.capture;
    },
    reload: (version, state) => {
      calls.push(`reload ${version}${state ? ` ${state.hash}` : ''}`);
      return new Promise<void>((resolve, reject) => {
        finishReload = () => (o.reloadFails ? reject(new Error('gone')) : resolve());
      });
    },
    apply: (s) => {
      calls.push('apply');
      applied.push(s);
    },
    onDeferred: (d) => deferred.push(d),
    log: (m) => calls.push(`log ${m}`),
  };
  const c = new ReloadCoordinator(deps, { version: 'v1' });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const finish = async () => {
    await settle();
    finishReload?.();
    finishReload = null;
    await settle();
  };
  return { c, calls, deferred, applied, finish, settle };
}

const BUSY = (edit: boolean, card: DeckBusy['card']): DeckBusy => ({ edit, card });

describe('ReloadCoordinator: the deferral table (6.6)', () => {
  it('no edit, no card: reloads at once, saving the view state before and restoring it after', async () => {
    const h = harness();
    h.c.requestReload('v2');
    expect(h.c.phase).toBe('reloading');
    await h.finish();
    expect(h.calls).toEqual(['capture', 'reload v2 #/3', 'apply']);
    expect(h.applied).toEqual([good]);
    expect(h.deferred).toEqual([]);
    expect(h.c.phase).toBe('idle');
  });

  it('a card open with nothing unsaved does not hold the reload; the card is restored', async () => {
    const h = harness();
    h.c.setBusy(BUSY(false, 'open'));
    h.c.requestReload('v2');
    await h.finish();
    expect(h.calls).toEqual(['capture', 'reload v2 #/3', 'apply']);
    expect(h.applied[0].card).toEqual(good.card);
  });

  it('an active edit: "Deck changed · reloads when you finish", then the reload when the edit commits or cancels', async () => {
    const h = harness();
    h.c.setBusy(BUSY(true, 'none'));
    h.c.requestReload('v2');
    expect(h.c.phase).toBe('deferred');
    expect(h.c.waitingFor()).toEqual(['edit']);
    expect(h.deferred).toEqual([true]);
    expect(RELOAD_DEFERRED_TEXT).toBe('Deck changed · reloads when you finish');
    await h.settle();
    expect(h.calls).toEqual([]);
    h.c.setBusy(BUSY(false, 'none'));
    await h.finish();
    expect(h.calls).toEqual(['capture', 'reload v2 #/3', 'apply']);
    expect(h.deferred).toEqual([true, false]);
  });

  it('a card with unsaved input: waits until the card closes, not just until its input is sent', async () => {
    const h = harness();
    h.c.setBusy(BUSY(false, 'dirty'));
    h.c.requestReload('v2');
    expect(h.c.waitingFor()).toEqual(['card']);
    h.c.setBusy(BUSY(false, 'open'));
    await h.settle();
    expect(h.c.phase).toBe('deferred');
    expect(h.calls).toEqual([]);
    h.c.setBusy(BUSY(false, 'none'));
    await h.finish();
    expect(h.calls).toEqual(['capture', 'reload v2 #/3', 'apply']);
  });

  it('both an edit and a dirty card: both must end', async () => {
    const h = harness();
    h.c.setBusy(BUSY(true, 'dirty'));
    h.c.requestReload('v2');
    expect(h.c.waitingFor()).toEqual(['card', 'edit']);
    h.c.setBusy(BUSY(false, 'dirty'));
    expect(h.c.waitingFor()).toEqual(['card']);
    h.c.setBusy(BUSY(false, 'none'));
    await h.finish();
    expect(h.calls[1]).toBe('reload v2 #/3');
  });

  it('a blocker that starts while waiting holds the reload too', async () => {
    const h = harness();
    h.c.setBusy(BUSY(true, 'none'));
    h.c.requestReload('v2');
    h.c.setBusy(BUSY(true, 'dirty'));
    h.c.setBusy(BUSY(false, 'open'));
    await h.settle();
    expect(h.c.waitingFor()).toEqual(['card']);
    expect(h.calls).toEqual([]);
    h.c.setBusy(BUSY(false, 'none'));
    await h.finish();
    expect(h.calls[1]).toBe('reload v2 #/3');
  });

  it('several changes while waiting: one reload, of the latest version', async () => {
    const h = harness();
    h.c.setBusy(BUSY(true, 'none'));
    for (const v of ['v2', 'v3', 'v4']) h.c.requestReload(v);
    h.c.setBusy(BUSY(false, 'none'));
    await h.finish();
    expect(h.calls.filter((c) => c.startsWith('reload'))).toEqual(['reload v4 #/3']);
    expect(h.c.reloads).toBe(1);
  });

  it('a change during a reload is shown next, after the first reload', async () => {
    const h = harness();
    h.c.requestReload('v2');
    h.c.requestReload('v3');
    await h.finish();
    await h.finish();
    expect(h.calls.filter((c) => c.startsWith('reload'))).toEqual(['reload v2 #/3', 'reload v3 #/3']);
  });

  it('the version already shown is not reloaded again', async () => {
    const h = harness();
    h.c.requestReload('v1');
    await h.settle();
    expect(h.calls).toEqual([]);
    expect(h.c.phase).toBe('idle');
  });

  it('a page that does not report its state reloads anyway, without restoring', async () => {
    const h = harness({ capture: null });
    h.c.requestReload('v2');
    await h.finish();
    expect(h.calls).toEqual(['capture', 'reload v2']);
  });

  it('a failed reload is logged; the next change reloads normally', async () => {
    const h = harness({ reloadFails: true });
    h.c.requestReload('v2');
    await h.finish();
    expect(h.calls).toContain('log reload failed: gone');
    expect(h.c.phase).toBe('idle');
  });

  it('after a reload the old page’s busy state no longer holds anything', async () => {
    const h = harness();
    h.c.setBusy(BUSY(false, 'open'));
    h.c.requestReload('v2');
    await h.finish();
    h.c.requestReload('v3');
    expect(h.c.phase).toBe('reloading');
  });

  it('a closed window never reloads', async () => {
    const h = harness();
    h.c.setBusy(BUSY(true, 'none'));
    h.c.requestReload('v2');
    h.c.dispose();
    h.c.setBusy(BUSY(false, 'none'));
    h.c.requestReload('v3');
    await h.settle();
    expect(h.calls).toEqual([]);
  });

  it('resetBusy (the page went away) releases a deferred reload', async () => {
    const h = harness();
    h.c.setBusy(BUSY(true, 'dirty'));
    h.c.requestReload('v2');
    h.c.resetBusy();
    await h.finish();
    expect(h.calls[1]).toBe('reload v2 #/3');
  });
});
