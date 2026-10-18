// A drag that starts inside a deck works as in Chrome, and the deck keeps its keyboard afterwards (SPEC 4: the
// deck renders as Chromium renders it; 6.9 Read; measurement step after review round 1).
//
// The repair step had turned on Chromium drag interception (CDP Input.setInterceptDrags) on the deck view as a
// file-drop backstop. Interception only applies to drags the page itself starts (RenderWidgetHostImpl::
// StartDragging); a drag that enters from the desktop reaches the page through DragTargetDragEnter, which it
// never sees, so it guarded nothing. What it did do: every drag a deck started (an image, a link, selected text,
// a draggable card) was held and never continued, and Blink, which stops handling input while a drag it started
// is in progress (WebFrameWidgetImpl doing_drag_and_drop_), then ignored every key and click on the deck until a
// reload. This spec drags with CDP mouse events, which Chromium turns into a real drag when interception is off.

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Scratch, launchApp, resolveRunAs, sleep, type BlApp } from '../helpers/app';

test.describe.configure({ mode: 'serial' });

const scratch = new Scratch(resolveRunAs());
test.afterAll(() => scratch.cleanup());

// A 40×40 red PNG: images are draggable by default, the commonest drag a reader starts by accident.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAIAAAADnC86AAAAL0lEQVR42u3NMQ0AAAgDsMmZfz2IwQQJT5P+zbQvIhaLxWKxWCwWi8VisVgsFt9ZIvNTakVhXpMAAAAASUVORK5CYII=';

const DECK = `<!doctype html><html><head><meta charset="utf-8"><title>Drag inside</title>
<style>html,body{margin:0;height:100%;background:#fff}
#card{position:absolute;left:80px;top:80px;width:200px;height:100px;background:#fc8}
#zone{position:absolute;left:520px;top:80px;width:220px;height:260px;background:#8cf}
#pic{position:absolute;left:80px;top:260px;width:40px;height:40px}</style></head><body>
<div id="card" draggable="true">Card one</div><div id="zone">Drop here</div><img id="pic" alt="" src="data:image/png;base64,${PNG}">
<script>
window.__d = []; window.__k = [];
var card = document.getElementById('card'), zone = document.getElementById('zone');
card.addEventListener('dragstart', function (e) { e.dataTransfer.setData('text/plain', 'card-1'); __d.push('dragstart'); });
card.addEventListener('dragend', function () { __d.push('dragend'); });
document.getElementById('pic').addEventListener('dragend', function () { __d.push('pic-dragend'); });
zone.addEventListener('dragover', function (e) { e.preventDefault(); });
zone.addEventListener('drop', function (e) { e.preventDefault(); __d.push('drop:' + (e.dataTransfer.getData('text/plain') ? 'text' : 'none')); });
window.addEventListener('keydown', function (e) { __k.push(e.key); });
</script></body></html>`;

/** Drags with CDP mouse events from (x0, y) to (x1, y) on the deck view, then types two letters with trusted keys. */
async function dragThenType(app: BlApp, wcId: number, x0: number, x1: number, y: number): Promise<{ d: string[]; k: string[] }> {
  return app.electronApp.evaluate(
    async ({ webContents }, a) => {
      const wc = webContents.fromId(a.id)!;
      const dbg = wc.debugger;
      const attached = dbg.isAttached();
      if (!attached) dbg.attach('1.3');
      try {
        const m = (type: string, x: number, buttons: number, extra: Record<string, unknown> = {}) =>
          dbg.sendCommand('Input.dispatchMouseEvent', { type, x, y: a.y, button: 'left', buttons, ...extra });
        await m('mouseMoved', a.x0, 0, { button: 'none' });
        await m('mousePressed', a.x0, 1, { clickCount: 1 });
        for (let i = 1; i <= 10; i++) {
          await m('mouseMoved', Math.round(a.x0 + ((a.x1 - a.x0) * i) / 10), 1);
          await new Promise((r) => setTimeout(r, 30));
        }
        await m('mouseReleased', a.x1, 0, { clickCount: 1 });
      } finally {
        if (!attached) dbg.detach();
      }
      await new Promise((r) => setTimeout(r, 500));
      wc.focus();
      for (const k of ['X', 'Y']) {
        wc.sendInputEvent({ type: 'keyDown', keyCode: k });
        wc.sendInputEvent({ type: 'char', keyCode: k.toLowerCase() });
        wc.sendInputEvent({ type: 'keyUp', keyCode: k });
      }
      await new Promise((r) => setTimeout(r, 600));
      return JSON.parse(await wc.executeJavaScript('JSON.stringify({ d: window.__d.splice(0), k: window.__k.splice(0) })')) as { d: string[]; k: string[] };
    },
    { id: wcId, x0, x1, y },
  );
}

for (const prot of [false, true]) {
  const label = prot ? 'Protected' : 'Trusted';
  test(`a drag the deck starts completes, and the deck still takes keys afterwards (${label})`, async () => {
    test.setTimeout(120_000);
    const dir = scratch.dir(`drag-inpage-${label.toLowerCase()}`);
    fs.writeFileSync(path.join(dir, 'deck.html'), DECK);
    scratch.own(dir);
    const app = await launchApp({ files: [path.join(dir, 'deck.html')], scratch, protected: prot });
    try {
      const deck = await app.waitForDeck('deck.html');
      const w = await app.win(deck.docId);
      expect(w.trust).toBe(prot ? 'protected' : 'trusted');
      await sleep(800);
      const card = (await deck.rect('#card'))!;
      const zone = (await deck.rect('#zone'))!;
      const pic = (await deck.rect('#pic'))!;
      // A draggable card dropped on the zone: the page's own drag and drop runs to the end.
      const one = await dragThenType(app, w.deckWebContentsId, Math.round(card.x + 60), Math.round(zone.x + 100), Math.round(card.y + 50));
      expect(one.d).toEqual(['dragstart', 'drop:text', 'dragend']);
      expect(one.k, 'the deck took no keys after a drag it started').toEqual(['x', 'y']);
      // An image dragged off (no drop target): the drag ends, and the deck still takes keys.
      const two = await dragThenType(app, w.deckWebContentsId, Math.round(pic.x + 20), Math.round(pic.x + 300), Math.round(pic.y + 20));
      expect(two.d).toEqual(['pic-dragend']);
      expect(two.k, 'the deck took no keys after an image drag').toEqual(['x', 'y']);
    } finally {
      await app.close();
    }
  });
}
