// <userData>/config.json (9.7): the user's name, color and Person id (6.8 Identity), settings defaults, and
// trusted and untrusted folders (Phase 1, Settings › Trust). Phase 0 reads and writes the identity and the
// "explained once" flags. Writes go through the atomic writer, one at a time (CoalescingWriter).
//
// The file is Blueline's own app data, so fields this version does not know are kept as they are when it
// rewrites the file (a newer version may have added them).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CoalescingWriter } from './atomic-write';

export interface AppConfig {
  name?: string;
  /** Person.id: slug of the name + '-' + 4 random characters (6.8), chosen once. */
  personId?: string;
  color?: string;
  /** One-time explanations already shown (6.8: "The first Cmd+S in Review says, once: …"). */
  seen?: { saveExplained?: boolean };
}

const PERSON_ID = /^[a-z0-9-]{1,40}$/;
const COLOR = /^#[0-9a-f]{6}$/;
const MAX_NAME = 200;
const MAX_CONFIG_BYTES = 1024 * 1024;

/** Reads the known fields, dropping any that fail their checks. */
export function sanitizeConfig(raw: unknown): AppConfig {
  const out: AppConfig = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  const get = (k: string): unknown => (Object.prototype.hasOwnProperty.call(r, k) ? r[k] : undefined);
  const name = get('name');
  if (typeof name === 'string' && name.trim().length > 0 && name.length <= MAX_NAME) out.name = name.trim();
  const id = get('personId');
  if (typeof id === 'string' && PERSON_ID.test(id)) out.personId = id;
  const color = get('color');
  if (typeof color === 'string' && COLOR.test(color)) out.color = color;
  const seen = get('seen');
  if (seen && typeof seen === 'object' && !Array.isArray(seen)) {
    const s = seen as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(s, 'saveExplained') && s.saveExplained === true) out.seen = { saveExplained: true };
  }
  return out;
}

export class ConfigStore {
  private config: AppConfig = {};
  /** The parsed file as it was, so unknown fields survive a rewrite. */
  private raw: Record<string, unknown> = {};
  private readonly writer: CoalescingWriter;

  constructor(
    readonly file: string,
    onWriteError: (e: Error) => void = () => undefined,
  ) {
    this.writer = new CoalescingWriter(file, (e) => {
      if (e) onWriteError(e);
    });
  }

  static forUserData(userData: string, onWriteError?: (e: Error) => void): ConfigStore {
    return new ConfigStore(path.join(userData, 'config.json'), onWriteError);
  }

  /** Loads the file. A missing or unreadable file gives an empty config (it is rewritten on the next change). */
  load(): AppConfig {
    try {
      const st = fs.statSync(this.file);
      if (!st.isFile() || st.size > MAX_CONFIG_BYTES) throw new Error('bad config');
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.raw = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
      this.config = sanitizeConfig(parsed);
    } catch {
      this.raw = {};
      this.config = {};
    }
    return this.get();
  }

  get(): AppConfig {
    return { ...this.config, seen: this.config.seen ? { ...this.config.seen } : undefined };
  }

  /** Merges `patch` into the config and writes it. */
  update(patch: AppConfig): Promise<void> {
    const next: AppConfig = { ...this.config };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.personId !== undefined) next.personId = patch.personId;
    if (patch.color !== undefined) next.color = patch.color;
    if (patch.seen !== undefined) next.seen = { ...this.config.seen, ...patch.seen };
    this.config = sanitizeConfig(next);
    return this.writer.schedule(() => {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(this.raw)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        out[k] = this.raw[k];
      }
      for (const [k, v] of Object.entries(this.config)) if (v !== undefined) out[k] = v;
      return new TextEncoder().encode(JSON.stringify(out, null, 2) + '\n');
    });
  }

  idle(): Promise<void> {
    return this.writer.idle();
  }

  get busy(): boolean {
    return this.writer.busy;
  }
}
