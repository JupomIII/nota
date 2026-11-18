/**
 * What a two-finger gesture means, decided from what it has actually done.
 *
 * The candidates all start identically — two fingers on the glass — and the only
 * honest signal is the motion:
 *
 *   spreading or closing  -> zoom (the separation between the fingers changes)
 *   moving together       -> rub the ink away, or pan when there is none
 *   neither               -> still undecided, so a two-finger tap can undo
 *
 * Zoom has priority, and it wins on the smallest sign of it. Two pieces of
 * evidence are accumulated over the gesture instead of being tested sample by
 * sample, because a pinch and a rub look alike frame to frame:
 *
 *  1. the worst separation change seen (`peakSpread`), which the eraser can never
 *     undo — spreading is the one thing a rub never does;
 *  2. the midpoint travel made while the separation held (`sweep`), which resets
 *     the moment the separation drifts. A pinch drifts, however slowly, so its
 *     sweep is always being cut short; a rub holds its grip and slides, so its
 *     sweep adds up and arms the eraser.
 *
 * A pinch whose midpoint slides 60 px while its fingers part by a few pixels is
 * therefore a zoom: the drift keeps restarting the sweep, and the travel is not
 * evidence against zooming. Erasing ink is destructive, so the eraser only arms
 * on a pair that has kept its separation through a deliberate, uninterrupted
 * sweep. Nothing is erased, and nothing is even painted, while the gesture is
 * undecided — everything here is pure so the rules can be tested without a
 * canvas.
 */

export type TwoFingerMode = 'undecided' | 'pinch' | 'scrub' | 'pan';

/**
 * Separation change, in screen pixels, that already reads as a zoom.
 *
 * Deliberately an absolute distance rather than a share of the grip: two fingers
 * sliding together across the glass wobble by a pixel or two whatever the grip, so
 * a pixel floor is the same noise test for fingertips held close together and for
 * a hand-span pinch — where a ratio would call the same 3 px of spread a zoom on a
 * narrow grip and a rub on a wide one. It sits above that wobble and below any
 * intentional spread.
 */
export const PINCH_HINT_PX = 2.4;

/**
 * How far the fingers may drift, in screen pixels, during one sweep before the
 * sweep is considered interrupted.
 *
 * This is what keeps a slow pinch from being mistaken for a rub: a pinch that
 * changes its separation by a fraction of a pixel per event still drifts past
 * this band quickly, and every crossing restarts the sweep. A rub holds its grip
 * inside the band and keeps adding travel.
 */
export const SWEEP_SEPARATION_PX = 1;

/**
 * Distance the pair must travel with its separation held before the eraser arms.
 *
 * The sweep is uninterrupted by construction, so this is a measure of
 * deliberateness rather than a delay: a rub sweeps this far and erases, and a
 * pinch — whose sweep keeps restarting — never reaches it.
 */
export const SCRUB_START_PX = 22;

/**
 * Travel after which a rub that has touched nothing becomes a pan. Premium apps
 * keep two-finger panning available; this is how both can share the gesture.
 */
export const SCRUB_TO_PAN_PX = 44;

/**
 * Slack added to both finger distances before they are compared.
 *
 * Comparing raw distances left the zoom dead for fingers that start close
 * together: every distance was floored at 24 px, so a pinch begun 8 px apart did
 * not move the sheet at all until the fingers reached 24 px, and then jumped into
 * the zoom. The same slack on the distance under the fingers and on the one they
 * started from keeps the ratio exactly 1 at the moment of contact and smooth
 * everywhere else: the first pixels of spread are already a visible, proportional
 * zoom, whatever the fingers are doing when they land. A pinch begun with the
 * fingertips touching therefore opens at the scale it started from instead of
 * dividing by a few pixels.
 */
export const PINCH_PAD = 24;

export interface Point {
  x: number;
  y: number;
}

export interface TwoFingerSample {
  /** Distance between the two contacts, in screen pixels. */
  dist: number;
  /** Midpoint of the two contacts, in screen pixels. */
  mid: Point;
}

/** What the pair has shown so far, accumulated by the caller across the gesture. */
export interface TwoFingerState {
  /** Largest separation change seen since it began, in screen pixels. */
  peakSpreadPx: number;
  /** Midpoint travel made while the separation held, in screen pixels. */
  sweepTravelPx: number;
}

/** The sweep in progress: where the held separation started, and how far it went. */
export interface SweepState {
  /** Separation the current sweep is measured from, in screen pixels. */
  originDist: number;
  /** Midpoint travel accumulated inside the band, in screen pixels. */
  travelPx: number;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Distance used for the zoom ratio; never zero, so the division is safe. */
export function pinchBase(startDist: number): number {
  return Math.max(0, startDist) + PINCH_PAD;
}

/**
 * Largest separation change seen so far, in screen pixels.
 *
 * The peak, not the current value: a pinch whose spread overshoots and settles is
 * still a pinch, so a pixel of zoom that has been shown cannot be taken back by a
 * rub that follows it.
 */
export function peakSpread(previous: number, startDist: number, dist: number): number {
  return Math.max(previous, Math.abs(dist - startDist));
}

/**
 * Adds one sample to the sweep.
 *
 * Inside the band the pair is holding its grip, so the travel the midpoint made
 * since the last sample counts towards arming the eraser. Outside it the fingers
 * have changed their separation: the sweep is over, and the next one is measured
 * from the separation as it now stands. That reset is what makes a slow pinch
 * safe — it cannot accumulate the clean travel a rub needs, however small each
 * individual change is.
 */
export function sweep(state: SweepState, dist: number, stepPx: number): SweepState {
  if (Math.abs(dist - state.originDist) > SWEEP_SEPARATION_PX) {
    return { originDist: dist, travelPx: 0 };
  }
  return { originDist: state.originDist, travelPx: state.travelPx + stepPx };
}

/**
 * Names a two-finger gesture, or keeps it undecided.
 *
 * Zoom wins on the smallest sign of spread, wherever the midpoint has travelled.
 * The rub is what remains: a pair that has held its separation through a full,
 * uninterrupted sweep. An undecided gesture is neither — the sheet follows the
 * fingers' separation (the zoom is live from the first pixel) but the eraser stays
 * off, so nothing can be painted and then taken back.
 */
export function classifyTwoFinger(state: TwoFingerState): Exclude<TwoFingerMode, 'pan'> {
  if (state.peakSpreadPx >= PINCH_HINT_PX) return 'pinch';
  if (state.sweepTravelPx >= SCRUB_START_PX) return 'scrub';
  return 'undecided';
}

/**
 * Once a rub is under way, decides whether it should give up and become a pan.
 * A rub that crossed no ink after a deliberate sweep was never about erasing.
 */
export function scrubTurnsIntoPan(startMid: Point, sample: TwoFingerSample, touchedInk: boolean): boolean {
  if (touchedInk) return false;
  return distance(sample.mid, startMid) >= SCRUB_TO_PAN_PX;
}

/** Screen-space radius of the eraser a rub carries, in CSS pixels. */
export const SCRUB_RADIUS_PX = 14;

/** Zoom range the page allows. */
export const MIN_SCALE = 0.15;
export const MAX_SCALE = 8;

/**
 * Scale for a pinch in progress.
 *
 * Both distances carry the same slack, so the ratio is 1 when the pinch starts and
 * follows the fingers from the first pixel of travel: no starting distance is too
 * small to zoom, and none produces a step at the moment the gesture is picked up.
 */
export function pinchScale(startScale: number, startDist: number, dist: number): number {
  const ratio = (Math.max(0, dist) + PINCH_PAD) / pinchBase(startDist);
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, startScale * ratio));
}
