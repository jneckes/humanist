// The notes block (section 8, "Notes inside the file"): one inert
// <script type="application/vnd.blueline+json" id="blueline-notes"> element, read as notes only when it is
// the last element in <body> with nothing but whitespace-only text after it. Any other element of that
// type (inside a <template>, followed by more content, nested deeper) is page content: served and mapped
// as it is, and never read as notes. Finding it needs a real parse (parse5), never a text search.

import { parse, type DefaultTreeAdapterTypes } from 'parse5';
import { isWhitespaceOnly } from './text';

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

export const NOTES_BLOCK_TYPE = 'application/vnd.blueline+json';
export const NOTES_BLOCK_ID = 'blueline-notes';

const HTML_NS = 'http://www.w3.org/1999/xhtml';

function isElement(n: Node): n is Element {
  return 'tagName' in n;
}

function child(parent: { childNodes: Node[] }, tagName: string): Element | null {
  for (const n of parent.childNodes) if (isElement(n) && n.tagName === tagName && n.namespaceURI === HTML_NS) return n;
  return null;
}

function attr(el: Element, name: string): string | null {
  for (const a of el.attrs) if (a.name === name && !a.namespace) return a.value;
  return null;
}

/**
 * The source range of the notes block's `<script …>…</script>` element (start of `<script` to the end of
 * `</script>`), or null. Offsets are UTF-16 indices into src (9.2 rule 2); a BOM is skipped for parse5
 * and counted back in (9.2 rule 3).
 */
export function findNotesBlock(src: string): { start: number; end: number } | null {
  const base = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  return findNotesBlockIn(parse(base ? src.slice(1) : src, { sourceCodeLocationInfo: true }), base);
}

/**
 * The same, from a parse5 document already parsed with location info from src.slice(base). The mapper
 * uses it to find the block in its own parse.
 */
export function findNotesBlockIn(doc: DefaultTreeAdapterTypes.Document, base: number): { start: number; end: number } | null {
  const html = child(doc, 'html');
  const body = html && child(html, 'body');
  if (!body) return null; // a <frameset> document has no body, so no notes
  // Last element child of <body>, with only whitespace-only text after it. A comment or any other node
  // after it means it is not last, so it is page content (section 8, Ignored for mapping).
  let last: Element | null = null;
  for (let k = body.childNodes.length - 1; k >= 0; k--) {
    const n = body.childNodes[k];
    if (isElement(n)) {
      last = n;
      break;
    }
    if (n.nodeName === '#text' && isWhitespaceOnly((n as DefaultTreeAdapterTypes.TextNode).value)) continue;
    return null;
  }
  if (!last || last.tagName !== 'script' || last.namespaceURI !== HTML_NS) return null;
  if (attr(last, 'type') !== NOTES_BLOCK_TYPE || attr(last, 'id') !== NOTES_BLOCK_ID) return null;
  const loc = last.sourceCodeLocation;
  // A block with no </script> ran to the end of the file: malformed, so it is not read as notes.
  if (!loc || !loc.startTag || !loc.endTag) return null;
  return { start: loc.startOffset + base, end: loc.endOffset + base };
}

/** src without its notes block (the clean copy, and the content that is hashed: Session.deck.sha256). */
export function removeNotesBlock(src: string): string {
  const nb = findNotesBlock(src);
  return nb ? src.slice(0, nb.start) + src.slice(nb.end) : src;
}
