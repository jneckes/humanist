// Network policy for deck partitions (9.9 Network policy, 6.10). Pure decisions, plus the proxy
// configuration the Protected partition uses for the channels webRequest does not see, and the test-only
// switch that turns one Protected layer off. trust-hooks.ts and protocol.ts wire these into Electron.

import * as net from 'node:net';
import type { TrustState } from '@blueline/core/ipc';

/** 9.9: the CDN allowlist. Protected view lets GETs of styles, scripts, fonts and images through to these. */
export const DEFAULT_ALLOWLIST: readonly string[] = Object.freeze([
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'esm.sh',
  'cdn.tailwindcss.com',
  'code.jquery.com',
]);

/** Resource types a Protected deck may fetch from the allowlist (9.9). */
export const PROTECTED_ALLOWED_TYPES: ReadonlySet<string> = new Set(['stylesheet', 'script', 'font', 'image']);

/** Everything decideRequest needs to know about one request and the document's current state. */
export interface RequestFacts {
  url: string;
  method: string;
  /** Electron's webRequest resourceType (`mainFrame`, `subFrame`, `stylesheet`, `xhr`, `ping`, …). */
  resourceType: string;
  trust: TrustState;
  /** **Allow network** was pressed for this file: the Trusted network policy applies (6.10). */
  networkAllowed: boolean;
  /** Settings › Trust "Block all network in Protected view": the allowlist is blocked too. */
  strict: boolean;
  allowlist: readonly string[];
}

/**
 * webRequest types through which a page reads a response's bytes: `xhr` is how Electron reports both
 * fetch() and XMLHttpRequest, `ping` is sendBeacon and `<a ping>`.
 */
export const READ_TYPES: ReadonlySet<string> = new Set(['xhr', 'ping']);

export type RequestReason =
  | 'bad-url'
  | 'file-scheme'
  | 'blueline'
  | 'files-read' // fetch/XHR of a -files URL, in both trust states (Electron enforces no CORS on custom schemes)
  | 'blueline-read' // Protected: blueline:// xhr (fetch) or ping, the second layer behind connect-src 'none'
  | 'media-only' // blueline-media:// loaded by anything but a media element, in both trust states
  | 'local'
  | 'main-frame' // a top-level load of anything but blueline://: navigation never leaves the document
  | 'trusted'
  | 'allowlisted'
  | 'protected'
  | 'scheme';

export interface RequestDecision {
  cancel: boolean;
  reason: RequestReason;
}

/** True when the Trusted network policy applies: a Trusted file, or a Protected one after Allow network. */
export function networkOpen(trust: TrustState, networkAllowed: boolean): boolean {
  return trust === 'trusted' || networkAllowed === true;
}

/**
 * Normalizes a user-entered allowlist host (Settings › Trust): lowercase, no scheme, port, path or
 * wildcard, and a plausible DNS name. Returns null to refuse it. An IP address (the last label is all
 * digits) and the loopback names `localhost` and `*.localhost` are refused: an allowlisted host bypasses
 * the Protected proxy, and loopback and link-local hosts must never do that (finding 8).
 */
export function normalizeAllowlistHost(s: string): string | null {
  if (typeof s !== 'string') return null;
  const h = s.trim().toLowerCase();
  if (h.length === 0 || h.length > 253) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(h)) return null;
  if (/^[0-9]+$/.test(h.slice(h.lastIndexOf('.') + 1)) || h.endsWith('.localhost')) return null;
  return h;
}

/** Exact, case-insensitive host match against the allowlist (no subdomains, no wildcards). */
export function hostAllowlisted(host: string, allowlist: readonly string[]): boolean {
  const h = host.toLowerCase();
  for (const a of allowlist) if (typeof a === 'string' && a.toLowerCase() === h) return true;
  return false;
}

/**
 * The single onBeforeRequest decision for a deck partition (9.9 Network policy).
 *
 * - `file:` is always cancelled; no page loads from `file://` and none may read it.
 * - `blueline:` is the document's own handler. A fetch or XHR of a `-files` URL is cancelled in both trust
 *   states: Electron 44 does not enforce CORS on custom-protocol responses (Phase 0 finding), so without
 *   this a Trusted page could read its folder's files, which 9.1 Serving forbids. webRequest sees the
 *   redirected leg too, so `fetch('img.png')` (307 to `-files`) is cancelled as well. In Protected (without
 *   Allow network) every blueline `xhr` (which is how webRequest reports `fetch()`) and `ping`
 *   (`sendBeacon`) request is cancelled as a second layer behind `connect-src 'none'`.
 * - `blueline-media:` serves the folder's audio and video (protocol.ts). Only a media element may load it
 *   (resource type `media`); fetch, XHR, beacons, frames and every other type are cancelled in both trust
 *   states. Blink already refuses CORS-mode requests to this scheme, since it is not CORS-enabled.
 * - `data:`, `blob:` and `about:` never touch the network.
 * - `http`, `https`, `ws`, `wss`: a top-level (`mainFrame`) load is always cancelled, because navigation is
 *   decided by trust-hooks and never leaves the document. Otherwise Trusted (or Allow network) allows
 *   subresources, fetch and XHR. Protected cancels everything except a `GET` of a stylesheet, script, font
 *   or image over http(s), on the default port, to an allowlisted host, and the strict option blocks
 *   those too.
 * - Any other scheme is cancelled.
 */
export function decideRequest(f: RequestFacts): RequestDecision {
  let u: URL;
  try {
    u = new URL(f.url);
  } catch {
    return { cancel: true, reason: 'bad-url' };
  }
  const open = networkOpen(f.trust, f.networkAllowed);
  switch (u.protocol) {
    case 'file:':
      return { cancel: true, reason: 'file-scheme' };
    case 'blueline:':
      if (READ_TYPES.has(f.resourceType)) {
        if (u.hostname.endsWith('-files')) return { cancel: true, reason: 'files-read' };
        if (!open) return { cancel: true, reason: 'blueline-read' };
      }
      return { cancel: false, reason: 'blueline' };
    case 'blueline-media:':
      return f.resourceType === 'media' ? { cancel: false, reason: 'blueline' } : { cancel: true, reason: 'media-only' };
    case 'data:':
    case 'blob:':
    case 'about:':
      return { cancel: false, reason: 'local' };
    case 'http:':
    case 'https:':
    case 'ws:':
    case 'wss:': {
      if (f.resourceType === 'mainFrame') return { cancel: true, reason: 'main-frame' };
      if (open) return { cancel: false, reason: 'trusted' };
      const fetchable =
        (u.protocol === 'http:' || u.protocol === 'https:') &&
        String(f.method).toUpperCase() === 'GET' &&
        PROTECTED_ALLOWED_TYPES.has(f.resourceType) &&
        u.port === '' &&
        u.username === '' &&
        u.password === '';
      if (!f.strict && fetchable && hostAllowlisted(u.hostname, f.allowlist)) return { cancel: false, reason: 'allowlisted' };
      return { cancel: true, reason: 'protected' };
    }
    default:
      return { cancel: true, reason: 'scheme' };
  }
}

// ---------------------------------------------------------------------------------------------------
// The Protected partition's proxy (9.9, Channels that onBeforeRequest does not see).
// ---------------------------------------------------------------------------------------------------

export interface ProxyOptions {
  /** The closed loopback port every non-allowlisted host is sent to (pickClosedLoopbackPort). */
  blockPort: number;
}

/** The `ses.setProxy()` configuration of a Protected partition (Electron's ProxyConfig, fixed_servers). */
export interface ProtectedProxyConfig {
  mode: 'fixed_servers';
  proxyRules: string;
  proxyBypassRules: string;
}

/**
 * Builds the proxy configuration of a Protected partition: every host goes to `127.0.0.1:<blockPort>` (a
 * closed port), except the allowlisted hosts, which go DIRECT (none when `strict`). Preconnects, WebRTC's
 * TCP fallback and anything else that escapes webRequest then connect to a closed port and fail, and
 * because the host name is handed to the (dead) proxy rather than resolved, no DNS query leaves for them.
 *
 * Why fixed_servers and not a PAC script (finding 8): Chromium bypasses the proxy for loopback and
 * link-local hosts (`localhost`, `*.localhost`, 127.0.0.0/8, `[::1]`, 169.254.0.0/16, `[fe80::]/10`) before
 * it consults a PAC script, so with a PAC a Protected deck reached local services over WebRTC TURN/TCP.
 * In a fixed_servers bypass list, `<-loopback>` removes that implicit bypass; a PAC has no equivalent.
 * fixed_servers has no per-host proxy either, so the allowlist can only go DIRECT (as 9.9 says): an
 * upstream proxy from `HTTPS_PROXY` is not used in Protected view.
 *
 * Hosts are re-validated (normalizeAllowlistHost), so an entry cannot add a bypass rule of its own (a
 * comma, `<local>`, `<-loopback>`, a wildcard or an IP range).
 */
export function protectedProxyConfig(allowlist: readonly string[], strict: boolean, opts: ProxyOptions): ProtectedProxyConfig {
  const port = opts.blockPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid block port');
  const hosts = strict ? [] : [...new Set(allowlist.map(normalizeAllowlistHost).filter((h): h is string => h !== null))];
  return { mode: 'fixed_servers', proxyRules: `127.0.0.1:${port}`, proxyBypassRules: [...hosts, '<-loopback>'].join(',') };
}

/**
 * URLs trust-hooks resolves after applying the Protected proxy. Every one must go to the closed port, or
 * the deck is not loaded: a name that is not allowlisted, and the loopback and link-local hosts Chromium
 * would otherwise bypass the proxy for. If a Chromium upgrade stops honouring `<-loopback>`, Protected
 * decks then fail closed instead of reaching local services.
 */
export const PROXY_CHECK_URLS: readonly string[] = Object.freeze([
  'https://blueline-proxy-check.invalid/',
  'https://127.0.0.1/',
  'https://localhost/',
  'https://[::1]/',
  'https://169.254.169.254/',
]);

/**
 * Picks the loopback port the Protected proxy sends blocked hosts to. It binds an ephemeral port on
 * 127.0.0.1, closes it, and returns it. Why this port:
 * - it was free a moment ago, so no service of ours or the user's is listening there;
 * - ports from the ephemeral range are not well-known services, and the OS hands them out to outgoing
 *   connections (which never listen) far more often than to listeners;
 * - a fixed low port (1, 9) can be bound by any user on macOS and Windows, so it is no safer, and port 0 is
 *   not a valid proxy port: Chromium would drop the entry and fall back to DIRECT.
 * A connection to it is refused, the proxy attempt fails, and Chromium fails the request (the proxy rules
 * have no DIRECT fallback). Residual risk: another local process could later listen on the same port and
 * would then see proxied host names (never the requests' contents for https). Pick once per app launch.
 */
export async function pickClosedLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error('no port'))));
    });
  });
}

// ---------------------------------------------------------------------------------------------------
// Test-only: turning one Protected layer off (9.9: "the security fixtures check each layer on its own").
// ---------------------------------------------------------------------------------------------------

/** The three layers of the Protected network policy (9.9). */
export type ProtectedLayer = 'csp' | 'requests' | 'proxy';
const LAYERS: ReadonlySet<string> = new Set<ProtectedLayer>(['csp', 'requests', 'proxy']);

/**
 * The Protected layers `BLUELINE_TEST_DISABLE_LAYER` (a comma list of `csp`, `requests`, `proxy`) turns off.
 * Honoured only when `BLUELINE_TEST=1` and the app is not packaged, so a release build never reads it:
 * - `csp`: the document is served without `Content-Security-Policy: connect-src 'none'` (protocol.ts);
 * - `requests`: onBeforeRequest no longer cancels for the Protected reasons `protected` and
 *   `blueline-read` (trust-hooks.ts); the reasons that hold in both trust states stay;
 * - `proxy`: the partition uses the system proxy instead of the closed-port proxy (trust-hooks.ts).
 * The security suite's layers spec turns two off at a time, so each layer is checked on its own.
 */
export function disabledProtectedLayers(env: Record<string, string | undefined>, isPackaged: boolean): ReadonlySet<ProtectedLayer> {
  const out = new Set<ProtectedLayer>();
  if (env.BLUELINE_TEST !== '1' || isPackaged) return out;
  for (const part of String(env.BLUELINE_TEST_DISABLE_LAYER ?? '').split(',')) {
    const name = part.trim().toLowerCase();
    if (LAYERS.has(name)) out.add(name as ProtectedLayer);
  }
  return out;
}
