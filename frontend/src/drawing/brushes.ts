import type { DrawToolId, StrokePoint } from '../storage/types';

export interface FreehandConfig {
  size: number;
  thinning: number;
  smoothing: number;
  streamline: number;
  taperStart: number;
  taperEnd: number;
  cap: boolean;
  simulatePressure: boolean;
}

const BASE: Record<string, Omit<FreehandConfig, 'size' | 'simulatePressure'>> = {
  fountain: {
    thinning: 0.74,
    smoothing: 0.55,
    streamline: 0.42,
    taperStart: 0.22,
    taperEnd: 0.32,
    cap: true,
  },
  ballpoint: {
    thinning: 0.36,
    smoothing: 0.5,
    streamline: 0.45,
    taperStart: 0.06,
    taperEnd: 0.1,
    cap: true,
  },
  pencil: {
    thinning: 0.28,
    smoothing: 0.38,
    streamline: 0.3,
    taperStart: 0.12,
    taperEnd: 0.18,
    cap: true,
  },
  highlighter: {
    thinning: 0.04,
    smoothing: 0.6,
    streamline: 0.7,
    taperStart: 0,
    taperEnd: 0,
    cap: true,
  },
};

export function averageTilt(points: StrokePoint[]): number {
  if (points.length === 0) return 0;
  let sum = 0;
  for (const p of points) {
    const t = Math.min(90, Math.hypot(p.tiltX || 0, p.tiltY || 0));
    sum += t / 90;
  }
  return sum / points.length;
}

export function hasRealPressure(points: StrokePoint[]): boolean {
  if (points.length < 3) return false;
  let min = 1;
  let max = 0;
  for (const p of points) {
    if (p.pressure < min) min = p.pressure;
    if (p.pressure > max) max = p.pressure;
  }
  return max - min > 0.02;
}

/**
 * The brush, given what only the points can decide.
 *
 * Split out so a stroke painted in pieces can be handed the configuration of
 * the whole stroke: a piece resolving its own would taper its start differently
 * from the line it belongs to.
 */
export function configFor(
  tool: DrawToolId,
  width: number,
  simulatePressure: boolean,
  tilt = 0,
): FreehandConfig {
  const base = BASE[tool] ?? BASE.ballpoint!;
  return {
    ...base,
    size: tool === 'pencil' ? width * (1 + tilt * 0.55) : width,
    simulatePressure,
  };
}

/**
 * Resolves the perfect-freehand configuration for a tool. Tilt widens the
 * graphite/pencil nib, which is the closest practical mapping of hardware tilt
 * that Safari exposes.
 */
export function brushConfig(tool: DrawToolId, width: number, points: StrokePoint[]): FreehandConfig {
  return configFor(
    tool,
    width,
    !hasRealPressure(points),
    tool === 'pencil' ? averageTilt(points) : 0,
  );
}
