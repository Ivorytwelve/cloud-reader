import type { BooksDbStatistic } from '$lib/data/database/books-db/versions/books-db';
import { database } from '$lib/data/store';
import { MergeMode } from '$lib/data/merge-mode';
import { ReplicationSaveBehavior } from '$lib/functions/replication/replication-options';
import { CloudApiError } from './api';
import { getConfiguredCloudApi } from './progress-session';
import { getCloudWriteRetryDelayMs } from './cloud-write-throttle';
import { getOrCreateDeviceId } from './progress-sync';
import type { CloudStatisticAggregate, CloudStatisticSnapshot } from './types';
import {
  acknowledgeCloudStatisticSnapshot,
  cloudStatisticSnapshotKey,
  discardCloudStatisticSnapshot,
  getDirtyCloudStatisticSnapshots,
  hasDirtyCloudStatistics,
  loadCloudStatisticContributions,
  markCloudStatisticDirty,
  saveCloudStatisticContributions
} from './statistics-upload-queue';

const CLOUD_STATS_TITLES_KEY = 'ttu-cloud-stat-titles-v1';
const CLOUD_STAT_FLUSH_DELAY_MS = 15_000;
const CLOUD_STAT_RETRY_DELAY_MS = 60_000;
let uploadTimer: ReturnType<typeof setTimeout> | undefined;
let flushInFlight: Promise<void> | undefined;

export function recordCloudStatisticDelta(input: {
  bookId: string;
  title: string;
  dateKey: string;
  readingTimeDelta?: number;
  characterDelta?: number;
  completedBook?: number;
  clearCompletion?: boolean;
  completedData?: CloudStatisticSnapshot['completedData'];
}) {
  if (typeof localStorage === 'undefined') return;
  const api = getConfiguredCloudApi();
  if (!api || !input.bookId || !input.dateKey) return;

  const deviceId = getOrCreateDeviceId();
  const key = cloudStatisticSnapshotKey(input.bookId, input.dateKey);
  const map = loadCloudStatisticContributions();
  const old = map[key];
  const clearingCompletion = Boolean(input.clearCompletion);
  const settingCompletion = Boolean(input.completedBook || input.completedData);
  const next: CloudStatisticSnapshot = {
    version: 1,
    deviceId,
    bookId: input.bookId,
    title: input.title,
    dateKey: input.dateKey,
    // A device may undo its own recent progress, but it must never create
    // a negative contribution that subtracts statistics belonging to another
    // device when the Worker sums snapshots.
    readingTime: Math.max(0, (old?.readingTime || 0) + (Number(input.readingTimeDelta) || 0)),
    charactersRead: Math.max(0, (old?.charactersRead || 0) + (Number(input.characterDelta) || 0)),
    lastStatisticModified: Date.now(),
    ...(clearingCompletion
      ? { clearCompletion: true }
      : settingCompletion
        ? { completedBook: input.completedBook || 1, completedData: input.completedData }
        : {
            ...(old?.completedBook ? { completedBook: old.completedBook } : {}),
            ...(old?.clearCompletion ? { clearCompletion: true } : {}),
            ...(old?.completedData ? { completedData: old.completedData } : {})
          })
  };
  map[key] = next;
  saveCloudStatisticContributions(map);
  markCloudStatisticDirty(key, next);
  scheduleCloudStatisticFlush();
}

export function recordCloudCompletion(input: {
  bookId: string;
  title: string;
  dateKey: string;
  completedData: CloudStatisticSnapshot['completedData'];
}) {
  recordCloudStatisticDelta({ ...input, completedBook: 1 });
}

export function clearCloudCompletion(input: {
  bookId: string;
  title: string;
  dateKey: string;
}) {
  recordCloudStatisticDelta({ ...input, clearCompletion: true });
}

export function scheduleCloudStatisticFlush(delay = CLOUD_STAT_FLUSH_DELAY_MS) {
  if (typeof window === 'undefined' || uploadTimer) return;
  setCloudStatisticFlushTimer(delay);
}

function scheduleCloudStatisticRetry(delay = CLOUD_STAT_RETRY_DELAY_MS) {
  if (typeof window === 'undefined') return;
  // A 429/backoff must replace a shorter normal flush timer that may have been
  // scheduled by a delta arriving while the rejected request was in flight.
  if (uploadTimer) clearTimeout(uploadTimer);
  setCloudStatisticFlushTimer(delay);
}

function setCloudStatisticFlushTimer(delay: number) {
  uploadTimer = setTimeout(() => {
    uploadTimer = undefined;
    void flushPendingCloudStatistics().catch(() => undefined);
  }, delay);
}

export async function flushPendingCloudStatistics(): Promise<void> {
  if (typeof localStorage === 'undefined') return;
  if (flushInFlight) return flushInFlight;

  const api = getConfiguredCloudApi();
  if (!api) return;

  let followupDelay: number | undefined;
  flushInFlight = (async () => {
    const dirtySnapshots = getDirtyCloudStatisticSnapshots();
    for (const { key, fingerprint, snapshot } of dirtySnapshots) {
      try {
        await api.putStatisticSnapshot(snapshot);
        acknowledgeCloudStatisticSnapshot(key, fingerprint);
      } catch (error) {
        // A deleted cloud book can leave an old local dirty snapshot behind. It
        // can never be accepted (the Worker requires the book to exist), so do
        // not let that dead item block every newer book's statistics forever.
        if (error instanceof CloudApiError && error.status === 404) {
          discardCloudStatisticSnapshot(key);
          continue;
        }

        // Keep the exact cumulative snapshot dirty. In particular, stop after a
        // 429 instead of hammering the Worker with every historical row.
        if (isRetryableStatisticUploadError(error)) {
          // A shared 429 breaker may be much longer than the normal transient
          // retry (for example the daily write cap). Respect it so statistics
          // do not wake up every minute just to be rejected locally.
          followupDelay = Math.max(CLOUD_STAT_RETRY_DELAY_MS, getCloudWriteRetryDelayMs());
        }
        throw error;
      }
    }

    // A new delta may have arrived while the last request was in flight. It is
    // still dirty, but should use the normal coalescing delay rather than the
    // failure backoff.
    if (hasDirtyCloudStatistics()) followupDelay = CLOUD_STAT_FLUSH_DELAY_MS;
  })().finally(() => {
    flushInFlight = undefined;
    if (followupDelay !== undefined && hasDirtyCloudStatistics()) {
      if (followupDelay >= CLOUD_STAT_RETRY_DELAY_MS) scheduleCloudStatisticRetry(followupDelay);
      else scheduleCloudStatisticFlush(followupDelay);
    }
  });

  return flushInFlight;
}

function isRetryableStatisticUploadError(error: unknown): boolean {
  if (!(error instanceof CloudApiError)) return true;
  return error.status === 408 || error.status === 429 || error.status >= 500;
}

function toBooksDbStatistic(stat: CloudStatisticAggregate): BooksDbStatistic {
  return {
    title: stat.title,
    dateKey: stat.dateKey,
    charactersRead: Math.max(0, Math.round(stat.charactersRead)),
    readingTime: Math.max(0, stat.readingTime),
    minReadingSpeed: Math.max(0, stat.minReadingSpeed),
    altMinReadingSpeed: Math.max(0, stat.altMinReadingSpeed),
    lastReadingSpeed: Math.max(0, stat.lastReadingSpeed),
    maxReadingSpeed: Math.max(0, stat.maxReadingSpeed),
    lastStatisticModified: stat.lastStatisticModified || Date.now(),
    ...(stat.completedBook ? { completedBook: 1 } : {}),
    ...(stat.completedData ? { completedData: stat.completedData } : {})
  };
}

/**
 * Delete canonical cloud statistic rows matching the same title/date semantics
 * used by the legacy Statistics UI. The cloud is canonical for cloud books, so
 * deleting only IndexedDB would make the row reappear on the next cloud sync.
 *
 * Pending local contribution snapshots are flushed first. Otherwise a dirty
 * snapshot that predates the deletion could upload afterward and partially
 * resurrect data that the user just deleted.
 */
export async function deleteCloudStatisticEntries(
  titles: Iterable<string>,
  startDate = '',
  endDate = ''
): Promise<number> {
  const api = getConfiguredCloudApi();
  if (!api) return 0;

  await flushPendingCloudStatistics();

  const titleSet = new Set(titles);
  if (!titleSet.size) return 0;

  const cloudStats = await api.getStatistics();
  const matching = cloudStats.filter((entry) => {
    if (!titleSet.has(entry.title)) return false;
    if (startDate && entry.dateKey < startDate) return false;
    if (endDate && entry.dateKey > endDate) return false;
    return true;
  });

  let deleted = 0;
  for (const entry of matching) {
    try {
      await api.deleteStatisticEntry(entry.bookId, entry.dateKey);
      deleted += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Cloud statistics deletion stopped after ${deleted}/${matching.length} entr${deleted === 1 ? 'y' : 'ies'}: ${message}`
      );
    }
  }

  return deleted;
}

/**
 * Pull the canonical cloud aggregate into Ttsu's local statistics DB so the
 * existing Statistics UI can stay unchanged. The local DB is a display/cache;
 * cloud uploads are generated from the separate per-device contribution map.
 */
export async function syncCloudStatisticsToLocal(): Promise<CloudStatisticAggregate[]> {
  const api = getConfiguredCloudApi();
  if (!api) return [];

  // Never replace the IndexedDB cache with an older cloud snapshot when
  // this device still has unsaved statistics. If the flush fails, propagate the
  // error and let the Statistics page keep showing its local cache.
  await flushPendingCloudStatistics();
  const cloudStats = await api.getStatistics();
  const byTitle = new Map<string, BooksDbStatistic[]>();
  for (const stat of cloudStats) {
    const list = byTitle.get(stat.title) || [];
    list.push(toBooksDbStatistic(stat));
    byTitle.set(stat.title, list);
  }

  let previousTitles: string[] = [];
  if (typeof localStorage !== 'undefined') {
    try {
      previousTitles = JSON.parse(localStorage.getItem(CLOUD_STATS_TITLES_KEY) || '[]') as string[];
    } catch {
      previousTitles = [];
    }
  }

  const allTitles = new Set([...previousTitles, ...byTitle.keys()]);
  await Promise.all(
    [...allTitles].map((title) =>
      database.storeStatistics(
        title,
        byTitle.get(title) || [],
        ReplicationSaveBehavior.Overwrite,
        MergeMode.REPLACE
      )
    )
  );

  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(CLOUD_STATS_TITLES_KEY, JSON.stringify([...byTitle.keys()]));
  }
  return cloudStats;
}
