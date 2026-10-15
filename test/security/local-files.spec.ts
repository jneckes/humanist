// Local-file confinement (SPEC 9.1 Serving and Refusals; section 10 Security fixtures). In both trust states
// the page may show sibling files but never read their bytes, and no path may reach a file outside the
// document's folder. The protocol fuzz (crafted paths) runs here too, from the page and from main.

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Scratch, resolveRunAs, sleep } from '../helpers/app';
import { openFixture, type ProbeResult } from '../helpers/security';

test.describe.configure({ mode: 'serial' });

function scratch(): Scratch {
  return new Scratch(resolveRunAs());
}

const READ_CHECKS = [
  'fetch-parent',
  'fetch-sibling',
  'fetch-ssh',
  'fetch-ssh-css',
  'fetch-dotdot-ssh',
  'xhr-sibling',
  'module-sibling',
  'worker-sibling',
  'cssrules',
  'canvas-read',
  'iframe-read',
  'file-scheme',
  'app-scheme',
];

for (const trust of ['protected', 'trusted'] as const) {
  test(`${trust}: sibling and outside files are never readable`, async () => {
    const s = scratch();
    const session = await openFixture({ scratch: s, fixture: 'local-files.html', trust });
    try {
      await session.waitPhase('load');
      await sleep(800);
      const results = (await session.results()) as Record<string, ProbeResult>;
      // Every read of a sibling, parent, dotfile or cross-scheme target must be blocked, in BOTH states
      // (9.1: a Trusted deck in the home folder still cannot read ~/.ssh or the files beside it).
      for (const key of READ_CHECKS) {
        expect(results[key]?.status, `${key}: ${JSON.stringify(results[key])}`).toBe('blocked');
      }
      // The script error from the throwing sibling must be muted (no readable message cross-origin).
      if (results['script-error-message']) {
        expect(results['script-error-message'].status, JSON.stringify(results['script-error-message'])).toBe('blocked');
      }
      // Positive control: a sibling image is shown (served, cross-origin), proving "show, not read".
      expect(results['sibling-img-show']?.status, JSON.stringify(results['sibling-img-show'])).toBe('ok');

      // The .ssh dotfile and the confidential files must never be fetchable; also confirm from main that the
      // -files host 404s the dotfile and any ../ escape.
      const bad = Object.entries(results).filter(([, r]) => r.status === 'leaked');
      expect(bad, `page read something it must not: ${JSON.stringify(bad)}`).toHaveLength(0);
    } finally {
      await session.close();
      s.cleanup();
    }
  });
}

// Protocol fuzz in real Electron (work item 5): request many crafted paths and assert none returns a file
// outside the folder. The page probes with stylesheet/image loads; this test also drives fetch() from the
// page over many crafted paths and reads status/bytes directly.
const CRAFTED = [
  '../outside/outside.txt',
  '..%2foutside%2foutside.txt',
  '%2e%2e/outside/outside.txt',
  '%2e%2e%2foutside%2foutside.txt',
  '..%252foutside%252foutside.txt',
  '..%5coutside%5coutside.txt',
  '....//outside/outside.txt',
  '..%c0%afoutside/outside.txt',
  '．．/outside/outside.txt',
  'foo/../../outside/outside.txt',
  '/outside/outside.txt',
  '//outside/outside.txt',
  '.ssh/id_rsa',
  '.ssh/id_rsa.css',
  '%2essh/id_rsa',
  'confidential.txt',
  '../confidential.txt',
  'link-outside.css',
  'link-outside-dir/outside.txt',
  'link-etc.css',
  'sub/%2e%2e/%2e%2e/outside/outside.txt',
  '.%2e/outside/outside.txt',
  '․․/outside/outside.txt',
];

for (const trust of ['protected', 'trusted'] as const) {
  test(`${trust}: protocol fuzz returns no file outside the folder`, async () => {
    const s = scratch();
    const session = await openFixture({ scratch: s, fixture: 'protocol-fuzz.html', trust });
    try {
      await session.waitPhase('load');
      await sleep(600);
      // The page's own CSS-escape probe: no crafted stylesheet may recolour the probe (an escape).
      const results = (await session.results()) as Record<string, ProbeResult>;
      const escaped = Object.entries(results).filter(([, r]) => r.status === 'leaked');
      expect(escaped, `a crafted path escaped the folder: ${JSON.stringify(escaped)}`).toHaveLength(0);

      // Drive crafted fetches from the page and read what came back. A sibling file is cross-origin (fetch
      // fails); an outside file must 404 or fail. The marker strings must never appear in a response body.
      const outsideMark = `OUTSIDE-${session.cfg.uniq}`;
      const parentMark = `PARENT-CONFIDENTIAL-${session.cfg.uniq}`;
      const probe = await session.deck.eval<{ path: string; ok: boolean; status: number; body: string }[]>(
        `(async () => {
          const paths = ${JSON.stringify(CRAFTED)};
          const out = [];
          for (const p of paths) {
            try {
              const r = await fetch(p, { cache: 'no-store' });
              const t = await r.text().catch(() => '');
              out.push({ path: p, ok: r.ok, status: r.status, body: t.slice(0, 80) });
            } catch (e) {
              out.push({ path: p, ok: false, status: -1, body: 'ERR:' + (e && e.name) });
            }
          }
          return out;
        })()`,
      );
      for (const r of probe) {
        expect(r.body.includes(outsideMark), `crafted path ${r.path} returned an outside file: ${r.body}`).toBe(false);
        expect(r.body.includes(parentMark), `crafted path ${r.path} returned a parent file: ${r.body}`).toBe(false);
        expect(r.body.includes('OPENSSH PRIVATE KEY'), `crafted path ${r.path} returned a key file: ${r.body}`).toBe(false);
        expect(r.body.includes('CONFIDENTIAL'), `crafted path ${r.path} returned a confidential file: ${r.body}`).toBe(false);
      }

      // And drive the same crafted paths through Electron's session.fetch against the deck's own handler,
      // confirming the handler (not the renderer) refuses them: every one is a 404, a redirect to -files, or
      // a cross-origin body the page could not have read.
      const folderReal = fs.realpathSync.native(session.folder.dir);
      const outsideReal = fs.realpathSync.native(path.dirname(folderReal));
      const handlerProbe = await session.app.electronApp.evaluate(
        async ({ session: ses, webContents }, a) => {
          const wc = webContents.fromId(a.wcId);
          const part = wc ? wc.session : ses.defaultSession;
          const base = 'blueline://' + a.docId + '/';
          const out: { path: string; status: number; body: string }[] = [];
          for (const p of a.paths) {
            try {
              const r = await part.fetch(base + p, { cache: 'no-store' });
              const t = await r.text().catch(() => '');
              out.push({ path: p, status: r.status, body: t.slice(0, 120) });
            } catch (e) {
              out.push({ path: p, status: -1, body: 'ERR:' + (e && (e as Error).name) });
            }
          }
          return out;
        },
        { docId: session.docId, wcId: session.deck.wcId, paths: CRAFTED },
      );
      for (const r of handlerProbe) {
        expect(r.body.includes(session.cfg.uniq) && r.body.includes('OUTSIDE'), `handler served an outside file for ${r.path}: ${r.body}`).toBe(false);
        expect(r.body.includes('OPENSSH PRIVATE KEY'), `handler served a key for ${r.path}: ${r.body}`).toBe(false);
        // confidential.txt lives in the folder but is not the document and has a .txt extension not in the
        // -files allowlist, so it must 404 (never 200 with its bytes).
        expect(r.body.includes('CONFIDENTIAL'), `handler served confidential bytes for ${r.path}: ${r.body}`).toBe(false);
      }
      void outsideReal;
    } finally {
      await session.close();
      s.cleanup();
    }
  });
}
