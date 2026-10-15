// Materializing the security fixtures and the files they probe into a temp folder (fixtures/security/README.md).
//
// A fixture under fixtures/security/ is a template. prepareFixtureFolder() copies the templates into a fresh
// folder, replaces the placeholders with this run's values, inlines the shared probe runtime, and writes the
// sibling and outside files the fixtures try to read (so none of them lives in the repo): sibling.css,
// sibling.js, sibling-throws.js, sibling.png, sibling.svg, secret.txt, a fake .ssh/id_rsa, symlinks that lead
// out of the folder, and an outside/ folder next to it.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { FIXTURES, launchApp, resolveDns, type BlApp, type DeckView, type DnsRouting, type Scratch } from './app';
import { sharedDnsServer, TestNet, type DnsServer } from './servers';

const SECURITY = path.join(FIXTURES, 'security');

export interface NetConfig {
  /** Unique per run and trust state; every probe host and path carries it. */
  uniq: string;
  /** The DNS zone the suite answers (bl-attacker.test). */
  zone: string;
  /** Recording HTTP + WebSocket server. */
  port: number;
  /** UDP listener (STUN/TURN/QUIC). */
  udp: number;
  /** TCP listener (TURN over TCP). */
  tcp: number;
  /** The non-loopback address the zone resolves to and the listeners bind to (the "test host" by address). */
  sink: string;
}

/** A 1×1 PNG, a tiny SVG and a CSS file, as sibling display files. */
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#38f"/></svg>\n';

const PROBE = fs.readFileSync(path.join(SECURITY, '_probe.js'), 'utf8');

/** Substitutes placeholders and inlines the probe runtime for one fixture. */
export function renderFixture(html: string, cfg: NetConfig): string {
  return html
    .split('__BL_CFG__')
    .join(JSON.stringify(cfg))
    .split('/*__BL_PROBE__*/')
    .join(PROBE)
    .split('__BL_UNIQ__')
    .join(cfg.uniq)
    .split('__BL_ZONE__')
    .join(cfg.zone)
    .split('__BL_SINK__')
    .join(cfg.sink)
    .split('__BL_PORT__')
    .join(String(cfg.port))
    .split('__BL_UDP__')
    .join(String(cfg.udp))
    .split('__BL_TCP__')
    .join(String(cfg.tcp));
}

export interface FixtureFolder {
  dir: string;
  /** The absolute path of a prepared fixture by its base name (e.g. 'network.html'). */
  file(name: string): string;
}

/**
 * Prepares a folder with every security fixture rendered for `cfg`, plus the sibling and outside files. The
 * folder is owned by the user the app runs as (Scratch.own), so the protocol handler's realpath checks run
 * against files bltest can stat. Returns the folder and a resolver for fixture paths.
 */
export function prepareFixtureFolder(scratch: Scratch, cfg: NetConfig): FixtureFolder {
  const base = scratch.dir('sec');
  const dir = path.join(base, 'docs');
  fs.mkdirSync(dir, { recursive: true });

  // The fixtures (templates → rendered copies).
  for (const name of fs.readdirSync(SECURITY)) {
    if (!name.endsWith('.html')) continue;
    const html = fs.readFileSync(path.join(SECURITY, name), 'utf8');
    fs.writeFileSync(path.join(dir, name), renderFixture(html, cfg));
  }

  // Sibling display files (served from the -files origin; the page may show but not read them).
  fs.writeFileSync(path.join(dir, 'sibling.css'), '/* sibling stylesheet */\n#bl-sibling-css-probe { color: rgb(1, 2, 3) !important; }\n');
  fs.writeFileSync(path.join(dir, 'sibling.js'), 'window.__blSiblingScript = (window.__blSiblingScript || 0) + 1;\n');
  // A sibling module script, to confirm module loads from the -files origin fail (as on file://).
  fs.writeFileSync(path.join(dir, 'sibling.mjs'), 'window.__blSiblingModule = true;\nexport const x = 1;\n');
  // A sibling script that throws, to confirm its error is muted cross-origin (no readable message).
  fs.writeFileSync(path.join(dir, 'sibling-throws.js'), 'throw new Error("sibling-secret-" + Math.random());\n');
  fs.writeFileSync(path.join(dir, 'sibling-worker.js'), 'self.postMessage("worker-ran");\n');
  fs.writeFileSync(path.join(dir, 'sibling.png'), PNG_1X1);
  fs.writeFileSync(path.join(dir, 'sibling.svg'), SVG);
  // A file whose bytes the page must never read (SPEC: fetch('../secret.txt'), a sibling file).
  fs.writeFileSync(path.join(dir, 'confidential.txt'), 'CONFIDENTIAL-' + cfg.uniq + '\n');
  fs.writeFileSync(path.join(base, 'confidential.txt'), 'PARENT-CONFIDENTIAL-' + cfg.uniq + '\n');

  // A fake .ssh/id_rsa inside the folder (SPEC: a request for .ssh/id_rsa; dotfiles must be refused).
  const ssh = path.join(dir, '.ssh');
  fs.mkdirSync(ssh, { recursive: true });
  fs.writeFileSync(path.join(ssh, 'id_rsa'), fakeKey(cfg.uniq), { mode: 0o600 });
  // Same bytes under an allowed extension, so only the dotfile rule (not the extension rule) refuses it.
  fs.writeFileSync(path.join(ssh, 'id_rsa.css'), fakeKey(cfg.uniq));

  // An outside/ folder a `..` or symlink would reach.
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'outside.css'), '#bl-outside { color: rgb(9, 9, 9) !important; }\n');
  fs.writeFileSync(path.join(outside, 'outside.js'), 'window.__blOutsideScript = true;\n');
  fs.writeFileSync(path.join(outside, 'outside.png'), PNG_1X1);
  fs.writeFileSync(path.join(outside, 'outside.txt'), 'OUTSIDE-' + cfg.uniq + '\n');

  // Symlinks inside the folder that lead out of it (SPEC 9.1 Refusals step 3: a symlink out is refused).
  trySymlink(path.join(outside, 'outside.css'), path.join(dir, 'link-outside.css'));
  trySymlink(outside, path.join(dir, 'link-outside-dir'));
  trySymlink('/etc/hostname', path.join(dir, 'link-etc.css'));

  scratch.own(base);
  return {
    dir,
    file(name: string) {
      return path.join(dir, name);
    },
  };
}

function fakeKey(uniq: string): string {
  // A fake, clearly-marked placeholder key; never a real one.
  return `-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE-TEST-KEY-${uniq}-NOT-A-REAL-KEY\n-----END OPENSSH PRIVATE KEY-----\n`;
}

function trySymlink(target: string, link: string): void {
  try {
    fs.symlinkSync(target, link);
  } catch {
    // Some volumes do not allow symlinks; those path cases are then skipped (the test notes it).
  }
}

/** A fresh unique label for a run and trust state: `p…` Protected, `t…` Trusted. */
export function uniqLabel(trust: 'protected' | 'trusted'): string {
  const r = Math.random().toString(36).slice(2, 8);
  return `${trust === 'protected' ? 'p' : 't'}${Date.now().toString(36)}${r}`;
}

// ------------------------------------------------------------------------------------------- the session

export type ProbeStatus = 'blocked' | 'leaked' | 'ok' | 'pending';
export interface ProbeResult {
  kind: string;
  status: ProbeStatus;
  detail: string;
}

/** One opened security fixture: the app, its deck, the per-phase test servers, and the run's config. */
export interface SecuritySession {
  app: BlApp;
  deck: DeckView;
  net: TestNet;
  dns: DnsServer;
  cfg: NetConfig;
  trust: 'protected' | 'trusted';
  folder: FixtureFolder;
  docId: string;
  dnsRouting: DnsRouting;
  /** Reads window.__bl.results from the page. */
  results(): Promise<Record<string, ProbeResult>>;
  /** Waits for window.__bl.phases[phase] === true. */
  waitPhase(phase?: string, timeout?: number): Promise<void>;
  /** Everything that reached the test servers for this run's label (http, dns, udp, tcp). */
  summary(): ReturnType<TestNet['summary']>;
  close(): Promise<void>;
}

export interface OpenFixtureOptions {
  scratch: Scratch;
  fixture: string;
  trust: 'protected' | 'trusted';
  /** Reuse a prepared folder and config (reopen tests); a fresh one otherwise. */
  folder?: FixtureFolder;
  cfg?: NetConfig;
  /** Reuse a userData folder (reopen tests). */
  userData?: string;
  extraArgs?: string[];
}

/**
 * Opens one security fixture in a trust state, with its own HTTP/UDP/TCP listeners for the run. The DNS
 * server is the worker's shared one; its queries are attributed by the run's unique label.
 */
export async function openFixture(o: OpenFixtureOptions): Promise<SecuritySession> {
  const dns = await sharedDnsServer();
  const dnsRouting = resolveDns(dns.available);
  const net = await new TestNet(dns).start();
  const cfg: NetConfig = o.cfg ?? {
    uniq: uniqLabel(o.trust),
    zone: dns.zone,
    port: net.http.port,
    udp: net.udp.port,
    tcp: net.tcp.port,
    sink: dns.sinkIp,
  };
  // When the config is reused across a close/reopen, the ports changed: keep the label, refresh the ports.
  cfg.port = net.http.port;
  cfg.udp = net.udp.port;
  cfg.tcp = net.tcp.port;
  cfg.sink = dns.sinkIp;
  const folder = o.folder ?? prepareFixtureFolder(o.scratch, cfg);
  const file = folder.file(o.fixture);
  const app = await launchApp({
    files: [file],
    protected: o.trust === 'protected',
    scratch: o.scratch,
    dns: dnsRouting,
    userData: o.userData,
    extraArgs: o.extraArgs,
  });
  let deck: DeckView;
  try {
    deck = await app.waitForDeck(o.fixture);
  } catch (e) {
    await net.close();
    await app.close();
    throw e;
  }
  const docId = deck.docId;
  return {
    app,
    deck,
    net,
    dns,
    cfg,
    trust: o.trust,
    folder,
    docId,
    dnsRouting,
    async results() {
      return (await deck.eval('(window.__bl && window.__bl.results) || {}')) as Record<string, ProbeResult>;
    },
    async waitPhase(phase = 'load', timeout = 15_000) {
      await deck.waitFor(`window.__bl && window.__bl.phases && window.__bl.phases[${JSON.stringify(phase)}]`, timeout);
    },
    summary() {
      return net.summary(cfg.uniq);
    },
    async close() {
      await app.close();
      await net.close();
    },
  };
}
