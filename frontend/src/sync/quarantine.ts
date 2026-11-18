import type { SyncKind } from '../storage/types';

/**
 * One change the laptop refused, parked here instead of blocking the queue.
 *
 * The outbox is an ordered queue: a single record the server will never accept
 * (a payload above its limit, a field it does not know) used to fail the push
 * forever, so every note written after it stayed on the iPad. Parking the
 * offender keeps the rest moving, and the reason stays readable.
 */
export interface QuarantineEntry {
  kind: SyncKind;
  id: string;
  label: string;
  reason: string;
  /** When it was refused; an edit later than this is worth trying again. */
  at: number;
}

export function quarantineKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

/**
 * A refusal that will never turn into an acceptance on retry: the payload is
 * malformed, too large, or no longer fits what this server version validates.
 * Network trouble, a rate limit and a server error are all worth retrying.
 */
export function isPermanentRefusal(status: number | null): boolean {
  return status === 400 || status === 413 || status === 422;
}

export type PushFailurePlan = 'retry-halves' | 'quarantine' | 'abort';

/**
 * What to do with a refused push. A batch is halved until the offending record
 * is alone, so the cost of finding it is a few requests, and a single refused
 * record is set aside rather than dropped.
 */
export function pushFailurePlan(entryCount: number, status: number | null): PushFailurePlan {
  if (!isPermanentRefusal(status)) return 'abort';
  return entryCount > 1 ? 'retry-halves' : 'quarantine';
}

/** Whether a parked entry still describes the object as it is now. */
export function stillParked(entry: QuarantineEntry, updatedAt: number): boolean {
  return updatedAt <= entry.at;
}

/** A line the sync screen can show: what was refused, and why. */
export function describeParked(entries: QuarantineEntry[]): string {
  const first = entries[0];
  if (!first) return '';
  const rest = entries.length - 1;
  const line = `${first.label}: ${first.reason}`;
  return rest > 0 ? `${first.label} (and ${rest} more): ${first.reason}` : line;
}
