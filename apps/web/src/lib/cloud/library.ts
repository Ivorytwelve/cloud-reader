import { TtsuCloudApi } from './api';
import type { AudioChapter, CloudAlignmentInfo, CloudBook } from './types';

export interface AddCloudBookInput {
  id?: string;
  title: string;
  author?: string;
  epub: File;
  audio?: File;
  subtitles?: File;
  cover?: File;
  audioCover?: File;
  alignment?: File;
  alignmentInfo?: CloudAlignmentInfo;
  audioMetadata?: {
    duration?: number;
    chapters?: AudioChapter[];
  };
  onUploadProgress?: (label: string, uploaded: number, total: number) => void;
}

/**
 * Creates a cloud book as one logical operation.
 *
 * Asset uploads still happen independently in R2, but a brand-new failed upload is
 * removed again after all in-flight uploads have settled. This prevents a failed
 * subtitle/cover upload from leaving a library card that misleadingly contains only
 * the already-finished EPUB/audio assets.
 */
export async function addBookToCloud(api: TtsuCloudApi, input: AddCloudBookInput): Promise<CloudBook> {
  const createdNewBook = !input.id;
  const id = input.id || crypto.randomUUID();
  const now = Date.now();

  // Do not advertise an alignment in the manifest until both the subtitle file and
  // the generated alignment asset have actually uploaded successfully.
  let book = await api.upsertBook({
    id,
    title: input.title,
    author: input.author,
    addedAt: now,
    updatedAt: now,
    assets: {},
    audio: input.audioMetadata,
    shelf: 'library'
  });

  const upload = async (
    kind: 'epub' | 'audio' | 'subtitles' | 'cover' | 'audioCover' | 'alignment',
    file?: File
  ) => {
    if (!file) return;
    await api.uploadAsset(id, kind, file, {
      onProgress: (done, total) => input.onUploadProgress?.(kind, done, total)
    });
  };

  const uploadGroup = async (tasks: Promise<void>[]) => {
    const results = await Promise.allSettled(tasks);
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
  };

  try {
    // Audio is normally the large item; running it alongside the EPUB keeps the
    // total upload time low. Promise.allSettled is intentional so cleanup never
    // races another still-running upload from the same group.
    await uploadGroup([upload('epub', input.epub), upload('audio', input.audio)]);
    await uploadGroup([
      upload('subtitles', input.subtitles),
      upload('cover', input.cover),
      upload('audioCover', input.audioCover),
      upload('alignment', input.alignment)
    ]);

    // Publish match metadata only after all corresponding files exist remotely.
    if (input.alignmentInfo) {
      book = await api.upsertBook({
        id,
        title: input.title,
        author: input.author,
        alignment: input.alignmentInfo,
        audio: input.audioMetadata
      });
    }

    book = (await api.getLibrary()).books.find((candidate) => candidate.id === id) || book;
    return book;
  } catch (error) {
    // Initial uploads use fresh UUIDs, so deleting a failed new book is safe. For a
    // future "repair/update existing book" flow we intentionally leave the existing
    // book untouched instead of deleting user data.
    if (createdNewBook) await api.deleteBook(id).catch(() => undefined);
    throw error;
  }
}
