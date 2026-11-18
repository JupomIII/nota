import type { ImagePlacement, Stroke, TextBlock } from '../storage/types';

/** The three lists a page's ink and objects live in. */
export interface PageModel {
  strokes: Stroke[];
  texts: TextBlock[];
  images: ImagePlacement[];
}

export interface ModelSelection {
  strokeIds: Set<string>;
  textIds: Set<string>;
  imageIds: Set<string>;
}

export interface RemoteMerge {
  model: PageModel;
  selection: ModelSelection;
  /** True when the selection pointed at something the laptop replaced away. */
  selectionTrimmed: boolean;
  /** True when the stroke under the pen was kept in front of the pull. */
  keptActiveStroke: boolean;
}

/**
 * What a page becomes once a pull has landed.
 *
 * The stored copy wins for everything the laptop sent, with one exception: the
 * stroke still under the pen, because reloading mid-word must not make the line
 * jump. Nothing here reads or writes the view, the zoom or the undo stack — that
 * is exactly what makes a pull invisible in the editor.
 */
export function mergeRemoteContent(
  incoming: PageModel,
  activeStroke: Stroke | null,
  selection: ModelSelection,
): RemoteMerge {
  const strokes = [...incoming.strokes];
  let keptActiveStroke = false;
  if (activeStroke && !strokes.some((stroke) => stroke.id === activeStroke.id)) {
    strokes.push(activeStroke);
    keptActiveStroke = true;
  }
  const textIds = new Set(incoming.texts.map((text) => text.id));
  const imageIds = new Set(incoming.images.map((image) => image.id));
  const strokeIds = new Set(strokes.map((stroke) => stroke.id));
  const next: ModelSelection = {
    strokeIds: new Set([...selection.strokeIds].filter((id) => strokeIds.has(id))),
    textIds: new Set([...selection.textIds].filter((id) => textIds.has(id))),
    imageIds: new Set([...selection.imageIds].filter((id) => imageIds.has(id))),
  };
  const selectionTrimmed =
    next.strokeIds.size !== selection.strokeIds.size ||
    next.textIds.size !== selection.textIds.size ||
    next.imageIds.size !== selection.imageIds.size;
  return {
    model: { strokes, texts: [...incoming.texts], images: [...incoming.images] },
    selection: next,
    selectionTrimmed,
    keptActiveStroke,
  };
}
