// A remembered Allow network and Enable editing are bound to the file where the marker cannot tell two files
// apart (6.10 What changes: "A different copy of the file starts from its own marker"; trust-store.ts
// bindsToFile). Review findings 5 and 28: a file Protected because it is in an untrusted folder has no marker, so
// the decision used to apply to any later file saved at the same path. Now it is bound to the file's identity
// (dev and ino): another program's new file at the path (temp file + rename, as browsers, mail clients and sync
// tools save) opens Protected with both switches off, while Blueline's own atomic write (which also puts a new
// file there) keeps them, because it re-binds the decision (documents.ts io(), trust-store.ts
// rebindAfterOwnWrite). As the rest of the suite: the app runs as bltest with the OS sandbox on when it can.

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FIXTURES, Scratch, launchApp, resolveRunAs, type BlApp } from '../helpers/app';

test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

const UNTRUSTED = 'In a folder you marked as untrusted';

interface Setup {
  s: Scratch;
  file: string;
  userData: string;
  trustFile: string;
}

/** An untrusted folder (config.json) with one unmarked deck in it, and a fresh userData. */
function setup(): Setup {
  const s = new Scratch(resolveRunAs());
  const dir = s.dir('trust-identity');
  const file = path.join(dir, 'proposal.html');
  fs.copyFileSync(path.join(FIXTURES, 'decks', 'single.html'), file);
  s.own(dir);
  const userData = path.join(s.dir('trust-identity-ud'), 'userData');
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ untrustedFolders: [fs.realpathSync.native(dir)], seen: { welcome: true } }));
  s.own(path.dirname(userData));
  return { s, file: fs.realpathSync.native(file), userData, trustFile: path.join(userData, 'trust.json') };
}

function entry(t: Setup): Record<string, unknown> | null {
  try {
    return (JSON.parse(fs.readFileSync(t.trustFile, 'utf8')) as { files: Record<string, Record<string, unknown>> }).files[t.file] ?? null;
  } catch {
    return null;
  }
}

/** Opens the deck (Protected: the untrusted folder) and presses Allow network and Enable editing in its trust bar. */
async function openAndAllow(t: Setup): Promise<{ app: BlApp; docId: string }> {
  const app = await launchApp({ files: [t.file], scratch: t.s, userData: t.userData });
  const deck = await app.waitForDeck('proposal.html');
  expect(await app.win(deck.docId)).toMatchObject({ trust: 'protected', trustReason: UNTRUSTED, networkAllowed: false, editingAllowed: false });
  const shell = await app.shellPage(deck.docId);
  await shell.locator('#allow-network').click();
  await expect.poll(async () => (await app.win(deck.docId)).networkAllowed).toBe(true);
  await shell.locator('#enable-editing').click();
  await expect.poll(async () => (await app.win(deck.docId)).editingAllowed).toBe(true);
  await expect.poll(() => entry(t)).toMatchObject({ marker: null, allowNetwork: true, editing: true });
  return { app, docId: deck.docId };
}

async function reopen(t: Setup): Promise<{ trust: string; trustReason: string | null; networkAllowed: boolean; editingAllowed: boolean }> {
  const app = await launchApp({ files: [t.file], scratch: t.s, userData: t.userData });
  try {
    const deck = await app.waitForDeck('proposal.html');
    const w = await app.win(deck.docId);
    return { trust: w.trust, trustReason: w.trustReason, networkAllowed: w.networkAllowed, editingAllowed: w.editingAllowed };
  } finally {
    await app.close();
  }
}

test('untrusted folder, no marker: another file saved over the path (temp + rename) opens Protected with network and editing off', async () => {
  const t = setup();
  try {
    const { app } = await openAndAllow(t);
    await app.close();
    // A sync client or a browser puts a different file at the path: a new file (new inode), no marker on Linux.
    const ino = fs.statSync(t.file).ino;
    const part = path.join(path.dirname(t.file), '.proposal.html.partial');
    fs.copyFileSync(path.join(FIXTURES, 'decks', 'report.html'), part);
    fs.renameSync(part, t.file);
    t.s.own(path.dirname(t.file));
    expect(fs.statSync(t.file).ino).not.toBe(ino);
    expect(await reopen(t)).toEqual({ trust: 'protected', trustReason: UNTRUSTED, networkAllowed: false, editingAllowed: false });
    // The old decision is gone from trust.json: the new file is recorded as received, with both switches off.
    expect(entry(t)).toMatchObject({ marker: null, allowNetwork: false, editing: false, received: true });
  } finally {
    t.s.cleanup();
  }
});

test("the control: Blueline's own atomic write (also a new inode) keeps both switches", async () => {
  const t = setup();
  try {
    const { app, docId } = await openAndAllow(t);
    const ino = fs.statSync(t.file).ino;
    const text = fs.readFileSync(t.file, 'utf8').replace('</body>', '<!-- saved by Blueline -->\n</body>');
    await app.electronApp.evaluate(async (_e, a) => {
      await (globalThis as unknown as { __blTest: { ownWrite(id: string, text: string): Promise<void> } }).__blTest.ownWrite(a.docId, a.text);
    }, { docId, text });
    await app.close();
    expect(fs.readFileSync(t.file, 'utf8')).toBe(text);
    expect(fs.statSync(t.file).ino, 'the atomic write renames a new file into place').not.toBe(ino);
    expect(await reopen(t)).toEqual({ trust: 'protected', trustReason: UNTRUSTED, networkAllowed: true, editingAllowed: true });
  } finally {
    t.s.cleanup();
  }
});
