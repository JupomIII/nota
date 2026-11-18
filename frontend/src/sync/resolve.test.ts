import { describe, expect, it } from 'vitest';
import {
  CONNECTION_LABELS,
  MDNS_HOST,
  candidatePorts,
  candidateUrls,
  connectionState,
  matchesIdentity,
  portOf,
  readIdentity,
  resolveServer,
  type Probe,
} from './resolve';

const published = {
  origin: 'https://jupomiii.github.io',
  protocol: 'https:',
  hostname: 'jupomiii.github.io',
};

describe('candidateUrls', () => {
  it('asks the advertised name first on a published HTTPS page', () => {
    const found = candidateUrls({
      serverUrl: 'https://192.168.1.20:8443',
      lastUrl: 'https://10.0.0.5:8443',
      page: published,
    });
    expect(found.map((entry) => entry.url)).toEqual([
      `https://${MDNS_HOST}:8443`,
      'https://10.0.0.5:8443',
      'https://192.168.1.20:8443',
    ]);
  });

  it('starts with the page origin when a Thoth server serves the page', () => {
    const found = candidateUrls({
      serverUrl: 'https://192.168.1.20:8443',
      page: { origin: 'http://localhost:8080', protocol: 'http:', hostname: 'localhost' },
      servedByServer: true,
    });
    expect(found[0]).toEqual({ url: 'http://localhost:8080', source: 'session', verifiable: false });
  });

  it('never offers plain HTTP to an HTTPS page, which Safari blocks outright', () => {
    const found = candidateUrls({
      serverUrl: 'http://192.168.1.20:8443',
      page: published,
      securePage: true,
    });
    expect(found.every((entry) => entry.url.startsWith('https://'))).toBe(true);
  });

  it('drops duplicates so one dead address is not probed three times', () => {
    const found = candidateUrls({
      serverUrl: 'https://10.0.0.5:8443',
      lastUrl: 'https://10.0.0.5:8443/',
      page: published,
    });
    expect(found.filter((entry) => entry.url === 'https://10.0.0.5:8443')).toHaveLength(1);
  });

  it('has nothing to try without an address or a page', () => {
    expect(candidateUrls({ serverUrl: '', page: null })).toHaveLength(1); // mDNS only
  });

  it('tries every port the server was seen on, not just 8443', () => {
    const found = candidateUrls({ serverUrl: '', ports: [9443], page: published });
    expect(found.map((entry) => entry.url)).toEqual([`https://${MDNS_HOST}:9443`]);
  });

  it('prefers the learned port over the default one', () => {
    const found = candidateUrls({ serverUrl: '', ports: [9443, 8443], page: published });
    expect(found.map((entry) => entry.url)).toEqual([
      `https://${MDNS_HOST}:9443`,
      `https://${MDNS_HOST}:8443`,
    ]);
  });

  it('stops asking for a local name the server says it does not advertise', () => {
    const found = candidateUrls({
      serverUrl: 'https://nota-example.ts.net',
      lastUrl: 'https://nota-example.ts.net',
      page: published,
      mdns: false,
    });
    expect(found.map((entry) => entry.url)).toEqual(['https://nota-example.ts.net']);
    expect(found.some((entry) => entry.url.includes(MDNS_HOST))).toBe(false);
  });

  it('keeps trying the local name until the server has been asked', () => {
    const found = candidateUrls({ serverUrl: 'https://nota-example.ts.net', page: published });
    expect(found[0]?.source).toBe('mdns');
  });
});

describe('candidatePorts', () => {
  it('drops nonsense and keeps the order it was given', () => {
    expect(candidatePorts([9443, 0, -1, 70000, 9443, 8443])).toEqual([9443, 8443]);
  });

  it('falls back to the default port only when nothing is known', () => {
    expect(candidatePorts([])).toEqual([8443]);
    expect(candidatePorts(undefined, 9443)).toEqual([9443]);
  });
});

describe('portOf', () => {
  it('reads an explicit port', () => {
    expect(portOf('https://nota.local:9443')).toBe(9443);
    expect(portOf('http://192.168.1.20:8080')).toBe(8080);
  });

  it('assumes the protocol default when the URL omits it', () => {
    expect(portOf('https://nota.local')).toBe(443);
    expect(portOf('http://nota.local')).toBe(80);
  });

  it('returns null for something that is not a URL', () => {
    expect(portOf('')).toBeNull();
  });
});

describe('matchesIdentity', () => {
  it('accepts a server that reports the stored id', () => {
    expect(matchesIdentity('abc123', { deviceName: 'laptop', serverId: 'abc123' })).toBe(true);
  });

  it('rejects a different server that inherited the old address', () => {
    expect(matchesIdentity('abc123', { deviceName: 'café printer', serverId: 'zzz999' })).toBe(false);
  });

  it('rejects a server that cannot prove who it is once an id is known', () => {
    expect(matchesIdentity('abc123', { deviceName: 'laptop' })).toBe(false);
  });

  it('accepts anything on the first connection, when no id is stored yet', () => {
    expect(matchesIdentity(undefined, { deviceName: 'laptop', serverId: 'new' })).toBe(true);
  });
});

describe('resolveServer', () => {
  const answer =
    (map: Record<string, { deviceName: string; serverId?: string }>) =>
    async (url: string): Promise<{ deviceName: string; serverId?: string; hostname?: string } | null> =>
      map[url] ?? null;

  it('skips an address that answers as another server and keeps going', async () => {
    const probe: Probe = answer({
      [`https://${MDNS_HOST}:8443`]: { deviceName: 'someone else', serverId: 'other' },
      'https://10.0.0.5:8443': { deviceName: 'nota-laptop', serverId: 'abc123' },
    });
    const hit = await resolveServer(
      {
        serverUrl: 'https://192.168.1.20:8443',
        lastUrl: 'https://10.0.0.5:8443',
        serverId: 'abc123',
        page: published,
      },
      { probe },
    );
    expect(hit?.url).toBe('https://10.0.0.5:8443');
    expect(hit?.source).toBe('last');
  });

  it('returns null when nothing answers as the paired server', async () => {
    const probe: Probe = answer({ [`https://${MDNS_HOST}:8443`]: { deviceName: 'other', serverId: 'other' } });
    const hit = await resolveServer(
      { serverUrl: 'https://192.168.1.20:8443', serverId: 'abc123', page: published },
      { probe },
    );
    expect(hit).toBeNull();
  });

  it('reports misses so a stuck connection can be described', async () => {
    const misses: string[] = [];
    await resolveServer(
      { serverUrl: 'https://192.168.1.20:8443', page: published },
      { probe: async () => null, onMiss: (candidate) => misses.push(candidate.url) },
    );
    expect(misses.length).toBeGreaterThan(1);
  });
});

describe('readIdentity', () => {
  it('needs the shape only a Thoth server answers', () => {
    expect(readIdentity({ ok: true, version: 1, deviceName: 'x' })).toEqual({
      deviceName: 'x',
      serverId: undefined,
      hostname: undefined,
    });
    expect(readIdentity({ ok: false })).toBeNull();
    expect(readIdentity('<html>')).toBeNull();
  });
});

describe('readIdentity, trusted addresses', () => {
  it('reads whether the laptop advertises a local name at all', () => {
    const behindTunnel = readIdentity({
      ok: true,
      version: 1,
      deviceName: 'nota-laptop',
      mdns: false,
      hostname: '',
    });
    expect(behindTunnel?.mdns).toBe(false);
    expect(behindTunnel?.hostname).toBeUndefined();
    // An older server says nothing, so the app keeps trying the name once.
    expect(readIdentity({ ok: true, version: 1, deviceName: 'x' })?.mdns).toBeUndefined();
  });
});

describe('connectionState', () => {
  it('says offline when the device has no network, whatever the last attempt said', () => {
    expect(connectionState({ phase: 'error', online: false, pending: 3, paired: true })).toBe('offline');
  });

  it('calls a refused pairing attention, not a network problem', () => {
    expect(
      connectionState({ phase: 'error', online: true, pending: 0, paired: true, needsAttention: true }),
    ).toBe('attention');
  });

  it('is reconnecting when changes are waiting on a search', () => {
    expect(connectionState({ phase: 'searching', online: true, pending: 2, paired: true })).toBe(
      'reconnecting',
    );
    expect(connectionState({ phase: 'searching', online: true, pending: 0, paired: true })).toBe(
      'searching',
    );
  });

  it('has a plain sentence for every state', () => {
    for (const label of Object.values(CONNECTION_LABELS)) {
      expect(label).not.toMatch(/http|:\d|192\.|10\./);
    }
  });
});
