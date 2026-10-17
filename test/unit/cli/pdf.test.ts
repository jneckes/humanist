// `blueline pdf deck.html [-o out.pdf]`, the command's side (6.1; 6.9 Save as PDF): it starts the app with
// --bl-cmd=pdf and base64url PdfArgs, waits, prints the app's result and exits with its code; and the run folder
// it makes (run-dir.ts) is removed on every way out, while folders left by killed commands are swept later.
// A stand-in program replaces Electron, as in index.test.ts.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { main, pdfOut } from '../../../packages/cli/src/index';
import { windowsStopCommand } from '../../../packages/cli/src/launch';
import { OWNER_FILE, RUN_PREFIX, STALE_AFTER_MS, makeRunDir, processAlive, sweepStaleRunDirs } from '../../../packages/cli/src/run-dir';
import { decodeArgs, validatePdfArgs } from '../../../packages/app/src/main/args';

const posix = process.platform !== 'win32';
let dir: string;
let deck: string;
let fakeApp: string;
const savedEnv = { ...process.env };

/** A stand-in app for pdf: records its argv, then writes a PdfCommandResult to --bl-out. */
const FAKE_APP = `#!${process.execPath}
const fs = require('node:fs');
const arg = (k) => (process.argv.find((a) => a.startsWith(k + '=')) || '').slice(k.length + 1);
const out = arg('--bl-out');
if (process.env.FAKE_ARGV) fs.writeFileSync(process.env.FAKE_ARGV, JSON.stringify({ argv: process.argv.slice(2), outDirExists: fs.existsSync(require('node:path').dirname(out)) }));
const args = JSON.parse(Buffer.from(arg('--bl-args'), 'base64url').toString('utf8'));
const mode = process.env.FAKE_PDF;
if (mode === 'missed') {
  fs.writeFileSync(out, JSON.stringify({ command: 'pdf', exitCode: 1, text: 'blueline pdf: wrote ' + args.out + ' (3 pages, one page per slide); 1 slide could not be shown: 4', json: { out: args.out, pages: 3, mode: 'raster', title: null, missed: [3] } }));
} else if (mode === 'usage') {
  fs.writeFileSync(out, JSON.stringify({ command: 'pdf', exitCode: 2, text: 'blueline pdf: notes.txt is not an HTML file.', json: { error: 'usage', message: 'x' } }));
} else {
  const o = args.out || args.file.replace(/\\.html?$/i, '.pdf');
  fs.writeFileSync(out, JSON.stringify({ command: 'pdf', exitCode: 0, text: 'blueline pdf: wrote ' + o + ' (12 pages, one page per slide)', json: { out: o, pages: 12, mode: 'raster', title: 'T', missed: [] } }));
}
`;

function setEnv(env: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function capture(): { out: () => string; err: () => string } {
  let out = '';
  let err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((c: string | Uint8Array) => {
    out += String(c);
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation(((c: string | Uint8Array) => {
    err += String(c);
    return true;
  }) as typeof process.stderr.write);
  return { out: () => out, err: () => err };
}

function runDirs(tmp: string): string[] {
  return fs.readdirSync(tmp).filter((n) => n.startsWith(RUN_PREFIX));
}

beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bl-cli-pdf-')));
  deck = path.join(dir, 'deck.html');
  fs.writeFileSync(deck, '<!doctype html><title>x</title><p>Hello</p>');
  fakeApp = path.join(dir, 'fake-electron');
  fs.writeFileSync(fakeApp, FAKE_APP, { mode: 0o755 });
  fs.mkdirSync(path.join(dir, 'app'));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!posix)('blueline pdf (the command side)', () => {
  it('starts the app with --bl-cmd=pdf and the PdfArgs the app accepts, prints its line, exits 0', async () => {
    const tmp = fs.mkdtempSync(path.join(dir, 'tmp-'));
    const argvFile = path.join(dir, 'argv.json');
    const io = capture();
    setEnv({ DISPLAY: ':99', BLUELINE_ELECTRON: fakeApp, BLUELINE_APP_DIR: path.join(dir, 'app'), FAKE_ARGV: argvFile, TMPDIR: tmp, FAKE_PDF: undefined });
    const code = await main(['pdf', deck, '-o', path.join(dir, 'out.pdf')]);
    expect(code).toBe(0);
    expect(io.out()).toBe(`blueline pdf: wrote ${path.join(dir, 'out.pdf')} (12 pages, one page per slide)\n`);
    const { argv, outDirExists } = JSON.parse(fs.readFileSync(argvFile, 'utf8')) as { argv: string[]; outDirExists: boolean };
    expect(argv).toContain('--bl-cmd=pdf');
    expect(argv).toContain(`--bl-parent=${process.pid}`);
    expect(outDirExists).toBe(true);
    const raw = argv.find((a) => a.startsWith('--bl-args='))!.slice('--bl-args='.length);
    const decoded = decodeArgs(raw);
    expect(decoded.ok && validatePdfArgs(decoded.value)).toEqual({ file: deck, out: path.join(dir, 'out.pdf') });
    // The run folder is gone once the app has exited.
    expect(runDirs(tmp)).toEqual([]);
  });

  it('relative paths become absolute; --protected and the default output (null) reach the app', async () => {
    const argvFile = path.join(dir, 'argv2.json');
    capture();
    setEnv({ DISPLAY: ':99', BLUELINE_ELECTRON: fakeApp, BLUELINE_APP_DIR: path.join(dir, 'app'), FAKE_ARGV: argvFile });
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      expect(await main(['pdf', 'deck.html', '--protected'])).toBe(0);
    } finally {
      process.chdir(cwd);
    }
    const { argv } = JSON.parse(fs.readFileSync(argvFile, 'utf8')) as { argv: string[] };
    const decoded = decodeArgs(argv.find((a) => a.startsWith('--bl-args='))!.slice('--bl-args='.length));
    expect(decoded.ok && decoded.value).toEqual({ file: deck, out: null, protected: true });
  });

  it("exits with the app's code (1: slides missing; 2: usage) and --json prints the result's JSON", async () => {
    let io = capture();
    setEnv({ DISPLAY: ':99', BLUELINE_ELECTRON: fakeApp, BLUELINE_APP_DIR: path.join(dir, 'app'), FAKE_PDF: 'missed', FAKE_ARGV: undefined });
    expect(await main(['pdf', deck, '--json'])).toBe(1);
    expect(JSON.parse(io.out())).toMatchObject({ pages: 3, missed: [3] });
    vi.restoreAllMocks();
    io = capture();
    setEnv({ FAKE_PDF: 'usage' });
    expect(await main(['pdf', deck])).toBe(2);
    expect(io.out()).toContain('not an HTML file');
  });

  it('a missing file is refused before the app starts', async () => {
    const io = capture();
    setEnv({ DISPLAY: ':99', BLUELINE_ELECTRON: fakeApp, BLUELINE_APP_DIR: path.join(dir, 'app') });
    expect(await main(['pdf', path.join(dir, 'nope.html')])).toBe(1);
    expect(io.err()).toContain('no such file');
  });
});

describe('pdfOut', () => {
  it('absolute; an existing folder or a trailing separator gets <deck>.pdf inside it', () => {
    expect(pdfOut(null, deck)).toBeNull();
    expect(pdfOut(path.join(dir, 'x.pdf'), deck)).toBe(path.join(dir, 'x.pdf'));
    expect(pdfOut(dir, deck)).toBe(path.join(dir, 'deck.pdf'));
    expect(pdfOut(`${path.join(dir, 'new-folder')}/`, deck)).toBe(path.join(dir, 'new-folder', 'deck.pdf'));
    expect(path.isAbsolute(pdfOut('rel.pdf', deck)!)).toBe(true);
  });
});

describe('run folders (run-dir.ts)', () => {
  it('records its owner and removes itself once', () => {
    const tmp = fs.mkdtempSync(path.join(dir, 'rd-'));
    const r = makeRunDir(tmp, 4242);
    expect(path.basename(r.dir).startsWith(RUN_PREFIX)).toBe(true);
    expect(fs.readFileSync(path.join(r.dir, OWNER_FILE), 'utf8')).toBe('4242\n');
    expect(r.out).toBe(path.join(r.dir, 'result.json'));
    fs.mkdirSync(`${r.out}.session`);
    r.cleanup();
    r.cleanup();
    expect(fs.existsSync(r.dir)).toBe(false);
  });

  it('the sweep removes folders older than a day whose owner is gone (or unrecorded), and nothing else', () => {
    const tmp = fs.mkdtempSync(path.join(dir, 'sweep-'));
    const old = (Date.now() - STALE_AFTER_MS - 60_000) / 1000;
    const mk = (name: string, owner: string | null, age: 'old' | 'new') => {
      const d = path.join(tmp, name);
      fs.mkdirSync(d);
      if (owner !== null) fs.writeFileSync(path.join(d, OWNER_FILE), owner);
      if (age === 'old') fs.utimesSync(d, old, old);
      return d;
    };
    const deadOld = mk(`${RUN_PREFIX}dead`, '999999', 'old');
    const liveOld = mk(`${RUN_PREFIX}live`, String(process.pid), 'old');
    const deadNew = mk(`${RUN_PREFIX}fresh`, '999999', 'new');
    const noOwnerOld = mk(`${RUN_PREFIX}phase0`, null, 'old');
    const other = mk('blueline-session-x', '999999', 'old');
    fs.symlinkSync(deadOld, path.join(tmp, `${RUN_PREFIX}link`));
    const removed = sweepStaleRunDirs({ tmp, alive: (pid) => pid === process.pid });
    expect(removed.sort()).toEqual([deadOld, noOwnerOld].sort());
    for (const d of [liveOld, deadNew, other]) expect(fs.existsSync(d)).toBe(true);
    // Another user's folder is never touched.
    const theirs = mk(`${RUN_PREFIX}theirs`, '999999', 'old');
    expect(sweepStaleRunDirs({ tmp, alive: () => false, uid: (process.getuid?.() ?? 0) + 1 })).toEqual([]);
    expect(fs.existsSync(theirs)).toBe(true);
  });

  it('processAlive', () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(0)).toBe(false);
    expect(processAlive(-5)).toBe(false);
  });
});

describe('Windows: a close request before a forced stop (launch.ts)', () => {
  it('taskkill /PID /T from System32, /F only when forced', () => {
    expect(windowsStopCommand(1234, { force: false, systemRoot: 'C:\\Windows' })).toEqual({ file: 'C:\\Windows\\System32\\taskkill.exe', args: ['/PID', '1234', '/T'] });
    expect(windowsStopCommand(1234, { force: true, systemRoot: 'D:\\Win' })).toEqual({ file: 'D:\\Win\\System32\\taskkill.exe', args: ['/PID', '1234', '/T', '/F'] });
    // A relative or missing SystemRoot never makes taskkill come from PATH.
    expect(windowsStopCommand(1, { force: false, systemRoot: 'Windows' }).file).toBe('C:\\Windows\\System32\\taskkill.exe');
    expect(windowsStopCommand(1, { force: false }).file).toBe('C:\\Windows\\System32\\taskkill.exe');
  });
});
