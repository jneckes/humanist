// What a launch without a file shows, and what a second launch without a file brings forward (6.0 First run and
// 6.1 Mechanics, as decided for Phase 1: review findings 24, 26 and 34). The first-run welcome shows on the first
// launch only (config.json seen.welcome unset). Later launches show nothing on macOS (the app stays in the Dock)
// and the Open window on Windows and Linux, where the app has no other UI. A second launch focuses the Blueline
// window that is open: a document, else the welcome or Open window, else Settings, else any other.
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { on() {}, handle() {} },
  BrowserWindow: class {},
  session: { fromPartition: () => ({}) },
  nativeTheme: { shouldUseDarkColors: false },
  dialog: {},
}));

import { secondLaunchFocus, startupWindow } from '../../../packages/app/src/main/first-run';

describe('a launch without a file (startupWindow)', () => {
  it('the first launch shows the first-run welcome on every platform', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) expect(startupWindow({ platform, welcomeSeen: false })).toBe('welcome');
  });

  it('macOS after the first run: nothing (the app stays in the Dock; File › Open works from the menu bar)', () => {
    expect(startupWindow({ platform: 'darwin', welcomeSeen: true })).toBeNull();
  });

  it('Windows and Linux after the first run: the Open window, never the first-run questions again', () => {
    expect(startupWindow({ platform: 'win32', welcomeSeen: true })).toBe('open');
    expect(startupWindow({ platform: 'linux', welcomeSeen: true })).toBe('open');
  });
});

describe('a second launch without a file (secondLaunchFocus)', () => {
  const none = { document: false, welcome: false, settings: false, other: false };

  it('focuses a document window first, then the welcome or Open window, then Settings, then any other window', () => {
    expect(secondLaunchFocus({ document: true, welcome: true, settings: true, other: true })).toBe('document');
    expect(secondLaunchFocus({ ...none, welcome: true, settings: true, other: true })).toBe('welcome');
    expect(secondLaunchFocus({ ...none, settings: true, other: true })).toBe('settings');
    expect(secondLaunchFocus({ ...none, other: true })).toBe('other');
  });

  it('with no window open, nothing to focus: the launch rule decides (startupWindow)', () => {
    expect(secondLaunchFocus(none)).toBeNull();
  });
});
