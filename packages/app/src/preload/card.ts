// The minimal note card (6.5, Phase 0): a real <textarea> in the overlay's shadow root that grows to fit its
// text, with a header naming the target, the author's name chip, the mark list (circled 1, 2, ..., hovering an entry
// highlights its mark) and the status. Every string is shown with textContent (section 8, Display).
// The thread (Phase 4) and recordings (Phase 5) are not part of the Phase 0 card.

import { circled } from './geometry';

export interface CardView {
  header: string;
  author: string;
  text: string;
  /** Mark numbers on the note, in order. */
  marks: number[];
  status: string;
}

export interface CardDeps {
  /** Every input event (typing, dictation, paste): the controller debounces the save (300 ms, 6.5). */
  onInput(text: string): void;
  /** Hovering a mark entry: highlight mark n on the page, or none (null). */
  onHoverMark(n: number | null): void;
}

/** Card width and the gap to the mark it belongs to, in CSS px. */
const CARD_W = 320;
const GAP = 14;

export class NoteCard {
  readonly el: HTMLDivElement;
  readonly textarea: HTMLTextAreaElement;
  private readonly targetEl: HTMLDivElement;
  private readonly authorEl: HTMLSpanElement;
  private readonly marksEl: HTMLDivElement;
  private readonly statusEl: HTMLSpanElement;
  private readonly hintEl: HTMLSpanElement;

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
    this.textarea = d.createElement('textarea');
    this.textarea.rows = 2;
    this.textarea.spellcheck = true;
    this.textarea.setAttribute('aria-label', 'Note text');
    this.textarea.placeholder = 'Type or dictate a note';
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
    this.el.append(head, this.textarea, this.marksEl, foot);
    container.append(this.el);

    this.textarea.addEventListener('input', (e) => {
      // A page cannot reach into the closed shadow root, but keep the rule: only trusted input drives the card.
      if (!e.isTrusted) return;
      this.fit();
      this.deps.onInput(this.textarea.value);
    });
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  /**
   * Shows the card next to `anchor` (viewport rect of the mark). With `focus`, the caret goes to the end of
   * the textarea, ready for typing or Wispr Flow dictation (6.4 A new note).
   */
  open(view: CardView, anchor: { x: number; y: number; w: number; h: number }, focus: boolean): void {
    this.textarea.value = view.text;
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
      s.addEventListener('mouseenter', (e) => {
        if (e.isTrusted) this.deps.onHoverMark(n);
      });
      s.addEventListener('mouseleave', (e) => {
        if (e.isTrusted) this.deps.onHoverMark(null);
      });
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
