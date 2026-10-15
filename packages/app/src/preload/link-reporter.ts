// Link reporter (9.9 Navigation and links): a capture-phase click listener on window that tells main which
// link the user clicked, so main can tell a clicked link from a navigation the user did not ask for. Only
// trusted clicks count. It never calls preventDefault: main cancels the navigation itself (will-navigate)
// and shows its own dialog.

import { DeckToMain, type LinkClick } from '@blueline/core/ipc';
import { listen } from './listeners';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The absolute URL a clicked `a` / `area` (HTML or SVG) would navigate to, or null. */
export function linkHref(el: Element, baseURI: string): string | null {
  const n = el.localName;
  if (n !== 'a' && n !== 'area') return null;
  if (el.namespaceURI === SVG_NS) {
    const raw = el.getAttribute('href') ?? el.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
    if (raw === null) return null;
    try {
      return new URL(raw, baseURI).href;
    } catch {
      return null;
    }
  }
  if (!el.hasAttribute('href')) return null;
  const href = (el as HTMLAnchorElement).href;
  return typeof href === 'string' && href ? href : null;
}

/**
 * True when the link only changes the fragment of the current document: that navigation stays in place
 * (9.9 allows it), so main needs no report and must not offer to open it elsewhere.
 */
export function isSameDocumentFragment(href: string, location: string): boolean {
  try {
    const a = new URL(href);
    const b = new URL(location);
    a.hash = '';
    b.hash = '';
    return a.href === b.href;
  } catch {
    return false;
  }
}

export function installLinkReporter(win: Window, send: (channel: typeof DeckToMain.link, payload: LinkClick) => void): void {
  listen(
    win,
    'click',
    (e) => {
      if (!e.isTrusted || e.button !== 0) return;
      for (const t of e.composedPath()) {
        const el = t as Element;
        if (!el || el.nodeType !== 1) continue;
        const href = linkHref(el, win.document.baseURI);
        if (href === null) continue;
        if (/^javascript:/i.test(href) || isSameDocumentFragment(href, win.location.href)) return;
        send(DeckToMain.link, { href });
        return;
      }
    },
    true,
  );
}
