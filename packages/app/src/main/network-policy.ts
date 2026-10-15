// Network policy for deck partitions (9.9 Network policy, 6.10). Pure decisions, plus the PAC script that
// the Protected partition's proxy uses for the channels webRequest does not see. trust-hooks.ts wires
// these into Electron.

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
 * wildcard, and a plausible DNS name. Returns null to refuse it.
 */
export function normalizeAllowlistHost(s: string): string | null {
  if (typeof s !== 'string') return null;
  const h = s.trim().toLowerCase();
  if (h.length === 0 || h.length > 253) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(h)) return null;
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
// PAC script for the Protected partition (9.9, Channels that onBeforeRequest does not see).
// ---------------------------------------------------------------------------------------------------

export interface PacOptions {
  /** The closed loopback port every non-allowlisted host is sent to (pickClosedLoopbackPort). */
  blockPort: number;
  /**
   * Dev and CI only: an upstream proxy (`PROXY host:port` or `HTTPS host:port`, see upstreamProxyFromEnv)
   * that allowlisted hosts use instead of DIRECT. Containers without direct outbound HTTPS need it.
   */
  upstream?: string | null;
}

const PROXY_RESULT = /^(PROXY|HTTPS) (\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):([0-9]{1,5})$/;

/**
 * Builds the PAC script for a Protected partition: `DIRECT` (or the dev upstream proxy) for allowlisted
 * hosts, none when `strict`, and `PROXY 127.0.0.1:<blockPort>` for every other host. Preconnects, WebRTC's
 * TCP fallback and anything else that escapes webRequest then connect to a closed port and fail, and
 * because the host name is handed to the (dead) proxy rather than resolved, no DNS query leaves either.
 *
 * Chromium falls back to DIRECT when a PAC script throws or returns nothing it can parse, so the script is
 * deliberately trivial: string comparisons only, no DNS helpers (dnsResolve, isInNet, isResolvable would
 * themselves leak a lookup), and a single non-DIRECT result for everything else. Hosts are re-validated
 * here and embedded with JSON.stringify, so a bad allowlist entry cannot inject code.
 */
export function buildPacScript(allowlist: readonly string[], strict: boolean, opts: PacOptions): string {
  const port = opts.blockPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid block port');
  const block = `PROXY 127.0.0.1:${port}`;
  let pass = 'DIRECT';
  if (opts.upstream != null) {
    if (!PROXY_RESULT.test(opts.upstream)) throw new Error('invalid upstream proxy');
    pass = opts.upstream;
  }
  const hosts = strict ? [] : [...new Set(allowlist.map(normalizeAllowlistHost).filter((h): h is string => h !== null))];
  const lines = [
    'function FindProxyForURL(url, host) {',
    '  var h = String(host).toLowerCase();',
  ];
  for (const h of hosts) lines.push(`  if (h === ${JSON.stringify(h)}) return ${JSON.stringify(pass)};`);
  lines.push(`  return ${JSON.stringify(block)};`, '}', '');
  return lines.join('\n');
}

/** The PAC script as the `data:` URL that `ses.setProxy({ mode: 'pac_script', pacScript })` takes. */
export function pacDataUrl(script: string): string {
  return `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(script, 'utf8').toString('base64')}`;
}

/**
 * Picks the loopback port the Protected PAC sends blocked hosts to. It binds an ephemeral port on
 * 127.0.0.1, closes it, and returns it. Why this port:
 * - it was free a moment ago, so no service of ours or the user's is listening there;
 * - ports from the ephemeral range are not well-known services, and the OS hands them out to outgoing
 *   connections (which never listen) far more often than to listeners;
 * - a fixed low port (1, 9) can be bound by any user on macOS and Windows, so it is no safer, and port 0 is
 *   not a valid proxy port: Chromium would drop the entry and fall back to DIRECT.
 * A connection to it is refused, the proxy attempt fails, and Chromium fails the request (the PAC result
 * has no DIRECT fallback). Residual risk: another local process could later listen on the same port and
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

/**
 * Dev and CI: the upstream proxy from `HTTPS_PROXY` / `https_proxy`, as a PAC result (`PROXY host:port` for
 * an http:// proxy URL, `HTTPS host:port` for https://), or null. Credentials in the URL are not supported
 * by PAC and make this return null. `NO_PROXY` is not consulted. In a normal desktop session the variable
 * is unset and allowlisted hosts go DIRECT, as 9.9 says.
 */
export function upstreamProxyFromEnv(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.HTTPS_PROXY ?? env.https_proxy;
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.username !== '' || u.password !== '') return null;
  const kind = u.protocol === 'http:' ? 'PROXY' : u.protocol === 'https:' ? 'HTTPS' : null;
  if (!kind || !u.hostname) return null;
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  const out = `${kind} ${u.hostname}:${port}`;
  return PROXY_RESULT.test(out) ? out : null;
}
