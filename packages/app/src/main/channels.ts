// The app's two IPC routers (9.1 Preload; ipc-guard.ts), created once. Each DeckToMain channel can be
// declared only once with ipcMain, so this module declares all of them and hands each validated message to
// the handlers registered for its sender webContents: a document's deck view (window.ts), a render view
// (render-service, app-render) or the Diagnostics deck (diagnostics, app-render). The document always
// comes from the registration, never from the payload.

import { ipcMain } from 'electron';
import type { WebContents } from 'electron';
import {
  DeckToMain,
  type DiagEvent,
  type FocusState,
  type LinkClick,
  type NoteOp,
  type RenderReply,
  type SlideState,
} from '@blueline/core/ipc';
import { FilesDeckToMain, type DeckBusy, type ViewStateReply } from '@blueline/core/ipc-files';
import { ViewsDeckToMain, type DesignReport, type PageStep, type WheelPan } from '@blueline/core/ipc-views';
import { validateDropRefused } from './drop';
import { validateDeckBusy, validateViewStateReply } from './view-state';
import { validateDesignReport, validatePageStep, validateWheelPan } from './views';
import {
  DeckIpc,
  ShellIpc,
  validateDiag,
  validateFocus,
  validateLink,
  validateMode,
  validateNote,
  validateReady,
  validateRenderReply,
  validateSlides,
  type DeckSender,
  type DeckViewKind,
  type DropInfo,
} from './ipc-guard';

/** What one registered deck, render or diagnostics view handles. Unhandled channels are dropped. */
export interface DeckViewHandlers {
  ready?(from: DeckSender): void;
  focus?(from: DeckSender, p: FocusState): void;
  link?(from: DeckSender, p: LinkClick): void;
  slides?(from: DeckSender, p: SlideState): void;
  mode?(from: DeckSender, p: { mode: 'read' }): void;
  note?(from: DeckSender, p: NoteOp): void;
  diag?(from: DeckSender, p: DiagEvent): void;
  renderReply?(from: DeckSender, p: RenderReply): void;
  /** Added by views (6.6 Reload; files-lifecycle's channels): the view state the page reported. */
  viewState?(from: DeckSender, p: ViewStateReply): void;
  /** Added by views (6.6): what holds a reload back (an edit, a card with unsaved input). */
  busy?(from: DeckSender, p: DeckBusy): void;
  /** Added by views (6.1): a file drag was refused on the deck view (no payload: 9.1, never a path). */
  dropRefused?(from: DeckSender): void;
  /** Added by views (6.9): the design size the page measured. */
  design?(from: DeckSender, p: DesignReport): void;
  /** Added by views (6.9 Navigation): PageUp or PageDown the deck did not use. */
  pageStep?(from: DeckSender, p: PageStep): void;
  /** Added by views (6.9): a wheel the page did not use, over a deck view larger than the window. */
  wheel?(from: DeckSender, p: WheelPan): void;
}

const handlers = new Map<number, DeckViewHandlers>();
let deck: DeckIpc | null = null;
let shell: ShellIpc | null = null;
let dropLogBudget = 200;

function logDrop(d: DropInfo): void {
  // Drops are silent to the page; in development and tests they are logged (a bounded number).
  if (process.env.BLUELINE_TEST !== '1' && process.env.BLUELINE_DEBUG !== '1') return;
  if (dropLogBudget-- <= 0) return;
  console.warn(`[blueline] ipc drop ${d.channel} ${d.reason}${d.why ? ` (${d.why})` : ''} wc=${d.webContentsId}`);
}

function route<K extends keyof DeckViewHandlers>(name: K) {
  return (from: DeckSender, payload: unknown): void => {
    const h = handlers.get(from.webContentsId)?.[name] as ((f: DeckSender, p: unknown) => void) | undefined;
    if (h) h(from, payload);
  };
}

/** The deck router. All DeckToMain channels are declared on first use. */
export function deckRouter(): DeckIpc {
  if (deck) return deck;
  const d = new DeckIpc({ ipcMain, onDrop: logDrop });
  d.on(DeckToMain.ready, validateReady, (from) => route('ready')(from, undefined));
  d.on(DeckToMain.focus, validateFocus, route('focus'));
  d.on(DeckToMain.link, validateLink, route('link'));
  d.on(DeckToMain.slides, validateSlides, route('slides'));
  d.on(DeckToMain.mode, validateMode, route('mode'));
  d.on(DeckToMain.note, validateNote, route('note'));
  d.on(DeckToMain.diag, validateDiag, route('diag'));
  d.on(DeckToMain.renderReply, validateRenderReply, route('renderReply'));
  // Phase 1 (views wires the files-lifecycle and views channels). The deck view only: render views have no UI.
  d.on(FilesDeckToMain.viewState, validateViewStateReply, route('viewState'), { kinds: ['deck'] });
  d.on(FilesDeckToMain.busy, validateDeckBusy, route('busy'), { kinds: ['deck'] });
  d.on(FilesDeckToMain.dropRefused, validateDropRefused, (from) => route('dropRefused')(from, undefined), { kinds: ['deck', 'diagnostics'] });
  d.on(ViewsDeckToMain.design, validateDesignReport, route('design'), { kinds: ['deck'] });
  d.on(ViewsDeckToMain.pageStep, validatePageStep, route('pageStep'), { kinds: ['deck'] });
  d.on(ViewsDeckToMain.wheel, validateWheelPan, route('wheel'), { kinds: ['deck'] });
  deck = d;
  return d;
}

/**
 * Registers a webContents main created as a deck, render or diagnostics view of document `docId`, with its
 * handlers. Call it right after creating the view, before loading it (9.1).
 */
export function attachDeckView(wc: WebContents, info: { docId: string; kind: DeckViewKind }, h: DeckViewHandlers): void {
  deckRouter().registerDeckView(wc, info);
  const fresh = !handlers.has(wc.id);
  handlers.set(wc.id, h);
  if (fresh) wc.once('destroyed', () => handlers.delete(wc.id));
}

/** The shell router (window shells and the Diagnostics window's shell). Channels are declared by their owners. */
export function shellRouter(): ShellIpc {
  if (!shell) shell = new ShellIpc({ ipcMain, onDrop: logDrop });
  return shell;
}
