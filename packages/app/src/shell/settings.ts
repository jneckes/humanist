// The Settings window's page (6.1 Becoming the default app: Settings › General; 6.10 Settings › Trust; 9.9 the
// CDN allowlist and the strict option). Two panes: General (whether Blueline is the default HTML app, and the
// button that makes it so; since Phase 2 also Editing › Smart punctuation, 6.3) and Trust (trusted and untrusted
// folders, "Block all network in Protected view", the allowlist, and About Protected view). Every string goes in
// with textContent, never as HTML, and no data goes into a style string (9.1 Shell view); the page talks to main
// only through window.blueline, the Settings preload's contextBridge API. Main shows the folder dialog itself:
// the page never names a folder to add.

import {
  PROTECTED_VIEW_HELP,
  type DefaultAppResult,
  type DefaultAppStatus,
  type FolderKind,
  type FolderResult,
  type SettingsApi,
  type SettingsPane,
  type SettingsState,
} from '@blueline/core/ipc-trust';

/** The state and API as main and the preload give them. `smartPunctuation` null (or absent): not offered. */
type PageState = Omit<SettingsState, 'smartPunctuation'> & { smartPunctuation?: boolean | null };
type PageApi = SettingsApi;

// window.blueline is declared as the document shell's ShellApi (shell.ts); in this window the Settings preload
// puts a SettingsApi there instead.
const api = (window as unknown as { blueline: PageApi }).blueline;

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
  return `Not changed: ${e instanceof Error ? e.message : String(e)}`;
}

let state: PageState | null = null;

// ------------------------------------------------------------------------------------------- tabs

const PANES: readonly SettingsPane[] = ['general', 'trust'];

function showPane(pane: SettingsPane): void {
  for (const p of PANES) {
    const selected = p === pane;
    const tab = el<HTMLButtonElement>(`tab-${p}`);
    tab.setAttribute('aria-selected', selected ? 'true' : 'false');
    tab.tabIndex = selected ? 0 : -1;
    el(`pane-${p}`).hidden = !selected;
  }
}

function setupTabs(): void {
  for (const p of PANES) {
    const tab = el<HTMLButtonElement>(`tab-${p}`);
    tab.addEventListener('click', () => showPane(p));
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const next = PANES[(PANES.indexOf(p) + (e.key === 'ArrowRight' ? 1 : PANES.length - 1)) % PANES.length];
      showPane(next);
      el(`tab-${next}`).focus();
    });
  }
}

// ------------------------------------------------------------------------------------------- General

function renderDefault(d: DefaultAppStatus | null, platform: SettingsState['platform']): void {
  const button = el<HTMLButtonElement>('make-default');
  const note = el('default-note');
  if (!d) {
    el('default-status').textContent = 'Checking which app opens HTML files…';
    button.disabled = true;
    note.textContent = '';
    return;
  }
  if (d.known && d.isDefault) el('default-status').textContent = 'Blueline opens your HTML files.';
  else if (d.known && d.current) el('default-status').textContent = `${d.current} opens your HTML files.`;
  else if (d.known) el('default-status').textContent = 'Blueline is not your HTML app.';
  else el('default-status').textContent = 'Blueline cannot tell which app opens your HTML files.';
  button.disabled = d.action === 'none' || (d.known && d.isDefault && d.action === 'set');
  if (d.reason) note.textContent = d.reason;
  else if (d.action === 'open-settings') note.textContent = 'Windows lets you choose this yourself: Default Apps settings opens on Blueline’s page. Choose Blueline for .html and .htm there.';
  else if (d.action === 'set' && platform === 'darwin') note.textContent = 'From macOS 26.4, macOS asks you to confirm the change.';
  else note.textContent = '';
}

function defaultResultText(r: DefaultAppResult): { text: string; kind: 'ok' | 'error' | 'info' } {
  if (r.ok && r.openedSettings) return { text: 'Default Apps settings is open. Choose Blueline there.', kind: 'info' };
  if (r.ok) return { text: 'Done: Blueline now opens your HTML files.', kind: 'ok' };
  if (r.declined) return { text: 'Not now: you kept your current HTML app.', kind: 'info' };
  return { text: r.reason ?? 'The default HTML app was not changed.', kind: 'error' };
}

function setupGeneral(): void {
  const button = el<HTMLButtonElement>('make-default');
  button.addEventListener('click', () => {
    button.disabled = true;
    say('default-result', '');
    void api
      .makeDefaultApp()
      .then((r) => {
        const t = defaultResultText(r);
        say('default-result', t.text, t.kind);
      })
      .catch((e: unknown) => say('default-result', failure(e), 'error'))
      .finally(() => {
        if (state) renderDefault(state.defaultApp, state.platform);
      });
  });
  // 6.3 Smart punctuation: the default for every document that has no setting of its own.
  const smart = el<HTMLInputElement>('smart-punctuation');
  smart.addEventListener('change', () => {
    const on = smart.checked;
    smartBusy = true;
    smart.disabled = true;
    say('smart-punctuation-result', '');
    void api
      .setSmartPunctuation(on)
      .catch((e: unknown) => {
        smart.checked = !on;
        say('smart-punctuation-result', failure(e), 'error');
      })
      .finally(() => {
        smartBusy = false;
        if (state) renderSmartPunctuation(state);
      });
  });
}

/** A change of the smart punctuation default is on its way to main: a state push leaves the box alone. */
let smartBusy = false;

function renderSmartPunctuation(s: PageState): void {
  if (smartBusy) return;
  const smart = el<HTMLInputElement>('smart-punctuation');
  const offered = typeof s.smartPunctuation === 'boolean';
  if (offered) smart.checked = s.smartPunctuation === true;
  smart.disabled = !offered;
}

// ------------------------------------------------------------------------------------------- Trust

function renderFolders(kind: FolderKind, folders: readonly string[]): void {
  const list = el<HTMLUListElement>(`${kind}-list`);
  list.replaceChildren();
  if (folders.length === 0) {
    list.append(make('li', 'empty', kind === 'trusted' ? 'No trusted folders.' : 'No untrusted folders.'));
    return;
  }
  for (const f of folders) {
    const li = make('li', 'item');
    li.dataset.folder = f;
    const name = make('span', 'path', f);
    name.title = f;
    const remove = make('button', 'remove', 'Remove');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${f}`);
    remove.addEventListener('click', () => {
      remove.disabled = true;
      void api.removeFolder(kind, f).catch((e: unknown) => {
        remove.disabled = false;
        say(`${kind}-result`, failure(e), 'error');
      });
    });
    li.append(name, remove);
    list.append(li);
  }
}

function folderResultText(kind: FolderKind, r: FolderResult): { text: string; kind: 'ok' | 'error' | 'info' } | null {
  if (r.canceled) return null;
  if (r.ok) return { text: `Added ${r.folder ?? 'the folder'}.`, kind: 'ok' };
  return { text: r.reason ?? (kind === 'trusted' ? 'That folder cannot be a trusted folder.' : 'That folder was not added.'), kind: 'error' };
}

function renderHosts(hosts: readonly string[], isDefault: boolean): void {
  const list = el<HTMLUListElement>('allowlist');
  list.replaceChildren();
  if (hosts.length === 0) list.append(make('li', 'empty', 'No hosts: Protected view loads nothing from the network.'));
  for (const h of hosts) {
    const li = make('li', 'item');
    li.dataset.host = h;
    const remove = make('button', 'remove', 'Remove');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove ${h}`);
    remove.addEventListener('click', () => {
      remove.disabled = true;
      void api.removeAllowlistHost(h).catch((e: unknown) => {
        remove.disabled = false;
        say('host-result', failure(e), 'error');
      });
    });
    li.append(make('span', 'host', h), remove);
    list.append(li);
  }
  el<HTMLButtonElement>('reset-allowlist').disabled = isDefault;
}

function setupTrust(): void {
  for (const kind of ['trusted', 'untrusted'] as const) {
    const add = el<HTMLButtonElement>(`add-${kind}`);
    add.addEventListener('click', () => {
      add.disabled = true;
      say(`${kind}-result`, '');
      void api
        .addFolder(kind)
        .then((r) => {
          const t = folderResultText(kind, r);
          if (t) say(`${kind}-result`, t.text, t.kind);
        })
        .catch((e: unknown) => say(`${kind}-result`, failure(e), 'error'))
        .finally(() => {
          add.disabled = false;
        });
    });
  }
  const strict = el<HTMLInputElement>('strict');
  strict.addEventListener('change', () => {
    const on = strict.checked;
    strict.disabled = true;
    void api
      .setStrictProtected(on)
      .catch(() => {
        strict.checked = !on;
      })
      .finally(() => {
        strict.disabled = false;
      });
  });
  const form = el<HTMLFormElement>('host-form');
  const input = el<HTMLInputElement>('host-input');
  form.addEventListener('submit', (e) => {
    // The page never navigates (9.1): the form only collects the host.
    e.preventDefault();
    const host = input.value.trim();
    if (host.length === 0) return;
    void api
      .addAllowlistHost(host)
      .then((r) => {
        if (r.ok) {
          input.value = '';
          say('host-result', `Allowed ${r.host ?? host}.`, 'ok');
        } else say('host-result', r.reason ?? 'That host was not added.', 'error');
      })
      .catch((err: unknown) => say('host-result', failure(err), 'error'));
  });
  el<HTMLButtonElement>('reset-allowlist').addEventListener('click', () => {
    void api
      .resetAllowlist()
      .then(() => say('host-result', 'The allowlist is back to its defaults.', 'ok'))
      .catch((err: unknown) => say('host-result', failure(err), 'error'));
  });
}

/** About Protected view (6.10, 9.9; SECURITY.md Known channels), from the shared text. */
function renderHelp(): void {
  const h = PROTECTED_VIEW_HELP;
  el('help-title').textContent = h.title;
  const box = el('help');
  const list = (tag: 'ul' | 'ol', items: readonly string[]) => {
    const l = make(tag, 'help-list');
    for (const i of items) l.append(make('li', undefined, i));
    return l;
  };
  box.append(
    make('p', 'note', h.intro),
    make('h3', 'subheading', h.blockedHeading),
    list('ul', h.blocked),
    make('h3', 'subheading', h.alwaysHeading),
    list('ul', h.always),
    make('h3', 'subheading', h.remainHeading),
    make('p', 'note', h.remainIntro),
    list('ol', h.remain),
    make('p', 'note', h.remainOutro),
  );
}

// ------------------------------------------------------------------------------------------- state

function render(s: PageState): void {
  state = s;
  renderDefault(s.defaultApp, s.platform);
  renderSmartPunctuation(s);
  renderFolders('trusted', s.trustedFolders);
  renderFolders('untrusted', s.untrustedFolders);
  const strict = el<HTMLInputElement>('strict');
  if (!strict.disabled) strict.checked = s.strictProtected;
  renderHosts(s.allowlist, s.allowlistIsDefault);
}

function start(): void {
  setupTabs();
  setupGeneral();
  setupTrust();
  renderHelp();
  api.onState(render);
  api.onShowPane((p) => {
    if (PANES.includes(p)) showPane(p);
  });
  void api.getState().then(render, () => undefined);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
