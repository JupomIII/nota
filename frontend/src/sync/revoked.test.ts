import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SyncClient, SyncError } from './client';

/**
 * A revoked device is not a wrong token.
 *
 * The laptop knows the difference and says so with `code: "revoked"`; the app
 * has to repeat that sentence instead of sending the reader looking for a token
 * file that is perfectly fine.
 */

const realFetch = globalThis.fetch;

beforeAll(() => {
  (globalThis as unknown as { window?: unknown }).window = { setTimeout, clearTimeout };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

function answer(status: number, body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

describe('a token the laptop refuses', () => {
  it('says the device was removed when the laptop says revoked', async () => {
    answer(401, { detail: 'This device was removed on the laptop.', code: 'revoked' });
    const client = new SyncClient('http://localhost:8443', 'device-token', 'ipad-1');

    let caught: unknown;
    try {
      await client.status();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SyncError);
    expect((caught as SyncError).code).toBe('revoked');
    expect((caught as SyncError).kind).toBe('auth');
    expect((caught as Error).message).toMatch(/removed on the laptop/i);
    expect((caught as Error).message).not.toMatch(/check the token/i);
  });

  it('lists the paired devices the laptop reports, and revokes by id', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url.replace('http://localhost:8443', '')}`);
      if (url.endsWith('/revoke')) return new Response('{}', { status: 200 });
      return new Response(
        JSON.stringify({
          devices: [
            { id: 'a1', label: 'iPad Louise', address: '10.0.0.5', createdAt: 1, lastSeenAt: 1, revoked: false },
            { id: 'b2', label: 'iPad Paul', address: '10.0.0.6', createdAt: 1, lastSeenAt: 1, revoked: true },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const client = new SyncClient('http://localhost:8443', 'laptop-token', 'laptop');
    const devices = await client.pairedDevices();
    await client.revokeDevice('a1');

    expect(devices.map((entry) => entry.label)).toEqual(['iPad Louise', 'iPad Paul']);
    expect(calls).toEqual(['GET /api/devices', 'POST /api/devices/a1/revoke']);
  });

  it('keeps the token sentence when the laptop does not explain itself', async () => {
    answer(401, { detail: 'Invalid or missing pairing token.' });
    const client = new SyncClient('http://localhost:8443', 'wrong-token', 'ipad-1');

    let caught: unknown;
    try {
      await client.status();
    } catch (error) {
      caught = error;
    }

    expect((caught as SyncError).code).toBe('');
    expect((caught as Error).message).toMatch(/token was rejected/i);
  });
});
