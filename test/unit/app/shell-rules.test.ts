// The shell rule (9.1 Shell view; docs/ARCHITECTURE.md): no innerHTML, outerHTML, insertAdjacentHTML or
// document.write, and no data in style strings, anywhere in the shell or the preloads. This test is the
// "lint rule" that enforces it.
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repo = path.resolve(__dirname, '../../..');
const DIRS = ['packages/app/src/shell', 'packages/app/src/preload'];
const FORBIDDEN = /\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write(?:ln)?|cssText)\b|setAttribute\(\s*['"]style['"]/;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

describe('shell and preload DOM rules', () => {
  it('no HTML-string or style-string sinks in TypeScript sources', () => {
    const offenders: string[] = [];
    for (const d of DIRS) {
      const abs = path.join(repo, d);
      if (!fs.existsSync(abs)) continue;
      for (const f of fs.readdirSync(abs)) {
        if (!f.endsWith('.ts')) continue;
        const lines = stripComments(fs.readFileSync(path.join(abs, f), 'utf8')).split('\n');
        lines.forEach((l, i) => {
          if (FORBIDDEN.test(l)) offenders.push(`${d}/${f}:${i + 1}: ${l.trim()}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the shell page has no inline script or style, and states the 9.1 CSP', () => {
    const html = fs.readFileSync(path.join(repo, 'packages/app/src/shell/index.html'), 'utf8');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).toContain("default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'");
  });
});
