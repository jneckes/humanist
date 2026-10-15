import { describe, expect, it } from 'vitest';
import {
  bbox,
  centroid,
  circled,
  ellipsePath,
  fitPolyline,
  isNearlyClosedLoop,
  parsePolyline,
  pointInPolygon,
  polylinePath,
  rectPath,
  simplify,
  type Pt,
} from '../../../packages/app/src/preload/geometry';

/** The SVG path check main applies to Mark.path (ipc-guard). */
const SVG_PATH = /^[MmZzLlHhVvCcSsQqTtAa0-9eE.,+\- \t\r\n]*$/;

const loop = (cx: number, cy: number, rx: number, ry: number, turn = 0.95, n = 40): Pt[] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const t = (i / n) * Math.PI * 2 * turn;
    return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)] as Pt;
  });

describe('ink geometry (6.4)', () => {
  it('snaps a nearly closed loop to an ellipse, not a line or a hook', () => {
    expect(isNearlyClosedLoop(loop(100, 100, 80, 40))).toBe(true);
    expect(isNearlyClosedLoop(loop(100, 100, 80, 40, 0.6))).toBe(false);
    const line: Pt[] = Array.from({ length: 20 }, (_, i) => [i * 10, 50] as Pt);
    expect(isNearlyClosedLoop(line)).toBe(false);
    expect(isNearlyClosedLoop(loop(10, 10, 2, 2))).toBe(false);
  });

  it('writes path data main accepts, in page coordinates rounded to 0.1', () => {
    const d = polylinePath([
      [1.234, 5.678],
      [-0.04, 10],
    ]);
    expect(d).toBe('M1.2 5.7 L0 10');
    expect(SVG_PATH.test(d)).toBe(true);
    expect(SVG_PATH.test(ellipsePath({ x: 10, y: 20, w: 100, h: 50 }))).toBe(true);
    expect(SVG_PATH.test(rectPath({ x: 10, y: 20, w: 100, h: 50 }))).toBe(true);
  });

  it('parses its own paths back to vertices', () => {
    expect(parsePolyline('M1 2 L3 4 L5 6')).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    expect(parsePolyline(rectPath({ x: 0, y: 0, w: 10, h: 5 }))).toEqual([
      [0, 0],
      [10, 0],
      [10, 5],
      [0, 5],
    ]);
    const e = parsePolyline(ellipsePath({ x: 0, y: 0, w: 10, h: 4 }))!;
    expect(bbox(e)).toEqual({ x: 0, y: 2, w: 10, h: 0 });
    expect(parsePolyline('M1 2 C 3 4 5 6 7 8')).toBeNull();
  });

  it('keeps a long stroke under the 16 KB mark path limit', () => {
    const pts: Pt[] = Array.from({ length: 20000 }, (_, i) => [i * 0.37, Math.sin(i / 7) * 300 + 400] as Pt);
    const { d, pts: kept } = fitPolyline(pts, 15000);
    expect(d.length).toBeLessThanOrEqual(15000);
    expect(kept[0]).toEqual(pts[0]);
    expect(kept[kept.length - 1]).toEqual(pts[pts.length - 1]);
  });

  it('simplify keeps the ends and drops collinear points', () => {
    const pts: Pt[] = [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
    ];
    expect(simplify(pts, 0.5)).toEqual([
      [0, 0],
      [3, 0],
    ]);
  });

  it('point in polygon and centroid', () => {
    const sq: Pt[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    expect(pointInPolygon([5, 5], sq)).toBe(true);
    expect(pointInPolygon([15, 5], sq)).toBe(false);
    expect(centroid(sq)).toEqual([5, 5]);
    const deg: Pt[] = [
      [0, 0],
      [10, 0],
    ];
    expect(centroid(deg)).toEqual([5, 0]);
  });

  it('numbers marks ① ② … ⑳ then (21)', () => {
    expect(circled(1)).toBe('①');
    expect(circled(2)).toBe('②');
    expect(circled(20)).toBe('⑳');
    expect(circled(21)).toBe('(21)');
  });
});
