import { describe, expect, it } from 'vitest';
import {
  describeHttpStatus,
  describeWait,
  normalizeServerUrl,
  pauseMessage,
  pauseSeconds,
  startPairing,
} from './client';

const refusal = (retryAfter?: string): Response =>
  new Response(JSON.stringify({ detail: 'too many requests' }), {
    status: 429,
    headers: retryAfter ? { 'Retry-After': retryAfter } : {},
  });

describe('a pairing refusal that says when to come back', () => {
  it('quotes the laptop’s own window in minutes', () => {
    expect(pauseSeconds(refusal('240'))).toBe(240);
    expect(pauseMessage(240)).toBe(
      'The laptop is asking for a pause. Try again in about 4 minutes.',
    );
  });

  it('speaks in seconds for a wait shorter than a minute', () => {
    expect(pauseMessage(45)).toContain('in about 45 seconds');
    expect(pauseMessage(1)).toContain('in about 1 second');
  });

  it('keeps the older wording when the laptop sends no duration', () => {
    expect(pauseSeconds(refusal())).toBeNull();
    expect(pauseMessage(null)).toContain('Wait a minute');
  });

  it('ignores a header that is not a positive number', () => {
    expect(pauseSeconds(refusal('later'))).toBeNull();
    expect(pauseSeconds(refusal('0'))).toBeNull();
    expect(pauseSeconds(refusal('-30'))).toBeNull();
  });

  it('rounds a rate limit up, never down', () => {
    expect(pauseSeconds(refusal('59.2'))).toBe(60);
    expect(describeWait(60)).toBe('1 minute');
  });

  it('reaches the screen through the request that was refused', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => refusal('300')) as unknown as typeof fetch;
    try {
      await expect(startPairing('https://laptop.local:8443', 'iPad')).rejects.toThrow(
        /Try again in about 5 minutes/,
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('describeHttpStatus', () => {
  it('turns a missing route into an address hint', () => {
    const message = describeHttpStatus(404);
    expect(message).toContain('HTTP 404');
    expect(message).toContain('address');
  });

  it('tells the reader what to do when the laptop breaks', () => {
    const message = describeHttpStatus(500);
    expect(message).toContain('HTTP 500');
    expect(message.toLowerCase()).toContain('restart the server window');
  });

  it('explains a rate limit without shouting', () => {
    expect(describeHttpStatus(429)).toContain('Try again in a minute');
  });

  it('says a change did not fit what this version sends, not that sync broke', () => {
    const message = describeHttpStatus(422);
    expect(message).toContain('HTTP 422');
    expect(message).toContain('Update the server on the laptop');
  });

  it('drops machine-shaped details but keeps readable prose', () => {
    expect(describeHttpStatus(400, '{"detail":[{"msg":"field required"}]}')).toBe(
      'The laptop could not read that request (HTTP 400).',
    );
    expect(describeHttpStatus(400, 'Missing title')).toContain('Missing title');
  });

  it('strips markup and shortens long server text', () => {
    const long = `<html><body>${'wide '.repeat(80)}</body></html>`;
    const message = describeHttpStatus(503, long);
    expect(message).not.toContain('<');
    expect(message.length).toBeLessThan(260);
  });
});

describe('normalizeServerUrl', () => {
  it('accepts a bare address and assumes HTTPS', () => {
    expect(normalizeServerUrl('192.168.1.20:8443')).toBe('https://192.168.1.20:8443');
  });

  it('drops trailing slashes but keeps the scheme', () => {
    expect(normalizeServerUrl('  https://laptop.local:8443// ')).toBe('https://laptop.local:8443');
  });

  it('returns empty for empty input', () => {
    expect(normalizeServerUrl('   ')).toBe('');
  });
});
