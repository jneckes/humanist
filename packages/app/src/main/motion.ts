// Reduced motion while reviewing and editing (Josh, 2026-10-17; docs/spec-amendments/README.md, decision 1).
//
// Decks that animate their builds split headings into one span per word or letter, scramble text and fade
// content in (PHASE0-FINDINGS F27): with motion on, most of their text cannot be anchored or edited. Every
// real deck Josh sent honours `prefers-reduced-motion: reduce` and then draws its final frame directly. So the
// deck view of Review and Edit emulates `prefers-reduced-motion: reduce` for that view only; Read (and
// Present) keep motion as the deck sets it. This is how the deck looks in Chrome for a viewer who asks for
// reduced motion (principle 2).
//
// CSS media queries follow the emulation live. A deck whose script reads matchMedia once at load needs a
// reload to see the change: the view reloads when an inline script of the deck mentions the media feature,
// keeping the URL hash so a hash-routed deck stays on its slide (full view-state restore is 6.6, Phase 1).

import type { WebContents } from 'electron';
import type { AppMode } from '@blueline/core/ipc';
import type { DeckMap } from '@blueline/core/types';

/** Review and Edit render with reduced motion; Read keeps the deck's own motion. */
export function wantsReducedMotion(mode: AppMode): boolean {
  return mode === 'review' || mode === 'edit';
}

/**
 * True when an inline script of the deck mentions prefers-reduced-motion: it may read the setting once at
 * load, so switching motion needs a reload. External scripts are not read here; their decks follow CSS only.
 */
export function readsMotionInScript(src: string, map: Pick<DeckMap, 'scripts'>): boolean {
  for (const s of map.scripts) {
    if (s.hasSrc || (s.kind !== 'classic' && s.kind !== 'module')) continue;
    if (src.slice(s.contentStart, s.contentEnd).includes('prefers-reduced-motion')) return true;
  }
  return false;
}

/** The CDP command that sets (or clears, with reduce false) the emulated media feature. */
export function emulatedMediaCommand(reduce: boolean): { features: { name: string; value: string }[] } {
  return { features: [{ name: 'prefers-reduced-motion', value: reduce ? 'reduce' : '' }] };
}

/**
 * Emulates prefers-reduced-motion for one deck view through its own debugger (Emulation.setEmulatedMedia).
 * Main-process only: nothing is exposed to the page, and no port is opened. The emulation lasts while the
 * debugger is attached, across the view's reloads.
 */
export class MotionEmulation {
  private reduced = false;

  constructor(
    private readonly wc: () => WebContents | null,
    private readonly log: (msg: string) => void,
  ) {}

  get isReduced(): boolean {
    return this.reduced;
  }

  /** Sets the emulation; true when it took effect. */
  async set(reduce: boolean): Promise<boolean> {
    const wc = this.wc();
    if (!wc) return false;
    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      await wc.debugger.sendCommand('Emulation.setEmulatedMedia', emulatedMediaCommand(reduce));
      this.reduced = reduce;
      return true;
    } catch (e) {
      // DevTools open on the view, or the view is closing: the deck keeps its own motion.
      this.log(`reduced motion: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }
}
