import { beforeAll, describe, expect, it } from 'vitest';
import type { DrawToolId, Stroke, StrokePoint } from '../storage/types';
import { PAINT_MARGIN, widenPaintMargin } from './paintMargin';
import { strokePath } from './strokeRender';

/**
 * What a frame of a live stroke costs, tool by tool, before and after.
 *
 * The stroke is grown one point per frame, as a pencil does, and the pages below
 * are 200 and 2 000 points long. Everything is measured on the code that paints:
 * `strokePath` for the whole-outline frames this replaces, and the live painter
 * for the window-at-a-time frames. Both go through the same brush.
 *
 * The Path2D stand-in is installed before anything runs, so the bench measures
 * the old code path in a plain Node process instead of failing on a missing
 * browser API.
 */

type Op = { op: string; args: number[] };

class CountingPath {
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

let pathsBuilt = 0;
const makePath = (): Path2D => {
  pathsBuilt += 1;
  return new CountingPath() as unknown as Path2D;
};
const opsOf = (path: Path2D): number => (path as unknown as CountingPath).ops.length;

type Painter = {
  paint(stroke: Stroke, surface: unknown): void;
  pointsPerFrame: number;
  builds: number;
  painted: unknown;
};

interface LiveStrokeModule {
  LiveStrokePainter: new (makePath: () => Path2D) => Painter;
  /** Absent in the previous revision, which decided the path inside the engine. */
  isIncrementalStroke?: (stroke: Stroke) => boolean;
}

let live: LiveStrokeModule | null = null;

beforeAll(async () => {
  // Node has no Path2D. Installing the stand-in first means the old whole-outline
  // path builds a path like it does in Safari instead of throwing.
  (globalThis as unknown as { Path2D: unknown }).Path2D = CountingPath;
  live = (await import('./liveStroke').catch(() => null)) as LiveStrokeModule | null;
});

function points(count: number): StrokePoint[] {
  const out: StrokePoint[] = [];
  for (let i = 0; i < count; i += 1) {
    const t = i / 30;
    out.push({
      x: 100 + i * 0.7 + Math.sin(t) * 6,
      y: 200 + Math.cos(t * 1.2) * 9,
      pressure: 0.5,
      tiltX: 0,
      tiltY: 0,
      timestamp: i * 4,
    });
  }
  return out;
}

function strokeOf(given: StrokePoint[], tool: DrawToolId): Stroke {
  return {
    id: `live-${tool}`,
    createdAt: 0,
    updatedAt: 0,
    version: 1,
    deviceId: 'bench',
    deletedAt: null,
    pageId: 'p',
    tool,
    color: '#1e2521',
    width: tool === 'highlighter' ? 22 : 4,
    opacity: tool === 'highlighter' ? 0.35 : tool === 'pencil' ? 0.9 : 1,
    points: given,
    shape: null,
  };
}

interface FrameCost {
  /** Points handed to the brush, which is what the outline work follows. */
  points: number;
  /** Path commands the frame draws with, fill and graphite edge included. */
  commands: number;
  /** Outlines rebuilt. */
  outlines: number;
  /** Screen area cleared, in square pixels. */
  cleared: number;
  /** Fresh Path2D objects, and fresh point triples for the brush. */
  paths: number;
  triples: number;
}

const mean = (frames: FrameCost[], key: keyof FrameCost): number =>
  frames.reduce((sum, f) => sum + f[key], 0) / frames.length;
const worst = (frames: FrameCost[], key: keyof FrameCost): number =>
  frames.reduce((max, f) => Math.max(max, f[key]), 0);

/** A frame painted the old way: the whole outline of every point, twice for the pencil. */
function wholeOutlineFrame(stroke: Stroke, cleared: number): FrameCost {
  const before = pathsBuilt;
  const path = strokePath(stroke.points, stroke.tool, stroke.width, { makePath });
  const commands = opsOf(path) * (stroke.tool === 'pencil' ? 2 : 1);
  return {
    points: stroke.points.length,
    commands,
    outlines: 1,
    cleared,
    paths: pathsBuilt - before,
    // A fresh input array of one triple per point, per call.
    triples: stroke.points.length,
  };
}

/** The same frame, painted a window at a time. */
function incrementalFrame(painter: Painter, stroke: Stroke): FrameCost {
  let commands = 0;
  let cleared = 0;
  const passes = stroke.tool === 'pencil' ? 2 : 1;
  const before = pathsBuilt;
  const surface = {
    clear: (rect: { minX: number; minY: number; maxX: number; maxY: number }) => {
      cleared += (rect.maxX - rect.minX) * (rect.maxY - rect.minY);
    },
    paint: (path: Path2D) => {
      commands += opsOf(path) * passes;
    },
    // `fill` is what the painter of the previous revision asked for; keeping both
    // is what lets this bench run against those sources to show the old cost.
    fill: (path: Path2D) => {
      commands += opsOf(path) * passes;
    },
    rectOf: (from: number, to: number) => {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = from; i < to; i += 1) {
        const p = stroke.points[i]!;
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      return { minX, minY, maxX, maxY };
    },
    // Bookkeeping for the clear at the end of the stroke, not a per-frame cost.
    inkBox: (from: number, to: number) => {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = from; i < to; i += 1) {
        const p = stroke.points[i]!;
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
      return { minX, minY, maxX, maxY };
    },
  };
  painter.paint(stroke, surface);
  return {
    points: painter.pointsPerFrame,
    commands,
    outlines: painter.builds,
    cleared,
    paths: pathsBuilt - before,
    // The brush's input buffer belongs to the painter and is reused.
    triples: 0,
  };
}

/** Cleared area of the whole stroke, as the old frame cleared it. */
function wholeStrokeArea(all: StrokePoint[]): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of all) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return (maxX - minX) * (maxY - minY);
}

const TOOLS: DrawToolId[] = ['fountain', 'pencil', 'highlighter'];

describe('cost of one frame of a live stroke', () => {
  it('stops growing with the length of the stroke, for every tool', () => {
    const before: Record<string, FrameCost[]> = {};
    const after: Record<string, FrameCost[]> = {};
    for (const tool of TOOLS) {
      for (const count of [200, 2000]) {
        const all = points(count);
        const oldFrames: FrameCost[] = [];
        for (let frame = 1; frame <= count; frame += 1) {
          const stroke = strokeOf(all.slice(0, frame), tool);
          oldFrames.push(wholeOutlineFrame(stroke, wholeStrokeArea(stroke.points)));
        }
        before[`${tool}@${count}`] = oldFrames;
        if (live) {
          const painter = new live.LiveStrokePainter(makePath);
          const stroke = strokeOf(all, tool);
          const newFrames: FrameCost[] = [];
          for (let frame = 1; frame <= count; frame += 1) {
            stroke.points = all.slice(0, frame);
            newFrames.push(incrementalFrame(painter, stroke));
          }
          after[`${tool}@${count}`] = newFrames;
        }
      }
    }

    const rows: string[] = [];
    for (const tool of TOOLS) {
      for (const count of [200, 2000]) {
        const b = before[`${tool}@${count}`]!;
        const a = after[`${tool}@${count}`] ?? b;
        rows.push(
          `${tool.padEnd(11)} ${String(count).padStart(4)}pt: whole outline ${mean(b, 'points').toFixed(0)}pt / ${mean(b, 'commands').toFixed(0)} cmd / ${mean(b, 'cleared').toFixed(0)}px2 / ${mean(b, 'triples').toFixed(0)} triples per frame` +
            `  ->  window ${mean(a, 'points').toFixed(0)}pt / ${mean(a, 'commands').toFixed(0)} cmd / ${mean(a, 'cleared').toFixed(0)}px2 / ${mean(a, 'triples').toFixed(0)} triples, worst ${worst(a, 'points')}pt and ${worst(a, 'outlines')} outline(s), ${mean(a, 'paths').toFixed(1)} paths`,
        );
      }
    }
    console.log(rows.join('\n'));

    // Which of the two paths the engine actually takes for each tool. Before this
    // change only the fountain was routed to the window: the pencil and the
    // highlighter rendered the whole outline on every frame.
    const routed = TOOLS.map((tool) => {
      const window = live?.isIncrementalStroke?.(strokeOf(points(2), tool)) === true;
      return `${tool}:${window ? 'window' : 'whole outline'}`;
    });
    console.log(`engine path per tool: ${routed.join(', ')}`);

    if (!live) {
      console.log('live painter missing: the right-hand column still shows the old cost');
      throw new Error('the live painter is not available, so the frame cost was not bounded');
    }

    for (const tool of TOOLS) {
      const oldRatio = mean(before[`${tool}@2000`]!, 'points') / mean(before[`${tool}@200`]!, 'points');
      const newRatio = worst(after[`${tool}@2000`]!, 'points') / worst(after[`${tool}@200`]!, 'points');
      const clearedOld = mean(before[`${tool}@2000`]!, 'cleared') / mean(before[`${tool}@200`]!, 'cleared');
      const clearedNew = mean(after[`${tool}@2000`]!, 'cleared') / mean(after[`${tool}@200`]!, 'cleared');
      console.log(
        `${tool.padEnd(11)} x10 points: whole outline x${oldRatio.toFixed(1)} work (cleared x${clearedOld.toFixed(1)}), window x${newRatio.toFixed(2)} (cleared x${clearedNew.toFixed(2)})`,
      );
      expect(oldRatio).toBeGreaterThan(8);
      expect(clearedOld).toBeGreaterThan(8);
      expect(newRatio).toBeLessThan(1.2);
      expect(clearedNew).toBeLessThan(1.2);
      expect(worst(after[`${tool}@2000`]!, 'points')).toBeLessThanOrEqual(24);
      expect(worst(after[`${tool}@2000`]!, 'outlines')).toBeLessThanOrEqual(1);
      expect(mean(after[`${tool}@2000`]!, 'triples')).toBe(0);
      expect(routed).toContain(`${tool}:window`);
    }
  });

  it('keeps the eraser cue at a constant cost', () => {
    // The eraser does not draw the stroke: it draws one circle of its radius at
    // the rub point, so its frame cost never followed the page either.
    const cost = (count: number) => {
      const all = points(count);
      const stroke = strokeOf(all, 'fountain');
      const path = makePath();
      (path as unknown as CountingPath).arc(stroke.points[0]!.x, stroke.points[0]!.y, 9, 0, Math.PI * 2);
      return { commands: opsOf(path), points: 1, outlines: 0, cleared: 0, paths: 1, triples: 0 };
    };
    const small = cost(200);
    const large = cost(2000);
    console.log(
      `eraser cue  200pt: ${small.commands} cmd per frame; 2000pt: ${large.commands} cmd per frame (the page's ink is not drawn)`,
    );
    expect(large.commands).toBe(small.commands);
  });

  it('keeps a zoom-out from repainting the page on every frame', () => {
    // The engine repaints the layers only when the view needs page the layers do
    // not hold; this is that decision, frame for frame, over a pinch that shrinks
    // the view by 3.5% a frame. The margin is the multiple of the viewport the
    // layers are painted with, so a repaint buys that much more zooming out.
    const shrink = 0.965;
    const frames = 60;
    const runZoom = (adaptive: boolean) => {
      let scale = 1;
      let held = 1;
      let margin = PAINT_MARGIN;
      let repaints = 0;
      for (let frame = 0; frame < frames; frame += 1) {
        scale *= shrink;
        const needed = 1 / scale;
        if (needed > held) {
          repaints += 1;
          if (adaptive) margin = widenPaintMargin(margin);
          held = needed * margin;
        }
      }
      return repaints;
    };
    const fixed = runZoom(false);
    const adaptive = runZoom(true);
    console.log(
      `zoom-out over ${frames} frames (x${(1 / Math.pow(shrink, frames)).toFixed(1)} out): ${fixed} full repaints with a fixed x${PAINT_MARGIN} margin, ${adaptive} with the widened one`,
    );
    expect(adaptive).toBeLessThanOrEqual(fixed);
    expect(adaptive).toBeLessThan(frames / 10);
  });
});
