import { describe, expect, it, vi } from 'vitest';
import { pinchAnchor, pinchView } from './pinch';
import { classifyTwoFinger } from './scrub';

/** A page already panned by one finger, as it stands when the second one lands. */
const landed = (drift: number) => ({ scale: 0.8, tx: -120 - drift, ty: 40 });

/** Document point under a screen point: the anchor every zoom must preserve. */
const docUnder = (view: { scale: number; tx: number; ty: number }, p: { x: number; y: number }) => ({
  x: (p.x - view.tx) / view.scale,
  y: (p.y - view.ty) / view.scale,
});

describe('pinch takeover from a one-finger pan', () => {
  // A second finger that takes its time leaves the sheet wherever the first
  // finger dragged it. What the pinch anchors on is the view on screen, so the
  // cases below vary the one thing that can move it — the drag — and the test
  // after them varies the waiting, which the takeover is meant to ignore.
  for (const drift of [0, 4, 12, 24, 32, 40]) {
    it(`starts where the sheet is after ${drift} px of one-finger drag`, () => {
      const live = landed(drift);
      const anchor = pinchAnchor(live, { x: 400, y: 300 }, { x: 520, y: 300 });

      expect(anchor.startView).toEqual(live);
      expect(anchor.startScale).toBe(live.scale);

      // The first frame after the second finger lands asks for exactly the view
      // that is already on screen: no snap back, no step, no re-centring.
      expect(pinchView(anchor, anchor.startDist, anchor.startMid)).toEqual(live);

      // And the zoom then moves out of that view instead of jumping into it.
      const zoomed = pinchView(anchor, anchor.startDist + 10, anchor.startMid);
      expect(zoomed.scale).toBeGreaterThan(live.scale);
      expect(Math.abs(zoomed.scale / live.scale - 1)).toBeLessThan(0.1);
      expect(Math.abs(zoomed.tx - live.tx)).toBeLessThan(60);
    });
  }

  // The pause before the second finger lands is deliberately not an input: the
  // anchor only needs the view and the two contacts. This holds the decision to
  // that, with a clock that actually moves — if the takeover ever read one, the
  // two anchors below would part company.
  it('takes no clock into the takeover', () => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
    try {
      vi.setSystemTime(new Date('2026-05-04T12:00:00Z'));
      const live = landed(24);
      const a = { x: 400, y: 300 };
      const b = { x: 520, y: 300 };

      const started = { date: Date.now(), perf: performance.now() };
      const immediate = pinchAnchor(live, a, b);
      const immediateView = pinchView(immediate, immediate.startDist + 10, immediate.startMid);

      // Nothing in the anchor records when the finger landed, so nothing
      // downstream can read a wait out of it.
      expect(Object.keys(immediate).sort()).toEqual([
        'startDist',
        'startMid',
        'startScale',
        'startView',
      ]);

      // 300 ms of settling, half a second, a full second: same anchor, same view.
      for (const waited of [300, 500, 1000]) {
        vi.advanceTimersByTime(waited);
        const late = pinchAnchor(live, a, b);
        expect(late).toEqual(immediate);
        expect(pinchView(late, late.startDist + 10, late.startMid)).toEqual(immediateView);
      }

      // The clock really did move, or an implementation that reads one would
      // pass this test without the anchors above ever being able to differ.
      expect(Date.now()).toBeGreaterThan(started.date);
      expect(performance.now()).toBeGreaterThanOrEqual(started.perf + 1_800);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('pinchView', () => {
  it('keeps the page point under the fingers under the fingers', () => {
    const view = { scale: 0.9, tx: 33, ty: -17 };
    const anchor = pinchAnchor(view, { x: 300, y: 320 }, { x: 420, y: 320 });
    // The pair spreads symmetrically, so the midpoint the zoom holds is the one
    // the fingers were at when the pinch took over.
    const fingers = anchor.startMid;
    const before = docUnder(view, fingers);
    for (const dist of [130, 160, 260, 90]) {
      const after = pinchView(anchor, dist, fingers);
      const held = docUnder(after, fingers);
      expect(held.x).toBeCloseTo(before.x, 6);
      expect(held.y).toBeCloseTo(before.y, 6);
    }
  });

  it('takes small spreads in small steps, with nothing to catch on', () => {
    const view = { scale: 1, tx: 0, ty: 0 };
    const anchor = pinchAnchor(view, { x: 400, y: 300 }, { x: 520, y: 300 });
    let previous = pinchView(anchor, 120, { x: 460, y: 300 });
    for (let dist = 121; dist <= 200; dist += 1) {
      const next = pinchView(anchor, dist, { x: 460, y: 300 });
      expect(next.scale).toBeGreaterThan(previous.scale);
      // A single pixel of spread is a single, small step: 2 % at most here.
      expect(next.scale / previous.scale).toBeLessThan(1.02);
      previous = next;
    }
  });

  it('zooms from the very first pixel, however close the fingers start', () => {
    for (const start of [0, 2, 8, 20, 120]) {
      const view = { scale: 1, tx: 0, ty: 0 };
      const anchor = pinchAnchor(view, { x: 400, y: 300 }, { x: 400 + start, y: 300 });
      const first = pinchView(anchor, start + 1, { x: 400 + start / 2, y: 300 });
      expect(first.scale).toBeGreaterThan(1);
    }
  });
});

describe('naming the gesture', () => {
  it('never steps the view while a sliding pinch is being recognised', () => {
    // A pinch whose midpoint travels 48 px while its fingers part by 4 px: the
    // view has to follow smoothly through the naming, whatever the moment the
    // gesture stops being undecided.
    const view = { scale: 1, tx: 40, ty: 12 };
    const anchor = pinchAnchor(view, { x: 300, y: 400 }, { x: 420, y: 400 });
    const modes: string[] = [];
    let peak = 0;
    let previous = view;
    for (let step = 1; step <= 40; step += 1) {
      const dist = anchor.startDist + step * 0.1;
      const mid = { x: anchor.startMid.x + step * 1.2, y: anchor.startMid.y };
      peak = Math.max(peak, Math.abs(dist - anchor.startDist));
      // Worst case for the eraser: the sweep is reported as never having run.
      modes.push(classifyTwoFinger({ peakSpreadPx: peak, sweepTravelPx: 0 }));
      const next = pinchView(anchor, dist, mid);
      expect(Math.abs(next.tx - previous.tx)).toBeLessThan(3);
      // Vertically the only motion is the zoom itself around the midpoint: a
      // fraction of a pixel per sample, never a step.
      expect(Math.abs(next.ty - previous.ty)).toBeLessThan(1);
      expect(Math.abs(next.scale / previous.scale - 1)).toBeLessThan(0.01);
      previous = next;
    }
    expect(modes).toContain('pinch');
    expect(modes).not.toContain('scrub');
  });
});
