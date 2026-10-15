// The OS sandbox and the run configuration (SPEC 9.9 Always: sandbox: true; docs/ARCHITECTURE.md "run as the
// non-root user bltest so the OS sandbox is on"). This test records which configuration ran (the run user,
// whether the OS sandbox is on, and how DNS is routed) so the results say so, and — when the app runs
// unprivileged — asserts the deck renderer is actually sandboxed (seccomp on, its own user namespace, not
// uid 0). Under --no-sandbox (root, development only) it records that and skips the OS-sandbox assertion.

import { expect, test } from '@playwright/test';
import { Scratch, resolveDns, resolveRunAs, sleep } from '../helpers/app';
import { openFixture } from '../helpers/security';
import { sharedDnsServer, SINK_IP } from '../helpers/servers';

test('records the run configuration and, when unprivileged, proves the OS sandbox is on', async () => {
  const runAs = resolveRunAs();
  const dns = await sharedDnsServer();
  const dnsRouting = resolveDns(dns.available);
  const config = {
    runAs: runAs.mode,
    osSandbox: runAs.sandbox,
    runAsReason: runAs.reason,
    dns: dnsRouting.mode,
    dnsReason: dnsRouting.reason,
    dnsObservable: dnsRouting.observable,
    sinkIp: SINK_IP,
  };
  // Surfaced in the run's stdout so the results record which configuration ran (work item requirement).
  console.log(`[bl-security] run configuration: ${JSON.stringify(config)}`);
  test.info().annotations.push({ type: 'run-config', description: JSON.stringify(config) });

  const s = new Scratch(runAs);
  const session = await openFixture({ scratch: s, fixture: 'ipc.html', trust: 'protected' });
  try {
    await sleep(400);
    const ev = await session.app.sandboxEvidence(session.deck);
    console.log(`[bl-security] deck renderer sandbox evidence: ${JSON.stringify(ev)}`);

    if (process.platform !== 'linux') {
      test.skip(true, 'OS-sandbox evidence is read from /proc; Linux only');
      return;
    }
    expect(ev.rendererPid, 'should have found the deck renderer process').toBeGreaterThan(0);

    if (!runAs.sandbox) {
      // root with --no-sandbox: the OS sandbox is off by design (development only). Recorded, not asserted.
      test.info().annotations.push({ type: 'os-sandbox-off', description: runAs.reason });
      return;
    }
    // Unprivileged run (bltest, or a non-root runner): the renderer must be genuinely sandboxed.
    // Seccomp is in filter mode (2), not disabled (0).
    expect(ev.seccomp, `the deck renderer should run under a seccomp filter; evidence ${JSON.stringify(ev)}`).toBe('2');
    expect(ev.noNewPrivs, 'the renderer should have no_new_privs set').toBe('1');
    // The renderer runs in its own user namespace (Chromium's Linux namespace sandbox), not main's.
    expect(ev.ownUserNs, 'the renderer should be in its own user namespace').toBe(true);
    if (runAs.mode === 'bltest') {
      // Running as bltest: the renderer is not uid 0.
      expect(ev.uid, `the renderer should not run as root; uid line ${ev.uid}`).not.toMatch(/^0\b/);
    }
  } finally {
    await session.close();
    s.cleanup();
  }
});
