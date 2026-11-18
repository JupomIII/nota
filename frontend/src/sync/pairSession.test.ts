import { afterEach, describe, expect, it, vi } from 'vitest';
import { pairWithSession, pairingProof } from './client';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('pairing with a scanned QR code', () => {
  it('sends a proof of the secret, never the secret', async () => {
    const sent: Record<string, unknown>[] = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          token: 'device-token',
          serverUrl: 'https://laptop.test:8443',
          deviceName: 'LAPTOP',
          mdns: false,
          code: 'A2F4G',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const result = await pairWithSession('https://laptop.test:8443/', 'session-1', 'the-secret', 'iPad 1234');

    expect(result.code).toBe('A2F4G');
    expect(result.token).toBe('device-token');
    const body = sent[0]!;
    expect(body.id).toBe('session-1');
    expect(body.deviceName).toBe('iPad 1234');
    expect(String(body.proof)).not.toContain('the-secret');
    // A vector computed independently with Python's hmac: the server computes
    // exactly this, and the session id is inside the signed message.
    expect(body.proof).toBe('df7ee89c980df324374b04cf9aff34becbb2052b45cad194dff5700e7a710876');
  });

  it('binds the proof to one session', async () => {
    const first = await pairingProof('the-secret', 'session-1');
    const second = await pairingProof('the-secret', 'session-2');
    expect(first).toHaveLength(64);
    expect(first).not.toBe(second);
  });

  it('explains an expired QR code in plain words', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 410 })) as unknown as typeof fetch;

    await expect(pairWithSession('https://laptop.test:8443', 's', 'k', 'iPad')).rejects.toThrow(
      /expired/i,
    );
  });

  it('explains a QR code that was already used', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 409 })) as unknown as typeof fetch;

    await expect(pairWithSession('https://laptop.test:8443', 's', 'k', 'iPad')).rejects.toThrow(
      /already paired/i,
    );
  });

  it('refuses to pair without an address', async () => {
    await expect(pairWithSession('  ', 's', 'k', 'iPad')).rejects.toThrow(/address/i);
  });
});
