// Review and Edit render the deck with prefers-reduced-motion: reduce; Read keeps the deck's own motion (Josh,
// 2026-10-17; docs/spec-amendments/README.md, decision 1; packages/app/src/main/motion.ts).

import { expect, test } from '@playwright/test';
import * as path from 'node:path';
import { FIXTURES, Scratch, copyInto, launchApp, resolveRunAs, sleep } from '../helpers/app';

test.describe.configure({ mode: 'serial' });

async function waitFor<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  let v = await read();
  while (!ok(v) && Date.now() < end) {
    await sleep(100);
    v = await read();
  }
  return v;
}

test('a deck that reads the setting at load is reloaded with reduced motion in Review, on the same slide, and with motion in Read', async () => {
  const s = new Scratch(resolveRunAs());
  const dir = s.dir('deck');
  const file = copyInto(path.join(FIXTURES, 'motion/motion-script.html'), dir);
  s.own(dir);
  const app = await launchApp({ files: [file], scratch: s });
  try {
    const deck = await app.waitForDeck('motion-script.html');
    const motion = () => deck.eval<string>('document.documentElement.dataset.motion || ""');
    const slide = () => deck.eval<string>('document.documentElement.dataset.slide || ""');
    expect(await motion()).toBe('no-preference');
    await deck.eval('location.hash = "#2"');
    expect(await waitFor(slide, (v) => v === '2')).toBe('2');
    const before = await deck.eval<number>('performance.timeOrigin');

    await deck.chord('2');
    const got = await waitFor(motion, (v) => v === 'reduce');
    expect(got, 'Review renders with reduced motion').toBe('reduce');
    expect(await deck.eval<number>('performance.timeOrigin'), 'the deck reloaded').not.toBe(before);
    expect(await slide(), 'the reload kept the slide (URL hash)').toBe('2');
    expect((await app.win(deck.docId)).appMode).toBe('review');

    await deck.chord('3');
    await sleep(600);
    // Review to Edit keeps reduced motion: no reload, still reduced (Edit is available for a Trusted file).
    expect(await motion()).toBe('reduce');

    await deck.chord('1');
    expect(await waitFor(motion, (v) => v === 'no-preference'), 'Read keeps the deck’s own motion').toBe('no-preference');
    expect(await slide()).toBe('2');
  } finally {
    await app.close();
    s.cleanup();
  }
});

test('a deck that uses the setting in CSS only follows the emulation live, with no reload', async () => {
  const s = new Scratch(resolveRunAs());
  const dir = s.dir('deck');
  const file = copyInto(path.join(FIXTURES, 'motion/motion-css.html'), dir);
  s.own(dir);
  const app = await launchApp({ files: [file], scratch: s });
  try {
    const deck = await app.waitForDeck('motion-css.html');
    const width = () => deck.eval<string>('getComputedStyle(document.getElementById("probe")).width');
    expect(await width()).toBe('10px');
    const before = await deck.eval<number>('performance.timeOrigin');
    await deck.chord('2');
    expect(await waitFor(width, (v) => v === '20px')).toBe('20px');
    expect(await deck.eval<number>('performance.timeOrigin'), 'no reload').toBe(before);
    await deck.chord('1');
    expect(await waitFor(width, (v) => v === '10px')).toBe('10px');
  } finally {
    await app.close();
    s.cleanup();
  }
});
