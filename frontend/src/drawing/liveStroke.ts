import type { Stroke } from '../storage/types';
import { configFor, type FreehandConfig } from './brushes';
import { strokePath, type FreehandInput, type PathFactory } from './strokeRender';

/**
 * Painting a growing stroke without rebuilding it.
 *
 * A wet stroke used to be repainted from its whole outline on every frame, which
 * made the cost of a frame follow the length of the stroke: the brush's outline
 * is a function of every point, so every point already on screen was recomputed
 * because the tip moved. What actually changes between two frames is the tip —
 * the brush's smoothing and its end taper only reach a few points back.
 *
 * So the stroke is written to the layer as a window over its last points: each
 * frame clears the box the previous frame painted and paints one piece covering
 * the last `LIVE_TAIL_POINTS` points. What falls out of the window has already
 * been painted and is never touched again. A frame therefore costs a fixed
 * number of points, whatever the length of the stroke.
 *
 * Two things make that faithful to the single-outline painting it replaces:
 *
 * 1. The piece gets the configuration of the whole stroke. A piece resolving its
 *    own would taper its start and simulate its own pressure, which is what made
 *    an earlier attempt at this visible as a change of shape at the join.
 * 2. The piece has no start taper, so it joins the frozen part at the full width
 *    of the nib, and it is cleared and repainted in the same box, so no pixel is
 *    painted twice and none is left unpainted.
 *
 * Two passes over one pixel only come out right when a fill replaces what is
 * under it. That is true of an opaque fill, so the wet layer is painted opaque
 * and the brush's opacity is applied to the layer as a whole when it is
 * composited: over one stroke on a transparent canvas that is the same pixels,
 * and overlaps stay invisible. The pencil's graphite edge is painted inside the
 * same layer, so the layer's opacity covers it too.
 *
 * The committed stroke never goes through any of this: when the pen lifts, the
 * ink layer draws the whole outline of all points, exactly as before.
 */

/**
 * Points the wet window holds. Long enough for the brush's smoothing and its
 * pressure simulation to settle onto the geometry of the whole stroke, short
 * enough that a frame does not care how long the stroke has become.
 */
export const LIVE_TAIL_POINTS = 24;

export interface ScreenRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** What the painter needs from the layer it paints on. */
export interface LiveSurface {
  /** Clears one screen-space rectangle of the live layer. */
  clear(rect: ScreenRect): void;
  /**
   * Paints one path in document space; the layer's transform is already applied.
   * Full opacity: the stroke's own opacity belongs to the layer, not to a piece.
   */
  paint(path: Path2D): void;
  /**
   * Screen rectangle of the pixels in points [from, to): the box of their nib.
   * Clearing it and painting the same points repaints every pixel it wiped.
   */
  rectOf(from: number, to: number): ScreenRect;
  /**
   * Screen rectangle covering everything those points could have painted, nib
   * and antialiasing included. This is what the layer has to clear when the
   * stroke ends: a wide nib paints well outside the box of its own points.
   */
  inkBox(from: number, to: number): ScreenRect;
}

/**
 * Can this stroke be painted a window at a time? Every freehand tool can,
 * because the window is only ever painted opaque: the brush's own opacity rides
 * on the layer (see the note at the top), so repainting a pixel leaves it opaque
 * instead of stacking two translucent passes. Strokes of the shape tools are a
 * single vector outline and are not grown point by point.
 */
export function isIncrementalStroke(stroke: Stroke): boolean {
  return stroke.shape === null;
}

/** The sessions the engine can be in while it paints the wet layer. */
export type LiveSessionKind =
  | 'none'
  | 'draw'
  | 'shape'
  | 'erase'
  | 'lasso'
  | 'pan'
  | 'pinch'
  | 'move'
  | 'resize';

/**
 * Does this frame have anything to put on the wet layer?
 *
 * It exists for the frames that have nothing: a drag or a pinch with a dry
 * pencil. Clearing the layer anyway wipes its whole backing store — 2048 x 2620
 * at iPad device scale — to leave it exactly as it was, every frame, which is
 * several milliseconds of fill the drag cannot afford.
 *
 * Anything already on the layer still owes a frame, so a stroke that has just
 * ended is cleared away as before.
 */
export function liveFrameHasWork(input: {
  kind: LiveSessionKind;
  /** Whether the layer still holds pixels from an earlier frame. */
  painted: boolean;
  scrubbing: boolean;
  selection: boolean;
}): boolean {
  if (input.painted || input.scrubbing || input.selection) return true;
  switch (input.kind) {
    case 'draw':
    case 'shape':
    case 'erase':
    case 'lasso':
    case 'move':
    case 'resize':
      return true;
    default:
      // A drag or a pinch draws nothing on this layer of its own.
      return false;
  }
}

export class LiveStrokePainter {
  private readonly buffer: FreehandInput[] = [];
  private strokeId: string | null = null;
  /** Pressure range of the whole stroke, so every piece shares its brush. */
  private minPressure = 1;
  private maxPressure = 0;
  private pointsSeen = 0;
  /** The window painted by the last frame, cleared by the next one. */
  private tail: ScreenRect | null = null;
  /** Everything this stroke has painted: the engine clears it when it ends. */
  private covered: ScreenRect | null = null;

  /** Outlines rebuilt by the last frame, and the points they covered. */
  builds = 0;
  pointsPerFrame = 0;

  constructor(private readonly makePath?: PathFactory) {}

  /** Screen rect the whole wet stroke occupies, for the engine's bookkeeping. */
  get painted(): ScreenRect | null {
    return this.covered;
  }

  reset(): void {
    this.strokeId = null;
    this.minPressure = 1;
    this.maxPressure = 0;
    this.pointsSeen = 0;
    this.tail = null;
    this.covered = null;
    this.builds = 0;
    this.pointsPerFrame = 0;
  }

  /** Paints one frame of a growing stroke. */
  paint(stroke: Stroke, surface: LiveSurface): void {
    if (this.strokeId !== stroke.id) {
      this.reset();
      this.strokeId = stroke.id;
    }
    this.builds = 0;
    this.pointsPerFrame = 0;

    const total = stroke.points.length;
    if (total === 0) {
      if (this.tail) surface.clear(this.tail);
      this.tail = null;
      return;
    }
    this.trackPressure(stroke);

    const from = Math.max(0, total - LIVE_TAIL_POINTS);
    const window = surface.rectOf(from, total);
    // Clear the box this frame is about to paint, and only that box: every pixel
    // it wipes is a pixel the piece paints back, so nothing is left behind and
    // nothing is painted twice.
    if (this.tail) surface.clear(window);
    surface.paint(this.build(stroke, from, total));
    this.tail = window;
    // The layer keeps the wider box: what the nib painted outside the points is
    // still on the canvas, and ending the stroke has to wipe all of it.
    this.covered = union(this.covered, surface.inkBox(from, total));
  }

  /**
   * Keeps the pressure range of the whole stroke as it grows, so the window is
   * handed the brush the committed outline will use. Min and max only widen, so
   * the answer never flips back and forth between frames.
   */
  private trackPressure(stroke: Stroke): void {
    const points = stroke.points;
    for (let i = this.pointsSeen; i < points.length; i += 1) {
      const pressure = points[i]!.pressure;
      if (pressure < this.minPressure) this.minPressure = pressure;
      if (pressure > this.maxPressure) this.maxPressure = pressure;
    }
    if (points.length > this.pointsSeen) this.pointsSeen = points.length;
  }

  /** The brush every window of this stroke is drawn with. */
  private config(stroke: Stroke): FreehandConfig {
    const real = this.pointsSeen >= 3 && this.maxPressure - this.minPressure > 0.02;
    return configFor(stroke.tool, stroke.width, !real);
  }

  private build(stroke: Stroke, from: number, to: number): Path2D {
    const piece = stroke.points.slice(from, to);
    this.builds += 1;
    this.pointsPerFrame += piece.length;
    return strokePath(piece, stroke.tool, stroke.width, {
      config: this.config(stroke),
      buffer: this.buffer,
      makePath: this.makePath,
      // The window hangs off the frozen part of the stroke at full width; only a
      // window that starts at the very beginning keeps the brush's start taper.
      noStartTaper: from > 0,
    });
  }
}

function union(a: ScreenRect | null, b: ScreenRect | null): ScreenRect | null {
  if (!a) return b;
  if (!b) return a;
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}
