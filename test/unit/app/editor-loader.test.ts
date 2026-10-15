// The capability seam (D11, 9.6): main loads dist/editor.cjs at runtime and never imports packages/editor.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isEditorModule, loadEditor, loadEditorDetailed } from '../../../packages/app/src/main/editor-loader';

let root: string;
const mk = (name: string, code: string | null) => {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  if (code !== null) fs.writeFileSync(path.join(d, 'editor.cjs'), code);
  return d;
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-editor-'));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('loadEditor', () => {
  it('loads an editor.cjs that exports EditorModule: capabilities edit and agent on', () => {
    const d = mk('good', "exports.editorVersion = '9.9.9'; exports.createWriteQueue = function () { return {}; };");
    const r = loadEditorDetailed(d);
    expect(r.editor?.editorVersion).toBe('9.9.9');
    expect(r.capabilities).toEqual({ edit: true, agent: true });
    expect(r.why).toBeNull();
    expect(loadEditor(d)).not.toBeNull();
  });

  it('no editor.cjs (reader-only build): both capabilities off', () => {
    const r = loadEditorDetailed(mk('none', null));
    expect(r).toMatchObject({ editor: null, capabilities: { edit: false, agent: false } });
    expect(r.why).toMatch(/not found/);
  });

  it('a bundle that throws or exports the wrong shape is not loaded', () => {
    expect(loadEditorDetailed(mk('throws', "throw new Error('boom');")).why).toMatch(/failed to load: boom/);
    expect(loadEditorDetailed(mk('shape', 'exports.editorVersion = 1;')).why).toMatch(/does not export/);
  });

  it('the reader-only build flag wins', () => {
    const d = mk('flag', "exports.editorVersion = '1'; exports.createWriteQueue = () => ({});");
    const before = process.env.BLUELINE_READER_ONLY;
    process.env.BLUELINE_READER_ONLY = '1';
    try {
      expect(loadEditor(d)).toBeNull();
    } finally {
      if (before === undefined) delete process.env.BLUELINE_READER_ONLY;
      else process.env.BLUELINE_READER_ONLY = before;
    }
  });

  it('isEditorModule', () => {
    expect(isEditorModule({ editorVersion: '1', createWriteQueue: () => ({}) })).toBe(true);
    expect(isEditorModule(null)).toBe(false);
    expect(isEditorModule({ editorVersion: '1' })).toBe(false);
  });

  it('nothing in packages/app or packages/cli imports packages/editor (D11)', () => {
    const repo = path.resolve(__dirname, '../../..');
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.ts$/.test(e.name) && /from\s+['"](@blueline\/editor|[./]+\/editor\/)|require\(['"]@blueline\/editor/.test(fs.readFileSync(p, 'utf8'))) offenders.push(p);
      }
    };
    walk(path.join(repo, 'packages/app/src'));
    walk(path.join(repo, 'packages/cli/src'));
    expect(offenders).toEqual([]);
  });
});
