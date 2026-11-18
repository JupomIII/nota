import { describe, expect, it } from 'vitest';
import {
  describeParked,
  isPermanentRefusal,
  pushFailurePlan,
  quarantineKey,
  stillParked,
  type QuarantineEntry,
} from './quarantine';

describe('a change the laptop refuses', () => {
  it('treats a payload it can never validate as final', () => {
    expect(isPermanentRefusal(400)).toBe(true);
    expect(isPermanentRefusal(413)).toBe(true);
    expect(isPermanentRefusal(422)).toBe(true);
  });

  it('keeps retrying what may clear by itself', () => {
    for (const status of [null, 401, 404, 409, 429, 500, 502, 503]) {
      expect(isPermanentRefusal(status)).toBe(false);
    }
  });

  it('narrows a refused batch down to the object it cannot take', () => {
    expect(pushFailurePlan(200, 422)).toBe('retry-halves');
    expect(pushFailurePlan(2, 413)).toBe('retry-halves');
  });

  it('parks the object once it is alone, so the queue keeps moving', () => {
    expect(pushFailurePlan(1, 413)).toBe('quarantine');
    expect(pushFailurePlan(1, 400)).toBe('quarantine');
  });

  it('aborts on trouble a retry can fix, instead of losing the change', () => {
    expect(pushFailurePlan(200, null)).toBe('abort');
    expect(pushFailurePlan(1, 503)).toBe('abort');
    expect(pushFailurePlan(1, 429)).toBe('abort');
  });
});

describe('a parked change', () => {
  const entry: QuarantineEntry = {
    kind: 'stroke',
    id: 's1',
    label: 'Stroke (fountain)',
    reason: 'That item is too large for the laptop to accept.',
    at: 1_000,
  };

  it('stays parked while the object itself is untouched', () => {
    expect(stillParked(entry, 1_000)).toBe(true);
    expect(stillParked(entry, 900)).toBe(true);
  });

  it('is worth sending again after an edit, which is a new payload', () => {
    expect(stillParked(entry, 1_001)).toBe(false);
  });

  it('names the object and the refusal in one line', () => {
    expect(describeParked([entry])).toBe(
      'Stroke (fountain): That item is too large for the laptop to accept.',
    );
    expect(describeParked([entry, { ...entry, id: 's2' }])).toContain('(and 1 more)');
    expect(describeParked([])).toBe('');
  });

  it('keys by kind as well as id, so two tables cannot mask each other', () => {
    expect(quarantineKey('stroke', 'x')).not.toBe(quarantineKey('text', 'x'));
  });
});
