// The input guard (input-guard.ts; SPEC 6.2 step 2, 6.5, 9.1 Preload; findings 9, 11, 12, 13): card input is
// handled by the overlay and stopped at window capture before any page listener, and the card accepts an
// edit only when a trusted beforeinput announced it in the same task (document.execCommand from the page
// fires a trusted input with no beforeinput). Fake windows and events; the real-Electron checks are in
// test/e2e/card-input.spec.ts and test/security/card-input.spec.ts.

import { describe, expect, it, vi } from 'vitest';
import { CardInputGate, GUARDED_EVENTS, GUARDED_KEYS, InputGuard, dropTarget, type TextFieldLike } from '../../../packages/app/src/preload/input-guard';
import { listenOn, reinstall } from '../../../packages/app/src/preload/listeners';

type Handler = (e: unknown) => void;

function fakeTarget() {
  let listeners: { type: string; fn: Handler; capture: boolean }[] = [];
  return {
    get listeners() {
      return listeners;
    },
    addEventListener(type: string, fn: Handler, opts?: boolean | AddEventListenerOptions) {
      const capture = opts === true || (typeof opts === 'object' && !!opts.capture);
      if (listeners.some((l) => l.type === type && l.fn === fn && l.capture === capture)) return; // as the DOM does
      listeners.push({ type, fn, capture });
    },
    fire(type: string, e: unknown) {
      for (const l of listeners.slice()) if (l.type === type) l.fn(e);
    },
    /** What document.open() does to every listener on the window and in the document (shadow trees included). */
    erase() {
      listeners = [];
    },
  };
}

function fakeEvent(type: string, o: { trusted?: boolean; path0?: unknown } = {}) {
  return {
    type,
    isTrusted: o.trusted ?? true,
    target: o.path0 ?? null,
    composedPath: () => (o.path0 === undefined ? [] : [o.path0]),
    stopImmediatePropagation: vi.fn(),
    stopPropagation: vi.fn(),
    preventDefault: vi.fn(),
  };
}

describe('InputGuard (D-e: card input never reaches the page)', () => {
  const host = { localName: 'blueline-overlay' };

  function setup(h: unknown = host) {
    const win = fakeTarget();
    const onOverlayEvent = vi.fn();
    new InputGuard(win as unknown as Window, { host: () => h as EventTarget | null, onOverlayEvent }).install();
    return { win, onOverlayEvent };
  }

  it('registers a capture-phase window listener for every input-family and key event', () => {
    const { win } = setup();
    const types = win.listeners.map((l) => l.type);
    for (const t of ['beforeinput', 'input', 'textInput', 'compositionstart', 'compositionupdate', 'compositionend', 'paste', 'cut', 'copy', 'select', 'selectionchange', 'keydown', 'keypress', 'keyup']) {
      expect(types, t).toContain(t);
    }
    expect(types).toEqual([...GUARDED_EVENTS, ...GUARDED_KEYS]);
    expect(win.listeners.every((l) => l.capture)).toBe(true);
  });

  it('runs the overlay handling, then stops a trusted event from the overlay, never preventing it', () => {
    const { win, onOverlayEvent } = setup();
    for (const type of ['beforeinput', 'input', 'textInput', 'paste', 'compositionupdate', 'keyup']) {
      const e = fakeEvent(type, { path0: host });
      onOverlayEvent.mockImplementationOnce(() => expect(e.stopImmediatePropagation).not.toHaveBeenCalled());
      win.fire(type, e);
      expect(onOverlayEvent, type).toHaveBeenCalledWith(e);
      expect(e.stopImmediatePropagation, type).toHaveBeenCalledTimes(1);
      expect(e.preventDefault, type).not.toHaveBeenCalled(); // the insertion (typing, paste, Wispr) still happens
    }
  });

  it('notes where a trusted drop landed, for the rest of its task, without touching the drop (E-10)', () => {
    vi.useFakeTimers();
    try {
      const { win, onOverlayEvent } = setup();
      const pageEl = { localName: 'div' };
      win.fire('drop', fakeEvent('drop', { path0: pageEl, trusted: false }));
      expect(dropTarget(win)).toBeUndefined();
      const e = fakeEvent('drop', { path0: pageEl });
      win.fire('drop', e);
      expect(dropTarget(win)).toBe(pageEl);
      // A drop on the page stays the page's: neither stopped nor prevented.
      expect(e.stopImmediatePropagation).not.toHaveBeenCalled();
      expect(e.preventDefault).not.toHaveBeenCalled();
      // The deleteByDrag of a move comes in the same task; a later one finds no drop.
      vi.runAllTimers();
      expect(dropTarget(win)).toBeUndefined();
      // A drop on the overlay is noted as its host (outside any deck field), and handled as before.
      win.fire('drop', fakeEvent('drop', { path0: host }));
      expect(dropTarget(win)).toBe(host);
      expect(onOverlayEvent).toHaveBeenCalledTimes(1);
      // Another window's drop is its own.
      expect(dropTarget(fakeTarget())).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the event even when the overlay handling throws', () => {
    const { win, onOverlayEvent } = setup();
    onOverlayEvent.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const e = fakeEvent('input', { path0: host });
    expect(() => win.fire('input', e)).toThrow('boom');
    expect(e.stopImmediatePropagation).toHaveBeenCalled();
  });

  it('leaves page events, untrusted events and events before the overlay exists alone', () => {
    const { win, onOverlayEvent } = setup();
    const page = fakeEvent('input', { path0: { localName: 'input' } });
    win.fire('input', page);
    const synthetic = fakeEvent('input', { path0: host, trusted: false });
    win.fire('input', synthetic);
    expect(page.stopImmediatePropagation).not.toHaveBeenCalled();
    expect(synthetic.stopImmediatePropagation).not.toHaveBeenCalled();
    expect(onOverlayEvent).not.toHaveBeenCalled();

    const early = setup(null);
    const e = fakeEvent('paste', { path0: host });
    early.win.fire('paste', e);
    expect(e.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it('reinstall() re-adds the guard and every overlay node listener after document.open() erased them (finding 12)', () => {
    const { win, onOverlayEvent } = setup();
    const textarea = fakeTarget();
    const nodeFn = vi.fn();
    listenOn(textarea as unknown as EventTarget, 'pointerdown', nodeFn);
    const before = win.listeners.length;
    win.erase();
    textarea.erase();
    win.fire('input', fakeEvent('input', { path0: host }));
    textarea.fire('pointerdown', {});
    expect(onOverlayEvent).not.toHaveBeenCalled();
    expect(nodeFn).not.toHaveBeenCalled();

    reinstall(win as unknown as Window);
    expect(win.listeners.length).toBe(before);
    const e = fakeEvent('input', { path0: host });
    win.fire('input', e);
    textarea.fire('pointerdown', {});
    expect(onOverlayEvent).toHaveBeenCalledWith(e);
    expect(e.stopImmediatePropagation).toHaveBeenCalled();
    expect(nodeFn).toHaveBeenCalledTimes(1);
    // Re-adding when nothing was erased adds nothing twice.
    reinstall(win as unknown as Window);
    expect(win.listeners.length).toBe(before);
    textarea.fire('pointerdown', {});
    expect(nodeFn).toHaveBeenCalledTimes(2);
  });
});

// ------------------------------------------------------------------------------------------- the card gate

class Field implements TextFieldLike {
  selectionStart: number | null = 0;
  selectionEnd: number | null = 0;
  constructor(public value = '') {
    this.caret(value.length);
  }
  setSelectionRange(a: number, b: number): void {
    this.selectionStart = a;
    this.selectionEnd = b;
  }
  caret(c: number): this {
    this.setSelectionRange(c, c);
    return this;
  }
  select(a: number, b: number): this {
    this.setSelectionRange(a, b);
    return this;
  }
  /** The default action of an edit: the value and the caret after it. */
  edit(value: string, caret: number): void {
    this.value = value;
    this.caret(caret);
  }
}

function gate(initial = '') {
  const field = new Field(initial);
  const timers: (() => void)[] = [];
  const restores: string[] = [];
  const g = new CardInputGate(
    () => field,
    (value, caret) => {
      restores.push(value);
      field.value = value;
      field.caret(caret);
    },
    (fn) => timers.push(fn),
  );
  g.reset(initial);
  const ev = (inputType: string, data: string | null = null, trusted = true) => ({ isTrusted: trusted, inputType, data });
  /** A real user edit: beforeinput, the default action, input; then the task ends. */
  const user = (inputType: string, data: string | null, value: string, caret: number) => {
    g.beforeInput(ev(inputType, data));
    field.edit(value, caret);
    const ok = g.input(ev(inputType, data));
    for (const t of timers.splice(0)) t();
    return ok;
  };
  /** document.execCommand from the page: the edit and a trusted input, no beforeinput. */
  const forged = (inputType: string, data: string | null, value: string, caret: number) => {
    field.edit(value, caret);
    return g.input(ev(inputType, data));
  };
  return { field, g, timers, ev, user, forged, restores };
}

describe('CardInputGate (finding 11: a deck cannot write into the card)', () => {
  it('accepts typing, IME composition, paste (Wispr Flow), undo and redo, each announced by a trusted beforeinput', () => {
    const { g, user } = gate();
    expect(user('insertText', 'a', 'a', 1)).toBe(true);
    expect(user('insertCompositionText', 'ni', 'ani', 3)).toBe(true);
    expect(user('insertCompositionText', '你好', 'a你好', 3)).toBe(true);
    expect(user('insertFromPaste', ' pasted', 'a你好 pasted', 10)).toBe(true);
    expect(user('insertReplacementText', 'fixed', 'a你好 fixed', 9)).toBe(true);
    expect(user('historyUndo', null, 'a你好 pasted', 10)).toBe(true);
    expect(user('historyRedo', null, 'a你好 fixed', 9)).toBe(true);
    expect(user('insertFromDrop', 'x', 'a你好 fixedx', 10)).toBe(true);
    expect(g.value).toBe('a你好 fixedx');
  });

  it('accepts deletions next to a collapsed caret, repeated characters included', () => {
    const { g, field, user } = gate('aab');
    field.caret(1);
    expect(user('deleteContentBackward', null, 'ab', 0)).toBe(true);
    field.caret(0);
    expect(user('deleteContentForward', null, 'b', 0)).toBe(true);
    expect(user('insertText', 'cc', 'ccb', 2)).toBe(true);
    field.caret(2);
    expect(user('deleteWordBackward', null, 'b', 0)).toBe(true);
    field.select(0, 1);
    expect(user('deleteByCut', null, '', 0)).toBe(true);
    expect(g.value).toBe('');
  });

  it('refuses execCommand insertText (no beforeinput) and puts the text and caret back', () => {
    const { g, field, user, forged } = gate();
    user('insertText', 'make the chart blue', 'make the chart blue', 19);
    field.caret(5);
    expect(forged('insertText', 'EVIL ', 'make EVIL the chart blue', 10)).toBe(false);
    expect(field.value).toBe('make the chart blue');
    expect([field.selectionStart, field.selectionEnd]).toEqual([5, 5]); // where the user's caret was
    expect(g.value).toBe('make the chart blue');
  });

  it('refuses execCommand selectAll + delete + insertText, leaving a collapsed caret at the end', () => {
    const { field, user, forged } = gate();
    user('insertText', 'tighten this headline', 'tighten this headline', 21);
    field.select(0, 21); // execCommand('selectAll') fires no input
    expect(forged('deleteContentBackward', null, '', 0)).toBe(false);
    expect(field.value).toBe('tighten this headline');
    expect(field.selectionStart).toBe(field.selectionEnd);
    expect(forged('insertText', 'Replace the pricing table', 'tighten this headlineReplace the pricing table', 46)).toBe(false);
    expect(field.value).toBe('tighten this headline');
    expect([field.selectionStart, field.selectionEnd]).toEqual([21, 21]);
    // The user's next key goes on as usual.
    expect(user('insertText', '!', 'tighten this headline!', 22)).toBe(true);
  });

  it('refuses an untrusted beforeinput as an arm, and an input whose type differs from the arm', () => {
    const { g, field, ev, forged } = gate('abc');
    g.beforeInput(ev('insertText', 'x', false));
    expect(forged('insertText', 'x', 'abcx', 4)).toBe(false);
    g.beforeInput(ev('insertText', 'x'));
    expect(forged('historyUndo', null, '', 0)).toBe(false);
    expect(field.value).toBe('abc');
  });

  it('a beforeinput with no input (Backspace at the start, Delete at the end) cannot carry a later forgery', () => {
    const { g, field, ev, forged } = gate('keep my words');
    // Backspace at the start: Chromium fires beforeinput and no input. The arm lives until the task ends.
    field.caret(0);
    g.beforeInput(ev('deleteContentBackward'));
    field.select(0, 13);
    expect(forged('deleteContentBackward', null, '', 0)).toBe(false);
    // Delete at the end, then a forged select-all forward delete.
    field.caret(13);
    g.beforeInput(ev('deleteContentForward'));
    field.select(0, 13);
    expect(forged('deleteContentForward', null, '', 0)).toBe(false);
    // An insert-type arm carries its data: other text is refused.
    g.beforeInput(ev('insertText', 'a'));
    expect(forged('insertText', 'EVIL', 'keep my wordsEVIL', 17)).toBe(false);
    // Cutting a collapsed selection removes nothing.
    field.caret(4);
    g.beforeInput(ev('deleteByCut'));
    field.select(0, 13);
    expect(forged('deleteByCut', null, '', 0)).toBe(false);
    expect(field.value).toBe('keep my words');
  });

  it('the arm ends with the task: a forgery after the timer is refused', () => {
    const { g, field, timers, ev, forged } = gate('abc');
    g.beforeInput(ev('insertText', 'x'));
    for (const t of timers.splice(0)) t();
    expect(forged('insertText', 'x', 'abcx', 4)).toBe(false);
    expect(field.value).toBe('abc');
  });

  it('restores through the card (a fresh textarea) once per refused change, and not for a refused no-op', () => {
    const { g, ev, user, forged, restores } = gate();
    user('insertText', 'abc', 'abc', 3);
    expect(forged('insertText', 'X', 'abcX', 4)).toBe(false);
    expect(restores).toEqual(['abc']);
    g.beforeInput(ev('insertText', '', false));
    expect(forged('insertText', '', 'abc', 3)).toBe(false);
    expect(restores).toEqual(['abc']);
  });

  it('a reopened card (J) starts from the note text', () => {
    const { g, field, forged } = gate();
    g.reset('tighten this headline');
    field.edit('tighten this headline', 21);
    expect(forged('insertText', ' Also remove the risk disclaimer.', 'tighten this headline Also remove the risk disclaimer.', 54)).toBe(false);
    expect(field.value).toBe('tighten this headline');
  });
});

describe('InputGuard: the Edit field (P2-7: its input never reaches the page)', () => {
  const host = { localName: 'blueline-overlay' };
  function node(parent: unknown = null) {
    return { nodeType: 1, parent, contains(this: unknown, n: { parent?: unknown } | null) {
      for (let c: unknown = n; c; c = (c as { parent?: unknown }).parent) if (c === this) return true;
      return false;
    } };
  }

  function setup(field: unknown, foreign = false) {
    const win = fakeTarget();
    const onOverlayEvent = vi.fn();
    const onFieldEvent = vi.fn();
    new InputGuard(win as unknown as Window, {
      host: () => host as unknown as EventTarget,
      onOverlayEvent,
      field: () => field as Element | null,
      onFieldEvent,
      foreignHistory: () => foreign,
    }).install();
    return { win, onOverlayEvent, onFieldEvent };
  }

  it('runs the field handling, then stops a trusted event from inside the field, never preventing it', () => {
    const field = node();
    const text = { nodeType: 3, parent: field };
    const { win, onFieldEvent, onOverlayEvent } = setup(field);
    for (const [type, target] of [['beforeinput', field], ['input', field], ['paste', text], ['compositionupdate', field], ['drop', text]] as const) {
      const e = fakeEvent(type, { path0: target });
      onFieldEvent.mockImplementationOnce(() => expect(e.stopImmediatePropagation).not.toHaveBeenCalled());
      win.fire(type, e);
      expect(onFieldEvent, type).toHaveBeenCalledWith(e);
      expect(e.stopImmediatePropagation, type).toHaveBeenCalledTimes(1);
      expect(e.preventDefault, type).not.toHaveBeenCalled();
    }
    expect(onOverlayEvent).not.toHaveBeenCalled();
  });

  it('leaves the rest of the page, untrusted events, and every event while no field is open alone', () => {
    const field = node();
    const other = node();
    const { win, onFieldEvent } = setup(field);
    const page = fakeEvent('input', { path0: other });
    win.fire('input', page);
    const synthetic = fakeEvent('beforeinput', { path0: field, trusted: false });
    win.fire('beforeinput', synthetic);
    expect(onFieldEvent).not.toHaveBeenCalled();
    expect(page.stopImmediatePropagation).not.toHaveBeenCalled();
    expect(synthetic.stopImmediatePropagation).not.toHaveBeenCalled();
    const closed = setup(null);
    const e = fakeEvent('input', { path0: field });
    closed.win.fire('input', e);
    expect(closed.onFieldEvent).not.toHaveBeenCalled();
    expect(e.stopImmediatePropagation).not.toHaveBeenCalled();
  });

  it('cancels and stops a native undo aimed at an earlier field (P2-9)', () => {
    const { win, onFieldEvent } = setup(node(), true);
    const e = Object.assign(fakeEvent('beforeinput', { path0: node() }), { inputType: 'historyUndo' });
    win.fire('beforeinput', e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.stopImmediatePropagation).toHaveBeenCalled();
    expect(onFieldEvent).not.toHaveBeenCalled();
  });
});
