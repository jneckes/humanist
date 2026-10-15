// Notes in the deck view, Phase 0 (6.4, 6.5): turns marks into NoteOps, keeps the open card in step with
// main, and draws every note's marks. Main assigns ids, authors, timestamps and statuses (ipc.ts NoteOp);
// this side only proposes `create`, `update` (text and the full mark list) and `close`.

import type { DeckToMain as DeckToMainT, NoteOp, NoteOpMark, NotesUpdate } from '@blueline/core/ipc';
import type { Note, Status } from '@blueline/core/types';
import { NoteCard } from './card';
import type { DrawnMark, InkLayer, InkMark } from './ink';
import { describeTarget, elementAt, nearestHeading, targetsInPolygon, clip } from './targets';

/** 6.5: card text is saved on every input, debounced by 300 ms. */
export const SAVE_DEBOUNCE_MS = 300;
/** A create main never answered (refused by validation) is given up after this long. */
const CREATE_TIMEOUT_MS = 15000;

const NOTE_ID = /^(?:[a-z0-9-]{1,40}:)?n-[0-9]{4,6}$/;
const STAMP = /^bl-[0-9]{1,9}$/;
const ROLE = /^[a-z-]{1,32}$/;

export interface NotesDeps {
  send(channel: (typeof DeckToMainT)['note'], op: NoteOp): void;
  userName(): string;
  /** Current slide index for NoteOp create (null when no slide engine was detected). */
  currentSlide(): number | null;
  /** Current slide title for the card header. */
  slideLabel(): string | null;
  /** A note's slide index, to draw only the current slide's ink (null: always). */
  inkFilter(note: Note): boolean;
  diag?(event: 'card-input' | 'mark-added', data: Record<string, string | number | boolean | null>): void;
  onCardChange?(open: boolean): void;
}

/** The note the open card edits. `id` is null until main answers the create. */
interface Session {
  clientId: string;
  id: string | null;
  text: string;
  sentText: string;
  marks: NoteOpMark[];
  sentMarks: number;
  header: string;
  createdAt: number;
  closing: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

function randomId(): string {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  let s = 'c';
  for (const b of a) s += (b % 36).toString(36);
  return s;
}

export class NotesController {
  private notes = new Map<string, Note>();
  private order: string[] = [];
  /** Sessions by clientId: the open one, plus closed ones still waiting for their id. */
  private sessions = new Map<string, Session>();
  private open: Session | null = null;

  constructor(
    private readonly doc: Document,
    private readonly win: Window,
    private readonly host: Element,
    private readonly card: NoteCard,
    private readonly ink: InkLayer,
    private readonly deps: NotesDeps,
  ) {}

  get cardOpen(): boolean {
    return this.open !== null && this.card.isOpen;
  }

  // ----------------------------------------------------------------------------------------------- from main

  /** MainToDeck.notes (or the notes in init): a NotesUpdate, or a bare Note[]. */
  setNotes(payload: unknown): void {
    let list: unknown;
    let created: unknown = undefined;
    if (Array.isArray(payload)) list = payload;
    else if (payload && typeof payload === 'object') {
      list = (payload as NotesUpdate).notes;
      created = (payload as NotesUpdate).created;
    }
    if (!Array.isArray(list)) return;
    const next = new Map<string, Note>();
    const order: string[] = [];
    for (const n of list) {
      if (!n || typeof n !== 'object' || typeof (n as Note).id !== 'string' || !NOTE_ID.test((n as Note).id)) continue;
      next.set((n as Note).id, n as Note);
      order.push((n as Note).id);
    }
    const known = new Set(this.notes.keys());
    this.notes = next;
    this.order = order;
    if (Array.isArray(created)) {
      for (const c of created) {
        if (c && typeof c.clientId === 'string' && typeof c.id === 'string' && NOTE_ID.test(c.id)) this.bind(c.clientId, c.id);
      }
    }
    // Fallback for a bare Note[]: a new note whose first mark's path is the one this view created.
    for (const s of this.sessions.values()) {
      if (s.id || s.marks.length === 0) continue;
      for (const id of order) {
        if (known.has(id)) continue;
        const n = next.get(id)!;
        if (n.marks?.[0]?.path === s.marks[0].path) {
          this.bind(s.clientId, id);
          break;
        }
      }
    }
    // The open note was deleted elsewhere: close the card without sending anything.
    if (this.open?.id && !this.notes.has(this.open.id)) {
      this.dropSession(this.open);
      this.open = null;
      this.card.close();
      this.deps.onCardChange?.(false);
    }
    if (this.open) this.card.update(this.view(this.open));
    this.redraw();
  }

  private bind(clientId: string, id: string): void {
    const s = this.sessions.get(clientId);
    if (!s || s.id) return;
    s.id = id;
    // Flush what happened while the create was in flight: text, later marks, a close.
    this.flush(s);
    if (s.closing) this.finishClose(s);
  }

  // ----------------------------------------------------------------------------------------------- marks

  /** A finished stroke (ink layer). Joins the open note unless Shift began it; else creates a note. */
  addMark(m: DrawnMark): void {
    const opMark: NoteOpMark = { tool: m.tool, path: m.path, targets: this.targetsFor(m) };
    if (m.shape) opMark.shape = m.shape;
    let s = this.open;
    if (!s || m.separate) {
      if (s) this.closeCard();
      s = this.newSession(this.headerFor(opMark));
      s.marks.push(opMark);
      this.sendCreate(s);
      this.open = s;
      this.card.open(this.view(s), m.box, true);
      this.deps.onCardChange?.(true);
    } else {
      s.marks.push(opMark);
      this.flush(s);
      this.card.update(this.view(s));
      // Keep the caret in the card (6.4): the ink layer prevented the pointer's default, so focus never left.
    }
    this.deps.diag?.('mark-added', { noteId: s.id, n: s.marks.length });
    this.redraw();
  }

  private targetsFor(m: DrawnMark): NoteOpMark['targets'] {
    let els: Element[] = [];
    if (m.point) {
      const el = elementAt(this.doc, m.point[0], m.point[1], this.host);
      if (el) els = [el];
    } else if (m.ends) {
      // 9.3 Arrow: the element at the tail and the element at the head.
      const tail = elementAt(this.doc, m.ends[0][0], m.ends[0][1], this.host);
      const head = elementAt(this.doc, m.ends[1][0], m.ends[1][1], this.host);
      els = [tail, head].filter((e): e is Element => !!e);
    } else if (m.polygon) {
      els = targetsInPolygon(this.doc, this.win, m.polygon, this.host);
    }
    return els.map(describeTarget);
  }

  /**
   * N (6.2): a new note on the current text selection or the hovered element. Phase 0 anchors it with a pin
   * mark at the selection (or element) center; the TextQuoteSelector target without a mark is Phase 3.
   */
  newNoteAt(hovered: Element | null): void {
    const sel = this.win.getSelection();
    let rect: DOMRect | null = null;
    let el: Element | null = null;
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      const r = sel.getRangeAt(0);
      const anc = r.commonAncestorContainer;
      const ancEl = anc.nodeType === 1 ? (anc as Element) : anc.parentElement;
      if (ancEl && !this.host.contains(ancEl)) {
        rect = r.getBoundingClientRect();
        el = ancEl;
      }
    }
    if (!el && hovered && hovered !== this.host && hovered.isConnected) {
      el = hovered;
      rect = hovered.getBoundingClientRect();
    }
    if (!rect || !(rect.width > 0 || rect.height > 0)) {
      const x = this.win.innerWidth / 2;
      const y = this.win.innerHeight / 2;
      el = elementAt(this.doc, x, y, this.host);
      rect = new DOMRect(x, y, 0, 0);
    }
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + Math.min(rect.height / 2, 24);
    const mark: DrawnMark = {
      tool: 'pin',
      path: `M${Math.round((cx + this.win.scrollX) * 10) / 10} ${Math.round((cy + this.win.scrollY) * 10) / 10}`,
      polygon: null,
      ends: null,
      point: [cx, cy],
      box: { x: rect.left, y: rect.top, w: rect.width, h: rect.height },
      separate: true,
    };
    if (el) {
      // The selection's element is the target, not whatever lies under the pin's center.
      const opMark: NoteOpMark = { tool: 'pin', path: mark.path, targets: [describeTarget(el)] };
      if (this.open) this.closeCard();
      const s = this.newSession(this.headerFor(opMark));
      s.marks.push(opMark);
      this.sendCreate(s);
      this.open = s;
      this.card.open(this.view(s), mark.box, true);
      this.deps.onCardChange?.(true);
      this.deps.diag?.('mark-added', { noteId: null, n: 1 });
      this.redraw();
    } else this.addMark(mark);
  }

  // ----------------------------------------------------------------------------------------------- card

  /** Card input (every keystroke, paste or dictation). */
  onInput(text: string): void {
    const s = this.open;
    if (!s) return;
    s.text = text;
    this.deps.diag?.('card-input', { length: text.length, value: text });
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      s.timer = null;
      this.flush(s);
    }, SAVE_DEBOUNCE_MS);
  }

  /** Closes the open card (Esc, Cmd+Enter, mode change, main's closeCard): saves now, then `close` (6.4). */
  closeCard(): void {
    const s = this.open;
    if (!s) {
      this.card.close();
      return;
    }
    this.open = null;
    this.card.close();
    this.deps.onCardChange?.(false);
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    s.closing = true;
    if (s.id) this.finishClose(s);
    // else: bind() finishes the close once main answers the create.
  }

  private finishClose(s: Session): void {
    this.flush(s);
    // Main decides: draft -> open, or deleted when empty with no marks (6.4, 6.6).
    if (s.id) this.deps.send('bl:deck:note', { op: 'close', id: s.id });
    this.dropSession(s);
  }

  private dropSession(s: Session): void {
    if (s.timer) clearTimeout(s.timer);
    this.sessions.delete(s.clientId);
  }

  /** Opens the card of an existing note (select tool click, J/K). */
  openNote(id: string): void {
    const note = this.notes.get(id);
    if (!note) return;
    if (this.open?.id === id) {
      this.card.focus();
      return;
    }
    if (this.open) this.closeCard();
    const s = this.newSession(this.headerForNote(note));
    s.id = id;
    s.text = typeof note.text === 'string' ? note.text : '';
    s.sentText = s.text;
    s.marks = this.opMarksOf(note);
    s.sentMarks = s.marks.length;
    this.open = s;
    const box = this.ink.boxOf(id) ?? { x: this.win.innerWidth / 2 - 160, y: 80, w: 0, h: 0 };
    this.card.open(this.view(s), box, true);
    this.deps.onCardChange?.(true);
    this.redraw();
  }

  /** J / K (6.2): the next or previous note in the deck's order, opening its card. */
  step(dir: 1 | -1): void {
    const ids = this.order.filter((id) => {
      const n = this.notes.get(id)!;
      return n.status !== 'accepted' && this.deps.inkFilter(n);
    });
    if (ids.length === 0) return;
    const cur = this.open?.id ? ids.indexOf(this.open.id) : -1;
    const next = cur < 0 ? (dir === 1 ? 0 : ids.length - 1) : (cur + dir + ids.length) % ids.length;
    this.openNote(ids[next]);
  }

  /** Hovering a mark entry in the card highlights it on the page (6.5). */
  hoverMark(n: number | null): void {
    const s = this.open;
    this.ink.setHighlight(s && n !== null ? { noteKey: s.id ?? s.clientId, n } : null);
  }

  // ----------------------------------------------------------------------------------------------- internals

  private newSession(header: string): Session {
    const s: Session = {
      clientId: randomId(),
      id: null,
      text: '',
      sentText: '',
      marks: [],
      sentMarks: 0,
      header,
      createdAt: Date.now(),
      closing: false,
      timer: null,
    };
    this.sessions.set(s.clientId, s);
    return s;
  }

  private sendCreate(s: Session): void {
    this.deps.send('bl:deck:note', { op: 'create', clientId: s.clientId, text: s.text, marks: s.marks.slice(), slide: this.deps.currentSlide() });
    s.sentText = s.text;
    s.sentMarks = s.marks.length;
    setTimeout(() => {
      if (!s.id && this.sessions.get(s.clientId) === s) {
        this.dropSession(s);
        if (this.open === s) this.card.setStatus('Not saved');
      }
    }, CREATE_TIMEOUT_MS);
  }

  /** Sends what main does not have yet: changed text and the full mark list when marks were added. */
  private flush(s: Session): void {
    if (!s.id) return;
    const op: { op: 'update'; id: string; text?: string; marks?: NoteOpMark[] } = { op: 'update', id: s.id };
    let any = false;
    if (s.text !== s.sentText) {
      op.text = s.text;
      any = true;
    }
    if (s.marks.length !== s.sentMarks) {
      op.marks = s.marks.slice();
      any = true;
    }
    if (!any) return;
    this.deps.send('bl:deck:note', op);
    s.sentText = s.text;
    s.sentMarks = s.marks.length;
  }

  /** NoteOpMarks of an existing note, rebuilt from its marks and targets (for `update` with the full list). */
  private opMarksOf(note: Note): NoteOpMark[] {
    const byRef = new Map((Array.isArray(note.targets) ? note.targets : []).map((t) => [t.ref, t]));
    const out: NoteOpMark[] = [];
    for (const m of Array.isArray(note.marks) ? note.marks : []) {
      const targets: NoteOpMark['targets'] = [];
      for (const ref of Array.isArray(m.targets) ? m.targets : []) {
        const t = byRef.get(ref);
        if (!t) continue;
        const css = t.selectors?.find((x) => x.type === 'CssSelector');
        const stamp = t.selectors?.find((x) => x.type === 'blueline:Stamp');
        targets.push({
          css: css && css.type === 'CssSelector' ? css.value.slice(0, 2000) : '',
          text: clip(typeof t.text === 'string' ? t.text : '', 300),
          role: typeof t.role === 'string' && ROLE.test(t.role) ? t.role : 'element',
          stamp: stamp && stamp.type === 'blueline:Stamp' && STAMP.test(stamp.value) ? stamp.value : null,
        });
      }
      const opm: NoteOpMark = { tool: m.tool, path: typeof m.path === 'string' ? m.path : '', targets };
      if (m.shape) opm.shape = m.shape;
      out.push(opm);
    }
    return out;
  }

  private headerFor(m: NoteOpMark): string {
    const parts: string[] = [];
    const slide = this.deps.slideLabel();
    if (slide) parts.push(slide);
    const t = m.targets[0];
    if (t) {
      const el = t.css ? this.safeQuery(t.css) : null;
      const h = el ? nearestHeading(el) : null;
      if (h) parts.push(`\u2018${h}\u2019`);
      parts.push(t.role);
    }
    return parts.join(' \u203a ') || 'Note';
  }

  private headerForNote(note: Note): string {
    const parts: string[] = [];
    const title = note.slide && typeof note.slide.title === 'string' ? note.slide.title : null;
    if (note.slide && typeof note.slide.index === 'number') parts.push(title ? `Slide ${note.slide.index + 1} \u203a ${title}` : `Slide ${note.slide.index + 1}`);
    const t = Array.isArray(note.targets) ? note.targets[0] : undefined;
    if (t) {
      if (typeof t.text === 'string' && t.text) parts.push(`\u2018${clip(t.text, 40)}\u2019`);
      if (typeof t.role === 'string') parts.push(t.role);
    }
    return parts.join(' \u203a ') || 'Note';
  }

  private safeQuery(css: string): Element | null {
    try {
      return this.doc.querySelector(css);
    } catch {
      return null;
    }
  }

  private view(s: Session) {
    const note = s.id ? this.notes.get(s.id) : undefined;
    const status: Status | 'draft' = note?.status ?? 'draft';
    return {
      header: s.header,
      author: this.deps.userName(),
      text: s.text,
      marks: s.marks.map((_, i) => i + 1),
      status: s.id ? statusLabel(status) : 'Draft \u00b7 saving\u2026',
    };
  }

  /** Draws every note's marks; the open note (and notes still waiting for an id) from local state. */
  private redraw(): void {
    const marks: InkMark[] = [];
    const local = new Map<string, Session>();
    for (const s of this.sessions.values()) local.set(s.id ?? s.clientId, s);
    for (const id of this.order) {
      if (local.has(id)) continue;
      const n = this.notes.get(id)!;
      if (n.status === 'accepted' || !this.deps.inkFilter(n)) continue;
      for (const m of Array.isArray(n.marks) ? n.marks : []) {
        if (typeof m.path !== 'string' || !m.path) continue;
        marks.push({ key: `${id}:${m.n}`, noteKey: id, n: m.n, tool: m.tool, shape: m.shape, path: m.path, done: n.status === 'done' });
      }
    }
    for (const [key, s] of local) {
      s.marks.forEach((m, i) => {
        if (m.path) marks.push({ key: `${key}:${i + 1}`, noteKey: key, n: i + 1, tool: m.tool, shape: m.shape, path: m.path, done: false });
      });
    }
    this.ink.setMarks(marks);
  }

  /** Select tool click on a mark (6.4): its note's card opens; the open note's own mark just refocuses it. */
  openByKey(key: string): void {
    const s = this.open;
    if (s && (s.id === key || s.clientId === key)) {
      this.card.focus();
      return;
    }
    if (this.notes.has(key)) this.openNote(key);
  }

  /** Redraws the ink (the current slide changed, so the slide filter may show other notes). */
  refreshInk(): void {
    this.redraw();
  }
}

function statusLabel(s: Status | 'draft'): string {
  switch (s) {
    case 'draft':
      return 'Draft';
    case 'open':
      return 'Open';
    case 'sent':
      return 'Sent';
    case 'working':
      return 'Claude is working';
    case 'done':
      return 'Done';
    case 'question':
      return 'Question';
    case 'accepted':
      return 'Accepted';
    case 'reopened':
      return 'Reopened';
  }
}
