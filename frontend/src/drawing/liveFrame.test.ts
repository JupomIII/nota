import { describe, expect, it } from 'vitest';
import type { DrawToolId, Stroke, StrokePoint } from '../storage/types';
import {
  LIVE_TAIL_POINTS,
  LiveStrokePainter,
  liveFrameHasWork,
  type LiveSessionKind,
  type LiveSurface,
} from './liveStroke';
import { MIN_NIB_SCREEN_DISTANCE, inkPointAt, nibHasMoved, smoothPressure } from './inkInput';
import { strokePath } from './strokeRender';

/**
 * What one frame of drawing costs, from the finger to the layer.
 *
 * The load is an iPad one: a pencil sampling at 240 Hz on a 834 x 1194 pt sheet,
 * two samples per frame at 120 Hz (four at 60 Hz), a stroke that has grown to
 * 2 000 points. The budget is the iPad screen's own: 16.6 ms at 60 Hz, 8.3 ms on
 * a ProMotion display — everything below the compositor, this frame included,
 * has to fit inside that.
 *
 * Two halves are measured separately because they are paid at different rates:
 *
 *   input  — pointermove to points on the page: the transform, the pressure
 *            average, the "has the nib moved" test and the append. Paid per
 *            sample, so 240 times a second.
 *   render — points to pixels: the piece of the stroke that moved, the box it
 *            clears, the box it could have inked, and the brush outline itself.
 *            Paid once per frame.
 *
 * The yardstick for the render half is the frame this replaced: the whole outline
 * of every point, rebuilt as soon as the tip moved. Both are product code — the
 * painter for the window, `strokePath` for the outline — measured in the same run
 * on the same stroke, so the ratio is the cost this project removed and the guard
 * below fails if that cost ever comes back.
 *
 * What is *not* measured here, and cannot be in Node: the rasterisation of those
 * paths by the browser. This is the JavaScript and Path2D-command cost of the
 * frame, which is the part this project decides; the fill itself is the
 * platform's. Assertions are written against the iPad budget and against ratios
 * measured in the same run, not against a stopwatch on one machine.
 */

/** iPad frame budgets: 60 Hz, then ProMotion at 120 Hz. */
const FRAME_BUDGET_60_MS = 16.6;
const FRAME_BUDGET_120_MS = 8.3;
const US_PER_MS = 1000;

/** A sheet at 1:1, the view a writer is in most of the time. */
const VIEW = { scale: 1, tx: 0, ty: 0 };
const SAMPLES_PER_FRAME = 2;
/** Pencil travel per sample: a fast hand, about 400 pt a second at 240 Hz. */
const SAMPLE_STEP_PX = 1.7;
const STROKE_POINTS = 2000;
const FRAMES = 300;
/**
 * A frame touches dozens of points, not hundreds. Written as a literal on
 * purpose: a guard that read the window size from the code it guards could never
 * notice that window being widened.
 */
const MAX_WINDOW_POINTS = 32;

class CountingPath {
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

const makePath = (): Path2D => new CountingPath() as unknown as Path2D;

/** Pen samples along a line a hand could actually draw. */
function samples(count: number): { x: number; y: number; pressure: number }[] {
  const out: { x: number; y: number; pressure: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      x: 40 + i * SAMPLE_STEP_PX,
      y: 300 + Math.sin(i / 70) * 26 + Math.sin(i / 13) * 9,
      // The force of a pencil resting and pressing: 0.35 to 0.85.
      pressure: 0.6 + Math.sin(i / 23) * 0.25,
    });
  }
  return out;
}

function pagePoints(count: number): StrokePoint[] {
  return samples(count).map((s, i) => inkPointAt(s.x, s.y, s.pressure, 0, 0, i * 4, VIEW));
}

function strokeOf(points: StrokePoint[], tool: DrawToolId): Stroke {
  return {
    id: `frame-${tool}`,
    createdAt: 0,
    updatedAt: 0,
    version: 1,
    deviceId: 'frame-bench',
    deletedAt: null,
    pageId: 'p',
    tool,
    color: '#1e2521',
    width: tool === 'highlighter' ? 22 : 4,
    opacity: tool === 'highlighter' ? 0.35 : tool === 'pencil' ? 0.9 : 1,
    points,
    shape: null,
  };
}

/** Counts the point-range copies a surface makes, without touching any global. */
function countingCopies(points: StrokePoint[]): () => number[] {
  const sizes: number[] = [];
  const native = Array.prototype.slice;
  (points as unknown as { slice: typeof Array.prototype.slice }).slice = function slice(
    this: StrokePoint[],
    from?: number,
    to?: number,
  ) {
    sizes.push(to === undefined ? this.length - (from ?? 0) : to - (from ?? 0));
    return native.call(this, from, to) as StrokePoint[];
  } as typeof Array.prototype.slice;
  return () => sizes;
}

const extentOf = (points: StrokePoint[], pad: number) => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
};

/**
 * The live surface as the engine builds it: the box to clear and the box the nib
 * could have inked, each over its own copy of the frame's points. The layer work
 * (the canvas calls) is stubbed: this measures the frame's bookkeeping and its
 * outline, not the browser's fill.
 */
function engineSurface(stroke: Stroke): LiveSurface {
  const toScreen = (x: number, y: number) => ({ x: x * VIEW.scale + VIEW.tx, y: y * VIEW.scale + VIEW.ty });
  const boxOf = (from: number, to: number, pad: number) => {
    const doc = extentOf(stroke.points.slice(from, to), pad);
    const tl = toScreen(doc.minX, doc.minY);
    const br = toScreen(doc.maxX, doc.maxY);
    return {
      minX: Math.min(tl.x, br.x),
      minY: Math.min(tl.y, br.y),
      maxX: Math.max(tl.x, br.x),
      maxY: Math.max(tl.y, br.y),
    };
  };
  const reach = stroke.width * 0.5 + 2 + (stroke.tool === 'pencil' ? stroke.width * 0.18 : 0);
  return {
    clear: () => {},
    paint: () => {},
    rectOf: (from, to) => boxOf(from, to, 0),
    inkBox: (from, to) => boxOf(from, to, reach),
  };
}

/** Microseconds per frame: fastest of several interleaved passes. */
function timeFrames(a: () => void, b: () => void): { aUs: number; bUs: number } {
  a();
  b();
  let aUs = Infinity;
  let bUs = Infinity;
  for (let pass = 0; pass < 4; pass += 1) {
    const startA = performance.now();
    a();
    aUs = Math.min(aUs, ((performance.now() - startA) * US_PER_MS) / FRAMES);
    const startB = performance.now();
    b();
    bUs = Math.min(bUs, ((performance.now() - startB) * US_PER_MS) / FRAMES);
  }
  return { aUs, bUs };
}

describe('cost of one frame, finger to layer', () => {
  it('stays far inside the iPad budget, tool by tool', () => {
    const rows: string[] = [];
    for (const tool of ['fountain', 'pencil', 'highlighter'] as DrawToolId[]) {
      const stroke = strokeOf(pagePoints(STROKE_POINTS), tool);
      const surface = engineSurface(stroke);
      const painter = new LiveStrokePainter(makePath);

      const windowFrame = () => {
        for (let i = 0; i < FRAMES; i += 1) painter.paint(stroke, surface);
      };
      // The frame this replaced: every point of the stroke, every frame.
      const outlineFrame = () => {
        for (let i = 0; i < FRAMES; i += 1) strokePath(stroke.points, stroke.tool, stroke.width, { makePath });
      };

      const { aUs: frameUs, bUs: outlineUs } = timeFrames(windowFrame, outlineFrame);

      rows.push(
        `${tool.padEnd(11)} frame ${frameUs.toFixed(1)} us` +
          ` (${((frameUs / US_PER_MS / FRAME_BUDGET_120_MS) * 100).toFixed(2)} % of a 120 Hz frame,` +
          ` ${((frameUs / US_PER_MS / FRAME_BUDGET_60_MS) * 100).toFixed(2)} % of a 60 Hz one)` +
          `; whole outline ${outlineUs.toFixed(0)} us, x${(outlineUs / frameUs).toFixed(0)} this frame`,
      );

      // 250 us is still 3 % of the ProMotion budget and some 30 times what this
      // measures: it only trips on real work coming back, a full-outline frame
      // being the first thing that would.
      expect(frameUs).toBeLessThan(250);
      expect(frameUs).toBeLessThan(FRAME_BUDGET_120_MS * US_PER_MS);
      // The removed cost has to stay removed: a frame must never be within an
      // order of magnitude of rebuilding the whole stroke.
      expect(frameUs * 10).toBeLessThan(outlineUs);
    }
    console.log(rows.join('\n'));
  });

  it('never copies more than the frame window out of the stroke', () => {
    const stroke = strokeOf(pagePoints(STROKE_POINTS), 'fountain');
    const copies = countingCopies(stroke.points);
    const painter = new LiveStrokePainter(makePath);
    const surface = engineSurface(stroke);
    painter.paint(stroke, surface);

    const sizes = copies();
    console.log(
      `copies     ${sizes.length} point ranges per frame, largest ${Math.max(...sizes)} points` +
        ` (stroke is ${stroke.points.length}), ${painter.pointsPerFrame} points handed to the brush`,
    );

    // Whatever the stroke's length, a frame touches one window of it.
    expect(painter.pointsPerFrame).toBeLessThanOrEqual(MAX_WINDOW_POINTS);
    expect(painter.pointsPerFrame).toBe(LIVE_TAIL_POINTS);
    for (const size of sizes) expect(size).toBeLessThanOrEqual(MAX_WINDOW_POINTS);
    // And it is a bounded number of ranges, not one per point.
    expect(sizes.length).toBeLessThanOrEqual(4);
  });

  it('keeps the input side of a frame to a fraction of a microsecond per sample', () => {
    const pen = samples(STROKE_POINTS);
    const points: StrokePoint[] = [];
    let lastPressure = 0;

    const run = () => {
      points.length = 0;
      lastPressure = 0;
      points.push(inkPointAt(pen[0]!.x, pen[0]!.y, pen[0]!.pressure, 0, 0, 0, VIEW));
      for (let i = 1; i < pen.length; i += 1) {
        const s = pen[i]!;
        const p = inkPointAt(s.x, s.y, s.pressure, 0, 0, i * 4, VIEW);
        lastPressure = smoothPressure(lastPressure, p.pressure);
        p.pressure = lastPressure;
        const last = points[points.length - 1]!;
        if (!nibHasMoved(last, p, MIN_NIB_SCREEN_DISTANCE, VIEW.scale)) continue;
        points.push(p);
      }
      return points.length;
    };

    const written = run();
    let perSample = Infinity;
    for (let pass = 0; pass < 5; pass += 1) {
      const started = performance.now();
      run();
      perSample = Math.min(perSample, ((performance.now() - started) * US_PER_MS) / (STROKE_POINTS - 1));
    }
    const perFrame = perSample * SAMPLES_PER_FRAME;

    console.log(
      `input       ${perSample.toFixed(3)} us/sample, ${SAMPLES_PER_FRAME} samples per frame` +
        ` -> ${perFrame.toFixed(3)} us/frame (${((perFrame / US_PER_MS / FRAME_BUDGET_120_MS) * 100).toFixed(3)} % of a 120 Hz frame)` +
        `, ${written} of ${STROKE_POINTS} samples became a point`,
    );

    // A pencil on a 120 Hz iPad leaves 4 ms between samples; the transform and the
    // append have to stay a rounding error next to the 8.3 ms frame they sit in.
    expect(perSample).toBeLessThan(50);
    expect(perFrame).toBeLessThan(FRAME_BUDGET_120_MS * US_PER_MS);
    // At this speed every sample is a real move, so every one is kept, pass after pass.
    expect(written).toBe(STROKE_POINTS);
    expect(points.length).toBe(written);
  });

  it('leaves the wet layer alone for a gesture that paints nothing', () => {
    const dry = (kind: LiveSessionKind) =>
      liveFrameHasWork({ kind, painted: false, scrubbing: false, selection: false });

    // A drag and a pinch draw nothing on this layer of their own.
    expect(dry('pan')).toBe(false);
    expect(dry('pinch')).toBe(false);
    expect(dry('none')).toBe(false);
    // Everything that does draw owes its frame.
    for (const kind of ['draw', 'shape', 'erase', 'lasso', 'move', 'resize'] as const) {
      expect(dry(kind)).toBe(true);
    }
    // And anything still on the layer owes one too, whatever is happening: a
    // stroke that just ended is cleared away by the frame that follows it.
    expect(liveFrameHasWork({ kind: 'pan', painted: true, scrubbing: false, selection: false })).toBe(true);
    expect(liveFrameHasWork({ kind: 'pinch', painted: false, scrubbing: true, selection: false })).toBe(true);
    expect(liveFrameHasWork({ kind: 'pan', painted: false, scrubbing: false, selection: true })).toBe(true);

    // What the gate saves each frame: the whole live backing store at iPad device
    // scale, wiped to leave it exactly as it was.
    const cssWidth = 1024;
    const cssHeight = 1310;
    const dpr = 2;
    const perFrame = cssWidth * dpr * (cssHeight * dpr);
    expect(perFrame).toBe(5_365_760);
    console.log(
      `dry gesture ${perFrame.toLocaleString('en-US')} px per frame no longer cleared` +
        ` (${((perFrame * 120) / 1e6).toFixed(0)} Mpx/s at 120 Hz)`,
    );
  });

  it('does not pay for the length of the stroke it is drawing', () => {
    const all = pagePoints(STROKE_POINTS);
    const short = strokeOf(all.slice(0, 200), 'fountain');
    const long = strokeOf(all, 'fountain');
    const frameOf = (stroke: Stroke) => {
      const surface = engineSurface(stroke);
      const painter = new LiveStrokePainter(makePath);
      painter.paint(stroke, surface);
      const started = performance.now();
      for (let i = 0; i < FRAMES; i += 1) painter.paint(stroke, surface);
      return ((performance.now() - started) * US_PER_MS) / FRAMES;
    };

    frameOf(short);
    frameOf(long);
    let at200 = Infinity;
    let at2000 = Infinity;
    for (let pass = 0; pass < 4; pass += 1) {
      at200 = Math.min(at200, frameOf(short));
      at2000 = Math.min(at2000, frameOf(long));
    }

    console.log(
      `length      200 pt: ${at200.toFixed(1)} us/frame, 2000 pt: ${at2000.toFixed(1)} us/frame` +
        ` (x${(at2000 / at200).toFixed(2)})`,
    );

    // Ten times the ink, the same frame: a frame only ever sees its window, so the
    // length of the stroke may not show up as more than noise.
    expect(at2000 / at200).toBeLessThan(2);
  });
});
