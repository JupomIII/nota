import { describe, expect, it } from 'vitest';
import {
  PINCH_HINT_PX,
  SCRUB_START_PX,
  SWEEP_SEPARATION_PX,
  classifyTwoFinger,
  peakSpread,
  sweep,
} from './scrub';

const GRIP = 120;

describe('peakSpread', () => {
  it('keeps the worst separation change, not the current one', () => {
    const peak = peakSpread(0, GRIP, GRIP + 2);
    expect(peak).toBe(2);
    // Easing back to the original grip does not take the evidence away.
    expect(peakSpread(peak, GRIP, GRIP)).toBe(2);
  });

  it('counts closing the fingers as well as spreading them', () => {
    expect(peakSpread(0, GRIP, GRIP - 2)).toBe(2);
  });
});

describe('sweep', () => {
  it('adds up the travel of a pair that holds its separation', () => {
    let state = { originDist: GRIP, travelPx: 0 };
    for (let i = 0; i < 30; i += 1) state = sweep(state, GRIP + 0.4, 1);
    expect(state.travelPx).toBeCloseTo(30, 10);
  });

  it('restarts as soon as the separation drifts past the band', () => {
    let state = { originDist: GRIP, travelPx: 0 };
    state = sweep(state, GRIP, 20);
    expect(state.travelPx).toBe(20);
    state = sweep(state, GRIP + SWEEP_SEPARATION_PX + 0.1, 1);
    expect(state.travelPx).toBe(0);
    expect(state.originDist).toBeCloseTo(GRIP + SWEEP_SEPARATION_PX + 0.1, 10);
  });

  it('never arms the eraser on a pinch that drifts slowly', () => {
    // A pinch whose fingers part by 4 px while the pair slides 60 px: 4 % of the
    // grip, well inside what a hand does, and no single sample looks like a pinch
    // (0.067 px per event). The sweep still restarts whenever the drift passes the
    // band, so it can never reach the sweep a rub needs — and the zoom is named on
    // the way.
    let state = { originDist: GRIP, travelPx: 0 };
    let peak = 0;
    for (let i = 0; i < 60; i += 1) {
      const dist = GRIP + i * (4 / 60);
      peak = peakSpread(peak, GRIP, dist);
      state = sweep(state, dist, 1);
      expect(state.travelPx).toBeLessThan(SCRUB_START_PX);
      expect(classifyTwoFinger({ peakSpreadPx: peak, sweepTravelPx: state.travelPx })).not.toBe('scrub');
    }
    expect(peak).toBeGreaterThanOrEqual(PINCH_HINT_PX);
  });

  it('reaches the eraser on a rub that holds its grip', () => {
    // The same 60 px of travel, with the separation held: this is a rub, and it
    // erases well before the end of the sweep.
    let state = { originDist: GRIP, travelPx: 0 };
    let peak = 0;
    let armed = false;
    for (let i = 0; i < 60; i += 1) {
      peak = peakSpread(peak, GRIP, GRIP);
      state = sweep(state, GRIP, 1);
      if (classifyTwoFinger({ peakSpreadPx: peak, sweepTravelPx: state.travelPx }) === 'scrub') {
        armed = true;
        break;
      }
    }
    expect(armed).toBe(true);
  });
});
