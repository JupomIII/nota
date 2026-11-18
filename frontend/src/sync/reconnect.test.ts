import 'fake-indexeddb/auto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../storage/db';
import type { Stroke } from '../storage/types';
import { loadSyncConfig, saveSyncConfig, syncNow } from './engine';
import type { SyncRecord } from '../storage/types';

/**
 * Reconnection, with the token the QR pairing handed out.
 *
 * The laptop sleeps, comes back at another address (the mDNS name stays put),
 * and the app has to find it again without asking anyone to scan a new code.
 * The real engine, the real resolver and the real client run here; only the
 * socket is replaced.
 */

const OLD_URL = 'https://192.168.1.20:8443';
const NAME_URL = 'https://nota.local:8443';
const SERVER_ID = 'laptop-identity';

let realFetch: typeof fetch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function health(): Response {
  return json({
    ok: true,
    name: 'nota-server',
    version: 1,
    deviceName: 'nota-laptop',
    time: Date.now(),
    serverId: SERVER_ID,
    hostname: 'nota.local',
    mdnsUrl: NAME_URL,
    mdns: true,
  });
}

interface Harness {
  token: string;
  pushes: number;
  statusGets: number;
}

/** A laptop that only answers under the advertised name, as after a DHCP move. */
function laptopAt(nameOnly: boolean, up = true): Harness {
  const seen: Harness = { token: '', pushes: 0, statusGets: 0 };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!up) throw new TypeError('Failed to fetch');
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const origin = `${url.protocol}//${url.host}`;
    if (nameOnly && origin === OLD_URL) throw new TypeError('Failed to fetch');
    if (url.pathname === '/api/health') return health();
    seen.token = String(new Headers(init?.headers).get('x-thoth-token') ?? '');
    if (url.pathname === '/api/status') {
      seen.statusGets += 1;
      return json({ deviceName: 'nota-laptop', counts: {}, conflicts: 0, cursor: 1, devices: [], dataDir: 'D:\\nota' });
    }
    if (url.pathname === '/api/sync/push') {
      seen.pushes += 1;
      const body = JSON.parse(String(init?.body ?? '{}')) as { records: SyncRecord[] };
      return json({
        accepted: body.records.map((entry) => ({
          kind: entry.kind,
          id: entry.id,
          version: entry.version,
          updatedAt: entry.updatedAt,
        })),
        conflicts: [],
        cursor: 1,
        serverTime: Date.now(),
      });
    }
    if (url.pathname === '/api/sync/changes') {
      return json({ records: [], cursor: 1, hasMore: false });
    }
    return json({ detail: 'not found' }, 404);
  }) as unknown as typeof fetch;
  return seen;
}

function stroke(id: string): Stroke {
  return {
    id,
    pageId: 'page-1',
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
  };
}

beforeAll(() => {
  (globalThis as unknown as { window?: unknown }).window = { setTimeout, clearTimeout };
  const existing = (globalThis as { navigator?: object }).navigator;
  if (existing) {
    Object.defineProperty(existing, 'onLine', { configurable: true, value: true });
  } else {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });
  }
  realFetch = globalThis.fetch;
});

beforeEach(async () => {
  await Promise.all(db.tables.map((table) => table.clear()));
  globalThis.fetch = realFetch;
  // What the QR pairing left behind: one address, one identity, one device token.
  await saveSyncConfig({
    serverUrl: OLD_URL,
    token: 'device-token-from-qr',
    autoSync: true,
    serverId: SERVER_ID,
    lastUrl: OLD_URL,
    mdns: true,
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('the laptop goes to sleep', () => {
  it('keeps the queue and the token, then catches up by itself', async () => {
    await db.strokes.put(stroke('s1'));
    await db.outbox.add({ kind: 'stroke', id: 's1' });

    laptopAt(false, false);
    const asleep = await syncNow();

    expect(asleep.ok).toBe(false);
    expect(asleep.message).toContain('not found');
    expect(await db.outbox.count()).toBe(1);
    // Nothing was re-paired and nothing was thrown away.
    expect((await loadSyncConfig()).token).toBe('device-token-from-qr');

    const seen = laptopAt(false, true);
    const awake = await syncNow();

    expect(awake.ok).toBe(true);
    expect(awake.pushed).toBe(1);
    expect(await db.outbox.count()).toBe(0);
    expect(seen.token).toBe('device-token-from-qr');
  });
});

describe('the laptop comes back at another address', () => {
  it('follows the advertised name and sends the same device token', async () => {
    await db.strokes.put(stroke('s2'));
    await db.outbox.add({ kind: 'stroke', id: 's2' });
    const seen = laptopAt(true);

    const outcome = await syncNow();

    expect(outcome.ok).toBe(true);
    expect(outcome.pushed).toBe(1);
    expect(seen.token).toBe('device-token-from-qr');
    // The saved address is replaced, so the next run starts on the live one.
    const config = await loadSyncConfig();
    expect(config.serverUrl).toBe(NAME_URL);
    expect(config.lastUrl).toBe(NAME_URL);
    // And the identity is unchanged: this is the same laptop, not a stranger.
    expect(config.serverId).toBe(SERVER_ID);
  });

  it('refuses an address that answers as a different server', async () => {
    await db.strokes.put(stroke('s3'));
    await db.outbox.add({ kind: 'stroke', id: 's3' });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      if (url.pathname !== '/api/health') throw new TypeError('Failed to fetch');
      return json({
        ok: true,
        name: 'nota-server',
        version: 1,
        deviceName: 'someone else',
        time: Date.now(),
        serverId: 'not-our-laptop',
        mdns: false,
      });
    }) as unknown as typeof fetch;

    const outcome = await syncNow();

    expect(outcome.ok).toBe(false);
    // The token was never offered to the stranger that inherited the address.
    expect(await db.outbox.count()).toBe(1);
  });
});
