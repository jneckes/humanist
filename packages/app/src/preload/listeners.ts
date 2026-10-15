// Window listeners that survive document.open(). The HTML spec erases every event listener on the window
// when a page calls document.open() on its own document, which would silently remove the key router's
// capture listener (6.2) and the link and focus reporters. Every preload listener on `window` is added
// through listen(); when the overlay sees the root element replaced it calls reinstall(), which re-adds
// them. addEventListener ignores a (type, callback, capture) triple that is already registered, so
// re-adding is safe when the listeners were not erased.

type Entry = { type: string; fn: EventListener; opts: AddEventListenerOptions | boolean | undefined };

const registry = new WeakMap<Window, Entry[]>();

export function listen<K extends keyof WindowEventMap>(
  win: Window,
  type: K,
  fn: (e: WindowEventMap[K]) => void,
  opts?: AddEventListenerOptions | boolean,
): void {
  let list = registry.get(win);
  if (!list) registry.set(win, (list = []));
  const entry: Entry = { type, fn: fn as EventListener, opts };
  list.push(entry);
  win.addEventListener(type, entry.fn, opts);
}

/** Re-adds every listen() listener on `win` (after document.open() erased them). `once` listeners are not re-added. */
export function reinstall(win: Window): void {
  for (const e of registry.get(win) ?? []) {
    if (typeof e.opts === 'object' && e.opts.once) continue;
    win.addEventListener(e.type, e.fn, e.opts);
  }
}
