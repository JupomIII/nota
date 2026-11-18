/**
 * Palm rejection, kept pure so the rules can be tested without a canvas.
 *
 * The pencil is active from the moment it touches down until it lifts. Touches
 * inside that window belong to the hand holding the pencil, never to navigation.
 * The moments after the pencil lifts are not the same thing: the hand at rest and
 * the fingers of the next pinch arrive there alike, so that window no longer
 * decides anything on its own.
 */

export interface PalmGuard {
  /** The user's setting; when off, every touch is navigation. */
  palmRejection: boolean;
  /** True between pencil down and pen up. */
  penDown: boolean;
  /** Milliseconds since the pencil last lifted; negative when it never has. */
  sincePenUp: number;
  /** True while a pencil-driven session owns the page. */
  penSession: boolean;
}

/**
 * A hand that lands this soon after the pencil lifts is still the same hand.
 *
 * It is a hold-back, not a rejection: a finger that arrives inside the window is
 * tracked at once, because it is the first finger of a pinch as often as it is
 * the hand that was just holding the pencil. What waits is one-finger panning,
 * which is the only thing a resting hand could do to the page behind `penDown`.
 */
export const PALM_GRACE_MS = 350;

const PEN_SESSIONS = new Set(['draw', 'shape', 'erase', 'lasso', 'move', 'resize']);

/** Sessions started by the pencil, which a stray touch must never interrupt. */
export function isPenSession(kind: string): boolean {
  return PEN_SESSIONS.has(kind);
}

/**
 * Should this touch be dropped altogether?
 *
 * Only the pencil's own authority is a reason to drop one. Width is not: a finger
 * pressed flat reports a wide contact and is still a finger, and a fixed
 * threshold on it is what used to stop pads-of-the-fingers pinching. The hand is
 * kept out of the gestures by comparing contacts instead (`isPalmContact`,
 * `pickPinchPair`), and out of panning by `inPenGrace`.
 */
export function shouldRejectTouch(guard: PalmGuard): boolean {
  if (!guard.palmRejection) return false;
  if (guard.penDown) return true;
  return guard.penSession;
}

/**
 * Is the hold-back that follows the pencil still running?
 *
 * While it runs, a lone finger that lands is tracked and ready to be half of a
 * pinch, but it does not start panning: a hand still resting beside the pencil
 * would otherwise drag the page the writer just wrote on. A second finger makes
 * the gesture a pinch straight away, whatever this answers.
 */
export function inPenGrace(guard: Pick<PalmGuard, 'sincePenUp'>): boolean {
  return guard.sincePenUp >= 0 && guard.sincePenUp < PALM_GRACE_MS;
}

/**
 * Picks the two contacts that drive a pinch.
 *
 * A finger reports a narrow contact whether it is upright or flattened on the
 * glass, while the hand resting behind it always reports a wider one. Choosing
 * the two narrowest contacts therefore finds the fingers whatever their surface
 * area is, with no threshold that has to be tuned per device or per grip.
 */
export function pickPinchPair(touches: readonly { w: number }[]): [number, number] | null {
  if (touches.length < 2) return null;
  let first = -1;
  let second = -1;
  for (let i = 0; i < touches.length; i += 1) {
    const w = touches[i]!.w;
    if (first < 0 || w < touches[first]!.w) {
      second = first;
      first = i;
    } else if (second < 0 || w < touches[second]!.w) {
      second = i;
    }
  }
  if (first < 0 || second < 0) return null;
  // Report them in the order they landed so the pair keeps its roles.
  return first < second ? [first, second] : [second, first];
}

/** A contact this wide is a hand even when the device reports fingers wide. */
export const PALM_MIN_PX = 110;

/** ...and it has to be this much wider than the fingers actually in use. */
export const PALM_FINGER_RATIO = 1.5;

/**
 * True for a contact that is clearly a hand rather than a finger.
 *
 * Width alone cannot decide: a finger pressed flat reports a wide contact and is
 * still a finger, which is why a fixed threshold breaks pinch on the pads of the
 * fingers. The comparison is therefore against the widths of the contacts this
 * device has actually seen, so the rule follows the grip instead of the spec.
 * With no history nothing is a palm: blocking the first contact would be worse
 * than letting one through.
 */
export function isPalmContact(width: number, fingerWidth: number): boolean {
  if (fingerWidth <= 0) return false;
  if (width < PALM_MIN_PX) return false;
  return width >= fingerWidth * PALM_FINGER_RATIO;
}

/** Middle value: one wide contact among narrow ones does not move the reference. */
export function medianWidth(widths: readonly number[]): number {
  if (widths.length === 0) return 0;
  const sorted = [...widths].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}
