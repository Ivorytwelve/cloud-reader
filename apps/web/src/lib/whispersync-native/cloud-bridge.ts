/*
 * Native bridge for Renji-XD/ttu-whispersync inside Ttsu.
 * The upstream source is vendored under $lib/whispersync-upstream.
 */
import { get } from 'svelte/store';
import { setAudioContext, setSubtitleContext, updateSubtitles } from '$lib/whispersync-upstream/lib/files';
import {
  bookData$,
  currentAudioSourceUrl$,
  currentCoverUrl$,
  currentRemoteAudioFileName$,
  currentTime$,
  duration$,
  extensionData$,
  lastError$,
  playbackRate$
} from '$lib/whispersync-upstream/lib/stores';
import { TtsuCloudApi } from '$lib/cloud/api';
import { getCloudLinkByLocalBookId, linkCloudBook } from '$lib/cloud/book-links';
import { applyCloudAlignmentIfNeeded, suppressCloudAlignment } from '$lib/cloud/local-library';
import { getCloudProgressSession, getConfiguredCloudApi } from '$lib/cloud/progress-session';
import { activeCloudBookId$, cloudAudiobookTrackingActive$ } from '$lib/cloud/audiobook-tracking';
import type { CloudAlignmentInfo, CloudBook } from '$lib/cloud/types';

let activeCloudBookId: string | undefined;
let activeCloudHasAudio = false;
let lastCloudSaveAt = 0;

export async function openCloudAudiobook(api: TtsuCloudApi, book: CloudBook): Promise<void> {
  activeCloudBookId = book.id;
  activeCloudBookId$.next(book.id);
  activeCloudHasAudio = !!book.assets.audio;
  cloudAudiobookTrackingActive$.next(activeCloudHasAudio);
  lastCloudSaveAt = 0;
  // Avoid subtitle parsing being clamped to a stale duration from the previous
  // SPA-opened book. The upload pipeline records duration when the browser can
  // read it; otherwise 0 means "do not clamp" until audio metadata arrives.
  duration$.set(book.audio?.duration || 0);

  // Subtitles are independent from the audiobook. A cloud book with subtitles but
  // no audio should still make those subtitles available to Whispersync.
  if (book.assets.subtitles) {
    const subtitleBlob = await api.fetchAsset(book.id, 'subtitles');
    const subtitleFile = new File([subtitleBlob], book.assets.subtitles.fileName, {
      type: book.assets.subtitles.contentType
    });
    const parsedSubtitles = await updateSubtitles(subtitleFile, document, true);
    if (!parsedSubtitles.size) {
      throw new Error(`Cloud subtitle file “${book.assets.subtitles.fileName}” contains no readable subtitle lines`);
    }
  } else {
    setSubtitleContext();
    if (book.alignment) {
      // v0.3.0 could leave this inconsistent state when a small Unicode-named
      // subtitle failed after the alignment had already been calculated. Keep
      // audio usable, but make the missing subtitle asset explicit in Whispersync.
      lastError$.set('This cloud book has saved matching data but no subtitle file. Delete/re-upload this incomplete cloud copy.');
    }
  }

  if (!book.assets.audio) {
    // Do not erase a locally selected Whispersync audiobook merely because this
    // cloud item has no cloud audio. Remote state is cleared when the previous
    // reader instance unmounts.
    return;
  }

  const session = getCloudProgressSession(book.id, api);
  if (!session) throw new Error('Cloud progress session is unavailable');
  await session.loaded;
  const remoteProgress = session.sync.current;
  const resumeAt = remoteProgress?.audiobook?.seconds;

  // Set the resume position before the audio element receives the new src.
  // Player.svelte seeks to currentTime when loadedmetadata fires.
  if (Number.isFinite(resumeAt)) {
    currentTime$.set(resumeAt!);
    const extensionData = get(extensionData$);
    extensionData.playbackPosition = resumeAt!;
    extensionData$.set(extensionData);
  }

  if (remoteProgress?.audiobook?.playbackRate) playbackRate$.set(remoteProgress.audiobook.playbackRate);

  const [audioUrl, audioCoverUrl] = await Promise.all([
    api.getSignedAssetUrl(book.id, 'audio'),
    book.assets.audioCover ? api.getSignedAssetUrl(book.id, 'audioCover') : Promise.resolve('')
  ]);

  // Do not make a Blob from the audiobook. The browser keeps native range-seek
  // behavior when the Whispersync <audio> element points straight at the Worker.
  await setAudioContext(get(currentCoverUrl$), get(currentAudioSourceUrl$), undefined, {
    coverUrl: audioCoverUrl,
    audioSourceUrl: audioUrl,
    chapters: book.audio?.chapters || []
  });
  currentRemoteAudioFileName$.set(book.assets.audio.fileName);
}

/**
 * Loads all cloud Whispersync attachments for the current local Ttsu book.
 * The old function name is retained for callers from v0.2.x.
 */
export async function autoOpenCloudAudiobookForLocalBook(localBookId: number): Promise<boolean> {
  const api = getConfiguredCloudApi();
  if (!api) return false;

  await waitForWhispersyncBook(localBookId);
  const library = await api.getLibrary();
  let link = getCloudLinkByLocalBookId(localBookId);
  let cloudBook = link ? library.books.find((book) => book.id === link!.cloudBookId) : undefined;

  // Recovery for a book that reached R2 but failed before v0.2.x could write the
  // local UUID mapping. Exact title fallback is only used when it is unambiguous.
  if (!cloudBook) {
    const title = get(bookData$).title;
    const candidates = library.books.filter((book) => book.title === title);
    if (candidates.length === 1) {
      cloudBook = candidates[0];
      link = linkCloudBook(cloudBook.id, localBookId, title);
    }
  }

  if (!cloudBook) return false;

  // If the user opened the normal Ttsu card rather than the Cloud Library card,
  // bring an existing cloud alignment into the local DB and reload once so the
  // currently rendered reader DOM is generated from the aligned HTML.
  const alignmentApplied = await applyCloudAlignmentIfNeeded(api, cloudBook, localBookId, {});
  if (alignmentApplied) {
    window.location.reload();
    return true;
  }

  await openCloudAudiobook(api, cloudBook);
  return !!(cloudBook.assets.audio || cloudBook.assets.subtitles);
}

export async function saveCloudAudiobookProgress(force = false): Promise<void> {
  if (!activeCloudBookId) return;
  const session = getCloudProgressSession(activeCloudBookId);
  if (!session) return;
  await session.loaded;

  const seconds = get(currentTime$);
  if (!Number.isFinite(seconds)) return;

  void force;
  await session.sync.save({
    audiobook: {
      seconds,
      duration: get(duration$) || undefined,
      playbackRate: get(playbackRate$)
    }
  });
}

export function clearCloudAudiobookSession(): void {
  activeCloudBookId = undefined;
  activeCloudBookId$.next(undefined);
  lastCloudSaveAt = 0;
  if (activeCloudHasAudio) {
    currentRemoteAudioFileName$.set('');
    currentAudioSourceUrl$.set('');
    currentCoverUrl$.set('');
  }
  activeCloudHasAudio = false;
  cloudAudiobookTrackingActive$.next(false);
}

interface CloudAudiobookProgressEventDetail {
  seconds: number;
  duration?: number;
  playbackRate?: number;
  paused?: boolean;
}

interface CloudAlignmentSavedDetail {
  localBookId: number;
  elementHtml: string;
  match: Omit<CloudAlignmentInfo, 'version' | 'source'>;
  waitUntil?: (promise: Promise<unknown>) => void;
}

let progressEventInstalled = false;

export function installCloudAudiobookProgressEvents(): () => void {
  if (progressEventInstalled) return () => undefined;
  progressEventInstalled = true;

  const onProgress = (event: Event) => {
    if (!activeCloudBookId) return;
    const detail = (event as CustomEvent<CloudAudiobookProgressEventDetail>).detail;
    if (!detail || !Number.isFinite(detail.seconds)) return;

    const now = Date.now();
    const shouldSave = detail.paused || now - lastCloudSaveAt >= 10_000;
    if (!shouldSave) return;
    lastCloudSaveAt = now;

    const session = getCloudProgressSession(activeCloudBookId);
    if (!session) return;

    void session.loaded
      .then(() =>
        session.sync.save({
          audiobook: {
            seconds: detail.seconds,
            duration: detail.duration,
            playbackRate: detail.playbackRate
          }
        })
      )
      .catch(() => undefined);
  };

  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') void saveCloudAudiobookProgress(true).catch(() => undefined);
  };

  const onAlignmentSaved = (event: Event) => {
    const detail = (event as CustomEvent<CloudAlignmentSavedDetail>).detail;
    if (!detail?.localBookId || !detail.elementHtml) return;
    const link = getCloudLinkByLocalBookId(detail.localBookId);
    const api = getConfiguredCloudApi();
    if (!link || !api) return;

    const promise = persistManualAlignment(api, link.cloudBookId, detail).catch((error) => {
      console.error('Failed to save manual cloud alignment', error);
      throw error;
    });
    detail.waitUntil?.(promise);
  };

  const onAlignmentReset = (event: Event) => {
    const localBookId = Number((event as CustomEvent<{ localBookId?: number }>).detail?.localBookId);
    if (!Number.isInteger(localBookId)) return;
    const link = getCloudLinkByLocalBookId(localBookId);
    if (link) suppressCloudAlignment(link.cloudBookId, true);
  };

  document.addEventListener('ttu-cloud:audiobook-progress', onProgress as EventListener);
  document.addEventListener('ttu-cloud:alignment-saved', onAlignmentSaved as EventListener);
  document.addEventListener('ttu-cloud:alignment-reset', onAlignmentReset as EventListener);
  document.addEventListener('visibilitychange', onVisibilityChange);

  return () => {
    document.removeEventListener('ttu-cloud:audiobook-progress', onProgress as EventListener);
    document.removeEventListener('ttu-cloud:alignment-saved', onAlignmentSaved as EventListener);
    document.removeEventListener('ttu-cloud:alignment-reset', onAlignmentReset as EventListener);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    progressEventInstalled = false;
  };
}

async function persistManualAlignment(
  api: TtsuCloudApi,
  cloudBookId: string,
  detail: CloudAlignmentSavedDetail
): Promise<void> {
  const library = await api.getLibrary();
  const book = library.books.find((candidate) => candidate.id === cloudBookId);
  if (!book) throw new Error('Cloud book no longer exists');

  const match: CloudAlignmentInfo = {
    version: 1,
    source: 'manual',
    matchedBy: detail.match.matchedBy,
    matchedOn: detail.match.matchedOn,
    matchedLines: detail.match.matchedLines,
    totalLines: detail.match.totalLines,
    diffLines: detail.match.diffLines,
    rate: detail.match.rate
  };
  const alignmentFile = new File([detail.elementHtml], 'whispersync-alignment.html', {
    type: 'text/html;charset=utf-8'
  });
  await api.uploadAsset(cloudBookId, 'alignment', alignmentFile);
  await api.upsertBook({ id: cloudBookId, title: book.title, alignment: match });
  suppressCloudAlignment(cloudBookId, false);
}

async function waitForWhispersyncBook(localBookId: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    const bookData = get(bookData$);
    const extensionData = get(extensionData$);
    if (bookData.id === localBookId && extensionData.title) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Whispersync did not finish initializing for this book');
}
