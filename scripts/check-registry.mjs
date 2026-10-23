#!/usr/bin/env node
// `npm run check:registry`: every package in package-lock.json is the one the npm registry signed (supply chain,
// docs/DEPENDENCIES.md). CI runs it after check:lockfile and before `npm ci`.
//
// For each registry package in package-lock.json (every platform's, installed here or not) it fetches the
// version's manifest from https://registry.npmjs.org/ and checks that
//   - the registry's ECDSA signature over "<name>@<version>:<integrity>" verifies with one of the registry's keys
//     (NPM_REGISTRY_KEYS, pinned here; a key that has expired counts only for a version published before it
//     expired, as npm decides), and
//   - that signed integrity is the lockfile's integrity, and the tarball URL the lockfile's.
// `npm ci` checks each tarball against the lockfile's integrity, and `npm audit signatures` checks the registry's
// signature over the registry's own integrity, but nothing else compares the two: a lockfile could carry the sha512
// of other content (served from a poisoned npm cache, say) and pass both. Here it fails.
//
// Usage: node scripts/check-registry.mjs [--root <dir>] [--concurrency 16]. Needs the network (HTTPS_PROXY is
// honoured).
import { spawnSync } from 'node:child_process';
import { verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REGISTRY, ROOT, nameOf } from './check-lockfile.mjs';

/**
 * The npm registry's signing keys, from https://registry.npmjs.org/-/npm/v1/keys (2026-10-23), the keys npm's
 * own TUF root lists for registry.npmjs.org. When the registry rotates its key, a package signed only with the new
 * one fails here ("signed with a key scripts/check-registry.mjs does not know"): check the new key against both
 * sources before adding it.
 */
export const NPM_REGISTRY_KEYS = [
  {
    keyid: 'SHA256:jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA',
    expires: '2025-01-29T00:00:00.000Z',
    key: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE1Olb3zMAFFxXKHiIkQO5cJ3Yhl5i6UPp+IhuteBJbuHcA5UogKo0EWtlWwW6KSaKoTNEYL7JlCQiVnkhBktUgg==',
  },
  {
    keyid: 'SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U',
    expires: null,
    key: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEY6Ya7W++7aUPzvMTrezH6Ycx3c+HOKYCcNGybJZSCJq/fd7Qa8uuAKtdIkUQtQiEKERhAmE5lMMJhP8OkDOa2g==',
  },
];

/** The registry packages of a package-lock.json: [{ name, version, integrity, resolved, keys: [lockfile keys] }]. */
export function lockedPackages(lock) {
  const byId = new Map();
  for (const [key, e] of Object.entries(lock.packages ?? {})) {
    if (!key.includes('node_modules/') || e.link) continue;
    const name = nameOf(key);
    const id = `${name}@${e.version}`;
    const prev = byId.get(id);
    if (prev) {
      prev.keys.push(key);
      if (prev.integrity !== e.integrity) prev.conflict = true;
    } else byId.set(id, { name, version: e.version, integrity: e.integrity, resolved: e.resolved, keys: [key] });
  }
  return [...byId.values()];
}

/**
 * Checks one locked package against its registry manifest (GET <registry>/<name>/<version>). `publishedAt`: the
 * version's publish time (ISO), needed only when its only valid signatures are from an expired key.
 * Returns { ok, problems, keyid, needsPublishTime }.
 */
export function checkSigned(pkg, manifest, { keys = NPM_REGISTRY_KEYS, publishedAt = null } = {}) {
  const problems = [];
  const id = `${pkg.name}@${pkg.version}`;
  if (pkg.conflict) problems.push(`${id}: package-lock.json gives it two different integrities`);
  if (!manifest || manifest.name !== pkg.name || manifest.version !== pkg.version) {
    return { ok: false, problems: [...problems, `${id}: the registry has no such version`], keyid: null, needsPublishTime: false };
  }
  const integrity = manifest.dist?.integrity;
  if (integrity !== pkg.integrity) problems.push(`${id}: package-lock.json has integrity ${pkg.integrity}, but the registry signed ${integrity ?? '(none)'}`);
  if (pkg.resolved && manifest.dist?.tarball !== pkg.resolved) problems.push(`${id}: package-lock.json resolves ${pkg.resolved}, the registry's tarball is ${manifest.dist?.tarball}`);
  const message = Buffer.from(`${pkg.name}@${pkg.version}:${integrity}`);
  let valid = null;
  let expiredOnly = null;
  const unknown = [];
  for (const sig of manifest.dist?.signatures ?? []) {
    const key = keys.find((k) => k.keyid === sig.keyid);
    if (!key) {
      unknown.push(sig.keyid);
      continue;
    }
    let good = false;
    try {
      good = verify('sha256', message, { key: Buffer.from(key.key, 'base64'), format: 'der', type: 'spki' }, Buffer.from(sig.sig, 'base64'));
    } catch {
      good = false;
    }
    if (!good) continue;
    if (!key.expires) {
      valid = key.keyid;
      break;
    }
    if (publishedAt && Date.parse(publishedAt) < Date.parse(key.expires)) {
      valid = key.keyid;
      break;
    }
    expiredOnly = key;
  }
  if (!valid) {
    if (expiredOnly && !publishedAt) return { ok: false, problems, keyid: null, needsPublishTime: true };
    if (expiredOnly) problems.push(`${id}: signed only with ${expiredOnly.keyid}, which expired ${expiredOnly.expires}, before this version was published (${publishedAt})`);
    else if (unknown.length) problems.push(`${id}: signed with ${unknown.join(', ')}, a key scripts/check-registry.mjs does not know (NPM_REGISTRY_KEYS)`);
    else problems.push(`${id}: no valid registry signature over ${pkg.name}@${pkg.version}:${integrity}`);
  }
  return { ok: problems.length === 0 && !!valid, problems, keyid: valid, needsPublishTime: false };
}

const encode = (name) => name.replace('/', '%2f');

async function getJson(url, tries = 4) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i >= tries) throw new Error(`${url}: ${e instanceof Error ? e.message : String(e)}`);
      await new Promise((res) => setTimeout(res, 1000 * 2 ** (i - 1)));
    }
  }
}

/** Checks every registry package of `root`'s package-lock.json. Returns { errors, summary }. */
export async function checkRegistry(root = ROOT, { concurrency = 16, registry = REGISTRY } = {}) {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const pkgs = lockedPackages(lock);
  const errors = [];
  const byKey = new Map();
  let next = 0;
  let packuments = 0;
  const worker = async () => {
    while (next < pkgs.length) {
      const pkg = pkgs[next++];
      try {
        const manifest = await getJson(`${registry}${encode(pkg.name)}/${pkg.version}`);
        let r = checkSigned(pkg, manifest);
        if (r.needsPublishTime) {
          // Signed only with the expired key: valid if the version was published before it expired.
          const packument = await getJson(`${registry}${encode(pkg.name)}`);
          packuments++;
          r = checkSigned(pkg, manifest, { publishedAt: packument?.time?.[pkg.version] ?? null });
          if (r.needsPublishTime) r.problems.push(`${pkg.name}@${pkg.version}: the registry gives no publish time`);
        }
        errors.push(...r.problems);
        if (r.keyid) byKey.set(r.keyid, (byKey.get(r.keyid) ?? 0) + 1);
      } catch (e) {
        errors.push(`${pkg.name}@${pkg.version}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  const keys = [...byKey].map(([k, n]) => `${n} with ${k}${NPM_REGISTRY_KEYS.find((x) => x.keyid === k)?.expires ? ' (expired key; published before it expired)' : ''}`);
  const summary = `${pkgs.length} packages: the registry's signed integrity is package-lock.json's for each (${keys.join(', ')}); ${packuments} publish times checked.`;
  return { errors, summary };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Node's fetch honours HTTPS_PROXY only with NODE_USE_ENV_PROXY=1 (Node 22.21+), read at startup.
  const proxied = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxied && !process.env.NODE_USE_ENV_PROXY) {
    const r = spawnSync(process.execPath, ['--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
    });
    process.exit(r.status ?? 1);
  }
  const argv = process.argv.slice(2);
  const root = argv.includes('--root') ? resolve(argv[argv.indexOf('--root') + 1]) : ROOT;
  const concurrency = argv.includes('--concurrency') ? Number(argv[argv.indexOf('--concurrency') + 1]) : 16;
  const t0 = Date.now();
  const { errors, summary } = await checkRegistry(root, { concurrency });
  if (errors.length) {
    console.error(`check:registry: ${errors.length} problem${errors.length === 1 ? '' : 's'}`);
    for (const e of errors.sort()) console.error(`  ${e}`);
    process.exit(1);
  }
  console.log(`check:registry: ok. ${summary} ${((Date.now() - t0) / 1000).toFixed(1)} s.`);
}
