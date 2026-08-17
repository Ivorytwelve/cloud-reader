/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

export type AssetKind = 'epub' | 'audio' | 'subtitles' | 'cover' | 'audioCover' | 'alignment';
export type CloudBookShelf = 'library' | 'history';
import type { CloudListeningSettings, IllustrationTimelineEntry } from '$lib/listening-mode/types';

export interface BookAsset {
  kind: AssetKind;
  fileName: string;
  contentType: string;
  size: number;
  etag?: string;
}

export interface AudioChapter {
  key: string;
  label: string;
  startSeconds: number;
  startText?: string;
}

export interface CloudAlignmentInfo {
  version: 1;
  source: 'auto' | 'manual';
  matchedBy: string;
  matchedOn: number;
  matchedLines: number;
  totalLines: number;
  diffLines: number;
  rate: number;
  /** Inferred once from the aligned EPUB and reused by every device. */
  illustrations?: IllustrationTimelineEntry[];
}

export interface CloudBook {
  id: string;
  title: string;
  author?: string;
  addedAt: number;
  updatedAt: number;
  assets: Partial<Record<AssetKind, BookAsset>>;
  audio?: {
    duration?: number;
    chapters?: AudioChapter[];
  };
  alignment?: CloudAlignmentInfo;
  /** Per-book overrides. Omitted fields (or null) inherit local defaults. */
  listeningSettings?: CloudListeningSettings;
  /** Cloud is canonical; local Ttsu copies are only a per-device cache. */
  shelf?: CloudBookShelf;
  /** Timestamp set when the user explicitly moves the title to reading history. */
  finishedAt?: number;
}

export interface LibraryManifest {
  version: 1;
  updatedAt: number;
  books: CloudBook[];
}

export interface CloudReaderBookmark {
  scrollX?: number;
  scrollY?: number;
  exploredCharCount?: number;
  progress: number | string | undefined;
  lastBookmarkModified: number;
}

export interface CloudReaderProgress {
  bookmark?: CloudReaderBookmark;
  percentage?: number;
  updatedAt: number;
}

export interface CloudAudiobookProgress {
  seconds: number;
  duration?: number;
  playbackRate?: number;
  updatedAt: number;
}

export interface CloudProgress {
  version: 1;
  bookId: string;
  reader?: CloudReaderProgress;
  audiobook?: CloudAudiobookProgress;
  deviceId: string;
  updatedAt: number;
}

export interface CloudQuotaStatus {
  initialized: boolean;
  usedBytes: number;
  reservedBytes: number;
  projectedBytes: number;
  maxBytes: number;
  remainingBytes: number;
  activeUploads: number;
  budgets: {
    readsToday: number;
    maxReadsPerDay: number;
    writesToday: number;
    maxWritesPerDay: number;
  };
}

export interface ProgressSnapshot {
  progress?: CloudProgress;
  etag?: string;
}

/** One-request view of the cloud library used by the manager. */
export interface CloudLibrarySnapshot {
  version: 1;
  generatedAt: number;
  library: LibraryManifest;
  quota: CloudQuotaStatus;
  progress: Record<string, ProgressSnapshot>;
  coverUrls: Record<string, string>;
}

export interface CloudStatisticSnapshot {
  version: 1;
  deviceId: string;
  bookId: string;
  title: string;
  dateKey: string;
  readingTime: number;
  charactersRead: number;
  lastStatisticModified: number;
  completedBook?: number;
  clearCompletion?: boolean;
  completedData?: {
    dateKey: string;
    charactersRead: number;
    readingTime: number;
    minReadingSpeed: number;
    altMinReadingSpeed: number;
    lastReadingSpeed: number;
    maxReadingSpeed: number;
    completedBook?: number;
  };
}

export interface CloudStatisticAggregate {
  bookId: string;
  title: string;
  dateKey: string;
  readingTime: number;
  charactersRead: number;
  minReadingSpeed: number;
  altMinReadingSpeed: number;
  lastReadingSpeed: number;
  maxReadingSpeed: number;
  lastStatisticModified: number;
  completedBook?: number;
  completedData?: CloudStatisticSnapshot['completedData'];
}
