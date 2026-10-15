// Test servers for the security suite (SPEC 9.9, "The Phase 0 security fixtures run their own DNS server and
// UDP listener"; section 10, Security fixtures: "the test server must receive nothing").
//
// - RecordingHttpServer: HTTP and WebSocket on 127.0.0.1, a random port. Records every request, every
//   WebSocket upgrade and every CONNECT, with the Host header, so each attempt can be attributed by the
//   unique host label or path segment the fixture put in its URL.
// - DnsServer: a minimal UDP (and TCP) DNS server for the `bl-attacker.test` zone. It answers A queries for
//   `*.bl-attacker.test` with 127.0.0.1 and logs every query it sees, so a name a deck tried to look up is
//   observable even when nothing connects afterwards (dns-prefetch, WebRTC ICE).
// - UdpListener / TcpListener: log every datagram (STUN, TURN, QUIC) and every connection (TURN over TCP).
//
// Everything listens on loopback only. Nothing here ever forwards a query or a request anywhere.

import * as crypto from 'node:crypto';
import * as dgram from 'node:dgram';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';

export const ATTACKER_ZONE = 'bl-attacker.test';

/**
 * The address the attacker zone resolves to (the "test host"). It must be non-loopback, because Chromium
 * bypasses the Protected proxy for loopback, so a loopback test host could not tell a proxy escape from a
 * loopback bypass — and a real attacker host is never loopback. The first non-internal IPv4 of the machine
 * (e.g. 192.0.2.2 in the dev container), or null when the machine has only loopback. The suite's listeners
 * bind to 0.0.0.0, so they receive on this address and on loopback alike. BL_TEST_SINK_IP overrides it.
 */
export function detectSinkIp(): string | null {
  const override = process.env.BL_TEST_SINK_IP;
  if (override) return override;
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

export const SINK_IP: string | null = detectSinkIp();

/**
 * The address the HTTP/UDP/TCP listeners bind to: the sink IP when there is one, so the app (and only this
 * machine) can reach them on a non-loopback address, else loopback. Never 0.0.0.0 — nothing here is meant to
 * be reachable off this machine.
 */
export const BIND_HOST: string = SINK_IP ?? '127.0.0.1';

// ------------------------------------------------------------------------------------------- HTTP + WS

export interface HttpRecord {
  at: number;
  kind: 'http' | 'ws-upgrade' | 'connect';
  method: string;
  url: string;
  /** Host header, lowercased ('' when absent). */
  host: string;
  headers: Record<string, string>;
  bodyBytes: number;
}

/** 1×1 transparent PNG. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

function flatHeaders(h: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

/**
 * The response for a path. Every response allows any origin (CORS `*`), so a Trusted deck's fetch and XHR
 * can read it: the suite checks that Trusted allows them (6.10), which needs a server that says yes.
 */
function respond(req: http.IncomingMessage, res: http.ServerResponse): void {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Cache-Control': 'no-store',
  };
  const p = (req.url ?? '/').split('?')[0];
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (p.endsWith('.png')) {
    res.writeHead(200, { ...cors, 'Content-Type': 'image/png' });
    res.end(PNG_1X1);
  } else if (p.endsWith('.css')) {
    res.writeHead(200, { ...cors, 'Content-Type': 'text/css' });
    res.end('#bl-remote-css-probe { width: 321px !important; }\n');
  } else if (p.endsWith('.js')) {
    res.writeHead(200, { ...cors, 'Content-Type': 'text/javascript' });
    res.end('window.__blRemoteScript = (window.__blRemoteScript || 0) + 1;\n');
  } else if (p.endsWith('/events')) {
    res.writeHead(200, { ...cors, 'Content-Type': 'text/event-stream' });
    res.write('data: hello\n\n');
    setTimeout(() => res.end(), 200);
  } else if (p.endsWith('/download')) {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="bl-download.bin"' });
    res.end('download-bytes');
  } else {
    res.writeHead(200, { ...cors, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('bl-test-server');
  }
}

export class RecordingHttpServer {
  readonly records: HttpRecord[] = [];
  private server: http.Server | null = null;
  private sockets = new Set<net.Socket>();
  port = 0;

  async start(): Promise<this> {
    const server = http.createServer((req, res) => {
      let bytes = 0;
      req.on('data', (c: Buffer) => {
        bytes += c.length;
      });
      req.on('end', () => {
        this.records.push({
          at: Date.now(),
          kind: 'http',
          method: req.method ?? '',
          url: req.url ?? '',
          host: String(req.headers.host ?? '').toLowerCase(),
          headers: flatHeaders(req.headers),
          bodyBytes: bytes,
        });
        respond(req, res);
      });
    });
    server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    // A WebSocket handshake (RFC 6455 4.2.2): accept it so a Trusted deck's WebSocket opens, and log it.
    server.on('upgrade', (req, socket: net.Socket) => {
      this.records.push({
        at: Date.now(),
        kind: 'ws-upgrade',
        method: req.method ?? '',
        url: req.url ?? '',
        host: String(req.headers.host ?? '').toLowerCase(),
        headers: flatHeaders(req.headers),
        bodyBytes: 0,
      });
      const key = String(req.headers['sec-websocket-key'] ?? '');
      const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
      setTimeout(() => socket.destroy(), 500);
    });
    // A request that reached us as a proxy would (CONNECT host:port): log it, never tunnel.
    server.on('connect', (req, socket: net.Socket) => {
      this.records.push({
        at: Date.now(),
        kind: 'connect',
        method: req.method ?? 'CONNECT',
        url: req.url ?? '',
        host: String(req.headers.host ?? '').toLowerCase(),
        headers: flatHeaders(req.headers),
        bodyBytes: 0,
      });
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: BIND_HOST, port: 0 }, () => resolve());
    });
    this.server = server;
    this.port = (server.address() as net.AddressInfo).port;
    return this;
  }

  /** Records whose host or URL contains `needle` (a unique label from the fixture). */
  matching(needle: string): HttpRecord[] {
    const n = needle.toLowerCase();
    return this.records.filter((r) => r.host.includes(n) || r.url.toLowerCase().includes(n));
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
  }
}

// ------------------------------------------------------------------------------------------- DNS

export interface DnsQuery {
  at: number;
  transport: 'udp' | 'tcp';
  /** Lowercased, without the trailing dot. */
  name: string;
  /** Numeric QTYPE (1 A, 28 AAAA, 65 HTTPS, …). */
  type: number;
  typeName: string;
  from: string;
}

const TYPE_NAMES: Record<number, string> = { 1: 'A', 5: 'CNAME', 12: 'PTR', 15: 'MX', 16: 'TXT', 28: 'AAAA', 33: 'SRV', 64: 'SVCB', 65: 'HTTPS', 255: 'ANY' };

interface ParsedQuestion {
  id: number;
  flags: number;
  name: string;
  type: number;
  cls: number;
  /** Offset just past the question section's first question. */
  questionEnd: number;
}

/** Parses the header and first question of a DNS message (RFC 1035 4.1). Null when malformed. */
export function parseDnsQuery(msg: Buffer): ParsedQuestion | null {
  if (msg.length < 12) return null;
  const id = msg.readUInt16BE(0);
  const flags = msg.readUInt16BE(2);
  const qd = msg.readUInt16BE(4);
  if ((flags & 0x8000) !== 0 || qd < 1) return null; // a response, or no question
  let off = 12;
  const labels: string[] = [];
  for (let guard = 0; guard < 128; guard++) {
    if (off >= msg.length) return null;
    const len = msg[off];
    if (len === 0) {
      off += 1;
      break;
    }
    if ((len & 0xc0) !== 0) return null; // compression pointers do not appear in a question we accept
    if (off + 1 + len > msg.length) return null;
    labels.push(msg.subarray(off + 1, off + 1 + len).toString('latin1'));
    off += 1 + len;
  }
  if (off + 4 > msg.length) return null;
  return { id, flags, name: labels.join('.').toLowerCase(), type: msg.readUInt16BE(off), cls: msg.readUInt16BE(off + 2), questionEnd: off + 4 };
}

/**
 * The answer: `127.0.0.1` for an A query in the zone, an empty NOERROR for other types in the zone (AAAA,
 * HTTPS), and NXDOMAIN for anything outside it, so nothing outside the zone resolves through this server.
 */
export function buildDnsResponse(msg: Buffer, q: ParsedQuestion, zone: string, sinkIp: string): Buffer {
  const inZone = q.name === zone || q.name.endsWith(`.${zone}`);
  const octets = sinkIp.split('.').map((n) => Number(n));
  const validSink = octets.length === 4 && octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
  const answerA = inZone && q.type === 1 && q.cls === 1 && validSink;
  const rcode = inZone ? 0 : 3;
  const header = Buffer.alloc(12);
  header.writeUInt16BE(q.id, 0);
  // QR=1, opcode copied, AA=1, RD copied, RA=1, RCODE.
  const flags = 0x8000 | (q.flags & 0x7800) | 0x0400 | (q.flags & 0x0100) | 0x0080 | rcode;
  header.writeUInt16BE(flags, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answerA ? 1 : 0, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);
  const question = msg.subarray(12, q.questionEnd);
  if (!answerA) return Buffer.concat([header, question]);
  // Name pointer to offset 12, type A, class IN, TTL 1 s (no caching across phases), RDLENGTH 4, the sink IP.
  const answer = Buffer.concat([Buffer.from([0xc0, 0x0c, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x04]), Buffer.from(octets)]);
  return Buffer.concat([header, question, answer]);
}

export class DnsServer {
  readonly queries: DnsQuery[] = [];
  private udp: dgram.Socket | null = null;
  private tcp: net.Server | null = null;
  private tcpSockets = new Set<net.Socket>();
  /** Why the server is not listening (null when it is). */
  unavailable: string | null = null;

  constructor(
    readonly host = '127.0.0.1',
    readonly port = 53,
    readonly zone = ATTACKER_ZONE,
    /** The A record the zone resolves to (the non-loopback sink IP, so the Protected proxy applies). */
    readonly sinkIp = BIND_HOST,
  ) {}

  private record(transport: 'udp' | 'tcp', q: ParsedQuestion, from: string): void {
    this.queries.push({ at: Date.now(), transport, name: q.name, type: q.type, typeName: TYPE_NAMES[q.type] ?? String(q.type), from });
  }

  async start(): Promise<this> {
    try {
      const udp = dgram.createSocket({ type: 'udp4', reuseAddr: false });
      await new Promise<void>((resolve, reject) => {
        udp.once('error', reject);
        udp.bind({ address: this.host, port: this.port, exclusive: true }, () => resolve());
      });
      udp.on('error', () => undefined);
      udp.on('message', (msg, rinfo) => {
        const q = parseDnsQuery(msg);
        if (!q) return;
        this.record('udp', q, `${rinfo.address}:${rinfo.port}`);
        udp.send(buildDnsResponse(msg, q, this.zone, this.sinkIp), rinfo.port, rinfo.address);
      });
      this.udp = udp;
      // DNS over TCP (RFC 1035 4.2.2: two-byte length prefix), in case a resolver falls back to it.
      const tcp = net.createServer((s) => {
        this.tcpSockets.add(s);
        s.on('close', () => this.tcpSockets.delete(s));
        s.on('error', () => undefined);
        let buf = Buffer.alloc(0);
        s.on('data', (d: Buffer) => {
          buf = Buffer.concat([buf, d]);
          while (buf.length >= 2) {
            const len = buf.readUInt16BE(0);
            if (buf.length < 2 + len) break;
            const msg = buf.subarray(2, 2 + len);
            buf = buf.subarray(2 + len);
            const q = parseDnsQuery(msg);
            if (!q) continue;
            this.record('tcp', q, `${s.remoteAddress}:${s.remotePort}`);
            const r = buildDnsResponse(msg, q, this.zone, this.sinkIp);
            const lenBuf = Buffer.alloc(2);
            lenBuf.writeUInt16BE(r.length, 0);
            s.write(Buffer.concat([lenBuf, r]));
          }
        });
      });
      await new Promise<void>((resolve, reject) => {
        tcp.once('error', reject);
        tcp.listen({ host: this.host, port: this.port, exclusive: true }, () => resolve());
      });
      this.tcp = tcp;
    } catch (e) {
      this.unavailable = `cannot listen on ${this.host}:${this.port} (${e instanceof Error ? e.message : String(e)})`;
      await this.close();
    }
    return this;
  }

  get available(): boolean {
    return this.unavailable === null && this.udp !== null;
  }

  /** Queries for names in the zone that contain `needle`. */
  matching(needle: string): DnsQuery[] {
    const n = needle.toLowerCase();
    return this.queries.filter((q) => q.name.includes(n));
  }

  /** Queries for names in the zone, at or after `since` (ms epoch). */
  inZoneSince(since: number): DnsQuery[] {
    return this.queries.filter((q) => q.at >= since && (q.name === this.zone || q.name.endsWith(`.${this.zone}`)));
  }

  /** Sends one A query from this process and resolves with the answer's first IPv4 address (self-check). */
  async selfCheck(name = `selfcheck.${ATTACKER_ZONE}`): Promise<string | null> {
    if (!this.available) return null;
    const q = Buffer.alloc(12);
    q.writeUInt16BE(0x1234, 0);
    q.writeUInt16BE(0x0100, 2);
    q.writeUInt16BE(1, 4);
    const labels = name.split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, 'latin1')]));
    const msg = Buffer.concat([q, ...labels, Buffer.from([0, 0, 1, 0, 1])]);
    const sock = dgram.createSocket('udp4');
    try {
      return await new Promise<string | null>((resolve) => {
        const t = setTimeout(() => resolve(null), 2000);
        sock.on('message', (r) => {
          clearTimeout(t);
          const an = r.readUInt16BE(6);
          resolve(an > 0 && r.length >= 4 ? Array.from(r.subarray(r.length - 4)).join('.') : null);
        });
        sock.send(msg, this.port, this.host);
      });
    } finally {
      sock.close();
    }
  }

  async close(): Promise<void> {
    for (const s of this.tcpSockets) s.destroy();
    const u = this.udp;
    this.udp = null;
    if (u) await new Promise<void>((r) => u.close(() => r()));
    const t = this.tcp;
    this.tcp = null;
    if (t) await new Promise<void>((r) => t.close(() => r()));
  }
}

// ------------------------------------------------------------------------------------------- UDP and TCP

export interface UdpPacket {
  at: number;
  from: string;
  bytes: number;
  /** A STUN message (RFC 5389 6: first two bits zero, magic cookie 0x2112A442 at offset 4). */
  stun: boolean;
  head: string;
}

export class UdpListener {
  readonly packets: UdpPacket[] = [];
  private sock: dgram.Socket | null = null;
  port = 0;

  async start(): Promise<this> {
    const sock = dgram.createSocket('udp4');
    await new Promise<void>((resolve, reject) => {
      sock.once('error', reject);
      sock.bind({ address: BIND_HOST, port: 0 }, () => resolve());
    });
    sock.on('error', () => undefined);
    sock.on('message', (msg, rinfo) => {
      const stun = msg.length >= 20 && (msg[0] & 0xc0) === 0 && msg.readUInt32BE(4) === 0x2112a442;
      this.packets.push({ at: Date.now(), from: `${rinfo.address}:${rinfo.port}`, bytes: msg.length, stun, head: msg.subarray(0, 16).toString('hex') });
    });
    this.sock = sock;
    this.port = sock.address().port;
    return this;
  }

  async close(): Promise<void> {
    const s = this.sock;
    this.sock = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }
}

export interface TcpConnection {
  at: number;
  from: string;
  head: string;
}

export class TcpListener {
  readonly connections: TcpConnection[] = [];
  private server: net.Server | null = null;
  private sockets = new Set<net.Socket>();
  port = 0;

  async start(): Promise<this> {
    const server = net.createServer((s) => {
      this.sockets.add(s);
      s.on('error', () => undefined);
      s.on('close', () => this.sockets.delete(s));
      const rec: TcpConnection = { at: Date.now(), from: `${s.remoteAddress}:${s.remotePort}`, head: '' };
      this.connections.push(rec);
      s.once('data', (d: Buffer) => {
        rec.head = d.subarray(0, 32).toString('hex');
      });
      setTimeout(() => s.destroy(), 1000);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: BIND_HOST, port: 0 }, () => resolve());
    });
    this.server = server;
    this.port = (server.address() as net.AddressInfo).port;
    return this;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    const srv = this.server;
    this.server = null;
    if (srv) await new Promise<void>((r) => srv.close(() => r()));
  }
}

// ------------------------------------------------------------------------------------------- one phase's network

/**
 * The listeners of one test phase: a fresh HTTP server, UDP listener and TCP listener (so anything they see
 * belongs to this phase), plus the worker's shared DNS server (port 53 can be bound once).
 */
export class TestNet {
  readonly http = new RecordingHttpServer();
  readonly udp = new UdpListener();
  readonly tcp = new TcpListener();
  startedAt = 0;

  constructor(readonly dns: DnsServer) {}

  async start(): Promise<this> {
    await Promise.all([this.http.start(), this.udp.start(), this.tcp.start()]);
    this.startedAt = Date.now();
    return this;
  }

  /** Everything that reached a listener during this phase. */
  summary(needle?: string): { http: HttpRecord[]; dns: DnsQuery[]; udp: UdpPacket[]; tcp: TcpConnection[] } {
    return {
      http: needle ? this.http.matching(needle) : this.http.records.slice(),
      dns: needle ? this.dns.matching(needle) : this.dns.inZoneSince(this.startedAt),
      udp: this.udp.packets.slice(),
      tcp: this.tcp.connections.slice(),
    };
  }

  async close(): Promise<void> {
    await Promise.all([this.http.close(), this.udp.close(), this.tcp.close()]);
  }
}

let sharedDns: DnsServer | null = null;

/** The worker's DNS server on 127.0.0.1:53 (BL_TEST_DNS_PORT overrides the port). Started once. */
export async function sharedDnsServer(): Promise<DnsServer> {
  if (!sharedDns) {
    const port = Number(process.env.BL_TEST_DNS_PORT ?? 53);
    sharedDns = await new DnsServer('127.0.0.1', port).start();
  }
  return sharedDns;
}
