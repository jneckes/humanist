// Local-file confinement (SPEC 9.1 Serving and Refusals; section 10 Security fixtures). In both trust states
// the page may show sibling files, media included, but never read their bytes, and no path may reach a file
// outside the document's folder. The protocol fuzz (crafted paths) runs here too, from the page and from main.

import { expect, test } from '@playwright/test';
import { Scratch, resolveRunAs, sleep } from '../helpers/app';
import { openFixture, outsideMarker, type ProbeResult } from '../helpers/security';

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

// local-files.html, sibling media (finding 7).
const MEDIA_CONTROLS = ['canvas-control', 'webaudio-control'];
const MEDIA_PLAIN = ['webm', 'mp4', 'wav', 'ogg', 'mp3'].map((e) => `media-${e}-plain`);
const MEDIA_CORS = [
  ...['webm', 'mp4'].flatMap((e) => ['rel', 'files', 'media', 'credentials'].map((how) => `media-${e}-cors-${how}`)),
  ...['wav', 'ogg', 'mp3'].flatMap((e) => ['rel', 'files', 'media'].map((how) => `media-${e}-cors-${how}`)),
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

      // Sibling media (finding 7): every crossorigin (CORS-mode) load fails, whichever URL it uses, while the
      // plain loads play with a tainted canvas and silent Web Audio output (the positive control that the
      // files are served and shown). The controls prove the canvas and analyser reads work at all, so a
      // "tainted" or "silent" result means the browser withheld the content.
      await session.waitPhase('media', 20_000);
      const media = (await session.results()) as Record<string, ProbeResult>;
      for (const key of MEDIA_CONTROLS) expect(media[key]?.status, `${key}: ${JSON.stringify(media[key])}`).toBe('ok');
      for (const key of MEDIA_PLAIN) expect(media[key]?.status, `${key} should play and stay unreadable: ${JSON.stringify(media[key])}`).toBe('ok');
      for (const key of MEDIA_CORS) expect(media[key]?.status, `${key} must not load: ${JSON.stringify(media[key])}`).toBe('blocked');
      expect(media['fetch-media-scheme']?.status, JSON.stringify(media['fetch-media-scheme'])).toBe('blocked');
      const mediaLeaks = Object.entries(media).filter(([, r]) => r.status === 'leaked');
      expect(mediaLeaks, `page read sibling media: ${JSON.stringify(mediaLeaks)}`).toHaveLength(0);

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

// Protocol fuzz in real Electron (work item 5; 9.1 Refusals). The crafted paths aim at outside/, whose files
// have extensions the -files host serves and carry OUTSIDE-<label> in their bytes (test/helpers/security.ts),
// so an escape would be served and recognised rather than refused for its extension (finding 42). The page
// loads them as stylesheets (protocol-fuzz.html: an outside.css that applied would recolour a probe, with an
// in-folder stylesheet as the positive control), and main requests every one through the deck partition's
// own handler with session.fetch and reads status and bytes.
const CRAFTED = [
  '../outside/outside.css',
  '..%2foutside%2foutside.css',
  '%2e%2e/outside/outside.css',
  '%2e%2e%2foutside%2foutside.css',
  '..%252foutside%252foutside.css',
  '..%5coutside%5coutside.css',
  '%2e%2e%5coutside%5coutside.css',
  '....//outside/outside.css',
  '..%c0%afoutside/outside.css',
  '．．/outside/outside.css',
  '․․/outside/outside.css',
  '.%2e/outside/outside.css',
  'foo/../../outside/outside.css',
  'sub/%2e%2e/%2e%2e/outside/outside.css',
  '/outside/outside.css',
  '//outside/outside.css',
  '../outside/outside.js',
  '../outside/outside.png',
  '../outside/outside.txt',
  '.ssh/id_rsa',
  '.ssh/id_rsa.css',
  '%2essh/id_rsa.css',
  'confidential.txt',
  '../confidential.txt',
  'link-outside.css',
  'link-outside-dir/outside.css',
  'link-outside-dir/outside.js',
  'link-etc.css',
];
// Media paths are not fetched here: the handler sends them to blueline-media://, which onBeforeRequest
// opens to media elements only ('media-only'), so a main-process fetch of one is cancelled whatever the
// path. Their confinement is the same resolveConfined, covered with real folders in protocol.test.ts.
// In-folder paths the handler must serve (status 200): the positive control that session.fetch reaches the
// handler and that a 404 above is a refusal, not a broken probe.
const IN_FOLDER = ['sibling.css', '%73ibling.css', 'sub/%2e%2e/sibling.css', 'sibling.png'];

for (const trust of ['protected', 'trusted'] as const) {
  test(`${trust}: protocol fuzz returns no file outside the folder`, async () => {
    const s = scratch();
    const session = await openFixture({ scratch: s, fixture: 'protocol-fuzz.html', trust });
    try {
      await session.waitPhase('load');
      await sleep(600);
      const results = (await session.results()) as Record<string, ProbeResult>;
      // Positive controls: an in-folder stylesheet applies, also through a crafted in-folder path, so the
      // stylesheet probe can see a crafted path that resolves.
      for (const key of ['css-control', 'css-control-dotdot']) {
        expect(results[key]?.status, `${key}: ${JSON.stringify(results[key])}`).toBe('ok');
      }
      // No crafted stylesheet may recolour the outside probe (an escape).
      const escaped = Object.entries(results).filter(([, r]) => r.status === 'leaked');
      expect(escaped, `a crafted path escaped the folder: ${JSON.stringify(escaped)}`).toHaveLength(0);

      // The handler itself, through Electron's session.fetch on the deck partition (redirects followed):
      // every crafted path is a bare 404; every in-folder control is a 200 with its own bytes.
      const mark = outsideMarker(session.cfg.uniq);
      const handlerProbe = await session.app.electronApp.evaluate(
        async ({ webContents }, a) => {
          const wc = webContents.fromId(a.wcId);
          if (!wc) throw new Error('no deck webContents');
          const base = 'blueline://' + a.docId + '/';
          const out: { path: string; status: number; url: string; body: string }[] = [];
          for (const p of a.paths) {
            try {
              const r = await wc.session.fetch(base + p, { cache: 'no-store' });
              const t = await r.text().catch(() => '');
              out.push({ path: p, status: r.status, url: r.url, body: t.slice(0, 200) });
            } catch (e) {
              out.push({ path: p, status: -1, url: '', body: 'ERR:' + (e && (e as Error).message) });
            }
          }
          return out;
        },
        { docId: session.docId, wcId: session.deck.wcId, paths: [...CRAFTED, ...IN_FOLDER] },
      );
      for (const r of handlerProbe) {
        expect(r.body.includes(mark), `handler served an outside file for ${r.path}: ${JSON.stringify(r)}`).toBe(false);
        expect(r.body.includes('OPENSSH PRIVATE KEY'), `handler served a key for ${r.path}`).toBe(false);
        expect(r.body.includes('CONFIDENTIAL'), `handler served confidential bytes for ${r.path}`).toBe(false);
        if (IN_FOLDER.includes(r.path)) expect(r.status, `in-folder control ${r.path}: ${JSON.stringify(r)}`).toBe(200);
        else expect(r.status, `crafted path ${r.path} must be refused: ${JSON.stringify(r)}`).toBe(404);
      }
      const css = handlerProbe.find((r) => r.path === 'sibling.css');
      expect(css?.body, 'the in-folder control returns its own bytes').toContain('#bl-sibling-css-probe');
    } finally {
      await session.close();
      s.cleanup();
    }
  });
}
