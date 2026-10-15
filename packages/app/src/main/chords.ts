// App chords (6.2 "App shortcuts are menu accelerators, enforced in main"). A focused page sees a keydown
// before the menu does, so a deck that calls preventDefault() on Cmd+S would swallow it. Main listens to
// `before-input-event` on the deck view and, when the input is exactly one of the app chords, calls
// event.preventDefault() (hiding the key from the page and the menu) and runs the menu item's action
// itself. Every other chord passes through, Wispr Flow's Cmd+V included.
//
// matchAppChord is pure: it sees Electron's `Input` and the focus state the preload reports.

/** The menu actions an app chord runs. */
export type AppChordAction =
  | 'mode-read'
  | 'mode-review'
  | 'mode-edit'
  | 'present'
  | 'find'
  | 'save'
  | 'save-pdf'
  | 'print'
  | 'send'
  | 'undo'
  | 'redo';

/** The fields of Electron's `Input` this reads. */
export interface ChordInput {
  type: string;
  key: string;
  code: string;
  control: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

export interface ChordContext {
  /** The preload reports a text field focused (DeckToMain.focus): Cmd+Z and Cmd+Shift+Z are native undo there. */
  textField: boolean;
  platform: NodeJS.Platform;
}

/** The key a chord names: a lowercase ASCII letter or digit, or `enter`. */
type ChordKey = string;

/**
 * The key of an input, as a menu accelerator sees it. `key` wins when it is an ASCII letter or digit, so a
 * Dvorak user's Cmd+O is not taken for Cmd+S. Otherwise (Option-modified characters on macOS such as `π`
 * for Option+P, non-Latin layouts, AZERTY's `&` on the 1 key) it falls back to the physical `code`.
 */
export function chordKey(input: Pick<ChordInput, 'key' | 'code'>): ChordKey | null {
  const key = typeof input.key === 'string' ? input.key : '';
  const code = typeof input.code === 'string' ? input.code : '';
  if (key === 'Enter' || code === 'Enter' || code === 'NumpadEnter') return 'enter';
  if (key.length === 1 && /^[A-Za-z0-9]$/.test(key)) return key.toLowerCase();
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1].toLowerCase();
  m = /^Digit([0-9])$/.exec(code);
  if (m) return m[1];
  return null;
}

interface ChordDef {
  key: ChordKey;
  shift: boolean;
  /** Option on macOS, Alt elsewhere. */
  alt: boolean;
  action: AppChordAction;
}

// 6.2: Cmd+1/2/3, Cmd+Option+P, Cmd+F, Cmd+S, Cmd+Shift+E, Cmd+P, Cmd+Shift+Enter; Cmd+Z / Cmd+Shift+Z.
const CHORDS: readonly ChordDef[] = [
  { key: '1', shift: false, alt: false, action: 'mode-read' },
  { key: '2', shift: false, alt: false, action: 'mode-review' },
  { key: '3', shift: false, alt: false, action: 'mode-edit' },
  { key: 'p', shift: false, alt: true, action: 'present' },
  { key: 'f', shift: false, alt: false, action: 'find' },
  { key: 's', shift: false, alt: false, action: 'save' },
  { key: 'e', shift: true, alt: false, action: 'save-pdf' },
  { key: 'p', shift: false, alt: false, action: 'print' },
  { key: 'enter', shift: true, alt: false, action: 'send' },
  { key: 'z', shift: false, alt: false, action: 'undo' },
  { key: 'z', shift: true, alt: false, action: 'redo' },
];

/**
 * The app chord an input is, or null to let it through. Only `keyDown` inputs match (the caller also hides
 * the matching keyUp). The modifier set must be exact: the platform's command key (Cmd on macOS, Ctrl on
 * Windows and Linux) and nothing else beyond the chord's own Shift or Option/Alt. Cmd+Z and Cmd+Shift+Z
 * match only while no text field has focus, so native undo works in cards and edits (9.2 Undo, step 5).
 */
export function matchAppChord(input: ChordInput, ctx: ChordContext): AppChordAction | null {
  if (!input || input.type !== 'keyDown') return null;
  const mac = ctx.platform === 'darwin';
  const command = mac ? input.meta === true : input.control === true;
  const otherCommand = mac ? input.control === true : input.meta === true;
  if (!command || otherCommand) return null;
  const key = chordKey(input);
  if (key === null) return null;
  for (const c of CHORDS) {
    if (c.key !== key || c.shift !== (input.shift === true) || c.alt !== (input.alt === true)) continue;
    if ((c.action === 'undo' || c.action === 'redo') && ctx.textField) return null;
    return c.action;
  }
  return null;
}

/**
 * Tracks keydowns main swallowed so their keyUp is hidden from the page too: a deck that acts on keyup
 * must not see half of an app chord.
 */
export class SwallowedKeys {
  private readonly codes = new Set<string>();

  /** Records a swallowed keyDown. */
  add(code: string): void {
    if (this.codes.size > 64) this.codes.clear();
    this.codes.add(code);
  }

  /** True (and forgets it) when `input` is the keyUp of a swallowed keyDown. */
  takeKeyUp(input: Pick<ChordInput, 'type' | 'code'>): boolean {
    if (input.type !== 'keyUp') return false;
    return this.codes.delete(input.code);
  }
}
