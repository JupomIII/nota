import type {
  DrawToolId,
  ShapeKind,
  ImagePlacement,
  Page,
  Stroke,
  StrokePoint,
  TextBlock,
  ToolSettings,
} from '../storage/types';
import { mergeRemoteContent } from './remoteContent';
import {
  newId, now } from '../lib/id';
import {
  boundsIntersect,
  boundsOfPoints,
  pointInPolygon,
  polylineDistance,
  recognizeShape,
  snapAngle,
  snapToGrid,
  type Bounds,
  type ShapeRecognition,
} from '../lib/geometry';
import { drawPaper } from './paper';
import { drawStroke } from './strokeRender';
import { InkView, StrokePathCache } from './strokeCache';
import { LiveStrokePainter, isIncrementalStroke, liveFrameHasWork, type LiveSurface } from './liveStroke';
import { MIN_NIB_SCREEN_DISTANCE, inkPointAt, nibHasMoved, smoothPressure } from './inkInput';
import { PAINT_MARGIN, widenPaintMargin } from './paintMargin';
import { looksLikeScribble } from './scribble';
import { frameStats } from './metrics';
import { paintText } from './textRender';
import { HistoryStack } from './history';
import {
  inPenGrace,
  isPalmContact,
  isPenSession,
  medianWidth,
  pickPinchPair,
  shouldRejectTouch,
} from './palm';
import { StrokeGrid } from './spatial';
import {
  PINCH_HINT_PX,
  SCRUB_RADIUS_PX,
  classifyTwoFinger,
  peakSpread,
  scrubTurnsIntoPan,
  sweep,
  type SweepState,
  type TwoFingerMode,
} from './scrub';
import { pinchAnchor, pinchView, type PinchAnchor, type ViewTransform } from './pinch';

type ShapeToolId = 'line' | 'rect' | 'circle' | 'ellipse' | 'triangle' | 'arrow';

export type { ViewTransform };

/**
 * Per-page session state that outlives the editor.
 *
 * Navigating to the notebook and back destroys the canvas and the engine, but
 * the undone-able steps recorded on a page are still meaningful: the strokes
 * they restore live in IndexedDB. The stacks are kept here, keyed by page, and
 * replayed against whichever engine currently shows that page.
 */
const enginesByPage = new Map<string, DrawingEngine>();
const historiesByPage = new Map<string, HistoryStack>();

export function historyForPage(pageId: string): HistoryStack {
  const existing = historiesByPage.get(pageId);
  if (existing) {
    // Refresh the insertion order so the least recently used page is evicted.
    historiesByPage.delete(pageId);
    historiesByPage.set(pageId, existing);
    return existing;
  }
  const stack = new HistoryStack();
  historiesByPage.set(pageId, stack);
  while (historiesByPage.size > 8) {
    const oldest = historiesByPage.keys().next().value;
    if (!oldest) break;
    historiesByPage.delete(oldest);
  }
  return stack;
}

export interface PageContent {
  strokes: Stroke[];
  texts: TextBlock[];
  images: ImagePlacement[];
}

export interface PagePersistence {
  addStrokes(strokes: Stroke[]): void;
  updateStrokes(strokes: Stroke[]): void;
  deleteStrokes(ids: string[]): void;
  addTexts(texts: TextBlock[]): void;
  updateTexts(texts: TextBlock[]): void;
  deleteTexts(ids: string[]): void;
  addImages(images: ImagePlacement[]): void;
  updateImages(images: ImagePlacement[]): void;
  deleteImages(ids: string[]): void;
  notifyChange(): void;
}

export interface SelectionSummary {
  count: number;
  bounds: Bounds | null;
}

export interface TextDraft {
  id: string | null;
  x: number;
  y: number;
  width: number;
  text: string;
  fontSize: number;
  color: string;
  align: 'left' | 'center' | 'right';
}

export interface EngineCallbacks {
  onSelectionChange(selection: SelectionSummary): void;
  onHistoryChange(): void;
  onViewChange(view: ViewTransform): void;
  requestTextEdit(draft: TextDraft): void;
  requestImage(): void;
  /** Fired after a freehand stroke that looks like a clean shape. */
  onShapeSuggestion?(suggestion: ShapeSuggestion): void;
  /** Short, user-facing feedback for a gesture that changed the ink. */
  onGestureNotice?(message: string): void;
  /**
   * Fired once a full eraser gesture has removed ink. The editor uses it to put
   * the pen back in hand after a one-stroke eraser, without changing any tool
   * behaviour the eraser itself relies on.
   */
  onEraseGesture?(): void;
}

export interface ShapeSuggestion extends ShapeRecognition {
  strokeId: string;
}

interface Mutation {
  label: string;
  addedStrokes?: Stroke[];
  removedStrokes?: Stroke[];
  updatedStrokes?: { before: Stroke; after: Stroke }[];
  addedTexts?: TextBlock[];
  removedTexts?: TextBlock[];
  updatedTexts?: { before: TextBlock; after: TextBlock }[];
  addedImages?: ImagePlacement[];
  removedImages?: ImagePlacement[];
  updatedImages?: { before: ImagePlacement; after: ImagePlacement }[];
}

interface Selection {
  strokeIds: Set<string>;
  textIds: Set<string>;
  imageIds: Set<string>;
}

interface LiveRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

type Session =
  | { kind: 'none' }
  | { kind: 'draw'; stroke: Stroke }
  | { kind: 'shape'; start: StrokePoint; current: StrokePoint }
  | {
      kind: 'erase';
      last: StrokePoint;
      before: Stroke[];
      lastEraseAt: number;
      /** Ink damaged by the drag, so ending it repaints only that. */
      dirty: Bounds | null;
    }
  | { kind: 'lasso'; points: StrokePoint[] }
  | {
      kind: 'move';
      start: { x: number; y: number };
      last: { x: number; y: number };
      strokes: Stroke[];
      texts: TextBlock[];
      images: ImagePlacement[];
    }
  | {
      kind: 'resize';
      origin: { x: number; y: number };
      last: { x: number; y: number };
      strokes: Stroke[];
      texts: TextBlock[];
      images: ImagePlacement[];
    }
  | {
      kind: 'pan';
      last: { x: number; y: number };
    }
      | {
      kind: 'pinch';
      /**
       * What the zoom is measured from. Taken from the view on screen when the
       * pinch takes over, and re-taken from the live view whenever the gesture
       * changes its mind about what it is: a new anchor always describes what is
       * already displayed, so nothing is ever put back where it was.
       */
      anchor: PinchAnchor;
      /** Pinch, rub or pan: decided from what the two fingers actually do. */
      mode: TwoFingerMode;
      /**
       * Largest change in the finger separation seen since the anchor was taken,
       * in screen pixels. Zoom evidence accumulates: once it has shown a pinch the
       * eraser can never arm itself behind it.
       */
      spreadPeak: number;
      /**
       * Travel made while the fingers held their separation. A pinch keeps
       * resetting it, a rub adds to it, so this is what tells the two apart.
       */
      sweep: SweepState;
      /** Where each finger was at the last erase, in stage pixels. */
      scrubLast: Map<number, { x: number; y: number }>;
      /** Strokes as they were when the rub began, for one undo entry. */
      scrubBefore: Stroke[] | null;
      /** True once the rub has actually removed something. */
      scrubHit: boolean;
      /** Area to repaint after the rub, in document coordinates. */
      scrubDirty: Bounds | null;
      /** Midpoint of the last processed move, for pan and rub travel. */
      lastMid: { x: number; y: number };
      /**
       * The two contacts this gesture belongs to. A hand resting on the glass can
       * add contacts at any moment; the pinch keeps reading the pair it started
       * with so those never move the sheet.
       */
      pair: [number, number];
    };

const HANDLE_SCREEN_SIZE = 18;
const ERASE_THROTTLE_MS = 34;
/** Tools whose ink can be scrubbed away with a scribble. */
const SCRIBBLE_TOOLS = new Set<DrawToolId>(['fountain', 'ballpoint', 'pencil']);
/** Movement, in CSS pixels, that turns a tap into a drag. */
const TAP_SLOP = 14;
const TAP_MAX_MS = 320;
const TAP_HOLD_MS = 480;
const TAP_REPEAT_MS = 150;
/** Points a live stroke outline may use before it is sampled down. */
/** How long the pencil must rest before the stroke becomes a straight line. */
const SNAP_HOLD_MS = 480;

export class DrawingEngine {
  private readonly stage: HTMLElement;
  private readonly paperCanvas: HTMLCanvasElement;
  private readonly inkCanvas: HTMLCanvasElement;
  private readonly liveCanvas: HTMLCanvasElement;
  private readonly paperCtx: CanvasRenderingContext2D;
  private readonly inkCtx: CanvasRenderingContext2D;
  private readonly liveCtx: CanvasRenderingContext2D;

  private dpr = 1;
  private cssWidth = 0;
  private cssHeight = 0;

  page: Page | null = null;
  view: ViewTransform = { scale: 1, tx: 0, ty: 0 };
  tool: DrawToolId = 'fountain';
  toolSettings: ToolSettings;
  oneFingerPan = true;

  /** Rub two fingers over ink to erase what they cross. */
  twoFingerErase = true;
  palmRejection = true;
  showBoundary = true;
  recognizeShapes = true;
  /** A scribble over ink erases it instead of drawing over it. */
  scribbleToErase = true;
  /** Holding the pencil still at the end of a stroke snaps it to a line. */
  holdToSnap = true;
  snapEnabled = false;
  snapSize = 36;

  private strokes: Stroke[] = [];
  private texts: TextBlock[] = [];
  private images: ImagePlacement[] = [];
  private strokeById = new Map<string, Stroke>();
  private strokeBounds = new Map<string, Bounds>();
  private imageBitmaps = new Map<string, CanvasImageSource>();
  private pdfBitmap: { image: CanvasImageSource; width: number; height: number } | null = null;

  private selection: Selection = {
    strokeIds: new Set(),
    textIds: new Set(),
    imageIds: new Set(),
  };

  private session: Session = { kind: 'none' };
  private activePointers = new Map<
    number,
    { x: number; y: number; type: string; w: number; palm: boolean }
  >();
  /** Widths of the contacts that behaved like fingers, newest last. */
  private fingerWidths: number[] = [];
  private penDown = false;
  /** -Infinity until the pencil has been lifted once: no hold-back to honour. */
  private penLastAt = Number.NEGATIVE_INFINITY;
  /** Smoothed pencil pressure, reset at the start of every stroke. */
  private lastPressure = 0;

  /**
   * perfect-freehand outlines, keyed by stroke. Rebuilding them for every
   * visible stroke on every repaint was the heaviest thing the page did: a pan
   * or a pinch repaints all of them, and one long stroke costs milliseconds.
   */
  private readonly strokePaths = new StrokePathCache();
  /**
   * Order in which the strokes were drawn. A repaint asks the spatial grid for the
   * strokes the viewport holds, and the grid answers in no particular order: this
   * puts them back so overlapping ink stacks exactly as it was written.
   */
  private readonly strokeOrder = new Map<string, number>();
  private nextStrokeOrder = 0;
  /** Viewport-scoped ink for the next repaint; reuses its own buffers. */
  private readonly viewportInk: InkView;
  /** Layout box of the stage, read once per gesture instead of per event. */
  private stageRect: DOMRect | null = null;
  /** Two fingers undo, three redo, holding them repeats (Procreate/Goodnotes). */
  private tap: { at: number; max: number; moved: boolean; repeats: number } | null = null;
  private tapHold: number | null = null;
  private tapRepeat: number | null = null;
  private readonly tapStart = new Map<number, { x: number; y: number }>();
  private viewDirty = false;
  /** Last time the pencil actually moved during a stroke, for hold-to-snap. */
  private lastMoveAt = 0;
  /** Last undo/redo availability told to the host, to avoid repeat renders. */
  private lastCanUndo = false;
  private lastCanRedo = false;
  private snapHoldTimer: number | null = null;
  private snappedStroke = false;
  private perfHudOn = false;
  /** Strokes that passed the viewport test on the last paint, for the HUD. */
  private visibleStrokes = 0;

  /** True while a rub is erasing, so the canvas can show its radius. */
  scrubActive = false;

  /** Screen-space area the live layer drew last frame, so it can be cleared. */
  private livePaintedRect: LiveRect | null = null;

  /** Spatial index over stroke bounds: erasing never walks the whole page. */
  private readonly inkIndex = new StrokeGrid();
  /** Ink damage from an erase, repainted region by region instead of whole. */
  private pendingInkDirty: Bounds | null = null;

  private pendingPaper = true;
  private pendingInk = true;
  private pendingLive = true;
  /**
   * The view each pixel layer was last rasterised at.
   *
   * Repainting the paper and every visible stroke on each frame of a pan or a
   * pinch was the largest cost on a loaded page: 320 strokes into a 2048x2620
   * backing store, plus a blurred shadow, sixty times a second. While a gesture
   * is in flight the already painted layers are stretched on the compositor
   * instead, and the exact pixels are rebuilt once the fingers stop.
   */
  private paperView: ViewTransform | null = null;
  private inkView: ViewTransform | null = null;
  /** Document area each layer actually holds pixels for. */
  private paperDoc: Bounds | null = null;
  private inkDoc: Bounds | null = null;
  /** A two-finger gesture moved this frame and must be applied once. */
  private gestureDirty = false;
  /**
   * Set when a pinch ends with fingers still on the glass: the leftover finger
   * is ignored until every touch is up, so a half-lifted pinch never turns into
   * a one-finger drag.
   */
  private singleFingerLock = false;
  /** Paint a margin around the viewport when a gesture outgrows the layers. */
  private expandPaint = false;
  /**
   * Page painted around the viewport, as a multiple of the viewport. Widened by
   * a gesture that outgrows it, so a long zoom-out does not ask for a full
   * repaint on every frame it keeps shrinking. Back to PAINT_MARGIN once the
   * gesture settles.
   */
  private paintMargin = PAINT_MARGIN;
  /** Adds the wet stroke to the live layer piece by piece. */
  private readonly livePainter = new LiveStrokePainter();
  /** True while the layers are being stretched instead of repainted. */
  private approximating = false;
  /** A gesture moved the view; the stretch is written once, on the next frame. */
  private pendingApproximation = false;
  private rafId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private viewSettleTimer: number | null = null;
  private disposed = false;

  private clipboard: PageContent | null = null;

  private historyStack = new HistoryStack();
  private unbindHistory: (() => void) | null = null;

  constructor(
    stage: HTMLElement,
    private readonly persistence: PagePersistence,
    private readonly callbacks: EngineCallbacks,
    toolSettings: ToolSettings,
  ) {
    this.stage = stage;
    this.toolSettings = toolSettings;

    const makeLayer = (zIndex: number): [HTMLCanvasElement, CanvasRenderingContext2D] => {
      const canvas = document.createElement('canvas');
      canvas.style.position = 'absolute';
      canvas.style.transformOrigin = '0 0';
      canvas.style.willChange = 'transform';
      canvas.style.inset = '0';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.zIndex = String(zIndex);
      canvas.style.touchAction = 'none';
      stage.appendChild(canvas);
      const ctx = canvas.getContext('2d', { alpha: zIndex !== 0, desynchronized: true });
      if (!ctx) throw new Error('Canvas 2D is not available in this browser');
      return [canvas, ctx];
    };

    [this.paperCanvas, this.paperCtx] = makeLayer(0);
    [this.inkCanvas, this.inkCtx] = makeLayer(1);
    [this.liveCanvas, this.liveCtx] = makeLayer(2);

    // The host positions the stage (Tailwind `absolute inset-0`). Only fall back
    // to `relative` when the element is still in normal flow, otherwise an
    // inline position would collapse the drawing area to zero height.
    if (window.getComputedStyle(this.stage).position === 'static') {
      this.stage.style.position = 'relative';
    }
    this.stage.style.touchAction = 'none';
    this.stage.style.overflow = 'hidden';

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(stage);
    this.resize();

    stage.addEventListener('pointerdown', this.onPointerDown);
    stage.addEventListener('pointermove', this.onPointerMove);
    stage.addEventListener('pointerup', this.onPointerUp);
    stage.addEventListener('pointercancel', this.onPointerCancel);
    stage.addEventListener('wheel', this.onWheel, { passive: false });
    stage.addEventListener('contextmenu', this.onContextMenu);
    stage.addEventListener('lostpointercapture', this.onLostPointerCapture);
    window.addEventListener('blur', this.resetPenState);
    document.addEventListener('visibilitychange', this.onVisibilityChange);

    this.viewportInk = new InkView(
      this.strokeById,
      (id) => this.strokeBounds.get(id),
      (id) => this.strokeOrder.get(id) ?? 0,
    );

    this.bindHistory();
  }

  get history(): HistoryStack {
    return this.historyStack;
  }

  /**
   * Hands the engine the undo stack that belongs to the page being opened, so
   * stepping back to a page keeps what was undone-able there instead of
   * starting empty.
   */
  adoptHistory(stack: HistoryStack): void {
    if (stack === this.historyStack) return;
    this.historyStack = stack;
    this.bindHistory();
  }

  private bindHistory(): void {
    this.unbindHistory?.();
    this.unbindHistory = this.historyStack.subscribe(() => {
      // Every stroke pushes a history entry, but the toolbar only needs to hear
      // about it when an arrow actually becomes available: otherwise each lift
      // re-rendered the whole editor for nothing.
      const canUndo = this.historyStack.canUndo;
      const canRedo = this.historyStack.canRedo;
      if (canUndo === this.lastCanUndo && canRedo === this.lastCanRedo) return;
      this.lastCanUndo = canUndo;
      this.lastCanRedo = canRedo;
      this.callbacks.onHistoryChange();
    });
    this.lastCanUndo = this.historyStack.canUndo;
    this.lastCanRedo = this.historyStack.canRedo;
    this.callbacks.onHistoryChange();
  }

  dispose(): void {
    this.disposed = true;
    for (const [id, engine] of enginesByPage) {
      if (engine === this) enginesByPage.delete(id);
    }
    this.cancelTap();
    this.cancelSnapHold();
    this.setPerfHud(false);
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    if (this.viewSettleTimer !== null) window.clearTimeout(this.viewSettleTimer);
    this.resizeObserver?.disconnect();
    this.stage.removeEventListener('pointerdown', this.onPointerDown);
    this.stage.removeEventListener('pointermove', this.onPointerMove);
    this.stage.removeEventListener('pointerup', this.onPointerUp);
    this.stage.removeEventListener('pointercancel', this.onPointerCancel);
    this.stage.removeEventListener('wheel', this.onWheel);
    this.stage.removeEventListener('contextmenu', this.onContextMenu);
    this.stage.removeEventListener('lostpointercapture', this.onLostPointerCapture);
    window.removeEventListener('blur', this.resetPenState);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.paperCanvas.remove();
    this.inkCanvas.remove();
    this.liveCanvas.remove();
  }

  /* ---------------------------------------------------------------- */
  /* Page lifecycle                                                    */
  /* ---------------------------------------------------------------- */

  setPage(page: Page, content: PageContent): void {
    this.page = page;
    enginesByPage.set(page.id, this);
    this.pdfBitmap = null;
    this.strokes = [...content.strokes];
    this.texts = [...content.texts];
    this.images = [...content.images];
    this.rebuildIndex();
    this.strokePaths.clear();
    this.cancelTap();
    this.cancelSnapHold();
    this.selection = { strokeIds: new Set(), textIds: new Set(), imageIds: new Set() };
    this.session = { kind: 'none' };
    // The stack is not cleared here: it belongs to the page, and the editor
    // swaps in the right one before calling this.
    this.callbacks.onSelectionChange({ count: 0, bounds: null });
    this.fitToPage();
    this.invalidateAll();
  }

  /**
   * Swaps in what the sync just wrote, without touching the view, the page's
   * undo stack or the place the reader was. The stroke still under the pen is
   * kept: a pull landing mid-word must not make the line jump.
   */
  applyRemoteContent(content: PageContent): void {
    const merged = mergeRemoteContent(
      { strokes: content.strokes, texts: content.texts, images: content.images },
      this.getActiveStroke(),
      this.selection,
    );
    this.strokes = merged.model.strokes;
    this.texts = merged.model.texts;
    this.images = merged.model.images;
    this.selection = merged.selection;
    this.rebuildIndex();
    this.strokePaths.clear();
    if (merged.selectionTrimmed) {
      this.callbacks.onSelectionChange({ count: this.selectionCount(), bounds: this.selectionBounds() });
    }
    this.invalidateAll();
  }

  setPdfBitmap(image: CanvasImageSource | null, width = 0, height = 0): void {
    this.pdfBitmap = image ? { image, width, height } : null;
    this.pendingPaper = true;
    this.schedule();
  }

  setImageBitmap(assetId: string, image: CanvasImageSource): void {
    this.imageBitmaps.set(assetId, image);
    this.pendingInk = true;
    this.schedule();
  }

  restoreDraft(stroke: Stroke): void {
    if (this.strokeById.has(stroke.id)) return;
    this.applyMutation({ label: 'Recovered draft', addedStrokes: [stroke] }, { record: false });
  }

  getActiveStroke(): Stroke | null {
    return this.session.kind === 'draw' ? this.session.stroke : null;
  }

  snapshot(): PageContent {
    return {
      strokes: this.strokes.slice(),
      texts: this.texts.slice(),
      images: this.images.slice(),
    };
  }

  /* ---------------------------------------------------------------- */
  /* View control                                                      */
  /* ---------------------------------------------------------------- */

  resize(): void {
    const rect = this.stage.getBoundingClientRect();
    this.stageRect = rect;
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    const changed = width !== this.cssWidth || height !== this.cssHeight;
    this.cssWidth = width;
    this.cssHeight = height;
    if (!changed) return;
    for (const canvas of [this.paperCanvas, this.inkCanvas, this.liveCanvas]) {
      canvas.width = Math.round(width * this.dpr);
      canvas.height = Math.round(height * this.dpr);
    }
    this.invalidateAll();
  }

  /**
   * The document point under the middle of the viewport. Storing this instead of
   * the raw translation keeps the page in the same place after a rotation or a
   * different window size.
   */
  get viewCentre(): { scale: number; cx: number; cy: number } {
    return {
      scale: this.view.scale,
      cx: (this.cssWidth / 2 - this.view.tx) / this.view.scale,
      cy: (this.cssHeight / 2 - this.view.ty) / this.view.scale,
    };
  }

  /** Puts a stored centre back under the middle of the current viewport. */
  centreView(state: { scale: number; cx: number; cy: number }): void {
    const scale = Math.max(0.15, Math.min(8, state.scale));
    this.setView({
      scale,
      tx: this.cssWidth / 2 - state.cx * scale,
      ty: this.cssHeight / 2 - state.cy * scale,
    });
  }

  get viewportSize(): { width: number; height: number } {
    return { width: this.cssWidth, height: this.cssHeight };
  }

  private pageSize(): { width: number; height: number } {
    if (!this.page) return { width: this.cssWidth, height: this.cssHeight };
    if (this.page.size === 'infinite') return { width: this.cssWidth, height: this.cssHeight };
    return { width: this.page.width, height: this.page.height };
  }

  fitToPage(): void {
    if (!this.page) return;
    if (this.page.size === 'infinite') {
      this.view = { scale: 1, tx: this.cssWidth / 2, ty: this.cssHeight / 2 };
    } else {
      const pad = 24;
      const raw = Math.min(
        (this.cssWidth - pad * 2) / this.page.width,
        (this.cssHeight - pad * 2) / this.page.height,
      );
      const s = Math.max(0.15, Math.min(4, raw));
      this.view = {
        scale: s,
        tx: (this.cssWidth - this.page.width * s) / 2,
        ty: (this.cssHeight - this.page.height * s) / 2,
      };
    }
    this.callbacks.onViewChange({ ...this.view });
    this.pendingPaper = true;
    this.pendingInk = true;
    this.schedule();
    this.emitViewSettled();
  }

  zoomBy(factor: number, center?: { x: number; y: number }): void {
    this.cancelApproximation();
    const cx = center?.x ?? this.cssWidth / 2;
    const cy = center?.y ?? this.cssHeight / 2;
    const scale = Math.max(0.15, Math.min(8, this.view.scale * factor));
    const applied = scale / this.view.scale;
    this.view = {
      scale,
      tx: cx - (cx - this.view.tx) * applied,
      ty: cy - (cy - this.view.ty) * applied,
    };
    this.callbacks.onViewChange({ ...this.view });
    this.pendingPaper = true;
    this.pendingInk = true;
    this.schedule();
    this.emitViewSettled();
  }

  setView(view: ViewTransform): void {
    this.cancelApproximation();
    this.view = view;
    this.callbacks.onViewChange({ ...this.view });
    this.invalidateAll();
  }

  private emitViewSettled(): void {
    if (this.viewSettleTimer !== null) window.clearTimeout(this.viewSettleTimer);
    this.viewSettleTimer = window.setTimeout(() => {
      this.viewSettleTimer = null;
      this.callbacks.onViewChange({ ...this.view });
    }, 180);
  }

  toDoc(screenX: number, screenY: number): { x: number; y: number } {
    return {
      x: (screenX - this.view.tx) / this.view.scale,
      y: (screenY - this.view.ty) / this.view.scale,
    };
  }

  toScreen(docX: number, docY: number): { x: number; y: number } {
    return {
      x: docX * this.view.scale + this.view.tx,
      y: docY * this.view.scale + this.view.ty,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Rendering                                                         */
  /* ---------------------------------------------------------------- */

  private invalidateAll(): void {
    this.cancelApproximation();
    this.pendingPaper = true;
    this.pendingInk = true;
    this.pendingLive = true;
    this.schedule();
  }

  private invalidateLive(): void {
    this.pendingLive = true;
    this.schedule();
  }

  private invalidateInk(): void {
    this.pendingInk = true;
    this.pendingLive = true;
    this.schedule();
  }

  /**
   * Repaints only the ink inside `region`. Erasing changes a few hundred pixels
   * around the fingers, so the rest of the page must not be redrawn: a full
   * repaint per touch move is what makes erasing slow down on a long note. A
   * queued full repaint already covers the whole canvas.
   */
  private invalidateInkRegion(region: Bounds): void {
    const current = this.pendingInkDirty;
    this.pendingInkDirty = current
      ? {
          minX: Math.min(current.minX, region.minX),
          minY: Math.min(current.minY, region.minY),
          maxX: Math.max(current.maxX, region.maxX),
          maxY: Math.max(current.maxY, region.maxY),
        }
      : { ...region };
    this.pendingLive = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.disposed || this.rafId !== null) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.render();
    });
  }

  private applyView(ctx: CanvasRenderingContext2D): void {
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.translate(this.view.tx, this.view.ty);
    ctx.scale(this.view.scale, this.view.scale);
  }

  /**
   * Tell the host the view moved once per frame, not once per pointer event, and
   * only when something in the DOM is pinned to the page: a plain ink page has
   * no reason to re-render React while a finger drags it around. The settled
   * view is sent when the gesture ends either way.
   */
  private queueViewChange(): void {
    if (this.texts.length === 0 && this.images.length === 0) return;
    this.viewDirty = true;
    this.schedule();
  }

  private viewportDocBounds(): Bounds {
    const tl = this.toDoc(0, 0);
    const br = this.toDoc(this.cssWidth, this.cssHeight);
    return { minX: tl.x, minY: tl.y, maxX: br.x, maxY: br.y };
  }

  private render(): void {
    if (this.disposed) return;
    const startedAt = this.perfHudOn ? performance.now() : 0;
    if (this.gestureDirty) {
      this.gestureDirty = false;
      this.applyTwoFinger();
    }
    const painted = this.pendingPaper || this.pendingInk || this.pendingLive;
    if (this.pendingPaper || this.pendingInk) {
      // A gesture that outran the layers repaints them wider than the viewport,
      // so the next frames can stretch again instead of rasterising each one.
      const real = this.view;
      const wide = this.expandPaint;
      this.expandPaint = false;
      if (wide) this.view = this.expandedView(real);
      try {
        if (this.pendingPaper) {
          this.pendingPaper = false;
          this.paintPaper();
        }
        if (this.pendingInk) {
          this.pendingInk = false;
          this.pendingInkDirty = null;
          this.paintInk();
        }
      } finally {
        this.view = real;
      }
      if (wide) {
        this.approximating = true;
        this.paperCanvas.style.transform = this.layerTransform(this.paperView);
        this.inkCanvas.style.transform = this.layerTransform(this.inkView);
      }
    } else if (this.pendingInkDirty) {
      const region = this.pendingInkDirty;
      this.pendingInkDirty = null;
      this.paintInkRegion(region);
    }
    // One stretch per frame: a finger reports up to 240 times a second and every
    // write re-composites two page-sized layers, most of them never seen.
    if (this.pendingApproximation) {
      this.pendingApproximation = false;
      this.approximateView();
    }
    if (this.pendingLive) {
      this.pendingLive = false;
      this.paintLive();
    }
    if (this.perfHudOn && painted) {
      frameStats.recordRepaint(
        performance.now() - startedAt,
        this.visibleStrokes,
        this.session.kind === 'draw' ? 1 : 0,
      );
    }
    if (this.viewDirty) {
      this.viewDirty = false;
      this.callbacks.onViewChange({ ...this.view });
    }
  }

  private paintPaper(): void {
    const ctx = this.paperCtx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
    if (!this.page) return;
    this.applyView(ctx);
    drawPaper(ctx, {
      template: this.page.template,
      width: this.page.width,
      height: this.page.height,
      scale: this.view.scale,
      tint: this.page.backgroundTint,
      infinite: this.page.size === 'infinite',
      showBoundary: this.showBoundary,
      gridSpacing: this.page.gridSpacing,
    });
    const pdf = this.pdfBitmap;
    if (pdf && this.page.pdfAssetId) {
      const px = this.page.size === 'infinite' ? this.cssWidth / this.view.scale : this.page.width;
      const py = this.page.size === 'infinite' ? this.cssHeight / this.view.scale : this.page.height;
      const ratio = Math.min(px / (pdf.width || px), py / (pdf.height || py));
      const w = (pdf.width || px) * ratio;
      const h = (pdf.height || py) * ratio;
      ctx.drawImage(pdf.image, (px - w) / 2, (py - h) / 2, w, h);
    }
    this.paperView = { ...this.view };
    this.paperDoc = this.paintedDocBounds();
    this.paperCanvas.style.transform = '';
  }

  private paintInk(): void {
    const ctx = this.inkCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.inkCanvas.width, this.inkCanvas.height);
    this.applyView(ctx);

    const viewport = this.viewportDocBounds();
    // Only what the viewport can show, in the order it was drawn: the page's total
    // ink no longer enters the cost of a repaint, and overlapping strokes still
    // stack exactly as they were written. The grid must hold exactly the page's
    // ink; if it ever drifts out of step, draw the list rather than hide a stroke.
    const strokes =
      this.inkIndex.size === this.strokes.length
        ? this.viewportInk.visible(this.inkIndex, viewport)
        : this.viewportInk.scan(this.strokes, viewport);
    this.visibleStrokes = strokes.length;
    for (const stroke of strokes) {
      drawStroke(ctx, stroke, { path: this.strokePaths.pathFor(stroke) });
    }
    this.inkView = { ...this.view };
    this.inkDoc = this.paintedDocBounds();
    this.inkCanvas.style.transform = '';
    this.paintImagesAndText(ctx, null);
  }

  /**
   * Repaints one rectangle of the ink layer: clears it, then draws only the
   * strokes reaching into it. Cost follows what the fingers touched, not how
   * much ink the page holds.
   */
  private paintInkRegion(region: Bounds): void {
    const ctx = this.inkCtx;
    const tl = this.toScreen(region.minX, region.minY);
    const br = this.toScreen(region.maxX, region.maxY);
    const pad = 4;
    const x = Math.max(0, Math.floor(Math.min(tl.x, br.x) - pad));
    const y = Math.max(0, Math.floor(Math.min(tl.y, br.y) - pad));
    const right = Math.min(this.cssWidth, Math.ceil(Math.max(tl.x, br.x) + pad));
    const bottom = Math.min(this.cssHeight, Math.ceil(Math.max(tl.y, br.y) + pad));
    if (right - x <= 0 || bottom - y <= 0) return;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.beginPath();
    ctx.rect(x, y, right - x, bottom - y);
    ctx.clip();
    ctx.clearRect(x, y, right - x, bottom - y);
    this.applyView(ctx);
    for (const id of this.inkIndex.queryExact(region, (id) => this.strokeBounds.get(id))) {
      const stroke = this.strokeById.get(id);
      if (!stroke) continue;
      drawStroke(ctx, stroke, { path: this.strokePaths.pathFor(stroke) });
    }
    this.paintImagesAndText(ctx, region);
    ctx.restore();
  }

  private paintImagesAndText(ctx: CanvasRenderingContext2D, region: Bounds | null): void {
    for (const image of this.images) {
      const bounds = {
        minX: image.x,
        minY: image.y,
        maxX: image.x + image.width,
        maxY: image.y + image.height,
      };
      if (region && !boundsIntersect(bounds, region)) continue;
      const bitmap = this.imageBitmaps.get(image.assetId);
      if (!bitmap) {
        ctx.save();
        ctx.strokeStyle = 'rgba(31,29,26,0.25)';
        ctx.setLineDash([6 / this.view.scale, 6 / this.view.scale]);
        ctx.strokeRect(image.x, image.y, image.width, image.height);
        ctx.restore();
        continue;
      }
      ctx.drawImage(bitmap, image.x, image.y, image.width, image.height);
    }
    for (const text of this.texts) {
      if (region) {
        const bounds = {
          minX: text.x,
          minY: text.y,
          maxX: text.x + text.width,
          maxY: text.y + text.fontSize * 1.4,
        };
        if (!boundsIntersect(bounds, region)) continue;
      }
      paintText(ctx, text);
    }
  }

  private boundsFor(stroke: Stroke): Bounds {
    const cached = this.strokeBounds.get(stroke.id);
    if (cached) return cached;
    const bounds = boundsOfPoints(stroke.points, stroke.width * 1.5 + 2);
    this.strokeBounds.set(stroke.id, bounds);
    return bounds;
  }

  /** Turns off stretching and leaves the layers to be repainted at full quality. */
  private cancelApproximation(): void {
    if (!this.approximating) return;
    this.approximating = false;
    this.paperCanvas.style.transform = '';
    this.inkCanvas.style.transform = '';
  }

  /** Which CSS stretch maps a layer painted at `from` onto the current view. */
  private layerTransform(from: ViewTransform | null): string {
    if (!from) return '';
    const k = this.view.scale / from.scale;
    const dx = this.view.tx - from.tx * k;
    const dy = this.view.ty - from.ty * k;
    if (k === 1 && Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return '';
    return `translate(${dx}px, ${dy}px) scale(${k})`;
  }

  /**
   * Moves the view without repainting: the paper and ink layers are stretched by
   * the compositor, so a pan or a pinch costs no raster work at all. The pixels
   * are rebuilt exactly when the gesture settles.
   */
  /** What a full paint of this view actually fills with pixels. */
  private paintedDocBounds(): Bounds {
    const viewport = this.viewportDocBounds();
    const page = this.page;
    if (!page || page.size === 'infinite') return viewport;
    return {
      minX: Math.max(viewport.minX, 0),
      minY: Math.max(viewport.minY, 0),
      maxX: Math.min(viewport.maxX, page.width),
      maxY: Math.min(viewport.maxY, page.height),
    };
  }

  /** The same view, zoomed out to leave a margin of already-painted page. */
  private expandedView(view: ViewTransform): ViewTransform {
    const k = 1 / this.paintMargin;
    const cx = this.cssWidth / 2;
    const cy = this.cssHeight / 2;
    return {
      scale: view.scale * k,
      tx: cx - (cx - view.tx) * k,
      ty: cy - (cy - view.ty) * k,
    };
  }

  /** Is everything the new view needs already on the layers? */
  private coveredByPaint(): boolean {
    const needed = this.paintedDocBounds();
    const inside = (held: Bounds | null): boolean => {
      if (!held) return false;
      const eps = 0.5 / this.view.scale;
      return (
        needed.minX >= held.minX - eps &&
        needed.minY >= held.minY - eps &&
        needed.maxX <= held.maxX + eps &&
        needed.maxY <= held.maxY + eps
      );
    };
    return inside(this.paperDoc) && inside(this.inkDoc);
  }

  private approximateView(): void {
    // Only stretch pixels that are up to date. If a repaint is already queued
    // (a page change, a new stroke, the tail of the previous gesture) dropping it
    // would stretch stale content, so let it run at the new view instead.
    if (!this.paperView || !this.inkView || this.pendingPaper || this.pendingInk || this.pendingInkDirty) {
      this.pendingPaper = this.pendingPaper || !this.paperView;
      this.pendingInk = this.pendingInk || !this.inkView;
      this.schedule();
      return;
    }
    // A stretched layer is a window onto the page, not the page itself: zooming
    // out (or panning past the ink) asks for pixels it never held, which showed
    // up as the sheet collapsing to a stamp on the desk. Repaint in that case.
    if (!this.coveredByPaint()) {
      // Buy more page than this gesture has needed so far: a pinch that keeps
      // shrinking would otherwise outgrow the layers on every frame and pay a
      // full repaint each time.
      this.paintMargin = widenPaintMargin(this.paintMargin);
      this.expandPaint = true;
      this.pendingPaper = true;
      this.pendingInk = true;
      this.pendingInkDirty = null;
      this.schedule();
      return;
    }
    this.approximating = true;
    this.pendingPaper = false;
    this.pendingInk = false;
    this.pendingInkDirty = null;
    this.paperCanvas.style.transform = this.layerTransform(this.paperView);
    this.inkCanvas.style.transform = this.layerTransform(this.inkView);
  }

  /**
   * Rebuilds the layers at the new view once the fingers are still.
   *
   * The stretch is deliberately left in place: each layer drops its own transform
   * in the same frame that repaints it (see paintPaper and paintInk). Clearing
   * them here instead would show the old pixels at their old size for one frame,
   * which read as the sheet snapping back before the new zoom landed.
   */
  private settleRaster(): void {
    if (!this.approximating) return;
    this.approximating = false;
    this.paintMargin = PAINT_MARGIN;
    this.pendingPaper = true;
    this.pendingInk = true;
    this.pendingInkDirty = null;
    this.schedule();
  }

  /**
   * Clears only the part of the live layer the previous frame drew on. Wiping
   * the whole 2048x2620 backing store every frame costs milliseconds at iPad
   * device scale, and the wet layer is usually a few percent of the page.
   */
  private clearLive(rect: LiveRect | null): void {
    const ctx = this.liveCtx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (!rect) {
      ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
      return;
    }
    const x = Math.max(0, Math.floor(rect.minX) - 2);
    const y = Math.max(0, Math.floor(rect.minY) - 2);
    const w = Math.min(this.cssWidth, Math.ceil(rect.maxX) + 2) - x;
    const h = Math.min(this.cssHeight, Math.ceil(rect.maxY) + 2) - y;
    if (w > 0 && h > 0) ctx.clearRect(x, y, w, h);
  }

  /**
   * Screen-space box the current frame will paint on the live layer. Conservative
   * on purpose: a box that is a little too large only costs a larger clear.
   */
  private liveContentRect(): LiveRect | null {
    const session = this.session;
    const pad = (strokeWidth: number) => strokeWidth + 4;
    const docRect = (b: Bounds, extra: number): LiveRect => {
      const tl = this.toScreen(b.minX - extra, b.minY - extra);
      const br = this.toScreen(b.maxX + extra, b.maxY + extra);
      return {
        minX: Math.min(tl.x, br.x),
        minY: Math.min(tl.y, br.y),
        maxX: Math.max(tl.x, br.x),
        maxY: Math.max(tl.y, br.y),
      };
    };
    let rect: LiveRect | null = null;
    const add = (r: LiveRect | null) => {
      if (!r) return;
      rect = rect
        ? {
            minX: Math.min(rect.minX, r.minX),
            minY: Math.min(rect.minY, r.minY),
            maxX: Math.max(rect.maxX, r.maxX),
            maxY: Math.max(rect.maxY, r.maxY),
          }
        : r;
    };

    switch (session.kind) {
      case 'draw': {
        const stroke = session.stroke;
        add(docRect(boundsOfPoints(stroke.points, stroke.width * 1.5 + 2), pad(stroke.width)));
        break;
      }
      case 'shape': {
        const a = session.start;
        const b = session.current;
        add(
          docRect(
            {
              minX: Math.min(a.x, b.x),
              minY: Math.min(a.y, b.y),
              maxX: Math.max(a.x, b.x),
              maxY: Math.max(a.y, b.y),
            },
            pad(this.toolSettings[this.tool as ShapeToolId]?.width ?? 3),
          ),
        );
        break;
      }
      case 'erase': {
        const p = this.toScreen(session.last.x, session.last.y);
        const r = this.toolSettings.eraser.width / 2 + 2;
        add({ minX: p.x - r, minY: p.y - r, maxX: p.x + r, maxY: p.y + r });
        break;
      }
      case 'lasso': {
        if (session.points.length >= 2) add(docRect(boundsOfPoints(session.points, 6), 6));
        break;
      }
      default:
        break;
    }

    // The rub cue and the selection box live on this layer too.
    if (this.scrubActive) {
      const r = SCRUB_RADIUS_PX + 4;
      for (const touch of this.activePointers.values()) {
        add({ minX: touch.x - r, minY: touch.y - r, maxX: touch.x + r, maxY: touch.y + r });
      }
    }
    const selection = this.selectionBounds();
    if (selection) add(docRect(selection, HANDLE_SCREEN_SIZE));
    return rect;
  }

  private paintLive(): void {
    const ctx = this.liveCtx;
    const s = this.view.scale;
    const session = this.session;
    const selection = this.selectionBounds();
    // Nothing to draw and nothing left on the layer: clearing it would wipe a
    // full-resolution backing store to leave it exactly as it was. A drag or a
    // pinch with a dry pencil is that, frame after frame.
    if (
      !liveFrameHasWork({
        kind: session.kind,
        painted: this.livePaintedRect !== null,
        scrubbing: this.scrubActive,
        selection: selection !== null,
      })
    ) {
      return;
    }
    // A wet stroke that paints over itself cleanly is added to the layer piece by
    // piece, so a frame costs its tail instead of the whole stroke. Anything else
    // this layer carries (a selection box, a rub cue) wants the frame cleared as a
    // whole, so those keep the whole-outline repaint below.
    if (session.kind === 'draw' && !this.scrubActive && selection === null) {
      if (isIncrementalStroke(session.stroke)) {
        this.paintLiveStroke(session.stroke);
        return;
      }
    }
    // Anything else on this layer (a selection box, a rub cue) is painted at its
    // own opacity, not at the opacity of a wet stroke.
    if (this.liveCanvas.style.opacity !== '') this.liveCanvas.style.opacity = '';
    const bounds = selection;
    const next = this.liveContentRect();
    const previous = this.livePaintedRect;
    this.clearLive(
      previous && next
        ? {
            minX: Math.min(previous.minX, next.minX),
            minY: Math.min(previous.minY, next.minY),
            maxX: Math.max(previous.maxX, next.maxX),
            maxY: Math.max(previous.maxY, next.maxY),
          }
        : next ?? previous,
    );
    this.applyView(ctx);

    switch (session.kind) {
      case 'draw': {
        // The wet stroke is drawn from exactly the points that will be committed,
        // with the same brush call the ink layer uses, so lifting the pen changes
        // nothing on screen. Painting it piece by piece was cheaper, but each
        // piece restarted the brush's smoothing, so the committed outline was a
        // different shape from the one under the pencil.
        drawStroke(ctx, session.stroke, { path: this.strokePaths.pathFor(session.stroke) });
        break;
      }
      case 'shape':
        drawStroke(ctx, this.makeShapeStroke(session.start, session.current));
        break;
      case 'erase': {
        const p = session.last;
        ctx.save();
        ctx.strokeStyle = 'rgba(74,97,86,0.65)';
        ctx.lineWidth = 1 / s;
        ctx.beginPath();
        ctx.arc(p.x, p.y, this.toolSettings.eraser.width / 2, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        break;
      }
      case 'lasso': {
        const points = session.points;
        if (points.length > 1) {
          ctx.save();
          ctx.strokeStyle = this.toolSettings.lasso.color;
          ctx.lineWidth = 1.5 / s;
          ctx.setLineDash([6 / s, 5 / s]);
          ctx.beginPath();
          ctx.moveTo(points[0]!.x, points[0]!.y);
          for (const p of points.slice(1)) ctx.lineTo(p.x, p.y);
          ctx.closePath();
          ctx.stroke();
          ctx.restore();
        }
        break;
      }
      default:
        break;
    }

    // The rub shows its radius under both fingers: the ink disappears a moment
    // before the finger arrives, otherwise the gesture feels like a guess.
    if (this.scrubActive && this.session.kind === 'pinch' && this.session.mode === 'scrub') {
      const radius = Math.max(1, SCRUB_RADIUS_PX / s);
      ctx.save();
      ctx.strokeStyle = 'rgba(74,97,86,0.55)';
      ctx.fillStyle = 'rgba(74,97,86,0.08)';
      ctx.lineWidth = 1.5 / s;
      for (const touch of this.activePointers.values()) {
        if (touch.type !== 'touch') continue;
        ctx.beginPath();
        ctx.arc(touch.x, touch.y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }

    if (bounds) {
      ctx.save();
      ctx.strokeStyle = '#4a6156';
      ctx.lineWidth = 1.5 / s;
      ctx.setLineDash([7 / s, 5 / s]);
      ctx.strokeRect(bounds.minX, bounds.minY, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
      ctx.setLineDash([]);
      const handle = HANDLE_SCREEN_SIZE / s;
      const hx = bounds.maxX - handle / 2;
      const hy = bounds.maxY - handle / 2;
      ctx.fillStyle = '#fffdfa';
      ctx.fillRect(hx, hy, handle, handle);
      ctx.strokeRect(hx, hy, handle, handle);
      ctx.restore();
    }

    this.livePaintedRect = next;
  }

  /**
   * Adds a growing stroke to the live layer, keeping what has become final.
   *
   * The layer is cleared only where the moving tail is, so the pixels under the
   * settled part of the stroke are left alone: a frame touches a few dozen points
   * at most, whatever the length of the stroke. The geometry of each piece and
   * the brush it is drawn with live in LiveStrokePainter.
   */
  private paintLiveStroke(stroke: Stroke): void {
    const ctx = this.liveCtx;
    // The cleared box is the box of the piece's own points: every pixel it wipes
    // is inside the ink the piece paints back over, so no gap can open between
    // two pieces.
    const pad = 0;
    const surface: LiveSurface = {
      clear: (rect) => {
        // Exact, unlike clearLive: a couple of pixels of margin would erase ink
        // from the settled part of the stroke that the piece does not paint back.
        const c = this.liveCtx;
        c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        // Rounded inwards: the box stays inside the ink the piece paints back.
        const x = Math.max(0, Math.ceil(rect.minX));
        const y = Math.max(0, Math.ceil(rect.minY));
        const w = Math.min(this.cssWidth, Math.floor(rect.maxX)) - x;
        const h = Math.min(this.cssHeight, Math.floor(rect.maxY)) - y;
        if (w > 0 && h > 0) c.clearRect(x, y, w, h);
        this.applyView(ctx);
      },
      paint: (path) => {
        // Full opacity on purpose: the stroke's own opacity is put on the layer
        // below, so two pieces that overlap do not stack their alpha.
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.fillStyle = stroke.color;
        ctx.fill(path);
        if (stroke.tool === 'pencil') {
          // The graphite edge, in layer space: the layer's opacity applies to it.
          ctx.globalAlpha = 0.35;
          ctx.strokeStyle = stroke.color;
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.lineWidth = Math.max(0.5, stroke.width * 0.18);
          ctx.stroke(path);
        }
        ctx.restore();
      },
      rectOf: (from, to) => {
        const doc = boundsOfPoints(stroke.points.slice(from, to), pad);
        const tl = this.toScreen(doc.minX, doc.minY);
        const br = this.toScreen(doc.maxX, doc.maxY);
        return {
          minX: Math.min(tl.x, br.x),
          minY: Math.min(tl.y, br.y),
          maxX: Math.max(tl.x, br.x),
          maxY: Math.max(tl.y, br.y),
        };
      },
      inkBox: (from, to) => {
        // How far past its own points a nib of this width paints, plus room for
        // the antialiased edge.
        const reach = stroke.width * 0.5 + 2 + (stroke.tool === 'pencil' ? stroke.width * 0.18 : 0);
        const doc = boundsOfPoints(stroke.points.slice(from, to), reach);
        const tl = this.toScreen(doc.minX, doc.minY);
        const br = this.toScreen(doc.maxX, doc.maxY);
        return {
          minX: Math.min(tl.x, br.x),
          minY: Math.min(tl.y, br.y),
          maxX: Math.max(tl.x, br.x),
          maxY: Math.max(tl.y, br.y),
        };
      },
    };
    this.applyView(ctx);
    this.liveCanvas.style.opacity = stroke.opacity === 1 ? '' : String(stroke.opacity);
    this.livePainter.paint(stroke, surface);
    this.livePaintedRect = this.livePainter.painted;
  }

  /* ---------------------------------------------------------------- */
  /* Input                                                             */
  /* ---------------------------------------------------------------- */

  private onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  private localPoint(e: PointerEvent | WheelEvent): { x: number; y: number } {
    // getBoundingClientRect forces layout; a 120 Hz pencil with coalesced
    // events would call it a dozen times per frame. One read per gesture is
    // enough, refreshed on entry and on resize.
    if (this.stageRect === null) this.stageRect = this.stage.getBoundingClientRect();
    return { x: e.clientX - this.stageRect.left, y: e.clientY - this.stageRect.top };
  }

  private makePoint(e: PointerEvent): StrokePoint {
    const local = this.localPoint(e);
    const pressure = e.pointerType === 'pen' ? Math.max(0.01, e.pressure || 0.4) : 0.5;
    return inkPointAt(local.x, local.y, pressure, e.tiltX ?? 0, e.tiltY ?? 0, e.timeStamp, this.view);
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.page) return;
    // The toolbar moves and the page scrolls between gestures: read the box now.
    this.stageRect = this.stage.getBoundingClientRect();
    const local = this.localPoint(e);
    const width = Math.max(e.width || 0, e.height || 0);
    // A hand resting on the glass reports a contact far wider than the fingers
    // this device has seen; it stays tracked so a pinch can re-pair onto the real
    // fingers, but it never starts a drag or counts towards a tap on its own.
    const palm = e.pointerType === 'touch' && this.palmRejection && isPalmContact(width, medianWidth(this.fingerWidths));
    this.activePointers.set(e.pointerId, {
      x: local.x,
      y: local.y,
      type: e.pointerType,
      w: width,
      palm,
    });
    try {
      this.stage.setPointerCapture(e.pointerId);
    } catch {
      /* Safari may refuse capture for pointers it has already cancelled. */
    }

    const touchCount = this.countTouches();

    if (e.pointerType === 'touch') {
      // Only the pencil's own authority drops a touch now: a finger that lands in
      // the moments after the pencil lifts is the first half of a pinch as often
      // as it is the hand that was holding it. Width never decides here either —
      // a finger flattened on the glass is still a finger, which is why pinching
      // with the pads of the fingers used to do nothing. Palms are kept out by
      // comparing contacts (pickPinchPair), so a resting hand cannot drive the
      // gesture whatever the clock says.
      const guard = {
        palmRejection: this.palmRejection,
        penDown: this.penDown,
        sincePenUp: e.timeStamp - this.penLastAt,
        penSession: isPenSession(this.session.kind),
      };
      if (shouldRejectTouch(guard)) {
        // A resting hand must not leave a pointer behind: an ignored contact that
        // stays in the map turns the next real finger into a phantom pinch.
        this.dropPointer(e.pointerId);
        return;
      }
      if (palm) {
        // A hand landing is not the start of a tap: it must not turn a one-finger
        // touch into a two-finger undo, nor keep the sequence alive.
        this.cancelTap();
      } else {
        this.fingerWidths.push(width);
        if (this.fingerWidths.length > 8) this.fingerWidths.shift();
        // A tap counts fingers only: a palm resting beside the finger must not
        // turn one finger into a two-finger undo.
        this.trackTap(e, this.countFingers());
      }
      if (touchCount >= 2) {
        // A knuckle or a resting hand adds a third contact mid-pinch. Re-anchoring
        // the gesture on a new pair resets the scale origin and the sheet jumps,
        // so a pinch that is already running keeps the fingers it started with.
        // Before it has moved anything, though, a narrower contact is the real
        // finger rather than the hand, and taking it costs nothing.
        if (this.session.kind !== 'pinch') this.beginPinch();
        else this.repairPinch();
        return;
      }
      // A finger inside the post-pencil hold-back is tracked at once, so it is
      // ready to be half of a pinch, but it does not pan on its own: it may be
      // the hand the pencil was just resting on. It starts panning the moment the
      // window passes, from onPointerMove, so nothing stays dead under a finger.
      if (
        this.oneFingerPan &&
        touchCount === 1 &&
        !this.singleFingerLock &&
        !palm &&
        !inPenGrace(guard)
      ) {
        this.session = { kind: 'pan', last: local };
      }
      return;
    }

    if (e.pointerType === 'pen') {
      this.penDown = true;
      this.cancelTap();
      // The hand holding the pencil is still on the glass. Dropping it now means
      // its lift cannot land in the middle of a stroke and cut the ink short.
      for (const [id, pointer] of [...this.activePointers]) {
        if (pointer.type === 'touch') this.activePointers.delete(id);
      }
      this.singleFingerLock = false;
    }
    if (this.session.kind === 'pan' || this.session.kind === 'pinch') {
      this.session = { kind: 'none' };
    }
    this.beginTool(e);
  };

  private countTouches(): number {
    let n = 0;
    for (const p of this.activePointers.values()) if (p.type === 'touch') n += 1;
    return n;
  }

  /** Touches that are fingers: a resting hand is not part of a tap. */
  private countFingers(): number {
    let n = 0;
    for (const p of this.activePointers.values()) if (p.type === 'touch' && !p.palm) n += 1;
    return n;
  }

  private beginTool(e: PointerEvent): void {
    const point = this.makePoint(e);
    this.lastPressure = 0;

    switch (this.tool) {
      case 'fountain':
      case 'ballpoint':
      case 'pencil':
      case 'highlighter': {
        this.snappedStroke = false;
        this.lastMoveAt = performance.now();
        const settings = this.toolSettings[this.tool];
        const stroke: Stroke = {
          id: newId(),
          pageId: this.page!.id,
          tool: this.tool,
          color: settings.color,
          width: settings.width,
          opacity: settings.opacity,
          points: [point],
          shape: null,
          createdAt: now(),
          updatedAt: now(),
          version: 1,
          deviceId: '',
          deletedAt: null,
        };
        this.session = { kind: 'draw', stroke };
        this.invalidateLive();
        break;
      }
      case 'line':
      case 'rect':
      case 'circle':
      case 'ellipse':
      case 'triangle':
      case 'arrow':
        this.session = {
          kind: 'shape',
          start: this.snapShapePoint(point),
          current: this.snapShapePoint(point),
        };
        this.invalidateLive();
        break;
      case 'eraser':
        this.session = {
          kind: 'erase',
          last: point,
          before: this.strokes.slice(),
          lastEraseAt: performance.now(),
          dirty: null,
        };
        this.eraseAt(point, this.toolSettings.eraser.width / 2);
        break;
      case 'lasso': {
        const local = this.localPoint(e);
        if (this.hasSelection()) {
          if (this.hitResizeHandle(local)) {
            this.beginResize(point);
            return;
          }
          if (this.selectionContains(point)) {
            this.beginMove(point);
            return;
          }
        }
        this.clearSelection();
        this.session = { kind: 'lasso', points: [point] };
        this.invalidateLive();
        break;
      }
      case 'text': {
        this.clearSelection();
        const stageLocal = this.localPoint(e);
        const doc = this.toDoc(stageLocal.x, stageLocal.y);
        this.callbacks.requestTextEdit({
          id: null,
          x: doc.x,
          y: doc.y,
          width: 320,
          text: '',
          fontSize: this.toolSettings.text.fontSize,
          color: this.toolSettings.text.color,
          align: 'left',
        });
        break;
      }
      case 'image':
        this.callbacks.requestImage();
        break;
      default:
        break;
    }
  }

  private beginPinch(): void {
    const touches = [...this.activePointers.entries()]
      .filter(([, p]) => p.type === 'touch')
      .map(([id, p]) => ({ id, ...p }));
    if (touches.length < 2) return;
    const picked = pickPinchPair(touches);
    if (!picked) return;
    const a = touches[picked[0]]!;
    const b = touches[picked[1]]!;
    // Anchored on the view as it stands. The first finger of a pinch always lands
    // alone and pans, so putting the sheet back now would move it under the
    // finger at the very instant the second one arrives. However long the second
    // finger took and however far the first one slid, the zoom grows out of what
    // is already on screen: the transition is continuous, with nothing to
    // catch.
    const anchor = pinchAnchor(this.view, a, b);
    this.session = {
      kind: 'pinch',
      anchor,
      // Two fingers can mean zoom, erase or pan; the next move decides.
      mode: 'undecided',
      spreadPeak: 0,
      sweep: { originDist: anchor.startDist, travelPx: 0 },
      scrubLast: new Map([
        [a.id, { x: a.x, y: a.y }],
        [b.id, { x: b.x, y: b.y }],
      ]),
      scrubBefore: null,
      scrubHit: false,
      scrubDirty: null,
      lastMid: { x: anchor.startMid.x, y: anchor.startMid.y },
      pair: [a.id, b.id],
    };
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.page) return;
    const local = this.localPoint(e);
    const stored = this.activePointers.get(e.pointerId);
    // A contact the palm filter dropped still reports moves. Letting those drive
    // the gesture makes the sheet jump between the two fingers on every event,
    // which is the violent shake a two-finger pinch used to end in.
    if (!stored) {
      if (e.pointerType === 'touch') return;
    } else {
      if (e.pointerType === 'touch') this.trackTapMove(e);
      stored.x = local.x;
      stored.y = local.y;
    }
    if (e.pointerType === 'pen') this.cancelTap();

    // A finger that landed during the post-pencil hold-back starts panning as
    // soon as the window has passed: the hold-back delays a pan, it never loses
    // one. A pinch is unaffected — it starts from its own second contact.
    if (
      this.session.kind === 'none' &&
      e.pointerType === 'touch' &&
      stored !== undefined &&
      !stored.palm &&
      this.oneFingerPan &&
      !this.singleFingerLock &&
      this.countTouches() === 1 &&
      !this.inPenGraceNow()
    ) {
      this.session = { kind: 'pan', last: local };
    }

    switch (this.session.kind) {
      case 'draw': {
        if (e.pointerType !== 'pen' && e.pointerType !== 'mouse') break;
        const stroke = this.session.stroke;
        const events =
          typeof e.getCoalescedEvents === 'function' ? (e.getCoalescedEvents() as PointerEvent[]) : [];
        const list = events.length > 0 ? events : [e];
        for (const ev of list) {
          const p = this.makePoint(ev);
          if (this.snappedStroke) {
            // After the hold the stroke is a line: the nib keeps moving its end.
            stroke.points = [stroke.points[0]!, p];
            continue;
          }
          if (ev.pointerType === 'pen') {
            this.lastPressure = smoothPressure(this.lastPressure, p.pressure);
            p.pressure = this.lastPressure;
          }
          const last = stroke.points[stroke.points.length - 1]!;
          if (!nibHasMoved(last, p, MIN_NIB_SCREEN_DISTANCE, this.view.scale)) continue;
          stroke.points.push(p);
        }
        this.lastMoveAt = performance.now();
        this.armSnapHold();
        this.invalidateLive();
        break;
      }
      case 'shape': {
        this.session.current = this.snapShapePoint(this.makePoint(e), this.session.start);
        this.invalidateLive();
        break;
      }
      case 'erase': {
        if (e.pointerType === 'touch') break;
        const point = this.makePoint(e);
        const t = performance.now();
        if (t - this.session.lastEraseAt >= ERASE_THROTTLE_MS) {
          const box = this.eraseSegment(this.session.last, point, this.toolSettings.eraser.width / 2);
          if (box) {
            const before = this.session.dirty;
            this.session.dirty = before
              ? {
                  minX: Math.min(before.minX, box.minX),
                  minY: Math.min(before.minY, box.minY),
                  maxX: Math.max(before.maxX, box.maxX),
                  maxY: Math.max(before.maxY, box.maxY),
                }
              : box;
          }
          this.session.lastEraseAt = t;
          this.session.last = point;
        }
        this.invalidateLive();
        break;
      }
      case 'lasso': {
        const point = this.makePoint(e);
        const last = this.session.points[this.session.points.length - 1]!;
        if (Math.hypot(point.x - last.x, point.y - last.y) > 2 / this.view.scale) {
          this.session.points.push(point);
          this.invalidateLive();
        }
        break;
      }
      case 'move': {
        const point = this.makePoint(e);
        const dx = point.x - this.session.last.x;
        const dy = point.y - this.session.last.y;
        if (dx === 0 && dy === 0) break;
        this.session.last = { x: point.x, y: point.y };
        this.translateSelection(dx, dy);
        this.invalidateInk();
        break;
      }
      case 'resize': {
        const point = this.makePoint(e);
        this.session.last = { x: point.x, y: point.y };
        const origin = this.session.origin;
        const startDx = Math.abs(this.resizeStartX - origin.x);
        const startDy = Math.abs(this.resizeStartY - origin.y);
        const factorX = Math.abs(point.x - origin.x) / Math.max(4, startDx);
        const factorY = Math.abs(point.y - origin.y) / Math.max(4, startDy);
        const factor = (factorX + factorY) / 2;
        this.scaleSelection(origin, factor);
        this.invalidateInk();
        break;
      }
      case 'pan': {
        const pan = this.session;
        const dx = local.x - pan.last.x;
        const dy = local.y - pan.last.y;
        pan.last = local;
        this.view = { ...this.view, tx: this.view.tx + dx, ty: this.view.ty + dy };

        // Overlays follow the view only when the page has any; forcing it every
        // frame re-rendered the whole editor 145 times a second for nothing.
        this.queueViewChange();
        // The stretch is written on the frame, not on every finger sample.
        this.pendingApproximation = true;
        this.invalidateLive();
        break;
      }
      case 'pinch': {
        // Two fingers report one at a time: acting on a single event measures a
        // distance where one finger has already moved and the other has not,
        // which swings the zoom by several percent every event — the sheet
        // shivers instead of zooming. The pair is read once per frame instead,
        // when both positions are as current as they get.
        this.gestureDirty = true;
        this.invalidateLive();
        break;
      }
      default:
        break;
    }
  };

  /**
   * Reads both fingers and moves the sheet for the frame.
   *
   * Naming the gesture happens here too, and once named it never changes back: a
   * pinch that has started zooming must not turn into a pan halfway through.
   */
  /**
   * Swaps in a better pair of contacts while the pinch is still untouched.
   *
   * Nothing has been applied yet, so re-anchoring cannot move the sheet; this is
   * the only moment a resting hand can be replaced by the fingers that follow it.
   */
  private repairPinch(): void {
    const s = this.session;
    if (s.kind !== 'pinch') return;
    if (s.mode !== 'undecided') return;
    const held = s.anchor.startView;
    if (this.view.scale !== held.scale || this.view.tx !== held.tx || this.view.ty !== held.ty) {
      return;
    }
    const touches = [...this.activePointers.entries()]
      .filter(([, p]) => p.type === 'touch')
      .map(([id, p]) => ({ id, ...p }));
    const picked = pickPinchPair(touches);
    if (!picked) return;
    const a = touches[picked[0]]!;
    const b = touches[picked[1]]!;
    if (s.pair[0] === a.id && s.pair[1] === b.id) return;
    s.pair = [a.id, b.id];
    s.anchor = pinchAnchor(this.view, a, b);
    s.spreadPeak = 0;
    s.sweep = { originDist: s.anchor.startDist, travelPx: 0 };
    s.lastMid = { x: s.anchor.startMid.x, y: s.anchor.startMid.y };
    s.scrubLast = new Map([
      [a.id, { x: a.x, y: a.y }],
      [b.id, { x: b.x, y: b.y }],
    ]);
  }

  private applyTwoFinger(): void {
    const s = this.session;
    if (s.kind !== 'pinch') return;
    const first = this.activePointers.get(s.pair[0]);
    const second = this.activePointers.get(s.pair[1]);
    if (!first || !second) return;
    const a = { id: s.pair[0], ...first };
    const b = { id: s.pair[1], ...second };
    // Deliberately not floored: the anchor's distance is not floored either, and
    // flooring one of them is a step of its own at the moment of takeover.
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const anchor = s.anchor;
    const stepX = mid.x - s.lastMid.x;
    const stepY = mid.y - s.lastMid.y;
    s.lastMid = mid;
    // The two pieces of evidence are accumulated, never sampled: spreading is the
    // one thing a rub never does, so a pixel of it outweighs any amount of
    // travelling afterwards, and a pinch keeps cutting its own sweep short by
    // drifting even when each individual sample barely moves.
    s.spreadPeak = peakSpread(s.spreadPeak, anchor.startDist, dist);
    s.sweep = sweep(s.sweep, dist, Math.hypot(stepX, stepY));

    // Before the gesture is named, its motion names it: spreading is zoom,
    // moving together is a rub, and neither leaves a two-finger tap alone.
    if (s.mode === 'undecided' && !this.twoFingerErase) s.mode = 'pinch';
    if (s.mode === 'undecided') {
      const decided = classifyTwoFinger({
        peakSpreadPx: s.spreadPeak,
        sweepTravelPx: s.sweep.travelPx,
      });
      if (decided === 'pinch') s.mode = 'pinch';
      if (decided === 'scrub') {
        s.mode = 'scrub';
        s.scrubBefore = this.strokes.slice();
        // The sweep that used this long to prove the pair is not zooming is not
        // ink the user meant to erase: the rub starts under the fingers as they
        // are now, instead of painting a mark back along the whole arbitration
        // path the moment the eraser arms.
        s.scrubLast = new Map([
          [a.id, { x: a.x, y: a.y }],
          [b.id, { x: b.x, y: b.y }],
        ]);
        this.scrubActive = true;
        this.markTapMoved();
      }
    }

    if (s.mode === 'scrub') {
      if (s.spreadPeak >= PINCH_HINT_PX) {
        // The fingers are pulling apart after all: stop erasing, keep the ink
        // that was already rubbed away as one undo step, and zoom from here.
        this.scrubActive = false;
        s.mode = 'pinch';
        s.anchor = pinchAnchor(this.view, a, b);
        s.spreadPeak = 0;
        s.sweep = { originDist: s.anchor.startDist, travelPx: 0 };
      }
    }
    if (s.mode === 'scrub') {
      this.rubAt(a, b);
      if (scrubTurnsIntoPan(s.anchor.startMid, { dist, mid }, s.scrubHit)) {
        // A sweep that crossed no ink is a pan, which keeps two-finger
        // scrolling available on empty paper.
        s.mode = 'pan';
        this.scrubActive = false;
      } else {
        return;
      }
    }

    if (s.mode === 'pan') {
      // Fingers that start pulling apart are zooming: carry on as a zoom from
      // where the sheet is now, instead of refusing to zoom for the rest of the
      // gesture just because it began as a drag.
      if (s.spreadPeak >= PINCH_HINT_PX) {
        s.mode = 'pinch';
        s.anchor = pinchAnchor(this.view, a, b);
        s.spreadPeak = 0;
        s.sweep = { originDist: s.anchor.startDist, travelPx: 0 };
      } else {
        if (stepX !== 0 || stepY !== 0) {
          this.view = { ...this.view, tx: this.view.tx + stepX, ty: this.view.ty + stepY };
          this.pendingPaper = true;
          this.pendingInk = true;
          this.queueViewChange();
        }
        return;
      }
    }

    // The whole view comes from the anchor and the two fingers, so the sheet is
    // continuous frame to frame: at the moment of takeover `dist` and `mid` are
    // the anchor's own, and the view it asks for is the one already on screen.
    const next = pinchView(s.anchor, dist, mid);
    // Only a named pinch cancels the tap. One finger of a two-finger tap arrives
    // a frame before the other, which briefly stretches the measured distance by
    // several percent; treating that as movement threw away taps whose hand had
    // barely slid.
    if (s.mode === 'pinch' && Math.abs(next.scale / s.anchor.startScale - 1) > 0.03) {
      this.markTapMoved();
    }
    this.view = next;
    this.queueViewChange();
    this.approximateView();
  }

  private resizeStartX = 0;
  private resizeStartY = 0;

  private onPointerUp = (e: PointerEvent): void => {
    if (e.pointerType === 'touch' && !this.activePointers.has(e.pointerId)) return;
    this.finishSession(e, false);
    this.activePointers.delete(e.pointerId);
    if (this.countTouches() === 0) this.singleFingerLock = false;
    if (e.pointerType === 'touch') this.endTap(e);
    if (e.pointerType === 'pen') {
      this.penDown = false;
      this.penLastAt = e.timeStamp;
    }
    if (this.session.kind === 'pinch') {
      // The second finger almost never lifts before the first. Turning the
      // leftover finger into a pan is what made a pinch read as a one-finger
      // drag; instead the gesture stays finished until every finger is up.
      const remaining = [...this.activePointers.values()].some((p) => p.type === 'touch');
      this.session = { kind: 'none' };
      this.singleFingerLock = remaining;
      this.emitViewSettled();
    }
    try {
      this.stage.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  /** Drops a pointer that was rejected, so it cannot skew touch counting. */
  private dropPointer(pointerId: number): void {
    this.activePointers.delete(pointerId);
    try {
      this.stage.releasePointerCapture(pointerId);
    } catch {
      /* The pointer may already be gone. */
    }
  }

  /**
   * The pencil state must not outlive the events that produced it: an app switch
   * or a lost capture can swallow the pointerup, which would otherwise suppress
   * every finger until the next stroke.
   */
  private readonly resetPenState = (): void => {
    this.penDown = false;
    this.penLastAt = Number.NEGATIVE_INFINITY;
    this.lastPressure = 0;
  };

  /** Is the hold-back that follows the pencil still running? */
  private inPenGraceNow(): boolean {
    if (!this.palmRejection || !Number.isFinite(this.penLastAt)) return false;
    return inPenGrace({ sincePenUp: performance.now() - this.penLastAt });
  }

  private readonly onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') this.resetPenState();
  };

  private readonly onLostPointerCapture = (e: PointerEvent): void => {
    if (e.pointerType !== 'pen' || !this.penDown) return;
    this.penDown = false;
    this.penLastAt = e.timeStamp;
  };

  private onPointerCancel = (e: PointerEvent): void => {
    if (e.pointerType === 'touch' && !this.activePointers.has(e.pointerId)) return;
    const wasPinch = this.session.kind === 'pinch';
    this.finishSession(e, true);
    this.activePointers.delete(e.pointerId);
    // A cancelled touch is the system or a palm taking the gesture away: the
    // fingers still down must not start dragging the sheet.
    if (wasPinch) this.singleFingerLock = this.countTouches() > 0;
    if (this.countTouches() === 0) this.singleFingerLock = false;
    if (e.pointerType === 'pen') {
      this.penDown = false;
      this.penLastAt = e.timeStamp;
    }
    this.session = { kind: 'none' };
    this.invalidateLive();
  };

  private finishSession(_e: PointerEvent, cancelled: boolean): void {
    const session = this.session;
    switch (session.kind) {
      case 'draw': {
        const stroke = session.stroke;
        this.cancelSnapHold();
        this.session = { kind: 'none' };
        if (
          this.scribbleToErase &&
          SCRIBBLE_TOOLS.has(stroke.tool) &&
          looksLikeScribble(stroke.points, this.view.scale)
        ) {
          // Goodnotes behaviour: a scrub removes what it crosses and leaves no
          // ink of its own, so the page does not fill up with grey smudges.
          this.eraseAlongScribble(stroke.points);
          this.invalidateLive();
          break;
        }
        if (stroke.points.length >= 2) {
          // Saved exactly as it was drawn: every recorded point, every pressure.
          // Decimating here reshaped the line a frame after the pencil lifted,
          // which reads as the app correcting the handwriting.
          this.commitStrokes([{ ...stroke, updatedAt: now() }], 'Draw');
          // Shape recognition walks every point of the stroke: it can wait for
          // the next task instead of holding the frame the pencil was lifted on.
          if (
            this.recognizeShapes &&
            this.tool !== 'highlighter' &&
            this.tool !== 'eraser' &&
            this.callbacks.onShapeSuggestion &&
            stroke.points.length >= 8
          ) {
            const points = stroke.points;
            window.setTimeout(() => {
              if (this.disposed) return;
              const suggestion = recognizeShape(points);
              if (suggestion) this.callbacks.onShapeSuggestion?.({ ...suggestion, strokeId: stroke.id });
            }, 0);
          }
        } else if (stroke.points.length === 1 && !cancelled) {
          this.commitStrokes([stroke], 'Dot');
        }
        this.invalidateLive();
        break;
      }
      case 'shape': {
        const { start, current } = session;
        this.session = { kind: 'none' };
        if (Math.hypot(current.x - start.x, current.y - start.y) > 2) {
          const settings =
            this.toolSettings[this.tool as ShapeToolId] ?? this.toolSettings.line;
          this.commitStrokes(
            [
              {
                id: newId(),
                pageId: this.page!.id,
                tool: this.tool,
                color: settings.color,
                width: settings.width,
                opacity: settings.opacity,
                points: [start, current],
                shape: this.tool as ShapeKind,
                createdAt: now(),
                updatedAt: now(),
                version: 1,
                deviceId: '',
                deletedAt: null,
              },
            ],
            'Shape',
          );
        }
        this.invalidateLive();
        break;
      }
      case 'erase': {
        this.session = { kind: 'none' };
        if (this.commitErase(session.before, session.dirty)) this.callbacks.onEraseGesture?.();
        break;
      }
      case 'lasso': {
        const polygon = session.points;
        this.session = { kind: 'none' };
        if (polygon.length > 2) this.selectInsidePolygon(polygon);
        this.invalidateLive();
        break;
      }
      case 'move':
      case 'resize': {
        this.session = { kind: 'none' };
        this.commitTransform(session, session.kind === 'move' ? 'Move selection' : 'Resize selection');
        break;
      }
      case 'pan':
        // Ending a drag has to end the session: a pan left behind keeps reading
        // `last`, so the next touch anywhere -- a resting hand included -- would
        // drag the sheet from a stale position.
        this.session = { kind: 'none' };
        this.settleRaster();
        this.emitViewSettled();
        break;
      case 'pinch': {
        // A rub is one undo entry for everything it crossed, and only the area it
        // damaged is repainted. Ending here rather than in pointer-up keeps a
        // cancelled touch (a lost pointer, a relaunched app) from leaving
        // erased ink with no way back.
        this.gestureDirty = false;
        const mode = session.mode;
        const before = session.scrubBefore;
        const dirty = session.scrubDirty;
        this.scrubActive = false;
        this.session = { kind: 'none' };
        if (mode === 'scrub' && before) {
          this.commitErase(before, dirty);
          this.markTapMoved();
        } else {
          this.invalidateLive();
        }
        this.settleRaster();
        this.emitViewSettled();
        break;
      }
      default:
        break;
    }
    if (cancelled) this.invalidateLive();
  }

  private onWheel = (e: WheelEvent): void => {
    if (!this.page) return;
    e.preventDefault();
    const local = this.localPoint(e);
    if (e.ctrlKey || e.metaKey) {
      this.zoomBy(Math.exp(-e.deltaY * 0.01), local);
      return;
    }
    this.view = { ...this.view, tx: this.view.tx - e.deltaX, ty: this.view.ty - e.deltaY };
    this.approximateView();
    if (this.viewSettleTimer !== null) window.clearTimeout(this.viewSettleTimer);
    this.viewSettleTimer = window.setTimeout(() => {
      this.viewSettleTimer = null;
      this.settleRaster();
      this.callbacks.onViewChange({ ...this.view });
    }, 140);
    this.emitViewSettled();
  };

  /* ---------------------------------------------------------------- */
  /* Mutations                                                         */
  /* ---------------------------------------------------------------- */

  private rebuildIndex(): void {
    this.strokeById.clear();
    this.strokeBounds.clear();
    this.inkIndex.clear();
    this.strokeOrder.clear();
    this.nextStrokeOrder = 0;
    for (const stroke of this.strokes) {
      this.strokeById.set(stroke.id, stroke);
      this.strokeOrder.set(stroke.id, this.nextStrokeOrder++);
      this.inkIndex.set(stroke.id, this.boundsFor(stroke));
    }
  }

  /**
   * Applies a model mutation and mirrors it to storage. Mutations are
   * idempotent so undo/redo can replay them safely.
   */
  private applyMutation(
    mutation: Mutation,
    opts: { record?: boolean; inkRegion?: Bounds } = {},
  ): void {
    const record = opts.record !== false;

    if (mutation.removedStrokes?.length) {
      const ids = new Set(mutation.removedStrokes.map((s) => s.id));
      const existing = this.strokes.filter((s) => ids.has(s.id)).map((s) => s.id);
      this.strokes = this.strokes.filter((s) => !ids.has(s.id));
      for (const id of ids) {
        this.strokeById.delete(id);
        this.strokeBounds.delete(id);
        this.strokeOrder.delete(id);
        this.strokePaths.forget(id);
        this.inkIndex.delete(id);
        this.selection.strokeIds.delete(id);
      }
      if (existing.length > 0) this.persistence.deleteStrokes(existing);
    }
    if (mutation.updatedStrokes?.length) {
      const map = new Map(mutation.updatedStrokes.map((u) => [u.after.id, u.after]));
      this.strokes = this.strokes.map((s) => map.get(s.id) ?? s);
      for (const update of mutation.updatedStrokes) {
        this.strokeById.set(update.after.id, update.after);
        this.strokeBounds.delete(update.after.id);
        this.strokePaths.forget(update.after.id);
        this.inkIndex.set(update.after.id, this.boundsFor(update.after));
      }
      this.persistence.updateStrokes(mutation.updatedStrokes.map((u) => u.after));
    }
    if (mutation.addedStrokes?.length) {
      const fresh = mutation.addedStrokes.filter((s) => !this.strokeById.has(s.id));
      for (const stroke of fresh) {
        this.strokes.push(stroke);
        this.strokeById.set(stroke.id, stroke);
        this.strokeOrder.set(stroke.id, this.nextStrokeOrder++);
        this.strokeBounds.delete(stroke.id);
        this.inkIndex.set(stroke.id, this.boundsFor(stroke));
      }
      if (fresh.length > 0) this.persistence.addStrokes(fresh);
    }

    if (mutation.removedTexts?.length) {
      const ids = new Set(mutation.removedTexts.map((t) => t.id));
      const existing = this.texts.filter((t) => ids.has(t.id)).map((t) => t.id);
      this.texts = this.texts.filter((t) => !ids.has(t.id));
      for (const id of ids) this.selection.textIds.delete(id);
      if (existing.length > 0) this.persistence.deleteTexts(existing);
    }
    if (mutation.updatedTexts?.length) {
      const ids = new Set(this.texts.map((t) => t.id));
      const updates = mutation.updatedTexts.filter((u) => ids.has(u.after.id));
      const map = new Map(updates.map((u) => [u.after.id, u.after]));
      this.texts = this.texts.map((t) => map.get(t.id) ?? t);
      if (updates.length > 0) this.persistence.updateTexts(updates.map((u) => u.after));
    }
    if (mutation.addedTexts?.length) {
      const existingIds = new Set(this.texts.map((t) => t.id));
      const fresh = mutation.addedTexts.filter((t) => !existingIds.has(t.id));
      this.texts.push(...fresh);
      if (fresh.length > 0) this.persistence.addTexts(fresh);
    }

    if (mutation.removedImages?.length) {
      const ids = new Set(mutation.removedImages.map((i) => i.id));
      const existing = this.images.filter((i) => ids.has(i.id)).map((i) => i.id);
      this.images = this.images.filter((i) => !ids.has(i.id));
      for (const id of ids) this.selection.imageIds.delete(id);
      if (existing.length > 0) this.persistence.deleteImages(existing);
    }
    if (mutation.updatedImages?.length) {
      const ids = new Set(this.images.map((i) => i.id));
      const updates = mutation.updatedImages.filter((u) => ids.has(u.after.id));
      const map = new Map(updates.map((u) => [u.after.id, u.after]));
      this.images = this.images.map((i) => map.get(i.id) ?? i);
      if (updates.length > 0) this.persistence.updateImages(updates.map((u) => u.after));
    }
    if (mutation.addedImages?.length) {
      const existingIds = new Set(this.images.map((i) => i.id));
      const fresh = mutation.addedImages.filter((i) => !existingIds.has(i.id));
      this.images.push(...fresh);
      if (fresh.length > 0) this.persistence.addImages(fresh);
    }

    if (opts.inkRegion) this.invalidateInkRegion(opts.inkRegion);
    else this.invalidateInk();
    this.selectionChanged();

    if (record) this.recordHistory(mutation);
    this.persistence.notifyChange();
  }

  /** Replays a recorded step; used by an undo stack that outlived its canvas. */
  async applyRecordedMutation(mutation: Mutation): Promise<void> {
    this.applyMutation(mutation, { record: false });
  }

  /**
   * Records one reversible step. The entries resolve the page's engine when they
   * run rather than closing over this instance: the editor is unmounted on the
   * way to another page, and the stack outlives it.
   */
  private recordHistory(forward: Mutation): void {
    const pageId = this.page?.id;
    const inverse = invertMutation(forward);
    this.history.push({
      label: forward.label,
      undo: async () => replayMutation(pageId, inverse),
      redo: async () => replayMutation(pageId, forward),
    });
  }

  /** Turns the HUD's frame sampling on or off. Off by default. */
  setPerfHud(enabled: boolean): void {
    this.perfHudOn = enabled;
    frameStats.setEnabled(enabled);
  }

  /**
   * A stroke that has not moved for a moment becomes a straight line between
   * its ends. The pen stays down, so lifting continues a normal stroke.
   */
  private armSnapHold(): void {
    if (!this.holdToSnap || this.snappedStroke) return;
    // One timer per stroke: clearing and re-arming it on every pointermove was
    // two timer calls per pencil event for no gain.
    if (this.snapHoldTimer !== null) return;
    this.snapHoldTimer = window.setTimeout(this.checkSnapHold, SNAP_HOLD_MS);
  }

  private checkSnapHold = (): void => {
    this.snapHoldTimer = null;
    if (this.snappedStroke || this.session.kind !== 'draw') return;
    const idle = performance.now() - this.lastMoveAt;
    if (idle < SNAP_HOLD_MS) {
      this.snapHoldTimer = window.setTimeout(this.checkSnapHold, Math.max(16, SNAP_HOLD_MS - idle));
      return;
    }
    this.snapCurrentStroke();
  };

  private cancelSnapHold(): void {
    if (this.snapHoldTimer !== null) {
      window.clearTimeout(this.snapHoldTimer);
      this.snapHoldTimer = null;
    }
  }

  private snapCurrentStroke(): void {
    this.snapHoldTimer = null;
    if (this.session.kind !== 'draw' || this.snappedStroke) return;
    const stroke = this.session.stroke;
    if (stroke.points.length < 3) return;
    const first = stroke.points[0]!;
    const last = stroke.points[stroke.points.length - 1]!;
    if (Math.hypot(last.x - first.x, last.y - first.y) * this.view.scale < 24) return;
    this.snappedStroke = true;
    stroke.points = [first, last];
    stroke.shape = 'line';
    this.invalidateLive();
    this.callbacks.onGestureNotice?.('Straight line — keep drawing to extend it');
  }

  /** Erases everything the scribble crossed, as one undo step. */
  private eraseAlongScribble(points: StrokePoint[]): void {
    if (points.length < 2) return;
    const radius = Math.max(6, this.toolSettings.eraser.width / 2);
    const before = this.strokes.slice();
    const step = Math.max(2, radius / 2);
    let previous = points[0]!;
    for (const point of points) {
      const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
      const steps = Math.max(1, Math.ceil(distance / step));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        this.eraseAt(
          {
            ...previous,
            x: previous.x + (point.x - previous.x) * t,
            y: previous.y + (point.y - previous.y) * t,
          },
          radius,
        );
      }
      previous = point;
    }
    this.commitErase(before);
  }

  /* Two-finger tap undoes and three-finger tap redoes; holding either walks
     further back or forward. These are the gestures Procreate and Goodnotes
     share, so a hand trained on an iPad already knows them. */

  private trackTap(e: PointerEvent, touchCount: number): void {
    // A sequence whose last pointerup never arrived must not silence every tap
    // that follows it, so a stale one is dropped before starting a new one.
    if (this.tap && (this.tap.repeats > 0 || e.timeStamp - this.tap.at > TAP_MAX_MS)) this.cancelTap();
    if (!this.tap) this.tap = { at: e.timeStamp, max: 0, moved: false, repeats: 0 };
    this.tap.max = Math.max(this.tap.max, touchCount);
    this.tapStart.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touchCount >= 2 && this.tapHold === null && this.tapRepeat === null) {
      this.tapHold = window.setTimeout(() => this.repeatTap(), TAP_HOLD_MS);
    }
  }

  private trackTapMove(e: PointerEvent): void {
    const start = this.tapStart.get(e.pointerId);
    if (!this.tap || !start) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > TAP_SLOP) this.markTapMoved();
  }

  private markTapMoved(): void {
    if (this.tap) this.tap.moved = true;
    this.stopTapTimers();
  }

  private endTap(e: PointerEvent): void {
    this.tapStart.delete(e.pointerId);
    const tap = this.tap;
    if (!tap || this.countTouches() > 0) return;
    this.tap = null;
    this.stopTapTimers();
    if (tap.moved || tap.repeats > 0) return;
    if (e.timeStamp - tap.at > TAP_MAX_MS) return;
    if (tap.max === 2) void this.undo();
    else if (tap.max >= 3) void this.redo();
  }

  private repeatTap(): void {
    this.tapHold = null;
    const tap = this.tap;
    if (!tap || tap.moved || this.countTouches() < 2) return;
    const step = (): void => {
      tap.repeats += 1;
      if (tap.max === 2) void this.undo();
      else void this.redo();
    };
    step();
    this.tapRepeat = window.setInterval(step, TAP_REPEAT_MS);
  }

  private stopTapTimers(): void {
    if (this.tapHold !== null) {
      window.clearTimeout(this.tapHold);
      this.tapHold = null;
    }
    if (this.tapRepeat !== null) {
      window.clearInterval(this.tapRepeat);
      this.tapRepeat = null;
    }
  }

  private cancelTap(): void {
    this.tap = null;
    this.tapStart.clear();
    this.stopTapTimers();
  }

  private commitStrokes(strokes: Stroke[], label: string): void {
    if (strokes.length === 0) return;
    this.applyMutation({ label, addedStrokes: strokes });
  }

  /* ---------------------------------------------------------------- */
  /* Eraser                                                            */
  /* ---------------------------------------------------------------- */

  private eraseSegment(from: StrokePoint, to: StrokePoint, radius: number): Bounds | null {
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.ceil(distance / Math.max(2, radius / 2)));
    let dirty: Bounds | null = null;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const box = this.eraseAt(
        {
          x: from.x + (to.x - from.x) * t,
          y: from.y + (to.y - from.y) * t,
          pressure: 0.5,
          tiltX: 0,
          tiltY: 0,
          timestamp: to.timestamp,
        },
        radius,
      );
      if (!box) continue;
      dirty = dirty
        ? {
            minX: Math.min(dirty.minX, box.minX),
            minY: Math.min(dirty.minY, box.minY),
            maxX: Math.max(dirty.maxX, box.maxX),
            maxY: Math.max(dirty.maxY, box.maxY),
          }
        : box;
    }
    return dirty;
  }

  /** Erases at one contact point; the drag is recorded as a single undo step. */
  private eraseAt(
    point: StrokePoint,
    radius: number,
    opts: { split?: boolean } = {},
  ): Bounds | null {
    const removed: Stroke[] = [];
    const added: Stroke[] = [];
    const mode = opts.split === false ? 'stroke' : this.toolSettings.eraser.mode;
    // Only the strokes whose bounds share a cell with the contact are tested:
    // the cost of one erase follows the ink near the finger, not the page.
    const area = {
      minX: point.x - radius,
      minY: point.y - radius,
      maxX: point.x + radius,
      maxY: point.y + radius,
    };
    let dirty: Bounds | null = null;
    for (const id of this.inkIndex.query(area)) {
      const stroke = this.strokeById.get(id);
      if (!stroke) continue;
      const reach = radius + stroke.width / 2;
      const bounds = this.boundsFor(stroke);
      if (
        point.x < bounds.minX - reach ||
        point.x > bounds.maxX + reach ||
        point.y < bounds.minY - reach ||
        point.y > bounds.maxY + reach
      ) {
        continue;
      }
      if (polylineDistance(stroke.points, point.x, point.y) > reach) continue;
      dirty = dirty
        ? {
            minX: Math.min(dirty.minX, bounds.minX),
            minY: Math.min(dirty.minY, bounds.minY),
            maxX: Math.max(dirty.maxX, bounds.maxX),
            maxY: Math.max(dirty.maxY, bounds.maxY),
          }
        : { ...bounds };
      if (mode === 'stroke' || stroke.shape || stroke.points.length < 3) {
        removed.push(stroke);
        continue;
      }
      const segments = splitStrokeAround(stroke, point, reach);
      removed.push(stroke);
      added.push(...segments);
    }
    if (removed.length === 0) return null;
    this.applyMutation(
      { label: 'Erase', removedStrokes: removed, addedStrokes: added },
      { record: false, inkRegion: dirty ?? undefined },
    );
    return dirty;
  }

  /** Erases along a document-space segment; used by the two-finger rub. */
  private eraseSegmentDoc(from: { x: number; y: number }, to: { x: number; y: number }, radius: number): Bounds | null {
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.min(12, Math.max(1, Math.ceil(distance / Math.max(2, radius / 2))));
    let dirty: Bounds | null = null;
    const stamp = performance.now();
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const box = this.eraseAt(
        {
          x: from.x + (to.x - from.x) * t,
          y: from.y + (to.y - from.y) * t,
          pressure: 0.5,
          tiltX: 0,
          tiltY: 0,
          timestamp: stamp,
        },
        radius,
        { split: false },
      );
      if (!box) continue;
      dirty = dirty
        ? {
            minX: Math.min(dirty.minX, box.minX),
            minY: Math.min(dirty.minY, box.minY),
            maxX: Math.max(dirty.maxX, box.maxX),
            maxY: Math.max(dirty.maxY, box.maxY),
          }
        : box;
    }
    return dirty;
  }

  /**
   * Rubs the ink under both fingers, from where each one was last seen. Each
   * finger erases only what it personally crossed, so nothing between the two
   * hands disappears.
   */
  private rubAt(a: { id: number; x: number; y: number }, b: { id: number; x: number; y: number }): void {
    if (this.session.kind !== 'pinch') return;
    const s = this.session;
    const radius = Math.max(1, SCRUB_RADIUS_PX / this.view.scale);
    let dirty: Bounds | null = null;
    for (const touch of [a, b]) {
      const previous = s.scrubLast.get(touch.id) ?? { x: touch.x, y: touch.y };
      const from = this.toDoc(previous.x, previous.y);
      const to = this.toDoc(touch.x, touch.y);
      if (Math.hypot(to.x - from.x, to.y - from.y) > 0.01) {
        const box = this.eraseSegmentDoc(from, to, radius);
        if (box) {
          dirty = dirty
            ? {
                minX: Math.min(dirty.minX, box.minX),
                minY: Math.min(dirty.minY, box.minY),
                maxX: Math.max(dirty.maxX, box.maxX),
                maxY: Math.max(dirty.maxY, box.maxY),
              }
            : box;
        }
      }
      s.scrubLast.set(touch.id, { x: touch.x, y: touch.y });
    }
    if (!dirty) return;
    s.scrubHit = true;
    if (!s.scrubDirty) s.scrubDirty = dirty;
    else {
      s.scrubDirty = {
        minX: Math.min(s.scrubDirty.minX, dirty.minX),
        minY: Math.min(s.scrubDirty.minY, dirty.minY),
        maxX: Math.max(s.scrubDirty.maxX, dirty.maxX),
        maxY: Math.max(s.scrubDirty.maxY, dirty.maxY),
      };
    }
    this.invalidateLive();
  }

  /** Pushes one undo entry for the whole eraser drag. */
  private commitErase(before: Stroke[], region?: Bounds | null): boolean {
    const afterIds = new Set(this.strokes.map((s) => s.id));
    const beforeIds = new Set(before.map((s) => s.id));
    const removed = before.filter((s) => !afterIds.has(s.id));
    const added = this.strokes.filter((s) => !beforeIds.has(s.id));
    if (removed.length === 0 && added.length === 0) {
      if (region) this.invalidateInkRegion(region);
      else this.invalidateInk();
      return false;
    }
    this.recordHistory({ label: 'Erase', addedStrokes: removed, removedStrokes: added });
    if (region) this.invalidateInkRegion(region);
    else this.invalidateInk();
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Selection                                                         */
  /* ---------------------------------------------------------------- */

  private hasSelection(): boolean {
    return this.selection.strokeIds.size + this.selection.textIds.size + this.selection.imageIds.size > 0;
  }

  private selectionBounds(): Bounds | null {
    if (!this.hasSelection()) return null;
    const points: { x: number; y: number }[] = [];
    for (const id of this.selection.strokeIds) {
      const stroke = this.strokeById.get(id);
      if (stroke) points.push(...stroke.points);
    }
    for (const id of this.selection.textIds) {
      const text = this.texts.find((t) => t.id === id);
      if (text) {
        points.push(
          { x: text.x, y: text.y },
          { x: text.x + text.width, y: text.y + text.fontSize * 1.4 },
        );
      }
    }
    for (const id of this.selection.imageIds) {
      const image = this.images.find((i) => i.id === id);
      if (image) {
        points.push({ x: image.x, y: image.y }, { x: image.x + image.width, y: image.y + image.height });
      }
    }
    if (points.length === 0) return null;
    return boundsOfPoints(points, 6);
  }

  private selectionChanged(): void {
    this.callbacks.onSelectionChange({
      count: this.selection.strokeIds.size + this.selection.textIds.size + this.selection.imageIds.size,
      bounds: this.selectionBounds(),
    });
    this.invalidateLive();
  }

  private selectInsidePolygon(polygon: { x: number; y: number }[]): void {
    const selection: Selection = { strokeIds: new Set(), textIds: new Set(), imageIds: new Set() };
    for (const stroke of this.strokes) {
      if (stroke.points.some((p) => pointInPolygon(p.x, p.y, polygon))) selection.strokeIds.add(stroke.id);
    }
    for (const text of this.texts) {
      if (pointInPolygon(text.x + text.width / 2, text.y + text.fontSize * 0.7, polygon)) {
        selection.textIds.add(text.id);
      }
    }
    for (const image of this.images) {
      if (pointInPolygon(image.x + image.width / 2, image.y + image.height / 2, polygon)) {
        selection.imageIds.add(image.id);
      }
    }
    this.selection = selection;
    this.selectionChanged();
    if (selection.textIds.size === 1 && selection.strokeIds.size === 0 && selection.imageIds.size === 0) {
      const id = [...selection.textIds][0]!;
      const draft = this.textDraftFor(id);
      if (draft) this.callbacks.requestTextEdit(draft);
    }
  }

  private selectionContains(point: { x: number; y: number }): boolean {
    const bounds = this.selectionBounds();
    if (!bounds) return false;
    return point.x >= bounds.minX && point.x <= bounds.maxX && point.y >= bounds.minY && point.y <= bounds.maxY;
  }

  private hitResizeHandle(local: { x: number; y: number }): boolean {
    const bounds = this.selectionBounds();
    if (!bounds) return false;
    const handle = this.toScreen(bounds.maxX, bounds.maxY);
    return Math.hypot(local.x - handle.x, local.y - handle.y) <= HANDLE_SCREEN_SIZE;
  }

  private beginMove(point: StrokePoint): void {
    this.session = {
      kind: 'move',
      start: { x: point.x, y: point.y },
      last: { x: point.x, y: point.y },
      strokes: this.strokes
        .filter((s) => this.selection.strokeIds.has(s.id))
        .map((s) => ({ ...s, points: s.points.map((p) => ({ ...p })) })),
      texts: this.texts.filter((t) => this.selection.textIds.has(t.id)).map((t) => ({ ...t })),
      images: this.images.filter((i) => this.selection.imageIds.has(i.id)).map((i) => ({ ...i })),
    };
  }

  private beginResize(point: StrokePoint): void {
    const bounds = this.selectionBounds();
    if (!bounds) return;
    this.resizeStartX = point.x;
    this.resizeStartY = point.y;
    this.session = {
      kind: 'resize',
      origin: { x: bounds.minX, y: bounds.minY },
      last: { x: point.x, y: point.y },
      strokes: this.strokes
        .filter((s) => this.selection.strokeIds.has(s.id))
        .map((s) => ({ ...s, points: s.points.map((p) => ({ ...p })) })),
      texts: this.texts.filter((t) => this.selection.textIds.has(t.id)).map((t) => ({ ...t })),
      images: this.images.filter((i) => this.selection.imageIds.has(i.id)).map((i) => ({ ...i })),
    };
  }

  private translateSelection(dx: number, dy: number): void {
    if (this.session.kind !== 'move') return;
    const { strokes, texts, images } = this.session;
    const strokeIds = new Set(strokes.map((s) => s.id));
    const textIds = new Set(texts.map((t) => t.id));
    const imageIds = new Set(images.map((i) => i.id));
    this.strokes = this.strokes.map((stroke) => {
      if (!strokeIds.has(stroke.id)) return stroke;
      const updated: Stroke = {
        ...stroke,
        points: stroke.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })),
      };
      this.strokeById.set(updated.id, updated);
      this.strokeBounds.delete(updated.id);
      // The spatial grid follows the ink: a selection dragged across the page has
      // to be found where it is now, by the repaint as much as by the eraser.
      this.inkIndex.set(updated.id, this.boundsFor(updated));
      return updated;
    });
    this.texts = this.texts.map((text) =>
      textIds.has(text.id) ? { ...text, x: text.x + dx, y: text.y + dy } : text,
    );
    this.images = this.images.map((image) =>
      imageIds.has(image.id) ? { ...image, x: image.x + dx, y: image.y + dy } : image,
    );
  }

  private scaleSelection(origin: { x: number; y: number }, factor: number): void {
    if (this.session.kind !== 'resize') return;
    const session = this.session;
    const clamp = Math.max(0.1, Math.min(10, factor));
    const base = (x: number, y: number) => ({
      x: origin.x + (x - origin.x) * clamp,
      y: origin.y + (y - origin.y) * clamp,
    });

    const strokeBase = new Map(session.strokes.map((s) => [s.id, s]));
    this.strokes = this.strokes.map((stroke) => {
      const source = strokeBase.get(stroke.id);
      if (!source) return stroke;
      const updated: Stroke = {
        ...stroke,
        width: Math.max(0.4, source.width * clamp),
        points: source.points.map((p) => {
          const scaled = base(p.x, p.y);
          return { ...p, x: scaled.x, y: scaled.y };
        }),
      };
      this.strokeById.set(updated.id, updated);
      this.strokeBounds.delete(updated.id);
      this.inkIndex.set(updated.id, this.boundsFor(updated));
      return updated;
    });
    const textBase = new Map(session.texts.map((t) => [t.id, t]));
    this.texts = this.texts.map((text) => {
      const source = textBase.get(text.id);
      if (!source) return text;
      const scaled = base(source.x, source.y);
      return {
        ...text,
        x: scaled.x,
        y: scaled.y,
        width: Math.max(40, source.width * clamp),
        fontSize: Math.max(6, source.fontSize * clamp),
      };
    });
    const imageBase = new Map(session.images.map((i) => [i.id, i]));
    this.images = this.images.map((image) => {
      const source = imageBase.get(image.id);
      if (!source) return image;
      const scaled = base(source.x, source.y);
      return {
        ...image,
        x: scaled.x,
        y: scaled.y,
        width: Math.max(8, source.width * clamp),
        height: Math.max(8, source.height * clamp),
      };
    });
  }

  private commitTransform(
    session: Extract<Session, { kind: 'move' } | { kind: 'resize' }>,
    label: string,
  ): void {
    const updatedStrokes: { before: Stroke; after: Stroke }[] = [];
    for (const before of session.strokes) {
      const after = this.strokeById.get(before.id);
      if (after && !sameStroke(before, after)) updatedStrokes.push({ before, after });
    }
    const updatedTexts: { before: TextBlock; after: TextBlock }[] = [];
    for (const before of session.texts) {
      const after = this.texts.find((t) => t.id === before.id);
      if (after && !sameText(before, after)) updatedTexts.push({ before, after });
    }
    const updatedImages: { before: ImagePlacement; after: ImagePlacement }[] = [];
    for (const before of session.images) {
      const after = this.images.find((i) => i.id === before.id);
      if (after && !sameImage(before, after)) updatedImages.push({ before, after });
    }
    if (updatedStrokes.length + updatedTexts.length + updatedImages.length === 0) {
      this.invalidateInk();
      return;
    }
    this.applyMutation({ label, updatedStrokes, updatedTexts, updatedImages });
  }

  clearSelection(): void {
    if (!this.hasSelection()) return;
    this.selection = { strokeIds: new Set(), textIds: new Set(), imageIds: new Set() };
    this.selectionChanged();
  }

  selectAll(): void {
    this.selection = {
      strokeIds: new Set(this.strokes.map((s) => s.id)),
      textIds: new Set(this.texts.map((t) => t.id)),
      imageIds: new Set(this.images.map((i) => i.id)),
    };
    this.selectionChanged();
  }

  selectionCount(): number {
    return this.selection.strokeIds.size + this.selection.textIds.size + this.selection.imageIds.size;
  }

  deleteSelection(): void {
    if (!this.hasSelection()) return;
    const removedStrokes = this.strokes.filter((s) => this.selection.strokeIds.has(s.id));
    const removedTexts = this.texts.filter((t) => this.selection.textIds.has(t.id));
    const removedImages = this.images.filter((i) => this.selection.imageIds.has(i.id));
    this.applyMutation({ label: 'Delete selection', removedStrokes, removedTexts, removedImages });
    this.clearSelection();
  }

  copySelection(): boolean {
    if (!this.hasSelection()) return false;
    this.clipboard = {
      strokes: this.strokes
        .filter((s) => this.selection.strokeIds.has(s.id))
        .map((s) => ({ ...s, points: s.points.map((p) => ({ ...p })) })),
      texts: this.texts.filter((t) => this.selection.textIds.has(t.id)).map((t) => ({ ...t })),
      images: this.images.filter((i) => this.selection.imageIds.has(i.id)).map((i) => ({ ...i })),
    };
    return true;
  }

  paste(): boolean {
    if (!this.clipboard || !this.page) return false;
    const offset = 18;
    const t = now();
    const pageId = this.page.id;
    const strokes = this.clipboard.strokes.map((s) => ({
      ...s,
      id: newId(),
      pageId,
      points: s.points.map((p) => ({ ...p, x: p.x + offset, y: p.y + offset })),
      createdAt: t,
      updatedAt: t,
      version: 1,
      deletedAt: null,
    }));
    const texts = this.clipboard.texts.map((x) => ({
      ...x,
      id: newId(),
      pageId,
      x: x.x + offset,
      y: x.y + offset,
      createdAt: t,
      updatedAt: t,
      version: 1,
      deletedAt: null,
    }));
    const images = this.clipboard.images.map((i) => ({
      ...i,
      id: newId(),
      pageId,
      x: i.x + offset,
      y: i.y + offset,
      createdAt: t,
      updatedAt: t,
      version: 1,
      deletedAt: null,
    }));
    this.applyMutation({ label: 'Paste', addedStrokes: strokes, addedTexts: texts, addedImages: images });
    this.selection = {
      strokeIds: new Set(strokes.map((s) => s.id)),
      textIds: new Set(texts.map((x) => x.id)),
      imageIds: new Set(images.map((i) => i.id)),
    };
    this.selectionChanged();
    return true;
  }

  hasClipboard(): boolean {
    return this.clipboard !== null;
  }

  /* ---------------------------------------------------------------- */
  /* Text and images                                                   */
  /* ---------------------------------------------------------------- */

  commitText(draft: TextDraft): void {
    if (!this.page) return;
    const t = now();
    if (draft.text.trim().length === 0) {
      if (draft.id) {
        const existing = this.texts.find((x) => x.id === draft.id);
        if (existing) this.applyMutation({ label: 'Delete text', removedTexts: [existing] });
      }
      return;
    }
    if (draft.id) {
      const before = this.texts.find((x) => x.id === draft.id);
      if (!before) return;
      const after: TextBlock = {
        ...before,
        text: draft.text,
        fontSize: draft.fontSize,
        color: draft.color,
        width: draft.width,
        align: draft.align,
        updatedAt: t,
        version: before.version + 1,
      };
      this.applyMutation({ label: 'Edit text', updatedTexts: [{ before, after }] });
    } else {
      this.applyMutation({
        label: 'Add text',
        addedTexts: [
          {
            id: newId(),
            pageId: this.page.id,
            x: draft.x,
            y: draft.y,
            width: draft.width,
            text: draft.text,
            fontSize: draft.fontSize,
            color: draft.color,
            align: draft.align,
            createdAt: t,
            updatedAt: t,
            version: 1,
            deviceId: '',
            deletedAt: null,
          },
        ],
      });
    }
  }

  textDraftFor(id: string): TextDraft | null {
    const text = this.texts.find((t) => t.id === id);
    if (!text) return null;
    return {
      id: text.id,
      x: text.x,
      y: text.y,
      width: text.width,
      text: text.text,
      fontSize: text.fontSize,
      color: text.color,
      align: text.align,
    };
  }

  addImage(assetId: string, image: CanvasImageSource, naturalWidth: number, naturalHeight: number): void {
    if (!this.page) return;
    this.setImageBitmap(assetId, image);
    const size = this.pageSize();
    const ratio = Math.min(
      (size.width * 0.6) / naturalWidth,
      (size.height * 0.6) / naturalHeight,
      1,
    );
    const w = naturalWidth * ratio;
    const h = naturalHeight * ratio;
    const center = this.toDoc(this.cssWidth / 2, this.cssHeight / 2);
    const t = now();
    const placement: ImagePlacement = {
      id: newId(),
      pageId: this.page.id,
      assetId,
      x: center.x - w / 2,
      y: center.y - h / 2,
      width: w,
      height: h,
      createdAt: t,
      updatedAt: t,
      version: 1,
      deviceId: '',
      deletedAt: null,
    };
    this.applyMutation({ label: 'Insert image', addedImages: [placement] });
    this.selection = { strokeIds: new Set(), textIds: new Set(), imageIds: new Set([placement.id]) };
    this.selectionChanged();
  }

  /* ---------------------------------------------------------------- */
  /* Host commands                                                     */
  /* ---------------------------------------------------------------- */

  setTool(tool: DrawToolId): void {
    this.tool = tool;
    this.clearSelection();
    this.invalidateLive();
  }

  setToolSettings(settings: ToolSettings): void {
    this.toolSettings = settings;
  }

  setShowBoundary(value: boolean): void {
    this.showBoundary = value;
    this.pendingPaper = true;
    this.pendingInk = true;
    this.schedule();
  }

  setRecognition(value: boolean): void {
    this.recognizeShapes = value;
  }

  setSnapping(enabled: boolean, gridSize: number): void {
    this.snapEnabled = enabled;
    this.snapSize = gridSize;
  }

  /** Replaces a wobbly freehand stroke with the proposal the user accepted. */
  applyShapeSuggestion(suggestion: ShapeSuggestion): void {
    const before = this.strokes.find((stroke) => stroke.id === suggestion.strokeId);
    if (!before) return;
    const after: Stroke = {
      ...before,
      shape: suggestion.kind,
      points: [suggestion.start, suggestion.end],
      updatedAt: now(),
      version: before.version + 1,
    };
    this.applyMutation({
      label: 'Straighten stroke',
      updatedStrokes: [{ before, after }],
    });
    this.invalidateInk();
  }

  private snapShapePoint(point: StrokePoint, start?: StrokePoint): StrokePoint {
    if (!this.snapEnabled) return point;
    const grid = snapToGrid(point.x, point.y, this.snapSize);
    const snapped: StrokePoint = { ...point, x: grid.x, y: grid.y };
    if (start && (this.tool === 'line' || this.tool === 'arrow')) {
      const angled = snapAngle(start, snapped, 15);
      snapped.x = angled.x;
      snapped.y = angled.y;
    }
    return snapped;
  }

  async undo(): Promise<void> {
    this.clearSelection();
    await this.history.undo();
  }

  async redo(): Promise<void> {
    this.clearSelection();
    await this.history.redo();
  }

  private makeShapeStroke(start: StrokePoint, end: StrokePoint): Stroke {
    const settings =
      this.toolSettings[this.tool as ShapeToolId] ?? this.toolSettings.line;
    return {
      id: 'preview',
      pageId: this.page?.id ?? '',
      tool: this.tool,
      color: settings.color,
      width: settings.width,
      opacity: settings.opacity,
      points: [start, end],
      shape: this.tool as ShapeKind,
      createdAt: 0,
      updatedAt: 0,
      version: 1,
      deviceId: '',
      deletedAt: null,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function replayMutation(pageId: string | undefined, mutation: Mutation): void {
  if (!pageId) return;
  const engine = enginesByPage.get(pageId);
  if (!engine) return;
  void engine.applyRecordedMutation(mutation);
}

function invertMutation(m: Mutation): Mutation {
  return {
    label: `Undo ${m.label.toLowerCase()}`,
    addedStrokes: m.removedStrokes,
    removedStrokes: m.addedStrokes,
    updatedStrokes: m.updatedStrokes?.map((u) => ({ before: u.after, after: u.before })),
    addedTexts: m.removedTexts,
    removedTexts: m.addedTexts,
    updatedTexts: m.updatedTexts?.map((u) => ({ before: u.after, after: u.before })),
    addedImages: m.removedImages,
    removedImages: m.addedImages,
    updatedImages: m.updatedImages?.map((u) => ({ before: u.after, after: u.before })),
  };
}

function sameStroke(a: Stroke, b: Stroke): boolean {
  if (a.width !== b.width || a.points.length !== b.points.length) return false;
  for (let i = 0; i < a.points.length; i++) {
    const p = a.points[i]!;
    const q = b.points[i]!;
    if (p.x !== q.x || p.y !== q.y) return false;
  }
  return true;
}

function sameText(a: TextBlock, b: TextBlock): boolean {
  return a.x === b.x && a.y === b.y && a.text === b.text && a.width === b.width && a.fontSize === b.fontSize;
}

function sameImage(a: ImagePlacement, b: ImagePlacement): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}


/** Splits a stroke around an eraser contact, preserving the surviving runs. */
export function splitStrokeAround(
  stroke: Stroke,
  point: { x: number; y: number },
  reach: number,
): Stroke[] {
  const runs: StrokePoint[][] = [];
  let current: StrokePoint[] = [];
  for (const p of stroke.points) {
    if (Math.hypot(p.x - point.x, p.y - point.y) <= reach) {
      if (current.length >= 2) runs.push(current);
      current = [];
    } else {
      current.push(p);
    }
  }
  if (current.length >= 2) runs.push(current);
  return runs.map((points, index) => ({
    ...stroke,
    id: newId(),
    points,
    createdAt: stroke.createdAt + index,
    updatedAt: now(),
    version: 1,
    deletedAt: null,
  }));
}
