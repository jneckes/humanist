// The window's layout (6.0 The window). Main owns the numbers: it positions the deck view from them and
// sends them to the shell in ShellState, so the shell's toolbar, bars, rails and panel line up with the
// deck view exactly. Pure, unit-tested. Where the deck view goes inside the content area (its zoom, Fit,
// Reading Width, Present) is views.ts.

import type { AppMode, ShellLayout } from '@blueline/core/ipc';

export const TOOLBAR_HEIGHT = 44;
export const TRUST_BAR_HEIGHT = 40;
export const BANNER_HEIGHT = 32;
/** 6.9 Find: the Find bar sits under the toolbar's bars (the deck view covers the content area). */
export const FIND_BAR_HEIGHT = 36;
export const STATUS_BAR_HEIGHT = 26;
export const LEFT_RAIL_WIDTH = 200;
export const RIGHT_PANEL_WIDTH = 300;
export const RIGHT_PANEL_NARROW = 240;

export interface LayoutInput {
  /** The window's content size in DIPs. */
  width: number;
  height: number;
  appMode: AppMode;
  trustBarVisible: boolean;
  bannerVisible: boolean;
  /** Added by views: the Find bar is open (6.9 Find); its results show in the rail. */
  findBarVisible?: boolean;
  /** Added by views: View › Hide Slides (6.0: the rail "can be collapsed"). The Find results bring it back. */
  railHidden?: boolean;
  /** Added by views: Present (6.9): no chrome at all; the deck view fills the window. */
  presenting?: boolean;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The shell layout for a window size. The right panel shows in Review and Edit (6.0); on narrow windows
 * the rail and then the panel give way so the deck keeps a usable width. Present shows no chrome.
 */
export function computeLayout(i: LayoutInput): ShellLayout {
  if (i.presenting) return { toolbar: 0, trustBar: 0, banner: 0, findBar: 0, statusBar: 0, leftRail: 0, rightPanel: 0 };
  const w = Math.max(0, Math.floor(i.width));
  const panelWanted = i.appMode === 'review' || i.appMode === 'edit';
  const rightPanel = !panelWanted ? 0 : w >= 1000 ? RIGHT_PANEL_WIDTH : w >= 700 ? RIGHT_PANEL_NARROW : 0;
  // The Find results live in the rail, so an open Find bar shows it even when the user hid it.
  const railWanted = !i.railHidden || i.findBarVisible === true;
  const leftRail = railWanted && w - rightPanel >= 700 ? LEFT_RAIL_WIDTH : 0;
  return {
    toolbar: TOOLBAR_HEIGHT,
    trustBar: i.trustBarVisible ? TRUST_BAR_HEIGHT : 0,
    banner: i.bannerVisible ? BANNER_HEIGHT : 0,
    findBar: i.findBarVisible ? FIND_BAR_HEIGHT : 0,
    statusBar: STATUS_BAR_HEIGHT,
    leftRail,
    rightPanel,
  };
}

/** The content area: between the bars, the rail and the panel (views.ts places the deck view inside it). */
export function deckBounds(layout: ShellLayout, size: { width: number; height: number }): Bounds {
  const x = layout.leftRail;
  const y = layout.toolbar + layout.trustBar + layout.banner + (layout.findBar ?? 0);
  const width = Math.max(0, Math.floor(size.width) - layout.leftRail - layout.rightPanel);
  const height = Math.max(0, Math.floor(size.height) - y - layout.statusBar);
  return { x, y, width, height };
}
