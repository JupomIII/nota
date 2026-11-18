import type { SyncKind, SyncRecord } from '../storage/types';

export interface PushRequest {
  deviceId: string;
  records: SyncRecord[];
}

export interface PushResponse {
  accepted: { kind: SyncKind; id: string; version: number; updatedAt: number }[];
  conflicts: { kind: SyncKind; id: string; server: SyncRecord; client: SyncRecord }[];
  cursor: number;
  serverTime: number;
}

export interface ChangesResponse {
  records: SyncRecord[];
  cursor: number;
  hasMore: boolean;
}

export interface HealthResponse {
  ok: boolean;
  name: string;
  version: number;
  deviceName: string;
  time: number;
  /** Where the laptop opens the app; absent from servers older than this build. */
  laptopUrl?: string;
  /** Identity that survives an address change; absent on older servers. */
  serverId?: string;
  /** The mDNS name the laptop advertises, e.g. nota.local. */
  hostname?: string;
  /** That name with the port it really listens on, custom ports included. */
  mdnsUrl?: string;
  /** False when the laptop advertises no local name (trusted address). */
  mdns?: boolean;
}

export interface PairResponse {
  token: string;
  serverUrl: string;
  deviceName: string;
  /** Whether the laptop also answers under nota.local; absent on older servers. */
  mdns?: boolean;
  /** The five-character code the laptop shows too; empty from older servers. */
  code?: string;
}

export interface DiscoveryReport {
  state: string;
  detail: string;
  hostname: string;
  url: string;
  service: string;
  addresses: string[];
}

export interface ServerStatus {
  deviceName: string;
  counts: Record<string, number>;
  conflicts: number;
  cursor: number;
  devices: string[];
  dataDir: string;
  tls: boolean;
  baseUrl: string;
  laptopUrl?: string;
  serverId?: string;
  hostname?: string;
  mdnsUrl?: string;
  mdns?: boolean;
  discovery?: DiscoveryReport;
}

export interface BackupInfo {
  name: string;
  size: number;
  createdAt: number;
}

export interface ImportResult {
  ok: boolean;
  inserted: number;
  updated: number;
  skipped: number;
  assets: number;
  errors: string[];
}

export const MAX_BATCH = 200;
