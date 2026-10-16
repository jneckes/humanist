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
}

export class Overlay {
  readonly host: HTMLElement;
  private readonly shadow: ShadowRoot;
  readonly parts: OverlayParts;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
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
    root.append(ink, capture, cards, hud, toast, help, badge);
    this.shadow.append(root);
    return { root, ink, capture, cards, hud, toast, help, badge };
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

  /** A short message at the bottom of the deck view (for example "Suggest a change comes later"). */
  showToast(text: string, ms = 2200): void {
    const t = this.parts.toast;
    t.textContent = text;
    t.hidden = false;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      t.hidden = true;
      this.toastTimer = null;
    }, ms);
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

  /** The `?` help overlay (6.2 key table). */
  toggleHelp(open?: boolean): void {
    const help = this.parts.help;
    const show = open ?? help.hidden;
    if (show && help.childElementCount === 0) {
      const d = this.doc;
      const h = d.createElement('h2');
      h.textContent = 'Keys in Review and Edit';
      const dl = d.createElement('dl');
      const rows: [string, string][] = [
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
      help.append(h, dl);
    }
    help.hidden = !show;
  }
}
