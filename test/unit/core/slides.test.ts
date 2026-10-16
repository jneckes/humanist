// core/slides.ts detectSlides on a small fake DOM (9.4 step 2; finding 29). The browser parts are checked in
// real Electron by test/e2e/slides.spec.ts (blueline map on fixtures/slides/cards.html).
import { describe, expect, it } from 'vitest';
import { currentSlide, detectSlides } from '@blueline/core/slides';

class FEl {
  parentElement: FEl | null = null;
  readonly children: FEl[] = [];
  text = '';
  /** display: none on this element (it and its subtree have no box). */
  hidden = false;
  constructor(
    readonly localName: string,
    readonly attrs: Record<string, string> = {},
  ) {}
  getAttribute(n: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null;
  }
  hasAttribute(n: string): boolean {
    return this.getAttribute(n) !== null;
  }
  get classList(): { contains(c: string): boolean } {
    const list = (this.attrs.class ?? '').split(/\s+/);
    return { contains: (c: string) => list.includes(c) };
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join('');
  }
  contains(other: FEl | null): boolean {
    for (let n = other; n; n = n.parentElement) if (n === this) return true;
    return false;
  }
  /** Rendered: neither it nor an ancestor is display: none. */
  shown(): boolean {
    for (let n: FEl | null = this; n; n = n.parentElement) if (n.hidden) return false;
    return true;
  }
  get offsetWidth(): number {
    return this.shown() ? 1600 : 0;
  }
  get offsetHeight(): number {
    return this.shown() ? 900 : 0;
  }
  getBoundingClientRect(): { width: number; height: number; top: number } {
    return this.shown() ? { width: 1600, height: 900, top: 0 } : { width: 0, height: 0, top: 0 };
  }
  descendants(): FEl[] {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }
  querySelectorAll(sel: string): FEl[] {
    if (sel === 'h1, h2, h3') return this.descendants().filter((e) => /^h[1-3]$/.test(e.localName));
    throw new Error(`unsupported selector ${sel}`);
  }
}

function el(name: string, attrs: Record<string, string> = {}, ...kids: (FEl | string)[]): FEl {
  const e = new FEl(name, attrs);
  for (const k of kids) {
    if (typeof k === 'string') e.text += k;
    else {
      k.parentElement = e;
      e.children.push(k);
    }
  }
  return e;
}

function hide(e: FEl): FEl {
  e.hidden = true;
  return e;
}

function page(body: FEl) {
  const html = el('html', {}, body);
  const all = () => [html, ...html.descendants()];
  const doc = {
    body,
    documentElement: html,
    querySelectorAll(sel: string): FEl[] {
      if (sel === '.reveal .slides > section') return [];
      if (sel === 'section, .slide, [data-slide]') return all().filter((e) => e.localName === 'section' || e.classList.contains('slide') || e.hasAttribute('data-slide'));
      if (sel === 'section[id]') return all().filter((e) => e.localName === 'section' && e.hasAttribute('id'));
      throw new Error(`unsupported selector ${sel}`);
    },
  };
  const win = {
    innerHeight: 900,
    location: { hash: '' },
    getComputedStyle: () => ({ visibility: 'visible', opacity: '1' }),
  };
  return { doc: doc as unknown as Document, win: win as unknown as Window };
}

/** fixtures/slides/cards.html: 3 .slide divs, one shown; each an h2 and a grid of 4 cards (`card` elements). */
function cardsDeck(card: 'section' | 'div', shown = 0): FEl[] {
  const slides = [1, 2, 3].map((n) =>
    el(
      'div',
      { class: 'slide' },
      el('h2', {}, `Slide ${n} heading`),
      el('div', { class: 'grid' }, ...[1, 2, 3, 4].map((c) => el(card, { class: 'card' }, el('h3', {}, `Card ${c} on slide ${n}`)))),
    ),
  );
  slides.forEach((s, i) => {
    if (i !== shown) hide(s);
  });
  return slides;
}

describe('detectSlides: generic slide engine (9.4 step 2)', () => {
  it('cards inside a hidden slide are not the slides (finding 29: a group with nothing visible does not qualify)', () => {
    const slides = cardsDeck('section');
    const { doc, win } = page(el('body', {}, ...slides));
    const m = detectSlides(doc, win);
    expect(m.kind).toBe('generic');
    expect(m.count).toBe(3);
    expect(m.titles).toEqual(['Slide 1 heading', 'Slide 2 heading', 'Slide 3 heading']);
    expect(m.current).toBe(0);
    // The deck moves: slide 2 shown. Detection still finds the slides, and the current one follows.
    hide(slides[0]);
    slides[1].hidden = false;
    const again = detectSlides(doc, win);
    expect(again.count).toBe(3);
    expect(again.current).toBe(1);
    expect(currentSlide(m, win)).toBe(1);
  });

  it('the <div class=card> control gives the same slides', () => {
    const { doc, win } = page(el('body', {}, ...cardsDeck('div')));
    const m = detectSlides(doc, win);
    expect(m.kind).toBe('generic');
    expect(m.titles).toEqual(['Slide 1 heading', 'Slide 2 heading', 'Slide 3 heading']);
  });

  it('three or more siblings with none visible are not a deck', () => {
    const { doc, win } = page(el('body', {}, el('h1', {}, 'Doc'), ...[1, 2, 3].map((n) => hide(el('section', {}, el('h2', {}, `Hidden ${n}`))))));
    expect(detectSlides(doc, win).kind).not.toBe('generic');
  });

  it('the outermost qualifying group wins over a longer one nested inside a slide (a carousel on a slide)', () => {
    const carousel = el('div', { class: 'carousel' }, ...[1, 2, 3, 4, 5].map((n) => el('div', { class: 'slide' }, el('h3', {}, `Photo ${n}`))));
    carousel.children.forEach((c, i) => {
      if (i !== 0) hide(c);
    });
    const outer = [1, 2, 3].map((n) => el('section', {}, el('h2', {}, `Section ${n}`), ...(n === 1 ? [carousel] : [])));
    hide(outer[1]);
    hide(outer[2]);
    const { doc, win } = page(el('body', {}, ...outer));
    const m = detectSlides(doc, win);
    expect(m.kind).toBe('generic');
    expect(m.titles).toEqual(['Section 1', 'Section 2', 'Section 3']);
  });

  it('a group with one or two visible still qualifies; three visible do not (a transition shows two)', () => {
    const two = [1, 2, 3, 4].map((n) => el('div', { class: 'slide' }, el('h2', {}, `S${n}`)));
    hide(two[2]);
    hide(two[3]);
    const a = page(el('body', {}, ...two));
    expect(detectSlides(a.doc, a.win)).toMatchObject({ kind: 'generic', count: 4 });
    const three = [1, 2, 3].map((n) => el('div', { class: 'slide' }, el('h2', {}, `S${n}`)));
    const b = page(el('body', {}, ...three));
    expect(detectSlides(b.doc, b.win).kind).not.toBe('generic');
  });
});
