// An X display for Electron under Linux (docs/ARCHITECTURE.md, Running Electron in the dev container).
//
// Playwright's global setup starts one Xvfb per worker and exports their names in BL_TEST_DISPLAYS; each
// worker process takes its own one into DISPLAY when it loads the Playwright config (useWorkerDisplay), so
// every app and command a worker starts runs on that worker's display. One display per worker, because an X
// server has one clipboard: tests that write the system clipboard and then paste (card-input,
// preload-electron, diagnostics) raced when two workers' apps shared a display, and one app pasted the
// other's text. A worker runs its tests one at a time, so nothing else writes its clipboard in between.
// Why our own servers instead of whatever DISPLAY the shell had:
// - the screen must be at least 3840×2160: an offscreen BrowserWindow is clamped to the X screen size
//   (docs/PHASE0-FINDINGS.md F2), and xvfb-run's default screen is 1280×1024;
// - the security suite runs the app as the unprivileged user `bltest` (so the OS sandbox is on), and an
//   xvfb-run display only admits clients that can read root's Xauthority file. `-ac` admits any local
//   client; the server listens on its unix socket only (`-nolisten tcp`), inside this container.
// Set BL_TEST_DISPLAY=:N to use an existing display instead (it must admit bltest when the app runs as bltest).

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

export const SCREEN = '3840x2160x24';

export interface DisplayHandle {
  display: string;
  /** Null when the display was not started here. */
  process: ChildProcess | null;
  stop(): Promise<void>;
}

function lockFile(n: number): string {
  return `/tmp/.X${n}-lock`;
}

function socketFile(n: number): string {
  return `/tmp/.X11-unix/X${n}`;
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

/** Starts Xvfb on the first free display number from `from`, and waits for its socket. */
export async function startXvfb(from = 140): Promise<DisplayHandle> {
  for (let n = from; n < from + 60; n++) {
    if (existsSync(lockFile(n)) || existsSync(socketFile(n))) continue;
    const child = spawn('Xvfb', [`:${n}`, '-screen', '0', SCREEN, '-nolisten', 'tcp', '-ac'], {
      stdio: 'ignore',
      detached: false,
    });
    let exited = false;
    child.once('exit', () => {
      exited = true;
    });
    child.once('error', () => {
      exited = true;
    });
    const up = await waitFor(() => exited || existsSync(socketFile(n)), 10_000);
    if (!up || exited) {
      // Lost a race for this display number (another Xvfb took it): try the next one.
      if (!exited) child.kill('SIGKILL');
      continue;
    }
    const display = `:${n}`;
    return {
      display,
      process: child,
      async stop() {
        if (exited) return;
        child.kill('SIGTERM');
        await waitFor(() => exited, 5000);
        if (!exited) child.kill('SIGKILL');
      },
    };
  }
  throw new Error('no free X display number for Xvfb');
}

/** The environment variable through which global setup hands the workers their displays. */
export const DISPLAYS_ENV = 'BL_TEST_DISPLAYS';

/**
 * Makes sure process.env.DISPLAY names a display the app can use, and starts one display per worker (`count`)
 * so no two workers share an X clipboard. Linux only; elsewhere a no-op. Returns the handles to stop in global
 * teardown. With BL_TEST_DISPLAY=:N every worker uses that one display (clipboard tests may then race).
 */
export async function ensureDisplays(count: number): Promise<DisplayHandle[]> {
  if (process.platform !== 'linux') return [];
  const given = process.env.BL_TEST_DISPLAY;
  if (given) {
    process.env.DISPLAY = given;
    process.env[DISPLAYS_ENV] = given;
    return [{ display: given, process: null, stop: async () => undefined }];
  }
  const handles: DisplayHandle[] = [];
  let from = 140;
  try {
    for (let i = 0; i < Math.max(1, count); i++) {
      const h = await startXvfb(from);
      handles.push(h);
      from = Number(h.display.slice(1)) + 1;
    }
  } catch (e) {
    await Promise.all(handles.map((h) => h.stop()));
    throw e;
  }
  // The runner itself (and anything global setup starts) uses the first; each worker switches to its own.
  process.env.DISPLAY = handles[0].display;
  process.env[DISPLAYS_ENV] = handles.map((h) => h.display).join(',');
  // Our servers need no cookie; a stale XAUTHORITY from the shell would only confuse clients.
  delete process.env.XAUTHORITY;
  return handles;
}

/**
 * In a Playwright worker process, points DISPLAY at the worker's own display from BL_TEST_DISPLAYS. Called at
 * the top of the Playwright configs: a worker sets TEST_PARALLEL_INDEX (0 to workers - 1, stable for the
 * worker's slot) before it loads the config, and it loads the config before any test file, so every spec, its
 * helpers and the processes it spawns see the worker's display. A no-op in the runner (no TEST_PARALLEL_INDEX)
 * and when global setup did not start the displays.
 */
export function useWorkerDisplay(env: NodeJS.ProcessEnv = process.env): string | null {
  const list = (env[DISPLAYS_ENV] ?? '').split(',').filter((d) => /^:\d+$/.test(d));
  const slot = Number(env.TEST_PARALLEL_INDEX);
  if (list.length === 0 || env.TEST_PARALLEL_INDEX === undefined || !Number.isInteger(slot) || slot < 0) return null;
  const display = list[slot % list.length];
  env.DISPLAY = display;
  return display;
}
