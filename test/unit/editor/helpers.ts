// Shared helpers for the editor tests: an in-memory DeckIO with the atomic writer's conflict contract
// (9.2 Atomic write step 3), hashing, and map building.

import { createHash } from 'node:crypto';
import { buildMap } from '@blueline/core/mapper';
import { decodeDeck, encodeDeck } from '@blueline/core/text';
import type { DeckIO } from '@blueline/core/capabilities';
import type { DeckMap, EditRequest } from '@blueline/core/types';

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function mapOf(src: string): DeckMap {
  const bytes = encodeDeck(src);
  return buildMap(src, { version: sha256(bytes), utf8: true });
}

export class WriteConflictError extends Error {
  override name = 'WriteConflictError';
}

/** An in-memory deck file. atomicWrite re-hashes the "disk" and rejects on a mismatch, as the app's writer does. */
export class MemIO implements DeckIO {
  readonly realpath = '/mem/deck.html';
  bytes: Uint8Array;
  writes = 0;
  /** Runs inside atomicWrite before the hash check: a concurrent writer landing at the worst moment. */
  beforeWrite: (() => void) | null = null;

  constructor(content: string | Uint8Array) {
    this.bytes = typeof content === 'string' ? encodeDeck(content) : content.slice();
  }

  get text(): string {
    return decodeDeck(this.bytes).src;
  }

  /** An external writer (another editor, the agent). */
  external(content: string | Uint8Array): void {
    this.bytes = typeof content === 'string' ? encodeDeck(content) : content.slice();
  }

  async read(): Promise<Uint8Array> {
    return this.bytes.slice();
  }

  async atomicWrite(bytes: Uint8Array, expectHash: string): Promise<void> {
    const hook = this.beforeWrite;
    this.beforeWrite = null;
    hook?.();
    if (sha256(this.bytes) !== expectHash) throw new WriteConflictError('the deck changed on disk');
    this.bytes = bytes.slice();
    this.writes++;
  }

  sha256(bytes: Uint8Array): string {
    return sha256(bytes);
  }
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** An edit request for the run whose value is `before` (the first one, or the one with this id). */
export function requestFor(map: DeckMap, runIdOrText: string, after: string): EditRequest {
  const run =
    [...map.runs, ...map.literals].find((r) => r.id === runIdOrText) ??
    [...map.runs, ...map.literals].find((r) => r.value === runIdOrText);
  if (!run) throw new Error(`no run ${JSON.stringify(runIdOrText)}`);
  return { version: map.version, runId: run.id, beforeText: run.value, afterText: after };
}
