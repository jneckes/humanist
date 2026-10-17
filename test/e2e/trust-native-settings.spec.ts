// Settings (6.1 Settings › General; 6.10 Settings › Trust; 9.9 the strict option and the CDN allowlist), in the
// real app: open Settings, add and remove trusted and untrusted folders through main's folder dialog, the
// refusal for the home folder, the strict option and the allowlist, all persisted in config.json and read back
// after a relaunch. The Settings window is the app's own when the app wires it (__blSettings); until then the
// harness (trust-native-harness.ts) loads the same modules into the running app, and the test says which ran.

import { expect, test } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FIXTURES, Scratch, launchApp, resolveRunAs, type BlApp } from '../helpers/app';
import { answerFolderDialog, openSettings, readConfig, removeTrustableFolders, trustableFolder, waitConfig } from './trust-native-harness';

test.describe.configure({ mode: 'serial' });

const DEFAULT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com', 'esm.sh', 'cdn.tailwindcss.com', 'code.jquery.com'];

function deckIn(s: Scratch): string {
  const dir = s.dir('trust-native-deck');
  const file = path.join(dir, 'single.html');
  fs.copyFileSync(path.join(FIXTURES, 'decks', 'single.html'), file);
  s.own(file);
  return file;
}

async function launch(s: Scratch, userData?: string): Promise<BlApp> {
  const file = deckIn(s);
  const app = await launchApp({ files: [file], scratch: s, userData });
  await app.waitForDeck('single.html');
  return app;
}

test('Settings: General shows the default-app state; Trust adds and removes folders, refuses the home folder, toggles strict, edits the allowlist; all persist', async () => {
  const s = new Scratch(resolveRunAs());
  let app = await launch(s);
  const userData = app.userData;
  try {
    const { page, mode } = await openSettings(app);
    test.info().annotations.push({ type: 'settings-window', description: mode === 'app' ? "the app's own wiring" : 'loaded by trust-native-harness.ts (the app does not wire Settings yet)' });

    // 9.1: the page runs under the shell CSP and has only the Settings API (named functions).
    const api = await page.evaluate(() => Object.keys((window as unknown as { blueline: Record<string, unknown> }).blueline).sort());
    expect(api).toEqual(['addAllowlistHost', 'addFolder', 'getState', 'makeDefaultApp', 'onShowPane', 'onState', 'removeAllowlistHost', 'removeFolder', 'resetAllowlist', 'setStrictProtected']);
    expect(await page.evaluate(() => typeof (window as unknown as Record<string, unknown>).require)).toBe('undefined');

    // General: on Linux the platform cannot set the default (Linux packages are Later); the button says so.
    await expect(page.locator('#tab-general')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#default-status')).toHaveText(/cannot tell which app opens your HTML files/);
    await expect(page.locator('#make-default')).toBeDisabled();
    await expect(page.locator('#default-note')).toContainText('Linux');

    // Trust.
    await page.locator('#tab-trust').click();
    await expect(page.locator('#pane-trust')).toBeVisible();
    await expect(page.locator('#pane-general')).toBeHidden();
    await expect(page.locator('#trusted-list')).toContainText('No trusted folders.');
    await expect(page.locator('#allowlist li')).toHaveCount(DEFAULT_HOSTS.length);
    await expect(page.locator('#help-title')).toHaveText('About Protected view');
    await expect(page.locator('#help')).toContainText('dns-prefetch');
    await expect(page.locator('#help')).toContainText('TURN');

    // Add a trusted folder: main's dialog answers; the folder is stored as its realpath.
    const decks = trustableFolder('decks', (p) => s.own(p));
    const viaLink = path.join(s.dir('trust-native-link'), 'decks-link');
    fs.symlinkSync(decks, viaLink);
    await answerFolderDialog(app, viaLink);
    await page.locator('#add-trusted').click();
    await expect(page.locator('#trusted-list li.item')).toHaveCount(1);
    await expect(page.locator('#trusted-list .path')).toHaveText(decks);
    await expect(page.locator('#trusted-result')).toHaveText(`Added ${decks}.`);
    await waitConfig(app, (c) => JSON.stringify(c.trustedFolders) === JSON.stringify([decks]));

    // The home folder is refused, with the reason; nothing changes.
    await answerFolderDialog(app, app.info.home);
    await page.locator('#add-trusted').click();
    await expect(page.locator('#trusted-result')).toHaveText('The home folder cannot be a trusted folder.');
    await expect(page.locator('#trusted-list li.item')).toHaveCount(1);
    // So is a temporary folder.
    const tmp = s.dir('trust-native-tmp');
    await answerFolderDialog(app, tmp);
    await page.locator('#add-trusted').click();
    await expect(page.locator('#trusted-result')).toHaveText('A temporary folder cannot be a trusted folder.');
    // Cancel changes nothing and says nothing.
    await answerFolderDialog(app, null);
    await page.locator('#add-trusted').click();
    await expect(page.locator('#trusted-list li.item')).toHaveCount(1);

    // An untrusted folder may be in a temp dir.
    await answerFolderDialog(app, tmp);
    await page.locator('#add-untrusted').click();
    await expect(page.locator('#untrusted-list .path')).toHaveText(fs.realpathSync.native(tmp));
    await waitConfig(app, (c) => JSON.stringify(c.untrustedFolders) === JSON.stringify([fs.realpathSync.native(tmp)]));

    // Strict: "Block all network in Protected view".
    await expect(page.locator('#strict')).not.toBeChecked();
    await page.locator('#strict').check();
    await waitConfig(app, (c) => c.strictProtected === true);

    // The allowlist (9.9: user-editable): a host is added normalized; a URL is refused with the reason.
    await page.locator('#host-input').fill('https://evil.example/x');
    await page.locator('#add-host').click();
    await expect(page.locator('#host-result')).toContainText('Enter a host name');
    await page.locator('#host-input').fill('Fonts.Example.COM');
    await page.locator('#add-host').click();
    await expect(page.locator('#host-result')).toHaveText('Allowed fonts.example.com.');
    await expect(page.locator('#allowlist li.item')).toHaveCount(DEFAULT_HOSTS.length + 1);
    await page.locator('#allowlist li[data-host="unpkg.com"] .remove').click();
    await expect(page.locator('#allowlist li.item')).toHaveCount(DEFAULT_HOSTS.length);
    const cfg = await waitConfig(app, (c) => Array.isArray(c.cdnAllowlist) && (c.cdnAllowlist as string[]).includes('fonts.example.com') && !(c.cdnAllowlist as string[]).includes('unpkg.com'));
    expect(cfg.cdnAllowlist).toEqual([...DEFAULT_HOSTS.filter((h) => h !== 'unpkg.com'), 'fonts.example.com']);

    // Opening Settings again focuses the same window.
    const again = await openSettings(app, 'general');
    expect(again.page).toBe(page);
    await expect(page.locator('#tab-general')).toHaveAttribute('aria-selected', 'true');
    expect(app.electronApp.windows().filter((p) => p.url().startsWith('app://shell/settings.html'))).toHaveLength(1);

    await app.close();

    // Relaunch with the same userData: everything was kept in config.json.
    app = await launch(s, userData);
    const { page: p2 } = await openSettings(app, 'trust');
    await expect(p2.locator('#pane-trust')).toBeVisible();
    await expect(p2.locator('#trusted-list .path')).toHaveText(decks);
    await expect(p2.locator('#untrusted-list .path')).toHaveText(fs.realpathSync.native(tmp));
    await expect(p2.locator('#strict')).toBeChecked();
    await expect(p2.locator('#allowlist li[data-host="fonts.example.com"]')).toHaveCount(1);

    // Remove the folders, turn strict off, restore the default allowlist.
    await p2.locator('#trusted-list .remove').click();
    await expect(p2.locator('#trusted-list')).toContainText('No trusted folders.');
    await p2.locator('#untrusted-list .remove').click();
    await expect(p2.locator('#untrusted-list')).toContainText('No untrusted folders.');
    await p2.locator('#strict').uncheck();
    await p2.locator('#reset-allowlist').click();
    await expect(p2.locator('#host-result')).toHaveText('The allowlist is back to its defaults.');
    const after = await waitConfig(app, (c) => Array.isArray(c.trustedFolders) && (c.trustedFolders as unknown[]).length === 0 && c.strictProtected === false && c.cdnAllowlist === undefined);
    expect(after.untrustedFolders).toEqual([]);
    await expect(p2.locator('#reset-allowlist')).toBeDisabled();
    // Unknown fields the app wrote (the user's identity) are still there.
    expect(readConfig(app).personId).toBeTruthy();
  } finally {
    await app.close();
    s.cleanup();
    removeTrustableFolders();
  }
});
