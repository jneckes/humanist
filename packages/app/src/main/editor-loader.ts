// The capability seam (D11, 9.6). Main never imports packages/editor: the build fails if anything does.
// The Edit capability ships as dist/editor.cjs next to main.cjs; when that file is present (and the build
// is not reader-only) main loads it at runtime and codes against EditorModule. capabilities = {edit, agent}
// are both true exactly when the editor loaded (v1, 9.6).

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { EditorModule } from '@blueline/core/capabilities';
import type { Capabilities } from '@blueline/core/ipc';

export const EDITOR_BUNDLE = 'editor.cjs';

export interface EditorLoad {
  editor: EditorModule | null;
  capabilities: Capabilities;
  /** Why the editor is absent (reader-only build, missing bundle, load error), for logs. */
  why: string | null;
}

/** True for an object shaped like EditorModule (the bundle's exports). */
export function isEditorModule(m: unknown): m is EditorModule {
  if (!m || (typeof m !== 'object' && typeof m !== 'function')) return false;
  const o = m as Record<string, unknown>;
  return typeof o.editorVersion === 'string' && typeof o.createWriteQueue === 'function';
}

/**
 * Loads `<dir>/editor.cjs` (default: the folder of main.cjs). Returns null when the build is reader-only,
 * the file is absent, or it fails to load or does not export the EditorModule interface.
 */
export function loadEditorDetailed(dir: string = __dirname): EditorLoad {
  const none = (why: string): EditorLoad => ({ editor: null, capabilities: { edit: false, agent: false }, why });
  // esbuild replaces this with '1' in the reader-only build (scripts/build.mjs), which ships no editor.cjs.
  if (process.env.BLUELINE_READER_ONLY === '1') return none('reader-only build');
  const file = path.join(dir, EDITOR_BUNDLE);
  if (!fs.existsSync(file)) return none(`${EDITOR_BUNDLE} not found`);
  let mod: unknown;
  try {
    // createRequire keeps esbuild from trying to bundle the path; the editor is loaded at runtime only.
    mod = createRequire(path.join(dir, 'main.cjs'))(file);
  } catch (e) {
    return none(`${EDITOR_BUNDLE} failed to load: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isEditorModule(mod)) return none(`${EDITOR_BUNDLE} does not export the EditorModule interface`);
  return { editor: mod, capabilities: { edit: true, agent: true }, why: null };
}

/** The editor module, or null (docs/ARCHITECTURE.md, Editor loader). */
export function loadEditor(dir: string = __dirname): EditorModule | null {
  return loadEditorDetailed(dir).editor;
}
