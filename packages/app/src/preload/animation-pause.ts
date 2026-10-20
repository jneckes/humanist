// Pausing the page's animations (6.3 "Animations pause while editing"; 6.7 step 3 for still renders). Shared by
// the deck view's Edit mode (edit-controller.ts) and the render agent (render-agent.ts).
//
// 6.3: call Animation.pause() on every animation, adopt a constructable stylesheet with
// `*{animation-play-state:paused!important}`, and remove it when leaving Edit. The spec does not say what happens
// to the Animation objects; a render window is thrown away, but the deck view goes back to Read, where a deck left
// frozen would be broken. So the Edit pause records exactly the animations it paused and, on leaving, plays only
// those that are still paused (the page may have finished, cancelled or restarted one meanwhile), and removes only
// its own sheet. Animations the page had paused itself are never touched.

import { PAUSE_ANIMATIONS_CSS } from './styles';

/** The parts of an Animation the pause uses (a real Animation in the preload; a fake in unit tests). */
export interface AnimationLike {
  readonly playState: string;
  pause(): void;
  play(): void;
}

/** The parts of a Document the pause uses. */
export interface PauseDoc {
  getAnimations(): AnimationLike[];
  adoptedStyleSheets: unknown[];
}

/** A new pause sheet, or null where constructable stylesheets are missing (they are not, in Electron 44). */
export function makePauseSheet(): CSSStyleSheet | null {
  try {
    const s = new CSSStyleSheet();
    s.replaceSync(PAUSE_ANIMATIONS_CSS);
    return s;
  } catch {
    return null;
  }
}

/** Pauses every running animation of the document and returns the ones it paused. */
export function pauseRunning(doc: PauseDoc): AnimationLike[] {
  const paused: AnimationLike[] = [];
  let list: AnimationLike[];
  try {
    list = doc.getAnimations();
  } catch {
    return paused;
  }
  for (const a of list) {
    try {
      if (a.playState === 'running') {
        a.pause();
        paused.push(a);
      }
    } catch {
      // An animation the page removed meanwhile.
    }
  }
  return paused;
}

/** Adopts `sheet` into the document once; true when it is adopted now. */
export function adoptSheet(doc: PauseDoc, sheet: unknown): boolean {
  if (!sheet) return false;
  try {
    if (!doc.adoptedStyleSheets.includes(sheet)) doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
    return doc.adoptedStyleSheets.includes(sheet);
  } catch {
    return false;
  }
}

/** Removes `sheet`, and only it, from the document's adopted sheets (the page may have adopted its own since). */
export function removeSheet(doc: PauseDoc, sheet: unknown): void {
  if (!sheet) return;
  try {
    if (doc.adoptedStyleSheets.includes(sheet)) doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((s) => s !== sheet);
  } catch {
    // A page that broke adoptedStyleSheets: nothing more to do.
  }
}

/**
 * The Edit-mode pause (6.3). pause() may be called again while paused (a field opens, a slide change started new
 * Web Animations): it pauses what runs now, adds those to the record, and adopts the sheet again if the page
 * replaced document.adoptedStyleSheets. resume() undoes exactly what the pauses did.
 */
export class AnimationPause {
  private readonly paused = new Set<AnimationLike>();
  private sheet: unknown = null;
  private on = false;

  constructor(
    private readonly doc: () => PauseDoc,
    private readonly newSheet: () => unknown = makePauseSheet,
  ) {}

  get active(): boolean {
    return this.on;
  }

  /** Pauses what runs now and adopts the sheet; returns how many animations it paused this time. */
  pause(): number {
    const doc = this.doc();
    this.on = true;
    if (!this.sheet) this.sheet = this.newSheet();
    adoptSheet(doc, this.sheet);
    const now = pauseRunning(doc);
    for (const a of now) this.paused.add(a);
    return now.length;
  }

  /** Removes the sheet and plays the animations the pause paused that are still paused; returns how many. */
  resume(): number {
    if (!this.on) return 0;
    this.on = false;
    removeSheet(this.doc(), this.sheet);
    let n = 0;
    for (const a of this.paused) {
      try {
        // Finished, cancelled (idle) or restarted by the page meanwhile: not ours to touch.
        if (a.playState === 'paused') {
          a.play();
          n++;
        }
      } catch {
        // removed meanwhile
      }
    }
    this.paused.clear();
    return n;
  }
}
