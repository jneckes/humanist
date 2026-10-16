// Each Protected network layer on its own (SPEC 9.9 Network policy, Protected: "Electron also does not
// document that webRequest sees custom-scheme requests, so the security fixtures check each layer on its
// own"; finding 41). The other specs run with all three layers on, where any one of them hides the others.
// Here layers.html opens Protected with two layers turned off by the test-only switch
// BLUELINE_TEST_DISABLE_LAYER (honoured only with BLUELINE_TEST=1 in an unpackaged build; network-policy
// disabledProtectedLayers), and each run asserts what the remaining layer blocks on its own:
//
//   csp       connect-src 'none': fetch, XHR, EventSource, WebSocket and sendBeacon fail for every origin,
//             blueline:// included. Images are not connect-src, so the <img> reaches the server: the
//             proof that the other two layers really are off.
//   requests  onBeforeRequest: every http(s)/ws request is cancelled ('protected'), and blueline:// fetch
//             and XHR ('blueline-read'). No CSP violation fires: the proof that the CSP is off.
//   proxy     the closed-port proxy: no connection reaches the test host at all. The blueline:// fetch
//             reads the document (the proxy does not see custom schemes): the proof that the other two
//             layers are off.
//
// Positive control: with all three off, the same attempts reach the server and the blueline:// fetch reads
// the document.

import { expect, test } from '@playwright/test';
import { Scratch, resolveRunAs, sleep } from '../helpers/app';
import { openFixture, type ProbeResult, type SecuritySession } from '../helpers/security';

test.describe.configure({ mode: 'serial' });

function scratch(): Scratch {
  return new Scratch(resolveRunAs());
}

const HTTP_ATTEMPTS = ['http-fetch', 'http-xhr', 'http-eventsource', 'http-websocket'];
/** Server paths of layers.html's attempts on the test host. */
const PATHS = ['layer-fetch', 'layer-xhr', 'layer-eventsource', 'layer-websocket', 'layer-beacon', 'layer-img'];

async function run(disable: string): Promise<{ session: SecuritySession; s: Scratch; results: Record<string, ProbeResult> }> {
  const s = scratch();
  const session = await openFixture({ scratch: s, fixture: 'layers.html', trust: 'protected', env: { BLUELINE_TEST_DISABLE_LAYER: disable } });
  try {
    expect((await session.app.win(session.docId)).trust).toBe('protected');
    await session.waitPhase('load', 20_000);
    await sleep(800);
    // The switch was honoured (main logs it loudly) for exactly these layers.
    const line = session.app.logsMatching(/TEST ONLY: BLUELINE_TEST_DISABLE_LAYER/);
    expect(line.length, `the app must log that layers are off: ${session.app.logs.slice(-20).join('\n')}`).toBeGreaterThan(0);
    for (const layer of disable.split(',')) expect(line[0]).toContain(layer);
    return { session, s, results: (await session.results()) as Record<string, ProbeResult> };
  } catch (e) {
    await session.close();
    s.cleanup();
    throw e;
  }
}

function arrived(session: SecuritySession): string[] {
  const sum = session.summary();
  return PATHS.filter((p) => sum.http.some((r) => r.url.includes(`/${p}`) || r.host.startsWith(`${p}.`)));
}

function status(results: Record<string, ProbeResult>, key: string): string {
  return `${key}: ${JSON.stringify(results[key])}`;
}

test('protected, only the CSP layer: fetch, XHR, EventSource, WebSocket and sendBeacon fail for every origin', async () => {
  const { session, s, results } = await run('requests,proxy');
  try {
    for (const key of ['bl-fetch', 'bl-xhr', ...HTTP_ATTEMPTS]) expect(results[key]?.status, status(results, key)).toBe('blocked');
    expect(results['bl-fetch']?.detail, 'the blueline:// fetch is refused by the CSP').not.toContain('read');
    expect(results['csp-violations']?.status, `connect-src violations: ${status(results, 'csp-violations')}`).toBe('blocked');
    expect(results['csp-violations']?.detail).toContain('connect-src');
    // Only the image arrives: it is not connect-src, and nothing else stops it with the other layers off.
    expect(arrived(session), JSON.stringify(session.summary().http.map((r) => r.url))).toEqual(['layer-img']);
    expect(session.app.logsMatching(/request cancelled \((protected|blueline-read)\)/), 'the requests layer is off').toHaveLength(0);
  } finally {
    await session.close();
    s.cleanup();
  }
});

test('protected, only the onBeforeRequest layer: http(s) and ws requests and blueline:// fetch and XHR are cancelled', async () => {
  const { session, s, results } = await run('csp,proxy');
  try {
    for (const key of ['bl-fetch', 'bl-xhr', ...HTTP_ATTEMPTS, 'http-img']) expect(results[key]?.status, status(results, key)).toBe('blocked');
    // No CSP is in force, so the listener alone did it.
    expect(results['csp-violations']?.status, status(results, 'csp-violations')).toBe('ok');
    expect(session.app.logsMatching(/request cancelled \(blueline-read\) xhr blueline:\/\//).length, 'blueline:// fetch/XHR cancelled by the listener').toBeGreaterThanOrEqual(2);
    for (const kind of ['xhr', 'webSocket', 'image']) {
      expect(session.app.logsMatching(new RegExp(`request cancelled \\(protected\\) ${kind} `)).length, `${kind} cancelled by the listener`).toBeGreaterThan(0);
    }
    const sum = session.summary();
    expect(sum.http, JSON.stringify(sum.http)).toHaveLength(0);
    expect(sum.httpConns, 'no connection reached the test host').toHaveLength(0);
  } finally {
    await session.close();
    s.cleanup();
  }
});

test('protected, only the proxy layer: no connection reaches the test host', async () => {
  const { session, s, results } = await run('csp,requests');
  try {
    // The CSP and the listener are off: the blueline:// fetch reads the document (no proxy covers it).
    expect(results['bl-fetch']?.status, status(results, 'bl-fetch')).toBe('leaked');
    expect(results['bl-fetch']?.detail).toContain('(the document)');
    expect(results['csp-violations']?.status, status(results, 'csp-violations')).toBe('ok');
    for (const key of [...HTTP_ATTEMPTS, 'http-img']) expect(results[key]?.status, status(results, key)).toBe('blocked');
    const sum = session.summary();
    expect(sum.http, JSON.stringify(sum.http)).toHaveLength(0);
    expect(sum.httpConns, 'no connection reached the test host').toHaveLength(0);
    expect(session.app.logsMatching(/request cancelled \((protected|blueline-read)\)/), 'the requests layer is off').toHaveLength(0);
  } finally {
    await session.close();
    s.cleanup();
  }
});

test('protected, every layer off (positive control): the same attempts reach the server and read the document', async () => {
  const { session, s, results } = await run('csp,requests,proxy');
  try {
    expect(results['bl-fetch']?.status, status(results, 'bl-fetch')).toBe('leaked');
    expect(results['bl-fetch']?.detail).toContain('(the document)');
    expect(results['bl-xhr']?.status, status(results, 'bl-xhr')).toBe('leaked');
    for (const key of [...HTTP_ATTEMPTS, 'http-img']) expect(results[key]?.status, status(results, key)).toBe('leaked');
    expect(results['csp-violations']?.status, status(results, 'csp-violations')).toBe('ok');
    await sleep(500);
    expect(arrived(session).sort(), JSON.stringify(session.summary().http.map((r) => r.url))).toEqual([...PATHS].sort());
  } finally {
    await session.close();
    s.cleanup();
  }
});
