// scripts/check-registry.mjs (supply chain, docs/DEPENDENCIES.md): each package-lock.json integrity must be the one
// the npm registry signed. Offline: the signature check runs on manifests signed here with a throwaway key, and on
// a real registry signature (reveal.js 6.0.2, captured 2026-10-23) with the pinned registry key. The "bypass" case
// passed every check before (adversarial review, 2026-10-23): a well-formed sha512 of other content in the
// lockfile, which `npm audit signatures` never compares with the registry's.

import { generateKeyPairSync, sign } from 'node:crypto';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

type Json = Record<string, any>;
interface Key {
  keyid: string;
  expires: string | null;
  key: string;
}
interface Result {
  ok: boolean;
  problems: string[];
  keyid: string | null;
  needsPublishTime: boolean;
}
interface CheckRegistry {
  NPM_REGISTRY_KEYS: Key[];
  checkSigned(pkg: Json, manifest: Json | null, opts?: { keys?: Key[]; publishedAt?: string | null }): Result;
  lockedPackages(lock: Json): Json[];
}

const ROOT = path.resolve(__dirname, '../../..');
const SHA512 = (byte: number) => `sha512-${Buffer.alloc(64, byte).toString('base64')}`;
let cr: CheckRegistry;

beforeAll(async () => {
  cr = (await import(pathToFileURL(path.join(ROOT, 'scripts/check-registry.mjs')).href)) as CheckRegistry;
});

const pair = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const spki = (k: ReturnType<typeof pair>) => k.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const sig = (k: ReturnType<typeof pair>, msg: string) => sign('sha256', Buffer.from(msg), k.privateKey).toString('base64');

describe('check:registry', () => {
  const current = pair();
  const old = pair();
  const keys: Key[] = [
    { keyid: 'SHA256:old', expires: '2025-01-29T00:00:00.000Z', key: spki(old) },
    { keyid: 'SHA256:current', expires: null, key: spki(current) },
  ];
  const pkg = { name: 'left-pad', version: '1.3.0', integrity: SHA512(1), resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz' };
  const manifest = (integrity: string, signatures: Json[], tarball = pkg.resolved) => ({ name: pkg.name, version: pkg.version, dist: { integrity, tarball, signatures } });

  it('passes a package whose lockfile integrity the registry signed', () => {
    const r = cr.checkSigned(pkg, manifest(pkg.integrity, [{ keyid: 'SHA256:current', sig: sig(current, `left-pad@1.3.0:${pkg.integrity}`) }]), { keys });
    expect(r).toMatchObject({ ok: true, problems: [], keyid: 'SHA256:current' });
  });

  it('bypass: fails when the lockfile carries the sha512 of other content than the registry signed', () => {
    const registry = SHA512(2);
    const r = cr.checkSigned(pkg, manifest(registry, [{ keyid: 'SHA256:current', sig: sig(current, `left-pad@1.3.0:${registry}`) }]), { keys });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/left-pad@1\.3\.0: package-lock\.json has integrity sha512-AQEB.*, but the registry signed sha512-AgIC/);
  });

  it('fails on a bad signature, an unknown key, another tarball URL or a missing version', () => {
    const forged = cr.checkSigned(pkg, manifest(pkg.integrity, [{ keyid: 'SHA256:current', sig: sig(current, `left-pad@1.3.0:${SHA512(3)}`) }]), { keys });
    expect(forged.problems.join('\n')).toMatch(/no valid registry signature/);
    const unknown = cr.checkSigned(pkg, manifest(pkg.integrity, [{ keyid: 'SHA256:other', sig: sig(pair(), `left-pad@1.3.0:${pkg.integrity}`) }]), { keys });
    expect(unknown.problems.join('\n')).toMatch(/signed with SHA256:other, a key scripts\/check-registry\.mjs does not know/);
    const tarball = cr.checkSigned(pkg, manifest(pkg.integrity, [{ keyid: 'SHA256:current', sig: sig(current, `left-pad@1.3.0:${pkg.integrity}`) }], 'https://evil.example/left-pad.tgz'), { keys });
    expect(tarball.problems.join('\n')).toMatch(/the registry's tarball is https:\/\/evil\.example/);
    expect(cr.checkSigned(pkg, null, { keys }).problems.join('\n')).toMatch(/the registry has no such version/);
    expect(cr.checkSigned(pkg, manifest(pkg.integrity, []), { keys }).problems.join('\n')).toMatch(/no valid registry signature/);
  });

  it('accepts an expired key only for a version published before it expired', () => {
    const m = manifest(pkg.integrity, [{ keyid: 'SHA256:old', sig: sig(old, `left-pad@1.3.0:${pkg.integrity}`) }]);
    expect(cr.checkSigned(pkg, m, { keys })).toMatchObject({ ok: false, needsPublishTime: true });
    expect(cr.checkSigned(pkg, m, { keys, publishedAt: '2018-04-09T01:00:00.000Z' })).toMatchObject({ ok: true, keyid: 'SHA256:old' });
    expect(cr.checkSigned(pkg, m, { keys, publishedAt: '2025-06-01T00:00:00.000Z' }).problems.join('\n')).toMatch(/signed only with SHA256:old, which expired/);
  });

  it('verifies a real registry signature with the pinned registry key', () => {
    const reveal = { name: 'reveal.js', version: '6.0.2', integrity: 'sha512-JYIg5D9aoxoaLeb84O+OvAwsKWdIavVgEDScxtYEXFCT6t6TQrhNtSgogcjdCpdLsWglhJn3zyE3fUOwiH5KEg==', resolved: 'https://registry.npmjs.org/reveal.js/-/reveal.js-6.0.2.tgz' };
    const m = {
      name: 'reveal.js',
      version: '6.0.2',
      dist: {
        integrity: reveal.integrity,
        tarball: reveal.resolved,
        signatures: [{ keyid: 'SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U', sig: 'MEUCIQCDYdY7PywiFbvHJCFvuekVA/sMBSLPvOyaKd7IcFROUQIgCUWTAXQ8Y8E1STBRqynYF/8ecvNknC/k7OOMmevyPOc=' }],
      },
    };
    expect(cr.checkSigned(reveal, m)).toMatchObject({ ok: true, keyid: 'SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U' });
    expect(cr.checkSigned({ ...reveal, integrity: SHA512(5) }, { ...m, dist: { ...m.dist, integrity: SHA512(5) } }).ok).toBe(false);
  });

  it('lists every registry package of a lockfile once, and notices two integrities for one version', () => {
    const lock = {
      packages: {
        '': {},
        'packages/app': {},
        'node_modules/@blueline/app': { link: true, resolved: 'packages/app' },
        'node_modules/a': { version: '1.0.0', integrity: SHA512(1) },
        'node_modules/x/node_modules/a': { version: '1.0.0', integrity: SHA512(2) },
        'node_modules/@s/b': { version: '2.0.0', integrity: SHA512(3) },
      },
    };
    const list = cr.lockedPackages(lock);
    expect(list.map((p) => `${p.name}@${p.version}`)).toEqual(['a@1.0.0', '@s/b@2.0.0']);
    expect(list[0].conflict).toBe(true);
  });
});
