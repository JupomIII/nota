/**
 * Scribble to erase, the way Goodnotes does it: a dense back-and-forth over
 * ink removes it instead of leaving a smudge. The test is deliberately strict —
 * handwriting is dense too, but it does not reverse direction ten times inside
 * a few centimetres, and it is not drawn in one stroke over existing ink.
 */
export interface ScribblePoint {
  x: number;
  y: number;
}

export interface ScribbleOptions {
  /** Direction reversals along the dominant axis before it counts. */
  minTurns?: number;
  /** Path length as a multiple of the box diagonal. */
  minDensity?: number;
  /** Largest screen size, in CSS pixels, of a deliberate scrub. */
  maxScreenDiagonal?: number;
}

export function looksLikeScribble(
  points: ScribblePoint[],
  scale = 1,
  options: ScribbleOptions = {},
): boolean {
  const minTurns = options.minTurns ?? 5;
  const minDensity = options.minDensity ?? 5;
  const maxScreenDiagonal = options.maxScreenDiagonal ?? 230;
  if (points.length < 12) return false;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let length = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
    if (i > 0) {
      const q = points[i - 1]!;
      length += Math.hypot(p.x - q.x, p.y - q.y);
    }
  }

  const width = maxX - minX;
  const height = maxY - minY;
  const diagonal = Math.hypot(width, height);
  if (diagonal < 8) return false;
  // A scrub is small: a long swoop across the page is a stroke, not an eraser.
  if (diagonal * Math.max(0.05, scale) > maxScreenDiagonal) return false;
  if (length < diagonal * minDensity) return false;

  const alongX = width >= height;
  let turns = 0;
  let previous = 0;
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    const q = points[i - 1]!;
    const delta = alongX ? p.x - q.x : p.y - q.y;
    if (Math.abs(delta) < 0.4) continue;
    const sign = delta > 0 ? 1 : -1;
    if (previous !== 0 && sign !== previous) turns += 1;
    previous = sign;
  }
  return turns >= minTurns;
}
