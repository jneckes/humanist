// The application menu (6.2: app shortcuts are menu accelerators, so they can be found there; main also
// takes them in before-input-event on the deck view, chords.ts). Every item runs an AppAction through the
// controller, on the focused document window.

import { Menu, type MenuItemConstructorOptions } from 'electron';
import type { AppAction } from './actions';

export interface MenuHandlers {
  run(action: AppAction): void;
  platform: NodeJS.Platform;
  /** Development builds get View › Toggle Developer Tools. */
  devTools: boolean;
}

/** The menu template (exported for tests: accelerators must match the 6.2 chord list). */
export function menuTemplate(h: MenuHandlers): MenuItemConstructorOptions[] {
  const mac = h.platform === 'darwin';
  const item = (label: string, action: AppAction, accelerator?: string): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: () => h.run(action),
  });
  const template: MenuItemConstructorOptions[] = [];
  if (mac) template.push({ role: 'appMenu' });
  template.push({
    label: 'File',
    submenu: [
      item('Open…', 'open', 'CmdOrCtrl+O'),
      item('Open in Protected View…', 'open-protected'),
      { type: 'separator' },
      item('Open in Browser', 'open-in-browser'),
      { type: 'separator' },
      item('Close', 'close', 'CmdOrCtrl+W'),
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
    ],
  });
  template.push({
    label: 'View',
    submenu: [
      item('Read', 'mode-read', 'CmdOrCtrl+1'),
      item('Review', 'mode-review', 'CmdOrCtrl+2'),
      item('Edit', 'mode-edit', 'CmdOrCtrl+3'),
      { type: 'separator' },
      item('Present', 'present', 'CmdOrCtrl+Alt+P'),
      item('Find…', 'find', 'CmdOrCtrl+F'),
      ...(h.devTools ? ([{ type: 'separator' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[]) : []),
    ],
  });
  template.push({
    label: 'Share',
    submenu: [
      item('Save', 'save', 'CmdOrCtrl+S'),
      item('Save as PDF…', 'save-pdf', 'CmdOrCtrl+Shift+E'),
      item('Print…', 'print', 'CmdOrCtrl+P'),
      { type: 'separator' },
      item('Send to Claude Code', 'send', 'CmdOrCtrl+Shift+Enter'),
    ],
  });
  if (mac) template.push({ role: 'windowMenu' });
  template.push({
    role: 'help',
    submenu: [item('Run Diagnostics', 'diagnostics'), item('Install Command Line Tool…', 'install-cli')],
  });
  return template;
}

export function installAppMenu(h: MenuHandlers): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate(h)));
}
