import { database } from '$lib/data/store';
import { getStorageHandler } from '$lib/data/storage/storage-handler-factory';
import { StorageKey } from '$lib/data/storage/storage-types';
import {
  cacheStorageData$,
  readingGoalsMergeMode$,
  replicationSaveBehavior$,
  statisticsMergeMode$
} from '$lib/data/store';
import { importData } from '$lib/functions/replication/replicator';
import { TtsuCloudApi } from './api';
import { getCloudLinkByCloudBookId, linkCloudBook } from './book-links';
import type { CloudBook, CloudProgress, CloudReaderBookmark, ProgressSnapshot } from './types';

export interface EnsureCloudBookLocalOptions {
  epubFile?: File;
  alignmentHtml?: string;
  onStatus?: (message: string) => void;
}

function browserHandler() {
  return getStorageHandler(
    window,
    StorageKey.BROWSER,
    '',
    true,
    cacheStorageData$.getValue(),
    replicationSaveBehavior$.getValue(),
    statisticsMergeMode$.getValue(),
    readingGoalsMergeMode$.getValue()
  );
}

export async function ensureCloudBookLocal(
  document: Document,
  api: TtsuCloudApi,
  book: CloudBook,
  options: EnsureCloudBookLocalOptions = {}
): Promise<number> {
  const linked = getCloudLinkByCloudBookId(book.id);
  if (linked) {
    const linkedBook = await database.getData(linked.localBookId).catch(() => undefined);
    if (linkedBook?.elementHtml) {
      await applyCloudAlignmentIfNeeded(api, book, linkedBook.id, options);
      return linkedBook.id;
    }
  }

  const existing = await database.getDataByTitle(book.title);
  if (existing?.elementHtml) {
    linkCloudBook(book.id, existing.id, existing.title);
    await applyCloudAlignmentIfNeeded(api, book, existing.id, options);
    return existing.id;
  }

  if (!book.assets.epub && !options.epubFile) {
    throw new Error('This cloud item does not contain an EPUB');
  }

  options.onStatus?.('Downloading EPUB…');
  let epubFile = options.epubFile;
  if (!epubFile) {
    const blob = await api.fetchAsset(book.id, 'epub');
    const asset = book.assets.epub!;
    epubFile = new File([blob], asset.fileName || `${book.title}.epub`, {
      type: asset.contentType || 'application/epub+zip'
    });
  }

  options.onStatus?.('Adding book to this device…');
  const error = await importData(
    document,
    browserHandler(),
    [epubFile],
    new AbortController().signal
  );
  if (error) throw new Error(error);

  const imported = await database.getDataByTitle(book.title);
  if (!imported?.elementHtml) {
    throw new Error(`The EPUB imported successfully but Ttsu could not find “${book.title}”`);
  }

  linkCloudBook(book.id, imported.id, imported.title);
  await applyCloudAlignmentIfNeeded(api, book, imported.id, options);
  return imported.id;
}

export async function applyRemoteReaderProgress(
  api: TtsuCloudApi,
  cloudBookId: string,
  localBookId: number,
  knownSnapshot?: ProgressSnapshot
): Promise<CloudProgress | undefined> {
  const remote = knownSnapshot ? knownSnapshot.progress : (await api.getProgress(cloudBookId)).progress;
  const bookmark = remote?.reader?.bookmark;
  if (!bookmark) return remote;

  await database.putBookmark(toLocalBookmark(bookmark, localBookId));
  database.bookmarksChanged$.next();
  return remote;
}

export function toCloudBookmark(bookmark: {
  scrollX?: number;
  scrollY?: number;
  exploredCharCount?: number;
  progress: number | string | undefined;
  lastBookmarkModified: number;
}): CloudReaderBookmark {
  return {
    scrollX: bookmark.scrollX,
    scrollY: bookmark.scrollY,
    exploredCharCount: bookmark.exploredCharCount,
    progress: bookmark.progress,
    lastBookmarkModified: bookmark.lastBookmarkModified
  };
}

function toLocalBookmark(bookmark: CloudReaderBookmark, localBookId: number) {
  return {
    dataId: localBookId,
    scrollX: bookmark.scrollX,
    scrollY: bookmark.scrollY,
    exploredCharCount: bookmark.exploredCharCount,
    progress: bookmark.progress,
    lastBookmarkModified: bookmark.lastBookmarkModified
  };
}


export async function applyCloudAlignmentIfNeeded(
  api: TtsuCloudApi,
  book: CloudBook,
  localBookId: number,
  options: EnsureCloudBookLocalOptions
): Promise<boolean> {
  if (!book.assets.alignment || !book.alignment) return false;
  if (isCloudAlignmentSuppressed(book.id)) return false;

  const local = await database.getData(localBookId);
  if (!local?.elementHtml) return false;
  const currentMatchedOn = getMatchedOn(local.elementHtml);
  if (currentMatchedOn >= book.alignment.matchedOn) return false;

  options.onStatus?.('Applying Whispersync alignment…');
  const alignedHtml =
    options.alignmentHtml || (await (await api.fetchAsset(book.id, 'alignment')).text());
  if (!alignedHtml.trim()) return false;

  const db = await database.db;
  await db.put('data', {
    ...local,
    htmlBackup: local.htmlBackup || local.elementHtml,
    elementHtml: alignedHtml,
    lastBookModified: Math.max(Date.now(), book.alignment.matchedOn)
  });
  return true;
}

function getMatchedOn(elementHtml: string): number {
  try {
    const body = new DOMParser().parseFromString(elementHtml, 'text/html').body;
    const value = body.firstElementChild instanceof HTMLElement
      ? body.firstElementChild.dataset.ttuWhispersyncMatchedOn
      : undefined;
    return Number.parseInt(value || '0', 10) || 0;
  } catch {
    return 0;
  }
}

const ALIGNMENT_SUPPRESS_PREFIX = 'ttu-cloud-alignment-suppressed:';

export function suppressCloudAlignment(cloudBookId: string, suppressed = true): void {
  if (typeof localStorage === 'undefined') return;
  const key = `${ALIGNMENT_SUPPRESS_PREFIX}${cloudBookId}`;
  if (suppressed) localStorage.setItem(key, '1');
  else localStorage.removeItem(key);
}

export function isCloudAlignmentSuppressed(cloudBookId: string): boolean {
  return typeof localStorage !== 'undefined' && localStorage.getItem(`${ALIGNMENT_SUPPRESS_PREFIX}${cloudBookId}`) === '1';
}
