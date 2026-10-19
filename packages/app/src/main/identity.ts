// The user's identity on their notes (6.8 Identity). The name comes from first run (Phase 1) or config.json,
// else `git config user.name`, else the OS user name. It is stored in config.json. A Person.id is a slug of
// the name (only a-z, 0-9 and -, cut to 35 characters), then '-' and 4 random characters from a-z0-9, so it
// always passes the section 8 id check `^[a-z0-9-]{1,40}$`.
//
// Phase 2: the name "can be changed from the name chip" (6.8). Identity.setName takes the chip's text through
// the first-run name rules (first-run.ts cleanName), stores it in config.json, and changes the running app's
// Person in place, so every window that holds it signs new notes with the new name. It updates the person's
// entry in each open session's people (trackSession: notes.ts updatePersonIn, then the session's save), and
// listeners (main's windows) tell their decks (DeckInit.userName). The Person.id never changes: earlier notes
// stay the user's.

import { randomInt } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WELCOME_LIMITS, type NameResult } from '@blueline/core/ipc-files';
import type { Person } from '@blueline/core/types';
import type { AppConfig } from './config';
import { cleanName } from './first-run';

const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';
/** Blueline blue; Phase 5 adds per-person colors. */
export const DEFAULT_COLOR = '#2563eb';

/** 6.8: slug of the name, only a-z, 0-9 and -, cut to 35 characters; 'user' when nothing is left. */
export function slugifyName(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 35)
    .replace(/-+$/g, '');
  return s.length > 0 ? s : 'user';
}

/** A fresh Person.id for a name: slug + '-' + 4 random [a-z0-9]. */
export function newPersonId(name: string, rand: (n: number) => number = (n) => randomInt(n)): string {
  let suffix = '';
  for (let i = 0; i < 4; i++) suffix += ALNUM[rand(ALNUM.length)];
  return `${slugifyName(name)}-${suffix}`;
}

/**
 * `user.name` from git's global config files, read directly. Running `git` on a Mac without the command line
 * tools would pop up an install dialog, so the files are parsed instead ($GIT_CONFIG_GLOBAL, ~/.gitconfig,
 * then $XDG_CONFIG_HOME/git/config; the first that sets it wins, as git's precedence puts ~/.gitconfig over
 * the XDG file). `include` directives are not followed.
 */
export function gitUserName(
  env: Record<string, string | undefined> = process.env,
  home: string = os.homedir(),
  read: (p: string) => string | null = (p) => {
    try {
      const st = fs.statSync(p);
      if (!st.isFile() || st.size > 1024 * 1024) return null;
      return fs.readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
): string | null {
  const files: string[] = [];
  if (env.GIT_CONFIG_GLOBAL) files.push(env.GIT_CONFIG_GLOBAL);
  files.push(path.join(home, '.gitconfig'));
  files.push(path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'git', 'config'));
  for (const f of files) {
    const text = read(f);
    if (text === null) continue;
    const name = parseGitUserName(text);
    if (name) return name;
  }
  return null;
}

/** The last `name` in a `[user]` section of a git config file (later values win, as in git). */
export function parseGitUserName(text: string): string | null {
  let section = '';
  let found: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"[^"]*")?\s*\]\s*(.*)$/.exec(line);
    if (sec) {
      section = sec[1].toLowerCase();
      if (!sec[2]) continue;
    }
    const body = sec ? sec[2] : line;
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/.exec(body);
    if (!kv || section !== 'user' || kv[1].toLowerCase() !== 'name') continue;
    let v = kv[2].trim();
    // Strip a trailing comment outside quotes, then the quotes.
    if (v.startsWith('"')) {
      const end = v.indexOf('"', 1);
      v = end > 0 ? v.slice(1, end) : v.slice(1);
    } else {
      v = v.replace(/\s[#;].*$/, '').trim();
    }
    if (v.length > 0 && v.length <= 200) found = v;
  }
  return found;
}

export function osUserName(): string | null {
  try {
    const u = os.userInfo().username;
    return typeof u === 'string' && u.length > 0 ? u : null;
  } catch {
    return null;
  }
}

export interface IdentitySources {
  gitName(): string | null;
  osName(): string | null;
  rand?: (n: number) => number;
}

/**
 * The user's Person, and the config patch to store when something was derived (6.8: "It is stored in
 * config.json"). A stored personId is kept even if the name changed later, so earlier notes stay theirs.
 */
export function resolvePerson(config: AppConfig, src: IdentitySources): { person: Person; patch: AppConfig | null } {
  const name = config.name ?? src.gitName() ?? src.osName() ?? 'Me';
  const id = config.personId ?? newPersonId(name, src.rand);
  const color = config.color ?? DEFAULT_COLOR;
  const patch: AppConfig = {};
  if (config.name === undefined) patch.name = name;
  if (config.personId === undefined) patch.personId = id;
  if (config.color === undefined) patch.color = color;
  return { person: { id, name, color }, patch: Object.keys(patch).length > 0 ? patch : null };
}

/** Where the name is stored: config.json (ConfigStore satisfies it). */
export interface NameStore {
  update(patch: { name: string }): Promise<void>;
}

/** An open document's session as Identity updates it: its notes (NotesStore) and its save. */
export interface TrackedSession {
  /** NotesStore.updatePerson: true when the session's people entry changed. */
  updatePerson(p: Person): boolean;
  /** SessionStore.save. */
  save(): unknown;
}

/** 6.8: the reason the name chip shows for a name it cannot keep (the welcome window's wording). */
export const NAME_RULE = `A name is 1 to ${WELCOME_LIMITS.name} characters, on one line.`;

/**
 * The running app's identity: the one Person object every window signs notes with (index.ts resolvePerson),
 * and the name chip's main side.
 */
export class Identity {
  private readonly listeners = new Set<(p: Person) => void>();
  private readonly sessions = new Set<TrackedSession>();

  constructor(
    private readonly me: Person,
    private readonly store: NameStore,
    private readonly log: (msg: string) => void = () => undefined,
  ) {}

  /** The live Person (the same object the controller hands to windows; its name follows setName). */
  get person(): Person {
    return this.me;
  }

  /**
   * The name chip (6.8): `raw` is what the user typed. Refused by the first-run rules (1 to 200 characters,
   * one line, no control characters or lone surrogates; runs of spaces collapse): the result says why and the
   * name stays. Otherwise it is stored in config.json first, then the Person changes and listeners hear of it.
   */
  async setName(raw: unknown): Promise<NameResult> {
    const name = cleanName(raw);
    if (name === null) return { ok: false, name: this.me.name, reason: NAME_RULE };
    if (name === this.me.name) return { ok: true, name };
    try {
      await this.store.update({ name });
    } catch (e) {
      this.log(`identity: the name was not saved: ${e instanceof Error ? e.message : String(e)}`);
      return { ok: false, name: this.me.name, reason: 'The name could not be saved.' };
    }
    this.adoptName(name);
    return { ok: true, name };
  }

  /**
   * A name another path already stored (first run's welcome window, first-run.ts onNameChanged): the Person
   * takes it and listeners hear of it. Ignores a name the first-run rules refuse.
   */
  adoptName(name: string): void {
    const clean = cleanName(name);
    if (clean === null || clean === this.me.name) return;
    this.me.name = clean;
    const p: Person = { id: this.me.id, name: this.me.name, color: this.me.color };
    // 6.8 "Session.people lists everyone with notes": every open session shows the new name at once.
    for (const s of [...this.sessions]) this.apply(s, p);
    for (const fn of [...this.listeners]) {
      try {
        fn({ ...p });
      } catch (e) {
        this.log(`identity: a name listener failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /**
   * Keeps an open document's session in step with the name: brought up to date now (the name may have changed
   * while no window showed the document), and on every change, saving when its people entry changed. Returns
   * the function that stops it (the window closed).
   */
  trackSession(s: TrackedSession): () => void {
    this.sessions.add(s);
    this.apply(s, { id: this.me.id, name: this.me.name, color: this.me.color });
    return () => this.sessions.delete(s);
  }

  private apply(s: TrackedSession, p: Person): void {
    try {
      if (s.updatePerson({ ...p })) void Promise.resolve(s.save()).catch((e: unknown) => this.log(`identity: a session was not saved: ${e instanceof Error ? e.message : String(e)}`));
    } catch (e) {
      this.log(`identity: a session was not updated: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Called with the new Person after every name change, after the tracked sessions (resend DeckInit.userName). */
  onChange(fn: (p: Person) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
