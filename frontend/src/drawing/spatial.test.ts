import { describe, expect, it } from 'vitest';
import { StrokeGrid } from './spatial';

const box = (minX: number, minY: number, w: number, h: number) => ({
  minX,
  minY,
  maxX: minX + w,
  maxY: minY + h,
});

describe('StrokeGrid', () => {
  it('finds an entry whose bounds overlap the query', () => {
    const grid = new StrokeGrid(50);
    grid.set('a', box(0, 0, 20, 20));
    grid.set('b', box(400, 400, 20, 20));
    expect([...grid.query(box(5, 5, 10, 10))]).toEqual(['a']);
  });

  it('misses nothing that lies inside the query, even across cells', () => {
    const grid = new StrokeGrid(50);
    grid.set('long', box(0, 0, 300, 10));
    expect([...grid.query(box(280, 5, 5, 5))]).toEqual(['long']);
  });

  it('never forgets a stroke too large to bucket', () => {
    const grid = new StrokeGrid(10);
    grid.set('huge', box(0, 0, 5000, 5000));
    expect([...grid.query(box(4000, 4000, 1, 1))]).toEqual(['huge']);
  });

  it('replaces an entry when it moves', () => {
    const grid = new StrokeGrid(50);
    grid.set('a', box(0, 0, 10, 10));
    grid.set('a', box(500, 500, 10, 10));
    expect([...grid.query(box(0, 0, 5, 5))]).toEqual([]);
    expect([...grid.query(box(505, 505, 5, 5))]).toEqual(['a']);
    expect(grid.size).toBe(1);
  });

  it('drops an entry on delete', () => {
    const grid = new StrokeGrid(50);
    grid.set('a', box(0, 0, 10, 10));
    grid.delete('a');
    expect([...grid.query(box(0, 0, 5, 5))]).toEqual([]);
    expect(grid.size).toBe(0);
  });

  it('filters a loose query down to real overlap for a repaint', () => {
    const grid = new StrokeGrid(50);
    grid.set('a', box(0, 0, 5, 5));
    grid.set('b', box(40, 40, 5, 5));
    const bounds = { a: box(0, 0, 5, 5), b: box(40, 40, 5, 5) };
    // Cell-sharing returns both; only one really reaches the rect.
    expect([...grid.query(box(0, 0, 2, 2))].sort()).toEqual(['a', 'b']);
    expect(grid.queryExact(box(0, 0, 2, 2), (id) => bounds[id as 'a' | 'b'])).toEqual(['a']);
  });

  it('does not leak ids when a cell empties', () => {
    const grid = new StrokeGrid(50);
    grid.set('a', box(0, 0, 10, 10));
    grid.delete('a');
    grid.set('b', box(200, 200, 10, 10));
    expect([...grid.query(box(0, 0, 5, 5))]).toEqual([]);
  });
});
