// The application menu (6.2): app chords are menu accelerators, and the menu lists every chord main takes.
// Phase 1: every reader command with its accelerator, enabled by the focused window's state; nothing but Quit
// while presenting (6.9: every key but Esc goes to the deck).
import { describe, expect, it } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { NO_DOCUMENT, SETTINGS_ACCELERATOR, ZOOM_ACCELERATORS, menuTemplate, type MenuState } from '../../../packages/app/src/main/menu';
import { PHASE_STUBS } from '../../../packages/app/src/main/actions';
import { matchAppChord } from '../../../packages/app/src/main/chords';

function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((i) => [i, ...(Array.isArray(i.submenu) ? flatten(i.submenu as MenuItemConstructorOptions[]) : [])]);
}

const DECK: MenuState = { hasDocument: true, appMode: 'read', kind: 'deck', zoomMode: 'fit', readingWidth: false, railHidden: false, presenting: false };
const DOC: MenuState = { ...DECK, kind: 'document' };

function items(state: MenuState, platform: NodeJS.Platform = 'linux', ran: string[] = []): Map<string, MenuItemConstructorOptions> {
  const all = flatten(menuTemplate({ run: (a) => ran.push(a), platform, devTools: false, state }));
  return new Map(all.filter((i) => i.label).map((i) => [i.label!, i]));
}

/** An accelerator as the chord matcher sees it on Linux (Ctrl). */
function asInput(acc: string): Parameters<typeof matchAppChord>[0] | null {
  const parts = acc.split('+');
  const key = parts[parts.length - 1];
  const mods = new Set(parts.slice(0, -1).map((m) => m.toLowerCase()));
  const k = key === 'Enter' ? 'Enter' : key.length === 1 ? key.toLowerCase() : null;
  if (!k) return null;
  const code = k === 'Enter' ? 'Enter' : /\d/.test(k) ? `Digit${k}` : /[a-z]/.test(k) ? `Key${k.toUpperCase()}` : k === ',' ? 'Comma' : '';
  return { type: 'keyDown', key: k, code, control: mods.has('cmdorctrl'), meta: false, alt: mods.has('alt'), shift: mods.has('shift') };
}

describe('menuTemplate', () => {
  const ran: string[] = [];
  const byLabel = items(DECK, 'linux', ran);

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

  it('the 6.2 chord list stays consistent: each chord accelerator runs the action main takes it for, and no other accelerator is a chord', () => {
    let last = '';
    const all = flatten(menuTemplate({ run: (a) => (last = a), platform: 'linux', devTools: false, state: DECK }));
    const seen = new Set<string>();
    for (const i of all) {
      if (typeof i.accelerator !== 'string' || typeof i.click !== 'function') continue;
      const inp = asInput(i.accelerator);
      expect(inp, i.accelerator).not.toBeNull();
      last = '';
      (i.click as () => void)();
      const chord = matchAppChord(inp!, { textField: false, platform: 'linux' });
      if (chord) {
        expect(chord, `${i.label}: ${i.accelerator}`).toBe(last);
        seen.add(chord);
      }
    }
    // Every 6.2 chord is in the menu.
    expect([...seen].sort()).toEqual(['find', 'mode-edit', 'mode-read', 'mode-review', 'present', 'print', 'redo', 'save', 'save-pdf', 'send', 'undo']);
    // Fit, 100% and Settings are menu accelerators only (no 6.2 chord takes Cmd+9, Cmd+0 or Cmd+,).
    for (const acc of [ZOOM_ACCELERATORS['zoom-fit'], ZOOM_ACCELERATORS['zoom-actual'], SETTINGS_ACCELERATOR]) {
      const inp = asInput(acc);
      if (inp) expect(matchAppChord(inp, { textField: false, platform: 'linux' }), acc).toBeNull();
    }
    expect(ZOOM_ACCELERATORS['zoom-fit']).toBe('CmdOrCtrl+9');
    expect(ZOOM_ACCELERATORS['zoom-actual']).toBe('CmdOrCtrl+0');
  });

  it('File has Open, Open Recent, Open in Protected View, Open in Browser, Reveal and Close; Help has the Phase 1 items', () => {
    for (const l of ['Open…', 'Open Recent', 'Open in Protected View…', 'Open in Browser', 'Show in Folder', 'Close', 'Run Diagnostics', 'Install Command Line Tool…', 'About Protected View', 'Welcome to Blueline']) {
      expect(byLabel.has(l), l).toBe(true);
    }
    expect(items(DECK, 'darwin').has('Reveal in Finder')).toBe(true);
    expect(items(DECK, 'win32').has('Show in Explorer')).toBe(true);
  });

  it('every item runs its action', () => {
    for (const i of byLabel.values()) if (typeof i.click === 'function') (i.click as () => void)();
    expect(ran).toEqual(
      expect.arrayContaining([
        'open',
        'open-protected',
        'open-in-browser',
        'reveal',
        'close',
        'undo',
        'redo',
        'mode-read',
        'mode-review',
        'mode-edit',
        'present',
        'find',
        'save',
        'save-pdf',
        'print',
        'send',
        'diagnostics',
        'install-cli',
        'zoom-fit',
        'zoom-actual',
        'zoom-fill',
        'reading-width',
        'toggle-rail',
        'about-protected',
        'welcome',
        'settings',
      ]),
    );
  });

  it('Settings…: Cmd+, in the macOS app menu, Ctrl+, in Edit elsewhere (6.10 Settings › Trust)', () => {
    const mac = menuTemplate({ run: () => undefined, platform: 'darwin', devTools: false, state: DECK });
    const appMenu = (mac[0].submenu as MenuItemConstructorOptions[]).map((i) => i.label ?? i.role);
    expect(appMenu).toContain('Settings…');
    expect((mac[0].submenu as MenuItemConstructorOptions[]).find((i) => i.label === 'Settings…')?.accelerator).toBe(SETTINGS_ACCELERATOR);
    expect((mac[0].submenu as MenuItemConstructorOptions[]).some((i) => i.role === 'quit')).toBe(true);
    const edit = menuTemplate({ run: () => undefined, platform: 'linux', devTools: false, state: DECK }).find((m) => m.label === 'Edit')!;
    expect((edit.submenu as MenuItemConstructorOptions[]).find((i) => i.label === 'Settings…')?.accelerator).toBe('CmdOrCtrl+,');
  });

  it('Open Recent lists the recent files it is given, or says there are none', () => {
    const none = flatten(menuTemplate({ run: () => undefined, platform: 'linux', devTools: false, state: DECK }));
    expect(none.find((i) => i.label === 'Open Recent')?.submenu).toEqual([{ label: 'No Recent Files', enabled: false }]);
    const recent = [{ label: 'deck.html', click: () => undefined }];
    const withRecent = flatten(menuTemplate({ run: () => undefined, platform: 'linux', devTools: false, state: DECK, recent }));
    expect(withRecent.find((i) => i.label === 'Open Recent')?.submenu).toBe(recent);
  });

  it('state: no document disables the document commands; the zoom is for decks, Reading Width for documents', () => {
    const none = items(NO_DOCUMENT);
    for (const l of ['Present', 'Find…', 'Save as PDF…', 'Print…', 'Close', 'Open in Browser', 'Fit', '100%', 'Reading Width', 'Hide Slides']) {
      expect(none.get(l)?.enabled, l).toBe(false);
    }
    for (const l of ['Open…', 'Open in Protected View…', 'Run Diagnostics', 'About Protected View']) expect(none.get(l)?.enabled, l).not.toBe(false);
    const deck = items(DECK);
    expect(deck.get('Fit')).toMatchObject({ enabled: true, checked: true, type: 'radio' });
    expect(deck.get('100%')).toMatchObject({ enabled: true, checked: false });
    expect(deck.get('Fill Width')).toMatchObject({ enabled: true, checked: false });
    expect(deck.get('Reading Width')?.enabled).toBe(false);
    expect(deck.get('Read')?.checked).toBe(true);
    const doc = items({ ...DOC, readingWidth: true, railHidden: true });
    expect(doc.get('Fit')?.enabled).toBe(false);
    expect(doc.get('Reading Width')).toMatchObject({ enabled: true, checked: true });
    expect(doc.has('Show Outline')).toBe(true);
    expect(items({ ...DECK, railHidden: true }).has('Show Slides')).toBe(true);
    expect(items({ ...DECK, zoomMode: 'fill' }).get('Fill Width')?.checked).toBe(true);
  });

  it('Present: every item is off except Quit (6.9: every key but Esc goes to the deck)', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const all = flatten(menuTemplate({ run: () => undefined, platform, devTools: true, state: { ...DECK, presenting: true } }));
      for (const i of all) {
        if (i.type === 'separator' || Array.isArray(i.submenu) || i.role === 'windowMenu') continue;
        if (i.role === 'quit') expect(i.enabled, 'quit').not.toBe(false);
        else expect(i.enabled, `${platform}: ${i.label ?? i.role}`).toBe(false);
      }
      expect(all.some((i) => i.role === 'quit')).toBe(true);
    }
  });

  it('copy and paste stay roles, so Cmd+V works on macOS (Wispr Flow, D2)', () => {
    const roles = flatten(menuTemplate({ run: () => undefined, platform: 'linux', devTools: false, state: DECK })).map((i) => i.role).filter(Boolean);
    expect(roles).toEqual(expect.arrayContaining(['cut', 'copy', 'paste', 'selectAll']));
    expect([...byLabel.values()].some((i) => i.accelerator === 'CmdOrCtrl+V')).toBe(false);
  });

  it('macOS gets the app and window menus; developer tools only in development', () => {
    const mac = menuTemplate({ run: () => undefined, platform: 'darwin', devTools: true });
    expect(mac[0].label).toBe('Blueline');
    expect(flatten(mac).some((i) => i.role === 'windowMenu')).toBe(true);
    expect(flatten(mac).some((i) => i.role === 'toggleDevTools')).toBe(true);
    expect([...byLabel.values()].some((i) => i.role === 'toggleDevTools')).toBe(false);
  });

  it('later-phase items say when they arrive', () => {
    expect(PHASE_STUBS.present).toBeUndefined();
    expect(PHASE_STUBS.find).toBeUndefined();
    expect(PHASE_STUBS.send).toMatch(/Phase 4/);
    // Phase 2: undo and redo of the document's own writes are app undo now (P2-10), not a stub.
    expect(PHASE_STUBS.undo).toBeUndefined();
    expect(PHASE_STUBS.redo).toBeUndefined();
  });
});
