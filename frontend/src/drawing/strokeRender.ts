import { getStroke } from 'perfect-freehand';
import type { Stroke, StrokePoint } from '../storage/types';
import { shapeOutlinePath } from '../lib/geometry';
import { brushConfig, type FreehandConfig } from './brushes';

/** One perfect-freehand input point: x, y, pressure. */
export type FreehandInput = [number, number, number];

/** Builds an empty path; tests inject a stub because Node has no Path2D. */
export type PathFactory = () => Path2D;

const defaultPathFactory: PathFactory = () => new Path2D();

/**
 * Fills `buffer` with the points in perfect-freehand's input shape.
 *
 * Allocating a fresh triple per point, per frame, is what made the live stroke
 * cost grow with its own length: a long stroke rebuilt sixty times a second drops
 * megabytes a second of short-lived arrays on the collector. The buffer is owned
 * by the caller and reused, so a frame allocates nothing; the numbers handed to
 * the brush are exactly the same ones, so the outline is unchanged.
 */
export function freehandInput(points: StrokePoint[], buffer: FreehandInput[] = []): FreehandInput[] {
  const count = points.length;
  for (let i = buffer.length; i < count; i += 1) buffer.push([0, 0, 0]);
  if (buffer.length > count) buffer.length = count;
  for (let i = 0; i < count; i += 1) {
    const p = points[i]!;
    const entry = buffer[i]!;
    entry[0] = p.x;
    entry[1] = p.y;
    entry[2] = Math.max(0.02, Math.min(1, p.pressure));
  }
  return buffer;
}

/** Converts a perfect-freehand outline into a smooth filled path. */
export function outlineToPath(outline: number[][], makePath: PathFactory = defaultPathFactory): Path2D {
  const path = makePath();
  if (outline.length === 0) return path;
  const first = outline[0]!;
  path.moveTo(first[0]!, first[1]!);
  for (let i = 1; i < outline.length; i++) {
    const a = outline[i]!;
    const b = outline[(i + 1) % outline.length]!;
    path.quadraticCurveTo(a[0]!, a[1]!, (a[0]! + b[0]!) / 2, (a[1]! + b[1]!) / 2);
  }
  path.closePath();
  return path;
}

export interface StrokePathOptions {
  /**
   * Leave the moving end square-capped instead of tapered. The live layer
   * paints a growing stroke in overlapping pieces, and a taper on every seam
   * would show as a string of points along the line.
   */
  noEndTaper?: boolean;
  /**
   * Leave the fixed end square-capped instead of tapered. A piece of a longer
   * stroke is joined to the piece before it at full width: a taper at the join
   * would show as a notch in the middle of the line.
   */
  noStartTaper?: boolean;
  /**
   * Brush resolved by the caller, for a piece of a longer stroke. Without it the
   * piece would pick its own taper and pressure simulation from its own points.
   */
  config?: FreehandConfig;
  /** Reused input array, so a per-frame rebuild allocates nothing. */
  buffer?: FreehandInput[];
  /** Path constructor; tests inject a stub, the app leaves it out. */
  makePath?: PathFactory;
}

export function strokePath(
  points: StrokePoint[],
  tool: Stroke['tool'],
  width: number,
  options: StrokePathOptions = {},
): Path2D {
  const makePath = options.makePath ?? defaultPathFactory;
  if (points.length === 0) return makePath();
  if (points.length === 1) {
    const p = points[0]!;
    const r = Math.max(0.4, (width * (0.35 + p.pressure * 0.65)) / 2);
    const path = makePath();
    path.arc(p.x, p.y, r, 0, Math.PI * 2);
    return path;
  }
  const cfg = options.config ?? brushConfig(tool, width, points);
  const input = freehandInput(points, options.buffer ?? []);
  const outline = getStroke(input, {
    size: cfg.size,
    thinning: cfg.thinning,
    smoothing: cfg.smoothing,
    streamline: cfg.streamline,
    simulatePressure: cfg.simulatePressure,
    start: { taper: options.noStartTaper ? 0 : cfg.taperStart * cfg.size, cap: cfg.cap },
    end: { taper: options.noEndTaper ? 0 : cfg.taperEnd * cfg.size, cap: cfg.cap },
    last: true,
  });
  return outlineToPath(outline, makePath);
}

export interface DrawStrokeOptions {
  /** Draw the vector shapes for shape-tool strokes. */
  includeShapes?: boolean;
  /** Outline already built by the caller and safe to reuse. */
  path?: Path2D;
  /** No taper on the moving end, for a piece of a growing live stroke. */
  noEndTaper?: boolean;
}

/**
 * Paints one stroke onto a context whose transform is already in document
 * space. Kept allocation-light because it runs for every visible stroke on
 * every full repaint.
 */
export function drawStroke(
  ctx: CanvasRenderingContext2D,
  stroke: Stroke,
  options: DrawStrokeOptions = {},
): void {
  if (stroke.points.length === 0) return;
  ctx.save();
  ctx.globalAlpha = stroke.opacity;
  ctx.fillStyle = stroke.color;
  ctx.strokeStyle = stroke.color;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  if (stroke.shape) {
    const a = stroke.points[0]!;
    const b = stroke.points[stroke.points.length - 1]!;
    const path = options.path ?? shapeOutlinePath(stroke.shape, a, b);
    ctx.lineWidth = stroke.width;
    ctx.stroke(path);
    ctx.restore();
    return;
  }

  if (options.includeShapes === false) {
    ctx.restore();
    return;
  }

  if (stroke.tool === 'highlighter') {
    ctx.globalCompositeOperation = 'multiply';
  }

  const path =
    options.path ?? strokePath(stroke.points, stroke.tool, stroke.width, { noEndTaper: options.noEndTaper });
  ctx.fill(path);

  if (stroke.tool === 'pencil') {
    // Graphite edge: a thin, lighter second pass softens the filled core.
    ctx.globalAlpha = stroke.opacity * 0.35;
    ctx.lineWidth = Math.max(0.5, stroke.width * 0.18);
    ctx.stroke(path);
  }
  ctx.restore();
}
