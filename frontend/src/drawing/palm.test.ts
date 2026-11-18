import { describe, expect, it } from 'vitest';
import {
  PALM_GRACE_MS,
  inPenGrace,
  isPalmContact,
  isPenSession,
  medianWidth,
  pickPinchPair,
  shouldRejectTouch,
} from './palm';

const pen = (over: Partial<Parameters<typeof shouldRejectTouch>[0]> = {}) => ({
  palmRejection: true,
  penDown: false,
  sincePenUp: Number.POSITIVE_INFINITY,
  penSession: false,
  contactSize: 0,
  ...over,
});

describe('palm rejection', () => {
  it('keeps every touch as navigation when the setting is off', () => {
    expect(shouldRejectTouch(pen({ palmRejection: false, penDown: true }))).toBe(false);
    expect(shouldRejectTouch(pen({ palmRejection: false, sincePenUp: 5 }))).toBe(false);
  });

  it('rejects touches while the pencil is in contact', () => {
    expect(shouldRejectTouch(pen({ penDown: true }))).toBe(true);
  });

  it('never drops a touch just because the pencil has lifted', () => {
    // The first finger of a pinch arrives in this window all the time; dropping
    // it made the gesture work only when both fingers waited for the clock.
    for (const sincePenUp of [-1, 0, 1, 120, PALM_GRACE_MS - 1, PALM_GRACE_MS, 1000]) {
      expect(shouldRejectTouch(pen({ sincePenUp }))).toBe(false);
    }
  });

  it('holds back one-finger panning while the hand is still down', () => {
    expect(inPenGrace({ sincePenUp: 0 })).toBe(true);
    expect(inPenGrace({ sincePenUp: PALM_GRACE_MS - 1 })).toBe(true);
    expect(inPenGrace({ sincePenUp: PALM_GRACE_MS })).toBe(false);
    expect(inPenGrace({ sincePenUp: 2000 })).toBe(false);
    expect(inPenGrace({ sincePenUp: -1 })).toBe(false);
  });

  it('treats every pencil session as owned, not just drawing', () => {
    for (const kind of ['draw', 'shape', 'erase', 'lasso', 'move', 'resize']) {
      expect(isPenSession(kind)).toBe(true);
      expect(shouldRejectTouch(pen({ penSession: isPenSession(kind) }))).toBe(true);
    }
    for (const kind of ['none', 'pan', 'pinch']) {
      expect(isPenSession(kind)).toBe(false);
      expect(shouldRejectTouch(pen({ penSession: isPenSession(kind) }))).toBe(false);
    }
  });

  it('does not treat a life without a pencil as palm activity', () => {
    expect(shouldRejectTouch(pen({ sincePenUp: -1 }))).toBe(false);
  });
});

describe('pickPinchPair', () => {
  it('takes the two narrowest contacts, in the order they landed', () => {
    // A flattened finger still reports a wide contact; the hand behind it wider.
    expect(pickPinchPair([{ w: 170 }, { w: 60 }, { w: 58 }])).toEqual([1, 2]);
    expect(pickPinchPair([{ w: 58 }, { w: 170 }, { w: 60 }])).toEqual([0, 2]);
  });

  it('needs two contacts', () => {
    expect(pickPinchPair([])).toBeNull();
    expect(pickPinchPair([{ w: 20 }])).toBeNull();
  });

  it('keeps a pair when every contact is the same size', () => {
    expect(pickPinchPair([{ w: 30 }, { w: 30 }, { w: 30 }])).toEqual([0, 1]);
  });
});

describe('isPalmContact', () => {
  it('calls a hand wide next to the fingers actually in use', () => {
    expect(isPalmContact(160, 20)).toBe(true);
    // Fingers pressed flat: still below the absolute floor, so still a finger.
    expect(isPalmContact(60, 14)).toBe(false);
  });

  it('does not flag anything without a reference', () => {
    expect(isPalmContact(300, 0)).toBe(false);
  });

  it('does not flag a hand on a device where every contact is wide', () => {
    expect(isPalmContact(150, 150)).toBe(false);
    expect(isPalmContact(140, 96)).toBe(false);
  });
});

describe('medianWidth', () => {
  it('ignores a single wide contact among fingers', () => {
    expect(medianWidth([14, 16, 150, 15])).toBe(16);
  });

  it('has no value without contacts', () => {
    expect(medianWidth([])).toBe(0);
  });
});
