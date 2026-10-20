// The ambiguity picker (6.3 "Dashed: ambiguous. On click, a picker shows each candidate with ±40 characters of
// context, and warns when the text is also used as a key"; 9.2 Strategy 2 step 3; P2-8). The deck asks main for
// the candidates of the clicked node (EditCandidatesRequest): main builds them from the DeckMap of the field's
// version, which holds the source the ClientMap lacks (offsets, lines, context, the key's line), and never offers
// `split` or `short` matches. The picker lists them in the overlay; the author picks one with the mouse, the
// arrow keys and Enter, or a digit; Esc closes it.
//
// The model (validation, selection) is pure and unit-tested; PickerView builds the panel with createElement and
// textContent only (9.1 Preload), in the overlay's closed shadow root.

import { EDIT_LIMITS, RUN_ID_RE, type EditCandidatesReply, type PickerCandidate } from '@blueline/core/ipc-edit';
import { pickKindFor } from '@blueline/core/edit-commit';
import type { EditPick, MatchReason, MatchResult } from '@blueline/core/types';

/** Most candidates the panel lists (EDIT_LIMITS.candidates; the matcher's MAX_SEARCH_CANDIDATES). */
export const PICKER_MAX = EDIT_LIMITS.candidates;

/**
 * Whether an ambiguous match can be offered in the picker (P2-8): its reason maps to a pick kind (`split`,
 * `short` and the `none` reasons do not), and it has candidates.
 */
export function pickable(m: MatchResult): EditPick['kind'] | null {
  if (m.confidence !== 'ambiguous' || m.candidates.length === 0) return null;
  return pickKindFor(m.reason as MatchReason | undefined);
}

function isWellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (!(d >= 0xdc00 && d <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

function okText(v: unknown, maxUnits: number): v is string {
  return typeof v === 'string' && v.length <= maxUnits && isWellFormed(v);
}

/**
 * The candidates of main's reply for the request `fieldId` asked about, rebuilt field by field: only runs the
 * request named, each once, in main's order, with a line, a context and an optional key warning of bounded size.
 * Main is trusted, but the panel never shows more than it asked for. null when the reply is for another request.
 */
export function pickerItems(reply: unknown, fieldId: number, requested: ReadonlySet<string>): PickerCandidate[] | null {
  if (!reply || typeof reply !== 'object') return null;
  const r = reply as Partial<EditCandidatesReply>;
  if (r.fieldId !== fieldId || !Array.isArray(r.candidates)) return null;
  const out: PickerCandidate[] = [];
  const seen = new Set<string>();
  for (const c of r.candidates.slice(0, PICKER_MAX)) {
    if (!c || typeof c !== 'object') continue;
    const { runId, line, context, keyWarning } = c as PickerCandidate;
    if (typeof runId !== 'string' || !RUN_ID_RE.test(runId) || !requested.has(runId) || seen.has(runId)) continue;
    if (!Number.isInteger(line) || line < 1) continue;
    if (!okText(context, EDIT_LIMITS.context)) continue;
    const item: PickerCandidate = { runId, line, context };
    if (keyWarning !== undefined) {
      if (!okText(keyWarning, EDIT_LIMITS.why)) continue;
      item.keyWarning = keyWarning;
    }
    seen.add(runId);
    out.push(item);
  }
  return out;
}

/** The picker's state: the listed candidates and the highlighted one. */
export class PickerModel {
  private at = 0;

  constructor(readonly items: readonly PickerCandidate[]) {}

  get index(): number {
    return this.at;
  }

  /** Moves the highlight by `d`, wrapping around. */
  move(d: number): void {
    const n = this.items.length;
    if (n === 0) return;
    this.at = (((this.at + d) % n) + n) % n;
  }

  /** Highlights item `i` (a hovered row). */
  set(i: number): void {
    if (Number.isInteger(i) && i >= 0 && i < this.items.length) this.at = i;
  }

  /** The highlighted item, or item `n` (0-based) when given; null when there is none. */
  choose(n?: number): PickerCandidate | null {
    const i = n === undefined ? this.at : n;
    return Number.isInteger(i) && i >= 0 && i < this.items.length ? this.items[i] : null;
  }
}

/** One line of the panel for a candidate: where it is in the file. */
export function candidateLabel(fileName: string, c: PickerCandidate): string {
  return `${fileName}:${c.line}`;
}

// ------------------------------------------------------------------------------------------- the panel

/** What a click on the panel asks for. */
export type PickerHit = { kind: 'choose'; index: number } | { kind: 'cancel' } | { kind: 'panel' };

/**
 * The panel in the overlay (class `picker chrome`). Rows are buttons with data-index; the controller hit-tests a
 * click at window capture (PickerView.hit) so the page never sees it, and drives the keys through the key router.
 */
export class PickerView {
  readonly el: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly hint: HTMLDivElement;

  constructor(
    private readonly doc: Document,
    container: HTMLElement,
  ) {
    const d = doc;
    this.el = d.createElement('div');
    this.el.className = 'picker chrome';
    this.el.hidden = true;
    this.el.setAttribute('role', 'listbox');
    this.el.setAttribute('aria-label', 'Choose the place to edit');
    this.title = d.createElement('div');
    this.title.className = 'picker-title';
    this.list = d.createElement('div');
    this.list.className = 'picker-list';
    this.hint = d.createElement('div');
    this.hint.className = 'picker-hint';
    this.hint.textContent = '\u2191 \u2193 to choose \u00b7 Enter to edit \u00b7 Esc to close';
    const close = d.createElement('button');
    close.className = 'picker-close';
    close.type = 'button';
    close.dataset.action = 'cancel';
    close.textContent = '\u00d7';
    close.setAttribute('aria-label', 'Close');
    this.el.append(close, this.title, this.list, this.hint);
    container.append(this.el);
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  /** "Finding where this text comes from…" while main answers. */
  loading(anchor: { x: number; y: number; w: number; h: number }): void {
    this.title.textContent = 'This text appears in more than one place. Finding them\u2026';
    this.list.replaceChildren();
    this.el.hidden = false;
    this.place(anchor);
  }

  show(anchor: { x: number; y: number; w: number; h: number }, fileName: string, model: PickerModel): void {
    const d = this.doc;
    this.title.textContent = 'This text appears in more than one place. Which one do you mean?';
    const rows: HTMLElement[] = [];
    model.items.forEach((c, i) => {
      const row = d.createElement('button');
      row.type = 'button';
      row.className = 'picker-row';
      row.dataset.index = String(i);
      row.setAttribute('role', 'option');
      const where = d.createElement('span');
      where.className = 'picker-where';
      where.textContent = (i < 9 ? `${i + 1}  ` : '') + candidateLabel(fileName, c);
      const ctx = d.createElement('span');
      ctx.className = 'picker-context';
      ctx.textContent = c.context;
      row.append(where, ctx);
      if (c.keyWarning) {
        const w = d.createElement('span');
        w.className = 'picker-warning';
        w.textContent = c.keyWarning;
        row.append(w);
      }
      rows.push(row);
    });
    this.list.replaceChildren(...rows);
    this.el.hidden = false;
    this.highlight(model.index);
    this.place(anchor);
  }

  highlight(i: number): void {
    const rows = this.list.children;
    for (let k = 0; k < rows.length; k++) {
      const on = k === i;
      rows[k].classList.toggle('on', on);
      rows[k].setAttribute('aria-selected', on ? 'true' : 'false');
      if (on) {
        // Scroll the list only (scrollIntoView could scroll the page under the fixed overlay). The list is
        // position: relative, so it is the row's offsetParent.
        const row = rows[k] as HTMLElement;
        const list = this.list;
        if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
        else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
      }
    }
  }

  hide(): void {
    this.el.hidden = true;
    this.list.replaceChildren();
  }

  /** What the overlay element `t` (from the shadow root's elementFromPoint) is in the panel, or null. */
  hit(t: Element | null): PickerHit | null {
    if (!t || !this.open || !this.el.contains(t)) return null;
    for (let e: Element | null = t; e && e !== this.el; e = e.parentElement) {
      const h = e as HTMLElement;
      if (h.dataset?.action === 'cancel') return { kind: 'cancel' };
      if (h.dataset?.index !== undefined) {
        const i = Number(h.dataset.index);
        if (Number.isInteger(i)) return { kind: 'choose', index: i };
      }
    }
    return { kind: 'panel' };
  }

  /** Next to the clicked text: below it, else above, kept inside the view. */
  private place(anchor: { x: number; y: number; w: number; h: number }): void {
    const win = this.doc.defaultView;
    const vw = win?.innerWidth ?? 1600;
    const vh = win?.innerHeight ?? 900;
    const w = Math.min(460, vw - 16);
    const h = this.el.offsetHeight || 200;
    let x = anchor.x;
    let y = anchor.y + anchor.h + 8;
    if (y + h > vh - 8) y = anchor.y - 8 - h;
    x = Math.max(8, Math.min(x, vw - w - 8));
    y = Math.max(8, Math.min(y, vh - h - 8));
    this.el.style.setProperty('left', `${Math.round(x)}px`);
    this.el.style.setProperty('top', `${Math.round(y)}px`);
    this.el.style.setProperty('width', `${Math.round(w)}px`);
  }
}
