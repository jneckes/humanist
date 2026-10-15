// Phase 0 E2E: CSP fixtures (SPEC section 10 "Scripts: every CSP fixture runs its own scripts and shows the
// overlay"; 9.1 Preload: the page's CSP applies to the isolated world, so the overlay must mount and add no
// violation). Each CSP fixture runs its own scripts (dataset.scriptsRan === 'yes') and shows the overlay,
// and the only CSP violation is the deck's own expected one — never one the overlay caused.

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FIXTURES, Scratch, copyInto, resolveRunAs, sleep } from '../helpers/app';
import { launchApp } from '../helpers/app';

test.describe.configure({ mode: 'serial' });

function scratch(): Scratch {
  return new Scratch(resolveRunAs());
}

interface CspExpect {
  csp: { scriptsRan: string; cspViolations?: string };
}

// The three CSP fixtures (SPEC section 10 CSP fixtures), with the deck's own expected violations, from each
// .expect.json. Anything observed that is not one of these would be a violation the overlay caused (9.1).
// csp-self-inline: the sibling script is blocked; Chromium names the redirected cross-origin URL by scheme
// ('blueline'). csp-nonce: the un-nonced inline script. csp-default-none: the data: image.
const CSP_FIXTURES: { name: string; allowed: string[] }[] = [
  { name: 'csp-self-inline.html', allowed: ['script-src-elem blueline', 'script-src-elem '] },
  { name: 'csp-nonce-strict-dynamic.html', allowed: ['script-src-elem inline'] },
  { name: 'csp-default-none.html', allowed: ['img-src data'] },
];

for (const { name, allowed } of CSP_FIXTURES) {
  test(`${name}: runs its own scripts and shows the overlay with no overlay-caused CSP violation`, async () => {
    const s = scratch();
    const dir = s.dir('deck');
    const base = name.replace(/\.html$/, '');
    // Copy the fixture and its sibling script, if any (csp-self-inline.js, csp-nonce-strict-dynamic.js).
    copyInto(path.join(FIXTURES, 'decks', name), dir);
    const siblingJs = path.join(FIXTURES, 'decks', `${base}.js`);
    if (fs.existsSync(siblingJs)) copyInto(siblingJs, dir);
    s.own(dir);
    const expectJson = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'decks', `${base}.expect.json`), 'utf8')) as CspExpect;

    const app = await launchApp({ files: [path.join(dir, name)], scratch: s });
    try {
      const deck = await app.waitForDeck(name);
      await sleep(600); // let the deck's scripts and the overlay settle

      // The deck's own scripts ran, under its own CSP (stamps and the served copy do not change the CSP).
      expect(await deck.eval<string>('document.documentElement.dataset.scriptsRan || ""'), `${name} scripts did not run`).toBe('yes');

      // The overlay mounted (a closed shadow host on <html>), built with constructable stylesheets and CSSOM
      // only, so even default-src 'none' does not block it.
      const overlay = await deck.eval<{ present: boolean; closed: boolean }>(
        `(function(){ var h = document.querySelector('blueline-overlay'); return { present: !!h, closed: !!h && h.shadowRoot === null }; })()`,
      );
      expect(overlay.present, `${name}: overlay host missing`).toBe(true);
      expect(overlay.closed, `${name}: overlay shadow should be closed`).toBe(true);

      // The only CSP violations are the deck's own expected ones; the overlay must add none (9.1 Preload).
      void expectJson;
      const violations = (await deck.eval<string>('document.documentElement.dataset.cspViolations || ""')).split(' | ').filter(Boolean);
      for (const v of violations) {
        const ok = allowed.some((a) => v === a || v.startsWith(a));
        expect(ok, `${name}: unexpected CSP violation (overlay-caused?): ${JSON.stringify(v)}; allowed: ${JSON.stringify(allowed)}`).toBe(true);
      }
    } finally {
      await app.close();
      s.cleanup();
    }
  });
}
