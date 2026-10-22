// The second hardening round: wrong-place writes three attackers found in the built app after the first round, each
// driven as it was found (a real click opens the field, real keys type, another program saves over the file as editors
// do, or writes it in place with a pause), and each must now leave the author's words as a verbatim note with the
// other program's file untouched, or land in the run the author pressed. The file on disk is the oracle.
//
//   - a deck generator run again after its slide list changed renumbers ids and page counters by position (place.ts
//     rule 3, records.ts): the slide's own title and body tell it apart;
//   - a new card modelled on the author's, put beside it while the tag next to the author's label is renamed: a stale
//     edit, and Cmd+Z after the same shape (rule 3; undo case 2 carried through the queue's steps);
//   - a program that writes the deck in place and pauses mid-file (write-queue.ts readWhole): its whole output stays;
//   - Blueline's own writes in between: Cmd+Z after later edits and another program's swap (undo case 2 carried
//     through them exactly), the toast's Undo and "Restore deck to <time>" clicked while a field is open and the page
//     is in a long task (write-queue.ts carryRange: a restore is placed, not carried by its trimmed splice; no
//     whole-span diff across Blueline's own writes).
//
// Every test needs the Edit capability: @edit in each title (the reader-only gate leaves them out).

import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeAll, externalSave, openDeck, openFieldAt, settled, sleep, typeKeys, until, type Opened } from './edit-fix-helpers';

const STYLE = '<style>body{font:20px/1.3 sans-serif;margin:16px;width:820px} section{min-height:140px;border:1px solid #ccc;margin:8px;padding:8px}</style>';
const deck = (...ss: string[]) => `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>Deck</title>${STYLE}</head><body>\n${ss.join('')}</body></html>\n`;

/** The notes of the deck's window: [kind, before, after]. */
async function notes(o: Opened): Promise<(string | undefined)[][]> {
  return (await o.app.win(o.deck.docId)).state.notes.map((n) => [n.kind, n.before, n.after]);
}

/** Field open, text typed, another program saves C, Enter `delay` ms later; the file once it settled. */
async function staleCommit(o: Opened, open: string, typed: string, C: string, delay: number): Promise<string> {
  await openFieldAt(o.deck, open);
  await o.deck.key('End', ['control']);
  await typeKeys(o.deck, typed);
  externalSave(o, C);
  await sleep(delay);
  await o.deck.key('Enter');
  await until('the commit answered', async () => ((await notes(o)).length > 0 || fs.readFileSync(o.file, 'utf8') !== C ? true : undefined), 20_000);
  return settled(o.file);
}

/** Another program's save, taken by the window (its handshake counted). */
async function takeExternal(o: Opened, text: string): Promise<void> {
  const before = (await o.app.win(o.deck.docId)).handshakes;
  externalSave(o, text);
  await until('the external change taken', async () => ((await o.app.win(o.deck.docId)).handshakes > before ? true : undefined), 30_000);
  await sleep(800);
}

test.describe('a generator run again renumbers its slides: a note, never the slide now at the author\'s position', () => {
  // As a Jinja2 template renders a Tailwind-style deck: ids and page counters from the loop index.
  const tw = (n: number, total: number | null, label: string, title: string, body: string) =>
    `<section id="slide-${n}" class="relative flex min-h-screen w-full flex-col justify-between overflow-hidden bg-white px-16 py-12 text-slate-900 antialiased">\n` +
    `  <header class="flex items-center justify-between border-b border-slate-200 pb-4 text-sm font-medium uppercase tracking-widest text-slate-500"><h2 class="text-xs font-semibold">${label}</h2><span class="tabular-nums">${String(n).padStart(2, '0')}${total === null ? '' : ` / ${String(total).padStart(2, '0')}`}</span></header>\n` +
    `  <div class="mx-auto grid w-full max-w-6xl grid-cols-12 gap-8"><div class="col-span-8 flex flex-col gap-6"><h3 class="text-5xl font-bold leading-tight">${title}</h3><p class="text-xl leading-relaxed text-slate-600">${body}</p></div></div>\n` +
    `</section>\n`;
  const SL = [
    ['Overview', 'Where we stand', 'A short summary of the quarter.'],
    ['Results', 'Revenue grew in every region', 'All four regions beat their targets.'],
    ['Results', 'Margins held', 'Gross margin stayed at 41 percent.'],
    ['Results', 'Costs fell', 'Two regions cut their spend.'],
    ['Next', 'What happens next', 'Owners and dates for each item.'],
  ];
  const render = (rows: string[][], total: boolean) => deck(...rows.map(([l, t, b], i) => tw(i + 1, total ? rows.length : null, l, t, b)));
  const cases = [
    { name: 'slides 2 and 3 swapped', A: render(SL, true), C: render([SL[0], SL[2], SL[1], SL[3], SL[4]], true), open: '#slide-2 h2' },
    { name: 'slide 2 deleted, the author typed in slide 3', A: render(SL, false), C: render([SL[0], SL[2], SL[3], SL[4]], false), open: '#slide-3 h2' },
  ];
  for (const c of cases) {
    test(`@edit ${c.name}`, async () => {
      const o = await openDeck({ html: c.A, name: 'deck.html' });
      try {
        const after = await staleCommit(o, c.open, ' Q3', c.C, 50);
        expect(after, 'the file is exactly what the generator wrote').toBe(c.C);
        expect(await notes(o)).toContainEqual(['verbatim', 'Results', 'Results Q3']);
      } finally {
        await closeAll(o);
      }
    });
  }
});

test.describe('a new card modelled on the author\'s, the tag next to the author\'s label renamed', () => {
  const LEAD = 'We will review the plan with the regional leads before the end of the month and agree on owners for every open item on the list';
  const REST = 'then report back to the board in the first week of the next quarter with a short written summary.';
  const NEW = 'and close the hiring plan for the two new support roles before the holidays start.';
  const card = (label: string, code: string, lead: string, rest: string) =>
    `<div class="card"><span class="label">${label}</span><p><code>${code}</code> ${lead}, ${rest}</p></div>\n`;
  const page = (cards: string) =>
    `<!doctype html>\n<html><head><meta charset="utf-8"><title>T</title><style>.card{margin:16px;padding:8px;border:1px solid #ccc}.label{font-weight:bold}</style></head><body>\n<div class="cards">\n${cards}</div>\n</body></html>\n`;
  const ctx = card('Context', 'ctx-01', 'Sales grew in three of the four regions this year while costs stayed flat across the group as a whole', 'mostly thanks to the new pricing.');
  const third = (label: string) => card(label, 'risk-03', 'Two suppliers may raise prices in the spring and one contract ends in June without a renewal option', 'so we are talking to others.');

  test('@edit a stale edit of the author\'s label is a note', async () => {
    const author = card('Next steps', 'step-02', LEAD, REST);
    const A = page(ctx + author + third('Risks'));
    const C = A.replace(author, card('Next steps', 'step-02', LEAD, NEW) + author.replace('<code>step-02</code>', '<code>stage-2</code>'));
    const o = await openDeck({ html: A, name: 'cards.html' });
    try {
      const after = await staleCommit(o, '.card:nth-child(2) .label', ' now', C, 50);
      expect(after).toBe(C);
      expect(await notes(o)).toContainEqual(['verbatim', 'Next steps', 'Next steps now']);
    } finally {
      await closeAll(o);
    }
  });

  test('@edit Cmd+Z after the new card is inserted above the edited one is refused', async () => {
    const A = page(ctx + card('Next steps', 'step-02', LEAD, REST) + third('Next steps'));
    const o = await openDeck({ html: A, name: 'cards-undo.html' });
    try {
      await openFieldAt(o.deck, '.card:nth-child(2) .label');
      await o.deck.key('End', ['control']);
      await typeKeys(o.deck, ' now');
      await o.deck.key('Enter');
      await until('the edit on disk', async () => (fs.readFileSync(o.file, 'utf8').includes('Next steps now') ? true : undefined), 30_000);
      await until('the edit in the undo stack', async () => ((((await o.app.editInfo(o.deck.docId))?.undo as { undo: number } | undefined)?.undo ?? 0) === 1 ? true : undefined));
      await sleep(500);
      const edited = card('Next steps now', 'step-02', LEAD, REST);
      const W1 = fs.readFileSync(o.file, 'utf8');
      expect(W1.includes(edited)).toBe(true);
      const C = W1.replace(edited, card('Next steps now', 'step-02', LEAD, NEW) + edited.replace('<code>step-02</code>', '<code>stage-2</code>'));
      await takeExternal(o, C);
      await o.deck.chord('z');
      await sleep(2000);
      expect(await settled(o.file), 'nothing undone in either card').toBe(C);
      const shell = await o.app.shellPage(o.deck.docId);
      expect(await shell.locator('#toast').innerText()).toMatch(/Can.t undo/);
    } finally {
      await closeAll(o);
    }
  });
});

test.describe('a program writes the deck in place and pauses mid-file while the author presses Enter', () => {
  const slide = (h: string, body: string) => `<section class="slide">\n  <h2>${h}</h2>\n  <p>${body}</p>\n  <p class="note">${'Filler text that makes the slide longer than the anchors. '.repeat(3)}</p>\n</section>\n`;
  const SL = [slide('Quarterly results', 'Revenue grew in every region'), slide('Margins', 'Gross margin held'), slide('Costs', 'Two regions cut spend'), slide('Hiring', 'Open roles fell'), slide('Next steps', 'Owners and dates')];
  const A = deck(...SL);
  const C = deck(...SL, slide('Appendix', 'Method and sources'));
  for (const mode of ['python-open-w', 'shell-redirect']) {
    test(`@edit ${mode}: the other program's whole output stays, with the edit in the author's slide or as a note`, async () => {
      const o = await openDeck({ html: A, name: 'deck.html' });
      try {
        await openFieldAt(o.deck, 'section:nth-of-type(1) h2');
        await o.deck.key('End', ['control']);
        await typeKeys(o.deck, ' now');
        const cut = C.indexOf('<section class="slide">\n  <h2>Costs');
        const p1 = path.join(path.dirname(o.file), '..', `p1-${Date.now()}.txt`);
        const p2 = p1.replace('p1-', 'p2-');
        fs.writeFileSync(p1, C.slice(0, cut));
        fs.writeFileSync(p2, C.slice(cut));
        const py = `import sys,time\nf=open(sys.argv[1],'w',encoding='utf-8')\nf.write(open(sys.argv[2],encoding='utf-8').read());f.flush()\ntime.sleep(3)\nf.write(open(sys.argv[3],encoding='utf-8').read());f.close()\n`;
        const child =
          mode === 'python-open-w'
            ? spawn('python3', ['-c', py, o.file, p1, p2], { stdio: 'ignore' })
            : spawn('sh', ['-c', '{ cat "$1"; sleep 3; cat "$2"; } > "$0"', o.file, p1, p2], { stdio: 'ignore' });
        const done = new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
        await sleep(700);
        expect(fs.statSync(o.file).size, 'the file is half-written when Enter is pressed').toBeLessThan(Buffer.byteLength(C));
        await o.deck.key('Enter');
        expect(await done).toBe(0);
        await sleep(1500);
        const after = await settled(o.file);
        const right = C.replace('<h2>Quarterly results</h2>', '<h2>Quarterly results now</h2>');
        expect([right, C], 'the other program\'s whole output, with the edit in the author\'s slide or not at all').toContain(after);
        if (after === C) expect(await notes(o)).toContainEqual(['verbatim', 'Quarterly results', 'Quarterly results now']);
      } finally {
        await closeAll(o);
      }
    });
  }
});

test.describe('Blueline\'s own writes between a write and its place now', () => {
  const s = (h: string, sub: string, body: string) =>
    `<section class="slide">\n  <div class="kicker">Section summary</div>\n  <h2 class="title">${h}</h2>\n  <p class="sub">${sub}</p>\n  <p>${body}</p>\n</section>\n`;
  const title = '<section class="slide">\n  <h1>Quarterly review</h1>\n</section>\n';
  const longTask = (o: Opened, ms: number) => o.deck.eval(`(function(){setTimeout(function(){var t=Date.now();while(Date.now()-t<${ms}){}},30);return 1;})()`);
  const focusShell = async (o: Opened) => {
    const w = await o.app.win(o.deck.docId);
    await o.app.electronApp.evaluate(({ BrowserWindow, webContents }, a) => {
      BrowserWindow.fromId(a.windowId)?.focus();
      webContents.fromId(a.shell)?.focus();
    }, { windowId: w.windowId, shell: w.shellWebContentsId });
  };

  test('@edit Cmd+Z after two later edits and another program\'s swap never undoes the twin\'s edit', async () => {
    const C = s('Next steps', 'Costs', 'Body C');
    const V0 = deck(s('Key takeaways', 'Same subtitle', 'Body B'), C, s('Key takeaways', 'Same subtitle', 'Body B'));
    const o = await openDeck({ html: V0, name: 'undo-twin.html' });
    const file = () => fs.readFileSync(o.file, 'utf8');
    try {
      const edit = async (sel: string, key: 'End' | 'Home', text: string, expectIn: string) => {
        await openFieldAt(o.deck, sel, key === 'Home' ? { at: 'start' } : {});
        await o.deck.key(key, ['control']);
        await typeKeys(o.deck, text);
        await o.deck.key('Enter');
        await until(`written ${expectIn}`, async () => (file().includes(expectIn) ? true : undefined));
        await sleep(400);
      };
      await edit('section:nth-of-type(1) h2', 'End', '!', '<h2 class="title">Key takeaways!</h2>\n  <p class="sub">Same subtitle</p>\n  <p>Body B</p>\n</section>\n<section class="slide">\n  <div class="kicker">Section summary</div>\n  <h2 class="title">Next steps');
      await edit('section:nth-of-type(3) h2', 'End', '!', 'Costs</p>\n  <p>Body C</p>\n</section>\n<section class="slide">\n  <div class="kicker">Section summary</div>\n  <h2 class="title">Key takeaways!');
      await edit('section:nth-of-type(1) .sub', 'Home', 'New ', '<p class="sub">New Same subtitle</p>');
      const V3 = file();
      const S = '<section class="slide">';
      const END = '</body></html>\n';
      const secs = V3.split(S);
      const V4 = secs[0] + S + secs[3].slice(0, -END.length) + S + secs[2] + S + secs[1] + END; // slides 1 and 3 swapped
      externalSave(o, V4);
      await until('the swap shown', async () => ((await o.deck.eval<string>('document.querySelector("section:nth-of-type(1) .sub").textContent')) === 'Same subtitle' ? true : undefined), 20_000);
      await sleep(600);
      const shell = await o.app.shellPage(o.deck.docId);
      for (let i = 0; i < 3; i++) {
        await o.deck.focus();
        await o.app.run('undo', o.deck.docId);
        await sleep(1200);
        const t = await shell.locator('#toast').innerText().catch(() => '');
        if (/Make a note/.test(t)) {
          await shell.locator('#toast button.toast-action').first().click();
          await sleep(600);
        }
      }
      const now = await settled(o.file);
      const heads = [...now.matchAll(/<h2 class="title">([^<]*)<\/h2>\n  <p class="sub">([^<]*)</g)].map((m) => `${m[1]} / ${m[2]}`);
      expect(heads[0], 'the twin keeps its "!"').toBe('Key takeaways! / Same subtitle');
    } finally {
      await closeAll(o);
    }
  });

  test('@edit the toast\'s Undo while a field is open and the page is busy, then another program\'s swap: the field\'s text never lands on the twin', async () => {
    const C = s('Next steps', 'Costs', 'Body C');
    const V0 = deck(title, s('Key takeaways', 'Same subtitle!', 'Body B'), C, s('Key takeaways', 'Same subtitle', 'Body B'));
    const Vf = deck(title, s('Key takeaways', 'Same subtitle', 'Body B'), C, s('Key takeaways', 'Same subtitle', 'Body B'));
    const Vc = deck(title, s('Key takeaways', 'Same subtitle', 'Body B'), C, s('Key takeaways', 'Same subtitle!', 'Body B'));
    const o = await openDeck({ html: V0, name: 'toast-undo.html' });
    const file = () => fs.readFileSync(o.file, 'utf8');
    try {
      await openFieldAt(o.deck, 'section:nth-of-type(2) .sub');
      await o.deck.key('End', ['control']);
      await o.deck.key('Backspace');
      await o.deck.key('Enter');
      await until('the first edit written', async () => (file() === Vf ? true : undefined));
      await sleep(600);
      await openFieldAt(o.deck, 'section:nth-of-type(2) h2');
      await o.deck.key('End', ['control']);
      await typeKeys(o.deck, ' two');
      const shell = await o.app.shellPage(o.deck.docId);
      await longTask(o, 1500);
      await sleep(60);
      await focusShell(o);
      await shell.locator('#toast button.toast-action').first().click({ timeout: 5000 });
      await until('the undo or the commit landed', async () => {
        const now = file();
        if (now === V0) {
          externalSave(o, Vc);
          return true;
        }
        return now !== Vf ? true : undefined;
      }, 10_000).catch(() => undefined);
      await sleep(4000);
      const now = await settled(o.file);
      expect(now.includes('<h2 class="title">Key takeaways two</h2>\n  <p class="sub">Same subtitle</p>'), 'the twin (no "!") took the field\'s text').toBe(false);
    } finally {
      await closeAll(o);
    }
  });

  test('@edit "Restore deck to <time>" while a field on a slide another program inserted is open and the page is busy: the twin keeps its heading', async () => {
    const sl = (h: string, body: string) => `<section class="slide">\n  <div class="kicker">Quarterly review</div>\n  <h2>${h}</h2>\n  <p>${body}</p>\n</section>\n`;
    const V0 = deck(title, sl('Key takeaways', 'Costs fell in two regions'), sl('Next steps', 'Owners and dates'));
    const V2 = deck(title, sl('Key takeaways', 'Revenue grew in every region'), sl('Key takeaways', 'Costs fell in two regions'), sl('Next steps', 'Owners and dates'));
    const o = await openDeck({ html: V0, name: 'restore.html' });
    try {
      externalSave(o, V2);
      await until('the insert shown', async () => ((await o.deck.eval<number>('document.querySelectorAll("section").length')) === 4 ? true : undefined), 20_000);
      await sleep(600);
      await openFieldAt(o.deck, 'section:nth-of-type(2) h2');
      await o.deck.key('End', ['control']);
      await typeKeys(o.deck, ' (A)');
      await o.app.run('history', o.deck.docId);
      const shell = await o.app.shellPage(o.deck.docId);
      const entries = shell.locator('#history-list li.history-entry');
      await until('history entries', async () => ((await entries.count()) >= 1 ? true : undefined));
      await o.app.answerDialogs(0);
      await longTask(o, 2500);
      await sleep(60);
      await focusShell(o);
      await entries.nth(0).locator('button.history-restore').click();
      await sleep(3500);
      const fst = await o.deck.editState<{ field: { text: string; version: string } | null }>();
      if (fst.field) {
        await o.deck.focus();
        await o.deck.key('Enter');
        await sleep(2000);
      }
      expect(await settled(o.file), 'the restored deck has no slide A: slide B keeps its heading').toBe(V0);
    } finally {
      await closeAll(o);
    }
  });
});
