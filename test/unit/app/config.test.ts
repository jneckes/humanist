// config.json (9.7): identity and one-time flags, written atomically, unknown fields kept.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigStore, sanitizeConfig } from '../../../packages/app/src/main/config';

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-config-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('ConfigStore', () => {
  it('starts empty, writes atomically (0600), and reads back', async () => {
    const s = ConfigStore.forUserData(dir);
    expect(s.load()).toEqual({ seen: undefined });
    await s.update({ name: 'Josh', personId: 'josh-ab12', color: '#2563eb' });
    await s.update({ seen: { saveExplained: true } });
    const f = path.join(dir, 'config.json');
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    const again = ConfigStore.forUserData(dir).load();
    expect(again).toEqual({ name: 'Josh', personId: 'josh-ab12', color: '#2563eb', seen: { saveExplained: true } });
  });

  it('keeps fields it does not know (a newer version may have written them)', async () => {
    const f = path.join(dir, 'config.json');
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    raw.trustedFolders = ['/Users/j/Decks'];
    fs.writeFileSync(f, JSON.stringify(raw));
    const s = ConfigStore.forUserData(dir);
    s.load();
    await s.update({ name: 'Josh N' });
    const after = JSON.parse(fs.readFileSync(f, 'utf8'));
    expect(after.trustedFolders).toEqual(['/Users/j/Decks']);
    expect(after.name).toBe('Josh N');
  });

  it('a broken file reads as empty', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-config-bad-'));
    fs.writeFileSync(path.join(d, 'config.json'), '{nope');
    expect(ConfigStore.forUserData(d).load()).toEqual({ seen: undefined });
    fs.rmSync(d, { recursive: true, force: true });
  });

  it('sanitizeConfig drops invalid values', () => {
    expect(sanitizeConfig({ name: '  ', personId: 'Bad Id', color: 'red', seen: { saveExplained: 'yes' } })).toEqual({});
    expect(sanitizeConfig({ name: ' Ann ', personId: 'ann-x1y2', color: '#aabbcc' })).toEqual({ name: 'Ann', personId: 'ann-x1y2', color: '#aabbcc' });
    expect(sanitizeConfig([1])).toEqual({});
  });
});
