import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describePending, plural, relativeTime } from './format';

const NOW = new Date('2026-05-04T12:00:00Z').getTime();

describe('relativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('reads as just now inside the first minute', () => {
    expect(relativeTime(NOW - 5_000)).toBe('just now');
    expect(relativeTime(NOW - 44_000)).toBe('just now');
  });

  it('never reaches the next unit before it is due', () => {
    expect(relativeTime(NOW - 59 * 60_000)).toBe('59 min ago');
    expect(relativeTime(NOW - (59 * 60_000 + 59_000))).toBe('59 min ago');
    expect(relativeTime(NOW - 23 * 3_600_000)).toBe('23 h ago');
    expect(relativeTime(NOW - 6 * 86_400_000)).toBe('6 d ago');
  });

  it('promotes each unit at its own boundary', () => {
    expect(relativeTime(NOW - 45_000)).toBe('1 min ago');
    expect(relativeTime(NOW - 3_600_000)).toBe('1 h ago');
    expect(relativeTime(NOW - 86_400_000)).toBe('1 d ago');
  });

  it('falls back to a date after a week, and says never with no timestamp', () => {
    expect(relativeTime(NOW - 8 * 86_400_000)).not.toMatch(/ago|just now/);
    expect(relativeTime(null)).toBe('never');
    expect(relativeTime(0)).toBe('never');
  });
});

describe('plural', () => {
  it('agrees with the count', () => {
    expect(plural(1, 'page')).toBe('1 page');
    expect(plural(0, 'page')).toBe('0 pages');
    expect(plural(3, 'notebook')).toBe('3 notebooks');
  });
});

describe('describePending', () => {
  it('names the biggest three kinds with correct plurals', () => {
    expect(describePending({ stroke: 12, page: 1, notebook: 2 })).toBe('12 strokes · 2 notebooks · 1 page');
  });

  it('ignores kinds with nothing queued, and says nothing when empty', () => {
    expect(describePending({ stroke: 0, page: 3, text: 0 })).toBe('3 pages');
    expect(describePending({})).toBe('');
  });

  it('breaks ties the same way every time', () => {
    expect(describePending({ page: 2, notebook: 2 })).toBe('2 notebooks · 2 pages');
  });

  it('still reads sensibly for a kind without a label', () => {
    expect(describePending({ widget: 2 })).toBe('2 widgets');
  });
});
