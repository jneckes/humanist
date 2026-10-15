// Pure geometry for the ink layer (6.4): stroke simplification, shape snapping, SVG path data in page
// coordinates (Mark.path), point-in-polygon for hit-testing (9.3). No DOM, so it is unit-tested directly.

export type Pt = readonly [number, number];

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Bounding box of points. */
export function bbox(pts: readonly Pt[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** Total length of a polyline. */
export function pathLength(pts: readonly Pt[]): number {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += dist(pts[i - 1], pts[i]);
  return n;
}

/** Area centroid of a polygon (falls back to the mean of the points for a degenerate one). */
export function centroid(pts: readonly Pt[]): Pt {
  if (pts.length === 0) return [0, 0];
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    const f = x0 * y1 - x1 * y0;
    a += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-6) {
    let sx = 0;
    let sy = 0;
    for (const [x, y] of pts) {
      sx += x;
      sy += y;
    }
    return [sx / pts.length, sy / pts.length];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

/** Even-odd ray casting: is the point inside the (implicitly closed) polygon? */
export function pointInPolygon(p: Pt, poly: readonly Pt[]): boolean {
  let inside = false;
  const [x, y] = p;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Ramer-Douglas-Peucker simplification with tolerance `eps` (px). Keeps the first and last points. */
export function simplify(pts: readonly Pt[], eps: number): Pt[] {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = -1;
    let idx = -1;
    const [ax, ay] = pts[s];
    const [bx, by] = pts[e];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let i = s + 1; i < e; i++) {
      const [px, py] = pts[i];
      let d: number;
      if (len2 === 0) d = Math.hypot(px - ax, py - ay);
      else {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > eps && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

/** Rounds to one decimal: page coordinates need no more, and the IPC limit counts path bytes. */
function r1(n: number): string {
  const v = Math.round(n * 10) / 10;
  return Object.is(v, -0) ? '0' : String(v);
}

/** Polyline as SVG path data: `M x y L x y ...`. */
export function polylinePath(pts: readonly Pt[]): string {
  if (pts.length === 0) return '';
  let d = `M${r1(pts[0][0])} ${r1(pts[0][1])}`;
  for (let i = 1; i < pts.length; i++) d += ` L${r1(pts[i][0])} ${r1(pts[i][1])}`;
  return d;
}

/** An ellipse as two SVG arcs, closed. */
export function ellipsePath(b: Box): string {
  const rx = b.w / 2;
  const ry = b.h / 2;
  const cy = b.y + ry;
  return `M${r1(b.x)} ${r1(cy)} A${r1(rx)} ${r1(ry)} 0 1 0 ${r1(b.x + b.w)} ${r1(cy)} A${r1(rx)} ${r1(ry)} 0 1 0 ${r1(b.x)} ${r1(cy)} Z`;
}

/** A rectangle path (box tool), closed. */
export function rectPath(b: Box): string {
  return `M${r1(b.x)} ${r1(b.y)} H${r1(b.x + b.w)} V${r1(b.y + b.h)} H${r1(b.x)} Z`;
}

/** A point (pin tool). `M x y` alone is valid path data. */
export function pointPath(p: Pt): string {
  return `M${r1(p[0])} ${r1(p[1])}`;
}

/** The polygon of an ellipse inside a box, for hit-testing (9.3: the box is "handled like an ellipse"). */
export function ellipsePolygon(b: Box, n = 48): Pt[] {
  const out: Pt[] = [];
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    out.push([cx + (b.w / 2) * Math.cos(t), cy + (b.h / 2) * Math.sin(t)]);
  }
  return out;
}

export function rectPolygon(b: Box): Pt[] {
  return [
    [b.x, b.y],
    [b.x + b.w, b.y],
    [b.x + b.w, b.y + b.h],
    [b.x, b.y + b.h],
  ];
}

/**
 * 6.4: "A closed or nearly closed pen loop snaps to an ellipse." Nearly closed: the gap between the ends is
 * at most a quarter of the box diagonal, the stroke is long enough to go around (at least 1.5 diagonals,
 * which a straight or hooked line is not), and the box is at least 8 px each way.
 */
export function isNearlyClosedLoop(pts: readonly Pt[]): boolean {
  if (pts.length < 6) return false;
  const b = bbox(pts);
  if (b.w < 8 || b.h < 8) return false;
  const diag = Math.hypot(b.w, b.h);
  const gap = dist(pts[0], pts[pts.length - 1]);
  return gap <= diag * 0.25 && pathLength(pts) >= diag * 1.5;
}

/**
 * Simplifies until the path data fits `maxBytes` (main refuses a mark path over 16 KB, 9.1). Path data is
 * ASCII, so its length is its byte count.
 */
export function fitPolyline(pts: readonly Pt[], maxBytes: number): { pts: Pt[]; d: string } {
  let eps = 0.6;
  let cur = simplify(pts, eps);
  let d = polylinePath(cur);
  while (d.length > maxBytes && eps < 1e4) {
    eps *= 2;
    cur = simplify(pts, eps);
    d = polylinePath(cur);
  }
  return { pts: cur, d };
}

/** Parses the path data this module writes (`M`, `L`, `H`, `V`, `A`, `Z`) back into its vertex points. */
export function parsePolyline(d: string): Pt[] | null {
  // Numbers first, so an exponent's `e` is not read as a command; any other letter is an unsupported command.
  const tokens = d.match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?|[A-Za-z]/g);
  if (!tokens) return null;
  const pts: Pt[] = [];
  let i = 0;
  let x = 0;
  let y = 0;
  let cmd = '';
  const num = (): number => {
    const v = Number(tokens[i++]);
    if (!Number.isFinite(v)) throw new Error('bad number');
    return v;
  };
  try {
    while (i < tokens.length) {
      const t = tokens[i];
      if (/^[A-Za-z]$/.test(t)) {
        cmd = t;
        i++;
        if (cmd === 'Z' || cmd === 'z') continue;
      }
      switch (cmd) {
        case 'M':
        case 'L':
          x = num();
          y = num();
          pts.push([x, y]);
          break;
        case 'H':
          x = num();
          pts.push([x, y]);
          break;
        case 'V':
          y = num();
          pts.push([x, y]);
          break;
        case 'A':
          num();
          num();
          num();
          num();
          num();
          x = num();
          y = num();
          pts.push([x, y]);
          break;
        default:
          return null;
      }
    }
  } catch {
    return null;
  }
  return pts;
}

/** Circled 1, 2, ... 20, then (21), (22), ...: the mark numbers on the page and in the card (6.4). */
export function circled(n: number): string {
  if (n >= 1 && n <= 20) return String.fromCharCode(0x2460 + n - 1);
  return `(${n})`;
}

/** Arrowhead segments for an arrow from `a` to `b`, as path data. */
export function arrowHeadPath(a: Pt, b: Pt, size = 14): string {
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const l: Pt = [b[0] - size * Math.cos(ang - Math.PI / 7), b[1] - size * Math.sin(ang - Math.PI / 7)];
  const r: Pt = [b[0] - size * Math.cos(ang + Math.PI / 7), b[1] - size * Math.sin(ang + Math.PI / 7)];
  return `M${r1(l[0])} ${r1(l[1])} L${r1(b[0])} ${r1(b[1])} L${r1(r[0])} ${r1(r[1])}`;
}

/** SVG path data for a perfect-freehand outline polygon (quadratic midpoints, as its README shows). */
export function outlinePath(outline: readonly (readonly number[])[]): string {
  const n = outline.length;
  if (n < 4) return '';
  const avg = (a: number, b: number) => (a + b) / 2;
  let a = outline[0];
  let b = outline[1];
  const c = outline[2];
  let d = `M${a[0].toFixed(1)},${a[1].toFixed(1)} Q${b[0].toFixed(1)},${b[1].toFixed(1)} ${avg(b[0], c[0]).toFixed(1)},${avg(b[1], c[1]).toFixed(1)} T`;
  for (let i = 2; i < n - 1; i++) {
    a = outline[i];
    b = outline[i + 1];
    d += `${avg(a[0], b[0]).toFixed(1)},${avg(a[1], b[1]).toFixed(1)} `;
  }
  return d + 'Z';
}
