// The run folder of one `blueline map`, `check` or `pdf` (6.1; section 10, Mutation probe step 1): a private
// folder in the temp folder that holds the app's result file and the app's private Chromium folders for the run
// (the app puts them next to --bl-out, packages/app/src/main/index.ts privateDir). The app cannot remove them
// itself, since Chromium still writes there while it shuts down, so the command removes the folder once the app
// has exited, on every way out: a normal end, a signal it passed on, and process exit as a backstop.
//
// A command killed outright (SIGKILL, a crash, a closed terminal on Windows) cannot clean up. So each folder
// records its owner's pid, and every later run sweeps the temp folder: a blueline-cli-* folder of this user,
// older than a day, whose owner is no longer running (or that records none), is removed.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const RUN_PREFIX = 'blueline-cli-';
export const OWNER_FILE = 'owner.pid';
/** A run folder this old, whose owner is gone, is left over from a killed command. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface RunDir {
  dir: string;
  /** The app's --bl-out. */
  out: string;
  /** Removes the folder (once; later calls do nothing). */
  cleanup(): void;
}

/** Makes this run's folder and records this process as its owner. */
export function makeRunDir(tmp: string = os.tmpdir(), pid: number = process.pid): RunDir {
  const dir = fs.mkdtempSync(path.join(tmp, RUN_PREFIX));
  fs.writeFileSync(path.join(dir, OWNER_FILE), `${pid}\n`, { mode: 0o600 });
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A file still held open (Windows): the next run's sweep removes it.
    }
  };
  return { dir, out: path.join(dir, 'result.json'), cleanup };
}

/** Whether process `pid` exists (EPERM: it exists, as another user's). */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface SweepOptions {
  tmp?: string;
  now?: number;
  alive?: (pid: number) => boolean;
  /** This user's uid (POSIX); folders of other users are never touched. Null where there is none (Windows). */
  uid?: number | null;
  staleAfterMs?: number;
}

/** Removes leftover run folders of killed commands (see the module comment). Returns the folders removed. */
export function sweepStaleRunDirs(o: SweepOptions = {}): string[] {
  const tmp = o.tmp ?? os.tmpdir();
  const now = o.now ?? Date.now();
  const alive = o.alive ?? processAlive;
  const uid = o.uid !== undefined ? o.uid : typeof process.getuid === 'function' ? process.getuid() : null;
  const staleAfter = o.staleAfterMs ?? STALE_AFTER_MS;
  const removed: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(tmp);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!name.startsWith(RUN_PREFIX)) continue;
    const dir = path.join(tmp, name);
    try {
      const st = fs.lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      if (uid !== null && st.uid !== uid) continue;
      if (now - st.mtimeMs < staleAfter) continue;
      let owner = 0;
      try {
        owner = Number(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8').trim());
      } catch {
        owner = 0; // made by a command that recorded no owner
      }
      if (owner > 0 && alive(owner)) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      // gone meanwhile, or not ours to remove
    }
  }
  return removed;
}
