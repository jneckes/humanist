// Command line of the app process (6.1 Mechanics; docs/ARCHITECTURE.md, Commands). Pure: no Electron, so
// unit tests drive it directly.
//
// The app accepts:
//   --bl-cmd=<open|map|check>      what to do (default open)
//   --bl-args=<base64url JSON>     the command's arguments (OpenArgs, MapArgs, CheckArgs in core/ipc)
//   --bl-out=<file>                map and check: where to write the CommandResult JSON
//   --bl-parent=<pid>              map and check: the `blueline` command's pid; the run stops when it is
//                                  gone (a killed command never leaves a probe run or a Diagnostics window)
//   --protected                    open the given files in Protected view (6.10)
//   plain paths                    files to open (Windows passes double-clicked files in argv, 6.1)
// Everything else that starts with `-` is a Chromium or Electron switch and is ignored.

import type { AppCommand, CheckArgs, MapArgs, OpenArgs } from '@blueline/core/ipc';

/** argv of the second instance is not exact (Chromium reorders and adds switches), so the CLI's data travels here. */
export interface SecondInstanceData {
  v: 1;
  cmd: 'open';
  files: string[];
  protected: boolean;
  cwd: string;
}

export type ParsedArgs =
  | { cmd: 'open'; files: string[]; protected: boolean; errors: string[] }
  | { cmd: 'map'; map: MapArgs | null; out: string | null; errors: string[] }
  | { cmd: 'check'; check: CheckArgs; out: string | null; errors: string[] };

const COMMANDS: readonly AppCommand[] = ['open', 'map', 'check'];
/** Generous caps: argv comes from the local user, but the parser must not choke on junk. */
const MAX_ARGS_JSON = 256 * 1024;
const MAX_FILES = 256;
const MAX_PATH = 32 * 1024;

/**
 * Parses the app's argv. `defaultApp` is `process.defaultApp` (dev: `electron <appDir> …`, where the first
 * positional argument is the app folder, not a file).
 */
export function parseAppArgs(argv: readonly string[], opts: { defaultApp: boolean }): ParsedArgs {
  const errors: string[] = [];
  let cmd: AppCommand = 'open';
  let rawArgs: string | null = null;
  let out: string | null = null;
  let prot = false;
  const positional: string[] = [];
  for (const a of argv.slice(1)) {
    if (typeof a !== 'string') continue;
    if (a.startsWith('--bl-cmd=')) {
      const c = a.slice('--bl-cmd='.length);
      if ((COMMANDS as readonly string[]).includes(c)) cmd = c as AppCommand;
      else errors.push(`unknown --bl-cmd ${JSON.stringify(c.slice(0, 40))}`);
    } else if (a.startsWith('--bl-args=')) rawArgs = a.slice('--bl-args='.length);
    else if (a.startsWith('--bl-out=')) out = a.slice('--bl-out='.length) || null;
    else if (a === '--protected') prot = true;
    else if (a.startsWith('-')) continue; // Chromium/Electron switches, macOS -psn_…
    else positional.push(a);
  }
  // Dev runs are `electron <appDir> [files…]`: the first positional argument is the app folder.
  if (opts.defaultApp) positional.shift();

  let json: unknown = undefined;
  if (rawArgs !== null) {
    const d = decodeArgs(rawArgs);
    if (d.ok) json = d.value;
    else errors.push(`--bl-args: ${d.why}`);
  }

  if (cmd === 'map') {
    const m = json === undefined ? null : validateMapArgs(json);
    if (json !== undefined && !m) errors.push('--bl-args: not valid map arguments');
    return { cmd, map: m, out, errors };
  }
  if (cmd === 'check') {
    const c = json === undefined ? { auto: false } : validateCheckArgs(json);
    if (!c) errors.push('--bl-args: not valid check arguments');
    return { cmd, check: c ?? { auto: false }, out, errors };
  }
  const files = positional.filter((p) => p.length > 0 && p.length <= MAX_PATH);
  if (json !== undefined) {
    const o = validateOpenArgs(json);
    if (o) {
      files.push(...o.files);
      prot = prot || o.protected;
    } else errors.push('--bl-args: not valid open arguments');
  }
  return { cmd: 'open', files: files.slice(0, MAX_FILES), protected: prot, errors };
}

/**
 * The pid in `--bl-parent=<pid>` (the last one), or null when there is none or it is not a positive
 * integer. Kept out of ParsedArgs: only map and check use it, and only for the watchdog in index.ts.
 */
export function parseParentArg(argv: readonly string[]): number | null {
  let pid: number | null = null;
  for (const a of argv.slice(1)) {
    if (typeof a !== 'string' || !a.startsWith('--bl-parent=')) continue;
    const v = a.slice('--bl-parent='.length);
    pid = /^[1-9]\d{0,9}$/.test(v) && Number(v) <= 0x7fffffff ? Number(v) : null;
  }
  return pid;
}

/** base64url → JSON. */
export function decodeArgs(raw: string): { ok: true; value: unknown } | { ok: false; why: string } {
  if (raw.length > MAX_ARGS_JSON || !/^[A-Za-z0-9_-]*={0,2}$/.test(raw)) return { ok: false, why: 'not base64url' };
  try {
    const text = Buffer.from(raw, 'base64url').toString('utf8');
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, why: 'not JSON' };
  }
}

/** JSON → base64url (the CLI's encoding, kept here so the round trip is tested in one place). */
export function encodeArgs(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function plainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function own(o: Record<string, unknown>, k: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
}

function pathString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_PATH && !v.includes('\0');
}

export function validateOpenArgs(v: unknown): OpenArgs | null {
  if (!plainObject(v)) return null;
  const files = own(v, 'files');
  const p = own(v, 'protected');
  if (!Array.isArray(files) || files.length > MAX_FILES || !files.every(pathString)) return null;
  if (p !== undefined && typeof p !== 'boolean') return null;
  return { files: files.slice(), protected: p === true };
}

export function validateMapArgs(v: unknown): MapArgs | null {
  if (!plainObject(v)) return null;
  const deck = own(v, 'deck');
  const report = own(v, 'report');
  const json = own(v, 'json');
  const min = own(v, 'minCoverage');
  if (!pathString(deck)) return null;
  if (report !== undefined && typeof report !== 'boolean') return null;
  if (json !== undefined && typeof json !== 'boolean') return null;
  if (min !== undefined && min !== null && (typeof min !== 'number' || !Number.isFinite(min) || min < 0 || min > 1)) return null;
  return { deck, report: report === true, json: json === true, minCoverage: typeof min === 'number' ? min : null };
}

export function validateCheckArgs(v: unknown): CheckArgs | null {
  if (!plainObject(v)) return null;
  const auto = own(v, 'auto');
  if (auto !== undefined && typeof auto !== 'boolean') return null;
  return { auto: auto === true };
}

/** additionalData from `second-instance` (another local process; validated like any input). */
export function validateSecondInstanceData(v: unknown): SecondInstanceData | null {
  if (!plainObject(v)) return null;
  if (own(v, 'v') !== 1 || own(v, 'cmd') !== 'open') return null;
  const o = validateOpenArgs({ files: own(v, 'files'), protected: own(v, 'protected') });
  const cwd = own(v, 'cwd');
  if (!o || !pathString(cwd)) return null;
  return { v: 1, cmd: 'open', files: o.files, protected: o.protected, cwd };
}
