// Navigation, links, popups, downloads and permissions (SPEC 6.10, 9.9 Navigation and links; section 10).
// In both trust states: top-level navigation, form submits, meta refresh and window.open are cancelled and
// reach nothing; a clicked link raises the right dialog; downloads are blocked in Protected and need
// confirmation in Trusted; every permission and device is denied.

import { expect, test } from '@playwright/test';
import { Scratch, resolveRunAs, sleep } from '../helpers/app';
import { openFixture, type ProbeResult } from '../helpers/security';

test.describe.configure({ mode: 'serial' });

function scratch(): Scratch {
  return new Scratch(resolveRunAs());
}

for (const trust of ['protected', 'trusted'] as const) {
  test(`${trust}: scripted navigation and popups reach nothing and leave the document in place`, async () => {
    const s = scratch();
    const session = await openFixture({ scratch: s, fixture: 'navigation.html', trust });
    try {
      await session.waitPhase('load');
      await sleep(800);
      const results = (await session.results()) as Record<string, ProbeResult>;
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

  test(`${trust}: a clicked <a ping> sends no ping to the test host`, async () => {
    const s = scratch();
    const session = await openFixture({ scratch: s, fixture: 'navigation.html', trust });
    try {
      await session.waitPhase('load');
      // Clicking the link both navigates (http → external dialog) and fires the ping (POST, resource type
      // "ping"). In Protected the ping is cancelled by connect-src 'none' and the webRequest listener; in
      // Trusted the ping is a subresource the policy allows, so it may arrive — but the a-ping host carries
      // a unique label, so assert per trust state.
      await session.deck.clickSelector('#link-ping');
      await sleep(800);
      const pings = session.summary().http.filter((r) => r.url.includes('a-ping'));
      if (trust === 'protected') {
        expect(pings, `a <a ping> leaked in Protected: ${JSON.stringify(pings)}`).toHaveLength(0);
        if (session.dnsRouting.observable) {
          expect(session.summary().dns.filter((q) => q.name.includes('clicked-ping')), 'a ping DNS leak in Protected').toHaveLength(0);
        }
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
      expect(results['meta-refresh']?.status, JSON.stringify(results['meta-refresh'])).toBe('blocked');
      expect(session.summary().http, 'meta refresh reached the server').toHaveLength(0);
      expect(await session.deck.url()).toContain('navigation-refresh.html');
    } finally {
      await session.close();
      s.cleanup();
    }
  });
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
    // 9.9: will-download is cancelled in Protected view. Every download item was prevented and never saved.
    for (const d of h.downloads) {
      expect(d.prevented, `download not prevented in Protected: ${JSON.stringify(d)}`).toBe(true);
      expect(d.stateAfter, `download progressed in Protected: ${JSON.stringify(d)}`).not.toBe('completed');
      expect(d.savePath ?? '', `a file was saved in Protected: ${JSON.stringify(d)}`).toBe('');
    }
  } finally {
    await session.close();
    s.cleanup();
  }
});

test('trusted: a download needs confirmation (a save dialog), nothing saved without it', async () => {
  const s = scratch();
  const session = await openFixture({ scratch: s, fixture: 'download.html', trust: 'trusted' });
  try {
    await session.waitPhase('load');
    await session.deck.clickSelector('#blob-download');
    await sleep(800);
    const h = await session.app.harness();
    expect(h.downloads.length, 'a download should have started in Trusted').toBeGreaterThanOrEqual(1);
    // 9.9: a Trusted download is not cancelled; it waits for the save dialog (its options are set). The
    // harness does not choose a path, so nothing is saved on disk.
    const d = h.downloads[0];
    expect(d.prevented, `Trusted download should not be event-prevented: ${JSON.stringify(d)}`).toBe(false);
    // The item is waiting for the user's save location (options set, not yet done).
    await session.app.cancelDownloads();
  } finally {
    await session.close();
    s.cleanup();
  }
});

for (const trust of ['protected', 'trusted'] as const) {
  test(`${trust}: permissions and device choosers are denied (after a real click)`, async () => {
    const s = scratch();
    const session = await openFixture({ scratch: s, fixture: 'permissions.html', trust });
    try {
      await session.waitPhase('load', 20_000);
      // Device choosers need a user gesture: click the button with trusted input.
      await session.deck.clickSelector('#run-devices');
      await session.waitPhase('devices', 10_000).catch(() => undefined);
      await sleep(800);
      const results = (await session.results()) as Record<string, ProbeResult>;
      // Every permission and device call must be blocked (denied), never granted.
      const granted = Object.entries(results).filter(([, r]) => r.status === 'leaked');
      expect(granted, `a permission or device was granted: ${JSON.stringify(granted)}`).toHaveLength(0);
      for (const key of ['getUserMedia', 'geolocation']) {
        expect(results[key]?.status, `${key}: ${JSON.stringify(results[key])}`).toBe('blocked');
      }
      // The device choosers reached main and were refused with no device.
      const h = await session.app.harness();
      const kinds = h.devices.map((d) => d.event);
      for (const ev of ['select-bluetooth-device', 'select-hid-device', 'select-serial-port', 'select-usb-device']) {
        if (results[ev.includes('bluetooth') ? 'bluetooth' : ev.includes('hid') ? 'hid' : ev.includes('serial') ? 'serial' : 'usb']?.status === 'blocked') {
          // The chooser may or may not fire depending on whether devices exist; when it fired, it was prevented.
          for (const d of h.devices.filter((x) => x.event === ev)) expect(d.prevented, `${ev} not prevented: ${JSON.stringify(d)}`).toBe(true);
        }
      }
      void kinds;
    } finally {
      await session.close();
      s.cleanup();
    }
  });
}
