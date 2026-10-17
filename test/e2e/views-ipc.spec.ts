// The views' deck channels are written by the page (9.1: "Main treats every message from a deck view as written
// by the page"). A Protected deck forging them through the preload's ipcRenderer (__blTestIpc, test builds only)
// cannot step its own slides with no PageUp/PageDown from the user, cannot move its view with no wheel, cannot
// shrink its view with a design size measured anywhere but at 1600×900, and malformed payloads are dropped. None of
// them changes the trust state or opens anything.

import { expect, test } from '@playwright/test';
import * as path from 'node:path';
import { FIXTURES, Scratch, copyInto, launchApp, resolveRunAs, sleep, type BlApp } from '../helpers/app';
import { FilesDeckToMain } from '../../packages/core/src/ipc-files';
import { ViewsDeckToMain } from '../../packages/core/src/ipc-views';

test.describe.configure({ mode: 'serial' });

const scratch = new Scratch(resolveRunAs());
test.afterAll(() => scratch.cleanup());

interface Win {
  trust: string;
  networkAllowed: boolean;
  editingAllowed: boolean;
  zoomFactor: number;
  view: { design: { w: number; h: number }; deck: { x: number; y: number } };
  state: { slide: { current: number } | null; view: { scroll: { x: number; y: number } | null } };
}

async function w(app: BlApp, docId: string): Promise<Win> {
  return (await app.win(docId)) as unknown as Win;
}

test('forged views messages from a Protected deck move nothing and change nothing', async () => {
  const dir = scratch.dir('views-ipc');
  const file = copyInto(path.join(FIXTURES, 'decks/generic-index.html'), dir);
  scratch.own(dir);
  const app = await launchApp({ files: [file], scratch, protected: true });
  try {
    const deck = await app.waitForDeck('generic-index.html');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.current ?? -1).toBe(0);
    const send = (channel: string, payload: unknown) =>
      deck.isolated(`(function(){ globalThis.__blTestIpc.send(${JSON.stringify(channel)}, ${JSON.stringify(payload)}); return true; })()`);
    const before = await w(app, deck.docId);
    expect(before.trust).toBe('protected');

    // A page step with no PageDown from the user: main presses nothing.
    for (let i = 0; i < 5; i++) await send(ViewsDeckToMain.pageStep, { dir: 1 });
    await sleep(1500);
    expect((await w(app, deck.docId)).state.slide?.current).toBe(0);

    // A design size measured at another viewport (a deck sized in vw shrinking its own view): ignored.
    const zoom = (await w(app, deck.docId)).zoomFactor;
    await send(ViewsDeckToMain.design, { kind: 'generic', w: 200, h: 100, viewportW: 900, viewportH: 500 });
    await sleep(500);
    expect((await w(app, deck.docId)).zoomFactor).toBe(zoom);

    // Wheel pans with no wheel, at 100% (where the view scrolls): the view stays.
    await app.run('zoom-actual', deck.docId);
    await expect.poll(async () => (await w(app, deck.docId)).zoomFactor).toBe(1);
    await send(ViewsDeckToMain.wheel, { dx: 400, dy: 400 });
    await sleep(500);
    expect((await w(app, deck.docId)).state.view.scroll).toMatchObject({ x: 0, y: 0 });

    // Malformed payloads are dropped by the guard (and logged in test builds).
    await send(ViewsDeckToMain.pageStep, { dir: 7 });
    await send(ViewsDeckToMain.wheel, { dx: 'x', dy: 1 });
    await send(ViewsDeckToMain.design, { kind: 'generic', w: 1e9, h: 1, viewportW: 1600, viewportH: 900 });
    await send(FilesDeckToMain.busy, { edit: 'yes', card: 'none' });
    await send(FilesDeckToMain.viewState, { reqId: 1, state: { scroll: { x: 0, y: 0 }, hash: 'javascript:alert(1)', slide: null, card: null } });
    await send(FilesDeckToMain.dropRefused, { path: '/etc/passwd' });
    await expect.poll(() => app.logsMatching(/ipc drop bl:views:page-step invalid/).length).toBeGreaterThan(0);
    expect(app.logsMatching(/ipc drop bl:views:wheel invalid/).length).toBeGreaterThan(0);
    expect(app.logsMatching(/ipc drop bl:views:design invalid/).length).toBeGreaterThan(0);
    expect(app.logsMatching(/ipc drop bl:files:busy invalid/).length).toBeGreaterThan(0);
    expect(app.logsMatching(/ipc drop bl:files:view-state invalid/).length).toBeGreaterThan(0);
    expect(app.logsMatching(/ipc drop bl:files:drop-refused invalid/).length).toBeGreaterThan(0);

    // Nothing about trust changed, and no other window opened.
    const after = await w(app, deck.docId);
    expect(after.trust).toBe('protected');
    expect(after.networkAllowed).toBe(false);
    expect(after.editingAllowed).toBe(false);
    expect((await app.windows()).length).toBe(1);

    // The real keys still work: PageDown from the user moves the deck (it handles PageDown itself).
    await deck.key('PageDown');
    await expect.poll(async () => (await w(app, deck.docId)).state.slide?.current ?? -1).toBe(1);
  } finally {
    await app.close();
  }
});
