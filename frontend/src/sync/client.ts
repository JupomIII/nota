import type {
  BackupInfo,
  ChangesResponse,
  HealthResponse,
  ImportResult,
  PairResponse,
  PushRequest,
  PushResponse,
  ServerStatus,
} from './protocol';

export class SyncError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly kind: 'network' | 'auth' | 'server' | 'config' = 'network',
    /** A machine-readable reason from the server, e.g. `revoked`. */
    readonly code: string = '',
  ) {
    super(message);
    this.name = 'SyncError';
  }
}

/** Accepts "192.168.1.20:8443", "https://host:8443/" or a full path. */
export function normalizeServerUrl(raw: string): string {
  let value = raw.trim();
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) {
    value = `https://${value}`;
  }
  value = value.replace(/\/+$/, '');
  return value;
}

function networkMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'The laptop did not answer in time. Is the server window still open?';
  }
  return (
    'Could not reach the laptop. Both devices must be on the same Wi-Fi, this iPad must trust the certificate, ' +
    'and Windows Firewall must let the server in (scripts\\allow-firewall.ps1 on the laptop). If iOS asked for ' +
    'Local Network access, allow it in Settings → Privacy & Security → Local Network.'
  );
}

/** Keeps server prose short and readable; FastAPI errors arrive as JSON. */
function cleanDetail(text: string): string {
  const trimmed = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!trimmed) return '';
  const readable = trimmed.length > 120 ? `${trimmed.slice(0, 117)}…` : trimmed;
  return /^[{\[]/.test(readable) ? '' : readable;
}

/**
 * One sentence a person can act on, instead of a status code and a stack trace.
 * Exported because it is the sync UI's vocabulary, not an implementation detail.
 */
export function describeHttpStatus(status: number, detail = ''): string {
  const extra = cleanDetail(detail);
  const withDetail = (base: string) => (extra ? `${base} ${extra}` : base);
  if (status === 400) return withDetail('The laptop could not read that request (HTTP 400).');
  if (status === 404) {
    return 'That address is not on the laptop (HTTP 404). Check the address and port shown in the server window.';
  }
  if (status === 409) return 'The laptop already holds a different copy of that item.';
  if (status === 413) return 'That item is too large for the laptop to accept.';
  if (status === 422) {
    // FastAPI validates every record: this is one *record* the laptop cannot
    // read, not the whole notebook, and the fix is a newer server there.
    return withDetail(
      'The laptop cannot read one of those changes (HTTP 422). Update the server on the laptop, then sync again.',
    );
  }
  if (status === 429) return 'The laptop is asking for a pause. Try again in a minute.';
  if (status >= 500) {
    return withDetail(
      `The laptop hit an error (HTTP ${status}). Try again, and restart the server window if it keeps happening.`,
    );
  }
  return withDetail(`The laptop answered HTTP ${status}.`);
}

/**
 * How long the laptop asked this device to wait, in seconds.
 *
 * The pairing refusal covers a sliding window, so the server's own number is
 * the only honest answer. Without the header the caller keeps the older
 * wording instead of inventing a delay.
 */
export function pauseSeconds(response: Response): number | null {
  const raw = (response.headers.get('retry-after') ?? '').trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.ceil(value);
}

/** A duration in the unit that fits it, so "wait" becomes something plannable. */
export function describeWait(seconds: number): string {
  const shown = Math.max(1, Math.round(seconds));
  if (shown < 60) return `${shown} second${shown === 1 ? '' : 's'}`;
  const minutes = Math.max(1, Math.round(shown / 60));
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/** The sentence shown when the laptop refuses further attempts for a while. */
export function pauseMessage(seconds: number | null): string {
  if (seconds === null) {
    return 'The laptop is asking for a pause. Wait a minute, then press Find this laptop again.';
  }
  return `The laptop is asking for a pause. Try again in about ${describeWait(seconds)}.`;
}

/** Pairing exchanges a six-character code for the long-lived token. */
export async function pairWithCode(
  rawUrl: string,
  code: string,
  deviceName: string,
): Promise<PairResponse> {
  const base = normalizeServerUrl(rawUrl);
  if (!base) throw new SyncError('Enter the laptop address first', null, 'config');
  let response: Response;
  try {
    response = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, deviceName }),
    });
  } catch (error) {
    throw new SyncError(networkMessage(error), null, 'network');
  }
  if (response.status === 401) {
    throw new SyncError('That pairing code has expired. Press Refresh code on the laptop, then type the new one.', 401, 'auth');
  }
  if (response.status === 429) {
    throw new SyncError('Too many attempts. Wait a minute, then use the current code on the laptop.', 429, 'auth');
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new SyncError(describeHttpStatus(response.status, text), response.status, 'server');
  }
  return (await response.json()) as PairResponse;
}

/**
 * The proof a scanned QR code buys.
 *
 * The secret from the QR never leaves this device: what travels is an HMAC of
 * the session id keyed by it, which proves knowledge and is worthless for any
 * other session.
 */
export async function pairingProof(secret: string, sessionId: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`nota-pair:${sessionId}`));
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Pairing with the QR code from the laptop: one secret, five minutes, one use.
 * The answer carries the five-character code the two screens compare by eye.
 */
export async function pairWithSession(
  rawUrl: string,
  sessionId: string,
  secret: string,
  deviceName: string,
  deviceKey = '',
): Promise<PairResponse> {
  const base = normalizeServerUrl(rawUrl);
  if (!base) throw new SyncError('Enter the laptop address first', null, 'config');
  let proof: string;
  try {
    proof = await pairingProof(secret, sessionId);
  } catch {
    throw new SyncError(
      'This browser cannot compute the pairing proof. Type the six-character code instead.',
      null,
      'config',
    );
  }
  let response: Response;
  try {
    response = await fetch(`${base}/api/pair/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: sessionId, proof, deviceName, deviceKey }),
    });
  } catch (error) {
    throw new SyncError(networkMessage(error), null, 'network');
  }
  if (response.status === 401) {
    throw new SyncError(
      'That QR code did not match this laptop, or it has already been tried three times. Scan a new one on the pairing page.',
      401,
      'auth',
    );
  }
  if (response.status === 409) {
    throw new SyncError(
      'That QR code has already paired a device. Scan the new one on the pairing page.',
      409,
      'auth',
    );
  }
  if (response.status === 410) {
    throw new SyncError(
      'That QR code has expired: they last five minutes. Scan the new one on the pairing page.',
      410,
      'auth',
    );
  }
  if (response.status === 429) {
    throw new SyncError(
      'Too many attempts on that QR code. Scan the new one on the pairing page.',
      429,
      'auth',
    );
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new SyncError(describeHttpStatus(response.status, text), response.status, 'server');
  }
  return (await response.json()) as PairResponse;
}

export interface PairAskHandle {
  id: string;
  expiresIn: number;
}

export type PairingAnswer =
  | { state: 'pending' | 'denied' | 'claimed' }
  | { state: 'allowed'; result: PairResponse };

/**
 * Asks the laptop to pair this device. Nothing comes back but a handle: the
 * laptop shows the request on its own page and decides there.
 */
export async function startPairing(
  rawUrl: string,
  label: string,
  deviceKey = '',
): Promise<PairAskHandle> {
  const base = normalizeServerUrl(rawUrl);
  if (!base) throw new SyncError('Enter the laptop address first', null, 'config');
  let response: Response;
  try {
    response = await fetch(`${base}/api/pair/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: label, deviceKey }),
    });
  } catch (error) {
    throw new SyncError(networkMessage(error), null, 'network');
  }
  if (response.status === 404) {
    throw new SyncError(
      'This laptop is running an older server, which has no waiting list yet. Type the pairing code below instead.',
      404,
      'server',
    );
  }
  if (response.status === 429) {
    // "Wait a minute" was wrong by a factor of ten: the server knows the real
    // delay, so it is the one quoted here.
    throw new SyncError(pauseMessage(pauseSeconds(response)), 429, 'auth');
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new SyncError(describeHttpStatus(response.status, text), response.status, 'server');
  }
  const body = (await response.json()) as Partial<PairAskHandle>;
  if (!body.id) throw new SyncError('The laptop did not name that request.', response.status, 'server');
  return { id: body.id, expiresIn: typeof body.expiresIn === 'number' ? body.expiresIn : 300 };
}

/** One look at a waiting request; the token arrives on the tick that follows Allow. */
export async function pollPairing(rawUrl: string, id: string): Promise<PairingAnswer> {
  const base = normalizeServerUrl(rawUrl);
  if (!base) throw new SyncError('Enter the laptop address first', null, 'config');
  let response: Response;
  try {
    response = await fetch(`${base}/api/pair/request/${encodeURIComponent(id)}`, { cache: 'no-store' });
  } catch (error) {
    throw new SyncError(networkMessage(error), null, 'network');
  }
  if (response.status === 404) {
    throw new SyncError('That request expired on the laptop. Press Find this laptop again.', 404, 'auth');
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new SyncError(describeHttpStatus(response.status, text), response.status, 'server');
  }
  const body = (await response.json()) as { state?: string; token?: string; serverUrl?: string; deviceName?: string };
  if (body.state === 'allowed' && body.token) {
    return {
      state: 'allowed',
      result: { token: body.token, serverUrl: body.serverUrl ?? base, deviceName: body.deviceName ?? '' },
    };
  }
  if (body.state === 'denied' || body.state === 'claimed') return { state: body.state };
  return { state: 'pending' };
}

/** One device the laptop has allowed in, as the laptop itself sees it. */
export interface PairedDevice {
  id: string;
  label: string;
  address: string;
  createdAt: number;
  lastSeenAt: number;
  revoked: boolean;
}

export class SyncClient {
  readonly baseUrl: string;

  constructor(
    rawUrl: string,
    private readonly token: string,
    private readonly deviceId: string,
  ) {
    this.baseUrl = normalizeServerUrl(rawUrl);
  }

  /** Aborts rather than leaving a spinner up forever on a sleeping laptop. */
  private async send(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    if (!this.baseUrl) throw new SyncError('Server address is empty', null, 'config');
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { 'X-Thoth-Token': this.token, ...(init.headers ?? {}) },
      });
    } catch (error) {
      throw new SyncError(networkMessage(error), null, 'network');
    } finally {
      window.clearTimeout(timer);
    }
  }

  private async request<T>(path: string, init: RequestInit = {}, timeoutMs = 20000): Promise<T> {
    const response = await this.send(path, init, timeoutMs);
    if (response.status === 401 || response.status === 403) {
      // The laptop says *why*: a removed device is not a wrong token, and the
      // reader should not be sent looking for a token file that is fine.
      const body = (await response.json().catch(() => ({}))) as { code?: string };
      if (body.code === 'revoked') {
        throw new SyncError(
          'This device was removed on the laptop. Pair it again when you are ready.',
          response.status,
          'auth',
          'revoked',
        );
      }
      throw new SyncError('The pairing token was rejected. Pair this iPad again from the laptop.', response.status, 'auth');
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new SyncError(describeHttpStatus(response.status, text), response.status, 'server');
    }
    return (await response.json()) as T;
  }

  /** Only the laptop answers this: the iPad is refused at the door. */
  async pairedDevices(): Promise<PairedDevice[]> {
    const body = await this.request<{ devices?: PairedDevice[] }>('/api/devices', { method: 'GET' }, 8000);
    return body.devices ?? [];
  }

  async revokeDevice(id: string): Promise<void> {
    await this.request<{ devices?: PairedDevice[] }>(
      `/api/devices/${encodeURIComponent(id)}/revoke`,
      { method: 'POST' },
      8000,
    );
  }

  health(): Promise<HealthResponse> {
    return this.request<HealthResponse>('/api/health', { method: 'GET' }, 8000);
  }

  /** Where the notes actually land: laptop name, storage folder and counts. */
  status(): Promise<ServerStatus> {
    return this.request<ServerStatus>('/api/status', { method: 'GET' }, 8000);
  }

  push(records: PushRequest['records']): Promise<PushResponse> {
    const body: PushRequest = { deviceId: this.deviceId, records };
    return this.request<PushResponse>('/api/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  changes(since: number, limit = 400): Promise<ChangesResponse> {
    return this.request<ChangesResponse>(`/api/sync/changes?since=${since}&limit=${limit}`, {
      method: 'GET',
    });
  }

  async uploadAsset(id: string, blob: Blob, mime: string): Promise<void> {
    const response = await this.send(
      `/api/sync/assets/${id}`,
      { method: 'PUT', headers: { 'Content-Type': mime || 'application/octet-stream' }, body: blob },
      60000,
    );
    if (!response.ok) {
      throw new SyncError(describeHttpStatus(response.status), response.status, 'server');
    }
  }

  async downloadAsset(id: string): Promise<Blob> {
    const response = await this.send(`/api/sync/assets/${id}`, { method: 'GET' }, 60000);
    if (!response.ok) {
      throw new SyncError(describeHttpStatus(response.status), response.status, 'server');
    }
    return response.blob();
  }

  createBackup(): Promise<BackupInfo> {
    return this.request<BackupInfo>('/api/backup/create', { method: 'POST' }, 120000);
  }

  listBackups(): Promise<BackupInfo[]> {
    return this.request<BackupInfo[]>('/api/backup/list', { method: 'GET' });
  }

  async exportBackup(): Promise<Blob> {
    const response = await this.send('/api/backup/export', { method: 'GET' }, 120000);
    if (!response.ok) throw new SyncError(describeHttpStatus(response.status), response.status, 'server');
    return response.blob();
  }

  async importBackup(file: Blob): Promise<ImportResult> {
    const response = await this.send(
      '/api/backup/import',
      { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file },
      120000,
    );
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new SyncError(describeHttpStatus(response.status, text), response.status, 'server');
    }
    return (await response.json()) as ImportResult;
  }

  async downloadBackup(name: string): Promise<Blob> {
    const response = await this.send(`/api/backup/download/${encodeURIComponent(name)}`, { method: 'GET' }, 120000);
    if (!response.ok) throw new SyncError(describeHttpStatus(response.status), response.status, 'server');
    return response.blob();
  }
}
