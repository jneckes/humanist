// core/dom-walk: the overlay's own changes are not script touches (P2-6), and describeNode builds a node's
// DomTextNode exactly as the render walk does. A small fake DOM and MutationObserver: the browser behaviour
// (records arriving after an input event) is checked in Electron by the overlay's E2E tests.
import { describe, expect, it } from 'vitest';
import { describeNode, DomWalker, ScriptTouchTracker } from '@blueline/core/dom-walk';

class FNode {
  parentNode: FNode | null = null;
  readonly childNodes: FNode[] = [];
  constructor(readonly nodeType: number) {}
  get parentElement(): FNode | null {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
  get previousSibling(): FNode | null {
    if (!this.parentNode) return null;
    const i = this.parentNode.childNodes.indexOf(this);
    return i > 0 ? this.parentNode.childNodes[i - 1] : null;
  }
  contains(n: FNode | null): boolean {
    for (let x = n; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
  append(...kids: FNode[]): this {
    for (const k of kids) {
      k.parentNode = this;
      this.childNodes.push(k);
    }
    return this;
  }
}

class FText extends FNode {
  constructor(public data: string) {
    super(3);
  }
}

class FEl extends FNode {
  constructor(private readonly attrs: Record<string, string> = {}) {
    super(1);
  }
  getAttribute(n: string): string | null {
    return Object.prototype.hasOwnProperty.call(this.attrs, n) ? this.attrs[n] : null;
  }
}

type Rec = { type: 'characterData' | 'childList'; target: FNode; addedNodes?: FNode[]; removedNodes?: FNode[] };

/** A MutationObserver whose records the test queues and delivers (the microtask, by hand). */
class FakeMO {
  static last: FakeMO;
  queue: Rec[] = [];
  constructor(private readonly cb: (r: Rec[]) => void) {
    FakeMO.last = this;
  }
  observe(): void {}
  takeRecords(): Rec[] {
    const r = this.queue;
    this.queue = [];
    return r;
  }
  push(...r: Rec[]): void {
    this.queue.push(...r.map((x) => ({ addedNodes: [], removedNodes: [], ...x })));
  }
  deliver(): void {
    const r = this.takeRecords();
    if (r.length > 0) this.cb(r);
  }
}

function setup() {
  // <section data-bl-e="bl-1"><h1 data-bl-e="bl-2">Title<span>Sub</span>More</h1><p>Plain</p></section>
  const t1 = new FText('Title');
  const sub = new FText('Sub');
  const span = new FEl().append(sub);
  const t2 = new FText('More');
  const h1 = new FEl({ 'data-bl-e': 'bl-2' }).append(t1, span, t2);
  const plain = new FText('Plain');
  const p = new FEl().append(plain);
  const section = new FEl({ 'data-bl-e': 'bl-1' }).append(h1, p);
  const doc = { readyState: 'complete', defaultView: { MutationObserver: FakeMO }, addEventListener() {} };
  const tracker = new ScriptTouchTracker(doc as unknown as Document);
  const mo = FakeMO.last;
  return { t1, t2, sub, span, h1, plain, p, section, tracker, mo };
}

const asText = (n: FNode) => n as unknown as Text;
const asNode = (n: FNode) => n as unknown as Node;

describe('describeNode (P2-6: Edit matches as blueline map does)', () => {
  it('without a tracker: stamp, textIndex, data and texts only', () => {
    const { t2 } = setup();
    expect(describeNode(asText(t2))).toEqual({ stamp: 'bl-2', textIndex: 1, data: 'More', texts: ['Title', 'More'] });
  });

  it('with the tracker: tracked; a node a script changed is touched, with its nearest stamped ancestor', () => {
    const { t1, sub, plain, tracker, mo } = setup();
    expect(describeNode(asText(t1), tracker)).toEqual({ stamp: 'bl-2', textIndex: 0, data: 'Title', texts: ['Title', 'More'], tracked: true });
    mo.push({ type: 'characterData', target: sub }, { type: 'characterData', target: plain });
    mo.deliver();
    expect(describeNode(asText(sub), tracker)).toMatchObject({ stamp: null, touched: true, stampedAncestor: 'bl-2', tracked: true });
    expect(describeNode(asText(plain), tracker)).toMatchObject({ touched: true, stampedAncestor: 'bl-1' });
    // Records still queued are taken when a node is described.
    mo.push({ type: 'characterData', target: t1 });
    expect(describeNode(asText(t1), tracker)).toMatchObject({ touched: true, stampedAncestor: 'bl-2' });
  });

  it('DomWalker.describeNode is the same with the walker\'s tracker', () => {
    const { t2, tracker, mo } = setup();
    mo.push({ type: 'characterData', target: t2 });
    const walker = new DomWalker({} as Window, { touched: tracker });
    expect(walker.describeNode(asText(t2))).toEqual(describeNode(asText(t2), tracker));
    expect(new DomWalker({} as Window).describeNode(asText(t2))).toEqual(describeNode(asText(t2)));
  });
});

describe('ScriptTouchTracker.ownChanges', () => {
  it('drops the records of the overlay\'s own change, and returns what fn returns', () => {
    const { t1, tracker, mo } = setup();
    const out = tracker.ownChanges(() => {
      t1.data = 'Edited';
      mo.push({ type: 'characterData', target: t1 });
      return 42;
    });
    expect(out).toBe(42);
    mo.deliver();
    expect(tracker.isTouched(asText(t1))).toBe(false);
  });

  it('delivers the changes queued before it as the page\'s', () => {
    const { t1, t2, tracker, mo } = setup();
    mo.push({ type: 'characterData', target: t2 }); // a page script, before the overlay's write
    tracker.ownChanges(() => mo.push({ type: 'characterData', target: t1 }));
    expect(tracker.isTouched(asText(t2))).toBe(true);
    expect(tracker.isTouched(asText(t1))).toBe(false);
  });

  it('with a scope, only changes inside it are the overlay\'s', () => {
    const { t1, plain, h1, tracker, mo } = setup();
    tracker.ownChanges(() => {
      mo.push({ type: 'characterData', target: t1 }, { type: 'characterData', target: plain });
    }, asNode(h1));
    expect(tracker.isTouched(asText(t1))).toBe(false);
    expect(tracker.isTouched(asText(plain))).toBe(true);
  });

  it('still takes its records when fn throws', () => {
    const { t1, tracker, mo } = setup();
    expect(() =>
      tracker.ownChanges(() => {
        mo.push({ type: 'characterData', target: t1 });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(tracker.isTouched(asText(t1))).toBe(false);
  });
});

describe('ScriptTouchTracker.ownRegion (an open edit field)', () => {
  it('while held, the browser\'s editing inside the field is not a script\'s, delivered or taken', () => {
    const { t1, h1, plain, tracker, mo } = setup();
    const release = tracker.ownRegion(asNode(h1));
    // Typing changes the text node; select-all and type may replace the field's text nodes (childList on h1).
    mo.push({ type: 'characterData', target: t1 });
    mo.deliver();
    const fresh = new FText('Typed');
    mo.push({ type: 'childList', target: h1, addedNodes: [fresh], removedNodes: [t1] });
    expect(tracker.isTouched(asText(t1))).toBe(false);
    // Outside the field, a page change counts as usual.
    mo.push({ type: 'characterData', target: plain });
    mo.deliver();
    expect(tracker.isTouched(asText(plain))).toBe(true);
    // Queued while held, still pending at the release: dropped by the release.
    mo.push({ type: 'characterData', target: t1 });
    release();
    expect(tracker.isTouched(asText(t1))).toBe(false);
    // After the release, the field's text is the page's again.
    mo.push({ type: 'characterData', target: t1 });
    expect(tracker.isTouched(asText(t1))).toBe(true);
    release(); // harmless twice
  });

  it('changes queued before the field opened are the page\'s', () => {
    const { t2, h1, tracker, mo } = setup();
    mo.push({ type: 'characterData', target: t2 });
    const release = tracker.ownRegion(asNode(h1));
    expect(tracker.isTouched(asText(t2))).toBe(true);
    release();
  });

  it('a page that removes the field itself is seen (the record targets the field\'s parent)', () => {
    const { h1, section, t1, tracker, mo } = setup();
    const release = tracker.ownRegion(asNode(h1));
    mo.push({ type: 'childList', target: section, removedNodes: [h1] });
    mo.deliver();
    release();
    // The section's children changed: its direct text children would count; the h1's own text is inside the
    // removed element, and the overlay turns what was typed into a verbatim note (P2-17).
    expect(tracker.isTouched(asText(t1))).toBe(false);
    const direct = new FText('direct');
    section.append(direct);
    expect(tracker.isTouched(asText(direct))).toBe(true);
  });
});
