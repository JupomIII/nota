import type { StrokePoint } from '../storage/types';

/**
 * The work one pointermove does on a freehand stroke, before anything is drawn.
 *
 * A pencil reports 240 samples a second, so this runs a few times per frame and
 * four times a frame on a 60 Hz iPad. It is here, rather than inside the engine,
 * so the per-event cost can be measured outside the browser and so the engine and
 * that measurement run the same arithmetic instead of two copies of it.
 */

export interface ViewLike {
  scale: number;
  tx: number;
  ty: number;
}

/** Smallest gap between recorded points, in screen pixels at the current zoom. */
export const MIN_NIB_SCREEN_DISTANCE = 0.35;

/**
 * A screen contact as a point of the page, with the pressure the brush will use.
 *
 * `pressure` arrives already chosen (pen force or the flat pressure of a mouse);
 * the clamp to 1 is the stroke's, because no brush reads more than full force.
 */
export function inkPointAt(
  screenX: number,
  screenY: number,
  pressure: number,
  tiltX: number,
  tiltY: number,
  timestamp: number,
  view: ViewLike,
): StrokePoint {
  return {
    x: (screenX - view.tx) / view.scale,
    y: (screenY - view.ty) / view.scale,
    pressure: Math.min(1, pressure),
    tiltX,
    tiltY,
    timestamp,
  };
}

/**
 * Pencil pressure is noisy at low force; an exponential average keeps the line
 * weight steady without lagging behind a deliberate press.
 */
export function smoothPressure(previous: number, next: number): number {
  return previous > 0 ? previous + (next - previous) * 0.45 : next;
}

/**
 * Has the nib moved far enough on screen to be worth a point?
 *
 * The threshold is in screen pixels, so it tightens as the page is zoomed out:
 * the same finger travel has to be a real move on glass, not a postage stamp of
 * the page. The floor keeps a tiny scale from asking for a mile per point.
 */
export function nibHasMoved(
  from: StrokePoint,
  to: StrokePoint,
  minScreenDistance: number,
  scale: number,
): boolean {
  const gap = minScreenDistance / Math.max(0.15, scale);
  return Math.hypot(to.x - from.x, to.y - from.y) >= gap;
}
