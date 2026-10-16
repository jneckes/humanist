// Navigation, links, popups, downloads and permissions (SPEC 6.10, 9.9 Navigation and links; section 10).
// In both trust states: top-level navigation, form submits, meta refresh and window.open are cancelled and
// reach nothing; a clicked link raises the right dialog; downloads are blocked in Protected and need
// confirmation in Trusted; every permission and device is denied.
//
// Every assertion has a positive control (9.9; fixtures/security/README.md): the page records that each
// attempt ran, main logs the navigation it cancelled, the same attempt reaches the test host where the
// policy allows it (Trusted), or the test loosens one handler in main and shows that the leak would be seen.

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Scratch, resolveRunAs, sleep, type BlApp, type DownloadRecord } from '../helpers/app';
import { openFixture, type ProbeResult, type SecuritySession } from '../helpers/security';

test.describe.configure({ mode: 'serial' });

function scratch(): Scratch {
  return new Scratch(resolveRunAs());
}

/** The "This page tried to leave the document" bar (9.9; window.ts BANNER_LEFT). */
const BANNER_LEFT = 'This page tried to leave the document';

/** The unclicked navigations navigation.html tries at load (each records its own result). */
const SCRIPTED = [
  'location-assign',
  'location-href',
  'location-replace',
  'window-open',
  'window-open-noopener',
  'form-top',
  'form-self',
  'reload',
  'synthetic-click',
  'custom-scheme',
];

/** Of those, the ones main reports as a cancelled navigation (test builds log `navigation blocked (…): <url>`). */
const LOGGED_BLOCKED = ['location-assign', 'location-href', 'location-replace', 'window-open', 'window-open-noopener', 'synthetic-click', 'custom-scheme'];

/** A test host URL for one check of this run (the probe runtime's __bl.url, from the suite's side). */
function hostUrl(session: SecuritySession, name: string): string {
  const c = session.cfg;
  return `http://${name}.${c.uniq}.${c.zone}:${c.port}/${c.uniq}/${name}`;
}

/** Polls the page's results until every name is recorded. */
async function waitResults(session: SecuritySession, names: string[], timeout = 15_000): Promise<Record<string, ProbeResult>> {
  const cond = names.map((n) => `window.__bl.results[${JSON.stringify(n)}]`).join(' && ');
  await session.deck.waitFor(`window.__bl && window.__bl.results && ${cond}`, timeout).catch(() => undefined);
  return (await session.results()) as Record<string, ProbeResult>;
}

for (const trust of ['protected', 'trusted'] as const) {
  test(`${trust}: scripted navigation and popups reach nothing and leave the document in place`, async () => {
    const s = scratch();
    const session = await openFixture({ scratch: s, fixture: 'navigation.html', trust });
    try {
      await session.waitPhase('load');
      await sleep(800);
      const results = (await session.results()) as Record<string, ProbeResult>;
      // Positive control: every attempt ran (the page recorded it) ...
      for (const name of SCRIPTED) expect(results[name], `the page never tried ${name}: ${JSON.stringify(results)}`).toBeTruthy();
      // ... and main saw and cancelled the navigations (so "nothing reached the server" is not a dead page).
      const blocked = session.app.logsMatching(/navigation blocked/).join('\n');
      for (const name of LOGGED_BLOCKED) {
        expect(blocked, `main did not report cancelling ${name}; logs:\n${blocked}`).toContain(`${name}.${session.cfg.uniq}`);
      }
      expect((await session.app.win(session.docId)).state.banner, 'the "tried to leave the document" bar is shown').toBe(BANNER_LEFT);
      // The document did not go anywhere.
      expect(results['still-here']?.status, JSON.stringify(results['still-here'])).toBe('ok');
      // window.open returned null (popup denied).
      expect(results['window-open']?.status, JSON.stringify(results['window-open'])).toBe('blocked');
      // The deck is still at its blueline:// URL.
      expect(await session.deck.url()).toContain(`blueline://${session.docId}/`);
      // Nothing reached the test server or its DNS (every nav target was on the attacker host).
      const sum = session.summary();
      expect(sum.http, `http: ${JSON.stringify(sum.http)}`).toHaveLength(0);
      if (session.dnsRouting.observable) {
        // Scripted navigations are top-level and cancelled before any lookup; none of their names resolves.
        const navNames = sum.dns.filter((q) => /location-|window-open|form-top|form-self|synthetic-click|custom-scheme/.test(q.name));
        expect(navNames, `a scripted navigation leaked DNS: ${JSON.stringify(navNames.map((q) => q.name))}`).toHaveLength(0);
      }
      // main showed no external-open and opened no extra window on its own.
      const h = await session.app.harness();
      expect(h.external, `nothing should have been opened externally: ${JSON.stringify(h.external)}`).toHaveLength(0);

      if (trust === 'trusted') {
        // Positive control for the server and DNS checks above: a fetch the Trusted policy allows, to the same
        // test host under this run's label, arrives (and its name is looked up where DNS is observable).
        await session.deck.eval(`fetch(${JSON.stringify(hostUrl(session, 'nav-control'))}).then(function(){return 1},function(){return 0})`);
        await sleep(500);
        const ctl = session.summary();
        expect(ctl.http.filter((r) => r.url.includes('/nav-control')), `the control fetch did not arrive: ${JSON.stringify(ctl.http)}`).toHaveLength(1);
        if (session.dnsRouting.observable) expect(ctl.dns.some((q) => q.name.includes('nav-control'))).toBe(true);
      }
    } finally {
      await session.close();
      s.cleanup();
    }
  });

  test(`${trust}: a clicked external link shows a confirm dialog and opens nothing until confirmed`, async () => {
    const s = scratch();
    const session = await openFixture({ scratch: s, fixture: 'navigation.html', trust });
    try {
      await session.waitPhase('load');
      await session.deck.clickSelector('#link-http');
      await sleep(600);
      const h = await session.app.harness();
      // 9.9: a clicked http link opens in the browser after a dialog that shows the full URL. The harness
      // answers the dialog Cancel, so shell.openExternal is never called, but the dialog must have shown the URL.
      const dlg = h.dialogs.find((d) => (d.detail ?? '').includes('clicked-http'));
      expect(dlg, `expected a confirm dialog showing the clicked URL; dialogs: ${JSON.stringify(h.dialogs)}`).toBeTruthy();
      expect(h.external, `openExternal must wait for confirmation: ${JSON.stringify(h.external)}`).toHaveLength(0);
      // Nothing reached the server (the URL was never actually opened, and the deck did not navigate).
      expect(session.summary().http).toHaveLength(0);
      expect(await session.deck.url()).toContain('blueline://');

      // Positive control for "openExternal must wait": once the dialog is confirmed ("Open in Browser"), the
      // openExternal spy records the URL, so a call without confirmation would have been seen.
      await sleep(1200); // past the link tracker's de-duplication window
      await session.app.answerDialogs(0);
      await session.deck.clickSelector('#link-http');
      await sleep(800);
      const h2 = await session.app.harness();
      expect(h2.external.filter((x) => x.startsWith('external:http://clicked-http.')), `a confirmed link was not opened: ${JSON.stringify(h2)}`).toHaveLength(1);
      // Opening is the system browser's job (stubbed here): Blueline itself still fetched nothing.
      expect(session.summary().http).toHaveLength(0);
    } finally {
      await session.close();
      s.cleanup();
    }
  });

  test(`${trust}: a clicked local .html link opens a new Blueline window`, async () => {
    const s = scratch();
    const session = await openFixture({ scratch: s, fixture: 'navigation.html', trust });
    try {
      await session.waitPhase('load');
      const before = (await session.app.windows()).length;
      await session.deck.clickSelector('#link-local');
      // The sibling page opens in its own window (its own doc, map and trust state).
      const sibling = await session.app.waitForDeck('sibling-page.html', { exclude: [session.docId], timeout: 20_000 });
      const sw = await session.app.win(sibling.docId);
      expect(sw.trust, 'a local .html opened from a Protected deck opens Protected too').toBe(trust);
      expect((await session.app.windows()).length).toBeGreaterThanOrEqual(before + 1);
      // The opener deck did not itself navigate.
      expect(await session.deck.url()).toContain(`blueline://${session.docId}/`);
      expect(await sibling.eval('!!document.querySelector("[data-bl-sibling-page]")')).toBe(true);
    } finally {
      await session.close();
      s.cleanup();
    }
  });

  // Clicking the link both navigates (http → the external-link dialog) and fires the hyperlink-auditing ping
  // (a POST, resource type "ping"). Protected cancels the ping (connect-src 'none' and onBeforeRequest).
  // Trusted allows network subresources (9.9 Trusted; sendBeacon is the same `ping` type), so the ping arrives
  // there: that is the positive control for the Protected assertion. Neither state fetches the link's href.
  const pingTitle =
    trust === 'protected'
      ? 'protected: a clicked <a ping> sends nothing to the test host'
      : 'trusted: a clicked <a ping> reaches the test host (positive control for Protected), and its href is not fetched';
  test(pingTitle, async () => {
    const s = scratch();
    const session = await openFixture({ scratch: s, fixture: 'navigation.html', trust });
    try {
      await session.waitPhase('load');
      await session.deck.clickSelector('#link-ping');
      await sleep(1000);
      // The click ran: main showed the dialog for the link's href.
      const h = await session.app.harness();
      expect(h.dialogs.some((d) => (d.detail ?? '').includes('clicked-ping-href')), `the ping link click did not register: ${JSON.stringify(h.dialogs)}`).toBe(true);
      const pings = session.summary().http.filter((r) => r.url.includes('/a-ping/'));
      if (trust === 'protected') {
        expect(pings, `a <a ping> leaked in Protected: ${JSON.stringify(pings)}`).toHaveLength(0);
        if (session.dnsRouting.observable) {
          expect(session.summary().dns.filter((q) => q.name.includes('clicked-ping')), 'a ping DNS leak in Protected').toHaveLength(0);
        }
      } else {
        expect(pings.length, `the Trusted ping did not arrive (the Protected check would prove nothing): ${JSON.stringify(session.summary().http)}`).toBeGreaterThanOrEqual(1);
        expect(pings[0].method).toBe('POST');
        expect(pings[0].headers['ping-to'] ?? '').toContain('clicked-ping-href');
      }
      // The navigation to the link's href never reached the server either (it goes through the dialog).
      expect(session.summary().http.filter((r) => r.url.includes('ping-href')), 'the ping link navigated to the server').toHaveLength(0);
    } finally {
      await session.close();
      s.cleanup();
    }
  });

  test(`${trust}: a meta refresh to the test host is cancelled`, async () => {
    const s = scratch();
    const session = await openFixture({ scratch: s, fixture: 'navigation-refresh.html', trust });
    try {
      await session.waitPhase('load');
      await sleep(800);
      const results = (await session.results()) as Record<string, ProbeResult>;
      // Positive control: the refresh fired, and main cancelled it (test builds log the cancelled URL).
      const blocked = session.app.logsMatching(/navigation blocked/).join('\n');
      expect(blocked, `main never saw the meta refresh; logs:\n${blocked}`).toContain(`meta-refresh.${session.cfg.uniq}`);
      expect((await session.app.win(session.docId)).state.banner).toBe(BANNER_LEFT);
      expect(results['meta-refresh']?.status, JSON.stringify(results['meta-refresh'])).toBe('blocked');
      expect(session.summary().http, 'meta refresh reached the server').toHaveLength(0);
      expect(await session.deck.url()).toContain('navigation-refresh.html');
    } finally {
      await session.close();
      s.cleanup();
    }
  });
}

/** Files whose name contains `needle`, under `dir` (depth-limited; missing folders are empty). */
function findFiles(dir: string, needle: string, depth = 4): string[] {
  const out: string[] = [];
  const walk = (d: string, left: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.name.includes(needle)) out.push(p);
      if (e.isDirectory() && left > 0) walk(p, left - 1);
    }
  };
  walk(dir, depth);
  return out;
}

/** The error dialogs main showed (an uncaught exception in main reaches dialog.showErrorBox, which the harness records). */
async function mainErrors(app: BlApp): Promise<string[]> {
  return (await app.harness()).dialogs.filter((d) => d.kind === 'error').map((d) => `${d.message}: ${d.detail}`);
}

test('protected: a download is blocked', async () => {
  const s = scratch();
  const session = await openFixture({ scratch: s, fixture: 'download.html', trust: 'protected' });
  try {
    await session.waitPhase('load');
    await session.deck.clickSelector('#blob-download');
    await session.deck.clickSelector('#data-download');
    await session.deck.clickSelector('#remote-download');
    await sleep(800);
    const h = await session.app.harness();
    // Positive control: the clicks did start downloads (will-download fired for the blob: and data: links;
    // the cross-origin http link goes through the external-link dialog instead).
    expect(h.downloads.length, `no download started, so nothing was checked: ${JSON.stringify(h)}`).toBeGreaterThanOrEqual(1);
    expect(h.downloads.some((d) => d.url.startsWith('blob:')), JSON.stringify(h.downloads)).toBe(true);
    // 9.9: will-download is cancelled in Protected view. Every item was event-prevented, ended cancelled, and
    // was never given a place to save to.
    for (const d of h.downloads as DownloadRecord[]) {
      expect(d.prevented, `download not prevented in Protected: ${JSON.stringify(d)}`).toBe(true);
      expect(d.done, `download not cancelled in Protected: ${JSON.stringify(d)}`).toBe('cancelled');
      expect(d.setSavePath ?? [], `a save path was set in Protected: ${JSON.stringify(d)}`).toHaveLength(0);
      expect(d.savePathAtStart ?? '', `a file was saved in Protected: ${JSON.stringify(d)}`).toBe('');
    }
    // No exception in main (the harness reads destroyed items safely; finding 46).
    expect(await mainErrors(session.app), 'main showed an error dialog').toHaveLength(0);
  } finally {
    await session.close();
    s.cleanup();
  }
});

test('trusted: a download waits for a save dialog, and nothing is saved without it', async () => {
  const s = scratch();
  // A private TMPDIR, so a file saved there would be this run's (and found).
  const tmp = s.dir('tmp');
  const session = await openFixture({ scratch: s, fixture: 'download.html', trust: 'trusted', env: { TMPDIR: tmp } });
  try {
    await session.waitPhase('load');
    await session.deck.clickSelector('#blob-download');
    await sleep(800);
    const h = await session.app.harness();
    // Positive control: the download started.
    const d = (h.downloads as DownloadRecord[]).find((x) => x.filename === 'bl-blob.bin');
    expect(d, `a download should have started in Trusted: ${JSON.stringify(h.downloads)}`).toBeTruthy();
    if (!d) return;
    // 9.9 / 6.10: a Trusted download is not cancelled; it waits for the user to choose a place in the save
    // dialog. No save path is set, the item is still in progress (not completed), and the dialog has options.
    expect(d.prevented, `Trusted download should not be event-prevented: ${JSON.stringify(d)}`).toBe(false);
    expect(d.setSavePath ?? [], `a save path was set without the user: ${JSON.stringify(d)}`).toHaveLength(0);
    expect(d.savePath, `the download has a save path without confirmation: ${JSON.stringify(d)}`).toBe('');
    expect(d.stateAfter, `the download did not wait for the save dialog: ${JSON.stringify(d)}`).toBe('progressing');
    expect(d.dialogTitle, `no save dialog options were set: ${JSON.stringify(d)}`).toBeTruthy();
    // Nothing named after the download appeared where Electron or the app would put it.
    const p = await session.app.paths();
    const dirs = [...new Set([session.app.info.home, session.app.info.tmpDir, p.home, p.downloads, p.temp])];
    const found = dirs.flatMap((dir) => findFiles(dir, 'bl-blob'));
    expect(found, `a downloaded file appeared without confirmation (searched ${dirs.join(', ')})`).toHaveLength(0);
    expect(await mainErrors(session.app), 'main showed an error dialog').toHaveLength(0);
    await session.app.cancelDownloads();
  } finally {
    await session.close();
    s.cleanup();
  }
});

for (const trust of ['protected', 'trusted'] as const) {
  test(`${trust}: camera, microphone, location and other permissions are refused by the handler (a permissive handler is the positive control)`, async () => {
    const s = scratch();
    // A fake camera and microphone, so getUserMedia reaches the permission request handler (without devices
    // Chromium fails with NotFoundError first, finding 36). Never --use-fake-ui-for-media-stream: it bypasses
    // the handler and grants.
    const session = await openFixture({ scratch: s, fixture: 'permissions.html', trust, extraArgs: ['--use-fake-device-for-media-stream'] });
    try {
      await session.waitPhase('load', 20_000);
      const results = await waitResults(session, ['getUserMedia', 'geolocation', 'notifications', 'clipboard-read', 'query-camera', 'query-microphone', 'query-geolocation']);
      const granted = Object.entries(results).filter(([, r]) => r.status === 'leaked');
      expect(granted, `a permission was granted: ${JSON.stringify(granted)}`).toHaveLength(0);
      // Refused by the permission handler, not failed for another reason.
      expect(results.getUserMedia?.status, JSON.stringify(results.getUserMedia)).toBe('blocked');
      expect(results.getUserMedia?.detail, 'getUserMedia must be refused by the handler (NotAllowedError)').toMatch(/^NotAllowedError\b/);
      expect(results.geolocation?.detail, 'geolocation must fail with PERMISSION_DENIED (code 1)').toMatch(/^code 1\b/);
      for (const k of ['notifications', 'clipboard-read', 'query-camera', 'query-microphone', 'query-geolocation']) {
        expect(results[k]?.status, `${k}: ${JSON.stringify(results[k])}`).toBe('blocked');
      }

      // Positive control: replace the deck partition's request handler with one that grants media and
      // geolocation, and rerun the same calls. A stream comes back, and geolocation fails for lack of a
      // provider (code 2) instead of permission (code 1), so the checks above would see such a grant.
      await session.app.electronApp.evaluate(({ webContents }, id) => {
        const wc = webContents.fromId(id);
        if (!wc) throw new Error('no deck');
        wc.session.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'media' || permission === 'geolocation'));
      }, session.deck.wcId);
      await session.deck.eval('window.__blRunPermissions("control-")');
      const ctl = await waitResults(session, ['control-getUserMedia', 'control-geolocation']);
      expect(ctl['control-getUserMedia']?.status, `the permissive handler did not give a stream: ${JSON.stringify(ctl['control-getUserMedia'])}`).toBe('leaked');
      const geo = ctl['control-geolocation'];
      expect(geo, 'the control geolocation call did not finish').toBeTruthy();
      expect(geo?.status === 'leaked' || /^code [23]\b/.test(geo?.detail ?? ''), `a granted geolocation should not fail with code 1: ${JSON.stringify(geo)}`).toBe(true);
    } finally {
      await session.close();
      s.cleanup();
    }
  });

  test(`${trust}: device choosers are reached after a real click and refused with no device`, async () => {
    const s = scratch();
    const session = await openFixture({ scratch: s, fixture: 'permissions.html', trust });
    try {
      await session.waitPhase('load', 20_000);
      const results0 = (await session.results()) as Record<string, ProbeResult>;
      // HID, serial and USB must exist in this build (a missing API is a failure, not a pass).
      for (const api of ['hid', 'serial', 'usb']) {
        expect(results0[`api-${api}`]?.status, `navigator.${api} is missing, so its chooser cannot be checked`).toBe('ok');
      }
      const bluetooth = results0['api-bluetooth']?.status === 'ok';
      test.info().annotations.push({
        type: 'bluetooth',
        description: bluetooth
          ? 'navigator.bluetooth exists: requestDevice is called after the click'
          : 'navigator.bluetooth is undefined in this build: the select-bluetooth-device handler is checked by a synthetic event only',
      });

      // 1. With the app's handlers: a real click calls every requestDevice; each is refused.
      await session.deck.clickSelector('#run-devices');
      await session.waitPhase('devices', 10_000);
      const results = await waitResults(session, ['hid', 'serial', 'usb']);
      for (const k of ['hid', 'serial', 'usb', ...(bluetooth ? ['bluetooth'] : [])]) {
        expect(results[k]?.status, `${k}: ${JSON.stringify(results[k])}`).toBe('blocked');
      }

      // 2. The app's permission check handler refuses HID, serial and USB before any chooser shows. To check
      // the chooser handlers themselves, let the check through (test only) and click again: each chooser
      // event must fire, be prevented, and choose no device (finding 37).
      const before = (await session.app.harness()).devices.length;
      await session.app.electronApp.evaluate(({ webContents }, id) => {
        const wc = webContents.fromId(id);
        if (!wc) throw new Error('no deck');
        wc.session.setPermissionCheckHandler(() => true);
      }, session.deck.wcId);
      await session.deck.clickSelector('#run-devices-chooser');
      await session.waitPhase('chooser', 10_000);
      const chosen = await waitResults(session, ['chooser-hid', 'chooser-serial', 'chooser-usb']);
      await sleep(300);
      const events = (await session.app.harness()).devices.slice(before);
      for (const ev of ['select-hid-device', 'select-serial-port', 'select-usb-device']) {
        const fired = events.filter((d) => d.event === ev);
        expect(fired.length, `${ev} never fired, so its handler was not checked: ${JSON.stringify(events)}`).toBeGreaterThanOrEqual(1);
        for (const d of fired) expect(d.prevented, `${ev} not prevented: ${JSON.stringify(d)}`).toBe(true);
      }
      // No device was chosen, even where one was offered (the container has a serial port): HID resolves
      // empty, serial and USB reject.
      for (const k of ['chooser-hid', 'chooser-serial', 'chooser-usb']) {
        expect(chosen[k]?.status, `${k}: ${JSON.stringify(chosen[k])}`).toBe('blocked');
      }

      // 3. Bluetooth: the API is absent in this build (and needs an adapter), so emit the chooser event the way
      // Electron does, with a device in the list, and check the app's handler: prevented, no device id.
      const bt = await session.app.electronApp.evaluate(({ webContents }, id) => {
        const wc = webContents.fromId(id);
        if (!wc) throw new Error('no deck');
        let prevented = false;
        const picked: unknown[] = [];
        const event = {
          preventDefault() {
            prevented = true;
          },
          get defaultPrevented() {
            return prevented;
          },
        };
        const listeners = wc.listenerCount('select-bluetooth-device');
        wc.emit('select-bluetooth-device', event, [{ deviceName: 'bl-fake', deviceId: 'bl-fake-device' }], (deviceId: unknown) => picked.push(deviceId));
        return { prevented, picked, listeners };
      }, session.deck.wcId);
      expect(bt.listeners, 'no select-bluetooth-device listener besides the harness').toBeGreaterThanOrEqual(2);
      expect(bt.prevented, `select-bluetooth-device was not prevented: ${JSON.stringify(bt)}`).toBe(true);
      expect(bt.picked.filter((x) => typeof x === 'string' && x !== ''), `a Bluetooth device was chosen: ${JSON.stringify(bt)}`).toHaveLength(0);
    } finally {
      await session.close();
      s.cleanup();
    }
  });
}
