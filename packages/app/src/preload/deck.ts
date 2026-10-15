// The deck preload (9.1 Preload): bundled to dist/preload-deck.cjs and run sandboxed in the deck view's
// isolated world, before any page script. Only require('electron') (ipcRenderer, webFrame) is available;
// core is imported by subpath so parse5 and acorn stay out of this bundle.
//
// Modes (process.argv `--bl-mode=`): `deck` (the visible view: overlay, key router, card, ink, link and focus
// reports, slide adapter), `render` (offscreen render windows: the render agent only, no UI, no key router)
// and `diagnostics` (the deck view of the Diagnostics window: `deck` plus DeckToMain.diag hooks).
//
// It talks to main only over ipcRenderer and exposes NOTHING to the page: no contextBridge, no globals in
// the main world. Test builds (`--bl-test=1`) put ipcRenderer on the isolated world's globalThis as
// __blTestIpc, so the security suite can send forged payloads as a compromised renderer would.

import { ipcRenderer, webFrame } from 'electron';
import { DeckToMain, MainToDeck, type AppMode, type DeckInit, type MapUpdate, type RenderReply } from '@blueline/core/ipc';
import { parsePreloadArgs } from './env';
import { KeyRouter, type KeyAction, type ShortcutAction, type TextFieldKind } from './key-router';
import { DeckUi } from './deck-ui';
import { RenderAgent } from './render-agent';

const env = parsePreloadArgs(process.argv);
if (env.test) (globalThis as Record<string, unknown>).__blTestIpc = ipcRenderer;

const send = (channel: string, payload?: unknown): void => ipcRenderer.send(channel, payload);

/** What the key router needs from the UI, which is built right after it. */
interface RouterBridge {
  appMode(): AppMode;
  textFieldOf(t: EventTarget | null): TextFieldKind | null;
  onAction(a: ShortcutAction | 'commit-edit' | 'cancel-edit' | 'close-card', e: KeyboardEvent): void;
  onDeckKey(e: KeyboardEvent): void;
  onDecision(e: KeyboardEvent, action: KeyAction, consumed: boolean): void;
}

let bridge: RouterBridge | null = null;

// 6.2 / 9.1: the capture-phase keydown listener is registered first, synchronously at preload start, before
// any page script runs, so it is the first keydown listener on window in either world.
if (env.mode !== 'render') {
  new KeyRouter(window, {
    appMode: () => bridge?.appMode() ?? 'read',
    textFieldOf: (t) => bridge?.textFieldOf(t) ?? null,
    onAction: (a, e) => bridge?.onAction(a, e),
    onDecision: (e, a, c) => bridge?.onDecision(e, a, c),
    onDeckKey: (e) => bridge?.onDeckKey(e),
  }).install();
}

if (env.mode === 'render') {
  // No UI and no key router in render mode (6.7).
  const agent = new RenderAgent(window, { executeJavaScript: (code) => webFrame.executeJavaScript(code) }, (r: RenderReply) =>
    send(DeckToMain.renderReply, r),
  );
  ipcRenderer.on(MainToDeck.renderRequest, (_e, payload: unknown) => {
    void agent.handle(payload);
  });
} else {
  const ui = new DeckUi(document, window, { send, diagnostics: env.mode === 'diagnostics' });
  bridge = ui;
  ipcRenderer.on(MainToDeck.init, (_e, p: unknown) => ui.applyInit(p as DeckInit));
  ipcRenderer.on(MainToDeck.appMode, (_e, p: unknown) => ui.applyAppMode(p, 'main'));
  ipcRenderer.on(MainToDeck.map, (_e, p: unknown) => ui.applyMap(p as MapUpdate));
  ipcRenderer.on(MainToDeck.notes, (_e, p: unknown) => ui.applyNotes(p));
  ipcRenderer.on(MainToDeck.chrome, (_e, p: unknown) => ui.applyChrome(p));
  ipcRenderer.on(MainToDeck.closeCard, () => ui.closeCard());
}

// Handshake: main answers with MainToDeck.init (deck and diagnostics) and then follows the app mode.
send(DeckToMain.ready);
