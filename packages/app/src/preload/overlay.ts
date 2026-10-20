// The overlay host (9.1 Preload, 9.6 Overlay): a closed Shadow DOM on an element appended to
// document.documentElement, styled with CSSOM property writes (the host) and one constructable stylesheet
// (inside). It loads nothing by URL, runs no inline code, never uses innerHTML, <style> or style attributes,
// so it works under the page's CSP (which applies to the isolated world) and under Trusted Types.

import { listenOn } from './listeners';
import { OVERLAY_CSS } from './styles';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** CSSOM writes on the host (9.6 Overlay); `important` so page stylesheets cannot move or hide it. */
const HOST_STYLE: readonly [string, string][] = [
  ['display', 'block'],
  ['position', 'fixed'],
  ['inset', '0'],
  ['z-index', '2147483647'],
  ['pointer-events', 'none'],
  ['margin', '0'],
  ['padding', '0'],
  ['border', '0'],
  ['width', 'auto'],
  ['height', 'auto'],
  ['min-width', '0'],
  ['min-height', '0'],
  ['max-width', 'none'],
  ['max-height', 'none'],
  ['opacity', '1'],
  ['visibility', 'visible'],
  ['transform', 'none'],
  ['filter', 'none'],
  ['clip-path', 'none'],
  ['overflow', 'visible'],
  ['background', 'none'],
  // Properties a page stylesheet could otherwise use to hide or shrink the host.
  ['translate', 'none'],
  ['scale', 'none'],
  ['rotate', 'none'],
  ['clip', 'auto'],
  ['mask', 'none'],
  ['content-visibility', 'visible'],
  ['contain', 'none'],
  ['mix-blend-mode', 'normal'],
];

export interface OverlayParts {
  root: HTMLDivElement;
  ink: SVGSVGElement;
  capture: HTMLDivElement;
  cards: HTMLDivElement;
  hud: HTMLDivElement;
  toast: HTMLDivElement;
  help: HTMLDivElement;
  badge: HTMLDivElement;
  /** Added in Phase 2: Edit's hover outline (6.3: solid exact, dashed ambiguous). */
  outline: HTMLDivElement;
  /** Added in Phase 2: the fit guard's badge, next to the edited element (6.3 Fit guard). */
  fit: HTMLDivElement;
  /** Added in Phase 2: where Edit's picker panel and its SVG text input live (edit-controller.ts). */
  edit: HTMLDivElement;
}

/** A toast's button (6.3 Saving: "Saved · deck.html:142" with Undo). */
export interface ToastAction {
  label: string;
  run(): void;
}

export interface ToastOptions {
  ms?: number;
  action?: ToastAction;
}

/** A box in the view's CSS pixels. */
export interface ViewRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How long a toast with a button stays: long enough to reach the button (6.3 Saving). */
const ACTION_TOAST_MS = 8000;

export class Overlay {
  readonly host: HTMLElement;
  private readonly shadow: ShadowRoot;
  readonly parts: OverlayParts;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  /** The shown toast's button action, run by toastAction() (the controller hit-tests clicks at window capture). */
  private toastRun: (() => void) | null = null;
  /** The mode the help overlay was built for. */
  private helpMode: string | null = null;
  private observers: MutationObserver[] = [];
  private onRootReplaced: (() => void)[] = [];
  /** The host's style attribute as this overlay last wrote it, so the observer never answers its own write. */
  private lastStyle: string | null = null;

  constructor(private readonly doc: Document) {
    // A custom-element-like name: attachShadow accepts it, and no page element is likely to share it.
    this.host = doc.createElement('blueline-overlay');
    this.applyHostStyle();
    this.shadow = this.host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(OVERLAY_CSS);
    this.shadow.adoptedStyleSheets = [sheet];
    this.parts = this.build();
    // Overlay clicks, pointer and wheel events must not bubble out to the deck's own listeners (a deck that
    // advances on click would move while the user draws or types). Capture-phase page listeners on window
    // and document still see pointer events, retargeted to the host (where the user draws, not what they
    // write). The input-event family (beforeinput, input, textInput, composition, clipboard) and keys are
    // stopped before any page listener by the input guard and the key router, at window capture
    // (input-guard.ts); stopping them here too keeps the overlay's events out of bubble listeners if a page
    // ever gets its capture listeners ahead of the guard. Through listenOn(), so document.open() does not
    // erase them for good.
    for (const type of ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'wheel', 'touchstart', 'touchmove', 'touchend', 'input', 'beforeinput', 'textInput', 'compositionstart', 'compositionupdate', 'compositionend', 'paste', 'cut', 'copy', 'focusin', 'focusout']) {
      listenOn(this.shadow, type, (e) => e.stopPropagation(), { passive: type === 'wheel' || type.startsWith('touch') });
    }
  }

  /** The closed shadow root, for focus queries (activeElement) and hit tests. Never handed to page code. */
  get shadowRoot(): ShadowRoot {
    return this.shadow;
  }

  private applyHostStyle(): void {
    const s = this.host.style;
    for (const [k, v] of HOST_STYLE) s.setProperty(k, v, 'important');
    this.lastStyle = this.host.getAttribute('style');
  }

  private build(): OverlayParts {
    const d = this.doc;
    const root = d.createElement('div');
    root.className = 'root';
    const ink = d.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
    ink.setAttribute('class', 'ink hidden');
    const capture = d.createElement('div');
    capture.className = 'capture';
    const cards = d.createElement('div');
    cards.className = 'cards chrome';
    const hud = d.createElement('div');
    hud.className = 'hud chrome';
    hud.hidden = true;
    const toast = d.createElement('div');
    toast.className = 'toast chrome';
    toast.hidden = true;
    toast.setAttribute('role', 'status');
    const help = d.createElement('div');
    help.className = 'help chrome';
    help.hidden = true;
    const badge = d.createElement('div');
    badge.className = 'badge chrome';
    badge.hidden = true;
    const outline = d.createElement('div');
    outline.className = 'outline chrome';
    outline.hidden = true;
    const fit = d.createElement('div');
    fit.className = 'fit chrome';
    fit.hidden = true;
    fit.setAttribute('role', 'status');
    const edit = d.createElement('div');
    edit.className = 'edit';
    // The outline sits under the cards and the edit panel; toasts, help and badges above everything.
    root.append(ink, capture, outline, cards, edit, hud, fit, toast, help, badge);
    this.shadow.append(root);
    return { root, ink, capture, cards, hud, toast, help, badge, outline, fit, edit };
  }

  /**
   * Mounts the host as soon as document.documentElement exists (at DOMContentLoaded at the latest, 9.1), moves
   * it to the end at DOMContentLoaded so it paints above the page's own fixed layers, and puts it back if the
   * page removes it or replaces the root element.
   */
  mount(): void {
    const tryMount = () => {
      const html = this.doc.documentElement;
      if (!html) return false;
      if (this.host.parentNode !== html) html.appendChild(this.host);
      this.applyHostStyle();
      this.watchRoot(html);
      return true;
    };
    if (!tryMount()) {
      const mo = new MutationObserver(() => {
        if (tryMount()) mo.disconnect();
      });
      mo.observe(this.doc, { childList: true });
    }
    // The root element may be replaced (document.open/write, replaceChild): follow it, and let the preload
    // re-add the window listeners document.open() erased (listeners.ts).
    const docMo = new MutationObserver(() => {
      if (this.doc.documentElement && this.host.parentNode !== this.doc.documentElement) {
        tryMount();
        for (const fn of this.onRootReplaced) fn();
      }
    });
    docMo.observe(this.doc, { childList: true });
    this.observers.push(docMo);
    const toEnd = () => {
      const html = this.doc.documentElement;
      if (html && html.lastElementChild !== this.host && !this.containsFocus()) html.appendChild(this.host);
      else if (html && this.host.parentNode !== html) tryMount();
    };
    if (this.doc.readyState === 'loading') this.doc.addEventListener('DOMContentLoaded', toEnd, { once: true });
    else toEnd();
  }

  private watchedRoot: Element | null = null;

  private watchRoot(html: Element): void {
    if (this.watchedRoot === html) return;
    this.watchedRoot = html;
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'childList') {
          for (const n of Array.from(r.removedNodes)) {
            if (n === this.host && this.doc.documentElement === html && this.host.parentNode !== html) {
              html.appendChild(this.host);
            }
          }
        } else if (r.type === 'attributes' && r.target === this.host && this.host.getAttribute('style') !== this.lastStyle) {
          this.applyHostStyle();
        }
      }
    });
    mo.observe(html, { childList: true });
    mo.observe(this.host, { attributes: true, attributeFilter: ['style', 'hidden', 'class'] });
    this.observers.push(mo);
  }

  /** Called after the page replaced the root element and the host was mounted on the new one. */
  whenRootReplaced(fn: () => void): void {
    this.onRootReplaced.push(fn);
  }

  /** A persistent pill at the top of the view (6.3 "Showing source case"), or none. */
  setBadge(text: string | null): void {
    const b = this.parts.badge;
    if (text === null) b.hidden = true;
    else {
      b.textContent = text;
      b.hidden = false;
    }
  }

  /** True when focus is inside the overlay (moving the host would blur the card's textarea). */
  containsFocus(): boolean {
    return this.shadow.activeElement !== null;
  }

  /** 6.7 Note screenshots: hide cards, outlines and other chrome; the ink stays. */
  setChromeHidden(hidden: boolean): void {
    this.parts.root.classList.toggle('chrome-hidden', hidden);
  }

  /**
   * A short message at the bottom of the deck view (for example "Suggest a change comes later"), optionally with
   * one button (6.3 Saving: Undo). The button is not wired with a listener: a click on it never reaches the page,
   * because the edit controller takes every press over the overlay's buttons at window capture and runs
   * toastAction() (P2-14).
   */
  showToast(text: string, opts: number | ToastOptions = 2200): void {
    const o: ToastOptions = typeof opts === 'number' ? { ms: opts } : opts;
    const t = this.parts.toast;
    const msg = this.doc.createElement('span');
    msg.className = 'toast-text';
    msg.textContent = text;
    if (o.action) {
      const b = this.doc.createElement('button');
      b.type = 'button';
      b.className = 'toast-action';
      b.dataset.action = 'toast';
      b.textContent = o.action.label;
      t.replaceChildren(msg, b);
    } else t.replaceChildren(msg);
    this.toastRun = o.action ? o.action.run : null;
    t.classList.toggle('actionable', !!o.action);
    t.hidden = false;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(
      () => {
        this.hideToast();
      },
      o.ms ?? (o.action ? ACTION_TOAST_MS : 2200),
    );
  }

  hideToast(): void {
    const t = this.parts.toast;
    t.hidden = true;
    t.classList.remove('actionable');
    this.toastRun = null;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = null;
  }

  /** The text the toast shows now ('' when hidden). */
  get toastText(): string {
    const t = this.parts.toast;
    return t.hidden ? '' : (t.querySelector('.toast-text')?.textContent ?? '');
  }

  /** The overlay element at a view point (the shadow root's own hit test), or null. */
  elementAt(x: number, y: number): Element | null {
    try {
      const el = this.shadow.elementFromPoint(x, y);
      return el && el !== this.host && this.shadow.contains(el) ? el : null;
    } catch {
      return null;
    }
  }

  /** The toast's button action when `el` is that button (or inside it), else null. Hides the toast when it runs. */
  toastAction(el: Element | null): (() => void) | null {
    const t = this.parts.toast;
    if (!el || t.hidden || !this.toastRun || !t.contains(el)) return null;
    const btn = el.closest('[data-action="toast"]');
    if (!btn || !t.contains(btn)) return null;
    const run = this.toastRun;
    return () => {
      this.hideToast();
      run();
    };
  }

  /** True when `el` is part of the toast (a press there is the overlay's, not the page's). */
  inToast(el: Element | null): boolean {
    return !!el && !this.parts.toast.hidden && this.parts.toast.contains(el);
  }

  /** Edit's hover outline around `r` (6.3): `solid` for exact, `dashed` for ambiguous; null hides it. */
  showOutline(r: ViewRect | null, kind: 'solid' | 'dashed' = 'solid'): void {
    const o = this.parts.outline;
    if (!r || !(r.w > 0 && r.h > 0)) {
      o.hidden = true;
      return;
    }
    const pad = 3;
    o.classList.toggle('dashed', kind === 'dashed');
    o.dataset.kind = kind;
    o.style.setProperty('left', `${Math.round(r.x - pad)}px`);
    o.style.setProperty('top', `${Math.round(r.y - pad)}px`);
    o.style.setProperty('width', `${Math.round(r.w + 2 * pad)}px`);
    o.style.setProperty('height', `${Math.round(r.h + 2 * pad)}px`);
    o.hidden = false;
  }

  /** The fit guard's badge (6.3: `+1 line`, `overflows`, `widow`) next to the edited element; null hides it. */
  setFitBadge(text: string | null, anchor: ViewRect | null = null): void {
    const f = this.parts.fit;
    if (text === null || !anchor) {
      f.hidden = true;
      return;
    }
    f.textContent = text;
    f.hidden = false;
    const win = this.doc.defaultView;
    const vw = win?.innerWidth ?? 1600;
    const vh = win?.innerHeight ?? 900;
    const w = f.offsetWidth || 120;
    const h = f.offsetHeight || 24;
    // Below the element's right edge, else above it; inside the view.
    let x = anchor.x + anchor.w - w;
    let y = anchor.y + anchor.h + 6;
    if (y + h > vh - 4) y = anchor.y - h - 6;
    x = Math.max(4, Math.min(x, vw - w - 4));
    y = Math.max(4, Math.min(y, vh - h - 4));
    f.style.setProperty('left', `${Math.round(x)}px`);
    f.style.setProperty('top', `${Math.round(y)}px`);
  }

  setHud(text: string | null): void {
    const h = this.parts.hud;
    if (text === null) h.hidden = true;
    else {
      h.textContent = text;
      h.hidden = false;
    }
  }

  get helpOpen(): boolean {
    return !this.parts.help.hidden;
  }

  /** The `?` help overlay (6.2 key table): the keys of the current mode (`edit`, else Review's). */
  toggleHelp(open?: boolean, mode: string = 'review'): void {
    const help = this.parts.help;
    const show = open ?? help.hidden;
    const which = mode === 'edit' ? 'edit' : 'review';
    if (show && (help.childElementCount === 0 || this.helpMode !== which)) {
      this.helpMode = which;
      const d = this.doc;
      const h = d.createElement('h2');
      h.textContent = which === 'edit' ? 'Keys in Edit' : 'Keys in Review and Edit';
      const dl = d.createElement('dl');
      const rows: [string, string][] =
        which === 'edit'
          ? [
              ['Click', 'Edit the text (solid outline); choose its place first (dashed)'],
              ['Enter', 'Save the edit'],
              ['Esc', 'Cancel the edit; again to return to Read'],
              ['Shift+Enter', 'Ignored: ask for a line break with a note'],
              ['Cmd+Z', 'Undo typing in the field; outside it, undo the last saved edit'],
              ['N', 'New note on the selection or hovered element'],
              ['J / K', 'Next / previous note'],
              ['\u2190 / \u2192', 'Move the deck'],
              ['?', 'This help'],
            ]
          : [
              ['V', 'Select (Review)'],
              ['1\u20135', 'Pen, highlighter, arrow, pin, box (Review)'],
              ['N', 'New note on the selection or hovered element'],
              ['R', 'Suggest a change (later)'],
              ['J / K', 'Next / previous note'],
              ['Esc', 'Close the card; again to return to Read'],
              ['\u2190 / \u2192', 'Move the deck'],
              ['?', 'This help'],
              ['Shift + stroke', 'Start a separate note'],
              ['Cmd+Enter', 'Close the card'],
            ];
      for (const [k, v] of rows) {
        const dt = d.createElement('dt');
        dt.textContent = k;
        const dd = d.createElement('dd');
        dd.textContent = v;
        dl.append(dt, dd);
      }
      help.replaceChildren(h, dl);
    }
    help.hidden = !show;
  }
}
