import type { BooksDbStatistic } from '$lib/data/database/books-db/versions/books-db';
import { database } from '$lib/data/store';
import { MergeMode } from '$lib/data/merge-mode';
import { ReplicationSaveBehavior } from '$lib/functions/replication/replication-options';
import { getConfiguredCloudApi } from './progress-session';
import { getOrCreateDeviceId } from './progress-sync';
import type { CloudStatisticAggregate, CloudStatisticSnapshot } from './types';

const CONTRIBUTIONS_KEY = 'ttu-cloud-stat-contributions-v1';
const pendingUploads = new Map<string, Promise<void>>();
let uploadTimer: ReturnType<typeof setTimeout> | undefined;

interface ContributionMap {
  [key: string]: CloudStatisticSnapshot;
}

function loadContributions(storage: Storage = localStorage): ContributionMap {
  try {
    return JSON.parse(storage.getItem(CONTRIBUTIONS_KEY) || '{}') as ContributionMap;
  } catch {
    return {};
  }
}

function saveContributions(value: ContributionMap, storage: Storage = localStorage) {
  storage.setItem(CONTRIBUTIONS_KEY, JSON.stringify(value));
}

function snapshotKey(bookId: string, dateKey: string) {
  return `${bookId}\u0000${dateKey}`;
}

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
  const key = snapshotKey(input.bookId, input.dateKey);
  const map = loadContributions();
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
  saveContributions(map);
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

export function scheduleCloudStatisticFlush(delay = 900) {
  if (typeof window === 'undefined') return;
  if (uploadTimer) clearTimeout(uploadTimer);
  uploadTimer = setTimeout(() => {
    uploadTimer = undefined;
    void flushPendingCloudStatistics();
  }, delay);
}

export async function flushPendingCloudStatistics(): Promise<void> {
  if (typeof localStorage === 'undefined') return;
  const api = getConfiguredCloudApi();
  if (!api) return;

  const contributions = loadContributions();
  const snapshots = Object.values(contributions);
  for (const snapshot of snapshots) {
    const key = snapshotKey(snapshot.bookId, snapshot.dateKey);
    const previous = pendingUploads.get(key) || Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(async () => {
        const latest = loadContributions()[key];
        if (!latest) return;
        await api.putStatisticSnapshot(latest);
      })
      .finally(() => {
        if (pendingUploads.get(key) === task) pendingUploads.delete(key);
      });
    pendingUploads.set(key, task);
  }
  await Promise.allSettled([...pendingUploads.values()]);
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

  await Promise.all(
    [...byTitle.entries()].map(([title, statistics]) =>
      database.storeStatistics(
        title,
        statistics,
        ReplicationSaveBehavior.Overwrite,
        MergeMode.REPLACE
      )
    )
  );
  return cloudStats;
}
