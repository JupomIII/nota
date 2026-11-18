import 'fake-indexeddb/auto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../storage/db';
import { PageWriteBuffer } from '../storage/pageStore';
import { applyRemoteRecord, loadPageContent } from '../storage/repo';
import type { Stroke } from '../storage/types';
import type { PageContent } from '../drawing/engine';
import { PageRefresher } from './liveRefresh';

const PAGE_ID = 'page-1';

function stroke(id: string, overrides: Partial<Stroke> = {}): Stroke {
  return {
    id,
    pageId: PAGE_ID,
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

function record(entity: Stroke, version: number, updatedAt: number) {
  return {
    kind: 'stroke' as const,
    id: entity.id,
    data: entity,
    createdAt: entity.createdAt,
    updatedAt,
    version,
    deviceId: 'laptop',
    deletedAt: null,
  };
}

beforeAll(() => {
  (globalThis as unknown as { window?: unknown }).window = { setTimeout, clearTimeout };
});

beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()));
});

afterAll(() => {
  void db.close();
});

describe('the page that is open when a sync lands', () => {
  it('writes local ink first, so the reload carries both copies', async () => {
    await db.strokes.put(stroke('from-laptop', { createdAt: 1 }));
    const buffer = new PageWriteBuffer(() => undefined);
    buffer.addStrokes([stroke('just-drawn', { createdAt: 5 })]);
    const applied: PageContent[] = [];
    const refresher = new PageRefresher(0);

    const reloaded = await refresher.apply(1, {
      pageId: PAGE_ID,
      flush: () => buffer.flush(),
      load: loadPageContent,
      apply: (content) => applied.push(content),
    });

    expect(reloaded).toBe(true);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.strokes.map((row) => row.id).sort()).toEqual(['from-laptop', 'just-drawn']);
    // The queued stroke reached storage instead of being replaced by the pull.
    expect(await db.strokes.get('just-drawn')).toBeTruthy();
    expect(await db.outbox.count()).toBe(1);
  });

  it('reloads each revision exactly once', async () => {
    let loads = 0;
    const refresher = new PageRefresher(0);
    const page = {
      pageId: PAGE_ID,
      flush: async () => undefined,
      load: async () => {
        loads += 1;
        return loadPageContent(PAGE_ID);
      },
      apply: () => undefined,
    };

    expect(await refresher.apply(1, page)).toBe(true);
    expect(await refresher.apply(1, page)).toBe(false);
    expect(loads).toBe(1);

    expect(await refresher.apply(2, page)).toBe(true);
    expect(loads).toBe(2);
  });

  it('applies a revision that arrives during a reload, and never loses it', async () => {
    const applied: number[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const refresher = new PageRefresher(0);
    const page = (marker: number) => ({
      pageId: PAGE_ID,
      flush: async () => {
        if (marker === 1) await gate;
      },
      load: async () => loadPageContent(PAGE_ID),
      apply: () => applied.push(marker),
    });

    const first = refresher.apply(1, page(1));
    const second = refresher.apply(2, page(2));
    release();
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(applied).toEqual([1, 2]);
  });

  it('does not swap one page into another when the reader turns it', async () => {
    let current = true;
    const refresher = new PageRefresher(0);

    const reloaded = await refresher.apply(1, {
      pageId: PAGE_ID,
      flush: async () => {
        current = false;
      },
      load: loadPageContent,
      apply: () => {
        throw new Error('content must not be applied to another page');
      },
      isCurrent: () => current,
    });

    expect(reloaded).toBe(false);
  });

  it('does not write a queued edit over the copy the sync just resolved', async () => {
    const stale = stroke('s1', { version: 3, updatedAt: 1_000 });
    const resolved = stroke('s1', {
      version: 5,
      updatedAt: 2_000,
      color: '#ff0000',
      points: [{ x: 40, y: 40, pressure: 0.9, tiltX: 0, tiltY: 0, timestamp: 2 }],
    });
    await db.strokes.put(stale);
    // What the conflict path does: the laptop's copy is written, and the edit
    // that was still in the page buffer describes the copy it replaced.
    await applyRemoteRecord(record(resolved, 5, 2_000));
    const buffer = new PageWriteBuffer(() => undefined);
    buffer.updateStrokes([stale]);
    const applied: PageContent[] = [];

    const refresher = new PageRefresher(0);
    await refresher.apply(1, {
      pageId: PAGE_ID,
      flush: () => buffer.flush(),
      load: loadPageContent,
      apply: (content) => applied.push(content),
    });

    const stored = await db.strokes.get('s1');
    expect(stored?.version).toBe(5);
    expect(stored?.color).toBe('#ff0000');
    expect(applied[0]?.strokes[0]?.version).toBe(5);
    // Nothing was queued back to the laptop from the stale edit.
    expect(await db.outbox.count()).toBe(0);
  });

  it('still writes a normal edit when no sync touched that record', async () => {
    await db.strokes.put(stroke('s1', { version: 1 }));
    const buffer = new PageWriteBuffer(() => undefined);
    buffer.updateStrokes([stroke('s1', { version: 1, color: '#00ff00' })]);

    await buffer.flush();

    const stored = await db.strokes.get('s1');
    expect(stored?.color).toBe('#00ff00');
    expect(stored?.version).toBe(2);
  });
});
