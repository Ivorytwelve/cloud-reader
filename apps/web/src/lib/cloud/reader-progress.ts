import type { BooksDbBookmarkData } from '$lib/data/database/books-db/versions/books-db';
import { database } from '$lib/data/store';
import { getCloudLinkByLocalBookId } from './book-links';
import { getCloudProgressSession } from './progress-session';
import { toCloudBookmark } from './local-library';

export async function hydrateLinkedCloudReaderProgress(localBookId: number): Promise<void> {
  const link = getCloudLinkByLocalBookId(localBookId);
  if (!link) return;

  const session = getCloudProgressSession(link.cloudBookId);
  if (!session) return;
  await session.loaded;

  const remote = session.sync.current;
  const bookmark = remote?.reader?.bookmark;
  if (!bookmark) return;

  await database.putBookmark({
    dataId: localBookId,
    scrollX: bookmark.scrollX,
    scrollY: bookmark.scrollY,
    exploredCharCount: bookmark.exploredCharCount,
    progress: bookmark.progress,
    lastBookmarkModified: bookmark.lastBookmarkModified
  });
  database.bookmarksChanged$.next();
}

export async function saveLinkedCloudReaderProgress(
  localBookId: number,
  bookmark: BooksDbBookmarkData
): Promise<void> {
  const link = getCloudLinkByLocalBookId(localBookId);
  if (!link) return;

  const session = getCloudProgressSession(link.cloudBookId);
  if (!session) return;
  await session.loaded;

  const percentage = normalizeProgress(bookmark.progress);
  await session.sync.save({
    reader: {
      bookmark: toCloudBookmark(bookmark),
      percentage
    }
  });
}

function normalizeProgress(progress: number | string | undefined): number | undefined {
  if (typeof progress === 'number') return Number.isFinite(progress) ? progress : undefined;
  if (typeof progress !== 'string') return undefined;
  const trimmed = progress.trim();
  if (!trimmed) return undefined;
  if (trimmed.endsWith('%')) {
    const value = Number(trimmed.slice(0, -1));
    return Number.isFinite(value) ? value / 100 : undefined;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}
