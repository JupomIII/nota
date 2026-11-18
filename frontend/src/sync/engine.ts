import { db, type OutboxEntry } from '../storage/db';
import type { StoredAsset, SyncKind, SyncRecord } from '../storage/types';
import {
  applyRemoteRecord,
  clearOutboxFor,
  getDeviceId,
  getSyncState,
  markOutbox,
  pendingCount,
  readEntity,
  setSyncState,
} from '../storage/repo';
import { SyncClient, SyncError, normalizeServerUrl, pairWithCode } from './client';
import { detectLocalServer, detectPairingCode, isServedByThoth, pageLocation, planAdoption, type DetectedServer } from './discovery';
import { portOf, resolveServer, type ResolvedServer } from './resolve';
import {
  describeParked,
  isPermanentRefusal,
  pushFailurePlan,
  quarantineKey,
  stillParked,
  type QuarantineEntry,
} from './quarantine';
import { MAX_BATCH, type PushResponse } from './protocol';
import { syncStatus } from './store';
import { now } from '../lib/id';
import { SYNC_INTERVAL_MS, retryDelay } from './backoff';

export interface SyncConfig {
  /** Address used at pairing time; only one of the candidates now. */
  serverUrl: string;
  token: string;
  autoSync: boolean;
  /** Identity of the paired server, so a new address is still the same server. */
  serverId?: string;
  /** The address that answered last, tried before the saved one. */
  lastUrl?: string;
  /** Ports this server has been seen on, so a non-default port is not lost. */
  mdnsPorts?: number[];
  /** False once the server says it advertises no local name (trusted address). */
  mdns?: boolean;
}

export interface SyncOutcome {
  ok: boolean;
  pushed: number;
  pulled: number;
  conflicts: number;
  assets: number;
  message: string;
}

const CONFIG_KEY = 'syncConfig';
const CURSOR_KEY = 'pullCursor';
const QUARANTINE_KEY = 'syncQuarantine';

async function loadQuarantine(): Promise<QuarantineEntry[]> {
  const rows = await getSyncState<QuarantineEntry[]>(QUARANTINE_KEY, []);
  return Array.isArray(rows) ? rows : [];
}

/**
 * Sets one change aside: its queue entry goes, so the rest of the outbox can
 * move, and the reason stays on the device with the object it belongs to.
 */
async function parkEntry(kind: SyncKind, id: string, label: string, reason: string): Promise<void> {
  const key = quarantineKey(kind, id);
  const parked = (await loadQuarantine()).filter((row) => quarantineKey(row.kind, row.id) !== key);
  parked.push({ kind, id, label, reason, at: now() });
  await setSyncState(QUARANTINE_KEY, parked);
  await clearOutboxFor(kind, id);
}

/**
 * Parked entries are retried only when the object changed since: an edit is a
 * new payload, and the refusal was about the old one. An object that is gone
 * needs no retry at all, so it simply leaves the list.
 */
async function rehealQuarantine(): Promise<Set<string>> {
  const parked = await loadQuarantine();
  if (parked.length === 0) return new Set<string>();
  const kept: QuarantineEntry[] = [];
  for (const entry of parked) {
    const entity = await readEntity(entry.kind, entry.id);
    if (!entity) continue;
    if (stillParked(entry, entity.updatedAt)) {
      kept.push(entry);
      continue;
    }
    await markOutbox(entry.kind, entry.id);
  }
  if (kept.length !== parked.length) await setSyncState(QUARANTINE_KEY, kept);
  return new Set(kept.map((entry) => quarantineKey(entry.kind, entry.id)));
}

export async function loadSyncConfig(): Promise<SyncConfig> {
  const config = await getSyncState<SyncConfig>(CONFIG_KEY, {
    serverUrl: '',
    token: '',
    autoSync: true,
  });
  return {
    serverUrl: config.serverUrl ?? '',
    token: config.token ?? '',
    autoSync: config.autoSync !== false,
    serverId: (config.serverId ?? '').trim() || undefined,
    lastUrl: (config.lastUrl ?? '').trim() || undefined,
    mdnsPorts: Array.isArray(config.mdnsPorts)
      ? config.mdnsPorts.filter((port) => Number.isFinite(port) && port > 0)
      : undefined,
    mdns: typeof config.mdns === 'boolean' ? config.mdns : undefined,
  };
}

export async function saveSyncConfig(patch: Partial<SyncConfig>): Promise<SyncConfig> {
  const current = await loadSyncConfig();
  const serverUrl = normalizeServerUrl(patch.serverUrl ?? current.serverUrl);
  const next: SyncConfig = {
    serverUrl,
    token: (patch.token ?? current.token).trim(),
    autoSync: patch.autoSync ?? current.autoSync,
    // Pairing keeps its identity; changing address never clears the token.
    serverId: patch.serverId ?? current.serverId,
    lastUrl: patch.lastUrl ?? (serverUrl ? serverUrl : current.lastUrl),
    mdnsPorts: patch.mdnsPorts ?? current.mdnsPorts,
    mdns: patch.mdns ?? current.mdns,
  };
  await setSyncState(CONFIG_KEY, next);
  // A new token is a new start: the refusal that applied to the previous one
  // no longer describes this device.
  await syncStatus.update({
    phase: next.serverUrl && next.token ? 'idle' : 'unconfigured',
    needsAttention: false,
    revoked: false,
  });
  return next;
}

export async function refreshCounters(): Promise<void> {
  const [pending, conflicts, parked] = await Promise.all([
    pendingCount(),
    db.conflicts.count(),
    loadQuarantine(),
  ]);
  const config = await loadSyncConfig();
  const lastSyncAt = await getSyncState<number | null>('lastSyncAt', null);
  syncStatus.update({
    pending,
    conflicts,
    stuck: parked.length,
    stuckNote: describeParked(parked),
    lastSyncAt,
    phase:
      syncStatus.getSnapshot().phase === 'syncing'
        ? 'syncing'
        : syncStatus.getSnapshot().phase === 'searching'
          ? 'searching'
        : !config.serverUrl || !config.token
          ? 'unconfigured'
          : syncStatus.getSnapshot().phase === 'error'
            ? 'error'
            : syncStatus.getSnapshot().online
              ? 'idle'
              : 'offline',
  });
}

export async function testConnection(
  serverUrl: string,
  token: string,
): Promise<{ ok: boolean; message: string }> {
  const deviceId = await getDeviceId();
  const client = new SyncClient(serverUrl, token, deviceId);
  try {
    const health = await client.health();
    return { ok: true, message: `${health.deviceName || 'Windows server'} · protocol v${health.version}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Connection failed';
    return { ok: false, message };
  }
}

export interface AdoptionResult {
  state: 'paired' | 'connected';
  detected: DetectedServer;
}

let adopting: Promise<AdoptionResult | null> | null = null;
/** The page origin cannot change without a reload, so one answer serves all screens. */
let adopted: AdoptionResult | null | undefined;

/**
 * A page served by the laptop's own backend already belongs to a machine, so it
 * adopts that origin instead of asking for an address. When the laptop is the
 * one asking, it can also read its own pairing page and pair with no typing.
 * Pages served from GitHub cannot discover anything: there it returns null.
 */
export function adoptServedServer(): Promise<AdoptionResult | null> {
  if (adopted !== undefined) return Promise.resolve(adopted);
  adopting ??= runAdoption()
    .then((result) => {
      adopted = result;
      return result;
    })
    .finally(() => {
      adopting = null;
    });
  return adopting;
}

/** Forgets the cached answer and probes again: the server may just have started. */
export function recheckServedServer(): Promise<AdoptionResult | null> {
  adopted = undefined;
  return adoptServedServer();
}

async function runAdoption(): Promise<AdoptionResult | null> {
  const config = await loadSyncConfig();
  // A stored loopback address is worth trying first on the laptop.
  const candidates = /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/i.test(config.serverUrl) ? [config.serverUrl] : [];
  const detected = await detectLocalServer(undefined, candidates);
  if (!detected) return null;
  const code = config.token.trim() ? null : await detectPairingCode(detected.origin);
  const plan = planAdoption(config, detected, code);
  if (plan.kind === 'none') return { state: 'connected', detected };
  if (plan.kind === 'repoint') {
    await saveSyncConfig({ serverUrl: plan.serverUrl });
    return { state: 'connected', detected };
  }
  try {
    const deviceId = await getDeviceId();
    const result = await pairWithCode(plan.serverUrl, plan.code, `Laptop ${deviceId.slice(0, 4)}`);
    // Stay on the address the page was served from, not the LAN one the server
    // reports: same-origin requests need no CORS entry and survive an IP change.
    await saveSyncConfig({ serverUrl: plan.serverUrl, token: result.token });
    return { state: 'paired', detected };
  } catch {
    // Keep the address even if pairing is refused: the form is then filled in.
    await saveSyncConfig({ serverUrl: plan.serverUrl });
    return { state: 'connected', detected };
  }
}

let inflight: Promise<SyncOutcome> | null = null;

export function syncNow(): Promise<SyncOutcome> {
  // A tap and a timer tick can land together: join the run instead of failing.
  inflight ??= runSync().finally(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * Finds the paired server, whatever address it holds now.
 *
 * The stored id is what makes this safe: a candidate only wins when it reports
 * the same identity, so the pairing token is never handed to a stranger that
 * inherited the old address on another network.
 */
export async function resolveActiveServer(
  config?: SyncConfig,
): Promise<{ config: SyncConfig; server: ResolvedServer } | null> {
  const cfg = config ?? (await loadSyncConfig());
  if (!cfg.token) return null;
  const page = pageLocation();
  const knownPorts = knownPortsOf(cfg);
  const server = await resolveServer({
    serverUrl: cfg.serverUrl,
    lastUrl: cfg.lastUrl,
    serverId: cfg.serverId,
    ports: knownPorts,
    page,
    servedByServer: isServedByThoth(page),
    securePage: page ? page.protocol !== 'http:' : true,
    mdns: cfg.mdns,
  });
  if (!server) return null;
  const next: SyncConfig = {
    ...cfg,
    serverUrl: server.url,
    lastUrl: server.url,
    serverId: server.serverId ?? cfg.serverId,
    mdnsPorts: rememberPorts(knownPorts, [server.mdnsUrl, server.url]),
    mdns: server.mdns ?? cfg.mdns,
  };
  const changed =
    next.serverUrl !== cfg.serverUrl ||
    next.lastUrl !== cfg.lastUrl ||
    next.serverId !== cfg.serverId ||
    next.mdns !== cfg.mdns ||
    (next.mdnsPorts?.join(',') ?? '') !== (cfg.mdnsPorts?.join(',') ?? '');
  if (changed) await setSyncState(CONFIG_KEY, next);
  return { config: next, server };
}

/** Ports to try under the advertised name: pairing, last good, then learned. */
function knownPortsOf(config: SyncConfig): number[] {
  const found: number[] = [];
  const push = (value: number | null | undefined) => {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0 && !found.includes(value)) {
      found.push(value);
    }
  };
  push(portOf(config.serverUrl));
  push(portOf(config.lastUrl ?? ''));
  for (const port of config.mdnsPorts ?? []) push(port);
  return found;
}

/** Keeps a short, ordered history of ports: newest first, four at most. */
function rememberPorts(known: number[], learned: (string | undefined)[]): number[] {
  const next: number[] = [];
  const push = (value: number | null) => {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0 && !next.includes(value)) {
      next.push(value);
    }
  };
  for (const url of learned) push(url ? portOf(url) : null);
  for (const port of known) push(port);
  return next.slice(0, 4);
}

async function runSync(): Promise<SyncOutcome> {
  let config = await loadSyncConfig();
  if ((!config.serverUrl && !config.serverId) || !config.token) {
    await syncStatus.update({ phase: 'unconfigured', message: 'No pairing token configured' });
    return { ok: false, pushed: 0, pulled: 0, conflicts: 0, assets: 0, message: 'Not configured' };
  }
  if (!navigator.onLine) {
    await syncStatus.update({ phase: 'offline', message: 'Offline — changes are queued' });
    return { ok: false, pushed: 0, pulled: 0, conflicts: 0, assets: 0, message: 'Offline' };
  }

  const deviceId = await getDeviceId();
  // The saved address may be stale after a network change: find the server
  // again (mDNS name, then last known address, then the saved one) before
  // sending anything. Nothing in the outbox is touched while this happens.
  await syncStatus.update({ phase: 'searching', message: 'Searching for your laptop…' });
  const active = await resolveActiveServer(config);
  if (!active) {
    await syncStatus.update({
      phase: 'error',
      message: 'Nota is not answering on this network. Changes stay on this device until it is back.',
    });
    return { ok: false, pushed: 0, pulled: 0, conflicts: 0, assets: 0, message: 'Nota not found' };
  }
  config = active.config;
  const client = new SyncClient(active.server.url, config.token, deviceId);
  await syncStatus.update({ phase: 'syncing', message: 'Synchronising…' });

  let pushed = 0;
  let pulled = 0;
  let conflictCount = 0;
  let assets = 0;

  try {
    // 1. Push local changes in bounded batches. One record the laptop will
    // never accept is parked (see quarantine.ts) instead of stopping every
    // other change behind it.
    const blocked = await rehealQuarantine();
    const uploaded = new Set<string>();
    for (;;) {
      const batch = await nextOutboxBatch(blocked);
      if (batch.length === 0) break;
      const outcome = await pushBatch(client, batch, blocked, uploaded, deviceId);
      pushed += outcome.pushed;
      conflictCount += outcome.conflicts;
      assets += outcome.assets;
    }

    // 2. Pull remote changes since the stored cursor.
    let resynced = false;
    for (;;) {
      const cursor = await getSyncState<number>(CURSOR_KEY, 0);
      const changes = await client.changes(cursor);
      // A cursor above the laptop's own sequence means it was restored from a
      // backup or started over. Waiting for a higher number would leave the
      // pull dead for good, so the walk restarts from the first record.
      if (changes.cursor < cursor && !resynced) {
        resynced = true;
        await setSyncState(CURSOR_KEY, 0);
        continue;
      }
      for (const record of changes.records) {
        const outcome = await applyPulledRecord(record);
        pulled += outcome.applied ? 1 : 0;
        conflictCount += outcome.conflict ? 1 : 0;
      }
      await setSyncState(CURSOR_KEY, changes.cursor);
      if (!changes.hasMore) break;
      // A page that repeats itself would be walked forever.
      if (changes.records.length === 0 && changes.cursor === cursor) break;
    }

    // 3. Fetch asset bytes referenced by records that arrived without them.
    assets += await downloadMissingAssets(client, blocked);

    const parked = await loadQuarantine();
    await setSyncState('lastSyncAt', now());
    await syncStatus.update({
      phase: 'success',
      message: `Synced ${pushed} up · ${pulled} down${conflictCount ? ` · ${conflictCount} conflicts` : ''}${
        parked.length ? ` · ${parked.length} not accepted` : ''
      }`,
      lastSyncAt: now(),
      needsAttention: false,
      revoked: false,
    });
    syncStatus.bumpDataVersion();
    await refreshCounters();
    return {
      ok: true,
      pushed,
      pulled,
      conflicts: conflictCount,
      assets,
      message: syncStatus.getSnapshot().message,
    };
  } catch (error) {
    // A refusal describes the token that made it. When the token was replaced
    // while this attempt was in flight — pairing again, or adopting the
    // laptop's own app — that sentence is about a device that is no longer
    // here, and showing it would send the reader after a phantom.
    const current = await loadSyncConfig();
    if (
      current.token !== config.token &&
      error instanceof SyncError &&
      error.kind === 'auth'
    ) {
      await refreshCounters();
      return { ok: false, pushed, pulled, conflicts: conflictCount, assets, message: 'Pairing changed while syncing' };
    }
    const message =
      error instanceof SyncError
        ? error.code === 'revoked'
          ? // A removed device needs no token hunt: the laptop said what happened.
            error.message
          : error.kind === 'auth'
            ? 'Pairing token rejected — check the token on the Windows server'
            : error.message
        : error instanceof Error
          ? error.message
          : 'Unknown sync error';
    await syncStatus.update({
      phase: 'error',
      message,
      // A refused token is the one failure the reader has to fix themselves.
      needsAttention: error instanceof SyncError && error.kind === 'auth',
      revoked: error instanceof SyncError && error.code === 'revoked',
    });
    await refreshCounters();
    return { ok: false, pushed, pulled, conflicts: conflictCount, assets, message };
  }
}

interface PushOutcome {
  pushed: number;
  conflicts: number;
  assets: number;
}

/** The next changes to send, skipping the ones parked by an earlier refusal. */
async function nextOutboxBatch(blocked: Set<string>): Promise<OutboxEntry[]> {
  // Parked rows are skipped before the limit, so the batch is still full.
  const rows = await db.outbox.limit(MAX_BATCH + blocked.size).toArray();
  return rows.filter((entry) => !blocked.has(quarantineKey(entry.kind, entry.id))).slice(0, MAX_BATCH);
}

/**
 * Sends one batch. A refusal that cannot be fixed by retrying is narrowed down
 * by halving until one record is alone; that record is parked, and everything
 * else keeps going.
 */
async function pushBatch(
  client: SyncClient,
  batch: OutboxEntry[],
  blocked: Set<string>,
  uploaded: Set<string>,
  deviceId: string,
): Promise<PushOutcome> {
  const records = new Map<string, SyncRecord>();
  for (const entry of batch) {
    const key = quarantineKey(entry.kind, entry.id);
    if (records.has(key)) continue;
    const entity = await readEntity(entry.kind as SyncKind, entry.id);
    if (!entity) continue;
    let data: unknown = entity;
    if (entry.kind === 'asset') {
      const { blob: _blob, ...meta } = entity as unknown as StoredAsset;
      data = meta;
    }
    records.set(key, {
      kind: entry.kind as SyncKind,
      id: entity.id,
      data,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
      version: entity.version,
      deviceId: entity.deviceId || deviceId,
      deletedAt: entity.deletedAt,
    });
  }

  // Attachment bytes go first: if an upload fails, the queue entry survives
  // and the next run retries, instead of leaving a record without its file.
  const batchAssets = new Set(
    batch.filter((entry) => entry.kind === 'asset').map((entry) => entry.id),
  );
  const assets = await uploadAssets(client, batchAssets, blocked, uploaded);

  // A file the laptop refused is not advertised either: sending its metadata
  // would leave the laptop holding an entry for a blob it will never have.
  for (const id of batchAssets) {
    if (blocked.has(quarantineKey('asset', id))) records.delete(quarantineKey('asset', id));
  }

  if (records.size === 0) {
    await forgetOutbox(batch);
    return { pushed: 0, conflicts: 0, assets };
  }

  let response: PushResponse;
  try {
    response = await client.push([...records.values()]);
  } catch (error) {
    const status = error instanceof SyncError ? error.status : null;
    const plan = pushFailurePlan(batch.length, status);
    if (plan === 'retry-halves') {
      const half = Math.ceil(batch.length / 2);
      const first = await pushBatch(client, batch.slice(0, half), blocked, uploaded, deviceId);
      const second = await pushBatch(client, batch.slice(half), blocked, uploaded, deviceId);
      return {
        pushed: first.pushed + second.pushed,
        conflicts: first.conflicts + second.conflicts,
        assets: assets + first.assets + second.assets,
      };
    }
    if (plan === 'quarantine') {
      const entry = batch[0];
      if (!entry) throw error;
      const entity = await readEntity(entry.kind as SyncKind, entry.id);
      await parkEntry(
        entry.kind as SyncKind,
        entry.id,
        entity ? describeRecord(entry.kind as SyncKind, entity) : 'One change',
        error instanceof Error ? error.message : 'The laptop refused that change.',
      );
      blocked.add(quarantineKey(entry.kind, entry.id));
      return { pushed: 0, conflicts: 0, assets };
    }
    throw error;
  }

  for (const accepted of response.accepted) {
    const local = await readEntity(accepted.kind, accepted.id);
    if (!local) continue;
    if (local.version !== accepted.version || local.updatedAt !== accepted.updatedAt) {
      const table = tableForKind(accepted.kind) as unknown as {
        put: (value: unknown) => Promise<unknown>;
      };
      await table.put({ ...local, version: accepted.version, updatedAt: accepted.updatedAt });
    }
  }
  for (const conflict of response.conflicts) {
    await recordConflict({
      kind: conflict.kind,
      objectId: conflict.id,
      label: describeRecord(conflict.kind, conflict.client.data),
      local: withoutBlob(conflict.client.data),
      server: withoutBlob(conflict.server.data),
    });
    await applyIncoming(conflict.server);
    await clearOutboxFor(conflict.kind, conflict.id);
  }
  await forgetOutbox(batch);
  return { pushed: records.size, conflicts: response.conflicts.length, assets };
}

async function forgetOutbox(batch: OutboxEntry[]): Promise<void> {
  const seqs = batch
    .map((entry) => entry.seq)
    .filter((seq): seq is number => typeof seq === 'number');
  if (seqs.length > 0) await db.outbox.bulkDelete(seqs);
}

async function uploadAssets(
  client: SyncClient,
  assetIds: Set<string>,
  blocked: Set<string>,
  uploaded: Set<string>,
): Promise<number> {
  let count = 0;
  for (const id of assetIds) {
    const key = quarantineKey('asset', id);
    if (blocked.has(key) || uploaded.has(id)) continue;
    const asset = (await db.assets.get(id)) as StoredAsset | undefined;
    if (!asset?.blob) continue;
    try {
      await client.uploadAsset(id, asset.blob, asset.mime);
      uploaded.add(id);
      count += 1;
    } catch (error) {
      const status = error instanceof SyncError ? error.status : null;
      // One file the laptop will not take must not hold back the ink around
      // it: park the file and let the next sync send everything else.
      if (!isPermanentRefusal(status)) throw error;
      await parkEntry(
        'asset',
        id,
        describeRecord('asset', asset),
        error instanceof Error ? error.message : 'The laptop refused that file.',
      );
      blocked.add(key);
    }
  }
  return count;
}

async function downloadMissingAssets(client: SyncClient, blocked: Set<string>): Promise<number> {
  const assets = await db.assets.toArray();
  let count = 0;
  for (const asset of assets) {
    if (asset.deletedAt !== null) continue;
    if (asset.blob && asset.blob.size > 0) continue;
    // A file the laptop refused will not appear there on the next attempt.
    if (blocked.has(quarantineKey('asset', asset.id))) continue;
    try {
      const blob = await client.downloadAsset(asset.id);
      await db.assets.put({ ...asset, blob });
      count += 1;
    } catch {
      // Leave the record; the next sync retries the download.
    }
  }
  return count;
}

function tableForKind(kind: SyncKind) {
  switch (kind) {
    case 'folder':
      return db.folders;
    case 'notebook':
      return db.notebooks;
    case 'page':
      return db.pages;
    case 'stroke':
      return db.strokes;
    case 'text':
      return db.texts;
    case 'image':
      return db.images;
    case 'equation':
      return db.equations;
    case 'graph':
      return db.graphs;
    case 'table':
      return db.tableObjects;
    case 'asset':
      return db.assets;
  }
}

function describeRecord(kind: SyncKind, data: unknown): string {
  const entity = data as { title?: string; name?: string; text?: string; tool?: string };
  if (kind === 'notebook') return entity.title || 'Notebook';
  if (kind === 'folder') return entity.name || 'Folder';
  if (kind === 'page') return `Page ${entity.title || ''}`.trim();
  if (kind === 'stroke') return `Stroke (${entity.tool ?? 'ink'})`;
  if (kind === 'text') return 'Text block';
  if (kind === 'image') return 'Image placement';
  if (kind === 'equation') return 'Equation';
  if (kind === 'graph') return entity.title || 'Graph';
  if (kind === 'table') return 'Table';
  return 'Attachment';
}

interface PendingConflict {
  kind: SyncKind;
  objectId: string;
  label: string;
  local: unknown;
  server: unknown;
}

/**
 * One row per object and decision. A push that is retried after a lost response
 * would otherwise pile up identical conflicts the reader has to dismiss twice.
 */
async function recordConflict(entry: PendingConflict): Promise<void> {
  const existing = await db.conflicts
    .where('objectId')
    .equals(entry.objectId)
    .filter((row) => row.kind === entry.kind)
    .first();
  if (existing?.seq !== undefined) {
    await db.conflicts.update(existing.seq, {
      label: entry.label,
      local: entry.local,
      server: entry.server,
    });
    return;
  }
  await db.conflicts.add({ ...entry, createdAt: now() });
}

/** A pulled asset carries metadata only; the bytes stay wherever they already are. */
async function applyIncoming(record: SyncRecord): Promise<void> {
  if (record.kind !== 'asset') {
    await applyRemoteRecord(record);
    return;
  }
  const existing = (await db.assets.get(record.id)) as StoredAsset | undefined;
  const next = { ...(record.data as StoredAsset) };
  if (existing?.blob) next.blob = existing.blob;
  await db.assets.put(next);
}

function withoutBlob(entity: unknown): unknown {
  if (entity && typeof entity === 'object' && 'blob' in (entity as Record<string, unknown>)) {
    const { blob: _blob, ...rest } = entity as Record<string, unknown>;
    return rest;
  }
  return entity;
}

async function applyPulledRecord(record: SyncRecord): Promise<{ applied: boolean; conflict: boolean }> {
  const local = await readEntity(record.kind, record.id);
  if (!local) {
    await applyIncoming(record);
    return { applied: true, conflict: false };
  }
  if (sameJson(withoutBlob(local), record.data)) {
    await clearOutboxFor(record.kind, record.id);
    return { applied: false, conflict: false };
  }
  const queued = await db.outbox.where('[kind+id]').equals([record.kind, record.id]).count();
  if (queued > 0) {
    await recordConflict({
      kind: record.kind,
      objectId: record.id,
      label: describeRecord(record.kind, record.data),
      local: withoutBlob(local),
      server: withoutBlob(record.data),
    });
    await applyIncoming(record);
    await clearOutboxFor(record.kind, record.id);
    return { applied: true, conflict: true };
  }
  if (record.updatedAt >= local.updatedAt) {
    await applyIncoming(record);
    return { applied: true, conflict: false };
  }
  await markOutbox(record.kind, record.id);
  return { applied: false, conflict: false };
}

/** Order-independent comparison: JSON key order differs between devices. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

function sameJson(local: unknown, incoming: unknown): boolean {
  return stableStringify(local) === stableStringify(incoming);
}

let listenersBound = false;
let failures = 0;
let timer: number | null = null;

/** One pending attempt at a time; a new schedule replaces the old one. */
function schedule(delay: number): void {
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    void tick();
  }, delay);
}

async function tick(): Promise<void> {
  const config = await loadSyncConfig();
  if (!config.autoSync || (!config.serverUrl && !config.serverId) || !config.token) {
    schedule(SYNC_INTERVAL_MS);
    return;
  }
  // While the iPad is offline there is nothing to try: keep the normal rhythm
  // so a missed `online` event still recovers within a minute.
  if (!navigator.onLine) {
    schedule(SYNC_INTERVAL_MS);
    return;
  }
  const pending = await pendingCount();
  if (document.visibilityState === 'hidden' && pending === 0) {
    schedule(SYNC_INTERVAL_MS);
    return;
  }
  const outcome = await syncNow();
  failures = outcome.ok ? 0 : failures + 1;
  schedule(retryDelay(failures));
}

export function startAutoSync(): void {
  if (listenersBound) return;
  listenersBound = true;
  schedule(4000);
  // Regaining a connection or returning to the app deserves an early attempt,
  // not a wait for the current backoff to run out.
  window.addEventListener('online', () => {
    failures = 0;
    schedule(1200);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') schedule(900);
  });
}

export async function resolveConflict(seq: number, strategy: 'keep-local' | 'keep-server'): Promise<void> {
  const conflict = await db.conflicts.get(seq);
  if (!conflict) return;
  if (strategy === 'keep-local') {
    const local = conflict.local as { updatedAt?: number };
    const record: SyncRecord = {
      kind: conflict.kind as SyncKind,
      id: conflict.objectId,
      data: local,
      createdAt: 0,
      updatedAt: Math.max(now(), (local.updatedAt ?? 0) + 1),
      version: 1,
      deviceId: await getDeviceId(),
      deletedAt: null,
    };
    const localData = { ...(conflict.local as Record<string, unknown>), updatedAt: record.updatedAt };
    await applyRemoteRecord({ ...record, data: localData });
    await markOutbox(conflict.kind as SyncKind, conflict.objectId);
  }
  await db.conflicts.delete(seq);
  // The page may still hold the losing copy: this is what asks it to reload.
  syncStatus.bumpDataVersion();
  await refreshCounters();
}
