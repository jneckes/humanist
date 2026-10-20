// Phase 0 E2E: the reader shell and deck view (SPEC section 10; 6.2; 9.1). Open a fixture and check the deck
// renders from blueline://<docId>/ with data-bl-e stamps and the overlay mounted; mode switching works with
// Cmd/Ctrl+1/2/3 even on a deck that preventDefault()s every key.

import { expect, test } from '@playwright/test';
import * as path from 'node:path';
import { EDIT_BUILD, FIXTURES, Scratch, copyInto, resolveRunAs, sleep } from '../helpers/app';
import { launchApp } from '../helpers/app';

test.describe.configure({ mode: 'serial' });

function scratch(): Scratch {
  return new Scratch(resolveRunAs());
}

test('a fixture renders from blueline:// with data-bl-e stamps and the overlay mounted', async () => {
  const s = scratch();
  const dir = s.dir('deck');
  const file = copyInto(path.join(FIXTURES, 'decks/generic-index.html'), dir);
  s.own(dir);
  const app = await launchApp({ files: [file], scratch: s });
  try {
    const deck = await app.waitForDeck('generic-index.html');
    // The document loads at blueline://<docId>/<name>.
    const w = await app.win(deck.docId);
    expect(w.trust, 'a local file with no marker opens Trusted').toBe('trusted');
    expect(await deck.url()).toBe(`blueline://${deck.docId}/generic-index.html`);

    // The served copy carries data-bl-e stamps (9.2 Strategy 1 step 3).
    const stamps = await deck.eval<number>('document.querySelectorAll("[data-bl-e]").length');
    expect(stamps, 'the served copy should stamp mapped elements').toBeGreaterThan(0);
    // Stamp format is bl-<n>.
    const sample = await deck.eval<string>('document.querySelector("[data-bl-e]").getAttribute("data-bl-e")');
    expect(sample).toMatch(/^bl-\d+$/);

    // The overlay host is mounted on documentElement, with a closed shadow root (9.1 Preload).
    const overlay = await deck.eval<{ present: boolean; closed: boolean; onHtml: boolean }>(
      `(function(){
        var h = document.querySelector('blueline-overlay');
        return { present: !!h, closed: !!h && h.shadowRoot === null, onHtml: !!h && h.parentElement === document.documentElement };
      })()`,
    );
    expect(overlay.present, 'the overlay host should be present').toBe(true);
    expect(overlay.closed, 'the overlay shadow root should be closed').toBe(true);
    expect(overlay.onHtml, 'the overlay host should hang off <html>').toBe(true);

    // The deck's own scripts ran (the fixture detected its slides).
    expect(await deck.eval<number>('document.querySelectorAll("[data-slide]").length')).toBeGreaterThan(0);
  } finally {
    await app.close();
    s.cleanup();
  }
});

test('Cmd/Ctrl+1/2/3 switch modes even on a deck that preventDefault()s every key', async () => {
  const s = scratch();
  const dir = s.dir('deck');
  const file = copyInto(path.join(FIXTURES, 'decks/keys-prevent-default.html'), dir);
  s.own(dir);
  const app = await launchApp({ files: [file], scratch: s });
  try {
    const deck = await app.waitForDeck('keys-prevent-default.html');
    const modeOf = async () => (await app.win(deck.docId)).appMode;
    expect(await modeOf()).toBe('read');

    // 6.2: main takes the app chords in before-input-event, so they work even though the page swallows keys.
    await deck.chord('2');
    await sleep(200);
    expect(await modeOf(), 'Cmd/Ctrl+2 should switch to Review').toBe('review');
    await deck.chord('3');
    await sleep(200);
    // A reader-only build refuses Edit (P2-15) and stays in Review; the chord still never reaches the page.
    if (EDIT_BUILD) expect(await modeOf(), 'Cmd/Ctrl+3 should switch to Edit').toBe('edit');
    else expect(await modeOf(), 'a reader-only build refuses Edit').toBe('review');
    await deck.chord('1');
    await sleep(200);
    expect(await modeOf(), 'Cmd/Ctrl+1 should switch to Read').toBe('read');

    // The app chords never reached the page (the page records every key it saw in data-page-keys).
    const pageKeys = await deck.eval<string>('document.documentElement.dataset.pageKeys || ""');
    for (const chord of ['Meta+1', 'Meta+2', 'Meta+3', 'Control+1', 'Control+2', 'Control+3']) {
      expect(pageKeys.includes(chord), `the page should not have seen ${chord}; saw: ${pageKeys}`).toBe(false);
    }
    // But an ordinary key does reach the page: in Read mode (now) every key goes to the deck (6.2 rule 4).
    await deck.key('ArrowRight');
    await sleep(150);
    expect(await deck.eval<string>('document.documentElement.dataset.pageKeys || ""'), 'an ordinary key should reach the page in Read').toContain('ArrowRight');
  } finally {
    await app.close();
    s.cleanup();
  }
});
