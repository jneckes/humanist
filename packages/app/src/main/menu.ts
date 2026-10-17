// The application menu (6.2: app shortcuts are menu accelerators, so they can be found there; main also
// takes them in before-input-event on the deck view, chords.ts). Every item runs an AppAction through the
// controller, on the focused document window.
//
// Phase 1 (views): every reader command is here with its accelerator, enabled by state (MenuState: a document
// window is focused, it is a deck or a document, Present is on). The 6.2 chords keep their accelerators
// (test/unit/app/menu.test.ts checks the list against chords.ts); the View menu's zoom items use Cmd+9 (Fit) and
// Cmd+0 (100%), as Preview does, which no 6.2 chord takes. While presenting, every key but Esc goes to the deck
// (6.9), so every accelerator is off except Quit.

import { Menu, type MenuItemConstructorOptions } from 'electron';
import type { AppMode } from '@blueline/core/ipc';
import type { ViewKind, ZoomMode } from '@blueline/core/ipc-views';
import { revealLabel, type AppAction } from './actions';

/** What the menu shows for the focused window (null fields: no document window has focus). */
export interface MenuState {
  hasDocument: boolean;
  appMode: AppMode | null;
  kind: ViewKind | null;
  zoomMode: ZoomMode;
  readingWidth: boolean;
  railHidden: boolean;
  presenting: boolean;
}

export const NO_DOCUMENT: Readonly<MenuState> = Object.freeze({
  hasDocument: false,
  appMode: null,
  kind: null,
  zoomMode: 'fit',
  readingWidth: false,
  railHidden: false,
  presenting: false,
});

export interface MenuHandlers {
  run(action: AppAction): void;
  platform: NodeJS.Platform;
  /** Development builds get View › Toggle Developer Tools. */
  devTools: boolean;
  /** The focused window's state; NO_DOCUMENT when absent. */
  state?: MenuState;
  /** File › Open Recent's items (recent.ts RecentFiles.menuItems); absent: the submenu says there are none. */
  recent?: MenuItemConstructorOptions[];
  /** The app's name for the macOS app menu. */
  appName?: string;
}

/** The accelerators of the View menu's zoom items (6.9), checked against the 6.2 chords in the tests. */
export const ZOOM_ACCELERATORS: Readonly<Record<'zoom-fit' | 'zoom-actual', string>> = Object.freeze({
  'zoom-fit': 'CmdOrCtrl+9',
  'zoom-actual': 'CmdOrCtrl+0',
});

/** Settings… (6.10 Settings › Trust; 6.1 Settings › General): Cmd+, in the macOS app menu, Ctrl+, in Edit elsewhere. */
export const SETTINGS_ACCELERATOR = 'CmdOrCtrl+,';

/** Turns every item of a template off (Present), keeping Quit; separators and submenus are kept as they are. */
function presentLock(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.map((i) => {
    if (i.type === 'separator') return i;
    if (i.role === 'quit') return i;
    if (Array.isArray(i.submenu)) return { ...i, submenu: presentLock(i.submenu as MenuItemConstructorOptions[]) };
    if (i.role === 'appMenu' || i.role === 'windowMenu' || i.role === 'help') return i;
    return { ...i, enabled: false };
  });
}

/** The menu template (exported for tests: accelerators must match the 6.2 chord list). */
export function menuTemplate(h: MenuHandlers): MenuItemConstructorOptions[] {
  const mac = h.platform === 'darwin';
  const st = h.state ?? NO_DOCUMENT;
  const doc = st.hasDocument;
  const deck = doc && st.kind !== 'document';
  const item = (label: string, action: AppAction, accelerator?: string, enabled = true): MenuItemConstructorOptions => ({
    label,
    accelerator,
    enabled,
    click: () => h.run(action),
  });
  const radio = (label: string, action: AppAction, checked: boolean, enabled: boolean, accelerator?: string): MenuItemConstructorOptions => ({
    label,
    type: 'radio',
    checked,
    enabled,
    accelerator,
    click: () => h.run(action),
  });
  const template: MenuItemConstructorOptions[] = [];
  if (mac) {
    template.push({
      label: h.appName ?? 'Blueline',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        item('Settings…', 'settings', SETTINGS_ACCELERATOR),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }
  const recent = h.recent && h.recent.length > 0 ? h.recent : [{ label: 'No Recent Files', enabled: false }];
  template.push({
    label: 'File',
    submenu: [
      item('Open…', 'open', 'CmdOrCtrl+O'),
      { label: 'Open Recent', submenu: recent },
      item('Open in Protected View…', 'open-protected'),
      { type: 'separator' },
      item('Open in Browser', 'open-in-browser', undefined, doc),
      item(revealLabel(h.platform), 'reveal', undefined, doc),
      { type: 'separator' },
      item('Close', 'close', 'CmdOrCtrl+W', doc),
      ...(mac ? [] : ([{ type: 'separator' }, { role: 'quit' }] as MenuItemConstructorOptions[])),
    ],
  });
  template.push({
    label: 'Edit',
    submenu: [
      // Custom items, not roles: outside a text field they run app undo and redo (9.2); inside one the
      // controller hands them to the focused page's native undo.
      item('Undo', 'undo', 'CmdOrCtrl+Z'),
      item('Redo', 'redo', 'Shift+CmdOrCtrl+Z'),
      { type: 'separator' },
      // Roles: on macOS copy and paste work only through these (Wispr Flow pastes with Cmd+V, D2).
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
      ...(mac ? [] : ([{ type: 'separator' }, item('Settings…', 'settings', SETTINGS_ACCELERATOR)] as MenuItemConstructorOptions[])),
    ],
  });
  const railLabel = st.kind === 'document' ? (st.railHidden ? 'Show Outline' : 'Hide Outline') : st.railHidden ? 'Show Slides' : 'Hide Slides';
  template.push({
    label: 'View',
    submenu: [
      radio('Read', 'mode-read', st.appMode === 'read', doc, 'CmdOrCtrl+1'),
      radio('Review', 'mode-review', st.appMode === 'review', doc, 'CmdOrCtrl+2'),
      radio('Edit', 'mode-edit', st.appMode === 'edit', doc, 'CmdOrCtrl+3'),
      { type: 'separator' },
      // 6.9 Deck view: Fit (default), 100%, Fill width. Documents have no zoom.
      radio('Fit', 'zoom-fit', st.zoomMode === 'fit', deck, ZOOM_ACCELERATORS['zoom-fit']),
      radio('100%', 'zoom-actual', st.zoomMode === 'actual', deck, ZOOM_ACCELERATORS['zoom-actual']),
      radio('Fill Width', 'zoom-fill', st.zoomMode === 'fill', deck),
      // 6.9 Document view: Reading Width (off by default, remembered per file).
      { label: 'Reading Width', type: 'checkbox', checked: st.readingWidth, enabled: doc && st.kind === 'document', click: () => h.run('reading-width') },
      { type: 'separator' },
      item(railLabel, 'toggle-rail', undefined, doc),
      { type: 'separator' },
      item('Present', 'present', 'CmdOrCtrl+Alt+P', doc),
      item('Find…', 'find', 'CmdOrCtrl+F', doc),
      ...(h.devTools ? ([{ type: 'separator' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[]) : []),
    ],
  });
  template.push({
    label: 'Share',
    submenu: [
      item('Save', 'save', 'CmdOrCtrl+S', doc),
      item('Save as PDF…', 'save-pdf', 'CmdOrCtrl+Shift+E', doc),
      item('Print…', 'print', 'CmdOrCtrl+P', doc),
      { type: 'separator' },
      item('Send to Claude Code', 'send', 'CmdOrCtrl+Shift+Enter', doc),
    ],
  });
  if (mac) template.push({ role: 'windowMenu' });
  template.push({
    role: 'help',
    submenu: [
      item('About Protected View', 'about-protected'),
      { type: 'separator' },
      item('Welcome to Blueline', 'welcome'),
      item('Install Command Line Tool…', 'install-cli'),
      item('Run Diagnostics', 'diagnostics'),
    ],
  });
  return st.presenting ? presentLock(template) : template;
}

export function installAppMenu(h: MenuHandlers): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(h)));
}
