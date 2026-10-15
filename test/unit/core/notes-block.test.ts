import { describe, expect, it } from 'vitest';
import { findNotesBlock, removeNotesBlock } from '@blueline/core/notes-block';

const json = (o: unknown) => JSON.stringify(o).replace(/</g, '\\u003C');
const block = (body = '{"format":"blueline-notes","version":1}') =>
  `<script type="application/vnd.blueline+json" id="blueline-notes" data-version="1">${body}</script>`;

function expectBlock(src: string, b: string): void {
  const nb = findNotesBlock(src);
  expect(nb).not.toBeNull();
  expect(src.slice(nb!.start, nb!.end)).toBe(b);
}

describe('findNotesBlock', () => {
  it('finds the block that is the last element in <body>', () => {
    const b = block();
    expectBlock(`<!doctype html><html><body><p>x</p>\n${b}\n</body></html>\n`, b);
    expectBlock(`<body><p>x</p>${b}</body>`, b);
  });

  it('finds it at the end of a file with no </body>', () => {
    const b = block();
    expectBlock(`<p>deck</p>\n${b}`, b);
    expectBlock(`<p>deck</p>\n${b}\n\n`, b);
  });

  it('allows comments and whitespace after </body>', () => {
    const b = block();
    expectBlock(`<body><p>x</p>${b}</body>\n<!-- c -->\n</html>\n<!-- after -->`, b);
  });

  it('counts the BOM in its offsets', () => {
    const b = block();
    const src = `\uFEFF<p>é</p>${b}`;
    const nb = findNotesBlock(src)!;
    expect(nb.start).toBe(9); // BOM + "<p>é</p>"
    expect(src.slice(nb.start, nb.end)).toBe(b);
  });

  it('reads notes with \\u003C escapes, including </script and <!-- in note text', () => {
    const b = block(json({ notes: [{ text: '</script><!-- <script> -->' }], u: '\u2028\u2029' }));
    expect(b).not.toContain('</script><');
    expectBlock(`<body><p>x</p>${b}</body>`, b);
  });

  it('is page content when followed by more content', () => {
    expect(findNotesBlock(`<body>${block()}<p>after</p></body>`)).toBeNull();
    expect(findNotesBlock(`<body>${block()}after</body>`)).toBeNull();
    expect(findNotesBlock(`<body>${block()}<!-- c --></body>`)).toBeNull();
    // Text after </body> is still body content.
    expect(findNotesBlock(`<body>${block()}</body>tail`)).toBeNull();
    expect(findNotesBlock(`<body>${block()}</body></html><p>late</p>`)).toBeNull();
  });

  it('is page content inside a <template> or nested in another element', () => {
    expect(findNotesBlock(`<body><template>${block()}</template></body>`)).toBeNull();
    expect(findNotesBlock(`<body><div>${block()}</div></body>`)).toBeNull();
    expect(findNotesBlock(`<head>${block()}</head><body></body>`)).toBeNull();
  });

  it('needs the exact type and id, and a closing tag', () => {
    expect(findNotesBlock(`<body><script type="application/json" id="blueline-notes">{}</script>`)).toBeNull();
    expect(findNotesBlock(`<body><script type="application/vnd.blueline+json" id="notes">{}</script>`)).toBeNull();
    expect(findNotesBlock(`<body><script type="application/vnd.blueline+json">{}</script>`)).toBeNull();
    expect(findNotesBlock(`<body><script type="application/vnd.blueline+json" id="blueline-notes">{"a":1}`)).toBeNull();
    expect(findNotesBlock('<frameset></frameset>')).toBeNull();
  });

  it('is not fooled by an unescaped </script> in the JSON', () => {
    const bad = `<script type="application/vnd.blueline+json" id="blueline-notes">{"t":"</script><p>x</p>"}</script>`;
    expect(findNotesBlock(`<body>${bad}</body>`)).toBeNull();
  });

  it('is not fooled by text that only looks like a block', () => {
    expect(findNotesBlock(`<body><!-- ${block()} --></body>`)).toBeNull();
    expect(findNotesBlock(`<body><textarea>${block()}</textarea></body>`)).toBeNull();
  });
});

describe('removeNotesBlock', () => {
  it('removes exactly the element and nothing else', () => {
    const src = `<body>\n<p>x</p>\n${block()}\n</body>\n`;
    expect(removeNotesBlock(src)).toBe('<body>\n<p>x</p>\n\n</body>\n');
  });

  it('leaves a file without a block unchanged', () => {
    const src = `<body>${block()}<p>after</p></body>`;
    expect(removeNotesBlock(src)).toBe(src);
  });
});
