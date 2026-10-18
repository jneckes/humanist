// The deck preload (9.1 Preload): bundled to dist/preload-deck.cjs and run sandboxed in the deck view's
// isolated world, before any page script. Only require('electron') (ipcRenderer, webFrame) is available;
// core is imported by subpath so parse5 and acorn stay out of this bundle.
//
// Modes (process.argv `--bl-mode=`): `deck` (the visible view: overlay, key router, card, ink, link and focus
// reports, slide adapter, the views' hooks), `render` (offscreen render windows: the render agent only, no UI,
// no key router) and `diagnostics` (the deck view of the Diagnostics window: `deck` plus DeckToMain.diag hooks).
//
// It talks to main only over ipcRenderer and exposes NOTHING to the page: no contextBridge, no globals in
// the main world. Test builds (`--bl-test=1`) put ipcRenderer on the isolated world's globalThis as
// __blTestIpc, so the security suite can send forged payloads as a compromised renderer would.

import { ipcRenderer, webFrame } from 'electron';
import { DeckToMain, MainToDeck, type AppMode, type DeckInit, type MapUpdate, type RenderReply } from '@blueline/core/ipc';
import { FilesDeckToMain, MainToDeckFiles } from '@blueline/core/ipc-files';
import { MainToDeckViews } from '@blueline/core/ipc-views';
import { parsePreloadArgs } from './env';
import { KeyRouter, type KeyAction, type ShortcutAction, type TextFieldKind } from './key-router';
import { InputGuard } from './input-guard';
import { DeckUi } from './deck-ui';
import { guardChildFrames, guardDeckFileDrops, guardFrameDrops } from './drop-guard';
import { RenderAgent } from './render-agent';
import { ViewHooks } from './view-hooks';

const env = parsePreloadArgs(process.argv);

/**
 * The deck views run this preload in every frame (nodeIntegrationInSubFrames, window.ts) so that no frame can
 * take a dropped file (drop-guard.ts, review finding 2). In a subframe it installs that guard and nothing else:
 * no overlay, no key router, no IPC (main's IPC guard refuses subframe senders anyway, 9.1). A test build also puts
 * ipcRenderer there as __blTestIpc, in the isolated world only, so the security suite can prove that refusal.
 */
function isSubframe(): boolean {
  try {
    return window.top !== window;
  } catch {
    return true;
  }
}

if (isSubframe()) {
  guardFrameDrops(window);
  // Test builds only (`--bl-test=1`, as for the top frame below): the security suite sends forged IPC from a
  // subframe, as a compromised renderer could, and checks that main's guard refuses every message from a frame
  // that is not the main frame (ipc-guard.ts isMainFrameOf; test/security/drop-frames.spec.ts).
  if (env.test) (globalThis as Record<string, unknown>).__blTestIpc = ipcRenderer;
} else runDeckPreload();

function runDeckPreload(): void {
  if (env.test) (globalThis as Record<string, unknown>).__blTestIpc = ipcRenderer;

  const send = (channel: string, payload?: unknown): void => ipcRenderer.send(channel, payload);

  /** What the key router needs from the UI, which is built right after it. */
  interface RouterBridge {
    appMode(): AppMode;
    textFieldOf(t: EventTarget | null): TextFieldKind | null;
    onAction(a: ShortcutAction | 'commit-edit' | 'cancel-edit' | 'close-card', e: KeyboardEvent): void;
    onDeckKey(e: KeyboardEvent): void;
    onDecision(e: KeyboardEvent, action: KeyAction, consumed: boolean): void;
    overlayHost(): EventTarget;
    onOverlayEvent(e: Event): void;
  }

  let bridge: RouterBridge | null = null;
  let ui: DeckUi | null = null;
  let hooks: ViewHooks | null = null;

  // 6.2 / 9.1: the capture-phase keydown listener is registered first, synchronously at preload start, before
  // any page script runs, so it is the first keydown listener on window in either world.
  if (env.mode !== 'render') {
    new KeyRouter(window, {
      // While main replays the deck's own keys (an index deck's rail click, 6.9), the view routes keys as Read.
      appMode: () => {
        const real = bridge?.appMode() ?? 'read';
        return hooks ? hooks.routerMode(real) : real;
      },
      textFieldOf: (t) => bridge?.textFieldOf(t) ?? null,
      onAction: (a, e) => bridge?.onAction(a, e),
      onDecision: (e, a, c) => {
        bridge?.onDecision(e, a, c);
        hooks?.onKeyDecision(e, a);
      },
      onDeckKey: (e) => bridge?.onDeckKey(e),
    }).install();
    // 6.1, 9.1: a file dragged onto the deck view never reaches the page, and the view never navigates to it; main
    // only hears that one was refused (no path, name or count), and says where to drop it.
    guardDeckFileDrops(window, { onRefused: () => send(FilesDeckToMain.dropRefused) });
    // The same for the same-origin frames below the top one, including a script-made about:blank frame the
    // subframe preload does not run in time for (drop-guard.ts, "frames").
    guardChildFrames(window, { onRefused: () => send(FilesDeckToMain.dropRefused) });
    // The input guard (input-guard.ts), right after the router so its key listeners never change the router's
    // decisions: the input-event family from the overlay (card typing, paste, dictation) is handled by the
    // overlay and stopped at window capture, before any page listener can read or cancel it.
    new InputGuard(window, {
      host: () => bridge?.overlayHost() ?? null,
      onOverlayEvent: (e) => bridge?.onOverlayEvent(e),
    }).install();
    hooks = new ViewHooks(window, {
      send,
      executeJavaScript: (code) => webFrame.executeJavaScript(code),
      ui: () => ui,
      host: () => ui?.overlay.host ?? null,
    });
    hooks.install();
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
    const h = hooks!;
    const deckUi = new DeckUi(document, window, {
      // The slide watcher's reports also tell the view hooks that the design size may be known (6.9 Fit).
      send: (channel, payload) => {
        send(channel, payload);
        if (channel === DeckToMain.slides) h.onSlides();
      },
      diagnostics: env.mode === 'diagnostics',
    });
    ui = deckUi;
    bridge = deckUi;
    ipcRenderer.on(MainToDeck.init, (_e, p: unknown) => {
      deckUi.applyInit(p as DeckInit);
      h.onInit();
    });
    ipcRenderer.on(MainToDeck.appMode, (_e, p: unknown) => deckUi.applyAppMode(p, 'main'));
    ipcRenderer.on(MainToDeck.map, (_e, p: unknown) => deckUi.applyMap(p as MapUpdate));
    ipcRenderer.on(MainToDeck.notes, (_e, p: unknown) => deckUi.applyNotes(p));
    ipcRenderer.on(MainToDeck.chrome, (_e, p: unknown) => deckUi.applyChrome(p));
    ipcRenderer.on(MainToDeck.closeCard, () => deckUi.closeCard());
    // 6.6 Reload: the view state around a reload (files-lifecycle's channels), and 6.9's navigation.
    ipcRenderer.on(MainToDeckFiles.captureViewState, (_e, p: unknown) => h.capture(p));
    ipcRenderer.on(MainToDeckFiles.applyViewState, (_e, p: unknown) => h.apply(p));
    ipcRenderer.on(MainToDeckViews.goto, (_e, p: unknown) => void h.goto(p));
    ipcRenderer.on(MainToDeckViews.navReplay, (_e, p: unknown) => h.setReplay(p));
    ipcRenderer.on(MainToDeckViews.pan, (_e, p: unknown) => h.setPan(p));
  }

  // Handshake: main answers with MainToDeck.init (deck and diagnostics) and then follows the app mode.
  send(DeckToMain.ready);
}
