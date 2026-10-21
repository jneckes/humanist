// Shared steps of the Phase 2 review-fix E2E specs (test/e2e/edit-fix-*.spec.ts): open a deck copy owned by the
// test user, enter Edit, open a field with a real click, type with real keys, save over the file as another
// program does (temp file and rename), and read the session the app keeps.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { FIXTURES, Scratch, copyInto, launchApp, resolveRunAs, sleep, type BlApp, type DeckView } from '../helpers/app';

export { FIXTURES, sleep };

export async function until<T>(what: string, fn: () => Promise<T | undefined>, timeout = 15_000): Promise<T> {
  const end = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch (e) {
      last = e;
    }
    await sleep(50);
  }
  throw new Error(`timed out: ${what}${last ? ` (${last instanceof Error ? last.message : String(last)})` : ''}`);
}

export interface Opened {
  s: Scratch;
  app: BlApp;
  deck: DeckView;
  file: string;
  dir: string;
  original: string;
}

/** A deck (a fixture path, or HTML text) copied to a scratch folder the test user owns, opened in the app. */
export async function openDeck(o: { fixture?: string; html?: string; name: string; edit?: boolean; userData?: string; s?: Scratch; extra?: string[] }): Promise<Opened> {
  const s = o.s ?? new Scratch(resolveRunAs());
  const dir = s.dir('edit-fix');
  let file: string;
  if (o.fixture) file = copyInto(o.fixture, dir, o.name);
  else {
    file = path.join(dir, o.name);
    fs.writeFileSync(file, o.html ?? '');
  }
  const files = [file];
  for (const x of o.extra ?? []) files.push(copyInto(path.join(FIXTURES, 'decks/single.html'), dir, x));
  s.own(dir);
  const original = fs.readFileSync(file, 'utf8');
  const app = await launchApp({ files, scratch: s, userData: o.userData });
  const deck = await app.waitForDeck(o.name);
  if (o.edit !== false) await enterEdit(app, deck);
  return { s, app, deck, file, dir, original };
}

export async function closeAll(o: Opened): Promise<void> {
  await o.app.close().catch(() => undefined);
  o.s.cleanup();
}

export async function enterEdit(app: BlApp, deck: DeckView): Promise<void> {
  await deck.chord('3');
  await until('Edit mode', async () => ((await app.win(deck.docId)).appMode === 'edit' ? true : undefined));
  // The map's second half runs after the first paint (D-9): wait until the overlay can open fields.
  await until('Edit ready', async () => ((await deck.editState<{ blocked: string | null }>()).blocked === null ? true : undefined), 20_000);
}

/** The view point of a character of the `nth` non-blank text node of `selector` (end: after its last character). */
export async function textPoint(deck: DeckView, selector: string, o: { nth?: number; at?: 'end' | 'start' | number } = {}): Promise<{ x: number; y: number } | null> {
  const ni = o.nth ?? -1;
  const at = o.at ?? 'end';
  const p = await deck.eval<{ x: number; y: number } | null>(
    `(function(){var e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;` +
      `var w=document.createTreeWalker(e,4),n,all=[];while((n=w.nextNode()))if(n.data.trim())all.push(n);if(!all.length)return null;` +
      `var t=${ni}<0?all[all.length-1]:all[${ni}];var r=document.createRange();var at=${JSON.stringify(at)};` +
      `if(at==='end'){r.setStart(t,t.data.length-1);r.setEnd(t,t.data.length);var b=r.getBoundingClientRect();return {x:b.right-1,y:b.top+b.height/2};}` +
      `if(at==='start'){r.setStart(t,0);r.setEnd(t,1);var b2=r.getBoundingClientRect();return {x:b2.left+1,y:b2.top+b2.height/2};}` +
      `r.setStart(t,at);r.setEnd(t,at+1);var b3=r.getBoundingClientRect();return {x:b3.left+1,y:b3.top+b3.height/2};})()`,
  );
  if (!p) return null;
  const zoom = await deck.app.electronApp.evaluate(({ webContents }, id) => webContents.fromId(id)?.getZoomFactor() ?? 1, deck.wcId);
  return { x: p.x * zoom, y: p.y * zoom };
}

/** A real click on the text of `selector` until the overlay opened a field on it. */
export async function openFieldAt(deck: DeckView, selector: string, o: { nth?: number; at?: 'end' | 'start' | number } = {}): Promise<void> {
  await until(
    `a field on ${selector}`,
    async () => {
      const p = await textPoint(deck, selector, o);
      if (!p) return undefined;
      await deck.click(p.x, p.y);
      const st = await deck.editState<{ field: { rootId: string } | null }>();
      return st && st.field ? true : undefined;
    },
    20_000,
  );
}

export async function typeKeys(deck: DeckView, text: string): Promise<void> {
  for (const ch of text) await deck.key(ch);
}

/** Another program saves the file: a temp file in the same folder, renamed over it. */
export function externalSave(o: Opened, text: string | Buffer): Buffer {
  const bytes = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
  const tmp = path.join(path.dirname(o.file), `.external-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  fs.writeFileSync(tmp, bytes);
  o.s.own(tmp);
  fs.renameSync(tmp, o.file);
  return bytes;
}

export function replaceOnce(src: string, from: string, to: string): string {
  const at = src.indexOf(from);
  if (at < 0 || src.indexOf(from, at + 1) >= 0) throw new Error(`${JSON.stringify(from)} must occur once`);
  return src.slice(0, at) + to + src.slice(at + from.length);
}

/** The file's text once it stopped changing for 600 ms. */
export async function settled(file: string, timeout = 20_000): Promise<string> {
  let last = fs.readFileSync(file, 'utf8');
  return until(
    'the file to settle',
    async () => {
      await sleep(600);
      const now = fs.readFileSync(file, 'utf8');
      const same = now === last;
      last = now;
      return same ? now : undefined;
    },
    timeout,
  );
}

/** Every session.json under userData (the notes and locks of the documents this app saved). */
export function sessions(userData: string): { file: string; json: { notes?: { id: string; kind: string; status: string; verbatim?: { before: string; after: string } }[]; locked?: { noteId: string; state: string; text: string; start: number; end: number }[]; deck?: { known?: string } } }[] {
  const out: { file: string; json: never }[] = [];
  const walk = (d: string) => {
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const n of names) {
      const p = path.join(d, n.name);
      if (n.isDirectory()) walk(p);
      else if (n.name === 'session.json') {
        try {
          out.push({ file: p, json: JSON.parse(fs.readFileSync(p, 'utf8')) as never });
        } catch {
          // being written
        }
      }
    }
  };
  walk(userData);
  return out;
}

/** True when `word` is in no file under userData (the typed words were kept nowhere). */
export function nowhereIn(userData: string, word: string): boolean {
  let found = false;
  const walk = (d: string) => {
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const n of names) {
      const p = path.join(d, n.name);
      if (n.isDirectory()) walk(p);
      else if (n.isFile()) {
        try {
          if (fs.statSync(p).size < 50_000_000 && fs.readFileSync(p).includes(word)) found = true;
        } catch {
          // gone
        }
      }
    }
  };
  walk(userData);
  return !found;
}
