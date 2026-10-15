// core/dom-walk.ts and core/slides.ts parts that run without a browser, on a tiny fake DOM. The browser
// parts (visibility, collect, detection on the fixtures) are checked in real Electron by
// test/e2e/preload-render.spec.ts.
import { describe, expect, it } from 'vitest';
import { childTextIndexOf, cssEscape, cssPath, describeTextNode, stampOf, textIndexOf } from '@blueline/core/dom-walk';
import { hashFor, inferHashFormat, slideTitle, trimTitle } from '@blueline/core/slides';

const HTML_NS = 'http://www.w3.org/1999/xhtml';

class FNode {
  parentNode: FEl | null = null;
  constructor(readonly nodeType: number) {}
  get parentElement(): FEl | null {
    return this.parentNode;
  }
  get previousSibling(): FNode | null {
    const p = this.parentNode;
    if (!p) return null;
    const i = p.childNodes.indexOf(this);
    return i > 0 ? p.childNodes[i - 1] : null;
  }
}
class FText extends FNode {
  constructor(public data: string) {
    super(3);
  }
}
class FEl extends FNode {
  childNodes: FNode[] = [];
  namespaceURI = HTML_NS;
  ownerDocument!: FDoc;
  constructor(
    readonly localName: string,
    readonly attrs: Record<string, string> = {},
  ) {
    super(1);
  }
  get isConnected(): boolean {
    return true;
  }
  getAttribute(n: string): string | null {
    return n in this.attrs ? this.attrs[n] : null;
  }
  get children(): FEl[] {
    return this.childNodes.filter((c): c is FEl => c instanceof FEl);
  }
  get previousElementSibling(): FEl | null {
    const p = this.parentNode;
    if (!p) return null;
    const kids = p.children;
    const i = kids.indexOf(this);
    return i > 0 ? kids[i - 1] : null;
  }
  get textContent(): string {
    return this.childNodes.map((c) => (c instanceof FText ? c.data : (c as FEl).textContent)).join('');
  }
  all(): FEl[] {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  querySelectorAll(sel: string): FEl[] {
    if (sel === 'h1, h2, h3') return this.all().filter((e) => /^h[1-3]$/.test(e.localName));
    throw new Error('unsupported selector ' + sel);
  }
}
class FDoc {
  constructor(readonly root: FEl) {}
  querySelectorAll(sel: string): FEl[] {
    const m = /^#(.+)$/.exec(sel);
    if (!m) throw new Error('unsupported ' + sel);
    const id = m[1].replace(/\\(.)/g, '$1');
    return [this.root, ...this.root.all()].filter((e) => e.getAttribute('id') === id);
  }
}

function el(name: string, attrs: Record<string, string> = {}, ...kids: (FEl | string)[]): FEl {
  const e = new FEl(name, attrs);
  for (const k of kids) {
    const n = typeof k === 'string' ? new FText(k) : k;
    n.parentNode = e;
    e.childNodes.push(n);
  }
  return e;
}
function doc(root: FEl): FDoc {
  const d = new FDoc(root);
  for (const e of [root, ...root.all()]) e.ownerDocument = d;
  return d;
}

describe('textIndex and locators (section 10 step 4; 9.2 Strategy 1 step 2)', () => {
  it('counts direct child text nodes that are not whitespace-only (NBSP is not whitespace)', () => {
    const p = el('p', {}, '\n  ', 'One ', el('b', {}, 'two'), ' \t', ' ', el('br'), 'three');
    const texts = p.childNodes.filter((c): c is FText => c instanceof FText);
    expect(texts.map((t) => textIndexOf(t as unknown as Text))).toEqual([-1, 0, -1, 1, 2]);
    // childIndex counts every text child, whitespace-only ones too (NodeLocator.childIndex).
    expect(texts.map((t) => childTextIndexOf(t as unknown as Text))).toEqual([0, 1, 2, 3, 4]);
  });

  it('describes a node with its parent stamp; a malformed data-bl-e is not a stamp', () => {
    const a = el('h2', { 'data-bl-e': 'bl-12' }, 'Title');
    const b = el('h2', { 'data-bl-e': 'bl-x"]' }, 'Title');
    expect(describeTextNode(a.childNodes[0] as unknown as Text)).toEqual({ stamp: 'bl-12', textIndex: 0, data: 'Title' });
    expect(stampOf(b as unknown as Element)).toBeNull();
  });

  it('builds CSS paths from the nearest unique id with :nth-of-type steps', () => {
    const target = el('span', {}, 'x');
    const root = el(
      'html',
      {},
      el('body', {}, el('div', { id: 'deck' }, el('section'), el('p'), el('section', {}, el('h2', {}, 'A'), el('p', {}, 'b'), el('p', {}, target)))),
    );
    doc(root);
    expect(cssPath(target as unknown as Element)).toBe('#deck > section:nth-of-type(2) > p:nth-of-type(2) > span:nth-of-type(1)');
    const deck = root.all().find((e) => e.getAttribute('id') === 'deck')!;
    expect(cssPath(deck as unknown as Element)).toBe('#deck');
  });

  it('skips a duplicate id and falls back to the root', () => {
    const t = el('em', {}, 'x');
    const root = el('html', {}, el('body', {}, el('div', { id: 'dup' }, t), el('div', { id: 'dup' })));
    doc(root);
    expect(cssPath(t as unknown as Element)).toBe('html > body:nth-of-type(1) > div:nth-of-type(1) > em:nth-of-type(1)');
  });

  it('escapes identifiers like CSS.escape', () => {
    expect(cssEscape('slide-1')).toBe('slide-1');
    expect(cssEscape('1st')).toBe('\\31 st');
    expect(cssEscape('-1x')).toBe('-\\31 x');
    expect(cssEscape('-')).toBe('\\-');
    expect(cssEscape('a.b#c d')).toBe('a\\.b\\#c\\ d');
    expect(cssEscape('é✓')).toBe('é✓');
    expect(cssEscape('a\u0000b')).toBe('a�b');
    expect(cssEscape('\u0001')).toBe('\\1 ');
  });
});

describe('slide titles and hashes (9.4)', () => {
  it('trims to 80 characters without splitting a surrogate pair', () => {
    expect(trimTitle('  Hello \n  world  ')).toBe('Hello world');
    const long = 'a'.repeat(79) + '😀b';
    expect(trimTitle(long)).toBe('a'.repeat(79));
    expect(trimTitle('x'.repeat(100)).length).toBe(80);
  });

  it('takes the first non-empty h1–h3, else data-title, else Slide N', () => {
    expect(slideTitle(el('section', {}, el('p', {}, 'x'), el('h3', {}, '  Third '), el('h1', {}, 'First')) as unknown as Element, 0)).toBe('Third');
    expect(slideTitle(el('section', { 'data-title': 'Customer voice' }, el('blockquote', {}, 'q')) as unknown as Element, 4)).toBe('Customer voice');
    expect(slideTitle(el('section', {}, el('h2', {}, '   '), el('p', {}, 'x')) as unknown as Element, 5)).toBe('Slide 6');
  });

  it('infers how a deck spells slide hashes, and refuses anything else', () => {
    expect(inferHashFormat('#roles', 1, 'roles')).toBe('#id');
    expect(inferHashFormat('#/roles', 1, 'roles')).toBe('#/id');
    expect(inferHashFormat('#3', 2, null)).toBe('#n1');
    expect(inferHashFormat('#2', 2, null)).toBe('#n0');
    expect(inferHashFormat('#/3', 2, 'x')).toBe('#/n1');
    expect(inferHashFormat('', 0, 'intro')).toBeNull();
    expect(inferHashFormat('#', 0, 'intro')).toBeNull();
    expect(inferHashFormat('#!/page', 0, 'intro')).toBeNull();
    expect(inferHashFormat('#caf%C3%A9', 0, 'café')).toBe('#id');
  });

  it('spells every slide in a format, or null when a slide has no id', () => {
    expect(hashFor('#id', 0, 'intro')).toBe('#intro');
    expect(hashFor('#id', 1, null)).toBeNull();
    expect(hashFor('#/id', 0, 'a b')).toBe('#/a%20b');
    expect(hashFor('#n1', 4, null)).toBe('#5');
    expect(hashFor('#/n0', 4, null)).toBe('#/4');
  });
});
