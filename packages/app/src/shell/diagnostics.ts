// The Diagnostics window's shell page (section 10, Phase 0, Diagnostics window): the current mode, the
// guided steps with Pass, Fail and Skip buttons, the automatic checks, the event log and Save. Main places
// the deck view (the bundled reveal.js deck with the real key router) beside the panel. Every string goes
// in with textContent, never as HTML (9.1 Shell view); the page talks to main only through
// window.blueline.diag (the shell preload's contextBridge API).

import type { AppMode, DiagState, DiagStep, ShellApi } from '@blueline/core/ipc';

declare global {
  interface Window {
    blueline: ShellApi;
  }
}

const api: ShellApi = window.blueline;

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

const MODE_LABEL: Record<AppMode, string> = { read: 'Read', review: 'Review', edit: 'Edit' };
const mac = /Mac/i.test(navigator.platform);
const cmd = mac ? 'Cmd' : 'Ctrl';

let busy = false;

function setStatus(text: string): void {
  el('status').textContent = text;
}

function stepItem(s: DiagStep): HTMLLIElement {
  const li = make('li', 'step');
  li.dataset.step = s.id;
  const head = make('div', 'step-head');
  head.append(make('span', 'step-title', s.title), make('span', `badge ${s.result}`, s.result));
  li.append(head, make('p', 'step-text', s.instructions.replace(/\bCmd\+/g, `${cmd}+`)));
  if (s.detail) li.append(make('p', 'step-detail', s.detail));
  if (!s.auto) {
    const actions = make('div', 'step-actions');
    for (const [result, label] of [
      ['pass', 'Pass'],
      ['fail', 'Fail'],
      ['skip', 'Skip'],
    ] as const) {
      const b = make('button', undefined, label);
      b.type = 'button';
      b.dataset.result = result;
      b.addEventListener('click', () => {
        void api.diag.record(s.id, result).catch((e: unknown) => setStatus(`Not recorded: ${String(e)}`));
      });
      actions.append(b);
    }
    li.append(actions);
  }
  return li;
}

function shortTime(iso: string): string {
  const t = iso.indexOf('T');
  return t >= 0 ? iso.slice(t + 1, t + 13) : iso;
}

function dataText(d: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(d);
    return s.length > 600 ? `${s.slice(0, 600)}…` : s;
  } catch {
    return '';
  }
}

function render(s: DiagState): void {
  if (!s || !Array.isArray(s.steps)) return;
  const mode = s.appMode && Object.prototype.hasOwnProperty.call(MODE_LABEL, s.appMode) ? MODE_LABEL[s.appMode] : 'Read';
  el('mode').textContent = mode;
  const guided = el('guided');
  const automatic = el('automatic');
  guided.replaceChildren(...s.steps.filter((x) => !x.auto).map(stepItem));
  automatic.replaceChildren(...s.steps.filter((x) => x.auto).map(stepItem));
  const log = el('log');
  const entries = Array.isArray(s.log) ? s.log.slice(-300).reverse() : [];
  log.replaceChildren(
    ...entries.map((e) => {
      const li = make('li');
      li.append(make('span', 'log-time', `${shortTime(String(e.at))} `), document.createTextNode(`${String(e.event)} ${dataText(e.data ?? {})}`));
      return li;
    }),
  );
  busy = s.running === true;
  el<HTMLButtonElement>('run-auto').disabled = busy;
  if (busy) setStatus('Running the automatic checks…');
  else if (s.savedTo) setStatus(`Saved to ${s.savedTo}`);
}

function init(): void {
  el('chord-hint').textContent = `${cmd}+1 Read · ${cmd}+2 Review · ${cmd}+3 Edit`;
  el('run-auto').addEventListener('click', () => {
    if (busy) return;
    setStatus('Running the automatic checks…');
    void api.diag.runAuto().catch((e: unknown) => setStatus(`The checks did not run: ${String(e)}`));
  });
  el('save').addEventListener('click', () => {
    void api.diag
      .save()
      .then((p) => setStatus(`Saved to ${p}`))
      .catch((e: unknown) => setStatus(`Not saved: ${String(e)}`));
  });
  api.diag.onState(render);
  void api.diag.getState().then(render);
}

init();
