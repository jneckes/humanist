// A real X click through XTEST (test/helpers/xclick.c), for the few E2E tests that need the window system's own
// event order: a click on a view of a window that is not active activates the window and focuses the view, and
// Electron reports those in an order its own APIs (BrowserWindow.focus, webContents.focus) do not reproduce.
// Built once per run with the system C compiler on Linux; `xclicker()` is null where it cannot be built (no
// compiler, no libX11/libXtst, not Linux), and the tests that need it skip.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let built: string | null | undefined;

function build(): string | null {
  if (process.platform !== 'linux') return null;
  const out = path.join(os.tmpdir(), `bl-xclick-${process.getuid?.() ?? 0}`);
  try {
    if (!fs.existsSync(out)) {
      execFileSync('cc', [path.join(__dirname, 'xclick.c'), '-o', `${out}.tmp`, '-lX11', '-l:libXtst.so.6'], { stdio: 'pipe' });
      fs.renameSync(`${out}.tmp`, out);
    }
    return out;
  } catch {
    return null;
  }
}

/** A function that clicks at root coordinates on the current DISPLAY, or null when the helper cannot be built. */
export function xclicker(): ((x: number, y: number) => void) | null {
  if (built === undefined) built = build();
  const bin = built;
  if (!bin || !process.env.DISPLAY) return null;
  return (x, y) => {
    execFileSync(bin, [String(Math.round(x)), String(Math.round(y))], { env: { ...process.env, DISPLAY: process.env.DISPLAY } });
  };
}
