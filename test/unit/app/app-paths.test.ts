// Where a packaged build serves the shell and the bundled decks from (9.10 Packaging; 9.1 Shell view;
// section 10 Diagnostics window). Inside app.asar the confined handlers refuse every file (Electron's fs
// gives lstat synthetic stats there), so electron-builder unpacks dist/shell and dist/assets and main
// serves them from app.asar.unpacked.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assetsDir, servedDirs, unpackedPath } from '../../../packages/app/src/main/app-paths';
import { FILES_EXTENSIONS, resolveConfined } from '../../../packages/app/src/main/confine';

describe('unpackedPath', () => {
  it('a dev run serves dist/ as it is', () => {
    expect(unpackedPath('/repo/packages/app/dist', false, 'linux')).toBe('/repo/packages/app/dist');
    expect(unpackedPath('/opt/Blueline/resources/app.asar/dist', false, 'linux')).toBe('/opt/Blueline/resources/app.asar/dist');
  });

  it('packaged: the app.asar segment becomes app.asar.unpacked (macOS, Linux, Windows)', () => {
    expect(unpackedPath('/Applications/Blueline.app/Contents/Resources/app.asar/dist', true, 'darwin')).toBe(
      '/Applications/Blueline.app/Contents/Resources/app.asar.unpacked/dist',
    );
    expect(unpackedPath('/opt/Blueline/resources/app.asar/dist/shell', true, 'linux')).toBe('/opt/Blueline/resources/app.asar.unpacked/dist/shell');
    expect(unpackedPath('C:\\Program Files\\Blueline\\resources\\app.asar\\dist', true, 'win32')).toBe('C:\\Program Files\\Blueline\\resources\\app.asar.unpacked\\dist');
    expect(unpackedPath('/x/app.asar', true, 'linux')).toBe('/x/app.asar.unpacked');
  });

  it('only a whole segment counts, and only the last one', () => {
    expect(unpackedPath('/x/my.app.asar/dist', true, 'linux')).toBe('/x/my.app.asar/dist');
    expect(unpackedPath('/x/app.asar.bak/dist', true, 'linux')).toBe('/x/app.asar.bak/dist');
    expect(unpackedPath('/x/app.asar.unpacked/dist', true, 'linux')).toBe('/x/app.asar.unpacked/dist');
    expect(unpackedPath('/app.asar/y/app.asar/dist', true, 'linux')).toBe('/app.asar/y/app.asar.unpacked/dist');
    // A backslash is a file name character outside Windows.
    expect(unpackedPath('/x\\app.asar\\dist', true, 'linux')).toBe('/x\\app.asar\\dist');
    // A packaged app without an archive (asar: false) keeps its paths.
    expect(unpackedPath('/opt/Blueline/resources/app/dist', true, 'linux')).toBe('/opt/Blueline/resources/app/dist');
  });
});

describe('servedDirs', () => {
  it('dev: dist/shell and dist/assets/diagnostics-deck/index.html', () => {
    expect(servedDirs('/repo/packages/app/dist', false, 'linux')).toEqual({
      shellDir: '/repo/packages/app/dist/shell',
      diagnosticsDeck: '/repo/packages/app/dist/assets/diagnostics-deck/index.html',
    });
  });

  it('packaged: both from app.asar.unpacked', () => {
    expect(servedDirs('/Applications/Blueline.app/Contents/Resources/app.asar/dist', true, 'darwin')).toEqual({
      shellDir: '/Applications/Blueline.app/Contents/Resources/app.asar.unpacked/dist/shell',
      diagnosticsDeck: '/Applications/Blueline.app/Contents/Resources/app.asar.unpacked/dist/assets/diagnostics-deck/index.html',
    });
    expect(servedDirs('C:\\B\\resources\\app.asar\\dist', true, 'win32')).toEqual({
      shellDir: 'C:\\B\\resources\\app.asar.unpacked\\dist\\shell',
      diagnosticsDeck: 'C:\\B\\resources\\app.asar.unpacked\\dist\\assets\\diagnostics-deck\\index.html',
    });
  });

  // The layout electron-builder produces: an archive file next to the unpacked folder. resolveConfined is
  // unchanged; what it gets is a real folder.
  let res: string;
  beforeAll(() => {
    res = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-app-paths-'));
    fs.writeFileSync(path.join(res, 'app.asar'), 'not a folder');
    const unpacked = path.join(res, 'app.asar.unpacked', 'dist');
    fs.mkdirSync(path.join(unpacked, 'shell'), { recursive: true });
    fs.mkdirSync(path.join(unpacked, 'assets', 'diagnostics-deck', 'vendor'), { recursive: true });
    fs.writeFileSync(path.join(unpacked, 'shell', 'index.html'), '<!doctype html><title>Blueline</title>');
    fs.writeFileSync(path.join(unpacked, 'assets', 'diagnostics-deck', 'index.html'), '<!doctype html>');
    fs.writeFileSync(path.join(unpacked, 'assets', 'diagnostics-deck', 'vendor', 'reveal.js'), '/* reveal */');
  });
  afterAll(() => fs.rmSync(res, { recursive: true, force: true }));

  it('packaged layout on disk: the confined handlers find the shell and the deck siblings', () => {
    if (process.platform === 'win32') return;
    const d = servedDirs(path.join(res, 'app.asar', 'dist'), true);
    const shellReal = fs.realpathSync.native(d.shellDir);
    const shell = resolveConfined(shellReal, '/index.html', { allowedExtensions: new Set(['html']) });
    expect(shell).not.toBeNull();
    if (shell) fs.closeSync(shell.fd);
    const deckReal = fs.realpathSync.native(d.diagnosticsDeck);
    const reveal = resolveConfined(path.dirname(deckReal), '/vendor/reveal.js', { allowedExtensions: FILES_EXTENSIONS });
    expect(reveal).not.toBeNull();
    if (reveal) fs.closeSync(reveal.fd);
  });
});

describe('assetsDir (the sample deck first run copies, 6.0)', () => {
  it('dev: dist/assets; packaged: from app.asar.unpacked', () => {
    expect(assetsDir('/repo/packages/app/dist', false, 'linux')).toBe('/repo/packages/app/dist/assets');
    expect(assetsDir('/Applications/Blueline.app/Contents/Resources/app.asar/dist', true, 'darwin')).toBe('/Applications/Blueline.app/Contents/Resources/app.asar.unpacked/dist/assets');
    expect(assetsDir('C:\\B\\resources\\app.asar\\dist', true, 'win32')).toBe('C:\\B\\resources\\app.asar.unpacked\\dist\\assets');
  });
});
