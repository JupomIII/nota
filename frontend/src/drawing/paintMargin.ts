/**
 * How much page a gesture keeps painted around the viewport.
 *
 * Panning and pinching never rasterise: the layers painted at their current view
 * are stretched by the compositor. That only works while the view stays inside
 * the page those layers actually hold pixels for, so a gesture that outgrows them
 * pays for a repaint — at a coarser scale, which is why the margin has to stay a
 * compromise.
 *
 * A fixed margin means a long zoom-out outgrows it again and again: each repaint
 * buys the same 1.6×, the fingers take more than that, and the next frame asks for
 * another full repaint. Widening the margin after each miss keeps that off the
 * frame loop: the second repaint of a gesture covers every remaining frame of it.
 * The first one is unchanged, so a gesture that never outgrows the margin — which
 * is most of them — looks exactly as it did.
 */

/** Page painted around the viewport, as a multiple of the viewport itself. */
export const PAINT_MARGIN = 1.6;

/**
 * Ceiling for the widened margin. Past this the layers hold so much page that a
 * single repaint costs more than the frames it saves, and the preview is soft
 * enough to notice.
 */
export const PAINT_MARGIN_MAX = 4.4;

/** The margin to use for the next repaint of the same gesture. */
export function widenPaintMargin(current: number): number {
  return Math.min(PAINT_MARGIN_MAX, current * 1.6);
}
