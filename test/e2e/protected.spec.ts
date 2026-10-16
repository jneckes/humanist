// Phase 0 E2E: Protected view and the trust bar (SPEC section 10; 6.10). Opening with --protected shows the
// yellow trust bar in the shell; clicking Allow network flips the network policy for the file. Uses the
// security network fixture (with the suite's servers) so the flip can be proven end to end: a fetch to the
// test host is blocked before and reaches the server after.

import { expect, test } from '@playwright/test';
import { Scratch, resolveRunAs, sleep } from '../helpers/app';
import { openFixture } from '../helpers/security';

test.describe.configure({ mode: 'serial' });

function scratch(): Scratch {
  return new Scratch(resolveRunAs());
}

test('--protected shows the trust bar, and Allow network flips the policy for the file', async () => {
  const s = scratch();
  const session = await openFixture({ scratch: s, fixture: 'network.html', trust: 'protected' });
  try {
    const w = await session.app.win(session.docId);
    expect(w.trust).toBe('protected');
    // The trust bar is shown (main state) and visible in the shell DOM.
    expect(w.state.trustBarVisible, 'the trust bar should be visible in Protected view').toBe(true);
    expect(w.networkAllowed).toBe(false);

    const shell = await session.app.shellPage(session.docId);
    await expect(shell.locator('#trust-bar')).toBeVisible();
    await expect(shell.locator('#allow-network')).toBeVisible();
    // The bar states the reason (6.10): "--protected" opens with "Opened at your request".
    await expect(shell.locator('#trust-text')).toContainText('Protected view');

    // Before: nothing reached the server (the page's load-time fetches were blocked in Protected).
    await session.waitPhase('load');
    await sleep(500);
    expect(session.summary().http, `nothing should have reached the server yet: ${JSON.stringify(session.summary().http)}`).toHaveLength(0);

    // Click Allow network in the shell. The deck reloads with the Trusted network policy.
    await shell.locator('#allow-network').click();
    // Main records the flip immediately.
    await session.deck.app.electronApp.evaluate(() => undefined); // flush the IPC round-trip
    let flipped = false;
    for (let i = 0; i < 50 && !flipped; i++) {
      flipped = (await session.app.win(session.docId)).networkAllowed;
      if (!flipped) await sleep(100);
    }
    expect(flipped, 'Allow network should set networkAllowed').toBe(true);
    // Trust itself does not change; only the network policy does (6.10).
    expect((await session.app.win(session.docId)).trust).toBe('protected');

    // After the reload, a fresh fetch to the test host now succeeds and reaches the server.
    const deck2 = await session.app.waitForDeck('network.html', { timeout: 20_000 });
    await sleep(500);
    const reached = await deck2.eval<string>(
      `fetch(${JSON.stringify(httpUrl(session))}, { cache: 'no-store' }).then(r => 'ok ' + r.status, e => 'err ' + (e && e.name))`,
    );
    expect(reached, `fetch after Allow network: ${reached}`).toContain('ok');
    await sleep(300);
    const got = session.summary();
    const afterAllow = got.http.filter((r) => r.url.includes('after-allow'));
    expect(afterAllow.length, `the server should have received the post-Allow fetch; got ${JSON.stringify(got.http.map((r) => r.url))}`).toBeGreaterThan(0);
  } finally {
    await session.close();
    s.cleanup();
  }
});

// Finding 22 (9.1 Shell view): every document window shares the one 'shell' session, and installShellPolicy
// installs its session-level part (permission handlers, onBeforeRequest, will-download) once per session.
// Before, each window added another will-download listener for the life of the process (and Node warned at
// the 11th window). The test harness adds one listener of its own, so the count is compared with the first
// window's, not with 1.
test('the shell session keeps one will-download listener however many windows open', async () => {
  const s = scratch();
  const session = await openFixture({ scratch: s, fixture: 'ipc.html', trust: 'protected' });
  try {
    const count = () =>
      session.app.electronApp.evaluate(({ session: ses }) => (ses.fromPartition('shell') as unknown as NodeJS.EventEmitter).listenerCount('will-download'));
    const first = await count();
    expect(first, 'the app and the harness each listen once').toBeLessThanOrEqual(2);
    for (const name of ['sibling-page.html', 'storage.html']) {
      const id = await session.app.open(session.folder.file(name), true);
      expect(id, `opened ${name}`).toBeTruthy();
      await session.app.waitForDeck(name, { timeout: 20_000 });
    }
    expect((await session.app.windows()).length).toBe(3);
    expect(await count(), 'three windows, still one app listener on the shared shell session').toBe(first);
  } finally {
    await session.close();
    s.cleanup();
  }
});

function httpUrl(session: { cfg: { uniq: string; zone: string; port: number } }): string {
  return `http://after-allow.${session.cfg.uniq}.${session.cfg.zone}:${session.cfg.port}/${session.cfg.uniq}/after-allow`;
}
