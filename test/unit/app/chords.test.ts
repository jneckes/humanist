// App chords (6.2 "App shortcuts are menu accelerators, enforced in main").
import { describe, expect, it } from 'vitest';
import { chordKey, matchAppChord, SwallowedKeys, type ChordInput } from '../../../packages/app/src/main/chords';

function input(p: Partial<ChordInput>): ChordInput {
  return { type: 'keyDown', key: '', code: '', control: false, meta: false, alt: false, shift: false, ...p };
}
const LINUX = { textField: false, platform: 'linux' as const };
const WIN = { textField: false, platform: 'win32' as const };
const MAC = { textField: false, platform: 'darwin' as const };
const ctrl = (key: string, code: string, extra: Partial<ChordInput> = {}) => input({ key, code, control: true, ...extra });
const cmd = (key: string, code: string, extra: Partial<ChordInput> = {}) => input({ key, code, meta: true, ...extra });

describe('matchAppChord: the 6.2 list', () => {
  const cases: [Partial<ChordInput>, string][] = [
    [{ key: '1', code: 'Digit1' }, 'mode-read'],
    [{ key: '2', code: 'Digit2' }, 'mode-review'],
    [{ key: '3', code: 'Digit3' }, 'mode-edit'],
    [{ key: 'p', code: 'KeyP', alt: true }, 'present'],
    [{ key: 'f', code: 'KeyF' }, 'find'],
    [{ key: 's', code: 'KeyS' }, 'save'],
    [{ key: 'E', code: 'KeyE', shift: true }, 'save-pdf'],
    [{ key: 'p', code: 'KeyP' }, 'print'],
    [{ key: 'Enter', code: 'Enter', shift: true }, 'send'],
    [{ key: 'z', code: 'KeyZ' }, 'undo'],
    [{ key: 'Z', code: 'KeyZ', shift: true }, 'redo'],
  ];
  it.each(cases)('Ctrl on Linux and Windows: %j → %s', (p, action) => {
    expect(matchAppChord(input({ ...p, control: true }), LINUX)).toBe(action);
    expect(matchAppChord(input({ ...p, control: true }), WIN)).toBe(action);
  });
  it.each(cases)('Cmd on macOS: %j → %s', (p, action) => {
    expect(matchAppChord(input({ ...p, meta: true }), MAC)).toBe(action);
  });

  it('macOS needs Cmd, not Ctrl; Linux and Windows need Ctrl, not Meta', () => {
    expect(matchAppChord(ctrl('s', 'KeyS'), MAC)).toBeNull();
    expect(matchAppChord(cmd('s', 'KeyS'), LINUX)).toBeNull();
    expect(matchAppChord(cmd('s', 'KeyS'), WIN)).toBeNull();
  });

  it('the modifier set must be exact', () => {
    expect(matchAppChord(ctrl('s', 'KeyS', { shift: true }), LINUX)).toBeNull(); // Ctrl+Shift+S
    expect(matchAppChord(ctrl('s', 'KeyS', { alt: true }), LINUX)).toBeNull(); // Ctrl+Alt+S
    expect(matchAppChord(ctrl('s', 'KeyS', { meta: true }), LINUX)).toBeNull(); // Ctrl+Meta+S
    expect(matchAppChord(cmd('s', 'KeyS', { control: true }), MAC)).toBeNull(); // Cmd+Ctrl+S
    expect(matchAppChord(ctrl('p', 'KeyP', { shift: true, alt: true }), LINUX)).toBeNull();
    expect(matchAppChord(ctrl('e', 'KeyE'), LINUX)).toBeNull(); // Ctrl+E without Shift
    expect(matchAppChord(ctrl('Enter', 'Enter'), LINUX)).toBeNull(); // Ctrl+Enter closes a card (6.4), not Send
    expect(matchAppChord(input({ key: 's', code: 'KeyS' }), LINUX)).toBeNull(); // no modifier
  });

  it("Wispr Flow's Cmd+V (and other chords) never match", () => {
    expect(matchAppChord(cmd('v', 'KeyV'), MAC)).toBeNull();
    expect(matchAppChord(ctrl('v', 'KeyV'), LINUX)).toBeNull();
    for (const [key, code] of [['c', 'KeyC'], ['x', 'KeyX'], ['a', 'KeyA'], ['b', 'KeyB'], ['4', 'Digit4'], ['0', 'Digit0']]) {
      expect(matchAppChord(cmd(key, code), MAC)).toBeNull();
      expect(matchAppChord(ctrl(key, code), LINUX)).toBeNull();
    }
  });

  it('Cmd+Z and Cmd+Shift+Z pass through while a text field has focus; other chords do not', () => {
    const tf = { textField: true, platform: 'darwin' as const };
    expect(matchAppChord(cmd('z', 'KeyZ'), tf)).toBeNull();
    expect(matchAppChord(cmd('z', 'KeyZ', { shift: true }), tf)).toBeNull();
    expect(matchAppChord(cmd('s', 'KeyS'), tf)).toBe('save');
    expect(matchAppChord(cmd('2', 'Digit2'), tf)).toBe('mode-review');
  });

  it('only keyDown matches (Electron reports raw key downs as keyDown)', () => {
    expect(matchAppChord(ctrl('s', 'KeyS', { type: 'keyUp' }), LINUX)).toBeNull();
    expect(matchAppChord(ctrl('s', 'KeyS', { type: 'char' }), LINUX)).toBeNull();
  });

  it('macOS Option+P types π: the physical key decides (Cmd+Option+P is Present)', () => {
    expect(matchAppChord(cmd('π', 'KeyP', { alt: true }), MAC)).toBe('present');
  });

  it('the typed key wins over the physical key when it is a Latin letter (Dvorak: Cmd+O is not Cmd+S)', () => {
    expect(matchAppChord(cmd('o', 'KeyS'), MAC)).toBeNull();
    expect(matchAppChord(cmd('s', 'Semicolon'), MAC)).toBe('save');
  });

  it('non-Latin layouts and AZERTY digits fall back to the physical key', () => {
    expect(matchAppChord(ctrl('ы', 'KeyS'), LINUX)).toBe('save'); // Russian layout
    expect(matchAppChord(ctrl('&', 'Digit1'), LINUX)).toBe('mode-read'); // AZERTY
  });
});

describe('chordKey', () => {
  it('normalizes keys', () => {
    expect(chordKey({ key: 'S', code: 'KeyS' })).toBe('s');
    expect(chordKey({ key: 'Enter', code: 'NumpadEnter' })).toBe('enter');
    expect(chordKey({ key: 'Unidentified', code: 'NumpadEnter' })).toBe('enter');
    expect(chordKey({ key: 'F5', code: 'F5' })).toBeNull();
    expect(chordKey({ key: '', code: '' })).toBeNull();
  });
});

describe('SwallowedKeys', () => {
  it("hides the keyUp of a swallowed keyDown once, and nothing else", () => {
    const s = new SwallowedKeys();
    s.add('KeyS');
    expect(s.takeKeyUp({ type: 'keyDown', code: 'KeyS' })).toBe(false);
    expect(s.takeKeyUp({ type: 'keyUp', code: 'KeyA' })).toBe(false);
    expect(s.takeKeyUp({ type: 'keyUp', code: 'KeyS' })).toBe(true);
    expect(s.takeKeyUp({ type: 'keyUp', code: 'KeyS' })).toBe(false);
  });
});
