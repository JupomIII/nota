import { describe, expect, it } from 'vitest';
import type { ImagePlacement, Stroke, TextBlock } from '../storage/types';
import { mergeRemoteContent } from './remoteContent';

function stroke(id: string, overrides: Partial<Stroke> = {}): Stroke {
  return {
    id,
    pageId: 'page-1',
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    deviceId: 'ipad',
    deletedAt: null,
    tool: 'fountain',
    color: '#111111',
    width: 2,
    opacity: 1,
    points: [{ x: 0, y: 0, pressure: 0.5, tiltX: 0, tiltY: 0, timestamp: 1 }],
    shape: null,
    ...overrides,
  };
}

function text(id: string): TextBlock {
  return {
    id,
    pageId: 'page-1',
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    deviceId: 'ipad',
    deletedAt: null,
    x: 0,
    y: 0,
    width: 200,
    text: 'hi',
    fontSize: 16,
    color: '#111111',
    align: 'left',
  };
}

function image(id: string): ImagePlacement {
  return {
    id,
    pageId: 'page-1',
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    deviceId: 'ipad',
    deletedAt: null,
    assetId: 'asset-1',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
  } as ImagePlacement;
}

const emptySelection = () => ({
  strokeIds: new Set<string>(),
  textIds: new Set<string>(),
  imageIds: new Set<string>(),
});

describe('what a pull does to the page under the pen', () => {
  it('takes the stored copy as the truth for everything the laptop sent', () => {
    const merged = mergeRemoteContent(
      { strokes: [stroke('a', { version: 4 }), stroke('b')], texts: [text('t1')], images: [image('i1')] },
      null,
      emptySelection(),
    );
    expect(merged.model.strokes.map((row) => row.id)).toEqual(['a', 'b']);
    expect(merged.model.strokes[0]?.version).toBe(4);
    expect(merged.model.texts.map((row) => row.id)).toEqual(['t1']);
    expect(merged.model.images.map((row) => row.id)).toEqual(['i1']);
    expect(merged.keptActiveStroke).toBe(false);
  });

  it('drops ink the laptop deleted instead of keeping a local ghost', () => {
    const merged = mergeRemoteContent({ strokes: [], texts: [], images: [] }, null, emptySelection());
    expect(merged.model.strokes).toHaveLength(0);
  });

  it('keeps the stroke still under the pen, which no pull has seen yet', () => {
    const merged = mergeRemoteContent(
      { strokes: [stroke('pulled')], texts: [], images: [] },
      stroke('wet'),
      emptySelection(),
    );
    expect(merged.model.strokes.map((row) => row.id)).toEqual(['pulled', 'wet']);
    expect(merged.keptActiveStroke).toBe(true);
  });

  it('does not draw the wet stroke twice when the pull already carries it', () => {
    const merged = mergeRemoteContent(
      { strokes: [stroke('wet')], texts: [], images: [] },
      stroke('wet'),
      emptySelection(),
    );
    expect(merged.model.strokes).toHaveLength(1);
    expect(merged.keptActiveStroke).toBe(false);
  });

  it('keeps a selection whose objects are still there', () => {
    const merged = mergeRemoteContent(
      { strokes: [stroke('a')], texts: [text('t1')], images: [] },
      null,
      { strokeIds: new Set(['a']), textIds: new Set(['t1']), imageIds: new Set() },
    );
    expect([...merged.selection.strokeIds]).toEqual(['a']);
    expect(merged.selectionTrimmed).toBe(false);
  });

  it('drops the part of a selection the laptop replaced away, and says so', () => {
    const merged = mergeRemoteContent(
      { strokes: [stroke('a')], texts: [], images: [image('i1')] },
      null,
      { strokeIds: new Set(['a', 'gone']), textIds: new Set(['t-gone']), imageIds: new Set(['i1']) },
    );
    expect([...merged.selection.strokeIds]).toEqual(['a']);
    expect(merged.selection.textIds.size).toBe(0);
    expect([...merged.selection.imageIds]).toEqual(['i1']);
    expect(merged.selectionTrimmed).toBe(true);
  });

  it('reports nothing as trimmed when the selection was empty', () => {
    const merged = mergeRemoteContent({ strokes: [stroke('a')], texts: [], images: [] }, null, emptySelection());
    expect(merged.selectionTrimmed).toBe(false);
  });
});
