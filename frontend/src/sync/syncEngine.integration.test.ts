import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../storage/db';
import { setSyncState } from '../storage/repo';
import type { Page, Stroke, StoredAsset, SyncRecord } from '../storage/types';
import { saveSyncConfig, syncNow } from './engine';
import type { QuarantineEntry } from './quarantine';
import type { PushRequest } from './protocol';

/* ------------------------------------------------------------------ */
/* A laptop, in memory                                                 */
/* ------------------------------------------------------------------ */

type Refusal = { status: number; detail: string } | null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** The real client, the real engine, and only the socket replaced. */
class FakeServer {
  readonly origin = 'https://laptop.test:8443';
  readonly serverId = 'srv-1';
  seq = 0;
  objects = new Map<string, SyncRecord>();
  assets = new Map<string, unknown>();
  changes: { seq: number; record: SyncRecord }[] = [];
  log: string[] = [];
  pushStatus: number | null = null;
  /** A server that keeps claiming another page, to catch an endless walk. */
  repeatPages = false;
  down = false;
  refuseRecord: (record: SyncRecord) => Refusal = () => null;
  refuseAsset: (id: string) => Refusal = () => null;

  count(method: string, path: string): number {
    const line = `${method} ${path}`;
    return this.log.filter((entry) => entry === line).length;
  }

  pushes(): number {
    return this.count('POST', '/api/sync/push');
  }

  seed(record: SyncRecord): void {
    this.seq += 1;
    this.objects.set(`${record.kind}:${record.id}`, record);
    this.changes.push({ seq: this.seq, record });
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (this.down) throw new TypeError('Failed to fetch');
    const target = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(target);
    if (url.origin !== this.origin) throw new TypeError('Failed to fetch');
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname;
    this.log.push(`${method} ${path}`);

    if (path === '/api/health') {
      return json({
        ok: true,
        name: 'nota-server',
        version: 1,
        deviceName: 'LAPTOP',
        time: Date.now(),
        serverId: this.serverId,
        hostname: '',
        mdnsUrl: '',
        mdns: false,
      });
    }

    if (path === '/api/sync/push') {
      const body = JSON.parse(String(init?.body ?? '{}')) as PushRequest;
      if (this.pushStatus !== null) return json({ detail: 'the laptop is busy' }, this.pushStatus);
      // FastAPI validates the whole payload before storing anything: one
      // record it cannot read refuses the request, not just that record.
      for (const entry of body.records) {
        const refusal = this.refuseRecord(entry);
        if (refusal) return json({ detail: refusal.detail }, refusal.status);
      }
      const accepted = body.records.map((entry) => {
        this.seq += 1;
        this.objects.set(`${entry.kind}:${entry.id}`, entry);
        this.changes.push({ seq: this.seq, record: entry });
        return { kind: entry.kind, id: entry.id, version: entry.version, updatedAt: entry.updatedAt };
      });
      return json({ accepted, conflicts: [], cursor: this.seq, serverTime: Date.now() });
    }

    if (path === '/api/sync/changes') {
      const since = Number(url.searchParams.get('since') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '400');
      const page = this.changes.filter((row) => row.seq > since).slice(0, limit);
      const cursor = page.length > 0 ? page[page.length - 1]!.seq : this.seq;
      const hasMore = this.repeatPages || this.changes.some((row) => row.seq > cursor);
      return json({ records: page.map((row) => row.record), cursor, hasMore });
    }

    if (path.startsWith('/api/sync/assets/')) {
      const id = decodeURIComponent(path.slice('/api/sync/assets/'.length));
      if (method === 'PUT') {
        const refusal = this.refuseAsset(id);
        if (refusal) return json({ detail: refusal.detail }, refusal.status);
        this.assets.set(id, init?.body);
        return json({ ok: true });
      }
      if (!this.assets.has(id)) return json({ detail: 'asset not found' }, 404);
      return new Response(this.assets.get(id) as BodyInit, {
        headers: { 'content-type': 'application/octet-stream' },
      });
    }

    return json({ detail: 'not found' }, 404);
  };
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const PAGE_ID = 'page-1';
const realFetch = globalThis.fetch;
let server: FakeServer;

function stroke(id: string, overrides: Partial<Stroke> = {}): Stroke {
  return {
    id,
    pageId: PAGE_ID,
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    deviceId: 'ipad-1',
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

function record(
  kind: SyncRecord['kind'],
  id: string,
  data: unknown,
  overrides: Partial<SyncRecord> = {},
): SyncRecord {
  return { kind, id, data, createdAt: 1, updatedAt: 1, version: 1, deviceId: 'ipad-1', deletedAt: null, ...overrides };
}

function page(): Page {
  return {
    id: PAGE_ID,
    notebookId: 'nb-1',
    index: 0,
    title: 'Notes',
    template: 'ruled',
    size: 'a4',
    width: 1240,
    height: 1754,
    pdfAssetId: null,
    pdfPageIndex: 0,
    backgroundTint: null,
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    deviceId: 'laptop',
    deletedAt: null,
  };
}

async function parkedChanges(): Promise<QuarantineEntry[]> {
  const row = await db.syncState.get('syncQuarantine');
  return (row?.value as QuarantineEntry[] | undefined) ?? [];
}

async function queue(rows: { kind: 'stroke'; id: string }[]): Promise<void> {
  await db.outbox.bulkAdd(rows);
}

/* ------------------------------------------------------------------ */
/* Setup                                                               */
/* ------------------------------------------------------------------ */

beforeAll(() => {
  // The sync client aborts with window timers, and the engine refuses to run
  // with no network: both are the browser's, so they are lent here.
  (globalThis as unknown as { window?: unknown }).window = { setTimeout, clearTimeout };
  const existing = (globalThis as { navigator?: object }).navigator;
  if (existing) {
    Object.defineProperty(existing, 'onLine', { configurable: true, value: true });
  } else {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
  }
});

beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()));
  server = new FakeServer();
  globalThis.fetch = server.fetch as unknown as typeof fetch;
  await saveSyncConfig({
    serverUrl: server.origin,
    token: 'token-1',
    autoSync: true,
    serverId: server.serverId,
    mdns: false,
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

/* ------------------------------------------------------------------ */
/* 1. One refused record must not stop the rest of the notebook        */
/* ------------------------------------------------------------------ */

describe('a laptop that refuses one record', () => {
  it('sends everything else, parks the culprit with its reason, and stays logarithmic', async () => {
    const rows = Array.from({ length: 64 }, (_, index) => stroke(`s${index}`));
    await db.strokes.bulkPut(rows);
    await queue(rows.map((row) => ({ kind: 'stroke' as const, id: row.id })));
    server.refuseRecord = (entry) => (entry.id === 's7' ? { status: 422, detail: 'field required' } : null);

    const outcome = await syncNow();

    expect(outcome.ok).toBe(true);
    expect(outcome.pushed).toBe(63);
    expect(server.objects.size).toBe(63);
    expect(server.objects.has('stroke:s7')).toBe(false);
    expect(await db.outbox.count()).toBe(0);

    const parked = await parkedChanges();
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ kind: 'stroke', id: 's7' });
    expect(parked[0]?.reason).toContain('HTTP 422');

    // Halving to find the culprit: a couple of requests per level, not one per
    // record and certainly not the whole batch again on every tick.
    const pushes = server.pushes();
    expect(pushes).toBeLessThan(rows.length);
    expect(pushes).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(rows.length)) + 3);
  });

  it('does not resend the whole batch on the next tick', async () => {
    const rows = Array.from({ length: 16 }, (_, index) => stroke(`s${index}`));
    await db.strokes.bulkPut(rows);
    await queue(rows.map((row) => ({ kind: 'stroke' as const, id: row.id })));
    server.refuseRecord = (entry) => (entry.id === 's3' ? { status: 413, detail: 'record too large' } : null);
    await syncNow();
    const after = server.pushes();
    const accepted = server.objects.size;

    const again = await syncNow();

    expect(again.ok).toBe(true);
    expect(server.pushes()).toBe(after);
    expect(server.objects.size).toBe(accepted);
    expect(await parkedChanges()).toHaveLength(1);
    expect(await parkedChanges()).toMatchObject([{ id: 's3' }]);
  });

  it('treats 400 like 422: one record out, the rest in', async () => {
    const rows = [stroke('a'), stroke('b')];
    await db.strokes.bulkPut(rows);
    await queue(rows.map((row) => ({ kind: 'stroke' as const, id: row.id })));
    server.refuseRecord = (entry) => (entry.id === 'b' ? { status: 400, detail: 'bad request' } : null);

    const outcome = await syncNow();

    expect(outcome.ok).toBe(true);
    expect(server.objects.has('stroke:a')).toBe(true);
    expect(server.objects.has('stroke:b')).toBe(false);
    expect((await parkedChanges())[0]?.id).toBe('b');
  });

  it('does not let a refused attachment hold back the strokes behind it', async () => {
    const asset = {
      id: 'asset-1',
      createdAt: 1,
      updatedAt: 1,
      version: 1,
      deviceId: 'ipad-1',
      deletedAt: null,
      mime: 'application/pdf',
      sha256: 'abc',
      size: 3,
      filename: 'notes.pdf',
      blob: new Blob(['abc'], { type: 'application/pdf' }),
    } as unknown as StoredAsset;
    await db.assets.put(asset);
    await db.strokes.put(stroke('after-the-asset'));
    await db.outbox.bulkAdd([
      { kind: 'asset', id: 'asset-1' },
      { kind: 'stroke', id: 'after-the-asset' },
    ]);
    server.refuseAsset = () => ({ status: 413, detail: 'asset too large' });

    const outcome = await syncNow();

    expect(outcome.ok).toBe(true);
    expect(server.objects.has('stroke:after-the-asset')).toBe(true);
    // No metadata is sent for a file the laptop refused: that would advertise
    // a blob it will never have.
    expect(server.objects.has('asset:asset-1')).toBe(false);
    expect((await parkedChanges()).map((entry) => entry.id)).toContain('asset-1');
    expect(server.count('PUT', '/api/sync/assets/asset-1')).toBe(1);

    await syncNow();
    expect(server.count('PUT', '/api/sync/assets/asset-1')).toBe(1);
    expect(server.count('GET', '/api/sync/assets/asset-1')).toBe(0);
  });

  it('sends a parked record again once it has been edited', async () => {
    await db.strokes.put(stroke('s1'));
    await db.outbox.add({ kind: 'stroke', id: 's1' });
    server.refuseRecord = () => ({ status: 422, detail: 'nope' });
    await syncNow();
    expect(await parkedChanges()).toHaveLength(1);
    expect(server.objects.size).toBe(0);

    server.refuseRecord = () => null;
    await db.strokes.put(stroke('s1', { updatedAt: Date.now() + 5_000, version: 2 }));

    const outcome = await syncNow();

    expect(outcome.ok).toBe(true);
    expect(server.objects.has('stroke:s1')).toBe(true);
    expect(await parkedChanges()).toHaveLength(0);
  });

  it('forgets a parked record whose object has been deleted', async () => {
    await db.strokes.put(stroke('s1'));
    await db.outbox.add({ kind: 'stroke', id: 's1' });
    server.refuseRecord = () => ({ status: 422, detail: 'nope' });
    await syncNow();
    expect(await parkedChanges()).toHaveLength(1);

    await db.strokes.delete('s1');
    await syncNow();

    expect(await parkedChanges()).toHaveLength(0);
  });

  it('does not park a parked record a second time when its edit is refused again', async () => {
    await db.strokes.put(stroke('s1'));
    await db.outbox.add({ kind: 'stroke', id: 's1' });
    server.refuseRecord = () => ({ status: 422, detail: 'nope' });
    await syncNow();
    const first = await parkedChanges();

    await db.strokes.put(stroke('s1', { updatedAt: Date.now() + 5_000, version: 2 }));
    await syncNow();

    const second = await parkedChanges();
    expect(second).toHaveLength(1);
    expect(second[0]?.id).toBe('s1');
    expect(second[0]?.at).toBeGreaterThanOrEqual(first[0]?.at ?? 0);
  });
});

/* ------------------------------------------------------------------ */
/* 2. A laptop whose sequence went back                                */
/* ------------------------------------------------------------------ */

describe('a laptop whose sequence went back', () => {
  it('restarts the walk from the first record and applies what it finds', async () => {
    await setSyncState('pullCursor', 50);
    server.seed(record('page', PAGE_ID, page()));
    server.seed(record('stroke', 'from-laptop', stroke('from-laptop'), { createdAt: 2, updatedAt: 2 }));
    // The laptop always claims another page: only the repeated empty one ends it.
    server.repeatPages = true;

    const outcome = await syncNow();

    expect(outcome.ok).toBe(true);
    expect(await db.pages.get(PAGE_ID)).toBeTruthy();
    expect(await db.strokes.get('from-laptop')).toBeTruthy();
    expect((await db.pages.get(PAGE_ID))?.title).toBe('Notes');

    const cursor = await db.syncState.get('pullCursor');
    expect(cursor?.value).toBe(server.seq);

    // One look at 50, one restart from 0, one empty page that ends the walk.
    expect(server.count('GET', '/api/sync/changes')).toBeLessThanOrEqual(3);
  });

  it('keeps the cursor where the laptop is once the walk is over', async () => {
    await setSyncState('pullCursor', 50);
    server.seed(record('stroke', 'only-one', stroke('only-one')));

    await syncNow();

    const cursor = await db.syncState.get('pullCursor');
    expect(cursor?.value).toBe(1);
  });

  it('ends a pull that repeats the same empty page instead of spinning', async () => {
    await setSyncState('pullCursor', 0);
    server.repeatPages = true;

    const outcome = await syncNow();

    expect(outcome.ok).toBe(true);
    expect(server.count('GET', '/api/sync/changes')).toBeLessThanOrEqual(2);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Errors a retry can fix must abandon the pass, not park anything  */
/* ------------------------------------------------------------------ */

describe('trouble a retry can fix', () => {
  it('keeps the queue when the laptop reports an error', async () => {
    await db.strokes.put(stroke('s1'));
    await db.outbox.add({ kind: 'stroke', id: 's1' });
    server.pushStatus = 503;

    const outcome = await syncNow();

    expect(outcome.ok).toBe(false);
    expect(await parkedChanges()).toHaveLength(0);
    expect(await db.outbox.count()).toBe(1);

    server.pushStatus = null;
    const retry = await syncNow();
    expect(retry.ok).toBe(true);
    expect(server.objects.has('stroke:s1')).toBe(true);
    expect(await db.outbox.count()).toBe(0);
  });

  it('keeps the queue for a rate limit', async () => {
    await db.strokes.put(stroke('s1'));
    await db.outbox.add({ kind: 'stroke', id: 's1' });
    server.pushStatus = 429;

    expect((await syncNow()).ok).toBe(false);

    expect(await parkedChanges()).toHaveLength(0);
    expect(await db.outbox.count()).toBe(1);
  });

  it('keeps the queue when the laptop cannot be found at all', async () => {
    await db.strokes.put(stroke('s1'));
    await db.outbox.add({ kind: 'stroke', id: 's1' });
    server.down = true;

    const outcome = await syncNow();

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('not found');
    expect(await parkedChanges()).toHaveLength(0);
    expect(await db.outbox.count()).toBe(1);
  });
});

