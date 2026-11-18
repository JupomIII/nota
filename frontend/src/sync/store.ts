export interface SyncStatus {
  phase: 'idle' | 'searching' | 'syncing' | 'success' | 'error' | 'offline' | 'unconfigured';
  message: string;
  lastSyncAt: number | null;
  pending: number;
  conflicts: number;
  /** Changes the laptop refused and this device is holding back. */
  stuck: number;
  /** The first refused change, in one readable line. */
  stuckNote: string;
  online: boolean;
  dataVersion: number;
  /** The token was refused (or pairing was lost): the reader has to act. */
  needsAttention: boolean;
  /**
   * This device was removed on the laptop, which is not a bad token and has
   * one fix: pair it again. Kept apart so the screen never sends the reader
   * hunting for a token file that is perfectly fine.
   */
  revoked: boolean;
}

const initial: SyncStatus = {
  phase: 'unconfigured',
  message: 'No sync server configured',
  lastSyncAt: null,
  pending: 0,
  conflicts: 0,
  stuck: 0,
  stuckNote: '',
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  dataVersion: 0,
  needsAttention: false,
  revoked: false,
};

let state: SyncStatus = initial;
const listeners = new Set<() => void>();

export const syncStatus = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  getSnapshot(): SyncStatus {
    return state;
  },
  update(patch: Partial<SyncStatus>): void {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  },
  bumpDataVersion(): void {
    this.update({ dataVersion: state.dataVersion + 1 });
  },
};

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => syncStatus.update({ online: true }));
  window.addEventListener('offline', () => syncStatus.update({ online: false }));
}
