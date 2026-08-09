import { TtsuCloudApi } from './api';
import type { CloudBook } from './types';

export interface WhispersyncCloudHooks {
  setAudio(options: {
    sourceUrl: string;
    coverUrl?: string;
    chapters: NonNullable<CloudBook['audio']>['chapters'];
  }): Promise<void> | void;
  setSubtitles?(file: File): Promise<void> | void;
}

export async function loadCloudAudiobook(
  api: TtsuCloudApi,
  book: CloudBook,
  hooks: WhispersyncCloudHooks,
): Promise<void> {
  if (!book.assets.audio) throw new Error('This cloud book has no audiobook');

  const [audioUrl, coverUrl] = await Promise.all([
    api.getSignedAssetUrl(book.id, 'audio'),
    book.assets.audioCover ? api.getSignedAssetUrl(book.id, 'audioCover') : Promise.resolve(undefined),
  ]);

  await hooks.setAudio({
    sourceUrl: audioUrl,
    coverUrl,
    chapters: book.audio?.chapters || [],
  });

  if (book.assets.subtitles && hooks.setSubtitles) {
    const blob = await api.fetchAsset(book.id, 'subtitles');
    const file = new File([blob], book.assets.subtitles.fileName, {
      type: book.assets.subtitles.contentType,
    });
    await hooks.setSubtitles(file);
  }
}
