// config.json (9.7): identity and one-time flags, written atomically, unknown fields kept; the settings defaults
// (Phase 2: smart punctuation, 6.3 "default on; toggle in settings").
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigStore, DEFAULT_SMART_PUNCTUATION, configGeneralSettings, sanitizeConfig, smartPunctuationDefault, smartPunctuationFor } from '../../../packages/app/src/main/config';

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

describe('settings defaults (9.7; 6.3 Smart punctuation)', () => {
  it('smart punctuation is on by default; a document’s own setting wins over the default', () => {
    expect(DEFAULT_SMART_PUNCTUATION).toBe(true);
    expect(smartPunctuationDefault({})).toBe(true);
    expect(smartPunctuationDefault({ defaults: { smartPunctuation: false } })).toBe(false);
    expect(smartPunctuationFor({}, undefined)).toBe(true);
    expect(smartPunctuationFor({ defaults: { smartPunctuation: false } }, {})).toBe(false);
    expect(smartPunctuationFor({ defaults: { smartPunctuation: false } }, { smartPunctuation: true })).toBe(true);
    expect(smartPunctuationFor({}, { smartPunctuation: false })).toBe(false);
    expect(smartPunctuationFor({}, null)).toBe(true);
  });

  it('sanitizeConfig keeps a boolean default only', () => {
    expect(sanitizeConfig({ defaults: { smartPunctuation: false } })).toEqual({ defaults: { smartPunctuation: false } });
    expect(sanitizeConfig({ defaults: { smartPunctuation: 'no' } })).toEqual({});
    expect(sanitizeConfig({ defaults: [true] })).toEqual({});
    expect(sanitizeConfig({ defaults: JSON.parse('{"__proto__": {"smartPunctuation": false}}') })).toEqual({});
  });

  it('configGeneralSettings: stored in config.json `defaults`, listeners told once per change; unknown defaults kept', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-config-general-'));
    const f = path.join(d, 'config.json');
    fs.writeFileSync(f, JSON.stringify({ name: 'Josh', defaults: { futureThing: 3 } }));
    const store = ConfigStore.forUserData(d);
    store.load();
    const g = configGeneralSettings(store);
    const heard: boolean[] = [];
    const off = g.onChange((s) => heard.push(s.smartPunctuation));
    g.onChange(() => {
      throw new Error('a listener that throws');
    });
    expect(g.get()).toEqual({ smartPunctuation: true });
    await g.setSmartPunctuation(false);
    await g.setSmartPunctuation(false);
    expect(g.get()).toEqual({ smartPunctuation: false });
    expect(heard).toEqual([false]);
    await store.idle();
    const disk = JSON.parse(fs.readFileSync(f, 'utf8'));
    expect(disk.defaults).toEqual({ futureThing: 3, smartPunctuation: false });
    expect(disk.name).toBe('Josh');
    expect(ConfigStore.forUserData(d).load().defaults).toEqual({ smartPunctuation: false });
    off();
    await g.setSmartPunctuation(true);
    expect(heard).toEqual([false]);
    await expect(g.setSmartPunctuation('yes' as never)).rejects.toThrow();
    // Another update leaves the defaults alone.
    await store.update({ railHidden: true });
    await store.idle();
    expect(JSON.parse(fs.readFileSync(f, 'utf8')).defaults).toEqual({ futureThing: 3, smartPunctuation: true });
    fs.rmSync(d, { recursive: true, force: true });
  });
});
