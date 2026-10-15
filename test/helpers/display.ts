// An X display for Electron under Linux (docs/ARCHITECTURE.md, Running Electron in the dev container).
//
// Playwright's global setup starts one Xvfb for the whole run and exports DISPLAY, so every worker and every
// app it launches shares it. Why our own server instead of whatever DISPLAY the shell had:
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

/**
 * Makes sure process.env.DISPLAY names a display the app can use. Linux only; elsewhere a no-op.
 * Returns the handle to stop in global teardown.
 */
export async function ensureDisplay(): Promise<DisplayHandle | null> {
  if (process.platform !== 'linux') return null;
  const given = process.env.BL_TEST_DISPLAY;
  if (given) {
    process.env.DISPLAY = given;
    return { display: given, process: null, stop: async () => undefined };
  }
  const h = await startXvfb();
  process.env.DISPLAY = h.display;
  // Our server needs no cookie; a stale XAUTHORITY from the shell would only confuse clients.
  delete process.env.XAUTHORITY;
  return h;
}
