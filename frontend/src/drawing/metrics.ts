/**
 * Frame timing for the opt-in performance HUD.
 *
 * Everything here is measured, never estimated: frames are real
 * requestAnimationFrame callbacks, the repaint figure is the wall time the
 * engine spent painting its layers on the last frame that painted anything.
 * The loop costs two `performance.now()` calls per frame and one array push,
 * so it can be left on for a whole session without changing what it measures.
 */

export interface PerfSample {
  /** Frames per second over the trailing second. */
  fps: number;
  /** Longest gap between two frames in the trailing second, in ms. */
  worstFrameMs: number;
  /** Wall time of the most recent frame that painted a layer. */
  repaintMs: number;
  /** Strokes that passed the viewport test on that frame. */
  visibleStrokes: number;
  /** 1 while a stroke is being drawn, 0 otherwise. */
  activeStrokes: number;
  /** Cost of the monitor's own callback, so its overhead is visible too. */
  hudMs: number;
}

const initial: PerfSample = {
  fps: 0,
  worstFrameMs: 0,
  repaintMs: 0,
  visibleStrokes: 0,
  activeStrokes: 0,
  hudMs: 0,
};

let sample: PerfSample = initial;
const listeners = new Set<() => void>();

export const perfStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): PerfSample {
    return sample;
  },
  update(patch: Partial<PerfSample>): void {
    sample = { ...sample, ...patch };
    for (const listener of listeners) listener();
  },
};

const WINDOW_MS = 1000;
const PUBLISH_MS = 200;

export class FrameStats {
  private enabled = false;
  private rafId: number | null = null;
  private lastFrameAt = 0;
  /** Frame gaps inside the trailing second. */
  private gaps: { at: number; ms: number }[] = [];
  private repaintMs = 0;
  private visibleStrokes = 0;
  private activeStrokes = 0;
  private hudMs = 0;
  private publishedAt = 0;

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) {
      this.lastFrameAt = 0;
      this.gaps = [];
      this.publishedAt = 0;
      this.rafId = requestAnimationFrame(this.tick);
      return;
    }
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.repaintMs = 0;
    this.visibleStrokes = 0;
    this.activeStrokes = 0;
    this.hudMs = 0;
    perfStore.update({ ...initial });
  }

  /** Called by the engine once per frame that painted a layer. */
  recordRepaint(ms: number, visibleStrokes: number, activeStrokes: number): void {
    this.repaintMs = ms;
    this.visibleStrokes = visibleStrokes;
    this.activeStrokes = activeStrokes;
  }

  private tick = (now: number): void => {
    const started = performance.now();
    if (this.lastFrameAt !== 0) this.gaps.push({ at: now, ms: now - this.lastFrameAt });
    this.lastFrameAt = now;

    const cutoff = now - WINDOW_MS;
    while (this.gaps.length > 0 && this.gaps[0]!.at < cutoff) this.gaps.shift();

    const cost = performance.now() - started;
    this.hudMs = this.hudMs === 0 ? cost : this.hudMs + (cost - this.hudMs) * 0.1;

    if (now - this.publishedAt >= PUBLISH_MS) {
      this.publishedAt = now;
      const window = this.gaps.length > 1 ? now - this.gaps[0]!.at : 0;
      let worst = 0;
      for (const gap of this.gaps) if (gap.ms > worst) worst = gap.ms;
      perfStore.update({
        fps: window > 0 ? (this.gaps.length * 1000) / window : 0,
        worstFrameMs: worst,
        repaintMs: this.repaintMs,
        visibleStrokes: this.visibleStrokes,
        activeStrokes: this.activeStrokes,
        hudMs: this.hudMs,
      });
    }

    this.rafId = requestAnimationFrame(this.tick);
  };
}

/** One monitor for the page: the editor creates one engine at a time. */
export const frameStats = new FrameStats();
