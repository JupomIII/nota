import { normalizeServerUrl } from './client';

/**
 * Finding the laptop again after it moves.
 *
 * A browser cannot browse Bonjour, so nothing here enumerates servers. What it
 * does instead is ask a short, ordered list of addresses "is this you?" and stop
 * at the first one that answers as *the same server* the iPad is paired with.
 *
 * The order is the whole strategy:
 *   1. the page's own origin, when the page is served by a Thoth server;
 *   2. the mDNS name, which the laptop keeps pointed at its current address;
 *   3. the address that worked last time;
 *   4. the address saved at pairing time.
 *
 * Identity matters as much as the order: on a café network, the address that
 * used to belong to the laptop can belong to something else. A candidate is
 * only adopted when the server it reaches reports the stored id.
 */

export type CandidateSource = 'session' | 'mdns' | 'last' | 'saved';

export interface ServerCandidate {
  url: string;
  source: CandidateSource;
  /** False when the server cannot prove it is the paired one (older builds). */
  verifiable: boolean;
}

export interface PageShape {
  origin: string;
  protocol: string;
  hostname: string;
}

export interface ResolveInput {
  /** Address saved at pairing time. */
  serverUrl: string;
  /** Address that answered most recently, if any. */
  lastUrl?: string;
  /** Identity learned from a previous connection. */
  serverId?: string;
  /**
   * Ports this server was seen on: the pairing address, the last good one, and
   * whatever the server announced. A name alone is not enough when the server
   * runs on something other than the default port.
   */
  ports?: number[];
  page?: PageShape | null;
  /** True when the page is served by a Thoth backend, so its origin is one. */
  servedByServer?: boolean;
  /** The published app is HTTPS, so plain HTTP candidates would be blocked. */
  securePage?: boolean;
  /**
   * False when the server advertises no local name (a trusted address is the
   * only way in). Undefined means "not known yet", which still tries it once.
   */
  mdns?: boolean;
}

export const MDNS_HOST = 'nota.local';
/** Only a fallback: the port actually used comes from the server itself. */
export const MDNS_PORT = 8443;

/** Ports worth trying under the advertised name, most likely first. */
export function candidatePorts(ports: number[] | undefined, fallback = MDNS_PORT): number[] {
  const seen = new Set<number>();
  for (const value of ports ?? []) {
    const port = Math.trunc(Number(value));
    if (Number.isFinite(port) && port > 0 && port < 65536) seen.add(port);
  }
  if (seen.size === 0) seen.add(fallback);
  return [...seen];
}

/** The port of a URL, or null when it does not carry one we can use. */
export function portOf(url: string): number | null {
  try {
    const parsed = new URL(url);
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === 'https:' ? 443 : parsed.protocol === 'http:' ? 80 : null;
  } catch {
    return null;
  }
}

export function mdnsUrl(protocol: 'https:' | 'http:', port = MDNS_PORT): string {
  return `${protocol === 'http:' ? 'http' : 'https'}://${MDNS_HOST}:${port}`;
}

/** The list of addresses to try, best first, without duplicates. */
export function candidateUrls(input: ResolveInput): ServerCandidate[] {
  const candidates: ServerCandidate[] = [];
  const seen = new Set<string>();
  const page = input.page ?? null;
  const secure = input.securePage ?? (page ? page.protocol !== 'http:' : true);
  const add = (raw: string, source: CandidateSource, verifiable = false) => {
    let url = normalizeServerUrl(raw);
    if (!url) return;
    // Safari blocks plain HTTP from an HTTPS page before the request leaves the
    // device. The same port speaks TLS on the laptop, so the address is raised
    // rather than dropped; loopback is exempt and left alone.
    if (secure && url.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/i.test(url)) {
      url = `https://${url.slice('http://'.length)}`;
    }
    if (seen.has(url)) return;
    seen.add(url);
    candidates.push({ url, source, verifiable });
  };

  // 1. The page belongs to a server: same origin, no CORS, no certificate.
  if (page && input.servedByServer) add(page.origin, 'session', false);

  // 2. The advertised name, once per port this server has been seen on. A
  // browser cannot read Bonjour's SRV record, so the port has to come from the
  // pairing/announcement history instead of a hardcoded 8443. A server behind a
  // trusted address advertises nothing, and asking for nota.local there would
  // only cost the first seconds of every reconnect.
  const ports = candidatePorts(input.ports);
  if (input.mdns !== false) {
    if (secure) {
      for (const port of ports) add(mdnsUrl('https:', port), 'mdns', true);
    } else if (page) {
      // A plain-HTTP page (the laptop's own copy) can reach either.
      for (const port of ports) add(mdnsUrl('http:', port), 'mdns', true);
      for (const port of ports) add(mdnsUrl('https:', port), 'mdns', true);
    }
  }

  // 3. Where it answered last time, then 4. where it was paired.
  add(input.lastUrl ?? '', 'last', true);
  add(input.serverUrl, 'saved', true);
  return candidates;
}

export interface ServerIdentity {
  deviceName: string;
  serverId?: string;
  hostname?: string;
  /** The address the server advertises, whose port is the one that works. */
  mdnsUrl?: string;
  /** False when this server has no local name at all (a trusted address). */
  mdns?: boolean;
}

/**
 * Whether a health answer is the server this iPad is paired with.
 *
 * With no stored id (first connection after pairing, or a server from before
 * identities existed) the candidate is accepted; once an id is known, a
 * different one is rejected so a pairing token is never offered to a stranger.
 */
export function matchesIdentity(storedId: string | undefined, health: ServerIdentity | null): boolean {
  if (!health) return false;
  const known = (storedId ?? '').trim();
  if (!known) return true;
  const reported = (health.serverId ?? '').trim();
  if (!reported) return false;
  return reported === known;
}

/** Reads a health payload without trusting its shape. */
export function readIdentity(payload: unknown): ServerIdentity | null {
  if (!payload || typeof payload !== 'object') return null;
  const body = payload as Record<string, unknown>;
  if (body.ok !== true) return null;
  if (typeof body.version !== 'number' || typeof body.deviceName !== 'string') return null;
  return {
    deviceName: body.deviceName,
    serverId: typeof body.serverId === 'string' && body.serverId ? body.serverId : undefined,
    hostname: typeof body.hostname === 'string' && body.hostname ? body.hostname : undefined,
    mdnsUrl: typeof body.mdnsUrl === 'string' && body.mdnsUrl ? body.mdnsUrl : undefined,
    mdns: typeof body.mdns === 'boolean' ? body.mdns : undefined,
  };
}

export type Probe = (url: string, timeoutMs: number) => Promise<ServerIdentity | null>;

/** Asks one address for /api/health. Any failure is simply "not this one". */
export const httpProbe: Probe = async (url, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${url}/api/health`, {
      cache: 'no-store',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;
    if (!(response.headers.get('content-type') ?? '').includes('json')) return null;
    return readIdentity(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

export interface ResolvedServer extends ServerIdentity {
  url: string;
  source: CandidateSource;
}

export interface ResolveOptions {
  probe?: Probe;
  timeoutMs?: number;
  /** Called for each address that did not answer, for diagnostics. */
  onMiss?: (candidate: ServerCandidate) => void;
}

/**
 * Walks the candidates until one answers as the paired server.
 *
 * The first address (the page's own origin) only has to answer: it is the
 * server we are literally talking to. Everything after it must prove identity.
 */
export async function resolveServer(
  input: ResolveInput,
  options: ResolveOptions = {},
): Promise<ResolvedServer | null> {
  const probe = options.probe ?? httpProbe;
  const timeoutMs = options.timeoutMs ?? 2500;
  const candidates = candidateUrls(input);
  // These addresses are alternatives, not steps. Asking them one after another
  // meant sitting out the full timeout of a dead port before trying the address
  // that worked last time, which is the usual reason "Searching for Nota…"
  // lingered for seconds. All probes start together and are read in preference
  // order: identity is what decides, so a fast unverified answer cannot win.
  const answers = candidates.map((candidate) =>
    probe(candidate.url, timeoutMs).catch(() => null),
  );
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate) continue;
    const health = await answers[index];
    if (!health) {
      options.onMiss?.(candidate);
      continue;
    }
    const isSession = candidate.source === 'session';
    if (!isSession && !matchesIdentity(input.serverId, health)) {
      options.onMiss?.(candidate);
      continue;
    }
    return { ...health, url: candidate.url, source: candidate.source };
  }
  return null;
}

/**
 * What the screen says, in the words a person uses. No addresses, no ports:
 * those live in the diagnostics panel.
 */
export type ConnectionState =
  | 'connected'
  | 'searching'
  | 'reconnecting'
  | 'offline'
  | 'attention'
  | 'unpaired';

export interface ConnectionInput {
  phase: string;
  online: boolean;
  pending: number;
  paired: boolean;
  needsAttention?: boolean;
}

export function connectionState(input: ConnectionInput): ConnectionState {
  if (!input.paired) return 'unpaired';
  if (!input.online) return 'offline';
  if (input.needsAttention) return 'attention';
  if (input.phase === 'syncing') return 'connected';
  if (input.phase === 'searching') return input.pending > 0 ? 'reconnecting' : 'searching';
  if (input.phase === 'error') return 'reconnecting';
  if (input.phase === 'offline') return 'offline';
  return 'connected';
}

export const CONNECTION_LABELS: Record<ConnectionState, string> = {
  // Short on purpose: it is the header subtitle, next to a title, on a 390 px
  // screen. The destination card already names the laptop.
  connected: 'Connected',
  searching: 'Searching for your laptop…',
  reconnecting: 'Reconnecting…',
  offline: 'Offline — changes saved locally',
  attention: 'Connection requires attention',
  unpaired: 'Not connected yet',
};
