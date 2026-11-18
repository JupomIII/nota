import { describe, expect, it } from 'vitest';
import {
  MAX_SCALE,
  MIN_SCALE,
  PINCH_PAD,
  SCRUB_START_PX,
  SCRUB_TO_PAN_PX,
  classifyTwoFinger,
  pinchBase,
  pinchScale,
  scrubTurnsIntoPan,
} from './scrub';

const start = { x: 500, y: 400 };

/** The evidence a gesture has accumulated: worst spread seen, clean sweep made. */
const evidence = (peakSpreadPx: number, sweepTravelPx: number) => ({
  peakSpreadPx,
  sweepTravelPx,
});

describe('classifyTwoFinger', () => {
  it('keeps a gesture undecided while nothing has happened', () => {
    expect(classifyTwoFinger(evidence(0, 0))).toBe('undecided');
  });

  it('keeps a division by zero impossible for fingers on top of each other', () => {
    expect(pinchBase(0)).toBe(PINCH_PAD);
  });
});

/* The rule under test: a pinch is drafted by spreading the fingers, never by
   holding them still, so a few pixels of spread outweigh any amount of travel. */
describe('pinch versus two-finger erase', () => {
  it('is a zoom whatever the pair travelled while the fingers spread', () => {
    // A pinch whose midpoint slides 0 to 60 px: it is still a zoom, and the
    // eraser must never see it, however much clean travel came with it.
    for (const spread of [2.5, 3, 4, 6]) {
      for (const travel of [0, 10, 20, 30, 45, 60]) {
        expect(classifyTwoFinger(evidence(spread, travel))).toBe('pinch');
      }
    }
  });

  it('is still a zoom when the fingers started very close together', () => {
    // The threshold is in screen pixels, not a share of the grip, so a pinch
    // begun with the fingertips touching is read exactly like a hand-span one.
    for (const travel of [0, 12, 60]) {
      expect(classifyTwoFinger(evidence(2.5, travel))).toBe('pinch');
    }
  });

  it('keeps the zoom once the separation has moved, even after it eases back', () => {
    // A pinch that overshoots by 5 px and settles is still a pinch: the peak is
    // what the eraser is tested against, never the sample under the fingers.
    expect(classifyTwoFinger(evidence(5, 0))).toBe('pinch');
    expect(classifyTwoFinger(evidence(5, 40))).toBe('pinch');
  });

  it('still erases on a deliberate sweep that holds its separation', () => {
    for (const travel of [SCRUB_START_PX, 30, 44]) {
      expect(classifyTwoFinger(evidence(0, travel))).toBe('scrub');
    }
  });

  it('paints nothing while the gesture is still deciding', () => {
    // Short of a deliberate sweep, with no spread: neither a zoom nor a rub, so no
    // eraser cue and no erased ink can appear before the gesture is known.
    expect(classifyTwoFinger(evidence(0, SCRUB_START_PX - 4))).toBe('undecided');
    expect(classifyTwoFinger(evidence(0.8, SCRUB_START_PX - 4))).toBe('undecided');
  });
});

describe('pinchScale', () => {
  it('opens at exactly the scale the pinch started from, whatever the spacing', () => {
    for (const spacing of [0, 2, 8, 12, 24, 60, 120, 400]) {
      expect(pinchScale(1, spacing, spacing)).toBeCloseTo(1, 10);
      expect(pinchScale(0.72, spacing, spacing)).toBeCloseTo(0.72, 10);
    }
  });

  it('zooms on the first pixels of spread with the fingertips together', () => {
    // Fingers 8 px apart, then 10 px more: flooring the distance at 24 px used to
    // hold the sheet at exactly the scale it had, so a fingertip pinch did
    // nothing until the fingers parted by the whole floor and then jumped.
    expect(pinchScale(1, 8, 18)).toBeGreaterThan(1.2);
    expect(pinchScale(1, 2, 12)).toBeGreaterThan(1.2);
    expect(pinchScale(1, 0, 10)).toBeGreaterThan(1.3);
  });

  it('gives a 10 px spread a visible, proportional change at every spacing', () => {
    for (const spacing of [2, 8, 12, 24, 60, 120, 200, 400]) {
      const grown = pinchScale(1, spacing, spacing + 10);
      expect(grown).toBeGreaterThan(1);
      // Never more than the fingers really spread out by...
      expect(grown).toBeLessThanOrEqual((spacing + 10) / spacing + 1e-9);
      // ...and within a tenth of it for a hand-span grip.
      if (spacing >= 120) expect(grown).toBeCloseTo((spacing + 10) / spacing, 1);
    }
  });

  it('is monotone over a close-to-wide pinch', () => {
    const scales = [2, 6, 12, 24, 30, 60, 120, 240].map((d) => pinchScale(1, 2, d));
    for (let i = 1; i < scales.length; i++) expect(scales[i]!).toBeGreaterThan(scales[i - 1]!);
  });

  it('closes the sheet when the fingers close in', () => {
    expect(pinchScale(1, 120, 60)).toBeLessThan(1);
    expect(pinchScale(1, 120, 0)).toBeCloseTo(PINCH_PAD / (120 + PINCH_PAD), 10);
  });

  it('clamps to the zoom range', () => {
    expect(pinchScale(1, 24, 100000)).toBe(MAX_SCALE);
    expect(pinchScale(1, 800, 24)).toBe(MIN_SCALE);
  });
});

describe('scrubTurnsIntoPan', () => {
  it('lets a rub that crossed no ink become a pan', () => {
    expect(
      scrubTurnsIntoPan(start, { dist: 120, mid: { x: 500 + SCRUB_TO_PAN_PX, y: 400 } }, false),
    ).toBe(true);
  });

  it('keeps erasing once the rub has removed something', () => {
    expect(
      scrubTurnsIntoPan(start, { dist: 120, mid: { x: 500 + SCRUB_TO_PAN_PX * 3, y: 400 } }, true),
    ).toBe(false);
  });

  it('does not give up before the sweep is deliberate', () => {
    expect(scrubTurnsIntoPan(start, { dist: 120, mid: { x: 505, y: 400 } }, false)).toBe(false);
  });
});
