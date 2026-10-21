// What the Chromium fuzz gate's mutation probe judges for a written edit (test/fuzz/harness/probe-select.ts; P2-16;
// SPEC 10 Phase 0 probe step 4: the sentinel in that DOM text node, in no other node except reported renders of the
// same run). Review finding 25: the node the author typed in is judged whether or not the run has other renders, so a
// write that lands elsewhere fails. Review finding 26: an edit the round's walk shows nowhere is probed on its own and
// fails when no stop shows it; the console-error and slide-count comparison runs for every round that wrote anything.
// Pure: no app module, no @blueline/editor (the reader-only gate runs test/fuzz/unit too). The decks these cases come
// from run end to end in scripts/fuzz-selftest.mjs.

import { describe, expect, it } from 'vitest';
import { authorNodes, judgeAlone, roundCheck, selectNodes, type AloneStop, type SeenNode, type WrittenEdit } from '../harness/probe-select';

const n = (key: string, data: string, exact: string | null = null): SeenNode => ({ key, data, exact });

/** wrongplace.html: #a is computed (['Quarterly','total'].join(' ')) and only reads like literal l:0:0, which feeds #b. */
const quarterly = (typedIn: '#a' | '#b', text = 'Quarterly total!'): WrittenEdit => ({
  runId: 'l:0:0',
  text,
  pick: false,
  target: { key: typedIn, data: 'Quarterly total', runId: 'l:0:0' },
  field: [{ key: typedIn, data: 'Quarterly total', runId: 'l:0:0' }],
});
const before = [n('h1', 'Summary', 'h:0'), n('#a', 'Quarterly total', 'l:0:0'), n('#b', 'Quarterly total', 'l:0:0')];

describe('selectNodes: the node the author typed in is always judged (finding 25)', () => {
  it('fails an edit typed in a node the run does not feed, though another render shows the new text', () => {
    // The write went to the literal: #b shows it, #a (where the author typed) still reads the old text.
    const after = [n('h1', 'Summary', 'h:0'), n('#a', 'Quarterly total'), n('#b', 'Quarterly total!', 'l:0:0')];
    const sel = selectNodes(quarterly('#a'), before, after);
    expect(sel).toMatchObject({ kind: 'render', node: { key: '#a', data: 'Quarterly total' } });
  });

  it('probes the author node with the run’s other renders when the edit shows where it was typed', () => {
    const after = [n('h1', 'Summary', 'h:0'), n('#a', 'Quarterly total'), n('#b', 'Quarterly total!', 'l:0:0')];
    const sel = selectNodes(quarterly('#b'), before, after);
    expect(sel.kind).toBe('probe');
    if (sel.kind !== 'probe') return;
    expect(sel.author.map((x) => x.key)).toEqual(['#b']);
    // #a no longer reads the run (it never did): not a render of it, so not judged here.
    expect(sel.extra).toEqual([]);
  });

  it('keeps every other exact render, and the places the run was that now read its new text, as extra nodes', () => {
    const e: WrittenEdit = { ...quarterly('#b'), runId: 'l:1:0', target: { key: '#b', data: 'Net', runId: 'l:1:0' }, field: [{ key: '#b', data: 'Net', runId: 'l:1:0' }], text: 'Gross' };
    const b = [n('#b', 'Net', 'l:1:0'), n('#c', 'Net', 'l:1:0'), n('#d', 'Net', 'l:1:0'), n('#e', 'Other', 'h:3')];
    const a = [n('#b', 'Gross', 'l:1:0'), n('#c', 'Gross', 'l:1:0'), n('#d', 'Gross'), n('#e', 'Other', 'h:3'), n('#f', 'Gross', 'l:1:0')];
    const sel = selectNodes(e, b, a);
    expect(sel.kind).toBe('probe');
    if (sel.kind !== 'probe') return;
    expect(sel.author.map((x) => x.key)).toEqual(['#b']);
    expect(sel.extra.map((x) => x.key).sort()).toEqual(['#c', '#d', '#f']);
  });

  it('a render the deck transforms is not the author node: trunc.html cuts the label in #nav, typed in #t', () => {
    const b = [n('#t', 'Pipeline', 'l:0:0'), n('#nav', 'Pipeline', 'l:0:0')];
    const a = [n('#t', 'Pipeline review 2026', 'l:0:0'), n('#nav', 'Pipeli...')];
    const typed = (key: string): WrittenEdit => ({ runId: 'l:0:0', text: 'Pipeline review 2026', pick: false, target: { key, data: 'Pipeline', runId: 'l:0:0' }, field: [{ key, data: 'Pipeline', runId: 'l:0:0' }] });
    expect(selectNodes(typed('#t'), b, a)).toMatchObject({ kind: 'probe', author: [{ key: '#t' }], extra: [] });
    // Typed in #nav, the author's node shows the cut form: a failure, though #t shows the new text.
    expect(selectNodes(typed('#nav'), b, a)).toMatchObject({ kind: 'render', node: { key: '#nav', data: 'Pipeli...' } });
  });

  it('a deck that sorts its labels moves the edited one: the node now holding it is the author’s (finding 25 re-verification)', () => {
    // sorted.html: labels drawn from literals into <li>s in alphabetical order. 'Lemon' (l:6:0) was the 7th; the
    // edit makes it 'Dictated text with a breakLemon', which sorts 4th; the 7th <li> now reads 'Kiwi' (l:5:0).
    const labels = ['Apple', 'Banana', 'Cherry', 'Fig', 'Grape', 'Kiwi', 'Lemon', 'Mango'];
    const runOf = (t: string) => `l:${labels.indexOf(t)}:0`;
    const b = labels.map((t, i) => n(`li:${i + 1}`, t, runOf(t)));
    const now = [...labels.filter((t) => t !== 'Lemon'), 'Dictated text with a breakLemon'].sort();
    const a = now.map((t, i) => n(`li:${i + 1}`, t, t === 'Dictated text with a breakLemon' ? 'l:6:0' : runOf(t)));
    const e: WrittenEdit = { runId: 'l:6:0', text: 'Dictated text with a breakLemon', pick: false, target: { key: 'li:7', data: 'Lemon', runId: 'l:6:0' }, field: [{ key: 'li:7', data: 'Lemon', runId: 'l:6:0' }] };
    const sel = selectNodes(e, b, a);
    expect(sel.kind).toBe('probe');
    if (sel.kind !== 'probe') return;
    expect(sel.author.map((x) => [x.key, x.data])).toEqual([['li:4', 'Dictated text with a breakLemon']]);
    // But the locator reading text no run holds is still a failure, though the new text shows elsewhere.
    const broken = a.map((x) => (x.key === 'li:7' ? n('li:7', 'Kiwi?') : x));
    expect(selectNodes(e, b, broken)).toMatchObject({ kind: 'render', node: { key: 'li:7', data: 'Kiwi?' } });
    // And with no exact render of the run holding the new text, a node reading another run's text fails too.
    const nowhere = a.map((x) => (x.exact === 'l:6:0' ? n(x.key, x.data) : x));
    expect(selectNodes(e, b, nowhere)).toMatchObject({ kind: 'render', node: { key: 'li:7', data: 'Kiwi' } });
  });

  it('a commit that went to another run of the field is judged on that run’s node in the field', () => {
    const e: WrittenEdit = {
      runId: 'h:2',
      text: 'Second!',
      pick: false,
      target: { key: 'p>0', data: 'First', runId: 'h:1' },
      field: [
        { key: 'p>0', data: 'First', runId: 'h:1' },
        { key: 'p>b>0', data: 'Second', runId: 'h:2' },
      ],
    };
    expect(authorNodes(e)).toEqual([{ key: 'p>b>0', data: 'Second' }]);
    const b = [n('p>0', 'First', 'h:1'), n('p>b>0', 'Second', 'h:2')];
    expect(selectNodes(e, b, [n('p>0', 'First', 'h:1'), n('p>b>0', 'Second!', 'h:2')])).toMatchObject({ kind: 'probe', author: [{ key: 'p>b>0' }] });
    expect(selectNodes(e, b, [n('p>0', 'First', 'h:1'), n('p>b>0', 'Second', 'h:2')])).toMatchObject({ kind: 'render', node: { key: 'p>b>0' } });
    expect(selectNodes({ ...e, field: [{ key: 'p>0', data: 'First', runId: 'h:1' }] }, b, [])).toEqual({ kind: 'lost' });
  });

  it('a locator a deck re-renders per slide: the copy with another slide’s text is not the author node', () => {
    const e: WrittenEdit = { runId: 'l:0:2', text: 'Third!', pick: false, target: { key: '#slot', data: 'Third', runId: 'l:0:2' }, field: [{ key: '#slot', data: 'Third', runId: 'l:0:2' }] };
    const b = [n('#slot', 'First', 'l:0:0'), n('#slot', 'Second', 'l:0:1'), n('#slot', 'Third', 'l:0:2')];
    expect(selectNodes(e, b, [n('#slot', 'First', 'l:0:0'), n('#slot', 'Second', 'l:0:1'), n('#slot', 'Third!', 'l:0:2')])).toMatchObject({ kind: 'probe', author: [{ data: 'Third!' }] });
    // The author's slide was not counted this time: probe it on its own, do not fail it on another slide's text.
    expect(selectNodes(e, b, [n('#slot', 'First', 'l:0:0'), n('#slot', 'Second', 'l:0:1')])).toMatchObject({ kind: 'alone', author: [{ key: '#slot' }] });
    // The author's slide still shows the old text: a failure.
    expect(selectNodes(e, b, [n('#slot', 'First', 'l:0:0'), n('#slot', 'Third', 'l:0:2')])).toMatchObject({ kind: 'render', node: { data: 'Third' } });
  });

  it('an edit whose node the walk does not show is probed on its own, never passed on another render (finding 26)', () => {
    // vanish2.html: a label with a quote is shown nowhere; #cap shows label 0 verbatim.
    const e: WrittenEdit = { runId: 'l:0:3', text: 'Delta "four"', pick: false, target: { key: '#item-3', data: 'Delta four', runId: 'l:0:3' }, field: [{ key: '#item-3', data: 'Delta four', runId: 'l:0:3' }] };
    expect(selectNodes(e, [n('#item-3', 'Delta four', 'l:0:3')], [n('#item-2', 'Charlie three', 'l:0:2')])).toEqual({ kind: 'alone', author: [{ key: '#item-3', others: new Set() }] });
    const other = [n('#item-3', 'Delta four', 'l:0:3'), n('#copy', 'Delta four', 'l:0:3')];
    expect(selectNodes(e, other, [n('#copy', 'Delta "four"', 'l:0:3')]).kind).toBe('alone');
  });

  it('a pick is judged on its picked node, wherever it is', () => {
    const e: WrittenEdit = { runId: 'l:4:0', text: 'Plan B', pick: true, target: { key: '#p', data: 'Plan', runId: 'l:4:0' }, field: [{ key: '#p', data: 'Plan', runId: 'l:4:0' }] };
    expect(selectNodes(e, [n('#p', 'Plan')], [n('#p', 'Plan')])).toMatchObject({ kind: 'picked', node: { key: '#p' } });
    expect(selectNodes(e, [n('#p', 'Plan')], [])).toMatchObject({ kind: 'alone' });
  });
});

describe('roundCheck: every round that wrote anything is compared with the walk before it (finding 26 b)', () => {
  it('fails a round whose walk logs a new console error or shows another slide count, even with nothing to probe', () => {
    const baseline = new Set(['Failed to load resource: blocked']);
    expect(roundCheck({ baseline, errors: ['Failed to load resource: blocked'], slidesBefore: 3, slidesAfter: 3 })).toBeNull();
    // throw-all.html: one odd character makes the script throw before anything renders.
    expect(roundCheck({ baseline, errors: ['Failed to load resource: blocked', 'Uncaught Error: bad label'], slidesBefore: 3, slidesAfter: 3 })).toMatch(/^new console error after the round's edits: Uncaught Error: bad label/);
    expect(roundCheck({ baseline, errors: [], slidesBefore: 3, slidesAfter: 1 })).toMatch(/slide count changed from 3 to 1/);
  });
});

describe('judgeAlone: the verdict of an edit probed on its own', () => {
  const author = [{ key: '#n', others: new Set<string>() }];
  const want = 'New text⟦bl⟧';
  const ok = { pass: true };
  const stop = (nodes: AloneStop['nodes'], rest: AloneStop['rest'] = ok, reached = true): AloneStop => ({ reached, nodes, rest });

  it('passes when some stop shows the author node visible with the new text and the sentinel, and no stop breaks a rule', () => {
    expect(judgeAlone([stop([]), stop([{ key: '#n', data: want, visible: true }])], { author, want })).toEqual({ pass: true });
  });

  it('fails an edit that shows nowhere: the node is gone, or there but never visible', () => {
    const gone = judgeAlone([stop([]), stop([])], { author, want });
    expect(gone).toMatchObject({ pass: false, render: false, why: expect.stringMatching(/^the edit shows nowhere/) });
    expect(gone).toMatchObject({ why: expect.stringContaining('it is not in the page at any stop') });
    expect(judgeAlone([stop([{ key: '#n', data: want, visible: false }])], { author, want })).toMatchObject({ pass: false, render: false, why: expect.stringContaining('in the page with the new text and the sentinel, but not laid out') });
    // A ticker's item, laid out but moved out of the viewport at every stop, still shows nowhere (lead decision E-12).
    // At another slide's stop it sits in the viewport under a hidden slide: that says nothing about why.
    const offscreen = judgeAlone(
      [stop([{ key: '#n', data: want, visible: false, laidOut: true, inView: false, onSlide: true }]), stop([{ key: '#n', data: want, visible: false, laidOut: true, inView: true, onSlide: false }])],
      { author, want },
    );
    expect(offscreen).toMatchObject({ pass: false, render: false, why: expect.stringContaining('laid out but outside the viewport at every stop that shows its slide') });
    const styled = judgeAlone([stop([{ key: '#n', data: want, visible: false, laidOut: true, inView: true }])], { author, want });
    expect(styled).toMatchObject({ pass: false, render: false, why: expect.stringContaining('hidden by its style') });
    expect(judgeAlone([stop([{ key: '#n', data: 'Old', visible: false }])], { author, want })).toMatchObject({ pass: false, render: false, why: expect.stringContaining('reads other text') });
    expect(judgeAlone([stop([], ok, false), stop([])], { author, want })).toMatchObject({ why: expect.stringContaining('1 of 2 stops could not be shown again') });
    expect(judgeAlone([stop([], ok, false)], { author, want })).toMatchObject({ pass: false, render: false, why: expect.stringContaining('no stop of the walk') });
  });

  it('fails a node that is shown with other text as a render failure', () => {
    expect(judgeAlone([stop([{ key: '#n', data: 'Old text', visible: true }])], { author, want })).toEqual({ pass: false, render: true, reads: 'Old text' });
    // Another slide's text at the same locator is not the author's node: the edit then shows nowhere.
    const slot = [{ key: '#n', others: new Set(['Other slide']) }];
    expect(judgeAlone([stop([{ key: '#n', data: 'Other slide', visible: true }])], { author: slot, want })).toMatchObject({ pass: false, render: false });
  });

  it('fails on the rules every stop must keep: the sentinel elsewhere, a new console error, another slide count', () => {
    const broken = { pass: false, why: 'new console error: Uncaught Error: bad label' };
    expect(judgeAlone([stop([{ key: '#n', data: want, visible: true }]), stop([], broken)], { author, want })).toEqual({ pass: false, render: false, why: broken.why });
  });

  it('a picked node need only be shown', () => {
    expect(judgeAlone([stop([{ key: '#n', data: 'Anything', visible: true }])], { author, want: null })).toEqual({ pass: true });
    expect(judgeAlone([stop([{ key: '#n', data: 'Anything', visible: false }])], { author, want: null })).toMatchObject({ pass: false });
  });
});
