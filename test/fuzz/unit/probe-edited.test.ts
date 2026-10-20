// The probe's checks of edited text (probe.ts NodeCheck.expectData and pickedRun), which the Chromium fuzz gate
// relies on (P2-16): a node must read exactly the edited text plus its sentinel, and a picked run is judged on
// where else its sentinel lands. `blueline map` sets neither, so its verdicts are unchanged
// (test/unit/app/probe.test.ts).

import { describe, expect, it } from 'vitest';
import type { FindResult, NodeLocator } from '@blueline/core/ipc';
import { SENTINEL, batchSentinel, judgeNode, locatorKey, type NodeCheck } from '../../../packages/app/src/main/probe';

const self: NodeLocator = { stamp: 'bl-1', cssPath: '#t', childIndex: 0 };
const other: NodeLocator = { stamp: 'bl-2', cssPath: '#u', childIndex: 0 };
type Match = FindResult['matches'][number];
const m = (loc: NodeLocator, data: string, extra: Partial<Match> = {}): Match => ({ key: 2, locator: loc, node: { stamp: loc.stamp, textIndex: 0, data }, visible: true, slide: 0, ...extra });

function check(data: string, opts: Partial<NodeCheck> = {}, found: Match[] = [m(self, data)]): NodeCheck {
  return {
    reached: true,
    slideCountBefore: 3,
    slideCountAfter: 3,
    located: { found: true, node: { key: 1, locator: self, node: { stamp: 'bl-1', textIndex: 0, data }, rect: { x: 0, y: 0, w: 1, h: 1 } }, visible: true, slide: 0 },
    found: { truncated: false, matches: found },
    self,
    sameRun: new Set(),
    reported: new Set([locatorKey(self), locatorKey(other)]),
    newErrors: [],
    ...opts,
  };
}

describe('judgeNode with expectData: the edited text renders exactly as written', () => {
  it('passes a node that reads the new text plus its sentinel', () => {
    const data = `R&D <b> 50%${SENTINEL}`;
    expect(judgeNode(check(data, { expectData: data }))).toEqual({ pass: true });
  });

  it('fails a node that holds the sentinel but shows the text otherwise (an entity left literal, a lost character)', () => {
    const v = judgeNode(check(`R&amp;D${SENTINEL}`, { expectData: `R&D${SENTINEL}` }));
    expect(v).toMatchObject({ pass: false, why: expect.stringContaining('not the edited text') });
    expect(judgeNode(check(`RD${SENTINEL}`, { expectData: `R&D${SENTINEL}` })).pass).toBe(false);
    // White space counts too: the DOM text node must be the run's text, character for character.
    expect(judgeNode(check(`R  D${SENTINEL}`, { expectData: `R D${SENTINEL}` })).pass).toBe(false);
  });

  it('still fails on everything map fails on: the sentinel elsewhere, a new console error, another slide count', () => {
    const data = `New title${SENTINEL}`;
    expect(judgeNode(check(data, { expectData: data }, [m(self, data), m(other, `x${SENTINEL}`)])).pass).toBe(false);
    expect(judgeNode(check(data, { expectData: data, newErrors: ['SyntaxError: Unexpected token'] })).pass).toBe(false);
    expect(judgeNode(check(data, { expectData: data, slideCountAfter: 2 })).pass).toBe(false);
  });

  it('a batch judges each node against its own sentinel', () => {
    const s1 = batchSentinel(0);
    const s2 = batchSentinel(1);
    const data = `Edited${s1}`;
    expect(judgeNode(check(data, { expectData: data, sentinel: s1 }, [m(self, data), m(other, `Other${s2}`)]))).toEqual({ pass: true });
  });
});

describe('judgeNode with pickedRun: the author chose the run (P2-8)', () => {
  it('does not require the picked node to show the run', () => {
    const v = judgeNode(check('Plan', { pickedRun: true }, [m(other, `Plan${SENTINEL}`)], ));
    // The only node with the sentinel is a reported node of another run: that is a write the author did not see.
    expect(v.pass).toBe(false);
    const sameRun = new Set([locatorKey(other)]);
    expect(judgeNode(check('Plan', { pickedRun: true, sameRun }, [m(other, `Plan${SENTINEL}`)]))).toEqual({ pass: true });
    expect(judgeNode(check('Plan', { pickedRun: true, located: null }, []))).toEqual({ pass: true });
  });

  it('still fails when the sentinel lands in a node the report does not count, or the page breaks', () => {
    const hidden: NodeLocator = { stamp: null, cssPath: 'div.hidden', childIndex: 0 };
    expect(judgeNode(check('Plan', { pickedRun: true }, [m(hidden, `Plan${SENTINEL}`, { visible: false, clipped: false })])).pass).toBe(false);
    expect(judgeNode(check('Plan', { pickedRun: true, newErrors: ['TypeError'] }, [])).pass).toBe(false);
    expect(judgeNode(check('Plan', { pickedRun: true, reached: false }, [])).pass).toBe(false);
  });
});
