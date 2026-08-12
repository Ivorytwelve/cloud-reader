import type { BooksDbStatistic } from '$lib/data/database/books-db/versions/books-db';
import { database } from '$lib/data/store';
import { MergeMode } from '$lib/data/merge-mode';
import { ReplicationSaveBehavior } from '$lib/functions/replication/replication-options';
import { CloudApiError } from './api';
import { getConfiguredCloudApi } from './progress-session';
import { getOrCreateDeviceId } from './progress-sync';
import type { CloudStatisticAggregate, CloudStatisticSnapshot } from './types';
import {
  acknowledgeCloudStatisticSnapshot,
  cloudStatisticSnapshotKey,
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
  completedData?: CloudStatisticSnapshot['completedData'];
}) {
  if (typeof localStorage === 'undefined') return;
  const api = getConfiguredCloudApi();
  if (!api || !input.bookId || !input.dateKey) return;

  const deviceId = getOrCreateDeviceId();
  const key = cloudStatisticSnapshotKey(input.bookId, input.dateKey);
  const map = loadCloudStatisticContributions();
  const old = map[key];
  const next: CloudStatisticSnapshot = {
    version: 1,
    deviceId,
    bookId: input.bookId,
    title: input.title,
    dateKey: input.dateKey,
    // Contributions are intentionally not clamped here. A rewind/undo on one
    // device must be able to subtract from progress accumulated elsewhere.
    readingTime: (old?.readingTime || 0) + (Number(input.readingTimeDelta) || 0),
    charactersRead: (old?.charactersRead || 0) + (Number(input.characterDelta) || 0),
    lastStatisticModified: Date.now(),
    completedBook: input.completedBook || old?.completedBook,
    completedData: input.completedData || old?.completedData
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
        // Keep the exact cumulative snapshot dirty. In particular, stop after a
        // 429 instead of hammering the Worker with every historical row.
        if (isRetryableStatisticUploadError(error)) {
          followupDelay = CLOUD_STAT_RETRY_DELAY_MS;
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
      if (followupDelay === CLOUD_STAT_RETRY_DELAY_MS) scheduleCloudStatisticRetry(followupDelay);
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
 * Pull the canonical cloud aggregate into Ttsu's local statistics DB so the
 * existing Statistics UI can stay unchanged. The local DB is a display/cache;
 * cloud uploads are generated from the separate per-device contribution map.
 */
export async function syncCloudStatisticsToLocal(): Promise<CloudStatisticAggregate[]> {
  const api = getConfiguredCloudApi();
  if (!api) return [];

  await flushPendingCloudStatistics().catch(() => undefined);
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
