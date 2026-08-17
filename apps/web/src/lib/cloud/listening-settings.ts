/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { get, writable } from 'svelte/store';
import { getConfiguredCloudApi } from './progress-session';
import type { CloudBook } from './types';
import type { CloudListeningSettings } from '$lib/listening-mode/types';

/** The cloud book currently attached to the open local reader. */
export const activeCloudBook$ = writable<CloudBook | undefined>(undefined);

export function setActiveCloudBook(book: CloudBook | undefined): void {
  activeCloudBook$.set(book);
}

export type CloudListeningSettingsPatch = Partial<CloudListeningSettings>;

/*
 * Per-book listening settings are deliberately low-frequency writes, but a user
 * can still change two selects before the first Worker request has returned.
 * Serialise writes per book and update the open-book store optimistically so the
 * second change is always based on the first one instead of an older manifest.
 */
const listeningSettingsSaveQueue = new Map<string, Promise<CloudBook>>();

/**
 * Persist only the per-book listening overrides. The open player is updated
 * synchronously; cloud writes for the same book are then sent in order. A late
 * response is never allowed to roll back a newer optimistic setting.
 */
export async function saveCloudBookListeningSettings(
  bookId: string,
  patch: CloudListeningSettingsPatch
): Promise<CloudBook> {
  const api = getConfiguredCloudApi();
  if (!api) throw new Error('Configure Cloud before saving per-book listening settings.');

  let book = get(activeCloudBook$);
  if (!book || book.id !== bookId) {
    const library = await api.getLibrary();
    book = library.books.find((candidate) => candidate.id === bookId);
  }
  if (!book) throw new Error('The cloud book is no longer available.');

  const nextSettings: CloudListeningSettings = {
    ...(book.listeningSettings || {}),
    ...patch
  };
  const optimisticBook: CloudBook = { ...book, listeningSettings: nextSettings };
  if (get(activeCloudBook$)?.id === bookId) activeCloudBook$.set(optimisticBook);

  const previous = listeningSettingsSaveQueue.get(bookId);
  const save = (previous ? previous.catch(() => optimisticBook) : Promise.resolve(optimisticBook))
    .then(async () => {
      const saved = await api.upsertBook({
        id: bookId,
        // Empty title makes this an update-only write: the Worker preserves the
        // existing title, but refuses to recreate a book that was deleted while
        // this settings request was queued.
        title: '',
        listeningSettings: nextSettings
      });

      let result = saved.listeningSettings
        ? saved
        : { ...saved, listeningSettings: nextSettings };

      activeCloudBook$.update((current: CloudBook | undefined) => {
        if (!current || current.id !== bookId) return current;
        // A newer select may already be reflected locally. Preserve it while
        // still taking fresh server metadata from this response. Chapter
        // backfill is another optimistic metadata write, so do not let an
        // older settings response temporarily erase freshly discovered audio
        // chapters either.
        result = {
          ...result,
          listeningSettings: current.listeningSettings || result.listeningSettings,
          audio:
            current.audio?.chapters?.length && !result.audio?.chapters?.length
              ? current.audio
              : result.audio
        };
        return result;
      });
      return result;
    })
    .finally(() => {
      if (listeningSettingsSaveQueue.get(bookId) === save) {
        listeningSettingsSaveQueue.delete(bookId);
      }
    });

  listeningSettingsSaveQueue.set(bookId, save);
  return save;
}

const audioChapterSaveInFlight = new Map<string, Promise<CloudBook>>();

/**
 * Backfill chapter metadata discovered by the reader. This is intentionally a
 * one-time metadata write: future devices can use the manifest instead of
 * re-reading ID3 chapter frames from the remote audiobook.
 */
export async function saveCloudBookAudioChapters(
  bookId: string,
  chapters: NonNullable<NonNullable<CloudBook['audio']>['chapters']>,
  duration?: number
): Promise<CloudBook> {
  const api = getConfiguredCloudApi();
  if (!api) throw new Error('Configure Cloud before saving audiobook chapters.');
  const existingInFlight = audioChapterSaveInFlight.get(bookId);
  if (existingInFlight) return existingInFlight;

  const save = (async () => {
    let book = get(activeCloudBook$);
    if (!book || book.id !== bookId) {
      const library = await api.getLibrary();
      book = library.books.find((candidate) => candidate.id === bookId);
    }
    if (!book) throw new Error('The cloud book is no longer available.');
    if (!book.assets.audio) return book;

    const signature = (items: typeof chapters | undefined) =>
      (items || []).map((chapter) => `${Math.round(chapter.startSeconds * 1000)}|${chapter.label}`).join('\n');
    if (signature(book.audio?.chapters) === signature(chapters)) return book;

    const audio = {
      ...(book.audio || {}),
      ...(Number.isFinite(duration) && Number(duration) > 0 ? { duration: Number(duration) } : {}),
      chapters
    };
    const optimisticBook: CloudBook = { ...book, audio };
    if (get(activeCloudBook$)?.id === bookId) activeCloudBook$.set(optimisticBook);

    const saved = await api.upsertBook({ id: bookId, title: '', audio });
    let result = saved;
    activeCloudBook$.update((current) => {
      if (!current || current.id !== bookId) return current;
      // Per-book settings can be changed while the one-time chapter backfill
      // is in flight. Preserve the newer optimistic settings until their own
      // serialized save finishes instead of flashing/rolling them back.
      result = {
        ...saved,
        listeningSettings: current.listeningSettings || saved.listeningSettings
      };
      return result;
    });
    return result;
  })().finally(() => {
    if (audioChapterSaveInFlight.get(bookId) === save) audioChapterSaveInFlight.delete(bookId);
  });

  audioChapterSaveInFlight.set(bookId, save);
  return save;
}
