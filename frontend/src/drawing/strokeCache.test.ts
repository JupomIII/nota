import { describe, expect, it } from 'vitest';
import type { Stroke, StrokePoint } from '../storage/types';
import { boundsOfPoints } from '../lib/geometry';
import { StrokeGrid } from './spatial';
import { InkView, StrokePathCache } from './strokeCache';
import { strokePath } from './strokeRender';

/** Stands in for Path2D, which Node does not have. */
class FakePath {
  ops = 0;
  moveTo(): void {
    this.ops += 1;
  }
  quadraticCurveTo(): void {
    this.ops += 1;
  }
  closePath(): void {
    this.ops += 1;
  }
  arc(): void {
    this.ops += 1;
  }
}

const makePath = (): Path2D => new FakePath() as unknown as Path2D;

function points(count: number, x = 100, y = 100): StrokePoint[] {
  const out: StrokePoint[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({ x: x + i * 2, y: y + Math.sin(i / 4) * 6, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: i });
  }
  return out;
}

function stroke(id: string, count: number, y = 100): Stroke {
  return {
    id,
    pageId: 'page',
    tool: 'fountain',
    color: '#1f1d1a',
    width: 2,
    opacity: 1,
    points: points(count, 100, y),
    shape: null,
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    deviceId: '',
    deletedAt: null,
  };
}

describe('strokePath input buffer', () => {
  it('fills the caller buffer instead of allocating a triple per point', () => {
    const buffer: [number, number, number][] = [];
    const ink = points(50);
    strokePath(ink, 'fountain', 2, { buffer, makePath });
    expect(buffer.length).toBe(50);
    const first = buffer[0];
    // A second rebuild reuses the very same triples: nothing is allocated, and the
    // numbers handed to the brush are the same ones as before.
    strokePath(ink, 'fountain', 2, { buffer, makePath });
    expect(buffer.length).toBe(50);
    expect(buffer[0]).toBe(first);
    expect(buffer[0]).toEqual([ink[0]!.x, ink[0]!.y, ink[0]!.pressure]);
  });

  it('shrinks the buffer when the stroke it serves is shorter', () => {
    const buffer: [number, number, number][] = [];
    strokePath(points(40), 'fountain', 2, { buffer, makePath });
    strokePath(points(10), 'fountain', 2, { buffer, makePath });
    expect(buffer.length).toBe(10);
  });
});

describe('StrokePathCache', () => {
  it('builds once and reuses the outline for an unchanged stroke', () => {
    const cache = new StrokePathCache(4000, makePath);
    const ink = stroke('a', 60);
    const first = cache.pathFor(ink);
    for (let frame = 0; frame < 120; frame += 1) expect(cache.pathFor(ink)).toBe(first);
    expect(cache.builds).toBe(1);
  });

  it('rebuilds when the live stroke grows, and only then', () => {
    const cache = new StrokePathCache(4000, makePath);
    const live = stroke('live', 4);
    cache.pathFor(live);
    expect(cache.builds).toBe(1);
    live.points.push({ x: 200, y: 120, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 9 });
    cache.pathFor(live);
    expect(cache.builds).toBe(2);
    cache.pathFor(live);
    expect(cache.builds).toBe(2);
  });

  it('forgets a stroke that was erased', () => {
    const cache = new StrokePathCache(4000, makePath);
    const ink = stroke('a', 20);
    cache.pathFor(ink);
    cache.forget('a');
    expect(cache.size).toBe(0);
  });
});

describe('InkView', () => {
  const page = 400;
  const strokes: Stroke[] = [];
  const strokeById = new Map<string, Stroke>();
  const strokeBounds = new Map<string, ReturnType<typeof boundsOfPoints>>();
  const strokeOrder = new Map<string, number>();
  const grid = new StrokeGrid();
  for (let i = 0; i < page; i += 1) {
    const ink = stroke(`s${i}`, 12, i * 50);
    strokes.push(ink);
    strokeById.set(ink.id, ink);
    strokeBounds.set(ink.id, boundsOfPoints(ink.points, ink.width * 1.5 + 2));
    strokeOrder.set(ink.id, i);
    grid.set(ink.id, strokeBounds.get(ink.id)!);
  }
  const view = new InkView(
    strokeById,
    (id) => strokeBounds.get(id),
    (id) => strokeOrder.get(id) ?? 0,
  );
  const viewport = { minX: 0, minY: 0, maxX: 900, maxY: 1000 };

  it('looks at the ink the viewport holds, not at the whole page', () => {
    const visible = view.visible(grid, viewport).length;
    expect(visible).toBeGreaterThan(0);
    // 400 strokes on the page, 21 of them within the viewport.
    expect(visible).toBeLessThanOrEqual(22);
    expect(visible).toBeLessThan(page / 10);
  });

  it('hands them back in the order they were drawn', () => {
    const visible = view.visible(grid, viewport);
    for (let i = 1; i < visible.length; i += 1) {
      expect(strokeOrder.get(visible[i]!.id)!).toBeGreaterThan(strokeOrder.get(visible[i - 1]!.id)!);
    }
  });

  it('finds the same strokes as a full-page scan', () => {
    const scanned = strokes.filter(
      (s) =>
        boundsOfPoints(s.points, s.width * 1.5 + 2).minX <= viewport.maxX &&
        boundsOfPoints(s.points, s.width * 1.5 + 2).maxX >= viewport.minX &&
        boundsOfPoints(s.points, s.width * 1.5 + 2).minY <= viewport.maxY &&
        boundsOfPoints(s.points, s.width * 1.5 + 2).maxY >= viewport.minY,
    );
    expect(view.visible(grid, viewport).map((s) => s.id)).toEqual(scanned.map((s) => s.id));
  });
});
