// Network policy (9.9), the Protected proxy configuration, the test-only layer switch, and the
// navigation/link decisions of trust-hooks (9.9 Navigation and links). Electron is not available here;
// these are the pure parts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_ALLOWLIST,
  PROXY_CHECK_URLS,
  decideRequest,
  disabledProtectedLayers,
  hostAllowlisted,
  normalizeAllowlistHost,
  pickClosedLoopbackPort,
  protectedProxyConfig,
  type RequestFacts,
} from '../../../packages/app/src/main/network-policy';
import {
  LinkTracker,
  classifyLinkTarget,
  classifySubframeNavigation,
  classifyTopNavigation,
  isSelfNavigation,
  openExternalConfirmed,
  parseExternalUrl,
  shellRequestAllowed,
} from '../../../packages/app/src/main/trust-hooks';

const P = (over: Partial<RequestFacts>): RequestFacts => ({
  url: 'https://example.com/',
  method: 'GET',
  resourceType: 'image',
  trust: 'protected',
  networkAllowed: false,
  strict: false,
  allowlist: DEFAULT_ALLOWLIST,
  ...over,
});
const T = (over: Partial<RequestFacts>) => P({ trust: 'trusted', ...over });

describe('default allowlist', () => {
  it('is the 8 CDN hosts of 9.9', () => {
    expect([...DEFAULT_ALLOWLIST].sort()).toEqual(
      ['cdn.jsdelivr.net', 'cdn.tailwindcss.com', 'cdnjs.cloudflare.com', 'code.jquery.com', 'esm.sh', 'fonts.googleapis.com', 'fonts.gstatic.com', 'unpkg.com'],
    );
    expect(Object.isFrozen(DEFAULT_ALLOWLIST)).toBe(true);
  });
  it('matches hosts exactly, case-insensitively, without subdomains', () => {
    expect(hostAllowlisted('fonts.gstatic.com', DEFAULT_ALLOWLIST)).toBe(true);
    expect(hostAllowlisted('FONTS.GSTATIC.COM', DEFAULT_ALLOWLIST)).toBe(true);
    expect(hostAllowlisted('evil.fonts.gstatic.com', DEFAULT_ALLOWLIST)).toBe(false);
    expect(hostAllowlisted('fonts.gstatic.com.evil.example', DEFAULT_ALLOWLIST)).toBe(false);
    expect(hostAllowlisted('gstatic.com', DEFAULT_ALLOWLIST)).toBe(false);
  });
  it('normalizes user-entered hosts and refuses anything else', () => {
    expect(normalizeAllowlistHost('  CDN.Example.COM ')).toBe('cdn.example.com');
    for (const bad of ['', 'localhost', 'data.localhost', '127.0.0.1', '169.254.169.254', '10.0.0.5', '*.example.com', 'https://a.com', 'a.com/x', 'a.com:443', 'a b.com', 'a.com"; return "DIRECT', 'a.com,<-loopback>', '-a.com', 'a..com']) {
      expect(normalizeAllowlistHost(bad), bad).toBeNull();
    }
  });
});

describe('decideRequest — Protected', () => {
  const allowed: [string, Partial<RequestFacts>][] = [
    ['stylesheet from fonts.googleapis.com', { url: 'https://fonts.googleapis.com/css2?family=Inter', resourceType: 'stylesheet' }],
    ['font from fonts.gstatic.com', { url: 'https://fonts.gstatic.com/s/inter/v1/a.woff2', resourceType: 'font' }],
    ['script from cdn.jsdelivr.net', { url: 'https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.js', resourceType: 'script' }],
    ['image from unpkg.com', { url: 'https://unpkg.com/x/logo.png', resourceType: 'image' }],
    ['plain http to the allowlist', { url: 'http://code.jquery.com/jquery.js', resourceType: 'script' }],
    ['explicit default port', { url: 'https://esm.sh:443/x.js', resourceType: 'script' }],
    ['the document itself', { url: 'blueline://0123abcd/deck.html', resourceType: 'mainFrame' }],
    ['a sibling image', { url: 'blueline://0123abcd-files/img.png', resourceType: 'image' }],
    ['a blueline subframe', { url: 'blueline://0123abcd-files/a.svg', resourceType: 'subFrame' }],
    ['data:', { url: 'data:image/png;base64,AAAA', resourceType: 'image' }],
    ['blob:', { url: 'blob:blueline://0123abcd/uuid', resourceType: 'xhr' }],
  ];
  it.each(allowed)('allows %s', (_n, over) => {
    expect(decideRequest(P(over)).cancel).toBe(false);
  });

  const cancelled: [string, Partial<RequestFacts>, string][] = [
    ['image beacon to a non-allowlisted host', { url: 'https://attacker.example/p.gif?d=1', resourceType: 'image' }, 'protected'],
    ['fetch to the allowlist', { url: 'https://cdn.jsdelivr.net/x.json', resourceType: 'xhr' }, 'protected'],
    ['POST to the allowlist', { url: 'https://cdn.jsdelivr.net/x', method: 'POST', resourceType: 'script' }, 'protected'],
    ['HEAD to the allowlist', { url: 'https://cdn.jsdelivr.net/x.js', method: 'HEAD', resourceType: 'script' }, 'protected'],
    ['media from the allowlist', { url: 'https://unpkg.com/a.mp4', resourceType: 'media' }, 'protected'],
    ['object from the allowlist', { url: 'https://unpkg.com/a.swf', resourceType: 'object' }, 'protected'],
    ['subframe to the allowlist', { url: 'https://unpkg.com/a.html', resourceType: 'subFrame' }, 'protected'],
    ['ping (a ping, sendBeacon)', { url: 'https://attacker.example/b', method: 'POST', resourceType: 'ping' }, 'protected'],
    ['CSP report', { url: 'https://attacker.example/r', method: 'POST', resourceType: 'cspReport' }, 'protected'],
    ['WebSocket', { url: 'wss://attacker.example/s', resourceType: 'webSocket' }, 'protected'],
    ['WebSocket to the allowlist', { url: 'wss://cdn.jsdelivr.net/s', resourceType: 'webSocket' }, 'protected'],
    ['plain ws', { url: 'ws://attacker.example/s', resourceType: 'webSocket' }, 'protected'],
    ['non-default port on the allowlist', { url: 'https://cdn.jsdelivr.net:8443/x.js', resourceType: 'script' }, 'protected'],
    ['credentials in the URL', { url: 'https://u:p@cdn.jsdelivr.net/x.js', resourceType: 'script' }, 'protected'],
    ['subdomain of the allowlist', { url: 'https://x.cdn.jsdelivr.net/x.js', resourceType: 'script' }, 'protected'],
    ['top-level navigation', { url: 'https://attacker.example/', resourceType: 'mainFrame' }, 'main-frame'],
    ['fetch of a sibling file', { url: 'blueline://0123abcd-files/secret.png', resourceType: 'xhr' }, 'files-read'],
    ['fetch of a sibling file via the doc host', { url: 'blueline://0123abcd/secret.png', resourceType: 'xhr' }, 'blueline-read'],
    ['fetch of the document', { url: 'blueline://0123abcd/deck.html', resourceType: 'xhr' }, 'blueline-read'],
    ['sendBeacon to blueline', { url: 'blueline://0123abcd/x', method: 'POST', resourceType: 'ping' }, 'blueline-read'],
    ['file:', { url: 'file:///etc/passwd', resourceType: 'image' }, 'file-scheme'],
    ['ftp:', { url: 'ftp://attacker.example/x', resourceType: 'image' }, 'scheme'],
    ['app: from a deck', { url: 'app://shell/index.html', resourceType: 'subFrame' }, 'scheme'],
    ['chrome:', { url: 'chrome://gpu', resourceType: 'subFrame' }, 'scheme'],
    ['devtools:', { url: 'devtools://devtools/x', resourceType: 'script' }, 'scheme'],
    ['garbage', { url: 'not a url' }, 'bad-url'],
  ];
  it.each(cancelled)('cancels %s', (_n, over, reason) => {
    const d = decideRequest(P(over));
    expect(d.cancel).toBe(true);
    expect(d.reason).toBe(reason);
  });

  it('strict blocks the allowlist too', () => {
    expect(decideRequest(P({ strict: true, url: 'https://fonts.gstatic.com/a.woff2', resourceType: 'font' })).cancel).toBe(true);
    // ...but not the document's own files
    expect(decideRequest(P({ strict: true, url: 'blueline://0123abcd-files/a.woff2', resourceType: 'font' })).cancel).toBe(false);
  });

  it('uses the allowlist it is given (user-edited)', () => {
    const allowlist = ['cdn.example.com'];
    expect(decideRequest(P({ allowlist, url: 'https://cdn.example.com/a.js', resourceType: 'script' })).cancel).toBe(false);
    expect(decideRequest(P({ allowlist, url: 'https://fonts.gstatic.com/a.woff2', resourceType: 'font' })).cancel).toBe(true);
  });
});

describe('decideRequest — Trusted and Allow network', () => {
  it.each([
    ['fetch', { url: 'https://api.example.com/x', resourceType: 'xhr' }],
    ['XHR POST', { url: 'https://api.example.com/x', method: 'POST', resourceType: 'xhr' }],
    ['WebSocket', { url: 'wss://api.example.com/s', resourceType: 'webSocket' }],
    ['image', { url: 'https://img.example.com/a.png', resourceType: 'image' }],
    ['media', { url: 'https://v.example.com/a.mp4', resourceType: 'media' }],
    ['subframe', { url: 'https://www.youtube.com/embed/x', resourceType: 'subFrame' }],
    ['blueline fetch', { url: 'blueline://0123abcd/deck.html', resourceType: 'xhr' }],
  ] as [string, Partial<RequestFacts>][])('Trusted allows %s', (_n, over) => {
    expect(decideRequest(T(over)).cancel).toBe(false);
    expect(decideRequest(P({ networkAllowed: true, ...over })).cancel).toBe(false);
  });
  it('still cancels top-level navigation and file:', () => {
    expect(decideRequest(T({ url: 'https://example.com/', resourceType: 'mainFrame' })).cancel).toBe(true);
    expect(decideRequest(T({ url: 'file:///etc/passwd', resourceType: 'image' })).cancel).toBe(true);
    expect(decideRequest(P({ networkAllowed: true, url: 'file:///x', resourceType: 'xhr' })).cancel).toBe(true);
    expect(decideRequest(T({ url: 'chrome://settings', resourceType: 'subFrame' })).cancel).toBe(true);
  });
  it('never lets fetch, XHR or beacons read the -files host, in either trust state', () => {
    for (const over of [{ trust: 'trusted' as const }, { networkAllowed: true }, {}]) {
      for (const resourceType of ['xhr', 'ping']) {
        const d = decideRequest(P({ ...over, url: 'blueline://0123abcd-files/photo.jpg', resourceType }));
        expect(d).toEqual({ cancel: true, reason: 'files-read' });
      }
      // Display loads stay allowed.
      for (const resourceType of ['image', 'stylesheet', 'script', 'font', 'media', 'subFrame', 'object', 'other']) {
        expect(decideRequest(P({ ...over, url: 'blueline://0123abcd-files/a.png', resourceType })).cancel, resourceType).toBe(false);
      }
    }
    // Trusted may fetch the document itself; a fetch of another path on the doc host is allowed here and its
    // redirected -files leg is cancelled.
    expect(decideRequest(T({ url: 'blueline://0123abcd/deck.html', resourceType: 'xhr' })).cancel).toBe(false);
    expect(decideRequest(T({ url: 'blueline://0123abcd/img.png', resourceType: 'xhr' })).cancel).toBe(false);
  });
  it('strict does not affect Trusted', () => {
    expect(decideRequest(T({ strict: true, url: 'https://api.example.com/x', resourceType: 'xhr' })).cancel).toBe(false);
  });
});

describe('decideRequest — blueline-media:// (finding 7)', () => {
  // Media is served only from blueline-media://<docId>/ (protocol.ts). Only a media element may load it:
  // fetch, XHR, beacons, frames, images, scripts and styles are cancelled in both trust states.
  const url = 'blueline-media://0123abcd/clip.webm';
  it('allows media element loads in every trust state', () => {
    for (const f of [P({ url, resourceType: 'media' }), T({ url, resourceType: 'media' }), P({ url, resourceType: 'media', networkAllowed: true })]) {
      expect(decideRequest(f)).toEqual({ cancel: false, reason: 'blueline' });
    }
  });
  it.each(['xhr', 'ping', 'image', 'stylesheet', 'script', 'font', 'subFrame', 'mainFrame', 'object', 'other', 'webSocket', 'cspReport'])(
    'cancels %s in every trust state',
    (resourceType) => {
      for (const f of [P({ url, resourceType }), T({ url, resourceType }), P({ url, resourceType, networkAllowed: true })]) {
        expect(decideRequest(f)).toEqual({ cancel: true, reason: 'media-only' });
      }
    },
  );
});

describe('Protected proxy configuration (finding 8)', () => {
  // 9.9 Channels that onBeforeRequest does not see: a PAC script cannot cover loopback or link-local hosts,
  // because Chromium bypasses the proxy for them before it consults the PAC (a Protected deck reached
  // 127.0.0.1 over WebRTC TURN/TCP). fixed_servers with '<-loopback>' in the bypass list removes that
  // implicit bypass, so every host but the allowlist goes to the closed port.
  const blockPort = 54321;
  it('sends every host to the closed loopback port, the allowlist DIRECT, and drops the implicit loopback bypass', () => {
    const c = protectedProxyConfig(DEFAULT_ALLOWLIST, false, { blockPort });
    expect(c.mode).toBe('fixed_servers');
    expect(c.proxyRules).toBe('127.0.0.1:54321');
    const bypass = c.proxyBypassRules.split(',');
    expect(bypass[bypass.length - 1]).toBe('<-loopback>');
    expect(bypass.slice(0, -1).sort()).toEqual([...DEFAULT_ALLOWLIST].sort());
  });
  it('strict bypasses nothing: even the allowlist goes to the closed port', () => {
    const c = protectedProxyConfig(DEFAULT_ALLOWLIST, true, { blockPort });
    expect(c).toEqual({ mode: 'fixed_servers', proxyRules: '127.0.0.1:54321', proxyBypassRules: '<-loopback>' });
  });
  it('uses the allowlist it is given, normalized, and drops entries that are not plain hosts', () => {
    const c = protectedProxyConfig(['  CDN.Example.COM ', 'cdn.example.com', '*.evil.com', 'a.com,<-loopback>', 'x;y.com', '127.0.0.1', '169.254.169.254', 'localhost', 'x.localhost', '<local>', 'a.com:443', ''], false, { blockPort });
    expect(c.proxyBypassRules).toBe('cdn.example.com,<-loopback>');
  });
  it('refuses invalid ports', () => {
    for (const bad of [0, -1, 65536, 1.5, NaN]) expect(() => protectedProxyConfig([], false, { blockPort: bad })).toThrow();
  });
  it('checks a non-allowlisted name and the loopback and link-local addresses after applying it', () => {
    // trust-hooks applyProxy resolves each of these and refuses to load the deck unless every one goes
    // to the closed port.
    const hosts = PROXY_CHECK_URLS.map((u) => new URL(u).hostname);
    expect(hosts).toEqual(expect.arrayContaining(['blueline-proxy-check.invalid', '127.0.0.1', 'localhost', '[::1]', '169.254.169.254']));
    for (const u of PROXY_CHECK_URLS) expect(hostAllowlisted(new URL(u).hostname, DEFAULT_ALLOWLIST)).toBe(false);
  });
});

describe('closed loopback port', () => {
  it('picks a port nothing listens on', async () => {
    const port = await pickClosedLoopbackPort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
    const err = await new Promise<string>((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port });
      s.once('connect', () => {
        s.destroy();
        resolve('connected');
      });
      s.once('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error'));
    });
    expect(err).toBe('ECONNREFUSED');
  });
});

describe('disabledProtectedLayers (test-only switch, finding 41)', () => {
  // 9.9: "the security fixtures check each layer on its own". BLUELINE_TEST_DISABLE_LAYER turns one Protected
  // layer off, only in an unpackaged build started with BLUELINE_TEST=1.
  const on = { BLUELINE_TEST: '1' };
  it('is empty unless BLUELINE_TEST=1 and the app is not packaged', () => {
    expect(disabledProtectedLayers({ BLUELINE_TEST_DISABLE_LAYER: 'csp,requests,proxy' }, false).size).toBe(0);
    expect(disabledProtectedLayers({ BLUELINE_TEST: 'true', BLUELINE_TEST_DISABLE_LAYER: 'csp' }, false).size).toBe(0);
    expect(disabledProtectedLayers({ ...on, BLUELINE_TEST_DISABLE_LAYER: 'csp,requests,proxy' }, true).size).toBe(0);
    expect(disabledProtectedLayers({ ...on }, false).size).toBe(0);
    expect(disabledProtectedLayers({}, false).size).toBe(0);
  });
  it('parses a comma list of csp, requests and proxy, and ignores anything else', () => {
    expect([...disabledProtectedLayers({ ...on, BLUELINE_TEST_DISABLE_LAYER: 'csp' }, false)]).toEqual(['csp']);
    expect([...disabledProtectedLayers({ ...on, BLUELINE_TEST_DISABLE_LAYER: ' proxy , CSP,requests,,' }, false)].sort()).toEqual(['csp', 'proxy', 'requests']);
    expect([...disabledProtectedLayers({ ...on, BLUELINE_TEST_DISABLE_LAYER: 'all,files-read,navigation' }, false)]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------
// trust-hooks: navigation and links (9.9)
// ---------------------------------------------------------------------------------------------------

const DOC = '0123456789abcdef';
const CUR = `blueline://${DOC}/deck.html`;

describe('classifyTopNavigation', () => {
  it('allows only a same-document fragment change', () => {
    expect(classifyTopNavigation(CUR, `${CUR}#slide-2`, true)).toBe('allow');
    expect(classifyTopNavigation(`${CUR}#a`, `${CUR}#b`, true)).toBe('allow');
  });
  it.each([
    [`${CUR}#slide-2`, false, 'cross-document even if only the fragment differs'],
    [`${CUR}?x=1#a`, true, 'query change'],
    [`blueline://${DOC}/other.html`, true, 'other file'],
    [`blueline://${DOC}/other.html`, false, 'other file'],
    ['https://example.com/', false, 'web'],
    ['javascript:alert(1)', false, 'javascript'],
    ['file:///etc/passwd', false, 'file'],
    ['not a url', true, 'garbage'],
  ])('cancels %s (sameDocument=%s, %s)', (target, same) => {
    expect(classifyTopNavigation(CUR, target, same)).toBe('cancel');
  });
});

describe('shellRequestAllowed', () => {
  it('lets the shell load only app://shell/', () => {
    expect(shellRequestAllowed('app://shell/index.html')).toBe(true);
    expect(shellRequestAllowed('app://shell/shell.js?x')).toBe(true);
    for (const u of ['app://other/x.js', 'app://shell:1/x', 'https://example.com/', 'blueline://0123abcd/deck.html', 'file:///etc/passwd', 'data:text/html,x', 'nope']) {
      expect(shellRequestAllowed(u), u).toBe(false);
    }
  });
});

describe('isSelfNavigation', () => {
  it('is true only for the same URL apart from the fragment', () => {
    expect(isSelfNavigation(CUR, CUR)).toBe(true);
    expect(isSelfNavigation(`${CUR}#a`, `${CUR}#b`)).toBe(true);
    expect(isSelfNavigation(CUR, `${CUR}?x=1`)).toBe(false);
    expect(isSelfNavigation(CUR, `blueline://${DOC}/other.html`)).toBe(false);
    expect(isSelfNavigation(CUR, `blueline://${DOC}-files/deck.html`)).toBe(false);
    expect(isSelfNavigation('', CUR)).toBe(false);
  });
});

describe('classifySubframeNavigation', () => {
  const closed = { docId: DOC, networkOpen: false };
  const open = { docId: DOC, networkOpen: true };
  it.each(['about:blank', 'about:srcdoc', 'data:text/html,hi', `blob:blueline://${DOC}/x`, `blueline://${DOC}-files/a.svg`, `blueline://${DOC}/deck.html`])(
    'allows %s',
    (u) => {
      expect(classifySubframeNavigation(u, closed)).toBe('allow');
    },
  );
  it('allows http(s) frames only while the network is open', () => {
    expect(classifySubframeNavigation('https://www.youtube.com/embed/x', closed)).toBe('cancel');
    expect(classifySubframeNavigation('http://127.0.0.1:9/form', closed)).toBe('cancel');
    expect(classifySubframeNavigation('https://www.youtube.com/embed/x', open)).toBe('allow');
  });
  it.each(['file:///etc/passwd', `blueline://fedcba9876543210/deck.html`, `blueline-media://${DOC}/clip.mp4`, 'app://shell/index.html', 'chrome://gpu', 'zoommtg://x', 'about:config', 'nope'])(
    'cancels %s',
    (u) => {
      expect(classifySubframeNavigation(u, open)).toBe('cancel');
    },
  );
});

describe('parseExternalUrl and openExternalConfirmed', () => {
  it('accepts only http, https and mailto', () => {
    expect(parseExternalUrl('https://example.com')).toBe('https://example.com/');
    expect(parseExternalUrl('http://example.com/a?b#c')).toBe('http://example.com/a?b#c');
    expect(parseExternalUrl('mailto:a@b.example?subject=hi')).toBe('mailto:a@b.example?subject=hi');
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'smb://host/share', 'ms-settings:x', 'blueline://x/y', 'data:text/html,x', 'http://', 'nope', 'https://' + 'a'.repeat(20000) + '.com']) {
      expect(parseExternalUrl(bad), bad.slice(0, 40)).toBeNull();
    }
  });
  it('opens only after confirmation, and only those schemes', async () => {
    const opened: string[] = [];
    const open = async (u: string) => {
      opened.push(u);
    };
    expect(await openExternalConfirmed('https://example.com', async () => true, open)).toBe(true);
    expect(await openExternalConfirmed('https://declined.example', async () => false, open)).toBe(false);
    let asked = false;
    expect(
      await openExternalConfirmed(
        'file:///etc/passwd',
        async () => {
          asked = true;
          return true;
        },
        open,
      ),
    ).toBe(false);
    expect(asked).toBe(false);
    expect(opened).toEqual(['https://example.com/']);
  });
});

describe('classifyLinkTarget', () => {
  let folder: string;
  beforeAll(() => {
    folder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bl-links-')));
    fs.writeFileSync(path.join(folder, 'deck.html'), 'x');
    fs.mkdirSync(path.join(folder, 'more'));
    fs.writeFileSync(path.join(folder, 'more', 'Other.HTM'), 'x');
    fs.writeFileSync(path.join(folder, 'img.png'), 'x');
    fs.writeFileSync(path.join(folder, '..', `bl-links-outside-${process.pid}.html`), 'x');
    fs.symlinkSync(path.join(folder, '..', `bl-links-outside-${process.pid}.html`), path.join(folder, 'out.html'));
  });
  afterAll(() => {
    fs.rmSync(folder, { recursive: true, force: true });
    fs.rmSync(path.join(folder, '..', `bl-links-outside-${process.pid}.html`), { force: true });
  });
  it('routes web and mail links outside', () => {
    expect(classifyLinkTarget('https://example.com/x', { docId: DOC, folderReal: folder })).toEqual({ kind: 'external', url: 'https://example.com/x' });
    expect(classifyLinkTarget('mailto:a@b.example', { docId: DOC, folderReal: folder }).kind).toBe('external');
  });
  it('opens local .html/.htm files inside the folder in Blueline', () => {
    expect(classifyLinkTarget(`blueline://${DOC}/more/Other.HTM`, { docId: DOC, folderReal: folder })).toEqual({
      kind: 'local-html',
      realpath: path.join(folder, 'more', 'Other.HTM'),
    });
    expect(classifyLinkTarget(`blueline://${DOC}/deck.html?x#y`, { docId: DOC, folderReal: folder }).kind).toBe('local-html');
    expect(classifyLinkTarget(`blueline://${DOC}-files/deck.html`, { docId: DOC, folderReal: folder }).kind).toBe('local-html');
  });
  it.each([
    ['file:///etc/passwd', 'scheme'],
    ['tel:+15555550100', 'scheme'],
    ['javascript:alert(1)', 'scheme'],
    [`blueline://fedcba9876543210/deck.html`, 'outside'],
    [`blueline://${DOC}/img.png`, 'not-html'],
    [`blueline://${DOC}/out.html`, 'not-html'],
    [`blueline://${DOC}/missing.html`, 'not-html'],
    [`blueline://${DOC}/%2e%2e/x.html`, 'not-html'],
  ])('blocks %s', (u, why) => {
    const t = classifyLinkTarget(u, { docId: DOC, folderReal: folder });
    expect(t.kind).toBe('blocked');
    expect(t.kind === 'blocked' && t.why).toBe(why);
  });
});

describe('LinkTracker', () => {
  function setup(opts: { graceMs?: number; clickTtlMs?: number } = {}) {
    let now = 1000;
    const timers: { at: number; fn: () => void; id: number }[] = [];
    let nextId = 1;
    const routed: [string, boolean][] = [];
    const t = new LinkTracker((u, c) => routed.push([u, c]), {
      now: () => now,
      setTimer: (fn, ms) => {
        const id = nextId++;
        timers.push({ at: now + ms, fn, id });
        return id;
      },
      clearTimer: (id) => {
        const i = timers.findIndex((x) => x.id === id);
        if (i !== -1) timers.splice(i, 1);
      },
      ...opts,
    });
    const advance = (ms: number) => {
      now += ms;
      for (const x of [...timers].sort((a, b) => a.at - b.at)) {
        if (x.at <= now) {
          timers.splice(timers.indexOf(x), 1);
          x.fn();
        }
      }
    };
    return { t, routed, advance };
  }

  it('a click then a navigation to the same URL is a user link', () => {
    const { t, routed } = setup();
    t.noteClick('https://example.com');
    t.attempt('https://example.com/');
    expect(routed).toEqual([['https://example.com/', true]]);
  });
  it('a navigation then a late click (within the grace period) is a user link', () => {
    const { t, routed, advance } = setup();
    t.attempt('https://example.com/');
    advance(100);
    t.noteClick('https://example.com/');
    advance(1000);
    expect(routed).toEqual([['https://example.com/', true]]);
  });
  it('a navigation without a click is blocked after the grace period', () => {
    const { t, routed, advance } = setup();
    t.attempt('https://attacker.example/');
    expect(routed).toEqual([]);
    advance(299);
    expect(routed).toEqual([]);
    advance(1);
    expect(routed).toEqual([['https://attacker.example/', false]]);
  });
  it('a click on another URL does not authorize a navigation', () => {
    const { t, routed, advance } = setup();
    t.noteClick('https://example.com/a');
    t.attempt('https://attacker.example/');
    advance(500);
    expect(routed).toEqual([['https://attacker.example/', false]]);
  });
  it('a click expires after ~2 s', () => {
    const { t, routed, advance } = setup();
    t.noteClick('https://example.com/');
    advance(2001);
    t.attempt('https://example.com/');
    advance(500);
    expect(routed).toEqual([['https://example.com/', false]]);
  });
  it('one click authorizes one attempt', () => {
    const { t, routed, advance } = setup();
    t.noteClick('https://example.com/');
    t.attempt('https://example.com/');
    advance(1500); // past the dedupe window
    t.attempt('https://example.com/');
    advance(500);
    expect(routed).toEqual([
      ['https://example.com/', true],
      ['https://example.com/', false],
    ]);
  });
  it('drops the duplicate attempt from will-frame-navigate + will-navigate', () => {
    const { t, routed, advance } = setup();
    t.noteClick('mailto:a@b.example');
    t.attempt('mailto:a@b.example');
    t.attempt('mailto:a@b.example');
    advance(1000);
    expect(routed).toEqual([['mailto:a@b.example', true]]);
    t.attempt('https://x.example/');
    t.attempt('https://x.example/');
    advance(1000);
    expect(routed.slice(1)).toEqual([['https://x.example/', false]]);
  });
  it('dispose cancels pending timers', () => {
    const { t, routed, advance } = setup();
    t.attempt('https://x.example/');
    t.dispose();
    advance(1000);
    t.noteClick('https://x.example/');
    t.attempt('https://y.example/');
    expect(routed).toEqual([]);
  });
});
