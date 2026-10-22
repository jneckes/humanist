// Lead decision F-1 through main's real wiring (the third attack round on F-1): a BlDocument on a real file, EditLane
// (attach, takeExternal as window.ts takeExternalChange calls it), EditSession (onBegin, onCommit, appUndo) and
// packages/editor's real write queue. Main takes every external change from the watcher and tells the queue with
// know(…, { onDisk: true }), so the queue counts it as another program's change even when it never reads that version
// itself: a field held open across two saves, or an undo after them, while another program duplicates a slide and
// then deletes its original, or deletes a divider and puts an identical one back. Each is a verbatim note or "Can't
// undo in place", never a write into the copy.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createWriteQueue, editorVersion } from '@blueline/editor';
import { CANT_UNDO } from '@blueline/editor/undo';
import type { EditorModule } from '@blueline/core/capabilities';
import type { EditResult } from '@blueline/core/ipc-edit';
import { sha256Hex } from '../../../packages/app/src/main/atomic-write';
import { BlDocument } from '../../../packages/app/src/main/documents';
import { EditLane, EditSession, type EditSessionDeps } from '../../../packages/app/src/main/edit-session';
import { HistoryStore } from '../../../packages/app/src/main/history';
import { NotesStore } from '../../../packages/app/src/main/notes';
import { emptySession } from '../../../packages/app/src/main/session-store';

const editor: EditorModule = { editorVersion, createWriteQueue };
let root: string;
let n = 0;
beforeAll(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bl-sight-')));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const DOC = '<!doctype html>\n<html><head><title>Review</title></head><body>\n';
const END = '</body></html>\n';
const pad = (k: string) => Array.from({ length: 4 }, (_, i) => `<p>Filler ${k} line ${i}: words that stay as they are.</p>\n`).join('');
const slide = (h: string, body: string) => `<section class="slide">\n  <div class="kicker">Quarterly review</div>\n  <h2>${h}</h2>\n  <p>${body}</p>\n</section>\n`;
const LONG = 'Revenue grew in every region, led by the north and the west, with margins steady and costs flat across the year; the board asked for detail on churn and on the new accounts';
/** A slide whose last line (far past the anchors' reach) says which one it is. */
const tagged = (h: string, tag: string) => `<section class="slide">\n  <h2>${h}</h2>\n  <p>${LONG}</p>\n  <p>${LONG}</p>\n  <p class="foot">${tag}</p>\n</section>\n`;
const DIV = '<section class="divider">\n  <h2>Section break</h2>\n</section>\n';

async function rig(text: string) {
  const dir = path.join(root, `d${n++}`);
  fs.mkdirSync(dir);
  const file = path.join(dir, 'deck.html');
  fs.writeFileSync(file, text);
  const bytes = new Uint8Array(fs.readFileSync(file));
  const doc = new BlDocument({ docId: 'abcdef0123456789', path: file, realpath: file, bytes, trust: { trust: 'trusted', reason: null, marker: null }, received: false });
  const session = emptySession({ path: file, realpath: file, fileKey: doc.fileKey, sha256: doc.contentHash, title: doc.title });
  const notes = new NotesStore(session, { me: () => ({ id: 'me-abcd', name: 'Me', color: '#2563eb' }), now: () => new Date().toISOString(), version: () => doc.version, slides: () => null });
  const history = HistoryStore.at(path.join(dir, 'history'), { realpath: file });
  const lane = new EditLane(file, { editor, capEdit: () => true, history: () => history, log: () => undefined });
  const sent: { channel: string; payload: unknown }[] = [];
  const toasts: { text: string }[] = [];
  let known: { version: string } | null = null;
  const deps: EditSessionDeps = {
    doc,
    lane,
    capabilities: { edit: true, agent: true },
    notes,
    session: { session, known: () => known, noteVersion: (v) => (known = { version: v.version }) },
    reload: { showing: 'x', noteOwnWrite: () => undefined, requestReload: () => undefined, setWriting: () => undefined, setEditBusy: () => undefined },
    mode: () => 'edit',
    sendDeck: (channel, payload) => void sent.push({ channel, payload }),
    toast: (t) => void toasts.push(t),
    save: () => undefined,
    notesChanged: () => undefined,
    adopted: () => undefined,
    taken: () => undefined,
    clipboard: () => undefined,
    confirm: async () => true,
    log: () => undefined,
  };
  const s = new EditSession(deps);
  await s.attach();
  /** Another program saves the file; the watcher reports it and main takes it (window.ts takeExternalChange). */
  const save = async (t: string) => {
    const tmp = path.join(dir, `.ext-${Math.random().toString(16).slice(2)}.tmp`);
    fs.writeFileSync(tmp, t);
    fs.renameSync(tmp, file);
    const b = new Uint8Array(fs.readFileSync(file));
    const v = sha256Hex(b);
    doc.knownHash = v;
    expect(await lane.takeExternal(s, b, v)).toBe('taken');
  };
  const disk = () => fs.readFileSync(file, 'utf8');
  const result = () => sent.filter((x) => x.channel === 'bl:edit:result').at(-1)?.payload as EditResult | undefined;
  let field = 0;
  /** A field opens on the `which`-th run holding `value` in the version the page shows now. */
  const begin = (value: string, which = 0) => {
    const v = doc.version;
    const run = doc.map.runs.filter((x) => x.value === value)[which];
    expect(run, `run #${which} of ${value}`).toBeTruthy();
    const id = ++field;
    s.onInput('mouseDown');
    s.onBegin({ fieldId: id, version: v, runIds: [run.id] });
    return {
      commit: async (after: string) => {
        s.onInput('keyDown');
        await s.onCommit({ fieldId: id, version: v, result: { kind: 'edit', runId: run.id, beforeText: value, afterText: after }, target: { css: 'h2', text: value, role: 'heading', stamp: run.stamp }, slide: 0, alsoPlaces: 0 });
      },
    };
  };
  return { s, doc, notes, save, disk, result, toasts, begin };
}

describe('a field held open across two saves main took (F-1)', () => {
  it('another program duplicates the slide, then deletes the original: a verbatim note, the copy untouched', async () => {
    const ORIG = tagged('Key takeaways', 'original');
    const COPY = tagged('Key takeaways', 'copy');
    const A = DOC + slide('Agenda', 'What we cover today') + pad('a') + ORIG + pad('b') + slide('Next steps', 'Owners and dates') + END;
    const r = await rig(A);
    const f = r.begin('Key takeaways');
    await r.save(A.replace(ORIG, ORIG + COPY));
    const C = A.replace(ORIG, COPY);
    await r.save(C);
    await f.commit('Key takeaways two');
    expect(r.result()).toMatchObject({ outcome: 'verbatim' });
    expect(r.disk()).toBe(C);
    expect(r.notes.notes.map((x) => [x.kind, x.verbatim])).toEqual([['verbatim', { before: 'Key takeaways', after: 'Key takeaways two' }]]);
  });

  it('the same with a byte-identical copy (the bytes as before): a verbatim note', async () => {
    const S = slide('Key takeaways', 'Revenue grew in every region');
    const A = DOC + slide('Agenda', 'What we cover today') + pad('a') + S + pad('b') + slide('Next steps', 'Owners and dates') + END;
    const r = await rig(A);
    const f = r.begin('Key takeaways');
    await r.save(A.replace(S, S + S));
    await r.save(A);
    await f.commit('Key takeaways two');
    expect(r.result()).toMatchObject({ outcome: 'verbatim' });
    expect(r.disk()).toBe(A);
  });

  it('identical dividers: another program deletes the author\'s and puts an identical one back: a verbatim note', async () => {
    const A = DOC + slide('Agenda', 'What we cover today') + DIV + slide('Key takeaways', 'Revenue grew') + DIV + slide('Next steps', 'Owners') + END;
    const r = await rig(A);
    const f = r.begin('Section break', 0);
    await r.save(A.replace(DIV + slide('Key takeaways', 'Revenue grew'), slide('Key takeaways', 'Revenue grew')));
    await r.save(A);
    await f.commit('Part two');
    expect(r.result()).toMatchObject({ outcome: 'verbatim' });
    expect(r.disk()).toBe(A);
  });

  it('control: two saves far away, the text in one place: written where the author typed', async () => {
    const S = slide('Key takeaways', 'Revenue grew in every region');
    const A = DOC + slide('Agenda', 'What we cover today') + pad('a') + S + pad('b') + slide('Next steps', 'Owners and dates') + END;
    const r = await rig(A);
    const f = r.begin('Key takeaways');
    await r.save(A.replace('Filler b line 3', 'Filler b line three'));
    const C = A.replace('Filler b line 3', 'Filler b line 3!');
    await r.save(C);
    await f.commit('Key takeaways two');
    expect(r.result()).toMatchObject({ outcome: 'written' });
    expect(r.disk()).toBe(C.replace('<h2>Key takeaways</h2>', '<h2>Key takeaways two</h2>'));
  });
});

describe('Cmd+Z after two saves main took (F-1)', () => {
  it('the written slide duplicated, then its original deleted: Can\'t undo in place, the file untouched', async () => {
    const S = slide('Key takeaways', 'Revenue grew in every region');
    const A = DOC + slide('Agenda', 'What we cover today') + pad('a') + S + pad('b') + slide('Next steps', 'Owners and dates') + END;
    const r = await rig(A);
    await r.begin('Key takeaways').commit('Key takeaways two');
    expect(r.result()).toMatchObject({ outcome: 'written' });
    const W = r.disk();
    const S2 = S.replace('Key takeaways', 'Key takeaways two');
    await r.save(W.replace(S2, S2 + S2));
    await r.save(W);
    await r.s.appUndo('undo');
    expect(r.toasts.at(-1)?.text).toBe(CANT_UNDO);
    expect(r.disk()).toBe(W);
  });

  it('the write made a heading equal another; slide deleted and an identical one put back: Can\'t undo in place', async () => {
    const A = DOC + slide('Key takeaways!', 'Same body') + slide('Next steps', 'Owners') + slide('Key takeaways', 'Same body') + END;
    const r = await rig(A);
    await r.begin('Key takeaways!').commit('Key takeaways');
    expect(r.result()).toMatchObject({ outcome: 'written' });
    const W = r.disk();
    await r.save(W.replace(slide('Key takeaways', 'Same body') + slide('Next steps', 'Owners'), slide('Next steps', 'Owners')));
    await r.save(W);
    await r.s.appUndo('undo');
    expect(r.toasts.at(-1)?.text).toBe(CANT_UNDO);
    expect(r.disk()).toBe(W);
  });

  it('control: two saves far away, the text in one place: undone', async () => {
    const S = slide('Key takeaways', 'Revenue grew in every region');
    const A = DOC + slide('Agenda', 'What we cover today') + pad('a') + S + pad('b') + slide('Next steps', 'Owners and dates') + END;
    const r = await rig(A);
    await r.begin('Key takeaways').commit('Key takeaways two');
    const W = r.disk();
    await r.save(W.replace('Filler b line 3', 'Filler b line three'));
    const C = W.replace('Filler b line 3', 'Filler b line 3!');
    await r.save(C);
    await r.s.appUndo('undo');
    expect(r.toasts.at(-1)?.text).toMatch(/^Undone/);
    expect(r.disk()).toBe(C.replace('<h2>Key takeaways two</h2>', '<h2>Key takeaways</h2>'));
  });
});
