// <userData>/config.json (9.7): the user's name, color and Person id (6.8 Identity), settings defaults, and
// trusted and untrusted folders (Settings › Trust, 6.10). Phase 0 reads and writes the identity and the
// "explained once" flags; Phase 1 adds the Trust settings: the trusted and untrusted folders, "Block all
// network in Protected view" and the user-edited CDN allowlist (9.9). folders.ts owns their rules (realpaths,
// refused folders); this file only stores them, re-checking each value when it reads the file. Writes go
// through the atomic writer, one at a time (CoalescingWriter).
//
// Phase 2 adds the settings defaults (9.7: "config.json: name, color, settings defaults, …"): `defaults` holds the
// value a document's Session.settings takes when it sets none, today smart punctuation (6.3: "default on; toggle in
// settings"), changed in Settings › General (settings-window.ts).
//
// The file is Blueline's own app data, so fields this version does not know are kept as they are when it
// rewrites the file (a newer version may have added them).

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Session } from '@blueline/core/types';
import { CoalescingWriter } from './atomic-write';
import { normalizeAllowlistHost } from './network-policy';

/** 6.3 Smart punctuation: default on. */
export const DEFAULT_SMART_PUNCTUATION = true;

/** Settings defaults (9.7): what each document's Session.settings falls back to. */
export interface SettingsDefaults {
  /** 6.3 Smart punctuation. Absent: DEFAULT_SMART_PUNCTUATION. */
  smartPunctuation?: boolean;
}

export interface AppConfig {
  name?: string;
  /** Person.id: slug of the name + '-' + 4 random characters (6.8), chosen once. */
  personId?: string;
  color?: string;
  /**
   * One-time explanations already shown (6.8: "The first Cmd+S in Review says, once: …"). `welcome` (added by
   * views for first-run.ts): the welcome window was shown (6.0 First run: on first launch).
   */
  seen?: { saveExplained?: boolean; welcome?: boolean };
  /** 9.9 Telemetry: the answer to "send crash reports?", asked once at first run (first-run.ts). Absent: not asked. */
  crashReports?: boolean;
  /** Added by views: View › Hide Slides (6.0: the left rail "can be collapsed"), remembered for every window. */
  railHidden?: boolean;
  /** Settings › Trust (6.10): folders whose files open Trusted even with an internet marker. Realpaths. */
  trustedFolders?: string[];
  /** Settings › Trust (6.10): folders whose files open Protected even without a marker. Realpaths. */
  untrustedFolders?: string[];
  /** Settings › Trust: "Block all network in Protected view" (6.10; 9.9: the strict option blocks the allowlist too). */
  strictProtected?: boolean;
  /** Settings › Trust: the CDN allowlist as the user edited it (9.9). Absent: network-policy's DEFAULT_ALLOWLIST. */
  cdnAllowlist?: string[];
  /** Settings defaults (9.7), changed in Settings › General. */
  defaults?: SettingsDefaults;
}

/** A change to the config. `cdnAllowlist: null` removes the edited list (back to the 9.9 defaults). `defaults` merges. */
export type ConfigPatch = Omit<AppConfig, 'cdnAllowlist'> & { cdnAllowlist?: string[] | null };

/** The smart punctuation default (config.json), on unless the user turned it off. */
export function smartPunctuationDefault(c: AppConfig): boolean {
  return c.defaults?.smartPunctuation ?? DEFAULT_SMART_PUNCTUATION;
}

/**
 * Whether the commit clean-up converts straight quotes for one document (6.3): the document's own setting
 * (Session.settings.smartPunctuation) when it has one, else the default from config.json. DeckInit.settings
 * carries it to the deck view.
 */
export function smartPunctuationFor(c: AppConfig, settings: Session['settings'] | null | undefined): boolean {
  const own = settings?.smartPunctuation;
  return typeof own === 'boolean' ? own : smartPunctuationDefault(c);
}

const PERSON_ID = /^[a-z0-9-]{1,40}$/;
const COLOR = /^#[0-9a-f]{6}$/;
const MAX_NAME = 200;
const MAX_CONFIG_BYTES = 1024 * 1024;
/** Limits on the Trust settings (core/ipc-trust.ts SETTINGS_LIMITS: the Settings window enforces the same). */
export const MAX_FOLDER_PATH = 4096;
export const MAX_FOLDERS = 500;
export const MAX_HOSTS = 200;

/**
 * A folder list as stored: absolute paths (on this platform), no NUL or other control characters, at most
 * MAX_FOLDER_PATH long, without duplicates, at most MAX_FOLDERS. Invalid entries are dropped, never kept
 * as something they are not (a malformed entry must not make a file Trusted).
 */
export function sanitizeFolderList(v: unknown, pathApi: path.PlatformPath = path): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const item of v.slice(0, MAX_FOLDERS * 4)) {
    if (typeof item !== 'string' || item.length === 0 || item.length > MAX_FOLDER_PATH) continue;
    if (/[\u0000-\u001f\u007f]/.test(item) || !pathApi.isAbsolute(item)) continue;
    if (!out.includes(item)) out.push(item);
    if (out.length >= MAX_FOLDERS) break;
  }
  return out;
}

/** The allowlist as stored: normalized hosts (normalizeAllowlistHost), no duplicates, at most MAX_HOSTS. */
export function sanitizeHostList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const item of v.slice(0, MAX_HOSTS * 4)) {
    const h = typeof item === 'string' ? normalizeAllowlistHost(item) : null;
    if (h !== null && !out.includes(h)) out.push(h);
    if (out.length >= MAX_HOSTS) break;
  }
  return out;
}

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
    const kept: NonNullable<AppConfig['seen']> = {};
    if (Object.prototype.hasOwnProperty.call(s, 'saveExplained') && s.saveExplained === true) kept.saveExplained = true;
    if (Object.prototype.hasOwnProperty.call(s, 'welcome') && s.welcome === true) kept.welcome = true;
    if (Object.keys(kept).length > 0) out.seen = kept;
  }
  const crash = get('crashReports');
  if (typeof crash === 'boolean') out.crashReports = crash;
  const rail = get('railHidden');
  if (typeof rail === 'boolean') out.railHidden = rail;
  const trusted = sanitizeFolderList(get('trustedFolders'));
  if (trusted) out.trustedFolders = trusted;
  const untrusted = sanitizeFolderList(get('untrustedFolders'));
  if (untrusted) out.untrustedFolders = untrusted;
  if (get('strictProtected') === true) out.strictProtected = true;
  else if (get('strictProtected') === false) out.strictProtected = false;
  const hosts = sanitizeHostList(get('cdnAllowlist'));
  if (hosts) out.cdnAllowlist = hosts;
  const defaults = get('defaults');
  if (defaults && typeof defaults === 'object' && !Array.isArray(defaults)) {
    const d = defaults as Record<string, unknown>;
    const kept: SettingsDefaults = {};
    if (Object.prototype.hasOwnProperty.call(d, 'smartPunctuation') && typeof d.smartPunctuation === 'boolean') kept.smartPunctuation = d.smartPunctuation;
    if (Object.keys(kept).length > 0) out.defaults = kept;
  }
  return out;
}

const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** A plain object's own fields, without keys that could reach a prototype (the file is read back as JSON). */
function ownFields(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const k of Object.keys(v)) if (!UNSAFE_KEYS.has(k)) out[k] = (v as Record<string, unknown>)[k];
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
    const c = this.config;
    return {
      ...c,
      seen: c.seen ? { ...c.seen } : undefined,
      trustedFolders: c.trustedFolders ? [...c.trustedFolders] : undefined,
      untrustedFolders: c.untrustedFolders ? [...c.untrustedFolders] : undefined,
      cdnAllowlist: c.cdnAllowlist ? [...c.cdnAllowlist] : undefined,
      defaults: c.defaults ? { ...c.defaults } : undefined,
    };
  }

  /** Merges `patch` into the config and writes it. */
  update(patch: ConfigPatch): Promise<void> {
    const next: AppConfig = { ...this.config };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.personId !== undefined) next.personId = patch.personId;
    if (patch.color !== undefined) next.color = patch.color;
    if (patch.seen !== undefined) next.seen = { ...this.config.seen, ...patch.seen };
    if (patch.trustedFolders !== undefined) next.trustedFolders = [...patch.trustedFolders];
    if (patch.untrustedFolders !== undefined) next.untrustedFolders = [...patch.untrustedFolders];
    if (patch.strictProtected !== undefined) next.strictProtected = patch.strictProtected;
    if (patch.crashReports !== undefined) next.crashReports = patch.crashReports;
    if (patch.railHidden !== undefined) next.railHidden = patch.railHidden;
    if (patch.cdnAllowlist === null) {
      delete next.cdnAllowlist;
      // The file's own copy goes too, or the rewrite below would keep the edited list (unknown fields are kept).
      delete this.raw.cdnAllowlist;
    } else if (patch.cdnAllowlist !== undefined) next.cdnAllowlist = [...patch.cdnAllowlist];
    if (patch.defaults !== undefined) next.defaults = { ...this.config.defaults, ...patch.defaults };
    this.config = sanitizeConfig(next);
    return this.writer.schedule(() => {
      const out = ownFields(this.raw);
      for (const [k, v] of Object.entries(this.config)) if (v !== undefined) out[k] = v;
      // Defaults this version does not know stay too (a newer version may have added them).
      if (this.config.defaults) out.defaults = { ...ownFields(this.raw.defaults), ...this.config.defaults };
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

/** The settings defaults Settings › General changes (6.3 Smart punctuation), as one snapshot. */
export interface GeneralSettingsState {
  smartPunctuation: boolean;
}

/** Settings › General's settings defaults over config.json. */
export interface GeneralSettings {
  get(): GeneralSettingsState;
  setSmartPunctuation(on: boolean): Promise<void>;
  /** Called after every change (main pushes the new default to open documents that have no setting of their own). */
  onChange(fn: (s: GeneralSettingsState) => void): () => void;
}

/** GeneralSettings stored in config.json `defaults`. */
export function configGeneralSettings(config: Pick<ConfigStore, 'get' | 'update'>): GeneralSettings {
  const listeners = new Set<(s: GeneralSettingsState) => void>();
  const get = (): GeneralSettingsState => ({ smartPunctuation: smartPunctuationDefault(config.get()) });
  return {
    get,
    async setSmartPunctuation(on) {
      if (typeof on !== 'boolean') throw new Error('setSmartPunctuation: not a boolean');
      if (get().smartPunctuation === on) return;
      await config.update({ defaults: { smartPunctuation: on } });
      const s = get();
      for (const fn of [...listeners]) {
        try {
          fn(s);
        } catch {
          // A listener's failure must not keep the others from the change.
        }
      }
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
