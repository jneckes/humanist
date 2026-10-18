// The welcome window's page (6.0 First run): Open a file, Make Blueline your HTML app, Try the sample deck
// (with the tour's three steps, ticked as the user does them in the sample's window), the user's name (6.8)
// and the crash-report question (9.9 Telemetry, asked once). Every string goes in with textContent, never as
// HTML, and no data goes into a style string (9.1 Shell view); the page talks to main only through
// window.blueline, the welcome preload's contextBridge API. Main shows the Open dialog itself: the page never
// names a file.
//
// The same page is the Open window (?mode=open, first-run.ts): what later launches show on Windows and Linux,
// with the three ways to start and none of the first run's questions or its tour. Main loads the page in one
// mode or the other and refuses the first-run answers from the Open window whatever the page shows.

import { tourSteps, type NameResult, type WelcomeApi, type WelcomeState } from '@blueline/core/ipc-files';
import type { DefaultAppResult, DefaultAppStatus } from '@blueline/core/ipc-trust';

// window.blueline is declared as the document shell's ShellApi (shell.ts); in this window the welcome preload
// puts a WelcomeApi there instead.
const api = (window as unknown as { blueline: WelcomeApi }).blueline;

/** The first-run welcome, or the Open window. */
const mode: 'welcome' | 'open' = new URLSearchParams(location.search).get('mode') === 'open' ? 'open' : 'welcome';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e as T;
}

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function say(id: string, text: string, kind: 'ok' | 'error' | 'info' = 'info'): void {
  const p = el(id);
  p.textContent = text;
  p.dataset.kind = kind;
}

function failure(e: unknown): string {
  return `That did not work: ${e instanceof Error ? e.message : String(e)}`;
}

let state: WelcomeState | null = null;
/** The name field is the user's while they edit it: state pushes do not overwrite it. */
let nameDirty = false;

// ------------------------------------------------------------------------------------------- default app

function renderDefault(d: DefaultAppStatus | null, platform: WelcomeState['platform']): void {
  const button = el<HTMLButtonElement>('make-default');
  const status = el('default-status');
  if (!d) {
    button.disabled = true;
    status.textContent = 'Checking which app opens HTML files…';
    return;
  }
  if (d.isDefault) {
    button.disabled = true;
    status.textContent = 'Blueline opens your HTML files.';
    return;
  }
  button.disabled = d.action === 'none';
  if (d.action === 'none') status.textContent = d.reason ?? 'This is set in your system’s settings.';
  else if (d.action === 'open-settings') status.textContent = 'Opens Default Apps in Settings, where you choose Blueline for .html and .htm.';
  else if (platform === 'darwin') status.textContent = d.current ? `HTML files open in ${d.current} now. Your Mac may ask you to confirm.` : 'Your Mac may ask you to confirm.';
  else status.textContent = d.current ? `HTML files open in ${d.current} now.` : 'Open HTML files with a double-click.';
}

function defaultResultText(r: DefaultAppResult): { text: string; kind: 'ok' | 'error' | 'info' } {
  if (r.ok && r.openedSettings) return { text: 'Choose Blueline for .html and .htm in Default Apps, then come back here.', kind: 'info' };
  if (r.ok) return { text: 'Blueline now opens your HTML files.', kind: 'ok' };
  // 6.1: a declined system prompt (macOS 26.4 and later) is "not now".
  if (r.declined) return { text: 'Not now. You can do this later in Settings › General.', kind: 'info' };
  return { text: `Not changed: ${r.reason ?? 'the system did not allow it.'}`, kind: 'error' };
}

// ------------------------------------------------------------------------------------------- tour

function renderTour(s: WelcomeState): void {
  const section = el('tour');
  // The Open window has no tour: it closes once the sample deck is open.
  section.hidden = mode !== 'welcome' || !s.sample.opened;
  const list = el('tour-steps');
  list.replaceChildren();
  for (const step of tourSteps(s.platform)) {
    const done = s.sample.modesSeen.includes(step.mode);
    const li = make('li', 'step');
    li.dataset.done = done ? 'true' : 'false';
    const mark = make('span', 'step-mark', done ? '✓' : '');
    mark.setAttribute('aria-hidden', 'true');
    const body = make('div');
    body.append(make('div', 'step-title', done ? `${step.title} (done)` : step.title), make('div', 'step-text', step.text));
    li.append(mark, body);
    list.append(li);
  }
}

// ------------------------------------------------------------------------------------------- state

function render(s: WelcomeState): void {
  state = s;
  renderDefault(s.defaultApp, s.platform);
  renderTour(s);
  const input = el<HTMLInputElement>('name-input');
  if (!nameDirty && document.activeElement !== input) input.value = s.name;
  // Unanswered (null) leaves the radios as the user has them: a state pushed between a click and its save
  // must not undo the click.
  if (s.crashReports !== null) {
    el<HTMLInputElement>('crash-yes').checked = s.crashReports;
    el<HTMLInputElement>('crash-no').checked = !s.crashReports;
  }
}

async function saveName(): Promise<boolean> {
  const input = el<HTMLInputElement>('name-input');
  if (!nameDirty) return true;
  let r: NameResult;
  try {
    r = await api.setName(input.value);
  } catch (e) {
    say('name-result', failure(e), 'error');
    return false;
  }
  if (!r.ok) {
    say('name-result', r.reason ?? 'Not saved.', 'error');
    return false;
  }
  nameDirty = false;
  input.value = r.name;
  say('name-result', `Saved. Your notes will say ${r.name}.`, 'ok');
  return true;
}

/** The page's mode: the first run's parts are shown only in the welcome; the Open window says what it is. */
function applyMode(): void {
  if (mode === 'welcome') {
    for (const e of document.querySelectorAll<HTMLElement>('[data-first-run]')) e.hidden = false;
    return;
  }
  document.title = 'Blueline';
  el('title').textContent = 'Blueline';
  el('lede').textContent = 'Open an HTML deck or document. You can also drop an .html file anywhere on this window.';
}

function setup(): void {
  applyMode();
  el('open-file').addEventListener('click', () => {
    void (async () => {
      if (!(await saveName())) return;
      try {
        const r = await api.openFile();
        if (r.canceled) return;
        say('action-result', r.ok ? 'Opened.' : (r.reason ?? 'Nothing was opened.'), r.ok ? 'ok' : 'error');
      } catch (e) {
        say('action-result', failure(e), 'error');
      }
    })();
  });
  el('make-default').addEventListener('click', () => {
    void (async () => {
      const b = el<HTMLButtonElement>('make-default');
      b.disabled = true;
      try {
        const r = defaultResultText(await api.makeDefaultApp());
        say('action-result', r.text, r.kind);
      } catch (e) {
        say('action-result', failure(e), 'error');
      } finally {
        if (state) renderDefault(state.defaultApp, state.platform);
      }
    })();
  });
  el('open-sample').addEventListener('click', () => {
    void (async () => {
      try {
        const r = await api.openSample();
        say('action-result', r.ok ? 'The sample deck is open in its own window. Follow the tour below.' : (r.reason ?? 'The sample deck did not open.'), r.ok ? 'ok' : 'error');
      } catch (e) {
        say('action-result', failure(e), 'error');
      }
    })();
  });

  const input = el<HTMLInputElement>('name-input');
  input.addEventListener('input', () => {
    nameDirty = true;
    say('name-result', '');
  });
  input.addEventListener('blur', () => void saveName());
  el('name-form').addEventListener('submit', (e) => {
    e.preventDefault();
    void saveName();
  });

  for (const [id, on] of [
    ['crash-yes', true],
    ['crash-no', false],
  ] as const) {
    el<HTMLInputElement>(id).addEventListener('change', () => {
      void api.setCrashReports(on).catch(() => undefined);
    });
  }

  el('done').addEventListener('click', () => {
    void (async () => {
      if (!(await saveName())) return;
      await api.close().catch(() => undefined);
    })();
  });

  api.onState(render);
  void api.getState().then(render, () => undefined);
}

setup();
