import { describe, expect, it } from 'vitest';
import type { DrawToolId, Stroke, StrokePoint } from '../storage/types';
import {
  LIVE_TAIL_POINTS,
  LiveStrokePainter,
  isIncrementalStroke,
  type LiveSurface,
  type ScreenRect,
} from './liveStroke';
import { strokePath } from './strokeRender';

type Op = { op: string; args: number[] };

/** Records the commands a path receives, which is all this test can inspect. */
class RecordingPath {
  readonly ops: Op[] = [];
  moveTo(x: number, y: number): void {
    this.ops.push({ op: 'M', args: [x, y] });
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    this.ops.push({ op: 'Q', args: [cx, cy, x, y] });
  }
  closePath(): void {
    this.ops.push({ op: 'Z', args: [] });
  }
  arc(x: number, y: number, r: number, a: number, b: number): void {
    this.ops.push({ op: 'A', args: [x, y, r, a, b] });
  }
}

const makePath = (): Path2D => new RecordingPath() as unknown as Path2D;
const opsOf = (path: Path2D): Op[] => (path as unknown as RecordingPath).ops;

function points(count: number): StrokePoint[] {
  const out: StrokePoint[] = [];
  for (let i = 0; i < count; i += 1) {
    const t = i / 30;
    out.push({
      x: 120 + i * 0.7 + Math.sin(t) * 7,
      y: 200 + Math.cos(t * 1.3) * 11 + Math.sin(t * 0.4) * 18,
      pressure: 0.45 + 0.3 * Math.sin(t * 1.7),
      tiltX: 0,
      tiltY: 0,
      timestamp: i * 4,
    });
  }
  return out;
}

function strokeOf(given: StrokePoint[], tool: DrawToolId = 'fountain', opacity = 1): Stroke {
  return {
    id: `stroke-${tool}`,
    createdAt: 0,
    updatedAt: 0,
    version: 1,
    deviceId: 'test',
    deletedAt: null,
    pageId: 'page-1',
    tool,
    color: '#1e2521',
    width: tool === 'highlighter' ? 22 : 3.2,
    opacity,
    points: given,
    shape: null,
  };
}

/** Outlines of the polygons a path draws: the control points are the outline. */
function polygonOf(ops: Op[]): number[][] {
  const out: number[][] = [];
  for (const op of ops) {
    if (op.op === 'M' || op.op === 'Q' || op.op === 'A') out.push([op.args[0]!, op.args[1]!]);
  }
  return out;
}

const SUB = [
  [0.25, 0.25],
  [0.75, 0.25],
  [0.25, 0.75],
  [0.75, 0.75],
] as const;

function windingInside(poly: number[][], px: number, py: number): boolean {
  let winding = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const side = (b[0]! - a[0]!) * (py - a[1]!) - (px - a[0]!) * (b[1]! - a[1]!);
    if (a[1]! <= py) {
      if (b[1]! > py && side > 0) winding += 1;
    } else if (b[1]! <= py && side < 0) winding -= 1;
  }
  return winding !== 0;
}

function nearPolygon(poly: number[][], px: number, py: number, half: number): boolean {
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const ex = b[0]! - a[0]!;
    const ey = b[1]! - a[1]!;
    const length = ex * ex + ey * ey;
    const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - a[0]!) * ex + (py - a[1]!) * ey) / length));
    const dx = px - (a[0]! + ex * t);
    const dy = py - (a[1]! + ey * t);
    if (dx * dx + dy * dy <= half * half) return true;
  }
  return false;
}

/** Coverage of one pixel by a filled outline. */
function fillCoverage(poly: number[][], x: number, y: number): number {
  let hits = 0;
  for (const [dx, dy] of SUB) if (windingInside(poly, x + dx, y + dy)) hits += 1;
  return hits / SUB.length;
}

/** Coverage of one pixel by an outline stroked with `half` width either side. */
function edgeCoverage(poly: number[][], x: number, y: number, half: number): number {
  let hits = 0;
  for (const [dx, dy] of SUB) if (nearPolygon(poly, x + dx, y + dy, half)) hits += 1;
  return hits / SUB.length;
}

type Event = { kind: 'clear'; rect: ScreenRect } | { kind: 'paint'; poly: number[][]; edge: number };

/**
 * A stand-in for the wet canvas: it keeps, per pixel, the alpha the layer holds
 * after every clear and every paint, in the order they were issued. Paints are
 * opaque, as the engine issues them; the stroke's opacity is applied to the whole
 * layer afterwards, which is what the engine does with the canvas' own opacity.
 */
class LayerModel {
  private readonly events: Event[] = [];
  private x0 = Infinity;
  private y0 = Infinity;
  private x1 = -Infinity;
  private y1 = -Infinity;

  clear(rect: ScreenRect): void {
    this.events.push({ kind: 'clear', rect });
  }

  paint(path: Path2D, edge: number): void {
    this.events.push({ kind: 'paint', poly: polygonOf(opsOf(path)), edge });
  }

  get paints(): number {
    return this.events.filter((e) => e.kind === 'paint').length;
  }

  /** Alpha the layer holds after those events, sampled in the pixel. */
  alphaAt(x: number, y: number): number {
    let alpha = 0;
    for (const event of this.events) {
      if (event.kind === 'clear') {
        const r = event.rect;
        // Rounded inwards, exactly as the engine issues the clearRect.
        if (
          x >= Math.ceil(r.minX) &&
          x <= Math.floor(r.maxX) &&
          y >= Math.ceil(r.minY) &&
          y <= Math.floor(r.maxY)
        ) {
          alpha = 0;
        }
        continue;
      }
      const fill = fillCoverage(event.poly, x, y);
      const edge = event.edge > 0 ? edgeCoverage(event.poly, x, y, event.edge) : 0;
      // Fill, then the graphite edge over it — both opaque passes in the layer.
      let piece = fill;
      if (edge > 0) piece = piece + 0.35 * edge * (1 - piece);
      if (piece === 0) continue;
      alpha = piece + alpha * (1 - piece);
    }
    return alpha;
  }

  grow(poly: number[][]): void {
    for (const [x, y] of poly) {
      if (x! < this.x0) this.x0 = x!;
      if (y! < this.y0) this.y0 = y!;
      if (x! > this.x1) this.x1 = x!;
      if (y! > this.y1) this.y1 = y!;
    }
  }

  get box() {
    return { x0: this.x0, y0: this.y0, x1: this.x1, y1: this.y1 };
  }
}

/** Screen rect for a point range, in document units (the test views at 1:1). */
function rectFor(all: StrokePoint[]) {
  return (from: number, to: number): ScreenRect => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = from; i < to; i += 1) {
      const p = all[i]!;
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const pad = 0;
    return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
  };
}

const edgeHalf = (stroke: Stroke): number =>
  stroke.tool === 'pencil' ? Math.max(0.5, stroke.width * 0.18) / 2 : 0;

/** The box everything those points could have painted, as the engine hands it out. */
function inkBoxFor(all: StrokePoint[], width: number, tool: DrawToolId) {
  const reach = width * 0.5 + 2 + (tool === 'pencil' ? width * 0.18 : 0);
  return (from: number, to: number): ScreenRect => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = from; i < to; i += 1) {
      const p = all[i]!;
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX: minX - reach, minY: minY - reach, maxX: maxX + reach, maxY: maxY + reach };
  };
}

const TOOLS: Array<{ tool: DrawToolId; opacity: number }> = [
  { tool: 'fountain', opacity: 1 },
  { tool: 'pencil', opacity: 0.9 },
  { tool: 'highlighter', opacity: 0.35 },
];

describe('live stroke painting', () => {
  for (const { tool, opacity } of TOOLS) {
    it(`paints the ${tool} the same ink as the whole outline, frame after frame`, () => {
      const all = points(tool === 'pencil' ? 120 : 160);
      const stroke = strokeOf(all, tool, opacity);
      const layer = new LayerModel();
      const surface: LiveSurface = {
        clear: (rect) => layer.clear(rect),
        paint: (path) => layer.paint(path, edgeHalf(stroke)),
        rectOf: rectFor(all),
        inkBox: inkBoxFor(all, stroke.width, tool),
      };
      const painter = new LiveStrokePainter(makePath);

      let maxPointsPerFrame = 0;
      for (let n = 1; n <= all.length; n += 1) {
        stroke.points = all.slice(0, n);
        painter.paint(stroke, surface);
        maxPointsPerFrame = Math.max(maxPointsPerFrame, painter.pointsPerFrame);
      }

      const reference = polygonOf(opsOf(strokePath(all, stroke.tool, stroke.width, { makePath })));
      layer.grow(reference);
      const box = layer.box;
      const half = edgeHalf(stroke);
      let differing = 0;
      /** Pixels where the two disagree by more than half a pixel of ink. */
      let coarse = 0;
      let worst = 0;
      let compared = 0;
      /** Ink the committed stroke has and the wet layer lost. */
      let holes = 0;
      /** Ink the wet layer has and the committed stroke does not. */
      let excess = 0;
      for (let y = Math.floor(box.y0) - 1; y <= Math.ceil(box.y1) + 1; y += 1) {
        for (let x = Math.floor(box.x0) - 1; x <= Math.ceil(box.x1) + 1; x += 1) {
          // What the ink layer draws when the pen lifts, on the same pixels.
          const fill = fillCoverage(reference, x, y);
          const edge = half > 0 ? edgeCoverage(reference, x, y, half) : 0;
          let want = opacity * fill;
          if (edge > 0) want = want + opacity * 0.35 * edge * (1 - opacity * fill);
          const got = opacity * layer.alphaAt(x, y);
          if (want === 0 && got === 0) continue;
          compared += 1;
          const delta = Math.abs(want - got);
          if (delta > 1 / 255) differing += 1;
          if (delta > 0.5) coarse += 1;
          if (want >= 0.75 * opacity && got < 0.5 * opacity) holes += 1;
          if (want <= 0.25 * opacity && got > 0.6 * opacity) excess += 1;
          worst = Math.max(worst, delta);
        }
      }

      console.log(
        `${tool}: ${compared} ink pixels, ${differing} differ by more than one subsample (${coarse} by more than half a pixel), holes ${holes}, excess ${excess}, worst ${worst.toFixed(2)}; ${layer.paints} painted pieces, at most ${maxPointsPerFrame} points per frame`,
      );
      // Same ink: nothing the committed stroke covers is missing, nothing is
      // painted where it does not go, and what differs sits on the antialiased
      // edge of the line, where a piece of the stroke is not yet the whole stroke.
      // A frame rebuilds one window, never the whole stroke.
      expect(maxPointsPerFrame).toBeLessThanOrEqual(LIVE_TAIL_POINTS);
      // What the engine wipes when the pen lifts covers everything the wet layer
      // painted, nib included: a wide highlighter paints far outside its points.
      const painted = painter.painted!;
      let bx0 = Infinity;
      let by0 = Infinity;
      let bx1 = -Infinity;
      let by1 = -Infinity;
      for (const [px, py] of reference) {
        if (px! < bx0) bx0 = px!;
        if (py! < by0) by0 = py!;
        if (px! > bx1) bx1 = px!;
        if (py! > by1) by1 = py!;
      }
      expect(painted.minX).toBeLessThanOrEqual(bx0);
      expect(painted.minY).toBeLessThanOrEqual(by0);
      expect(painted.maxX).toBeGreaterThanOrEqual(bx1);
      expect(painted.maxY).toBeGreaterThanOrEqual(by1);
      expect(holes).toBeLessThanOrEqual(10);
      expect(excess).toBeLessThanOrEqual(90);
      expect(coarse).toBeLessThanOrEqual(40);
      expect(worst).toBeLessThanOrEqual(0.9);
    });
  }

  it('leaves the committed stroke untouched, whatever the tool', () => {
    for (const { tool, opacity } of TOOLS) {
      const all = points(240);
      const before = all.map((p) => `${p.x},${p.y},${p.pressure}`).join(' ');
      const stroke = strokeOf(all, tool, opacity);
      const surface: LiveSurface = {
        clear: () => {},
        paint: () => {},
        rectOf: rectFor(all),
        inkBox: inkBoxFor(all, stroke.width, tool),
      };
      const painter = new LiveStrokePainter(makePath);
      for (let n = 1; n <= all.length; n += 1) {
        stroke.points = all.slice(0, n);
        painter.paint(stroke, surface);
      }
      expect(stroke.points.map((p) => `${p.x},${p.y},${p.pressure}`).join(' ')).toBe(before);
      // What the ink layer draws when the pen lifts: the whole outline, exactly the
      // commands a stroke that was never previewed produces.
      const committed = JSON.stringify(opsOf(strokePath(stroke.points, stroke.tool, stroke.width, { makePath })));
      const reference = JSON.stringify(opsOf(strokePath(all, stroke.tool, stroke.width, { makePath })));
      expect(committed).toBe(reference);
    }
  });

  it('grows every freehand stroke piece by piece', () => {
    expect(isIncrementalStroke(strokeOf(points(3)))).toBe(true);
    expect(isIncrementalStroke(strokeOf(points(3), 'ballpoint'))).toBe(true);
    expect(isIncrementalStroke(strokeOf(points(3), 'pencil', 0.9))).toBe(true);
    expect(isIncrementalStroke(strokeOf(points(3), 'highlighter', 0.35))).toBe(true);
    expect(isIncrementalStroke({ ...strokeOf(points(3)), shape: 'line' })).toBe(false);
  });
});
