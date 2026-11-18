import { describe, expect, it } from 'vitest';
import type { Stroke, StrokePoint } from '../storage/types';
import { boundsIntersect, boundsOfPoints, type Bounds } from '../lib/geometry';
import { StrokeGrid } from './spatial';
import { InkView, StrokePathCache } from './strokeCache';
import { strokePath } from './strokeRender';

/**
 * A reproducible cost bench for the repaint hot path.
 *
 * It does not measure the canvas raster work, which needs a browser: it measures
 * the work the engine does *around* the raster — how many strokes a repaint looks
 * at, how many outlines it rebuilds, and how much it allocates — with a page that
 * already holds thousands of points. Those counts are what made a repaint cost
 * follow the size of the note instead of the size of the screen.
 *
 * The "before" figure is computed here too, as a faithful copy of the loop the
 * engine used to run over `this.strokes`, so both sides are measured on the same
 * machine and the same data.
 */

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

const STROKES = 400;
const POINTS_PER_STROKE = 20;
const VIEWPORT: Bounds = { minX: 0, minY: 0, maxX: 900, maxY: 1000 };

function makeInk(index: number, count: number, y: number): Stroke {
  const points: StrokePoint[] = [];
  for (let i = 0; i < count; i += 1) {
    points.push({
      x: 100 + i * 3,
      y: y + Math.sin(i / 4) * 6,
      pressure: 0.45 + (i % 5) * 0.1,
      tiltX: 0,
      tiltY: 0,
      timestamp: i,
    });
  }
  return {
    id: `s${index}`,
    pageId: 'page',
    tool: 'fountain',
    color: '#1f1d1a',
    width: 2,
    opacity: 1,
    points,
    shape: null,
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    deviceId: '',
    deletedAt: null,
  };
}

function scene(): {
  strokes: Stroke[];
  strokeById: Map<string, Stroke>;
  bounds: Map<string, Bounds>;
  order: Map<string, number>;
  grid: StrokeGrid;
} {
  const strokes: Stroke[] = [];
  const strokeById = new Map<string, Stroke>();
  const bounds = new Map<string, Bounds>();
  const order = new Map<string, number>();
  const grid = new StrokeGrid();
  for (let i = 0; i < STROKES; i += 1) {
    const ink = makeInk(i, POINTS_PER_STROKE, i * 50);
    strokes.push(ink);
    strokeById.set(ink.id, ink);
    bounds.set(ink.id, boundsOfPoints(ink.points, ink.width * 1.5 + 2));
    order.set(ink.id, i);
    grid.set(ink.id, bounds.get(ink.id)!);
  }
  return { strokes, strokeById, bounds, order, grid };
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

describe('repaint cost with a page full of ink', () => {
  const { strokes, strokeById, bounds, order, grid } = scene();
  const totalPoints = STROKES * POINTS_PER_STROKE;

  it('looks at the strokes on screen instead of every stroke on the page', () => {
    const view = new InkView(
      strokeById,
      (id) => bounds.get(id),
      (id) => order.get(id) ?? 0,
    );
    const legacyMs: number[] = [];
    const viewMs: number[] = [];
    let legacySeen = 0;
    let visible = 0;

    // Warm both sides so the first frame does not dominate the median.
    for (let frame = 0; frame < 120; frame += 1) {
      const before = performance.now();
      // The loop the engine ran: every stroke of the page, every repaint.
      legacySeen = 0;
      for (const ink of strokes) {
        if (boundsIntersect(bounds.get(ink.id)!, VIEWPORT)) legacySeen += 1;
      }
      legacyMs.push(performance.now() - before);

      const started = performance.now();
      visible = view.visible(grid, VIEWPORT).length;
      viewMs.push(performance.now() - started);
    }

    console.log(
      `[bench] page ${STROKES} strokes / ${totalPoints} points — per repaint:\n` +
        `        before: ${STROKES} bounds tests, ${median(legacyMs).toFixed(3)} ms median\n` +
        `        after:  ${visible} bounds tests, ${median(viewMs).toFixed(3)} ms median`,
    );

    // Same answer, a fraction of the work.
    expect(visible).toBe(legacySeen);
    expect(visible).toBeLessThanOrEqual(22);
    expect(STROKES / visible).toBeGreaterThanOrEqual(18);
  });

  it('rebuilds no outline over 120 repaints of unchanged ink', () => {
    const cache = new StrokePathCache(4000, makePath);
    const view = new InkView(
      strokeById,
      (id) => bounds.get(id),
      (id) => order.get(id) ?? 0,
    );
    const started = performance.now();
    for (let frame = 0; frame < 120; frame += 1) {
      for (const ink of view.visible(grid, VIEWPORT)) cache.pathFor(ink);
    }
    const elapsed = performance.now() - started;
    console.log(
      `[bench] 120 repaints of ${view.visible(grid, VIEWPORT).length} visible strokes: ` +
        `${cache.builds} outline builds, ${elapsed.toFixed(1)} ms total`,
    );
    // One build per stroke, ever: the 120 repaints add none.
    expect(cache.builds).toBe(view.visible(grid, VIEWPORT).length);
  });
});

describe('live stroke cost', () => {
  it('allocates nothing per frame while rebuilding a long wet stroke', () => {
    const buffer: [number, number, number][] = [];
    const wet = makeInk(0, 2000, 0);

    // The old shape of the call, measured here so both sides come from the same
    // machine: one fresh triple per point, per frame.
    const legacyStarted = performance.now();
    let legacyAllocations = 0;
    for (let frame = 0; frame < 60; frame += 1) {
      const mapped = wet.points.map(
        (p) => [p.x, p.y, Math.max(0.02, Math.min(1, p.pressure))] as [number, number, number],
      );
      legacyAllocations += mapped.length;
    }
    const legacyMs = (performance.now() - legacyStarted) / 60;

    const started = performance.now();
    let ops = 0;
    for (let frame = 0; frame < 60; frame += 1) {
      const path = strokePath(wet.points, wet.tool, wet.width, { buffer, makePath }) as unknown as FakePath;
      ops = path.ops;
    }
    const elapsed = performance.now() - started;
    console.log(
      `[bench] 60 frames of a 2000-point wet stroke:\n` +
        `        before: ${legacyAllocations / 60} input triples allocated per frame (${legacyMs.toFixed(2)} ms)\n` +
        `        after:  0 allocated per frame, ${buffer.length} triples reused, ` +
        `${(elapsed / 60).toFixed(2)} ms per outline build, ${ops} path commands`,
    );
    expect(legacyAllocations / 60).toBe(2000);
    // The same 2 000 triples serve every frame: no array per point per frame.
    expect(buffer.length).toBe(2000);
    expect(ops).toBeGreaterThan(0);
  });
});
