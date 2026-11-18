import { boundsIntersect, type Bounds } from '../lib/geometry';

/**
 * A uniform grid over stroke bounds, so erasing looks at the strokes near the
 * finger instead of the whole page. Without it every contact point of a scrub
 * walks the entire document and the cost of one erase grows with the note.
 *
 * A stroke too large for a sensible number of cells is kept aside and returned
 * for every query, which keeps insertion linear and never misses ink.
 */

/** Document points per cell: small enough to be precise, large enough to be cheap. */
const DEFAULT_CELL = 96;

/** A stroke spanning more cells than this is stored as a single big entry. */
const MAX_CELLS_PER_STROKE = 64;

function cellKey(cx: number, cy: number): number {
  // Two coordinates folded into one number, centred so negatives work.
  return (cx + 32768) * 65536 + (cy + 32768);
}

export class StrokeGrid {
  private cells = new Map<number, Set<string>>();
  private entries = new Map<string, { keys: number[]; big: boolean }>();
  private big = new Set<string>();

  constructor(private readonly cellSize: number = DEFAULT_CELL) {}

  clear(): void {
    this.cells.clear();
    this.entries.clear();
    this.big.clear();
  }

  /** Inserts or replaces one entry. */
  set(id: string, bounds: Bounds): void {
    this.delete(id);
    const x0 = Math.floor(bounds.minX / this.cellSize);
    const y0 = Math.floor(bounds.minY / this.cellSize);
    const x1 = Math.floor(bounds.maxX / this.cellSize);
    const y1 = Math.floor(bounds.maxY / this.cellSize);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS_PER_STROKE) {
      this.big.add(id);
      this.entries.set(id, { keys: [], big: true });
      return;
    }
    const keys: number[] = [];
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const key = cellKey(cx, cy);
        let bucket = this.cells.get(key);
        if (!bucket) {
          bucket = new Set();
          this.cells.set(key, bucket);
        }
        bucket.add(id);
        keys.push(key);
      }
    }
    this.entries.set(id, { keys, big: false });
  }

  delete(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    if (entry.big) {
      this.big.delete(id);
      return;
    }
    for (const key of entry.keys) {
      const bucket = this.cells.get(key);
      if (!bucket) continue;
      bucket.delete(id);
      if (bucket.size === 0) this.cells.delete(key);
    }
  }

  /** Ids whose bounds may intersect `area`; a superset, never a miss. */
  query(area: Bounds, out: Set<string> = new Set()): Set<string> {
    for (const id of this.big) out.add(id);
    const x0 = Math.floor(area.minX / this.cellSize);
    const y0 = Math.floor(area.minY / this.cellSize);
    const x1 = Math.floor(area.maxX / this.cellSize);
    const y1 = Math.floor(area.maxY / this.cellSize);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const bucket = this.cells.get(cellKey(cx, cy));
        if (!bucket) continue;
        for (const id of bucket) out.add(id);
      }
    }
    return out;
  }

  /** Ids whose bounds really overlap `area`, for repainting one rectangle. */
  queryExact(area: Bounds, boundsFor: (id: string) => Bounds | undefined): string[] {
    const found: string[] = [];
    for (const id of this.query(area)) {
      const bounds = boundsFor(id);
      if (bounds && boundsIntersect(bounds, area)) found.push(id);
    }
    return found;
  }

  get size(): number {
    return this.entries.size;
  }
}
