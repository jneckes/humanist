// `blueline pdf` and `blueline map` decide trust as the app decides an open (command-trust.ts; 6.1, 6.10, 9.9):
// the user's config.json (read, never written) gives the trusted and untrusted folders, the strict option and the
// allowlist; remembered decisions in trust.json never apply and trust.json is never read or written; the PDF of a
// Protected deck is marked as a derived file. Real CLI runs: test/e2e/command-trust.spec.ts.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('electron', () => ({
  app: { getPath: (n: string) => (n === 'appData' ? '/home/anna/.config' : os.tmpdir()), name: 'Blueline', on() {}, once() {}, removeListener() {}, isPackaged: false },
  BrowserWindow: class {},
  dialog: {},
  nativeTheme: { on() {} },
  ipcMain: { on() {}, handle() {} },
  session: { fromPartition: () => ({}) },
}));

import { commandTrust, describeTrust, realUserData } from '../../../packages/app/src/main/command-trust';
import { loadDocument } from '../../../packages/app/src/main/documents';
import { REASON_UNTRUSTED_FOLDER } from '../../../packages/app/src/main/folders';
import { REASON_INTERNET, markDerivedFile } from '../../../packages/app/src/main/markers';
import { DEFAULT_ALLOWLIST } from '../../../packages/app/src/main/network-policy';
import { renderTargetFor } from '../../../packages/app/src/main/render-service';
import { TrustStore } from '../../../packages/app/src/main/trust-store';

const Q = '0083;65f1c2a3;Safari;6E1F6E7C-1C1B-4B8E-9D2E-123456789ABC';
let dir: string;
beforeAll(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bl-cmdtrust-')));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A userData with config.json, and a location that refuses nothing in this temp folder. */
function userData(config: Record<string, unknown>): string {
  const ud = fs.mkdtempSync(path.join(dir, 'ud-'));
  fs.writeFileSync(path.join(ud, 'config.json'), JSON.stringify(config));
  return ud;
}
const location = { platform: 'linux' as const, home: '/home/anna', tmpdirs: [] };

function deckIn(folder: string, name = 'deck.html'): string {
  fs.mkdirSync(folder, { recursive: true });
  const p = path.join(folder, name);
  fs.writeFileSync(p, '<!doctype html><title>Deck</title><h1>Deck</h1>');
  return fs.realpathSync(p);
}

describe('realUserData: where a command finds the user settings', () => {
  it("BLUELINE_USER_DATA when set (tests), else Electron's default userData, <appData>/<app name>", () => {
    expect(realUserData({ BLUELINE_USER_DATA: 'rel/ud' })).toBe(path.resolve('rel/ud'));
    expect(realUserData({})).toBe(path.join('/home/anna/.config', 'Blueline'));
    expect(realUserData({ BLUELINE_USER_DATA: '' })).toBe(path.join('/home/anna/.config', 'Blueline'));
  });
});

describe('commandTrust: the app decision without remembered decisions (findings 1, 4)', () => {
  it('an unmarked deck in an untrusted folder is Protected; strict and an edited allowlist reach the partition policy', async () => {
    const inbox = path.join(dir, 'inbox');
    const deck = deckIn(inbox);
    const ud = userData({ untrustedFolders: [fs.realpathSync(inbox)], strictProtected: true, cdnAllowlist: ['cdn.example.org'] });
    const t = commandTrust({ userData: ud, location, platform: 'linux', readMarker: async () => ({ marker: null, reason: null }) });
    expect(t.configFile).toBe(path.join(ud, 'config.json'));
    const d = await t.decideTrust(deck, false);
    expect(d).toMatchObject({ trust: { trust: 'protected', reason: REASON_UNTRUSTED_FOLDER, marker: null }, allowNetwork: false, editing: false, markerUncertain: false });
    expect(t.describe()).toBe(`protected (${REASON_UNTRUSTED_FOLDER}; rule untrusted-folder)`);
    expect(t.strict()).toBe(true);
    expect(t.allowlist()).toEqual(['cdn.example.org']);
  });

  it('defaults (no config.json): the 9.9 allowlist, strict off; a marked deck Protected, an unmarked one Trusted', async () => {
    const t = commandTrust({ userData: path.join(dir, 'no-such-userdata'), location, platform: 'linux', readMarker: async (p) => (p.endsWith('marked.html') ? { marker: Q, reason: REASON_INTERNET } : { marker: null, reason: null }) });
    expect(t.strict()).toBe(false);
    expect(t.allowlist()).toEqual(DEFAULT_ALLOWLIST);
    expect((await t.decideTrust(deckIn(path.join(dir, 'plain'), 'marked.html'), false)).trust).toEqual({ trust: 'protected', reason: REASON_INTERNET, marker: Q });
    expect(t.describe()).toBe(`protected (${REASON_INTERNET}; rule marker)`);
    expect((await t.decideTrust(deckIn(path.join(dir, 'plain'), 'mine.html'), false)).trust).toEqual({ trust: 'trusted', reason: null, marker: null });
    expect(t.describe()).toBe('trusted (rule none)');
    expect((await t.decideTrust(deckIn(path.join(dir, 'plain'), 'mine.html'), true)).trust.trust).toBe('protected');
    expect(t.describe()).toBe('protected (Opened at your request; rule requested)');
  });

  it('a trusted folder makes a marked deck Trusted, as in the app; a refused one (a temporary folder) does not', async () => {
    // A folder outside the temporary folders (a trusted folder there is refused, 6.10); the marker is read by a stand-in.
    const t = commandTrust({ userData: userData({ trustedFolders: ['/home/anna/Decks', dir] }), location, platform: 'linux', readMarker: async () => ({ marker: Q, reason: REASON_INTERNET }) });
    expect((await t.decideTrust('/home/anna/Decks/q4.html', false)).trust).toEqual({ trust: 'trusted', reason: null, marker: Q });
    expect(t.describe()).toBe('trusted (rule trusted-folder)');
    expect((await t.decideTrust(path.join(dir, 'q4.html'), false)).trust.trust).toBe('protected');
  });

  it('a decision trust.json remembers never applies, and neither trust.json nor config.json is written', async () => {
    const inbox = path.join(dir, 'inbox-mem');
    const deck = deckIn(inbox);
    const ud = userData({ untrustedFolders: [fs.realpathSync(inbox)] });
    // The app remembered Allow network and Enable editing for this very file (bound to its identity).
    const appStore = new TrustStore(path.join(ud, 'trust.json'), undefined, undefined, { platform: 'linux' }).load();
    await appStore.remember(deck, null, { allowNetwork: true, editing: true });
    const trustBefore = fs.readFileSync(path.join(ud, 'trust.json'), 'utf8');
    const configBefore = fs.readFileSync(path.join(ud, 'config.json'), 'utf8');
    const stamp = (p: string) => fs.statSync(p).mtimeMs;
    const mtimes = [stamp(path.join(ud, 'trust.json')), stamp(path.join(ud, 'config.json'))];
    const t = commandTrust({ userData: ud, location, platform: 'linux', readMarker: async () => ({ marker: null, reason: null }) });
    const doc = await loadDocument(deck, { protectedRequested: false, untrustedLocation: () => false, decideTrust: (rp, req) => t.decideTrust(rp, req) });
    expect({ trust: doc.trust(), network: doc.networkAllowed(), editing: doc.editingAllowed() }).toEqual({ trust: 'protected', network: false, editing: false });
    await new Promise((r) => setTimeout(r, 50));
    expect(fs.readFileSync(path.join(ud, 'trust.json'), 'utf8')).toBe(trustBefore);
    expect(fs.readFileSync(path.join(ud, 'config.json'), 'utf8')).toBe(configBefore);
    expect([stamp(path.join(ud, 'trust.json')), stamp(path.join(ud, 'config.json'))]).toEqual(mtimes);
    expect(fs.readdirSync(ud).sort()).toEqual(['config.json', 'trust.json']);
    // And none is created where there was none.
    const empty = userData({ untrustedFolders: [fs.realpathSync(inbox)] });
    await commandTrust({ userData: empty, location, platform: 'linux', readMarker: async () => ({ marker: null, reason: null }) }).decideTrust(deck, false);
    expect(fs.readdirSync(empty)).toEqual(['config.json']);
  });

  it('the PDF of a deck Protected by an untrusted folder is marked as a derived file (9.9; pdf.ts saveAsPdf passes doc.isProtected())', async () => {
    const inbox = path.join(dir, 'inbox-pdf');
    const deck = deckIn(inbox);
    const t = commandTrust({ userData: userData({ untrustedFolders: [fs.realpathSync(inbox)] }), location, platform: 'linux', readMarker: async () => ({ marker: null, reason: null }) });
    const doc = await loadDocument(deck, { protectedRequested: false, untrustedLocation: () => false, decideTrust: (rp, req) => t.decideTrust(rp, req) });
    const target = renderTargetFor(doc);
    // What saveAsPdf hands markDerivedFile (pdf.ts: { realpath: from, marker: doc.marker, protectedView: doc.isProtected() }).
    const source = { realpath: target.realpath, marker: target.marker, protectedView: target.isProtected() };
    expect(source).toEqual({ realpath: deck, marker: null, protectedView: true });
    // On Windows that writes a Zone.Identifier naming the deck (macOS: a quarantine value, through the helper).
    const written: { file: string; text: string }[] = [];
    await markDerivedFile(path.join(inbox, 'deck.pdf'), source, { platform: 'win32', writeFile: async (file, bytes) => void written.push({ file, text: new TextDecoder().decode(bytes) }) });
    expect(written).toHaveLength(1);
    expect(written[0].file).toBe(`${path.join(inbox, 'deck.pdf')}:Zone.Identifier`);
    expect(written[0].text).toMatch(/^\[ZoneTransfer\]\r\nZoneId=3\r\nReferrerUrl=file:\/\/.*deck\.html\r\n$/);
  });

  it('describeTrust names the state, the reason and the rule', () => {
    expect(describeTrust({ state: 'protected', reason: 'Came from the internet', rule: 'marker' } as Parameters<typeof describeTrust>[0])).toBe('protected (Came from the internet; rule marker)');
  });
});
