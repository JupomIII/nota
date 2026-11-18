import { distance, pinchScale, type Point } from './scrub';

export interface ViewTransform {
  scale: number;
  tx: number;
  ty: number;
}

/**
 * Where a two-finger gesture takes its measurements from.
 *
 * It is always taken from the view that is on screen at that instant. The first
 * finger of a pinch lands alone and pans, so the sheet has usually moved a little
 * by the time the second one arrives; re-anchoring on the live view makes the
 * zoom grow out of what the eye is already looking at. Anchoring anywhere else —
 * the view before the pan, for instance — moves the sheet under the fingers at
 * the exact moment the second one lands, which reads as a jump.
 */
export interface PinchAnchor {
  /** Distance between the two contacts when the pinch took over, in screen px. */
  startDist: number;
  /** Midpoint of the two contacts then, in screen px. */
  startMid: Point;
  startScale: number;
  /** The view on screen then. */
  startView: ViewTransform;
}

/** Anchors a pinch on the view and the two contacts as they are now. */
export function pinchAnchor(view: ViewTransform, a: Point, b: Point): PinchAnchor {
  return {
    // Deliberately raw: `pinchScale` adds its slack to both distances, so a
    // floor here would be a second, unmatched one — exactly the step this anchor
    // exists to avoid.
    startDist: distance(a, b),
    startMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    startScale: view.scale,
    startView: { ...view },
  };
}

/**
 * The view a pinch asks for, given where its two fingers are now.
 *
 * The point of the page under the fingers' midpoint stays under that midpoint,
 * so the sheet zooms around the hand instead of around the middle of the screen.
 */
export function pinchView(anchor: PinchAnchor, dist: number, mid: Point): ViewTransform {
  const scale = pinchScale(anchor.startScale, anchor.startDist, dist);
  const applied = scale / anchor.startScale;
  return {
    scale,
    tx: mid.x - (anchor.startMid.x - anchor.startView.tx) * applied,
    ty: mid.y - (anchor.startMid.y - anchor.startView.ty) * applied,
  };
}
