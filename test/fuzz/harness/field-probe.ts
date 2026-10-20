// The edit field of a walked text node, read in the render view (bundled as an IIFE by bundle.mjs and run by the
// fuzz harness in an isolated world of its own, FIELD_WORLD_ID, so the page's world never sees it). 9.2 Committing
// an edit step 1: the field is the innermost element that holds the clicked text node, and each of its text nodes
// is recorded with its run. This reports, for each locator the walk collected, that element's textContent and
// every text node in it (in tree order, with its offset in textContent and its own locator), exactly as the
// overlay would see them when the author clicks the node; main maps each node to its run with the walk's matches.
// It only reads the DOM, with the locator functions the render agent uses (@blueline/core/dom-walk).

import { makeLocator, resolveLocator } from '@blueline/core/dom-walk';
import type { NodeLocator } from '@blueline/core/ipc';

interface Part {
  start: number;
  end: number;
  data: string;
  locator: NodeLocator | null;
}

interface FieldReply {
  key: number;
  /** Null when the locator no longer names a node, the node's text is not what the walk saw, or the field is too large. */
  field: { text: string; parts: Part[] } | null;
}

const TEXT_NODE = 3;

function fieldOf(node: Text, maxChars: number): FieldReply['field'] {
  const el = node.parentElement;
  if (!el) return null;
  const parts: Part[] = [];
  let at = 0;
  // textContent is the concatenation of every descendant text node in tree order (DOM Standard), so the offsets
  // below index it exactly.
  const walker = document.createTreeWalker(el, 0x4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType !== TEXT_NODE) continue;
    const data = (n as Text).data;
    if (at + data.length > maxChars) return null;
    parts.push({ start: at, end: at + data.length, data, locator: makeLocator(n as Text) });
    at += data.length;
  }
  const text = el.textContent ?? '';
  return text.length === at ? { text, parts } : null;
}

const api = {
  fields(reqs: { key: number; locator: NodeLocator; data: string }[], maxChars: number): FieldReply[] {
    return reqs.map((r) => {
      const node = resolveLocator(document, r.locator);
      if (!node || node.data !== r.data) return { key: r.key, field: null };
      return { key: r.key, field: fieldOf(node, maxChars) };
    });
  },
};

(globalThis as unknown as { __blFuzzField: typeof api }).__blFuzzField = api;
