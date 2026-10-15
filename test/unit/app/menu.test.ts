// The application menu (6.2): app chords are menu accelerators, and the menu lists every chord main takes.
import { describe, expect, it } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { menuTemplate } from '../../../packages/app/src/main/menu';
import { PHASE_STUBS } from '../../../packages/app/src/main/actions';

function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((i) => [i, ...(Array.isArray(i.submenu) ? flatten(i.submenu as MenuItemConstructorOptions[]) : [])]);
}

describe('menuTemplate', () => {
  const ran: string[] = [];
  const items = flatten(menuTemplate({ run: (a) => ran.push(a), platform: 'linux', devTools: false }));
  const byLabel = new Map(items.filter((i) => i.label).map((i) => [i.label!, i]));

  it('has the 6.2 accelerators', () => {
    const acc = (label: string) => byLabel.get(label)?.accelerator;
    expect(acc('Read')).toBe('CmdOrCtrl+1');
    expect(acc('Review')).toBe('CmdOrCtrl+2');
    expect(acc('Edit')).toBe('CmdOrCtrl+3');
    expect(acc('Present')).toBe('CmdOrCtrl+Alt+P');
    expect(acc('Find…')).toBe('CmdOrCtrl+F');
    expect(acc('Save')).toBe('CmdOrCtrl+S');
    expect(acc('Save as PDF…')).toBe('CmdOrCtrl+Shift+E');
    expect(acc('Print…')).toBe('CmdOrCtrl+P');
    expect(acc('Send to Claude Code')).toBe('CmdOrCtrl+Shift+Enter');
    expect(acc('Undo')).toBe('CmdOrCtrl+Z');
    expect(acc('Redo')).toBe('Shift+CmdOrCtrl+Z');
  });

  it('File has Open, Open in Protected View, Open in Browser and Close; Help has Run Diagnostics', () => {
    for (const l of ['Open…', 'Open in Protected View…', 'Open in Browser', 'Close', 'Run Diagnostics', 'Install Command Line Tool…']) {
      expect(byLabel.has(l), l).toBe(true);
    }
  });

  it('every item runs its action', () => {
    for (const i of items) if (typeof i.click === 'function') (i.click as () => void)();
    expect(ran).toEqual(
      expect.arrayContaining(['open', 'open-protected', 'open-in-browser', 'close', 'undo', 'redo', 'mode-read', 'mode-review', 'mode-edit', 'present', 'find', 'save', 'save-pdf', 'print', 'send', 'diagnostics', 'install-cli']),
    );
  });

  it('copy and paste stay roles, so Cmd+V works on macOS (Wispr Flow, D2)', () => {
    const roles = items.map((i) => i.role).filter(Boolean);
    expect(roles).toEqual(expect.arrayContaining(['cut', 'copy', 'paste', 'selectAll']));
    expect(items.some((i) => i.accelerator === 'CmdOrCtrl+V')).toBe(false);
  });

  it('macOS gets the app and window menus; developer tools only in development', () => {
    const mac = menuTemplate({ run: () => undefined, platform: 'darwin', devTools: true });
    expect(mac[0].role).toBe('appMenu');
    expect(flatten(mac).some((i) => i.role === 'windowMenu')).toBe(true);
    expect(flatten(mac).some((i) => i.role === 'toggleDevTools')).toBe(true);
    expect(items.some((i) => i.role === 'toggleDevTools')).toBe(false);
  });

  it('later-phase items say when they arrive', () => {
    expect(PHASE_STUBS.present).toMatch(/Phase 1/);
    expect(PHASE_STUBS.send).toMatch(/Phase 4/);
    expect(PHASE_STUBS.undo).toMatch(/Phase 2/);
  });
});
