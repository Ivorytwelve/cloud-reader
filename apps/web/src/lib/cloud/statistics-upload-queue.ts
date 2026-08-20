import type { CloudStatisticSnapshot } from './types';

export const CLOUD_STAT_CONTRIBUTIONS_KEY = 'ttu-cloud-stat-contributions-v1';
export const CLOUD_STAT_DIRTY_KEY = 'ttu-cloud-stat-dirty-v2';

export interface CloudStatisticContributionMap {
  [key: string]: CloudStatisticSnapshot;
}

interface DirtyMap {
  [key: string]: string;
}

export interface DirtyStatisticSnapshot {
  key: string;
  fingerprint: string;
  snapshot: CloudStatisticSnapshot;
}

export function cloudStatisticSnapshotKey(bookId: string, dateKey: string): string {
  return `${bookId}\u0000${dateKey}`;
}

export function loadCloudStatisticContributions(
  storage: Storage = localStorage
): CloudStatisticContributionMap {
  return readJson<CloudStatisticContributionMap>(storage, CLOUD_STAT_CONTRIBUTIONS_KEY, {});
}

export function saveCloudStatisticContributions(
  value: CloudStatisticContributionMap,
  storage: Storage = localStorage
): void {
  storage.setItem(CLOUD_STAT_CONTRIBUTIONS_KEY, JSON.stringify(value));
}

/**
 * Persist the fact that a particular cumulative per-device snapshot changed.
 *
 * Older Cloud Reader versions did not have this queue and re-uploaded every
 * historical snapshot on every flush. Starting with an empty dirty map is
 * intentional: existing cumulative snapshots are treated as already synced,
 * and the next local delta for a date writes the complete current snapshot.
 */
export function markCloudStatisticDirty(
  key: string,
  snapshot: CloudStatisticSnapshot,
  storage: Storage = localStorage
): void {
  const dirty = loadDirtyMap(storage);
  dirty[key] = cloudStatisticFingerprint(snapshot);
  saveDirtyMap(dirty, storage);
}

export function getDirtyCloudStatisticSnapshots(
  storage: Storage = localStorage
): DirtyStatisticSnapshot[] {
  const contributions = loadCloudStatisticContributions(storage);
  const dirty = loadDirtyMap(storage);
  const result: DirtyStatisticSnapshot[] = [];
  let dirtyChanged = false;

  for (const [key, queuedFingerprint] of Object.entries(dirty)) {
    const snapshot = contributions[key];
    if (!snapshot) {
      delete dirty[key];
      dirtyChanged = true;
      continue;
    }

    const fingerprint = cloudStatisticFingerprint(snapshot);
    if (queuedFingerprint !== fingerprint) {
      dirty[key] = fingerprint;
      dirtyChanged = true;
    }
    result.push({ key, fingerprint, snapshot });
  }

  if (dirtyChanged) saveDirtyMap(dirty, storage);
  return result;
}

/**
 * Acknowledge only the exact revision that was sent. If another reading delta
 * landed while the request was in flight, its newer fingerprint remains dirty.
 */
export function acknowledgeCloudStatisticSnapshot(
  key: string,
  sentFingerprint: string,
  storage: Storage = localStorage
): boolean {
  const contributions = loadCloudStatisticContributions(storage);
  const dirty = loadDirtyMap(storage);
  const latest = contributions[key];

  if (!latest || dirty[key] !== sentFingerprint) return false;
  if (cloudStatisticFingerprint(latest) !== sentFingerprint) return false;

  delete dirty[key];
  saveDirtyMap(dirty, storage);
  return true;
}

export function hasDirtyCloudStatistics(storage: Storage = localStorage): boolean {
  return Object.keys(loadDirtyMap(storage)).length > 0;
}

export function discardCloudStatisticSnapshot(
  key: string,
  storage: Storage = localStorage
): void {
  const contributions = loadCloudStatisticContributions(storage);
  const dirty = loadDirtyMap(storage);
  let changed = false;

  if (key in contributions) {
    delete contributions[key];
    saveCloudStatisticContributions(contributions, storage);
    changed = true;
  }
  if (key in dirty) {
    delete dirty[key];
    changed = true;
  }
  if (changed) saveDirtyMap(dirty, storage);
}

export function cloudStatisticFingerprint(snapshot: CloudStatisticSnapshot): string {
  // JSON.stringify is deterministic for this object because all snapshots are
  // produced by our own literal construction with stable property order.
  return JSON.stringify(snapshot);
}

function loadDirtyMap(storage: Storage): DirtyMap {
  return readJson<DirtyMap>(storage, CLOUD_STAT_DIRTY_KEY, {});
}

function saveDirtyMap(value: DirtyMap, storage: Storage): void {
  storage.setItem(CLOUD_STAT_DIRTY_KEY, JSON.stringify(value));
}

function readJson<T>(storage: Storage, key: string, fallback: T): T {
  try {
    const raw = storage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
