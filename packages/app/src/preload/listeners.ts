// Listeners that survive document.open(). The HTML spec's document open steps erase every event listener on
// the window AND on every shadow-including descendant of the document, the overlay host's closed shadow
// tree included, which would silently remove the key router's and the input guard's capture listeners
// (6.2, 9.1), the link and focus reporters, and every overlay listener: the card, the ink capture layer,
// the shadow root's stopPropagation listeners. Every preload listener on `window` is added through
// listen(), and every listener on an overlay node through listenOn(); when the overlay sees the root
// element replaced it calls reinstall(), which re-adds them all. The overlay host itself survives (it is
// put back on the new root), so its nodes are the same objects. addEventListener ignores a (type, callback,
// capture) triple that is already registered, so re-adding is safe when the listeners were not erased.
//
// Ordering limit: reinstall() runs from a MutationObserver callback, after the scripts that the page's
// document.write inserted have run, so listeners those scripts register synchronously come before the
// re-added ones. The preload cannot get ahead of them (see test/e2e/card-input.spec.ts).

type Entry = { type: string; fn: EventListener; opts: AddEventListenerOptions | boolean | undefined };
type NodeEntry = Entry & { target: EventTarget };

const registry = new WeakMap<Window, Entry[]>();
/** Listeners on overlay nodes (the host's shadow tree). The overlay lives as long as the page. */
const nodes: NodeEntry[] = [];

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

/**
 * Adds a listener to a node the preload owns (the overlay's shadow root and its elements) and records it so
 * reinstall() can add it again after document.open(). Register once per node: nodes created per update
 * (the card's mark list entries) use one delegated listener on their container instead.
 */
export function listenOn(target: EventTarget, type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions | boolean): void {
  const entry: NodeEntry = { target, type, fn: fn as EventListener, opts };
  nodes.push(entry);
  target.addEventListener(type, entry.fn, opts);
}

/**
 * Re-adds every listen() listener on `win` and every listenOn() listener (after document.open() erased
 * them). `once` listeners are not re-added.
 */
export function reinstall(win: Window): void {
  for (const e of registry.get(win) ?? []) {
    if (typeof e.opts === 'object' && e.opts.once) continue;
    win.addEventListener(e.type, e.fn, e.opts);
  }
  for (const e of nodes) {
    if (typeof e.opts === 'object' && e.opts.once) continue;
    e.target.addEventListener(e.type, e.fn, e.opts);
  }
}
