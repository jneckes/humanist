// Supply-chain rules that live in the repository's text rather than in a script (docs/DEPENDENCIES.md). Each
// failed before the fixes of the adversarial review of 2026-10-23:
//   - every Playwright Electron launch names the binary (scripts/electron-binary.cjs): without executablePath,
//     Playwright requires electron's index.js, which downloads a missing binary;
//   - every documented `gh attestation verify` pins the workflow, the branch and GitHub-hosted runners: with
//     --repo alone it accepts an attestation from any workflow of the repository, on any ref;
//   - every CI job that installs sets npm's safety settings in its environment (which no npmrc overrides) and
//     checks the lockfile against the registry before `npm ci`, and what was installed after.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');

function files(dir: string, re: RegExp): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (re.test(e.name)) out.push(p);
    }
  };
  walk(path.join(ROOT, dir));
  return out;
}

/** The argument list of the call whose opening parenthesis is at `open` (balanced parentheses). */
function callArgs(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

describe('Electron launches never download Electron', () => {
  it('every _electron.launch in the tests and scripts passes executablePath', () => {
    const calls: string[] = [];
    const missing: string[] = [];
    for (const file of [...files('test', /\.(ts|mjs|cjs|js)$/), ...files('scripts', /\.(ts|mjs|cjs|js)$/)]) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\b_?electron\.launch\s*\(/g)) {
        const where = `${path.relative(ROOT, file)}:${text.slice(0, m.index).split('\n').length}`;
        calls.push(where);
        if (!/\bexecutablePath\s*:/.test(callArgs(text, m.index + m[0].length - 1))) missing.push(where);
      }
    }
    expect(calls.length).toBeGreaterThan(5);
    expect(missing).toEqual([]);
  });
});

describe('the documented build provenance check', () => {
  it('every `gh attestation verify` pins the Mac build workflow, a branch and GitHub-hosted runners', () => {
    const docs = [
      ...['README.md', 'SECURITY.md', 'CONTRIBUTING.md'].map((f) => path.join(ROOT, f)),
      ...files('docs', /\.md$/),
      ...fs.readdirSync(path.join(ROOT, '.github/workflows')).map((f) => path.join(ROOT, '.github/workflows', f)),
    ].filter((f) => fs.existsSync(f));
    const commands: string[] = [];
    for (const file of docs) {
      // Join shell continuations (a trailing backslash, and a YAML comment's leading #).
      const text = fs.readFileSync(file, 'utf8').replace(/\\\n\s*#?\s*/g, ' ');
      for (const m of text.matchAll(/gh attestation verify[^\n`]*/g)) commands.push(`${path.relative(ROOT, file)}: ${m[0]}`);
    }
    expect(commands.length).toBeGreaterThanOrEqual(3);
    for (const c of commands) {
      expect(c, c).toMatch(/--repo jneckes\/humanist\b/);
      expect(c, c).toMatch(/--signer-workflow jneckes\/humanist\/\.github\/workflows\/mac-build\.yml\b/);
      expect(c, c).toMatch(/--source-ref refs\/heads\/\S+/);
      expect(c, c).toMatch(/--deny-self-hosted-runners\b/);
    }
  });
});

describe('CI installs with npm\'s safety settings, between the checks', () => {
  const workflows = fs.readdirSync(path.join(ROOT, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f));

  it('every job that runs npm ci sets ignore-scripts, git and the registry in its environment, and runs the checks around it', () => {
    let jobs = 0;
    for (const wf of workflows) {
      const text = fs.readFileSync(path.join(ROOT, '.github/workflows', wf), 'utf8');
      const body = text.slice(text.indexOf('\njobs:\n'));
      // Jobs are the two-space-indented keys under jobs:.
      const starts = [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)];
      starts.forEach((m, i) => {
        const block = body.slice(m.index, starts[i + 1]?.index ?? body.length);
        if (!/run: npm ci\b/.test(block)) return;
        jobs++;
        const name = `${wf} ${m[1]}`;
        expect(block, name).toMatch(/^ {6}npm_config_ignore_scripts: 'true'$/m);
        expect(block, name).toMatch(/^ {6}npm_config_git: 'false'$/m);
        expect(block, name).toMatch(/^ {6}npm_config_registry: https:\/\/registry\.npmjs\.org\/$/m);
        const at = (cmd: string) => block.indexOf(`run: ${cmd}`);
        expect(at('npm run check:lockfile'), name).toBeGreaterThan(0);
        expect(at('npm run check:registry'), name).toBeGreaterThan(at('npm run check:lockfile'));
        expect(at('npm ci'), name).toBeGreaterThan(at('npm run check:registry'));
        expect(at('npm run check:installed'), name).toBeGreaterThan(at('npm ci'));
      });
    }
    expect(jobs).toBeGreaterThanOrEqual(2);
  });
});
