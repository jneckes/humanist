// Present (6.9, Cmd+Option+P): "The window goes full screen, with the chrome views hidden. The deck view fills
// the screen, and every key except Esc goes to the deck. Esc is caught in before-input-event and exits Present.
// For a document, Present shows it full screen at reading width."
//
// - Full screen: BrowserWindow.setFullScreen on every platform. On macOS that is the native full screen (its own
//   Space); the deck view and the shell are views of the window's contentView either way, and main lays them
//   out from the content size it reports after each resize, so both stay correct through the animation. A
//   window that was already full screen stays so when Present ends.
// - Chrome hidden: the shell is the window's own webContents, so it cannot be removed; layout.ts gives every bar,
//   the rail and the panel zero size, the shell shows no chrome (ShellView.presenting), only the letterbox
//   behind the deck view, and views.ts lays the deck view out at Fit over the whole window (documents at
//   reading width).
// - Keys: Present routes keys as Read does (6.2 step 4: every key to the deck), so the app mode is Read while
//   presenting, and the previous mode comes back after it. Main takes no app chord from the deck view while
//   presenting, and the menu's accelerators are disabled (menu.ts), except Quit; Esc, and only Esc, is taken in
//   before-input-event and ends Present.
// - The slide the presenter reached stays shown when Present ends (the deck view is never reloaded for it; a
//   mode change that reloads for reduced motion restores the view state, window.ts).
//
// The state machine is pure over a small host interface, unit-tested (test/unit/app/present.test.ts).

import type { AppMode } from '@blueline/core/ipc';

export interface PresentHost {
  isFullScreen(): boolean;
  setFullScreen(on: boolean): void;
  appMode(): AppMode;
  /** Switches the app mode (DocWindow.setMode); false when refused. */
  setMode(mode: AppMode): boolean;
  /** Lays the window out again (bars, rail, deck view, zoom) and pushes the shell state. */
  relayout(): void;
  /** Gives the keyboard to the deck view. */
  focusDeck(): void;
  /** Present started or ended (the app menu's accelerators follow it). */
  onChange(presenting: boolean): void;
}

/** The fields of Electron's `Input` the Esc check reads. */
export interface PresentInput {
  type: string;
  key: string;
  code: string;
  control: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  isAutoRepeat?: boolean;
}

/** 6.9: Esc, and only Esc (no modifier), ends Present. */
export function isPresentExit(input: PresentInput): boolean {
  if (!input || input.type !== 'keyDown') return false;
  if (input.control || input.meta || input.alt || input.shift) return false;
  return input.key === 'Escape' || input.code === 'Escape';
}

export class Present {
  private saved: { mode: AppMode; wasFullScreen: boolean } | null = null;
  /** Main set full screen and is waiting for the window to get there (macOS animates). */
  private entering = false;

  constructor(private readonly host: PresentHost) {}

  get active(): boolean {
    return this.saved !== null;
  }

  /** The mode Present will go back to, while presenting. */
  get savedMode(): AppMode | null {
    return this.saved?.mode ?? null;
  }

  /** Starts Present (Cmd+Option+P, the toolbar's Present). Returns false when it was already on. */
  enter(): boolean {
    if (this.saved) return false;
    const wasFullScreen = this.host.isFullScreen();
    this.saved = { mode: this.host.appMode(), wasFullScreen };
    // Read routing: every key goes to the deck (6.2 step 4), and the deck keeps its own motion (Read, Present).
    if (this.host.appMode() !== 'read') this.host.setMode('read');
    if (!wasFullScreen) {
      this.entering = true;
      this.host.setFullScreen(true);
    }
    this.host.relayout();
    this.host.focusDeck();
    this.host.onChange(true);
    return true;
  }

  /** Ends Present (Esc), restoring the window's full screen state and the mode it had. */
  exit(): boolean {
    const s = this.saved;
    if (!s) return false;
    this.saved = null;
    this.entering = false;
    if (!s.wasFullScreen && this.host.isFullScreen()) this.host.setFullScreen(false);
    if (s.mode !== this.host.appMode()) this.host.setMode(s.mode);
    this.host.relayout();
    this.host.focusDeck();
    this.host.onChange(false);
    return true;
  }

  /** The window reached full screen (enter-full-screen). */
  onEnterFullScreen(): void {
    this.entering = false;
    if (this.saved) this.host.relayout();
  }

  /**
   * The window left full screen (leave-full-screen): when that was not Present's own exit (the user used the
   * system's control, or another app took it), Present ends too, so the chrome comes back with the window.
   */
  onLeaveFullScreen(): void {
    if (!this.saved || this.entering) return;
    this.exit();
  }

  /** before-input-event while presenting: true when the input ended Present (the caller prevents it). */
  onInput(input: PresentInput): boolean {
    if (!this.saved || !isPresentExit(input)) return false;
    if (input.isAutoRepeat) return true;
    this.exit();
    return true;
  }
}
