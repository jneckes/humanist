// Network containment (SPEC 6.10, 9.9 Network policy; section 10 Security fixtures). The network, hints and
// webrtc fixtures run in both trust states. In Protected view nothing may reach the test servers; in Trusted
// view the allowed kinds (subresources, fetch, XHR) arrive, which is the positive control, while navigation,
// popups, permissions and local reads still fail (their own specs check those). Each layer of the Protected
// policy is checked on its own in layers.spec.ts.

import { expect, test } from '@playwright/test';
import { Scratch, resolveRunAs, sleep } from '../helpers/app';
import { openFixture, type SecuritySession } from '../helpers/security';

test.describe.configure({ mode: 'serial' });

function scratch(): Scratch {
  return new Scratch(resolveRunAs());
}

/** Reloads the deck from main, which runs its pagehide and visibilitychange handlers (finding 45). */
async function reloadDeck(session: SecuritySession): Promise<void> {
  await session.app.electronApp.evaluate(({ webContents }, id) => {
    const wc = webContents.fromId(id);
    if (!wc || wc.isDestroyed()) throw new Error('no deck webContents');
    wc.reload();
  }, session.deck.wcId);
  await sleep(2000);
}

/** Requests for network.html's unload beacons (sendBeacon and keepalive fetch on pagehide/visibilitychange). */
function unloadBeacons(session: SecuritySession): string[] {
  return session.summary().http.filter((r) => /pagehide-(beacon|fetch)/.test(r.url) || /^pagehide-/.test(r.host)).map((r) => r.url);
}

test('protected: no network attempt reaches the test servers', async () => {
  const s = scratch();
  const session = await openFixture({ scratch: s, fixture: 'network.html', trust: 'protected' });
  try {
    expect(session.trust).toBe('protected');
    const w = await session.app.win(session.docId);
    expect(w.trust).toBe('protected');
    await session.waitPhase('load');
    // Let any late/async attempt (worker, eventsource, websocket retry) run.
    await sleep(1500);

    const results = await session.results();
    // Every page-observed probe is blocked (a leaked one would mean data or a live connection).
    const leaked = Object.entries(results).filter(([, r]) => r.status === 'leaked');
    expect(leaked, `page saw leaks: ${JSON.stringify(leaked)}`).toHaveLength(0);
    // fetch, XHR and the subresources must each be blocked (not merely pending).
    for (const key of ['fetch', 'fetch-ip', 'xhr', 'css-static', 'js-static', 'img-static', 'img-ip']) {
      expect(results[key]?.status, `${key}: ${JSON.stringify(results[key])}`).toBe('blocked');
    }

    // The servers are the real verdict: NOTHING for this run's label.
    const sum = session.summary();
    expect(sum.http, `http: ${JSON.stringify(sum.http)}`).toHaveLength(0);
    if (session.dnsRouting.observable) expect(sum.dns, `dns: ${JSON.stringify(sum.dns)}`).toHaveLength(0);
    expect(sum.udp, `udp: ${JSON.stringify(sum.udp)}`).toHaveLength(0);

    // Unload beacons (finding 45): a reload runs the page's pagehide and visibilitychange handlers (the
    // Trusted test below proves they then deliver), and in Protected view nothing they send may arrive.
    // Closing the window is not a test of this: close runs no unload handlers (DocWindow.closeDeck closes the
    // deck's webContents without beforeunload/unload), which the Trusted test also pins.
    await reloadDeck(session);
    const after = session.summary();
    expect(after.http, `http after the reload: ${JSON.stringify(after.http)}`).toHaveLength(0);
    if (session.dnsRouting.observable) expect(after.dns).toHaveLength(0);
  } finally {
    await session.close();
    s.cleanup();
  }
});

test('trusted: subresources, fetch and XHR reach the server (positive control)', async () => {
  const s = scratch();
  const session = await openFixture({ scratch: s, fixture: 'network.html', trust: 'trusted' });
  try {
    expect(session.trust).toBe('trusted');
    expect((await session.app.win(session.docId)).trust).toBe('trusted');
    await session.waitPhase('load');
    await sleep(1500);

    const sum = session.summary();
    const paths = sum.http.map((r) => r.url);
    // fetch, XHR and the static subresources are allowed in Trusted and must arrive.
    for (const marker of ['/fetch', '/xhr', '/css-static', '/js-static', '/img-static']) {
      expect(paths.some((u) => u.includes(marker)), `expected a request to ${marker}; got ${JSON.stringify(paths)}`).toBe(true);
    }
    // The WebSocket handshake reaches the server in Trusted.
    expect(sum.http.some((r) => r.kind === 'ws-upgrade'), `ws upgrade; got ${JSON.stringify(sum.http.map((r) => r.kind))}`).toBe(true);

    const results = await session.results();
    expect(results['fetch']?.status, JSON.stringify(results['fetch'])).toBe('leaked'); // "leaked" = the read succeeded, which Trusted allows
    expect(results['xhr']?.status).toBe('leaked');

    // Unload beacons, positive control for the Protected reload check (finding 45): a reload delivers both
    // the pagehide sendBeacon and the keepalive fetch.
    expect(unloadBeacons(session), 'nothing unloaded yet').toHaveLength(0);
    await reloadDeck(session);
    const beacons = unloadBeacons(session);
    expect(beacons.some((u) => u.includes('pagehide-beacon')), `pagehide sendBeacon after reload: ${JSON.stringify(beacons)}`).toBe(true);
    expect(beacons.some((u) => u.includes('pagehide-fetch')), `pagehide keepalive fetch after reload: ${JSON.stringify(beacons)}`).toBe(true);
    // Tripwire: closing the window runs no unload handlers, so nothing more arrives, even in Trusted view.
    // If this fails, the close path started running them, and the Protected test must check close too.
    const before = beacons.length;
    await session.app.closeDoc(session.docId);
    await sleep(1500);
    expect(unloadBeacons(session).length, 'close ran unload handlers').toBe(before);
  } finally {
    await session.close();
    s.cleanup();
  }
});

// Resource hints (9.9 Channels that onBeforeRequest does not see; finding 43). In Electron 44 only two kinds
// of hint make traffic at all, even in Trusted view with the network open: dns-prefetch (a DNS lookup) and
// prefetch (an HTTP request). preconnect (by name or by address), prerender, speculation rules and links
// produce no DNS query and no connection. The Trusted test is the positive control for the first group and
// a tripwire for the second: if a later Electron starts acting on an inert hint, it fails, and the Protected
// containment of that hint (the served-copy strip, the closed-port proxy) must then be checked for real.
const LIVE_HTTP_HINTS = ['static-prefetch', 'js-prefetch'];
const LIVE_DNS_HINTS = ['static-dns-prefetch', 'js-dns-prefetch-'];
const INERT_HINTS = ['static-preconnect', 'js-preconnect', 'static-prerender', 'js-prerender', 'speculation-prefetch', 'speculation-prerender', 'anchor-link', 'js-anchor'];

test('trusted: dns-prefetch and prefetch hints make traffic; preconnect, prerender and speculation rules make none', async () => {
  const s = scratch();
  const session = await openFixture({ scratch: s, fixture: 'hints.html', trust: 'trusted' });
  try {
    expect((await session.app.win(session.docId)).trust).toBe('trusted');
    await session.waitPhase('load');
    await sleep(2500);
    const sum = session.summary();
    const urls = sum.http.map((r) => `${r.host}${r.url}`);
    for (const h of LIVE_HTTP_HINTS) expect(urls.some((u) => u.includes(h)), `${h} should be fetched in Trusted; got ${JSON.stringify(urls)}`).toBe(true);
    if (session.dnsRouting.observable) {
      for (const h of LIVE_DNS_HINTS) expect(sum.dns.some((q) => q.name.startsWith(h)), `${h} should be looked up in Trusted; got ${JSON.stringify(sum.dns.map((q) => q.name))}`).toBe(true);
    } else {
      test.info().annotations.push({ type: 'skip-dns', description: session.dnsRouting.reason });
    }
    // Tripwire: the inert hints, by name and by address, make no request, no lookup and no connection.
    for (const h of INERT_HINTS) {
      expect(urls.filter((u) => u.includes(h)), `${h} made a request in Trusted`).toHaveLength(0);
      if (session.dnsRouting.observable) expect(sum.dns.filter((q) => q.name.startsWith(h)).map((q) => q.name), `${h} made a DNS lookup in Trusted`).toHaveLength(0);
    }
    // A preconnect opens a socket and sends nothing. Every connection the server saw carried a request (the
    // prefetches), so no hint (the IP-literal preconnect included) opened one of its own.
    const idle = sum.httpConns.filter((c) => c.requests === 0);
    expect(idle, `connections that carried no request (a preconnect?): ${JSON.stringify(sum.httpConns)}`).toHaveLength(0);
  } finally {
    await session.close();
    s.cleanup();
  }
});

test('protected: the hints that make traffic in Trusted (dns-prefetch, prefetch) are contained', async () => {
  const s = scratch();
  const session = await openFixture({ scratch: s, fixture: 'hints.html', trust: 'protected' });
  try {
    await session.waitPhase('load');
    await sleep(2500);
    const sum = session.summary();
    // prefetch: the static hint is removed from the served copy, the script-inserted one is cancelled by
    // onBeforeRequest (type `other`). Nothing reaches the server, not even a bare connection.
    expect(sum.http, `http: ${JSON.stringify(sum.http)}`).toHaveLength(0);
    expect(sum.httpConns, `connections: ${JSON.stringify(sum.httpConns)}`).toHaveLength(0);
    expect(sum.udp, `udp: ${JSON.stringify(sum.udp)}`).toHaveLength(0);
    if (session.dnsRouting.observable) {
      // Static dns-prefetch is removed from the served copy (with the x-dns-prefetch-control meta). The only
      // DNS that may leak today is the script-inserted dns-prefetch (next test, a known gap).
      const other = sum.dns.filter((q) => !q.name.includes('js-dns-prefetch'));
      expect(other, `a hint other than script-inserted dns-prefetch leaked DNS: ${JSON.stringify(other)}`).toHaveLength(0);
    } else {
      test.info().annotations.push({ type: 'skip-dns', description: session.dnsRouting.reason });
    }
  } finally {
    await session.close();
    s.cleanup();
  }
});

// KNOWN GAP, documented (9.9 "or states the channel"; SECURITY.md; docs/PHASE0-FINDINGS.md): a script-inserted
// `<link rel="dns-prefetch">` triggers a DNS lookup in Protected view. The served-copy strip covers only hints
// present at parse time; Blink ignores X-DNS-Prefetch-Control for link-element prefetches (only the
// WebPreferences switch gates them, which Electron 44 does not expose); Electron's network hints handler
// resolves the name in the partition's network context without consulting the proxy; and no CSP directive
// covers it. Only the name leaves (no socket, no HTTP). test.fail() keeps the channel visible: when a release
// closes it, this test passes and Playwright flags the modifier for removal.
test('protected: script-inserted dns-prefetch leaks no DNS query [known gap]', async () => {
  const s = scratch();
  const session = await openFixture({ scratch: s, fixture: 'hints.html', trust: 'protected' });
  try {
    await session.waitPhase('load');
    await sleep(1500);
    if (!session.dnsRouting.observable) {
      // DNS is not observable in this mode; cannot judge the gap here.
      test.skip(true, session.dnsRouting.reason);
      return;
    }
    test.fail(true, 'script-inserted dns-prefetch leaks a DNS query in Protected view (9.9): a documented channel, see SECURITY.md');
    const leaked = session.summary().dns.filter((q) => q.name.includes('js-dns-prefetch'));
    expect(leaked, `script-inserted dns-prefetch should leak nothing but did: ${JSON.stringify(leaked.map((q) => q.name))}`).toHaveLength(0);
  } finally {
    await session.close();
    s.cleanup();
  }
});

/** A STUN/TURN Allocate request (RFC 5766: type 0x0003, magic cookie 0x2112A442) as the first bytes. */
function isTurnAllocate(head: string): boolean {
  return head.startsWith('0003') && head.slice(8, 16) === '2112a442';
}

test('protected: WebRTC opens no socket to the test host or to a loopback service', async () => {
  const s = scratch();
  const session = await openFixture({ scratch: s, fixture: 'webrtc.html', trust: 'protected' });
  try {
    await session.waitPhase('load', 20_000);
    await sleep(500);
    const sum = session.summary();
    // The sockets are the exfiltration channel: disable_non_proxied_udp stops UDP STUN/TURN; the proxy
    // sends TURN/TCP and TLS to the closed port. Nothing reaches the UDP or TCP listener.
    expect(sum.udp, `udp packets: ${JSON.stringify(sum.udp)}`).toHaveLength(0);
    expect(sum.tcp, `tcp connections: ${JSON.stringify(sum.tcp)}`).toHaveLength(0);
    // Finding 8: TURN over TCP to 127.0.0.1, localhost and [::1]. Chromium bypasses a PAC proxy for
    // loopback; the fixed_servers proxy with '<-loopback>' sends these to its closed port too.
    expect(sum.loop, `loopback connections: ${JSON.stringify(sum.loop)}`).toHaveLength(0);
    const results = await session.results();
    expect(results['rtc-candidates']?.status, JSON.stringify(results['rtc-candidates'])).not.toBe('leaked');
  } finally {
    await session.close();
    s.cleanup();
  }
});

test('trusted: WebRTC TURN over TCP reaches the test host and the loopback service (positive control)', async () => {
  const s = scratch();
  const session = await openFixture({ scratch: s, fixture: 'webrtc.html', trust: 'trusted' });
  try {
    expect((await session.app.win(session.docId)).trust).toBe('trusted');
    await session.waitPhase('load', 20_000);
    await sleep(500);
    const sum = session.summary();
    // With no proxy, the same fixture's TURN/TCP connections arrive: the Protected test above would see them.
    expect(sum.tcp.some((c) => isTurnAllocate(c.head)), `TURN Allocate at the test host: ${JSON.stringify(sum.tcp)}`).toBe(true);
    const v4 = session.net.loopTcp.connections;
    expect(v4.some((c) => isTurnAllocate(c.head)), `TURN Allocate at 127.0.0.1 (turn:127.0.0.1 and turn:localhost): ${JSON.stringify(v4)}`).toBe(true);
    if (session.net.loopTcp6.unavailable) {
      test.info().annotations.push({ type: 'no-ipv6', description: session.net.loopTcp6.unavailable });
    } else {
      const v6 = session.net.loopTcp6.connections;
      expect(v6.some((c) => isTurnAllocate(c.head)), `TURN Allocate at [::1]: ${JSON.stringify(v6)}`).toBe(true);
    }
  } finally {
    await session.close();
    s.cleanup();
  }
});

// KNOWN GAP, documented (9.9 "or states the channel"; SECURITY.md; docs/PHASE0-FINDINGS.md): in Protected view
// Chromium's ICE resolves the hostname of a TURN-over-TCP or TLS server before the (dead, proxied) connect, so
// the attacker's DNS server learns the name. No socket connects (previous test), and UDP STUN/TURN names are
// never resolved (disable_non_proxied_udp). 9.9's example mitigation, removing RTCPeerConnection from the
// page's world before its scripts run, was tried in Phase 0 and rejected: a script-created about:blank iframe
// (contentWindow or window[0], and document.write into it) still has a working RTCPeerConnection, even with
// the preload running in subframes (nodeIntegrationInSubFrames covers srcdoc, blob: and data: frames only),
// and Electron 44 has no switch that disables WebRTC per webContents.
test('protected: WebRTC resolves no TURN hostname [known gap]', async () => {
  const s = scratch();
  const session = await openFixture({ scratch: s, fixture: 'webrtc.html', trust: 'protected' });
  try {
    await session.waitPhase('load', 20_000);
    if (!session.dnsRouting.observable) {
      test.skip(true, session.dnsRouting.reason);
      return;
    }
    test.fail(true, 'WebRTC resolves TURN-over-TCP/TLS hostnames in Protected view (9.9): a documented channel, see SECURITY.md');
    const leaked = session.summary().dns.filter((q) => q.name.includes('turn-') || q.name.includes('stun-'));
    expect(leaked, `WebRTC should resolve no TURN/STUN hostname but did: ${JSON.stringify(leaked.map((q) => q.name))}`).toHaveLength(0);
  } finally {
    await session.close();
    s.cleanup();
  }
});
