/*
 * Native bridge for Renji-XD/ttu-whispersync inside Ttsu.
 * The upstream source is vendored under $lib/whispersync-upstream.
 */
import { get } from 'svelte/store';
import { setAudioContext, setSubtitleContext, updateSubtitles } from '$lib/whispersync-upstream/lib/files';
import { getRemoteMp3EmbeddedArtwork } from '$lib/whispersync-upstream/lib/id3-chapters';
import {
	bookData$,
	currentAudioSourceUrl$,
	currentCoverUrl$,
	currentRemoteAudioFileName$,
	currentSubtitles$,
	currentTime$,
  duration$,
  extensionData$,
  lastError$,
  paused$,
  playbackRate$,
  pendingCloudResumeTime$
} from '$lib/whispersync-upstream/lib/stores';
import { CloudApiError, TtsuCloudApi } from '$lib/cloud/api';
import { getCloudLinkByLocalBookId, linkCloudBook } from '$lib/cloud/book-links';
import { applyCloudAlignmentIfNeeded, suppressCloudAlignment } from '$lib/cloud/local-library';
import { getCloudProgressSession, getConfiguredCloudApi } from '$lib/cloud/progress-session';
import { activeCloudBookId$, cloudAudiobookTrackingActive$ } from '$lib/cloud/audiobook-tracking';
import { AudiobookWriteBuffer, type BufferedAudiobookProgress } from '$lib/cloud/audiobook-write-buffer';
import { getCloudWriteRetryDelayMs } from '$lib/cloud/cloud-write-throttle';
import type { CloudAlignmentInfo, CloudBook, CloudProgress } from '$lib/cloud/types';
import { inferIllustrationTimeline } from '$lib/cloud/illustration-timeline';
import { activeCloudBook$, setActiveCloudBook } from '$lib/cloud/listening-settings';

const CLOUD_AUDIO_SAVE_INTERVAL_MS = 5_000;
const CLOUD_AUDIO_RETRY_MIN_MS = 5_000;
const CLOUD_AUDIO_RETRY_MAX_MS = 60_000;
const CLOUD_AUDIO_REVALIDATE_RETRY_MS = 5_000;
const CLOUD_AUDIO_RUNTIME_SEEK_TOLERANCE_SECONDS = 0.75;
const CLOUD_AUDIO_TAB_REVISION_KEY = 'ttu-cloud-audiobook-revision-v1';

let activeCloudBookId: string | undefined;
let activeCloudHasAudio = false;
let lastCloudSaveAt = 0;

// A dormant browser tab must never be able to push its stale player state over
// newer cloud progress. Writes are disarmed whenever the page leaves the
// foreground and are only re-armed after a fresh cloud read has completed.
let cloudAudioWritesArmed = false;
let cloudAudioUserDirty = false;
let cloudAudioRevalidation: Promise<void> | undefined;
let cloudAudioNeedsRevalidation = false;
let cloudAudioRevalidateRetryAt = 0;
let cloudAudioSaveInFlight: Promise<void> | undefined;
let cloudAudioSaveTimer: ReturnType<typeof setTimeout> | undefined;
let cloudAudioRetryDelay = CLOUD_AUDIO_RETRY_MIN_MS;
const cloudAudioWriteBuffer = new AudiobookWriteBuffer();
const cloudAudioCoverBackfills = new Map<string, Promise<string>>();

export async function openCloudAudiobook(api: TtsuCloudApi, book: CloudBook): Promise<void> {
	activeCloudBookId = book.id;
	activeCloudBookId$.next(book.id);
	setActiveCloudBook(book);
  activeCloudHasAudio = !!book.assets.audio;
  cloudAudiobookTrackingActive$.next(activeCloudHasAudio);
  resetCloudAudioWriteState();
  cloudAudioWritesArmed = false;
  cloudAudioUserDirty = false;
  cloudAudioNeedsRevalidation = false;
  cloudAudioRevalidateRetryAt = 0;
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
  applyAuthoritativeCloudAudiobookProgress(remoteProgress, false);

  const [audioUrl, audioCoverUrl, epubCoverUrl] = await Promise.all([
    api.getSignedAssetUrl(book.id, 'audio'),
    book.assets.audioCover ? api.getSignedAssetUrl(book.id, 'audioCover') : Promise.resolve(''),
    // Audiobook Center versions predating dedicated audioCover uploads still
    // have the lightweight EPUB cover asset. Use it as a safe remote fallback
    // instead of clearing the player's artwork to an empty string.
    book.assets.cover ? api.getSignedAssetUrl(book.id, 'cover') : Promise.resolve('')
  ]);
  const remoteCoverUrl = audioCoverUrl || epubCoverUrl;

  // Do not make a Blob from the audiobook. The browser keeps native range-seek
  // behavior when the Whispersync <audio> element points straight at the Worker.
  // Set the remote marker BEFORE changing the audio src. Player.svelte uses
  // this marker during loadedmetadata to distinguish a cloud resume from a
  // normal local-file load. Setting it afterward created a startup race where
  // a fast audio element could restore from its default 0-second position.
  currentRemoteAudioFileName$.set(book.assets.audio.fileName);
  await setAudioContext(get(currentCoverUrl$), get(currentAudioSourceUrl$), undefined, {
    coverUrl: remoteCoverUrl,
    audioSourceUrl: audioUrl,
		chapters: (book.audio?.chapters || []).map((chapter) => ({
			...chapter,
			startText: chapter.startText || ''
		}))
  });

  // Old Audiobook Center uploads can contain perfectly valid APIC artwork in
  // the remote MP3 while lacking the separately cached audioCover asset. Recover
  // it with a bounded ID3 Range read, upload only the tiny image, and switch this
  // live session to the audiobook artwork when ready. Playback never waits for
  // this best-effort repair.
  if (!audioCoverUrl) {
    void backfillMissingCloudAudioCover(api, book, audioUrl).catch((error) => {
      console.warn('Could not backfill embedded cloud audiobook cover', error);
    });
  }

  // Loading the source itself may emit timeupdate/pause events. They are not
  // user progress, so only arm writes after the remote source has been seeded.
  cloudAudioWritesArmed = true;
}

async function backfillMissingCloudAudioCover(
  api: TtsuCloudApi,
  book: CloudBook,
  audioUrl: string
): Promise<string> {
  if (!book.assets.audio || book.assets.audioCover || !/\.mp3$/i.test(book.assets.audio.fileName)) return '';

  const existing = cloudAudioCoverBackfills.get(book.id);
  if (existing) return existing;

  const task = (async () => {
    const artwork = await getRemoteMp3EmbeddedArtwork(audioUrl, book.assets.audio?.fileName || '');
    if (!artwork?.blob.size) return '';

    const audioName = book.assets.audio?.fileName || 'audiobook.mp3';
    const stem = audioName.replace(/\.[^.]+$/, '') || 'audiobook';
    const fileName = `${stem}.audio-cover.${artwork.extension}`;
    const coverFile = new File([artwork.blob], fileName, { type: artwork.mimeType });
    await api.uploadAsset(book.id, 'audioCover', coverFile);
    const coverUrl = await api.getSignedAssetUrl(book.id, 'audioCover');

    // The upload endpoint writes audioCover into the canonical cloud manifest.
    // Do not replace activeCloudBook$ here with the older `book` snapshot: other
    // asynchronous metadata backfills/settings writes may have advanced it while
    // cover extraction was running.

    // Do not let a slow extraction from a previously opened book replace the
    // artwork of a newer session.
    if (activeCloudBookId === book.id && get(currentAudioSourceUrl$) === audioUrl) {
      currentCoverUrl$.set(coverUrl);
    }
    return coverUrl;
  })();

  cloudAudioCoverBackfills.set(book.id, task);
  try {
    return await task;
  } finally {
    cloudAudioCoverBackfills.delete(book.id);
  }
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

  // Older cloud books (and books uploaded by Audiobook Center) can already have
  // a valid Whispersync alignment without the newer illustration timeline
  // metadata. Infer it once from the aligned local EPUB + loaded subtitles and
  // publish it back to the manifest. The session gets the inferred timeline
  // immediately even if the best-effort cloud write is rate-limited.
  if (cloudBook.assets.audio && cloudBook.alignment && cloudBook.alignment.illustrations === undefined) {
    void backfillCloudIllustrationTimeline(api, cloudBook, localBookId).catch((error) => {
      console.warn('Could not backfill cloud illustration timeline', error);
    });
  }

  return !!(cloudBook.assets.audio || cloudBook.assets.subtitles);
}

async function backfillCloudIllustrationTimeline(
  api: TtsuCloudApi,
  book: CloudBook,
  localBookId: number
): Promise<void> {
  const localBook = get(bookData$);
  const subtitles = [...get(currentSubtitles$).values()];
  if (localBook.id !== localBookId || !localBook.elementHtml || !subtitles.length || !book.alignment) {
    return;
  }

  const illustrations = inferIllustrationTimeline(localBook.elementHtml, subtitles);
  const currentActive = get(activeCloudBook$);
  const optimisticBook: CloudBook = {
    ...book,
    alignment: { ...book.alignment, illustrations },
    ...(currentActive?.id === book.id && currentActive.listeningSettings
      ? { listeningSettings: currentActive.listeningSettings }
      : {})
  };
  setActiveCloudBook(optimisticBook);

  // Persist even an empty array. In cloud metadata [] means “inference ran and
  // this EPUB has no timed illustrations”, while undefined means an older book
  // still needs the one-time backfill.
  const saved = await api.upsertBook({
    id: book.id,
    // Update-only: do not resurrect a book if it was deleted while the
    // asynchronous illustration inference was running.
    title: '',
    alignment: optimisticBook.alignment
  });
  const latestActive = get(activeCloudBook$);
  setActiveCloudBook(
    latestActive?.id === book.id && latestActive.listeningSettings
      ? { ...saved, listeningSettings: latestActive.listeningSettings }
      : saved
  );
}


function applyAuthoritativeCloudAudiobookProgress(
  progress: CloudProgress | undefined,
  notifyLoadedPlayer: boolean,
  reason: 'initial' | 'conflict' | 'revalidation' = 'initial'
): void {
  const audiobook = progress?.audiobook;
	const rawSeconds = audiobook?.seconds;
	const seconds = typeof rawSeconds === 'number' && Number.isFinite(rawSeconds) ? rawSeconds : 0;
  const extensionData = get(extensionData$);

  cloudAudioUserDirty = false;
  cloudAudioWriteBuffer.seedCommitted(
    audiobook
      ? {
          seconds,
          duration: audiobook.duration,
          playbackRate: audiobook.playbackRate
        }
      : undefined
  );

  const currentSeconds = get(currentTime$);
  const shouldApplyPosition =
    !notifyLoadedPlayer ||
    !Number.isFinite(currentSeconds) ||
    Math.abs(currentSeconds - seconds) > CLOUD_AUDIO_RUNTIME_SEEK_TOLERANCE_SECONDS;

  if (shouldApplyPosition) {
    pendingCloudResumeTime$.set(seconds);
    currentTime$.set(seconds);
    extensionData$.set({ ...extensionData, playbackPosition: seconds });
  }

  const savedPlaybackRate = audiobook?.playbackRate;
  if (typeof savedPlaybackRate === 'number' && Number.isFinite(savedPlaybackRate) && savedPlaybackRate > 0) {
    playbackRate$.set(savedPlaybackRate);
  } else if (reason === 'initial') {
    // Playback speed is per-book cloud progress. Older books may not have a
    // saved rate yet, so never leak the previous book's speed into a newly
    // opened audiobook.
    playbackRate$.set(1);
  }

  if (notifyLoadedPlayer && shouldApplyPosition) {
    document.dispatchEvent(
      new CustomEvent('ttu-cloud:apply-audiobook-position', {
        detail: { seconds, playbackRate: audiobook?.playbackRate, reason }
      })
    );
  }
}

function resetCloudAudioWriteState(): void {
  lastCloudSaveAt = 0;
  cloudAudioRetryDelay = CLOUD_AUDIO_RETRY_MIN_MS;
  cloudAudioWriteBuffer.reset();
  if (cloudAudioSaveTimer) {
    clearTimeout(cloudAudioSaveTimer);
    cloudAudioSaveTimer = undefined;
  }
}

function scheduleCloudAudioSave(delay: number): void {
  if (cloudAudioSaveTimer || !activeCloudBookId || !cloudAudioWriteBuffer.pending) return;
  cloudAudioSaveTimer = setTimeout(() => {
    cloudAudioSaveTimer = undefined;
    void drainCloudAudiobookProgress(false).catch(() => undefined);
  }, Math.max(0, delay));
}

function isRetryableProgressSaveError(error: unknown): boolean {
  if (!(error instanceof CloudApiError)) return true;
  return error.status === 408 || error.status === 429 || error.status >= 500;
}

function queueCloudAudiobookProgress(value: {
  seconds: number;
  duration?: number;
  playbackRate?: number;
}): BufferedAudiobookProgress | undefined {
  return cloudAudioWriteBuffer.queue(value);
}

function announceCloudAudiobookWrite(bookId: string, updatedAt: number): void {
  try {
    localStorage.setItem(CLOUD_AUDIO_TAB_REVISION_KEY, `${Date.now()}:${bookId}:${updatedAt}`);
  } catch {
    // Cross-tab coordination is an extra safety layer; the ETag still protects
    // cloud writes when localStorage is unavailable.
  }
}

async function drainCloudAudiobookProgress(force: boolean, allowDisarmed = false): Promise<void> {
  if (cloudAudioSaveInFlight) {
    const inFlight = cloudAudioSaveInFlight;
    await inFlight.catch(() => undefined);
    if (force && cloudAudioWriteBuffer.pending) {
      return drainCloudAudiobookProgress(force, allowDisarmed);
    }
    return;
  }

  const pending = cloudAudioWriteBuffer.pending;
  const bookId = activeCloudBookId;
  if (!pending || !bookId || !cloudAudioUserDirty) return;
  if (!allowDisarmed && (!cloudAudioWritesArmed || cloudAudioRevalidation)) return;

  const cloudWriteBlockedFor = getCloudWriteRetryDelayMs();
  if (cloudWriteBlockedFor > 0) {
    // Keep only the latest buffered position and wake up when the shared Worker
    // write breaker allows one probe. No network request is made here.
    scheduleCloudAudioSave(cloudWriteBlockedFor + 250);
    return;
  }

  const elapsed = Date.now() - lastCloudSaveAt;
  if (!force && lastCloudSaveAt && elapsed < CLOUD_AUDIO_SAVE_INTERVAL_MS) {
    scheduleCloudAudioSave(CLOUD_AUDIO_SAVE_INTERVAL_MS - elapsed);
    return;
  }

  if (cloudAudioSaveTimer) {
    clearTimeout(cloudAudioSaveTimer);
    cloudAudioSaveTimer = undefined;
  }

  const session = getCloudProgressSession(bookId);
  if (!session) return;
  const sent = pending;

  const task = (async () => {
    await session.loaded;
    if (activeCloudBookId !== bookId) return;
    if (!allowDisarmed && (!cloudAudioWritesArmed || cloudAudioRevalidation)) return;

    const conflictRevisionBefore = session.sync.audiobookConflictRevision;
    const saved = await session.sync.save({
      audiobook: {
        seconds: sent.seconds,
        duration: sent.duration,
        playbackRate: sent.playbackRate,
        updatedAt: sent.updatedAt
      }
    });

    if (activeCloudBookId !== bookId) return;

    // A save() call may return a newer locally coalesced session snapshot than
    // the exact token this drain sent. That is not a remote conflict and must
    // never seek the player. Only a real same-field 412 increments the conflict
    // revision in CloudProgressSync.
    const audiobookConflict = session.sync.audiobookConflictRevision !== conflictRevisionBefore;
    if (audiobookConflict) {
      cloudAudioWriteBuffer.discardPending();
      cloudAudioUserDirty = false;
      cloudAudioNeedsRevalidation = document.visibilityState === 'hidden';
      cloudAudioWritesArmed = document.visibilityState !== 'hidden';
      cloudAudioRetryDelay = CLOUD_AUDIO_RETRY_MIN_MS;
      lastCloudSaveAt = 0;
      applyAuthoritativeCloudAudiobookProgress(saved, true, 'conflict');
      return;
    }

    cloudAudioWriteBuffer.acknowledgeSent(sent);
    lastCloudSaveAt = Date.now();
    cloudAudioRetryDelay = CLOUD_AUDIO_RETRY_MIN_MS;
    announceCloudAudiobookWrite(bookId, saved?.audiobook?.updatedAt ?? sent.updatedAt);
  })();

  cloudAudioSaveInFlight = task;
  try {
    await task;
  } catch (error) {
    // The buffer still contains the exact unsaved snapshot (or something newer).
    // Retry transient failures with backoff instead of losing a final pause/seek.
    if (activeCloudBookId === bookId && cloudAudioWriteBuffer.pending && cloudAudioUserDirty) {
      if (isRetryableProgressSaveError(error)) {
        const sharedThrottleDelay = getCloudWriteRetryDelayMs();
        const delay = Math.max(cloudAudioRetryDelay, sharedThrottleDelay);
        cloudAudioRetryDelay = Math.min(cloudAudioRetryDelay * 2, CLOUD_AUDIO_RETRY_MAX_MS);
        if (cloudAudioWritesArmed && !cloudAudioRevalidation) {
          scheduleCloudAudioSave(delay + (sharedThrottleDelay > 0 ? 250 : 0));
        }
      } else {
        cloudAudioWriteBuffer.discardPending();
        cloudAudioUserDirty = false;
      }
    }
    throw error;
  } finally {
    if (cloudAudioSaveInFlight === task) cloudAudioSaveInFlight = undefined;
    if (
      cloudAudioWriteBuffer.pending &&
      cloudAudioWritesArmed &&
      !cloudAudioRevalidation &&
      !cloudAudioSaveTimer
    ) {
      const elapsedAfterSave = Date.now() - lastCloudSaveAt;
      scheduleCloudAudioSave(
        lastCloudSaveAt ? Math.max(0, CLOUD_AUDIO_SAVE_INTERVAL_MS - elapsedAfterSave) : 0
      );
    }
  }
}

async function revalidateActiveCloudAudiobook(): Promise<void> {
  if (!activeCloudBookId || !activeCloudHasAudio || document.visibilityState === 'hidden') return;
  if (cloudAudioRevalidation) return cloudAudioRevalidation;
  if (Date.now() < cloudAudioRevalidateRetryAt) return;

  const bookId = activeCloudBookId;
  cloudAudioWritesArmed = false;
  if (cloudAudioSaveTimer) {
    clearTimeout(cloudAudioSaveTimer);
    cloudAudioSaveTimer = undefined;
  }
  cloudAudioWriteBuffer.discardPending();

  cloudAudioRevalidation = (async () => {
    // A visibility-triggered flush may still be finishing. Reading only after it
    // settles prevents GET-before-PUT from restoring an older position locally.
    await cloudAudioSaveInFlight?.catch(() => undefined);
    if (activeCloudBookId !== bookId) return;

    const session = getCloudProgressSession(bookId);
    if (!session) return;

    await session.loaded;
    const remote = await session.sync.load();

    // The user may have navigated to a different book while the request was in flight.
    if (activeCloudBookId !== bookId) return;

    applyAuthoritativeCloudAudiobookProgress(remote, true, 'revalidation');
    lastCloudSaveAt = 0;
    cloudAudioNeedsRevalidation = false;
    cloudAudioRevalidateRetryAt = 0;
    cloudAudioWritesArmed = true;
  })()
    .catch((error) => {
      if (activeCloudBookId === bookId) {
        cloudAudioNeedsRevalidation = true;
        cloudAudioWritesArmed = false;
        cloudAudioRevalidateRetryAt = Date.now() + CLOUD_AUDIO_REVALIDATE_RETRY_MS;
      }
      throw error;
    })
    .finally(() => {
      cloudAudioRevalidation = undefined;
    });

  return cloudAudioRevalidation;
}

function requestCloudAudioRevalidationIfNeeded(): void {
  if (
    !cloudAudioNeedsRevalidation ||
    document.visibilityState === 'hidden' ||
    cloudAudioRevalidation ||
    Date.now() < cloudAudioRevalidateRetryAt
  ) {
    return;
  }
  void revalidateActiveCloudAudiobook().catch(() => undefined);
}

export async function saveCloudAudiobookProgress(force = false): Promise<void> {
  if (!activeCloudBookId || !cloudAudioWritesArmed || !cloudAudioUserDirty) return;

  // Snapshot synchronously before any await: reader teardown can reset the
  // two-way bound <audio> currentTime to zero on the next microtask.
  const seconds = get(currentTime$);
  if (!Number.isFinite(seconds)) return;

  queueCloudAudiobookProgress({
    seconds,
    duration: get(duration$) || undefined,
    playbackRate: get(playbackRate$)
  });

  if (!cloudAudioWriteBuffer.pending) return;
  await drainCloudAudiobookProgress(force, force);
}


export function clearCloudAudiobookSession(): void {
	activeCloudBookId = undefined;
	activeCloudBookId$.next(undefined);
	activeCloudBook$.set(undefined);
  resetCloudAudioWriteState();
  cloudAudioWritesArmed = false;
  cloudAudioUserDirty = false;
  cloudAudioRevalidation = undefined;
  cloudAudioNeedsRevalidation = false;
  cloudAudioRevalidateRetryAt = 0;
  if (activeCloudHasAudio) {
    currentRemoteAudioFileName$.set('');
    pendingCloudResumeTime$.set(null);
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

interface CloudProgressFlushDetail {
  waitUntil?: (promise: Promise<unknown>) => void;
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

  const onUserActivity = () => {
    if (!activeCloudBookId) return;
    if (!cloudAudioWritesArmed || cloudAudioRevalidation) {
      requestCloudAudioRevalidationIfNeeded();
      return;
    }
    cloudAudioUserDirty = true;
  };

  const onProgress = (event: Event) => {
    if (!activeCloudBookId) return;
    if (!cloudAudioWritesArmed || cloudAudioRevalidation) {
      requestCloudAudioRevalidationIfNeeded();
      return;
    }

    const detail = (event as CustomEvent<CloudAudiobookProgressEventDetail>).detail;
    if (!detail || !Number.isFinite(detail.seconds)) return;
    // A hidden tab may continue genuine background playback. Allow those moving
    // updates, but never let a suspension-generated hidden pause event write.
    if (document.visibilityState === 'hidden' && detail.paused) return;

    // Continuous playback is itself genuine progression. Paused timeupdate
    // events are writable only after an explicit player interaction.
    if (!detail.paused) cloudAudioUserDirty = true;
    if (!cloudAudioUserDirty) return;

    const queued = queueCloudAudiobookProgress({
      seconds: detail.seconds,
      duration: detail.duration,
      playbackRate: detail.playbackRate
    });
    if (!queued) return;

    const cloudWriteBlockedFor = getCloudWriteRetryDelayMs();
    if (cloudWriteBlockedFor > 0) {
      scheduleCloudAudioSave(cloudWriteBlockedFor + 250);
      return;
    }

    const now = Date.now();
    const elapsed = now - lastCloudSaveAt;
    if (detail.paused) {
      void drainCloudAudiobookProgress(true).catch(() => undefined);
    } else if (!lastCloudSaveAt || elapsed >= CLOUD_AUDIO_SAVE_INTERVAL_MS) {
      void drainCloudAudiobookProgress(false).catch(() => undefined);
    } else {
      scheduleCloudAudioSave(CLOUD_AUDIO_SAVE_INTERVAL_MS - elapsed);
    }
  };

  const onFlushProgress = (event: Event) => {
    const detail = (event as CustomEvent<CloudProgressFlushDetail>).detail;
    const promise = saveCloudAudiobookProgress(true);
    detail?.waitUntil?.(promise);
    void promise.catch(() => undefined);
  };

  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      // Snapshot before the browser can suspend the page. If playback keeps
      // running in the background, this tab is still the live authority and
      // its normal timeupdate writes continue advancing cloud progress. Merely
      // returning to the foreground must not GET an older periodic cloud
      // snapshot and seek the live audio backwards.
      const paused = get(paused$);
      const pending = saveCloudAudiobookProgress(true);
      cloudAudioNeedsRevalidation = cloudAudioNeedsRevalidation || paused;
      if (paused) {
        cloudAudioWritesArmed = false;
        cloudAudioUserDirty = false;
      }
      void pending.catch(() => undefined);
      return;
    }

    if (!cloudAudioNeedsRevalidation) return;
    cloudAudioWritesArmed = false;
    requestCloudAudioRevalidationIfNeeded();
  };

  const onWindowFocus = () => {
    if (!cloudAudioNeedsRevalidation) return;
    cloudAudioWritesArmed = false;
    requestCloudAudioRevalidationIfNeeded();
  };

  const onPageShow = (event: PageTransitionEvent) => {
    // Only a real BFCache restore needs an unconditional reconciliation. A
    // normal pageshow/foreground transition must not disturb continuously
    // playing audio. Cross-tab writes still set cloudAudioNeedsRevalidation
    // through the storage listener below.
    if (!event.persisted) return;
    cloudAudioNeedsRevalidation = true;
    cloudAudioWritesArmed = false;
    requestCloudAudioRevalidationIfNeeded();
  };

  const onStorage = (event: StorageEvent) => {
    if (event.key !== CLOUD_AUDIO_TAB_REVISION_KEY || !event.newValue || !activeCloudBookId) return;
    const [, bookId] = event.newValue.split(':');
    if (bookId !== activeCloudBookId) return;

    // Another tab on this browser successfully wrote audiobook progress for the
    // same book. Immediately revoke this tab's write authority; if visible,
    // reconcile now, otherwise wait until it returns to the foreground.
    cloudAudioNeedsRevalidation = true;
    cloudAudioWritesArmed = false;
    cloudAudioUserDirty = false;
    cloudAudioWriteBuffer.discardPending();
    if (cloudAudioSaveTimer) {
      clearTimeout(cloudAudioSaveTimer);
      cloudAudioSaveTimer = undefined;
    }
    requestCloudAudioRevalidationIfNeeded();
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

  document.addEventListener('ttu-cloud:audiobook-user-activity', onUserActivity as EventListener);
  document.addEventListener('ttu-cloud:audiobook-progress', onProgress as EventListener);
  document.addEventListener('ttu-cloud:flush-audiobook-progress', onFlushProgress as EventListener);
  document.addEventListener('ttu-cloud:alignment-saved', onAlignmentSaved as EventListener);
  document.addEventListener('ttu-cloud:alignment-reset', onAlignmentReset as EventListener);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('focus', onWindowFocus);
  window.addEventListener('pageshow', onPageShow);
  window.addEventListener('storage', onStorage);

  return () => {
    document.removeEventListener('ttu-cloud:audiobook-user-activity', onUserActivity as EventListener);
    document.removeEventListener('ttu-cloud:audiobook-progress', onProgress as EventListener);
    document.removeEventListener('ttu-cloud:flush-audiobook-progress', onFlushProgress as EventListener);
    document.removeEventListener('ttu-cloud:alignment-saved', onAlignmentSaved as EventListener);
    document.removeEventListener('ttu-cloud:alignment-reset', onAlignmentReset as EventListener);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('focus', onWindowFocus);
    window.removeEventListener('pageshow', onPageShow);
    window.removeEventListener('storage', onStorage);
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
		rate: detail.match.rate,
		illustrations: inferIllustrationTimeline(detail.elementHtml, [...get(currentSubtitles$).values()])
  };
  const alignmentFile = new File([detail.elementHtml], 'whispersync-alignment.html', {
    type: 'text/html;charset=utf-8'
  });
  await api.uploadAsset(cloudBookId, 'alignment', alignmentFile);
	const saved = await api.upsertBook({ id: cloudBookId, title: book.title, alignment: match });
	setActiveCloudBook(saved);
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
