// Offset tables between a decoded (or cooked) string and the raw source slice it came from
// (9.2 Strategy 1 step 5, Strategy 2 step 4). Index i of the decoded string starts at raw offset
// toRaw(i); toRaw(length) is the raw slice's length. Atomic units (a character reference, an escape
// sequence, a CRLF pair, a template placeholder) map to several raw characters and may never be split:
// widen() grows a span until neither end falls inside one.

export interface OffsetTable {
  /** Length of the decoded/cooked string. */
  readonly length: number;
  /** Raw offset (relative to the raw slice) where decoded index i starts. toRaw(length) === raw length. */
  toRaw(i: number): number;
  /** Grows [start, end) so that neither end falls inside an atomic unit. */
  widen(start: number, end: number): { start: number; end: number };
}

/**
 * A table built unit by unit. Each unit covers `decLen` decoded characters (0 or more) and `rawLen` raw
 * characters. A unit with decLen 1 and rawLen 1 is a plain character; anything else is atomic.
 */
export class UnitTable implements OffsetTable {
  /** rawStart[i] for decoded index i, with rawStart[length] = raw length. */
  private readonly rawStart: number[] = [];
  /** unitStart[i]: true if decoded index i is the first character of its unit (or i === length). */
  private readonly unitStart: boolean[] = [];
  private rawPos = 0;
  private done = false;

  /** Appends a unit: decLen decoded characters produced from rawLen raw characters. */
  push(decLen: number, rawLen: number): void {
    if (this.done) throw new Error('UnitTable is finished');
    if (decLen === 0) {
      // A unit that decodes to nothing (a line continuation, a dropped character) is folded into the
      // next unit's raw range: the next decoded character starts after it, and the gap stays atomic
      // with that character so a splice never separates them.
      this.pendingSkip += rawLen;
      this.rawPos += rawLen;
      return;
    }
    const start = this.rawPos - this.pendingSkip;
    for (let k = 0; k < decLen; k++) {
      this.rawStart.push(k === 0 ? start : this.rawPos + rawLen);
      this.unitStart.push(k === 0);
    }
    this.pendingSkip = 0;
    this.rawPos += rawLen;
  }

  private pendingSkip = 0;

  /** Closes the table. Trailing raw characters that decode to nothing belong to the end position. */
  finish(): this {
    this.rawStart.push(this.rawPos);
    this.unitStart.push(true);
    this.done = true;
    return this;
  }

  get length(): number {
    return this.rawStart.length - 1;
  }

  /** Raw length of the slice the table was built over. */
  get rawLength(): number {
    return this.rawStart[this.rawStart.length - 1];
  }

  toRaw(i: number): number {
    if (!this.done) throw new Error('UnitTable is not finished');
    if (i < 0 || i > this.length) throw new RangeError(`offset ${i} outside 0..${this.length}`);
    // Inside a multi-character unit (e.g. a reference that decodes to two code units), every index but
    // the first points at the unit's end. Callers must widen() first; toRaw of an interior index is
    // only meaningful as "after this unit".
    return this.rawStart[i];
  }

  isUnitBoundary(i: number): boolean {
    return this.unitStart[i] === true;
  }

  widen(start: number, end: number): { start: number; end: number } {
    if (!this.done) throw new Error('UnitTable is not finished');
    let s = Math.max(0, Math.min(start, this.length));
    let e = Math.max(s, Math.min(end, this.length));
    while (s > 0 && !this.unitStart[s]) s--;
    while (e < this.length && !this.unitStart[e]) e++;
    return { start: s, end: e };
  }
}

/** Composes two tables: outer maps a run into its container string, inner maps that container into raw. */
export function composeTables(run: OffsetTable, runOffsetInContainer: number, container: OffsetTable): OffsetTable {
  return {
    length: run.length,
    toRaw(i: number): number {
      return container.toRaw(runOffsetInContainer + run.toRaw(i)) - container.toRaw(runOffsetInContainer);
    },
    widen(start: number, end: number) {
      // Widen in the run first, then in the container, and repeat until stable: a unit in either layer
      // may straddle a boundary of the other.
      let s = start;
      let e = end;
      for (let guard = 0; guard < 64; guard++) {
        const a = run.widen(s, e);
        const cs = runOffsetInContainer + run.toRaw(a.start);
        const ce = runOffsetInContainer + run.toRaw(a.end);
        const b = container.widen(cs, ce);
        if (b.start === cs && b.end === ce) return a;
        // Map the container widening back to run indices.
        let ns = a.start;
        let ne = a.end;
        while (ns > 0 && runOffsetInContainer + run.toRaw(ns) > b.start) ns--;
        while (ne < run.length && runOffsetInContainer + run.toRaw(ne) < b.end) ne++;
        if (ns === s && ne === e) return { start: ns, end: ne };
        s = ns;
        e = ne;
      }
      return { start: 0, end: run.length };
    },
  };
}
