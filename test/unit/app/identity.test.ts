// The user's identity (6.8 Identity; section 8 Person id check), and Phase 2's name chip (main side): setName with
// the first-run rules, the Person changed in place, listeners updating open sessions' people.
import { describe, expect, it } from 'vitest';
import type { Session } from '@blueline/core/types';
import { Identity, NAME_RULE, gitUserName, newPersonId, parseGitUserName, resolvePerson, slugifyName } from '../../../packages/app/src/main/identity';
import { NotesStore, updatePersonIn } from '../../../packages/app/src/main/notes';
import { emptySession } from '../../../packages/app/src/main/session-store';

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

describe('Identity.setName (the name chip, 6.8)', () => {
  const setup = (opts: { fail?: boolean } = {}) => {
    const person = { id: 'josh-ab12', name: 'Josh', color: '#2563eb' };
    const stored: string[] = [];
    const id = new Identity(person, {
      update: async (p) => {
        if (opts.fail) throw new Error('disk full');
        stored.push(p.name);
      },
    });
    return { person, stored, id };
  };

  it('stores the name, changes the live Person in place (same object, same id), and tells listeners', async () => {
    const { person, stored, id } = setup();
    const heard: unknown[] = [];
    id.onChange((p) => heard.push(p));
    expect(await id.setName('  Josh   Neckes ')).toEqual({ ok: true, name: 'Josh Neckes' });
    expect(stored).toEqual(['Josh Neckes']);
    expect(id.person).toBe(person);
    expect(person).toEqual({ id: 'josh-ab12', name: 'Josh Neckes', color: '#2563eb' });
    expect(heard).toEqual([{ id: 'josh-ab12', name: 'Josh Neckes', color: '#2563eb' }]);
    // The same name again stores nothing and tells nobody.
    expect(await id.setName('Josh Neckes')).toEqual({ ok: true, name: 'Josh Neckes' });
    expect(stored).toHaveLength(1);
    expect(heard).toHaveLength(1);
  });

  it('refuses what first run refuses, keeping the name', async () => {
    const { person, stored, id } = setup();
    for (const bad of ['', '   ', 'a'.repeat(201), 'two\nlines', 'tab\there', 'nul\u0000', 'lone \uD800', 'sep\u2028', 42, null, { name: 'x' }]) {
      expect(await id.setName(bad), JSON.stringify(bad)).toEqual({ ok: false, name: 'Josh', reason: NAME_RULE });
    }
    expect(NAME_RULE).toBe('A name is 1 to 200 characters, on one line.');
    expect(stored).toEqual([]);
    expect(person.name).toBe('Josh');
    expect(await id.setName('Zoë O’Brien 😀')).toEqual({ ok: true, name: 'Zoë O’Brien 😀' });
  });

  it('a name that cannot be saved is not taken', async () => {
    const logged: string[] = [];
    const person = { id: 'josh-ab12', name: 'Josh', color: '#2563eb' };
    const id = new Identity(person, { update: () => Promise.reject(new Error('disk full')) }, (m) => logged.push(m));
    const heard: unknown[] = [];
    id.onChange((p) => heard.push(p));
    expect(await id.setName('Anna')).toEqual({ ok: false, name: 'Josh', reason: 'The name could not be saved.' });
    expect(person.name).toBe('Josh');
    expect(heard).toEqual([]);
    expect(logged.join()).toMatch(/disk full/);
  });

  it('adoptName: a name first run already stored; listeners can be removed, and one that throws does not stop the rest', () => {
    const { person, stored, id } = setup();
    const heard: string[] = [];
    id.onChange(() => {
      throw new Error('boom');
    });
    const off = id.onChange((p) => heard.push(p.name));
    id.adoptName('Anna');
    id.adoptName('bad\nname');
    id.adoptName('Anna');
    expect(person.name).toBe('Anna');
    expect(heard).toEqual(['Anna']);
    expect(stored).toEqual([]);
    off();
    id.adoptName('Ben');
    expect(heard).toEqual(['Anna']);
  });

  it('a listener updates the person in every open session’s people (notes keep the same author id)', async () => {
    const { person, id } = setup();
    const sessions: Session[] = [0, 1].map(() => emptySession({ path: '/d.html', realpath: '/d.html', fileKey: '0123456789abcdef', sha256: 'f'.repeat(64), title: 'T' }));
    const stores = sessions.map((s) => new NotesStore(s, { me: () => person, now: () => 't', version: () => 'f'.repeat(64), slides: () => null }));
    stores[0].addVerbatim({ before: 'a', after: 'b', target: null, slide: null });
    const changed: boolean[] = [];
    id.onChange((p) => stores.forEach((n) => changed.push(n.updatePerson(p))));
    await id.setName('Joshua');
    expect(changed).toEqual([true, false]);
    expect(sessions[0].people).toEqual([{ id: 'josh-ab12', name: 'Joshua', color: '#2563eb' }]);
    expect(sessions[1].people).toEqual([]);
    expect(sessions[0].notes[0].author).toBe('josh-ab12');
  });
});

describe('Identity.trackSession (6.8: open sessions follow the name)', () => {
  it('brings a session up to date when tracked, updates and saves it on every change, and stops when untracked', async () => {
    const person = { id: 'josh-ab12', name: 'Josh', color: '#2563eb' };
    const logged: string[] = [];
    const id = new Identity(person, { update: async () => undefined }, (m) => logged.push(m));
    const s = emptySession({ path: '/d.html', realpath: '/d.html', fileKey: '0123456789abcdef', sha256: 'f'.repeat(64), title: 'T' });
    // The name changed while no window showed this document.
    s.people.push({ id: 'josh-ab12', name: 'Old Name', color: '#2563eb' }, { id: 'anna-x7k2', name: 'Anna', color: '#123456' });
    const notes = new NotesStore(s, { me: () => person, now: () => 't', version: () => 'f'.repeat(64), slides: () => null });
    let saves = 0;
    const stop = id.trackSession({ updatePerson: (p) => notes.updatePerson(p), save: () => saves++ });
    expect(s.people[0].name).toBe('Josh');
    expect(saves).toBe(1);
    await id.setName('Joshua');
    expect(s.people).toEqual([{ id: 'josh-ab12', name: 'Joshua', color: '#2563eb' }, { id: 'anna-x7k2', name: 'Anna', color: '#123456' }]);
    expect(saves).toBe(2);
    // A session without the user's notes is not saved.
    const other = emptySession({ path: '/e.html', realpath: '/e.html', fileKey: 'fedcba9876543210', sha256: 'f'.repeat(64), title: 'E' });
    let otherSaves = 0;
    id.trackSession({ updatePerson: (p) => updatePersonIn(other, p), save: () => otherSaves++ });
    // A failing save is logged, not thrown.
    id.trackSession({ updatePerson: () => true, save: () => Promise.reject(new Error('disk full')) });
    stop();
    await id.setName('J');
    expect(s.people[0].name).toBe('Joshua');
    expect(otherSaves).toBe(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(logged.join()).toMatch(/disk full/);
  });
});
