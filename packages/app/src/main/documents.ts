// Documents (9.1 Windows and views, Protocol; 9.2 Text units; 6.10 When it applies). One BlDocument per open
// file: its identity (docId, realpath, fileKey), the bytes read at open with their map and version, its
// trust state, and the served copy the deck view loads. A DocumentRegistry keeps the open documents and,
// per session partition, which of them that partition's blueline:// handler may serve (9.1 Refusals step 1).
//
// No Electron here: protocol.ts and markers.ts are imported for their pure parts, so unit tests open real
// files from temp folders.

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildMap } from '@blueline/core/mapper';
import { buildServedCopy } from '@blueline/core/served';
import { decodeDeck, encodeDeck, encodeLatin1, type DecodedDeck } from '@blueline/core/text';
import type { TrustState } from '@blueline/core/ipc';
import type { DeckMap } from '@blueline/core/types';
import type { DeckIO } from '@blueline/core/capabilities';
import { atomicWriteFile, createDeckIO, readRegularFile, sha256Hex } from './atomic-write';
import { isUntrustedLocation, readInternetMarker, type InternetMarker } from './markers';
import type { ServedDoc } from './protocol';

/** The trust bar's reason when the user asked for Protected view (6.10: `--protected`, File › Open in Protected View). */
export const REASON_REQUESTED = 'Opened at your request';

/** Extensions Blueline opens (D1: an `.html` file; 9.10 fileAssociations html and htm). */
export const OPENABLE_EXTENSIONS: ReadonlySet<string> = new Set(['html', 'htm']);

export interface TrustDecision {
  trust: TrustState;
  /** The trust bar's reason, or null when Trusted. */
  reason: string | null;
  /** The internet marker's whole value (what trust.json will remember a decision against, Phase 1). */
  marker: string | null;
}

/**
 * 6.10 When it applies: Protected when the user asked for it, or when the file carries an internet marker;
 * a marker that cannot be read counts as one (when unsure, refuse). Otherwise Trusted.
 * Phase 1 adds trusted and untrusted folders (Settings › Trust) and decisions remembered in trust.json.
 */
export async function decideTrust(
  realpath: string,
  requestedProtected: boolean,
  readMarker: (p: string) => Promise<InternetMarker> = (p) => readInternetMarker(p),
): Promise<TrustDecision> {
  let m: InternetMarker;
  try {
    m = await readMarker(realpath);
  } catch {
    m = { marker: null, reason: 'Could not check where this file came from', uncertain: true };
  }
  if (requestedProtected) return { trust: 'protected', reason: REASON_REQUESTED, marker: m.marker };
  if (m.marker !== null || m.uncertain) return { trust: 'protected', reason: m.reason ?? 'Came from the internet', marker: m.marker };
  return { trust: 'trusted', reason: null, marker: null };
}

/** fileKey = first 16 hex of sha256(realpath) (9.7). */
export function fileKeyOf(realpath: string): string {
  return sha256Hex(new TextEncoder().encode(realpath)).slice(0, 16);
}

/**
 * True when `id` is a docId Blueline can serve: 16 lowercase hex digits, at least one of them a letter. A host of
 * decimal digits only is read as an IPv4 number in a standard scheme's URL, so blueline://8117861969109379/…
 * is an invalid URL (ERR_INVALID_URL in Electron 44) and the deck would never load.
 */
export function isDocumentId(id: string): boolean {
  return /^[0-9a-f]{16}$/.test(id) && /[a-f]/.test(id);
}

/**
 * A fresh docId: 16 lowercase hex digits from the CSPRNG (9.1 URLs: a random id that main maps to the folder),
 * drawn again in the rare case (about 1 in 1,850) that they are all decimal digits (isDocumentId).
 */
export function newDocumentId(random: (n: number) => Uint8Array = (n) => randomBytes(n)): string {
  for (;;) {
    const id = Buffer.from(random(8)).toString('hex');
    if (isDocumentId(id)) return id;
  }
}

/** `<userData>/files/<fileKey>/origin`: the docId a Trusted file is served under on every open. */
export function originFileFor(userData: string, fileKey: string): string {
  if (!/^[0-9a-f]{16}$/.test(fileKey)) throw new Error('invalid fileKey');
  return path.join(userData, 'files', fileKey, 'origin');
}

/**
 * The docId of a Trusted file (6.10 Storage: "Kept per file"). Cookies, localStorage and IndexedDB are kept
 * per origin, and the deck's origin is blueline://<docId>, so a Trusted file needs the same docId on every
 * open as well as its persistent partition (9.1). It is still random (9.1 URLs), never derived from the
 * path, so the page learns nothing about where the file lives: generated once from the CSPRNG and kept in
 * app data. A Protected open never uses it (a fresh docId in a non-persistent partition). If the id cannot
 * be read or kept, a fresh one is used: the deck works, and its storage is not kept.
 */
export function trustedDocumentId(userData: string, fileKey: string): Promise<string> {
  const file = originFileFor(userData, fileKey);
  // One lookup per file at a time: two opens of the same file by different paths must not each make an id.
  const pending = originLookups.get(file);
  if (pending) return pending;
  const job = readOrMakeOrigin(file).finally(() => originLookups.delete(file));
  originLookups.set(file, job);
  return job;
}

const originLookups = new Map<string, Promise<string>>();

async function readOrMakeOrigin(file: string): Promise<string> {
  try {
    const text = (await fs.promises.readFile(file, 'utf8')).trim();
    if (isDocumentId(text)) return text;
  } catch {
    // none yet, or unreadable: make one
  }
  const id = newDocumentId();
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await atomicWriteFile(file, new TextEncoder().encode(`${id}\n`), { newFileMode: 0o600 });
  } catch {
    // not kept: this open still works with `id`
  }
  return id;
}

/** The deck partition (9.1): non-persistent per open when Protected, persistent per file when Trusted. */
export function partitionFor(trust: TrustState, docId: string, fileKey: string): string {
  return trust === 'protected' ? `deck-${docId}` : `persist:deck-${fileKey}`;
}

/** 9.2 rule 1: the banner of a deck that failed the UTF-8 check. */
export function notUtf8Reason(fileName: string): string {
  return `${fileName} is not UTF-8; direct edits are off`;
}

const TITLE_RE = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title\s*>/i;
const SIMPLE_REFS: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** The document's `<title>` text, whitespace collapsed (Session.deck.title; display and origin matching only). */
export function extractTitle(src: string): string {
  const m = TITLE_RE.exec(src.length > 2_000_000 ? src.slice(0, 2_000_000) : src);
  if (!m) return '';
  const text = m[1].replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]+);/gi, (all, ref: string) => {
    if (ref[0] === '#') {
      const cp = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : all;
    }
    const v = SIMPLE_REFS[ref.toLowerCase()];
    return v ?? all;
  });
  return text.replace(/[\s ]+/g, ' ').trim().slice(0, 300);
}

/** sha256 of the file with the notes block removed (Session.deck.sha256, section 8 baseSha). */
export function contentHashOf(decoded: DecodedDeck, map: DeckMap, version: string): string {
  const nb = map.notesBlock;
  if (!nb) return version;
  const stripped = decoded.src.slice(0, nb.start) + decoded.src.slice(nb.end);
  return sha256Hex(decoded.utf8 ? encodeDeck(stripped) : encodeLatin1(stripped));
}

export interface DocumentInit {
  docId: string;
  /** The path as the user gave it (absolute). */
  path: string;
  realpath: string;
  bytes: Uint8Array;
  trust: TrustDecision;
  /** 6.8 Received: first opened Protected, or in a mail, messages or temporary folder. */
  received: boolean;
  /**
   * Added by views: the internet marker could not be read (6.10: such a file opens Protected). Nothing is
   * remembered in trust.json for it, since there is no marker to remember a decision against (folders.ts).
   */
  markerUncertain?: boolean;
}

/**
 * Added by views: what opening a file decided beyond its trust state (6.10 When it applies, What changes;
 * folders.ts resolveOpenTrust): the switches remembered in trust.json for this file and marker, and 6.8's
 * received state.
 */
export interface OpenDecision {
  trust: TrustDecision;
  /** Turn **Allow network** on at open (remembered for this file and marker). */
  allowNetwork: boolean;
  /** Turn **Enable editing** on at open (Protected, remembered for this file and marker). */
  editing: boolean;
  /** 6.8 Received when trust.json remembers it; null: first opened Protected, or the location rule decides. */
  received: boolean | null;
  markerUncertain: boolean;
}

/** Decodes, maps and hashes a document's bytes (9.2 rule 1: a deck that is not UTF-8 is mapped from latin1). */
function contentOf(bytes: Uint8Array): { decoded: DecodedDeck; version: string; map: DeckMap; contentHash: string; title: string } {
  const version = sha256Hex(bytes);
  const decoded = decodeDeck(bytes);
  const map = buildMap(decoded.src, { version, utf8: decoded.utf8 });
  return { decoded, version, map, contentHash: contentHashOf(decoded, map, version), title: extractTitle(decoded.src) };
}

/** One open document. Implements the protocol handler's ServedDoc. */
export class BlDocument implements ServedDoc {
  readonly docId: string;
  readonly path: string;
  readonly realpath: string;
  readonly folderReal: string;
  readonly fileName: string;
  readonly fileKey: string;
  readonly partition: string;
  readonly trustReason: string | null;
  readonly marker: string | null;
  readonly received: boolean;
  /** Added by views: the marker could not be read at open (DocumentInit.markerUncertain). */
  readonly markerUncertain: boolean;
  /**
   * The hash of the file as Blueline last knew it (9.2 Watcher step 3, Write protocol step 6). Phase 1/2: the
   * watcher compares every settled change against it; the write queue's afterWrite sets it.
   */
  knownHash: string;

  private readonly trustState: TrustState;
  private network = false;
  private editing: boolean;
  private readonly servedCache = new Map<boolean, Uint8Array>();
  private bytesRead: Uint8Array;
  private released = false;
  /** The content (bytes read, their decoding, map and hashes): replaced by replaceContent on an external change. */
  private content: { decoded: DecodedDeck; version: string; map: DeckMap; contentHash: string; title: string };
  /** The file is gone from its path (9.2 Watcher): the window keeps the last version, read-only. */
  private goneNow = false;

  constructor(init: DocumentInit) {
    if (!isDocumentId(init.docId)) throw new Error('invalid docId');
    this.docId = init.docId;
    this.path = init.path;
    this.realpath = init.realpath;
    this.folderReal = path.dirname(init.realpath);
    this.fileName = path.basename(init.realpath);
    this.fileKey = fileKeyOf(init.realpath);
    this.bytesRead = init.bytes;
    this.content = contentOf(init.bytes);
    this.knownHash = this.content.version;
    this.trustState = init.trust.trust;
    this.trustReason = init.trust.reason;
    this.marker = init.trust.marker;
    this.received = init.received;
    this.markerUncertain = init.markerUncertain === true;
    // 6.10: editing is on for a Trusted file, and off in Protected view until Enable editing.
    this.editing = this.trustState === 'trusted';
    this.partition = partitionFor(this.trustState, this.docId, this.fileKey);
  }

  /** The bytes read at open, or at the last external change (their sha256 is `version`); empty once released. */
  get bytes(): Uint8Array {
    return this.bytesRead;
  }

  get decoded(): DecodedDeck {
    return this.content.decoded;
  }

  /** sha256 hex of the bytes shown: the map version (9.2 Write protocol step 1). */
  get version(): string {
    return this.content.version;
  }

  get map(): DeckMap {
    return this.content.map;
  }

  /** sha256 of the file without its notes block (Session.deck.sha256). */
  get contentHash(): string {
    return this.content.contentHash;
  }

  get title(): string {
    return this.content.title;
  }

  /**
   * Added by views: the file changed on disk, by someone else (9.2 Watcher step 3: "rebuild the map … and tell
   * the deck view to reload, with the new version"). The document now serves `bytes`: their decoding, map,
   * hashes and served copies replace the old ones, and knownHash is the new version. The docId, partition and
   * trust stay: a reload shows the new version in the same window (6.6). Transforming locked spans is Phase 4.
   * Throws (and keeps the old content) when the new bytes cannot be mapped.
   */
  replaceContent(bytes: Uint8Array): void {
    if (this.released) throw new Error(`${this.fileName} was closed`);
    const next = contentOf(bytes);
    this.content = next;
    this.bytesRead = bytes;
    this.servedCache.clear();
    this.knownHash = next.version;
  }

  /** 9.2 Watcher: the file is gone from its path (true), or back (false). */
  setGone(gone: boolean): void {
    this.goneNow = gone;
  }

  get gone(): boolean {
    return this.goneNow;
  }

  /** How many served copies are cached (one per Protected/Trusted variant; tests). */
  get servedCopies(): number {
    return this.servedCache.size;
  }

  /**
   * The document's window closed (finding 21): drop the bytes read at open and the served copies, which are
   * each the size of the file, so a document something still references does not keep them. It is gone from
   * the registry by then, so the protocol handler never asks for it again; if anything did, documentBody
   * refuses (the handler answers 404). Identity, map and trust stay readable.
   */
  release(): void {
    this.released = true;
    this.bytesRead = new Uint8Array(0);
    this.servedCache.clear();
  }

  /** Current trust (ServedDoc). Trust never changes while the document is open; Allow network and Enable editing are separate switches. */
  trust(): TrustState {
    return this.trustState;
  }

  /** **Allow network** was pressed (ServedDoc; 6.10). Phase 1: remembered in trust.json for this file. */
  networkAllowed(): boolean {
    return this.network;
  }

  /** Editing is allowed: Trusted, or **Enable editing** was pressed (6.10). */
  editingAllowed(): boolean {
    return this.editing;
  }

  get utf8(): boolean {
    return this.decoded.utf8;
  }

  /** "deck.html is not UTF-8; direct edits are off" (9.2 rule 1), or null. */
  get readOnlyReason(): string | null {
    return this.decoded.utf8 ? null : notUtf8Reason(this.fileName);
  }

  /** Editing is allowed and possible: the overlay may offer it (DeckInit.editingAllowed). A gone file is read-only. */
  editable(): boolean {
    return this.editing && this.decoded.utf8 && !this.goneNow;
  }

  /** The Protected network policy applies: served with connect-src 'none' and without resource hints (9.9). */
  servedProtected(): boolean {
    return this.trustState === 'protected' && !this.network;
  }

  allowNetwork(): void {
    this.network = true;
  }

  enableEditing(): void {
    this.editing = true;
  }

  /**
   * This document's DeckIO for the editor's write queue (core/capabilities.ts; Phase 2 creates the queue).
   * Every write re-checks, at the moment of the write, that the Edit capability is on, the file is UTF-8
   * and editing is allowed (9.1: "checks this at the moment of the write"; 9.2 rule 1), and a successful
   * write sets knownHash (9.2 Write protocol step 6).
   */
  io(editCapability: () => boolean): DeckIO {
    return createDeckIO(this.realpath, {
      refuse: () => {
        if (!editCapability()) return 'Edit is not available in this version of Blueline';
        if (this.readOnlyReason) return this.readOnlyReason;
        if (this.goneNow) return `${this.fileName} was moved or deleted`;
        if (!this.editing) return `${this.fileName} is in Protected view: enable editing first`;
        return null;
      },
      onWritten: (hash) => {
        this.knownHash = hash;
      },
    });
  }

  /** The served copy (9.1 Serving): stamps, notes block removed, resource hints removed while Protected. */
  async documentBody(): Promise<{ body: Uint8Array; utf8: boolean }> {
    if (this.released) throw new Error(`${this.fileName} was closed`);
    const prot = this.servedProtected();
    let body = this.servedCache.get(prot);
    if (!body) {
      const copy = buildServedCopy(this.decoded.src, this.map, { protected: prot });
      // 9.1 Charset: a deck that failed the UTF-8 check is served through latin1, byte for byte.
      body = this.decoded.utf8 ? encodeDeck(copy) : encodeLatin1(copy);
      this.servedCache.set(prot, body);
    }
    // A copy per response: the cached bytes must never be handed to (and detached by) a stream.
    return { body: body.slice(), utf8: this.decoded.utf8 };
  }
}

export class OpenError extends Error {
  override readonly name = 'OpenError';
}

export interface LoadOptions {
  protectedRequested: boolean;
  readMarker?: (p: string) => Promise<InternetMarker>;
  /** 6.8 Received: overridable for tests. */
  untrustedLocation?: (realpath: string) => boolean;
  docId?: string;
  /**
   * Chooses the docId once trust is known (unless `docId` is given): the app passes trustedDocumentId for a
   * Trusted file, so its origin and storage are kept per file (6.10). Default: a fresh random docId.
   */
  docIdFor?: (trust: TrustState, fileKey: string) => Promise<string>;
  /**
   * Added by views: the app's 6.10 decision (folders.ts resolveOpenTrust: trusted and untrusted folders, and the
   * switches trust.json remembers for this file and marker). Without it, decideTrust above (marker or request
   * only): map, the probe and Diagnostics open files that way.
   */
  decideTrust?: (realpath: string, requestedProtected: boolean) => Promise<OpenDecision>;
}

/**
 * Opens a file: resolves its realpath (9.2 Atomic write step 1: always written at that path), checks it
 * is an .html/.htm regular file, reads it, maps it and decides its trust. Throws OpenError with a message
 * for the user.
 */
export async function loadDocument(p: string, opts: LoadOptions): Promise<BlDocument> {
  if (typeof p !== 'string' || p.length === 0 || p.includes('\0')) throw new OpenError('Not a file path');
  const abs = path.resolve(p);
  let realpath: string;
  try {
    realpath = await fs.promises.realpath(abs);
  } catch {
    throw new OpenError(`${path.basename(abs)} was not found`);
  }
  const fileName = path.basename(realpath);
  const ext = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase() : '';
  if (!OPENABLE_EXTENSIONS.has(ext)) throw new OpenError(`${fileName} is not an HTML file. Blueline opens .html and .htm files.`);
  let bytes: Uint8Array;
  try {
    bytes = await readRegularFile(realpath);
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (code === 'ENOTREG') throw new OpenError(`${fileName} is not a regular file`);
    if (code === 'EFBIG') throw new OpenError(`${fileName} is too large to open`);
    if (code === 'EACCES' || code === 'EPERM') throw new OpenError(`${fileName} cannot be read (permission denied)`);
    throw new OpenError(`${fileName} could not be read`);
  }
  const untrusted = opts.untrustedLocation ?? ((r: string) => isUntrustedLocation(r) !== null);
  let decision: OpenDecision;
  if (opts.decideTrust) decision = await opts.decideTrust(realpath, opts.protectedRequested);
  else {
    const t = await decideTrust(realpath, opts.protectedRequested, opts.readMarker);
    decision = { trust: t, allowNetwork: false, editing: false, received: null, markerUncertain: false };
  }
  const trust = decision.trust;
  // 6.8: received when trust.json remembers it so, else when it opens Protected or sits in a mail, messages or
  // temporary folder.
  const received = decision.received ?? (trust.trust === 'protected' || untrusted(realpath));
  const docId = opts.docId ?? (opts.docIdFor ? await opts.docIdFor(trust.trust, fileKeyOf(realpath)) : newDocumentId());
  try {
    const doc = new BlDocument({ docId, path: abs, realpath, bytes, trust, received, markerUncertain: decision.markerUncertain });
    // 6.10: a remembered Allow network and Enable editing apply at once (only in Protected view; Trusted has both).
    if (trust.trust === 'protected') {
      if (decision.allowNetwork) doc.allowNetwork();
      if (decision.editing) doc.enableEditing();
    }
    return doc;
  } catch (e) {
    // The mapper never throws on HTML; if it ever does, refuse to open rather than serve an unstamped copy.
    throw new OpenError(`${fileName} could not be opened: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * The open documents, and which partition each belongs to. A partition's blueline:// handler looks
 * documents up through lookupIn(partition, docId), so it never sees another partition's documents
 * (9.1 Per-partition handler, Refusals step 1).
 */
export class DocumentRegistry {
  private readonly byId = new Map<string, BlDocument>();
  private readonly byPartition = new Map<string, Set<string>>();

  add(doc: BlDocument): void {
    if (this.byId.has(doc.docId)) throw new Error('duplicate docId');
    this.byId.set(doc.docId, doc);
    let set = this.byPartition.get(doc.partition);
    if (!set) {
      set = new Set();
      this.byPartition.set(doc.partition, set);
    }
    set.add(doc.docId);
  }

  remove(doc: BlDocument): void {
    if (this.byId.get(doc.docId) !== doc) return;
    this.byId.delete(doc.docId);
    const set = this.byPartition.get(doc.partition);
    set?.delete(doc.docId);
    if (set && set.size === 0) this.byPartition.delete(doc.partition);
  }

  get(docId: string): BlDocument | undefined {
    return this.byId.get(docId);
  }

  all(): BlDocument[] {
    return [...this.byId.values()];
  }

  /** The handler lookup of one partition: only that partition's documents. */
  lookupIn(partition: string, docId: string): BlDocument | undefined {
    if (!this.byPartition.get(partition)?.has(docId)) return undefined;
    const d = this.byId.get(docId);
    return d && d.partition === partition ? d : undefined;
  }

  /** The lookup function installDeckProtocol takes for `partition`. */
  lookupFor(partition: string): (docId: string) => BlDocument | undefined {
    return (docId) => this.lookupIn(partition, docId);
  }
}
