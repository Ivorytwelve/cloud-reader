export type AssetKind = 'epub' | 'audio' | 'subtitles' | 'cover' | 'audioCover' | 'alignment';
export type CloudBookShelf = 'library' | 'history';

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
  illustrations?: IllustrationTimelineEntry[];
}

export interface CloudListeningSettings {
  openingMode?: 'reading' | 'listening' | null;
  progressBar?: 'chapter' | 'book' | null;
  showSentence?: boolean | null;
  keepReaderActive?: boolean | null;
  showIllustrations?: boolean | null;
  illustrationNotification?: boolean | null;
  skipSeconds?: number | null;
}

export interface IllustrationTimelineEntry {
  id: string;
  triggerSeconds: number;
  href: string;
  resourceKey?: string;
  alt?: string;
  confidence: 'high' | 'medium';
  beforeSubtitleId?: string;
  afterSubtitleId?: string;
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
  listeningSettings?: CloudListeningSettings;
  shelf?: CloudBookShelf;
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

export interface ReaderProgress {
  bookmark?: CloudReaderBookmark;
  percentage?: number;
  updatedAt: number;
}

export interface AudiobookProgress {
  seconds: number;
  duration?: number;
  playbackRate?: number;
  updatedAt: number;
}

export interface CloudProgress {
  version: 1;
  bookId: string;
  reader?: ReaderProgress;
  audiobook?: AudiobookProgress;
  deviceId: string;
  updatedAt: number;
}

export interface ProgressSnapshot {
  progress?: CloudProgress;
  etag?: string;
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

export interface CloudLibrarySnapshot {
  version: 1;
  generatedAt: number;
  library: LibraryManifest;
  quota: CloudQuotaStatus;
  progress: Record<string, ProgressSnapshot>;
  coverUrls: Record<string, string>;
}

export interface MultipartCompleteBody {
  parts: Array<{ partNumber: number; etag: string }>;
  fileName: string;
  contentType: string;
  size: number;
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
