import { describe, expect, it } from 'vitest';
import { looksLikeScribble } from './scribble';

function zigzag(passes: number, length: number, step = 2): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  for (let pass = 0; pass < passes; pass++) {
    const direction = pass % 2 === 0 ? 1 : -1;
    for (let i = 0; i <= length; i += step) {
      points.push({ x: 100 + (direction > 0 ? i : length - i), y: 100 + pass * 6 });
    }
  }
  return points;
}

describe('looksLikeScribble', () => {
  it('accepts a dense back-and-forth over a small area', () => {
    expect(looksLikeScribble(zigzag(8, 90), 1)).toBe(true);
  });

  it('rejects a single long line', () => {
    const line = Array.from({ length: 60 }, (_, i) => ({ x: 100 + i * 4, y: 120 }));
    expect(looksLikeScribble(line, 1)).toBe(false);
  });

  it('rejects handwriting-like arcs with few reversals', () => {
    const points: { x: number; y: number }[] = [];
    for (let i = 0; i < 80; i++) {
      points.push({ x: 100 + i * 1.2, y: 160 + Math.sin(i / 4) * 12 });
    }
    expect(looksLikeScribble(points, 1)).toBe(false);
  });

  it('rejects a scrub drawn far too large to be deliberate', () => {
    expect(looksLikeScribble(zigzag(8, 90), 4)).toBe(false);
  });

  it('ignores a tap', () => {
    expect(looksLikeScribble([{ x: 10, y: 10 }], 1)).toBe(false);
  });
});
