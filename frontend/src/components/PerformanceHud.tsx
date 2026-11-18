import { useSyncExternalStore } from 'react';
import { perfStore } from '../drawing/metrics';

/**
 * The opt-in readout. It never touches the pointer pipeline and draws nothing
 * on the canvas, so what it reports is the app's own frame cost, not its own.
 */
export function PerformanceHud() {
  const sample = useSyncExternalStore(perfStore.subscribe, perfStore.getSnapshot);
  const fps = sample.fps > 0 ? Math.round(sample.fps) : 0;
  return (
    <div
      data-testid="performance-hud"
      aria-live="off"
      className="pointer-events-none absolute left-2 top-2 z-30 rounded-md bg-ink/85 px-2 py-1.5 font-mono text-[10.5px] leading-[1.45] tabular-nums text-paper-raised shadow-panel"
    >
      <div>
        <span data-testid="hud-fps">{fps}</span> fps
        {' · '}
        worst <span data-testid="hud-worst">{sample.worstFrameMs.toFixed(1)}</span> ms
      </div>
      <div>
        repaint <span data-testid="hud-repaint">{sample.repaintMs.toFixed(2)}</span> ms
        {' · '}
        <span data-testid="hud-strokes">{sample.visibleStrokes}</span> visible
        {sample.activeStrokes > 0 ? ' · drawing' : ''}
      </div>
      <div className="text-paper-raised/60">
        hud <span data-testid="hud-cost">{sample.hudMs.toFixed(3)}</span> ms
      </div>
    </div>
  );
}
