// NotesController and N's pin (notes.ts; SPEC 6.2 N, 6.4 "A note that is empty and has no marks is
// discarded", marks numbered ① ②; finding 18). Phase 0 anchors an N note with a pin the user never drew: the
// first stroke on the open card takes its place, so the user's marks are ① and ②, and an N note closed with
// no text is discarded (NoteOp delete). Fake DOM pieces; the targets module is stubbed.

import { describe, expect, it, vi } from 'vitest';
import type { NoteOp, NoteOpMark } from '@blueline/core/ipc';
import type { Note } from '@blueline/core/types';

vi.mock('../../../packages/app/src/preload/targets', () => ({
  describeTarget: (el: { css: string; text?: string }) => ({ css: el.css, text: el.text ?? '', role: 'heading', stamp: null }),
  elementAt: () => null,
  targetsInPolygon: (_d: unknown, _w: unknown, poly: [number, number][]) => (poly.length ? [{ css: `#stroke-${poly[0][0]}`, text: 'stroke' }] : []),
  nearestHeading: () => null,
  clip: (s: string, n: number) => s.slice(0, n),
}));

const { NotesController } = await import('../../../packages/app/src/preload/notes');
import type { DrawnMark } from '../../../packages/app/src/preload/ink';

function setup() {
  const sent: NoteOp[] = [];
  const card = { open: vi.fn(), update: vi.fn(), close: vi.fn(), focus: vi.fn(), setStatus: vi.fn(), isOpen: true };
  const ink = { setMarks: vi.fn(), boxOf: () => null, setHighlight: vi.fn() };
  const win = { getSelection: () => ({ rangeCount: 0, isCollapsed: true }), innerWidth: 1600, innerHeight: 900, scrollX: 0, scrollY: 0 };
  const doc = { querySelector: () => null };
  const host = { contains: () => false };
  const notes: Note[] = [];
  const nc = new NotesController(doc as never, win as never, host as never, card as never, ink as never, {
    send: (_ch, op) => sent.push(JSON.parse(JSON.stringify(op))),
    userName: () => 'Josh',
    currentSlide: () => null,
    slideLabel: () => null,
    inkFilter: () => true,
  });
  /** Main's answer to the last create: the note with its id. */
  const answer = () => {
    const c = [...sent].reverse().find((o) => o.op === 'create') as Extract<NoteOp, { op: 'create' }>;
    const id = `n-${String(notes.length + 1).padStart(4, '0')}`;
    notes.push({ id, status: 'draft', marks: c.marks.map((m, i) => ({ n: i + 1, tool: m.tool, path: m.path, targets: [] })), text: c.text } as unknown as Note);
    nc.setNotes({ notes, created: [{ clientId: c.clientId, id }] });
    return id;
  };
  const heading = { css: '#title', text: 'Revenue', isConnected: true, getBoundingClientRect: () => ({ left: 300, top: 180, width: 200, height: 40 }) };
  const stroke = (x: number, separate = false): DrawnMark => ({
    tool: 'pen',
    shape: 'ellipse',
    path: `M${x} 100 L${x + 40} 140`,
    polygon: [
      [x, 100],
      [x + 40, 100],
      [x + 40, 140],
    ],
    ends: null,
    point: null,
    box: { x, y: 100, w: 40, h: 40 },
    separate,
  });
  const lastMarks = (): NoteOpMark[] | undefined => {
    for (let i = sent.length - 1; i >= 0; i--) {
      const o = sent[i];
      if (o.op === 'update' && o.marks) return o.marks;
      if (o.op === 'create') return o.marks;
    }
    return undefined;
  };
  return { nc, sent, card, heading, stroke, answer, lastMarks };
}

describe('N notes and their pin (finding 18)', () => {
  it('N then two strokes: the strokes are marks 1 and 2 on one note, keeping the element N anchored to', () => {
    const { nc, sent, card, heading, stroke, answer, lastMarks } = setup();
    nc.newNoteAt(heading as never);
    expect(sent[0]).toMatchObject({ op: 'create', marks: [{ tool: 'pin', targets: [{ css: '#title' }] }] });
    answer();
    nc.addMark(stroke(600));
    nc.addMark(stroke(900));
    const marks = lastMarks()!;
    expect(marks.map((m) => m.tool)).toEqual(['pen', 'pen']);
    expect(marks[0].targets.map((t) => t.css)).toEqual(['#stroke-600', '#title']);
    expect(marks[1].targets.map((t) => t.css)).toEqual(['#stroke-900']);
    expect(card.update.mock.calls.at(-1)![0].marks).toEqual([1, 2]);
    expect(sent.filter((o) => o.op === 'create')).toHaveLength(1);
    nc.closeCard();
    expect(sent.at(-1)).toEqual({ op: 'close', id: 'n-0001' });
  });

  it('the first stroke replaces the pin even before main answered the create', () => {
    const { nc, sent, heading, stroke, answer, lastMarks } = setup();
    nc.newNoteAt(heading as never);
    nc.addMark(stroke(600));
    expect(sent.filter((o) => o.op === 'update')).toHaveLength(0); // no id yet
    answer();
    expect(lastMarks()!.map((m) => m.tool)).toEqual(['pen']);
  });

  it('N then Esc with no text: the note is deleted, not kept as an empty open note', () => {
    const { nc, sent, heading, answer } = setup();
    nc.newNoteAt(heading as never);
    const id = answer();
    nc.onInput('  ');
    nc.closeCard();
    expect(sent.at(-1)).toEqual({ op: 'delete', id });
    expect(sent.some((o) => o.op === 'close')).toBe(false);
  });

  it('N then Esc before main answered: the delete goes once the id arrives', () => {
    const { nc, sent, heading, answer } = setup();
    nc.newNoteAt(heading as never);
    nc.closeCard();
    expect(sent.map((o) => o.op)).toEqual(['create']);
    const id = answer();
    expect(sent.at(-1)).toEqual({ op: 'delete', id });
  });

  it('an N note with text keeps its pin and closes as usual', () => {
    const { nc, sent, heading, answer } = setup();
    nc.newNoteAt(heading as never);
    const id = answer();
    nc.onInput('make this bigger');
    nc.closeCard();
    expect(sent.slice(-2)).toEqual([
      { op: 'update', id, text: 'make this bigger' },
      { op: 'close', id },
    ]);
  });

  it('a stroke that starts a note is a real mark: closing it with no text sends close (main keeps it)', () => {
    const { nc, sent, stroke, answer } = setup();
    nc.addMark(stroke(600));
    const id = answer();
    nc.addMark(stroke(900));
    nc.closeCard();
    expect(sent.at(-1)).toEqual({ op: 'close', id });
    expect((sent.filter((o) => o.op === 'update').at(-1) as { marks: NoteOpMark[] }).marks).toHaveLength(2);
  });
});
