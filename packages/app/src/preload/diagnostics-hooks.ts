// Diagnostics hooks (section 10, Phase 0, Diagnostics window; `--bl-mode=diagnostics`). The Diagnostics deck
// runs the real key router, mode switching, card and ink; these hooks add DeckToMain.diag events the
// Diagnostics window records, and the heading that becomes contenteditable="plaintext-only" on click with
// the 9.2 beforeinput rules (Committing an edit, steps 1-2) and the 6.3 source-case reset. Nothing here
// writes the file: the heading edit is a probe of input events only.

import { DeckToMain, type DiagEvent } from '@blueline/core/ipc';
import type { KeyAction } from './key-router';
import { listen } from './listeners';

type DiagData = Record<string, string | number | boolean | null>;
export type DiagSend = (event: DiagEvent['event'], data: DiagData) => void;

/** 9.2 Committing an edit, step 2: the input types an edit field accepts; insertParagraph commits. */
export const ALLOWED_INPUT_TYPES = new Set([
  'insertText',
  'insertReplacementText',
  'insertFromPaste',
  'insertFromDrop',
  'deleteContentBackward',
  'deleteContentForward',
  'deleteWordBackward',
  'deleteWordForward',
  'deleteByCut',
]);

/** What the router needs from an edit field (6.2: Enter and Esc for the active edit). */
export interface ActiveEdit {
  readonly element: Element;
  commit(): void;
  cancel(): void;
}

/** `<seq>` of `data-bl-key-log="<seq>:<key>:<isTrusted>"` written by the deck's own capture listeners, or null. */
export function parseKeyLogSeq(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^(\d+):/.exec(v);
  return m ? Number(m[1]) : null;
}

/** The longest string a diag event may carry (main refuses more than 4 KB per value). */
function cap(s: string): string {
  return s.length > 2000 ? s.slice(0, 2000) : s;
}

/**
 * Key order and stopImmediatePropagation (6.2; section 10 Diagnostics: "the preload's capture listener runs
 * before the deck's own, and stopImmediatePropagation() from the isolated world stops the deck's listeners").
 * The reveal fixture's own capture listeners count keydown events in data-bl-key-log; read inside the router
 * (before the page's listeners could run if the router is first) and again after the event finished.
 */
export class KeyOrderProbe {
  private lastSeq: number | null;

  constructor(
    private readonly doc: Document,
    private readonly send: DiagSend,
  ) {
    this.lastSeq = parseKeyLogSeq(doc.documentElement?.dataset.blKeyLog);
  }

  onDecision(e: KeyboardEvent, action: KeyAction, consumed: boolean): void {
    if (!e.isTrusted) return;
    // No log yet counts as seq 0: the page's listeners write it on the first keydown they see.
    const seqNow = parseKeyLogSeq(this.doc.documentElement?.dataset.blKeyLog) ?? 0;
    const before = this.lastSeq ?? 0;
    const key = e.key;
    setTimeout(() => {
      const after = parseKeyLogSeq(this.doc.documentElement?.dataset.blKeyLog);
      // A page without logging listeners (after stays null) tells us nothing.
      const first = after === null ? 'unknown' : seqNow === before ? 'preload' : 'page';
      if (after !== null) this.lastSeq = after;
      this.send('key-order', { first, key, code: e.code, action: action.kind });
      if (consumed) {
        this.send('stop-propagation', { pageListenerRan: after === null ? null : after !== seqNow, key, code: e.code });
      }
    }, 0);
  }
}

/**
 * The Diagnostics heading (`[data-bl-diag="heading"]` in the reveal fixture): on a trusted click it becomes
 * contenteditable="plaintext-only" and logs every beforeinput.inputType (Wispr Flow pastes, so expect
 * insertFromPaste and a paste event), paste and input. Enter (insertParagraph) and blur commit, Esc cancels.
 */
export class DiagnosticsHeading implements ActiveEdit {
  private original = '';
  private textNode: Text | null = null;
  private saved: { transform: [string, string]; caps: [string, string] } | null = null;
  private active = false;

  constructor(
    readonly element: HTMLElement,
    private readonly win: Window,
    private readonly send: DiagSend,
    private readonly onChange: (edit: ActiveEdit | null) => void,
    private readonly badge: (text: string | null) => void = () => {},
  ) {
    element.addEventListener('beforeinput', (e) => this.onBeforeInput(e as InputEvent));
    element.addEventListener('paste', (e) => {
      if (!this.active || !e.isTrusted) return;
      const text = (e as ClipboardEvent).clipboardData?.getData('text/plain') ?? '';
      this.send('paste', { length: text.length });
    });
    element.addEventListener('input', (e) => {
      if (!this.active || !e.isTrusted) return;
      this.send('heading-input', { value: cap(element.textContent ?? '') });
    });
    element.addEventListener('blur', () => {
      if (this.active) this.commit();
    });
  }

  get isActive(): boolean {
    return this.active;
  }

  /** 9.2 Committing an edit, step 1, and 6.3 Click to place a caret. */
  begin(x: number, y: number): void {
    if (this.active) return;
    const el = this.element;
    this.original = el.textContent ?? '';
    this.textNode = Array.from(el.childNodes).find((n): n is Text => n.nodeType === 3 && (n as Text).data.trim() !== '') ?? null;
    // 6.3 Source case: reset text-transform and font-variant-caps while editing, so the file's case shows.
    const cs = this.win.getComputedStyle(el);
    if (cs.textTransform !== 'none' || cs.fontVariantCaps !== 'normal') {
      this.saved = {
        transform: [el.style.getPropertyValue('text-transform'), el.style.getPropertyPriority('text-transform')],
        caps: [el.style.getPropertyValue('font-variant-caps'), el.style.getPropertyPriority('font-variant-caps')],
      };
      el.style.setProperty('text-transform', 'none', 'important');
      el.style.setProperty('font-variant-caps', 'normal', 'important');
      this.badge('Showing source case');
    }
    el.setAttribute('contenteditable', 'plaintext-only');
    this.active = true;
    el.focus({ preventScroll: true });
    const doc = el.ownerDocument;
    const sel = this.win.getSelection();
    const pos = typeof doc.caretPositionFromPoint === 'function' ? doc.caretPositionFromPoint(x, y) : null;
    if (sel && pos && el.contains(pos.offsetNode)) sel.collapse(pos.offsetNode, pos.offset);
    this.send('heading-input', { value: cap(this.original), began: true, sourceCase: this.saved !== null });
    this.onChange(this);
  }

  commit(): void {
    if (!this.active) return;
    this.end();
    this.send('heading-input', { value: cap(this.element.textContent ?? ''), committed: true });
  }

  cancel(): void {
    if (!this.active) return;
    this.end();
    const el = this.element;
    if (this.textNode && this.textNode.parentNode === el) this.textNode.data = this.original;
    else el.textContent = this.original;
    this.send('heading-input', { value: cap(this.original), cancelled: true });
  }

  private end(): void {
    this.active = false;
    const el = this.element;
    el.removeAttribute('contenteditable');
    if (this.saved) {
      const [t, tp] = this.saved.transform;
      const [c, cp] = this.saved.caps;
      if (t) el.style.setProperty('text-transform', t, tp);
      else el.style.removeProperty('text-transform');
      if (c) el.style.setProperty('font-variant-caps', c, cp);
      else el.style.removeProperty('font-variant-caps');
      this.saved = null;
      this.badge(null);
    }
    if (this.element.ownerDocument.activeElement === el) el.blur();
    this.onChange(null);
  }

  /** 9.2 Committing an edit, step 2. */
  private onBeforeInput(e: InputEvent): void {
    if (!this.active) return;
    this.send('beforeinput', { inputType: e.inputType, data: e.data === null ? null : cap(e.data), trusted: e.isTrusted });
    if (!e.isTrusted) {
      e.preventDefault();
      return;
    }
    if (e.inputType === 'insertParagraph') {
      e.preventDefault();
      this.commit();
      return;
    }
    if (!ALLOWED_INPUT_TYPES.has(e.inputType)) {
      e.preventDefault();
      return;
    }
    // Any target range that starts or ends outside the active text node is refused.
    const node = this.textNode;
    for (const r of e.getTargetRanges()) {
      const ok = (c: Node) => c === node || c === this.element;
      if (!ok(r.startContainer) || !ok(r.endContainer)) {
        e.preventDefault();
        return;
      }
    }
    // Pasted and dropped line breaks become spaces.
    if (e.inputType === 'insertFromPaste' || e.inputType === 'insertFromDrop') {
      const text = e.dataTransfer?.getData('text/plain') ?? e.data ?? '';
      if (/[\r\n\u2028\u2029]/.test(text)) {
        e.preventDefault();
        this.element.ownerDocument.execCommand('insertText', false, text.replace(/\r\n|[\r\n\u2028\u2029]/g, ' '));
      }
    }
  }
}

/** Wires the diagnostics heading: a trusted click on it begins the edit. */
export function installDiagnosticsHeading(
  win: Window,
  send: DiagSend,
  onChange: (edit: ActiveEdit | null) => void,
  enabled: () => boolean,
  badge: (text: string | null) => void = () => {},
): { current(): DiagnosticsHeading | null } {
  let heading: DiagnosticsHeading | null = null;
  listen(
    win,
    'click',
    (e) => {
      if (!e.isTrusted || !enabled()) return;
      for (const t of e.composedPath()) {
        const el = t as HTMLElement;
        if (!el || el.nodeType !== 1) continue;
        if (el.getAttribute('data-bl-diag') !== 'heading') continue;
        if (!heading || heading.element !== el) heading = new DiagnosticsHeading(el, win, send, onChange, badge);
        heading.begin(e.clientX, e.clientY);
        return;
      }
    },
    true,
  );
  return { current: () => heading };
}

/** The diag sender: DeckToMain.diag with primitive data only (main refuses anything else). */
export function diagSender(send: (channel: typeof DeckToMain.diag, payload: DiagEvent) => void): DiagSend {
  return (event, data) => {
    const clean: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(data)) {
      if (n >= 32 || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(k)) continue;
      if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) clean[k] = v;
      // 1,300 UTF-16 units are at most 3,900 UTF-8 bytes: under main's 4 KB per value. Slice first, then
      // replace a surrogate the slice may have split (main refuses lone surrogates).
      else if (typeof v === 'string') clean[k] = v.slice(0, 1300).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
      else continue;
      n++;
    }
    send(DeckToMain.diag, { event, data: clean });
  };
}
