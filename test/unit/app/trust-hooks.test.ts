// trust-hooks against fake Electron sessions (9.1 Shell view; 9.9 Network policy, Channels that
// onBeforeRequest does not see). The pure decisions are tested in network-policy.test.ts; these check what
// the install functions do to a session.
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { Session, WebContents } from 'electron';
import { DEFAULT_ALLOWLIST, PROXY_CHECK_URLS } from '../../../packages/app/src/main/network-policy';
import { installDeckSessionPolicy, installDeckWebContentsPolicy, installShellPolicy } from '../../../packages/app/src/main/trust-hooks';

interface ProxyConfigLike {
  mode: string;
  proxyRules?: string;
  proxyBypassRules?: string;
  pacScript?: string;
}

/**
 * A session with just enough of Electron's surface for the install functions. resolveProxy follows the
 * applied config the way Chromium does: fixed_servers sends every host to proxyRules unless a bypass entry
 * names it, and loopback and link-local hosts are bypassed implicitly unless '<-loopback>' is listed
 * (`honourNoLoopback: false` models a Chromium that ignored it). Any other mode resolves DIRECT.
 */
class FakeSession extends EventEmitter {
  calls: Record<string, number> = {};
  proxies: ProxyConfigLike[] = [];
  honourNoLoopback = true;
  readonly webRequest = {
    onBeforeRequest: (_l: unknown) => this.count('onBeforeRequest'),
  };
  private count(k: string): void {
    this.calls[k] = (this.calls[k] ?? 0) + 1;
  }
  setPermissionRequestHandler(): void {
    this.count('setPermissionRequestHandler');
  }
  setPermissionCheckHandler(): void {
    this.count('setPermissionCheckHandler');
  }
  setDevicePermissionHandler(): void {
    this.count('setDevicePermissionHandler');
  }
  setBluetoothPairingHandler(): void {
    this.count('setBluetoothPairingHandler');
  }
  async setProxy(c: ProxyConfigLike): Promise<void> {
    this.proxies.push(c);
  }
  async closeAllConnections(): Promise<void> {
    this.count('closeAllConnections');
  }
  async resolveProxy(url: string): Promise<string> {
    const c = this.proxies[this.proxies.length - 1];
    if (!c || c.mode !== 'fixed_servers') return 'DIRECT';
    const host = new URL(url).hostname.toLowerCase();
    const bypass = (c.proxyBypassRules ?? '').split(',').filter(Boolean);
    const noLoopback = this.honourNoLoopback && bypass.includes('<-loopback>');
    const implicit = /^(localhost|.*\.localhost|127\.\d+\.\d+\.\d+|\[::1\]|169\.254\.\d+\.\d+|\[fe80:.*\])$/.test(host);
    if (implicit && !noLoopback) return 'DIRECT';
    if (bypass.includes(host)) return 'DIRECT';
    return `PROXY ${c.proxyRules}`;
  }
}

class FakeWebContents extends EventEmitter {
  openHandlers = 0;
  setWindowOpenHandler(): void {
    this.openHandlers++;
  }
}

describe('installShellPolicy (finding 22)', () => {
  it('installs the session-level policy once per session, however many windows share it', () => {
    const ses = new FakeSession();
    const views = [new FakeWebContents(), new FakeWebContents(), new FakeWebContents()];
    for (const wc of views) installShellPolicy(ses as unknown as Session, wc as unknown as WebContents);
    // One will-download listener on the one shared shell session, not one per window (no
    // MaxListenersExceededWarning at the 11th window).
    expect(ses.listenerCount('will-download')).toBe(1);
    expect(ses.calls).toMatchObject({ setPermissionRequestHandler: 1, setPermissionCheckHandler: 1, setDevicePermissionHandler: 1, onBeforeRequest: 1 });
    // Every window still gets its own view listeners.
    for (const wc of views) {
      for (const ev of ['will-frame-navigate', 'will-navigate', 'will-redirect', 'will-attach-webview']) expect(wc.listenerCount(ev), ev).toBe(1);
      expect(wc.openHandlers).toBe(1);
    }
  });

  it('still cancels shell downloads', () => {
    const ses = new FakeSession();
    installShellPolicy(ses as unknown as Session, new FakeWebContents() as unknown as WebContents);
    installShellPolicy(ses as unknown as Session, new FakeWebContents() as unknown as WebContents);
    let prevented = 0;
    ses.emit('will-download', { preventDefault: () => prevented++ });
    expect(prevented).toBe(1);
  });

  it('installs the policy on each distinct session', () => {
    const a = new FakeSession();
    const b = new FakeSession();
    installShellPolicy(a as unknown as Session, new FakeWebContents() as unknown as WebContents);
    installShellPolicy(b as unknown as Session, new FakeWebContents() as unknown as WebContents);
    expect(a.listenerCount('will-download')).toBe(1);
    expect(b.listenerCount('will-download')).toBe(1);
  });
});

function deckPolicy(trust: 'protected' | 'trusted', over: { strict?: boolean; networkAllowed?: boolean } = {}) {
  return {
    trust: () => trust,
    networkAllowed: () => over.networkAllowed ?? false,
    strict: () => over.strict ?? false,
    allowlist: () => DEFAULT_ALLOWLIST,
    blockPort: 54321,
  };
}

describe('installDeckSessionPolicy: the Protected proxy (finding 8)', () => {
  it('applies fixed_servers to the closed port with the allowlist and <-loopback> bypassed, then verifies it', async () => {
    const ses = new FakeSession();
    const h = installDeckSessionPolicy(ses as unknown as Session, deckPolicy('protected'));
    await h.ready;
    expect(ses.proxies).toHaveLength(1);
    const c = ses.proxies[0];
    expect(c.mode).toBe('fixed_servers');
    expect(c.pacScript).toBeUndefined();
    expect(c.proxyRules).toBe('127.0.0.1:54321');
    expect(c.proxyBypassRules!.split(',')).toEqual([...DEFAULT_ALLOWLIST, '<-loopback>']);
    // What the deck's channels then resolve to: loopback and link-local go to the closed port too.
    for (const u of ['https://attacker.example/', 'https://127.0.0.1:3478/', 'https://localhost/', 'https://data.localhost/', 'https://[::1]/', 'https://169.254.169.254/', 'https://[fe80::1]/']) {
      expect(await ses.resolveProxy(u), u).toBe('PROXY 127.0.0.1:54321');
    }
    expect(await ses.resolveProxy('https://fonts.gstatic.com/x.woff2')).toBe('DIRECT');
    h.dispose();
  });

  it('strict sends the allowlist to the closed port as well', async () => {
    const ses = new FakeSession();
    await installDeckSessionPolicy(ses as unknown as Session, deckPolicy('protected', { strict: true })).ready;
    expect(ses.proxies[0]).toEqual({ mode: 'fixed_servers', proxyRules: '127.0.0.1:54321', proxyBypassRules: '<-loopback>' });
    expect(await ses.resolveProxy('https://fonts.gstatic.com/')).toBe('PROXY 127.0.0.1:54321');
  });

  it('refuses (the deck is not loaded) when loopback still bypasses the proxy', async () => {
    const ses = new FakeSession();
    ses.honourNoLoopback = false;
    const h = installDeckSessionPolicy(ses as unknown as Session, deckPolicy('protected'));
    await expect(h.ready).rejects.toThrow(/did not apply/);
    expect(PROXY_CHECK_URLS.length).toBeGreaterThan(1);
  });

  it('uses the system proxy for Trusted and after Allow network', async () => {
    for (const p of [deckPolicy('trusted'), deckPolicy('protected', { networkAllowed: true })]) {
      const ses = new FakeSession();
      await installDeckSessionPolicy(ses as unknown as Session, p).ready;
      expect(ses.proxies).toEqual([{ mode: 'system' }]);
    }
  });
});

/** A deck or render view's webContents, with what installDeckWebContentsPolicy touches. */
class FakeViewContents extends FakeWebContents {
  destroyed = false;
  isDestroyed(): boolean {
    return this.destroyed;
  }
  getURL(): string {
    return 'blueline://0a1b2c3d4e5f6a7b/deck.html';
  }
  setWebRTCIPHandlingPolicy(): void {}
}

describe('installDeckWebContentsPolicy: re-installing on one view', () => {
  const opts = (docId: string) => ({
    docId,
    folderReal: '/tmp/deck',
    isProtected: () => true,
    networkOpen: () => false,
    onUserLink: () => undefined,
    openLocalHtml: () => undefined,
    onBlocked: () => undefined,
  });

  it('keeps one listener per event however often a render view re-attaches (one docId per probe load)', () => {
    const wc = new FakeViewContents();
    // A probe run re-attaches its render view once per load, each time under a fresh docId.
    for (let i = 0; i < 15; i++) installDeckWebContentsPolicy(wc as unknown as WebContents, opts(`0a1b2c3d4e5f6a${(16 + i).toString(16)}`));
    for (const ev of ['destroyed', 'will-frame-navigate', 'will-navigate', 'will-redirect', 'will-attach-webview', 'select-bluetooth-device', 'will-prevent-unload']) {
      expect(wc.listenerCount(ev), ev).toBe(1);
    }
    wc.destroyed = true;
    wc.emit('destroyed');
    expect(wc.listenerCount('destroyed')).toBe(0);
  });
});
