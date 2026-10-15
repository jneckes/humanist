// Network containment (SPEC 6.10, 9.9 Network policy; section 10 Security fixtures). The network, hints and
// webrtc fixtures run in both trust states. In Protected view nothing may reach the test servers; in Trusted
// view the allowed kinds (subresources, fetch, XHR) arrive, which is the positive control, while navigation,
// popups, permissions and local reads still fail (their own specs check those).

import { expect, test } from '@playwright/test';
import { Scratch, resolveRunAs, sleep } from '../helpers/app';
import { openFixture } from '../helpers/security';

test.describe.configure({ mode: 'serial' });

function scratch(): Scratch {
  return new Scratch(resolveRunAs());
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

    // Close the window: pagehide/visibility beacons must not escape either.
    await session.app.closeDoc(session.docId);
    await sleep(500);
    const after = session.summary();
    expect(after.http, `http after close: ${JSON.stringify(after.http)}`).toHaveLength(0);
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
  } finally {
    await session.close();
    s.cleanup();
  }
});

test('protected: static hints, preconnect, prefetch, prerender and speculation rules are contained', async () => {
  const s = scratch();
  const session = await openFixture({ scratch: s, fixture: 'hints.html', trust: 'protected' });
  try {
    await session.waitPhase('load');
    await sleep(1500);
    const sum = session.summary();
    // No request reaches the server through any hint (preconnect/prefetch/prerender go through the PAC proxy
    // to the closed port; static dns-prefetch and the x-dns-prefetch-control meta are stripped by the served
    // copy; speculation rules get no network).
    expect(sum.http, `http: ${JSON.stringify(sum.http)}`).toHaveLength(0);
    expect(sum.udp, `udp: ${JSON.stringify(sum.udp)}`).toHaveLength(0);
    if (session.dnsRouting.observable) {
      // The only DNS that may leak today is the script-inserted dns-prefetch (next test, a known gap).
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
// resolves the name in the partition's network context without consulting the PAC proxy; and no CSP directive
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

test('protected: WebRTC opens no socket to the test host', async () => {
  const s = scratch();
  const session = await openFixture({ scratch: s, fixture: 'webrtc.html', trust: 'protected' });
  try {
    await session.waitPhase('load', 20_000);
    const sum = session.summary();
    // The sockets are the exfiltration channel: disable_non_proxied_udp stops UDP STUN/TURN; the PAC proxy
    // sends TURN/TCP and TLS to the closed port. Nothing reaches the UDP or TCP listener.
    expect(sum.udp, `udp packets: ${JSON.stringify(sum.udp)}`).toHaveLength(0);
    expect(sum.tcp, `tcp connections: ${JSON.stringify(sum.tcp)}`).toHaveLength(0);
    const results = await session.results();
    expect(results['rtc-candidates']?.status, JSON.stringify(results['rtc-candidates'])).not.toBe('leaked');
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
