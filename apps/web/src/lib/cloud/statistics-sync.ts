import type { BooksDbStatistic } from '$lib/data/database/books-db/versions/books-db';
import { getCloudBookLinks, getCloudLinkByLocalBookId } from './book-links';
import { getConfiguredCloudApi } from './progress-session';
import { getOrCreateDeviceId } from './progress-sync';
import type { CloudStatisticRow, CloudStatisticSnapshotInput } from './types';

function snapshotFromStatistic(statistic: BooksDbStatistic): CloudStatisticSnapshotInput {
  return {
    dateKey: statistic.dateKey,
    readingTime: Math.max(0, Number(statistic.readingTime) || 0),
    charactersRead: Math.max(0, Number(statistic.charactersRead) || 0),
    minReadingSpeed: Math.max(0, Number(statistic.minReadingSpeed) || 0),
    altMinReadingSpeed: Math.max(0, Number(statistic.altMinReadingSpeed) || 0),
    lastReadingSpeed: Math.max(0, Number(statistic.lastReadingSpeed) || 0),
    maxReadingSpeed: Math.max(0, Number(statistic.maxReadingSpeed) || 0),
    lastStatisticModified: Number(statistic.lastStatisticModified) || Date.now(),
    ...(statistic.completedBook ? { completedBook: statistic.completedBook } : {}),
    ...(statistic.completedData ? { completedData: statistic.completedData } : {})
  };
}

export async function syncCloudStatisticSnapshots(
  localBookId: number,
  title: string,
  statistics: BooksDbStatistic[]
): Promise<void> {
  if (!statistics.length || !Number.isInteger(localBookId)) return;
  const link = getCloudLinkByLocalBookId(localBookId);
  const api = getConfiguredCloudApi();
  if (!link || !api) return;

  await api.putStatisticSnapshots(
    link.cloudBookId,
    getOrCreateDeviceId(),
    title,
    statistics.map(snapshotFromStatistic)
  );
}

async function pushLocalCloudStatistics(localStatistics: BooksDbStatistic[]): Promise<void> {
  const api = getConfiguredCloudApi();
  if (!api) return;

  // Absolute per-device snapshots are idempotent, so refreshing Statistics can
  // safely push this device's local rows first. This also migrates pre-cloud
  // history and closes the race with a final reader save before we fetch the
  // cross-device aggregate.
  const links = getCloudBookLinks();
  const deviceId = getOrCreateDeviceId();
  for (const link of links) {
    const rows = localStatistics.filter((entry) => entry.title === link.title);
    if (!rows.length) continue;
    await api.putStatisticSnapshots(
      link.cloudBookId,
      deviceId,
      link.title,
      rows.map(snapshotFromStatistic)
    );
  }
}


function toBooksDbStatistics(rows: CloudStatisticRow[]): BooksDbStatistic[] {
  const merged = new Map<string, BooksDbStatistic>();
  for (const row of rows) {
    const key = `${row.title}\u0000${row.dateKey}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        title: row.title,
        dateKey: row.dateKey,
        readingTime: Math.max(0, row.readingTime),
        charactersRead: Math.max(0, row.charactersRead),
        minReadingSpeed: Math.max(0, row.minReadingSpeed),
        altMinReadingSpeed: Math.max(0, row.altMinReadingSpeed),
        lastReadingSpeed: Math.max(0, row.lastReadingSpeed),
        maxReadingSpeed: Math.max(0, row.maxReadingSpeed),
        lastStatisticModified: row.lastStatisticModified,
        ...(row.completedBook ? { completedBook: row.completedBook } : {}),
        ...(row.completedData ? { completedData: row.completedData as any } : {})
      });
      continue;
    }

    existing.readingTime += Math.max(0, row.readingTime);
    existing.charactersRead += Math.max(0, row.charactersRead);
    existing.lastReadingSpeed = existing.readingTime
      ? Math.ceil((3600 * existing.charactersRead) / existing.readingTime)
      : 0;
    const rowMin = Math.max(0, row.minReadingSpeed);
    if (rowMin) existing.minReadingSpeed = existing.minReadingSpeed
      ? Math.min(existing.minReadingSpeed, rowMin)
      : rowMin;
    const rowAltMin = Math.max(0, row.altMinReadingSpeed);
    if (rowAltMin) existing.altMinReadingSpeed = existing.altMinReadingSpeed
      ? Math.min(existing.altMinReadingSpeed, rowAltMin)
      : rowAltMin;
    existing.maxReadingSpeed = Math.max(existing.maxReadingSpeed, row.maxReadingSpeed || 0);
    if (row.lastStatisticModified >= existing.lastStatisticModified) {
      existing.lastStatisticModified = row.lastStatisticModified;
      if (row.completedData) existing.completedData = row.completedData as any;
    }
    if (row.completedBook) existing.completedBook = 1;
  }
  return [...merged.values()];
}

/**
 * Cloud statistics are canonical for cloud-library titles. Local Ttsu statistics
 * remain available for non-cloud titles and as an offline fallback.
 */
export async function mergeCloudStatistics(
  localStatistics: BooksDbStatistic[]
): Promise<BooksDbStatistic[]> {
  const api = getConfiguredCloudApi();
  if (!api) return localStatistics;

  try {
    await pushLocalCloudStatistics(localStatistics);
    const [library, cloudRows] = await Promise.all([api.getLibrary(), api.getStatistics()]);
    const cloudTitles = new Set(library.books.map((book) => book.title));
    const localOnly = localStatistics.filter((entry) => !cloudTitles.has(entry.title));
    return [...localOnly, ...toBooksDbStatistics(cloudRows)];
  } catch (error) {
    console.warn('Cloud statistics unavailable; using local statistics', error);
    return localStatistics;
  }
}
