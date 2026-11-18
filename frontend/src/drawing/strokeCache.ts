import type { Stroke } from '../storage/types';
import { boundsIntersect, shapeOutlinePath, type Bounds } from '../lib/geometry';
import type { StrokeGrid } from './spatial';
import { strokePath, type FreehandInput, type PathFactory } from './strokeRender';

/**
 * The two hot-path pieces of a repaint, out of the engine so they can be
 * measured: the outline of each stroke, and which strokes the viewport holds.
 *
 * Both used to be paid for the whole page on every repaint. Neither allocates per
 * frame now, and neither looks at ink the viewport cannot show.
 */

interface CacheEntry {
  points: number;
  updatedAt: number;
  width: number;
  tool: Stroke['tool'];
  shape: Stroke['shape'];
  path: Path2D;
}

/**
 * Outlines of committed strokes, rebuilt only when the stroke itself changed.
 *
 * The stamp is compared field by field instead of being formatted into a string:
 * a full repaint used to allocate one template string per visible stroke, on every
 * repaint, purely to find out that nothing had changed.
 */
export class StrokePathCache {
  private readonly entries = new Map<string, CacheEntry>();
  /** Perfect-freehand input, reused for every build: no per-point allocation. */
  private readonly buffer: FreehandInput[] = [];
  /** Outlines actually built; a repaint of unchanged ink must not increase it. */
  builds = 0;

  constructor(
    private readonly limit = 4000,
    private readonly makePath?: PathFactory,
  ) {}

  pathFor(stroke: Stroke): Path2D {
    const cached = this.entries.get(stroke.id);
    if (
      cached &&
      cached.points === stroke.points.length &&
      cached.updatedAt === stroke.updatedAt &&
      cached.width === stroke.width &&
      cached.tool === stroke.tool &&
      cached.shape === stroke.shape
    ) {
      return cached.path;
    }
    const path = stroke.shape
      ? shapeOutlinePath(stroke.shape, stroke.points[0]!, stroke.points[stroke.points.length - 1]!)
      : strokePath(stroke.points, stroke.tool, stroke.width, {
          buffer: this.buffer,
          makePath: this.makePath,
        });
    this.builds += 1;
    if (this.entries.size > this.limit) this.entries.clear();
    this.entries.set(stroke.id, {
      points: stroke.points.length,
      updatedAt: stroke.updatedAt,
      width: stroke.width,
      tool: stroke.tool,
      shape: stroke.shape,
      path,
    });
    return path;
  }

  forget(id: string): void {
    this.entries.delete(id);
  }

  clear(): void {
    this.entries.clear();
    this.buffer.length = 0;
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Strokes the viewport can show, in the order they were drawn.
 *
 * The grid answers with a superset of what overlaps the viewport, so the page's
 * total ink no longer enters the cost of a repaint: a long, zoomed-in page pays
 * for what is on screen, not for the whole note. The order is restored explicitly
 * because overlapping ink must stack exactly as it was written, and the grid hands
 * its cells back in no particular order.
 *
 * The returned array and the id set are reused between calls: read the result
 * before asking again.
 */
export class InkView {
  private readonly ids = new Set<string>();
  private readonly list: Stroke[] = [];

  constructor(
    private readonly strokeById: Map<string, Stroke>,
    private readonly boundsFor: (id: string) => Bounds | undefined,
    private readonly orderOf: (id: string) => number,
  ) {}

  /**
   * Fallback for a page whose index and stroke list disagree: the whole list, in
   * document order. Slower, but it can never hide ink the user wrote.
   */
  scan(strokes: readonly Stroke[], viewport: Bounds): Stroke[] {
    const list = this.list;
    list.length = 0;
    for (const stroke of strokes) {
      const bounds = this.boundsFor(stroke.id);
      if (bounds && boundsIntersect(bounds, viewport)) list.push(stroke);
    }
    return list;
  }

  visible(index: StrokeGrid, viewport: Bounds): Stroke[] {
    const list = this.list;
    list.length = 0;
    this.ids.clear();
    index.query(viewport, this.ids);
    for (const id of this.ids) {
      const stroke = this.strokeById.get(id);
      if (!stroke) continue;
      const bounds = this.boundsFor(id);
      if (!bounds || !boundsIntersect(bounds, viewport)) continue;
      list.push(stroke);
    }
    list.sort((a, b) => this.orderOf(a.id) - this.orderOf(b.id));
    return list;
  }
}
