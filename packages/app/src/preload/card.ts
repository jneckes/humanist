// The minimal note card (6.5, Phase 0): a real <textarea> in the overlay's shadow root that grows to fit its
// text, with a header naming the target, the author's name chip, the mark list (circled 1, 2, ..., hovering an entry
// highlights its mark) and the status. Every string is shown with textContent (section 8, Display).
// The thread (Phase 4) and recordings (Phase 5) are not part of the Phase 0 card.

import { circled } from './geometry';
import { CardInputGate, type InputLike } from './input-guard';
import { listenOn } from './listeners';

export interface CardView {
  header: string;
  author: string;
  text: string;
  /** Mark numbers on the note, in order. */
  marks: number[];
  status: string;
}

export interface CardDeps {
  /** Every accepted edit (typing, dictation, paste): the controller debounces the save (300 ms, 6.5). */
  onInput(text: string): void;
  /** Hovering a mark entry: highlight mark n on the page, or none (null). */
  onHoverMark(n: number | null): void;
}

/** Card width and the gap to the mark it belongs to, in CSS px. */
const CARD_W = 320;
const GAP = 14;

export class NoteCard {
  readonly el: HTMLDivElement;
  /** The textarea now: each note, and each refused edit, gets a fresh one (see renew()). */
  private ta: HTMLTextAreaElement;
  private readonly targetEl: HTMLDivElement;
  private readonly authorEl: HTMLSpanElement;
  private readonly marksEl: HTMLDivElement;
  private readonly statusEl: HTMLSpanElement;
  private readonly hintEl: HTMLSpanElement;
  /** Accepts only edits a trusted beforeinput announced (input-guard.ts). */
  private readonly gate: CardInputGate;

  constructor(
    private readonly doc: Document,
    container: HTMLElement,
    private readonly deps: CardDeps,
  ) {
    const d = doc;
    this.el = d.createElement('div');
    this.el.className = 'card';
    this.el.hidden = true;
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', 'Note');
    const head = d.createElement('div');
    head.className = 'head';
    this.targetEl = d.createElement('div');
    this.targetEl.className = 'target';
    this.authorEl = d.createElement('span');
    this.authorEl.className = 'author';
    head.append(this.targetEl, this.authorEl);
    this.ta = this.makeTextarea();
    this.marksEl = d.createElement('div');
    this.marksEl.className = 'marks';
    const foot = d.createElement('div');
    foot.className = 'foot';
    this.statusEl = d.createElement('span');
    this.statusEl.className = 'status';
    this.hintEl = d.createElement('span');
    this.hintEl.className = 'hint';
    this.hintEl.textContent = 'Esc or Cmd+Enter to close';
    foot.append(this.statusEl, this.hintEl);
    this.el.append(head, this.ta, this.marksEl, foot);
    container.append(this.el);

    this.gate = new CardInputGate(
      () => this.ta,
      (value, caret) => this.renew(value, caret),
    );
    // The textarea has no input listener of its own: the input guard stops the card's input events at window
    // (capture), before they reach the textarea, and calls beforeInput() and input() (input-guard.ts).
    // Hovering a mark entry highlights its mark (6.5); one delegated listener, since the entries are rebuilt on
    // every update and listenOn() keeps it across document.open().
    listenOn(this.marksEl, 'mouseover', (e) => {
      if (!e.isTrusted) return;
      const item = e.target instanceof Element ? e.target.closest('.mark-item') : null;
      const n = item instanceof HTMLElement ? Number(item.dataset.n) : NaN;
      this.deps.onHoverMark(Number.isInteger(n) ? n : null);
    });
    listenOn(this.marksEl, 'mouseleave', (e) => {
      if (e.isTrusted) this.deps.onHoverMark(null);
    });
  }

  get textarea(): HTMLTextAreaElement {
    return this.ta;
  }

  private makeTextarea(): HTMLTextAreaElement {
    const ta = this.doc.createElement('textarea');
    ta.rows = 2;
    ta.spellcheck = true;
    ta.setAttribute('aria-label', 'Note text');
    ta.placeholder = 'Type or dictate a note';
    return ta;
  }

  /**
   * Puts `value` in a fresh textarea in place of the current one, keeping focus and putting the caret at
   * `caret`. Chromium keeps one undo history per frame, whose steps still apply after a script sets `value`:
   * native undo and redo in the card would replay another note's typing, or an edit the gate refused
   * (Cmd+Shift+Z after a refused execCommand brought the forged words back as a trusted historyRedo). A new
   * element leaves those steps behind.
   */
  private renew(value: string, caret: number): void {
    const old = this.ta;
    const focused = (old.getRootNode() as ShadowRoot | Document).activeElement === old;
    const next = this.makeTextarea();
    next.value = value;
    this.ta = next;
    old.replaceWith(next);
    if (focused) next.focus({ preventScroll: true });
    next.setSelectionRange(caret, caret);
  }

  /** A trusted beforeinput for the textarea (from the input guard). */
  beforeInput(e: InputLike): void {
    this.gate.beforeInput(e);
  }

  /**
   * An input for the textarea (from the input guard), after the edit happened: saved when a trusted
   * beforeinput announced it; otherwise (document.execCommand from the page) the textarea is restored to
   * the last accepted text and nothing is saved (9.1: page scripts cannot drive the card). Returns whether
   * the edit was accepted.
   */
  input(e: InputLike): boolean {
    const ok = this.gate.input(e);
    this.fit();
    if (ok) this.deps.onInput(this.textarea.value);
    return ok;
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  /**
   * Shows the card next to `anchor` (viewport rect of the mark). With `focus`, the caret goes to the end of
   * the textarea, ready for typing or Wispr Flow dictation (6.4 A new note).
   */
  open(view: CardView, anchor: { x: number; y: number; w: number; h: number }, focus: boolean): void {
    this.renew(view.text, view.text.length);
    this.gate.reset(view.text);
    this.update(view);
    this.el.hidden = false;
    this.fit();
    this.place(anchor);
    if (focus) this.focus();
  }

  focus(): void {
    this.textarea.focus({ preventScroll: true });
    const n = this.textarea.value.length;
    this.textarea.setSelectionRange(n, n);
  }

  /** Updates everything except the text, which the user owns while the card is open. */
  update(view: CardView): void {
    this.targetEl.textContent = view.header;
    this.targetEl.title = view.header;
    this.authorEl.textContent = view.author;
    this.authorEl.hidden = !view.author;
    this.statusEl.textContent = view.status;
    const items: HTMLSpanElement[] = [];
    for (const n of view.marks) {
      const s = this.doc.createElement('span');
      s.className = 'mark-item';
      s.textContent = circled(n);
      s.dataset.n = String(n);
      items.push(s);
    }
    this.marksEl.replaceChildren(...items);
  }

  setStatus(text: string): void {
    this.statusEl.textContent = text;
  }

  close(): void {
    if (this.el.hidden) return;
    if (this.el.contains(this.doc.activeElement) || (this.el.getRootNode() as ShadowRoot).activeElement === this.textarea) {
      this.textarea.blur();
    }
    this.el.hidden = true;
    this.deps.onHoverMark(null);
  }

  /** Grows the textarea to fit its text (6.5); the stylesheet caps it at half the viewport. */
  private fit(): void {
    const ta = this.textarea;
    ta.style.setProperty('height', 'auto');
    ta.style.setProperty('height', `${Math.ceil(ta.scrollHeight + 2)}px`);
  }

  /** Right of the mark if it fits, else left, else below; clamped to the viewport. */
  place(anchor: { x: number; y: number; w: number; h: number }): void {
    const vw = this.doc.defaultView?.innerWidth ?? 1600;
    const vh = this.doc.defaultView?.innerHeight ?? 900;
    const h = this.el.offsetHeight || 160;
    const w = Math.min(CARD_W, vw - 16);
    let x = anchor.x + anchor.w + GAP;
    let y = anchor.y;
    if (x + w > vw - 8) x = anchor.x - GAP - w;
    if (x < 8) {
      x = Math.min(Math.max(8, anchor.x), vw - w - 8);
      y = anchor.y + anchor.h + GAP;
      if (y + h > vh - 8) y = anchor.y - GAP - h;
    }
    x = Math.max(8, Math.min(x, vw - w - 8));
    y = Math.max(8, Math.min(y, vh - h - 8));
    this.el.style.setProperty('left', `${Math.round(x)}px`);
    this.el.style.setProperty('top', `${Math.round(y)}px`);
  }
}
