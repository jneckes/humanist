// The user's identity (6.8 Identity; section 8 Person id check).
import { describe, expect, it } from 'vitest';
import { gitUserName, newPersonId, parseGitUserName, resolvePerson, slugifyName } from '../../../packages/app/src/main/identity';

const PERSON_ID = /^[a-z0-9-]{1,40}$/;

describe('Person ids', () => {
  it('slug: a-z, 0-9 and - only, cut to 35 characters', () => {
    expect(slugifyName('Josh Neckes')).toBe('josh-neckes');
    expect(slugifyName('  Ána  Müller-Ström ')).toBe('ana-muller-strom');
    expect(slugifyName('李雷')).toBe('user');
    expect(slugifyName('---')).toBe('user');
    const long = slugifyName('a'.repeat(30) + ' ' + 'b'.repeat(30));
    expect(long.length).toBeLessThanOrEqual(35);
    expect(long.endsWith('-')).toBe(false);
  });

  it('id = slug + "-" + 4 random [a-z0-9], always passing the section 8 check', () => {
    let k = 0;
    const id = newPersonId('Josh Neckes', () => k++);
    expect(id).toBe('josh-neckes-abcd');
    for (const name of ['x', 'Anna', 'a'.repeat(200), '!!!', 'Zoë O’Brien', '\u0000']) {
      const v = newPersonId(name);
      expect(v).toMatch(PERSON_ID);
      expect(v).toMatch(/-[a-z0-9]{4}$/);
    }
  });
});

describe('name sources', () => {
  it('parses user.name from a git config file', () => {
    expect(parseGitUserName('[core]\n\tname = no\n[user]\n\tname = Josh Neckes\n\temail = j@x')).toBe('Josh Neckes');
    expect(parseGitUserName('[user]\n  name = "Anna Ström" ; comment\n')).toBe('Anna Ström');
    expect(parseGitUserName('[user]\nname = A\n[user]\nname = B # later wins\n')).toBe('B');
    expect(parseGitUserName('[user "x"]\nname = Sub\n')).toBe('Sub');
    expect(parseGitUserName('[alias]\nname = no\n')).toBeNull();
    expect(parseGitUserName('')).toBeNull();
  });

  it('reads $GIT_CONFIG_GLOBAL, ~/.gitconfig, then the XDG file', () => {
    const files: Record<string, string> = { '/h/.config/git/config': '[user]\nname = Xdg' };
    const read = (p: string) => files[p] ?? null;
    expect(gitUserName({}, '/h', read)).toBe('Xdg');
    files['/h/.gitconfig'] = '[user]\nname = Home';
    expect(gitUserName({}, '/h', read)).toBe('Home');
    files['/g'] = '[user]\nname = Env';
    expect(gitUserName({ GIT_CONFIG_GLOBAL: '/g' }, '/h', read)).toBe('Env');
    expect(gitUserName({}, '/nohome', () => null)).toBeNull();
  });

  it('config name, else git, else the OS user; derived values are stored', () => {
    const r1 = resolvePerson({ name: 'Josh', personId: 'josh-ab12', color: '#123456' }, { gitName: () => 'G', osName: () => 'o' });
    expect(r1).toEqual({ person: { id: 'josh-ab12', name: 'Josh', color: '#123456' }, patch: null });
    const r2 = resolvePerson({}, { gitName: () => 'Git Name', osName: () => 'os', rand: () => 0 });
    expect(r2.person).toEqual({ id: 'git-name-aaaa', name: 'Git Name', color: '#2563eb' });
    expect(r2.patch).toEqual({ name: 'Git Name', personId: 'git-name-aaaa', color: '#2563eb' });
    const r3 = resolvePerson({}, { gitName: () => null, osName: () => 'josh', rand: () => 1 });
    expect(r3.person.name).toBe('josh');
    // A stored id survives a name change, so earlier notes stay the user's.
    const r4 = resolvePerson({ name: 'New Name', personId: 'old-name-zzzz' }, { gitName: () => null, osName: () => null });
    expect(r4.person.id).toBe('old-name-zzzz');
  });
});
