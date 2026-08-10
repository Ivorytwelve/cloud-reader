<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount, tick } from 'svelte';
  import { get } from 'svelte/store';
  import { faCheck, faCloud, faRotate, faTrash } from '@fortawesome/free-solid-svg-icons';
  import Fa from 'svelte-fa';
  import { pagePath } from '$lib/data/env';
  import { database } from '$lib/data/store';
  import loadEpub from '$lib/functions/file-loaders/epub/load-epub';
  import { TtsuCloudApi } from './api';
  import { extractCloudAudioMetadata } from './audio-metadata';
  import { linkCloudBook, unlinkCloudBook } from './book-links';
  import { loadCloudConfig } from './config';
  import { addBookToCloud } from './library';
  import { applyRemoteReaderProgress, ensureCloudBookLocal } from './local-library';
  import { clearCloudProgressSession, seedCloudProgressSession } from './progress-session';
  import type { CloudAlignmentInfo, CloudBook, CloudLibrarySnapshot, CloudProgress, CloudQuotaStatus, LibraryManifest } from './types';
  import { cloudAddRequest$, cloudRefreshRequest$, cloudSort$, type CloudSortState } from './ui-state';
  import {
    CLOUD_PROGRESS_REVISION_KEY,
    CLOUD_PROGRESS_UPDATED_EVENT,
    type CloudProgressUpdatedDetail
  } from './cloud-events';

  let api: TtsuCloudApi | undefined;
  let manifest: LibraryManifest = { version: 1, updatedAt: 0, books: [] };
  let quota: CloudQuotaStatus | undefined;
  let progressByBook = new Map<string, CloudProgress>();
  let coverUrlByBook = new Map<string, string>();
  let coverEtagByBook = new Map<string, string>();

  let loading = false;
  let error = '';
  let status = '';
  let showUpload = false;

  const initialConfig = typeof localStorage !== 'undefined' ? loadCloudConfig() : undefined;

  let libraryScroller: HTMLDivElement | undefined;
  let historyScroller: HTMLDivElement | undefined;
  let libraryFadeLeft = false;
  let libraryFadeRight = false;
  let historyFadeLeft = false;
  let historyFadeRight = false;
  let lastAddRequest = 0;
  let lastRefreshRequest = 0;
  let lastRefreshAt = 0;
  let refreshQueued = false;
  let autoRefreshTimer: number | undefined;

  let epubFile: File | undefined;
  let audioFile: File | undefined;
  let subtitleFile: File | undefined;
  let coverFile: File | undefined;
  let audioCoverFile: File | undefined;
  let epubElementHtml = '';
  let lastAlignmentInfo: CloudAlignmentInfo | undefined;
  let alignmentWarning = '';
  let uploadTitle = '';
  let uploadAuthor = '';
  let inspectingEpub = false;
  let uploading = false;
  let uploadFailed = false;
  let uploadController: AbortController | undefined;
  let uploadLabel = '';
  let uploadDone = 0;
  let uploadTotal = 0;

  $: libraryBooks = sortCloudBooks(
    manifest.books.filter((book) => book.shelf !== 'history'),
    $cloudSort$
  );
  $: historyBooks = sortCloudBooks(
    manifest.books.filter((book) => book.shelf === 'history'),
    $cloudSort$
  );

  onMount(() => {
    lastAddRequest = get(cloudAddRequest$);
    lastRefreshRequest = get(cloudRefreshRequest$);

    const unsubscribeAdd = cloudAddRequest$.subscribe((request) => {
      if (request > lastAddRequest) {
        lastAddRequest = request;
        if (api) showUpload = true;
        else error = 'Configure Cloud in Settings before adding books.';
      }
    });
    const unsubscribeRefresh = cloudRefreshRequest$.subscribe((request) => {
      if (request > lastRefreshRequest) {
        lastRefreshRequest = request;
        if (api) void refresh();
        else error = 'Configure Cloud in Settings before refreshing.';
      }
    });

    const onResize = () => updateShelfEdges();
    const onFocus = () => scheduleAutoRefresh();
    const onPageShow = () => scheduleAutoRefresh(0, true);
    const onOnline = () => scheduleAutoRefresh(0, true);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') scheduleAutoRefresh();
    };
    const onProgressUpdated = (event: Event) => {
      const detail = (event as CustomEvent<CloudProgressUpdatedDetail>).detail;
      if (!detail?.bookId) return;

      if (detail.progress && manifest.books.some((book) => book.id === detail.bookId)) {
        const next = new Map(progressByBook);
        next.set(detail.bookId, detail.progress);
        progressByBook = next;
        lastRefreshAt = Date.now();
        void tick().then(updateShelfEdges);
      } else {
        scheduleAutoRefresh(75, true);
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === CLOUD_PROGRESS_REVISION_KEY) scheduleAutoRefresh(75, true);
    };

    window.addEventListener('resize', onResize);
    window.addEventListener('focus', onFocus);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('online', onOnline);
    window.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener(CLOUD_PROGRESS_UPDATED_EVENT, onProgressUpdated as EventListener);

    if (initialConfig) void connectAndRefresh();

    return () => {
      unsubscribeAdd();
      unsubscribeRefresh();
      if (autoRefreshTimer) window.clearTimeout(autoRefreshTimer);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener(CLOUD_PROGRESS_UPDATED_EVENT, onProgressUpdated as EventListener);
    };
  });

  function scheduleAutoRefresh(delay = 75, force = false) {
    if (!api || document.visibilityState === 'hidden') return;
    if (!force && Date.now() - lastRefreshAt < 1500) return;

    if (autoRefreshTimer) window.clearTimeout(autoRefreshTimer);
    autoRefreshTimer = window.setTimeout(() => {
      autoRefreshTimer = undefined;
      void refresh();
    }, delay);
  }

  async function connectAndRefresh() {
    const config = loadCloudConfig();
    if (!config) {
      api = undefined;
      manifest = { version: 1, updatedAt: 0, books: [] };
      quota = undefined;
      await tick();
      updateShelfEdges();
      return;
    }

    api = new TtsuCloudApi({ baseUrl: config.workerUrl, token: config.token });
    await refresh();
  }

  async function refresh() {
    if (!api) return;
    if (loading) {
      refreshQueued = true;
      return;
    }
    loading = true;
    error = '';
    status = 'Syncing cloud library…';

    try {
      const snapshot = await api.getLibrarySnapshot();
      applyLibrarySnapshot(snapshot);
      status = '';
      await tick();
      updateShelfEdges();
    } catch (caught) {
      error = errorMessage(caught);
      status = '';
    } finally {
      loading = false;
      lastRefreshAt = Date.now();
      if (refreshQueued) {
        refreshQueued = false;
        scheduleAutoRefresh(50, true);
      }
    }
  }


  function applyLibrarySnapshot(snapshot: CloudLibrarySnapshot) {
    manifest = snapshot.library;
    quota = snapshot.quota;

    const nextProgress = new Map<string, CloudProgress>();
    const nextCovers = new Map<string, string>();
    const nextCoverEtags = new Map<string, string>();

    for (const book of manifest.books) {
      const progressSnapshot = snapshot.progress[book.id] || {};
      if (progressSnapshot.progress) nextProgress.set(book.id, progressSnapshot.progress);
      seedCloudProgressSession(book.id, progressSnapshot, api);

      const coverEtag = book.assets.cover?.etag || '';
      if (!book.assets.cover) continue;

      const oldUrl = coverUrlByBook.get(book.id);
      const oldEtag = coverEtagByBook.get(book.id);
      // Keep the exact same signed URL while the cover object is unchanged so a
      // routine refresh does not cause the browser to download the image again.
      const coverUrl = oldUrl && oldEtag === coverEtag ? oldUrl : snapshot.coverUrls[book.id];
      if (coverUrl) nextCovers.set(book.id, coverUrl);
      nextCoverEtags.set(book.id, coverEtag);
    }

    progressByBook = nextProgress;
    coverUrlByBook = nextCovers;
    coverEtagByBook = nextCoverEtags;
    lastRefreshAt = Date.now();
  }

  async function onEpubChanged(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    epubFile = input.files?.[0];
    coverFile = undefined;
    epubElementHtml = '';
    lastAlignmentInfo = undefined;
    alignmentWarning = '';
    if (!epubFile) return;

    inspectingEpub = true;
    error = '';
    try {
      const data = await loadEpub(epubFile, document, Date.now());
      uploadTitle = data.title || epubFile.name.replace(/\.epub$/i, '');
      epubElementHtml = data.elementHtml;
      if (data.coverImage) {
        coverFile = new File([data.coverImage], `cover${extensionForMime(data.coverImage.type)}`, {
          type: data.coverImage.type || 'image/jpeg'
        });
      }
    } catch (caught) {
      error = `Could not inspect EPUB: ${errorMessage(caught)}`;
      if (!uploadTitle) uploadTitle = epubFile.name.replace(/\.epub$/i, '');
    } finally {
      inspectingEpub = false;
    }
  }

  function onAudioChanged(event: Event) {
    audioFile = (event.currentTarget as HTMLInputElement).files?.[0];
    audioCoverFile = undefined;
  }

  function onSubtitleChanged(event: Event) {
    subtitleFile = (event.currentTarget as HTMLInputElement).files?.[0];
    lastAlignmentInfo = undefined;
    alignmentWarning = '';
  }

  async function uploadBook() {
    if (!api || !epubFile || !uploadTitle.trim() || uploading) return;
    uploading = true;
    uploadFailed = false;
    uploadController = new AbortController();
    error = '';
    status = 'Preparing upload…';
    uploadLabel = '';
    uploadDone = 0;
    uploadTotal = 0;

    try {
      let audioMetadata: { duration?: number; chapters?: Awaited<ReturnType<typeof extractCloudAudioMetadata>>['chapters'] } | undefined;
      if (audioFile) {
        status = 'Reading audiobook metadata…';
        const extracted = await extractCloudAudioMetadata(audioFile).catch(() => undefined);
        if (extracted) {
          audioMetadata = { duration: extracted.duration, chapters: extracted.chapters };
          if (extracted.cover) {
            audioCoverFile = new File([extracted.cover], `audiobook-cover${extensionForMime(extracted.cover.type)}`, {
              type: extracted.cover.type || 'image/jpeg'
            });
          }
        }
      }

      let alignmentFile: File | undefined;
      let alignmentInfo: CloudAlignmentInfo | undefined;
      let alignmentHtml: string | undefined;
      if (subtitleFile && epubElementHtml) {
        try {
          status = 'Matching subtitles to EPUB…';
          const [{ updateSubtitles }, { settings$ }, { matchSubtitlesToBookHtml }] = await Promise.all([
            import('$lib/whispersync-upstream/lib/files'),
            import('$lib/whispersync-upstream/lib/stores'),
            import('./whispersync-alignment')
          ]);
          const parsedSubtitles = await updateSubtitles(subtitleFile, document, false);
          const result = await matchSubtitlesToBookHtml(
            document,
            epubElementHtml,
            [...parsedSubtitles.values()],
            subtitleFile.name,
            {
              similarityThreshold: get(settings$.matchLineSimilarityThreshold$),
              // Cloud auto-matching needs a wider recovery window than the interactive
              // matcher because ruby-heavy EPUBs can create many text nodes between
              // a TOC heading and the real chapter body.
              maxAttempts: Math.max(200, get(settings$.matchLineMaxAttempts$)),
              ignoreRp: get(settings$.matchLineIgnoreRp$),
              onProgress: (done, total) => {
                uploadLabel = 'matching';
                uploadDone = done;
                uploadTotal = total;
              }
            }
          );
          alignmentHtml = result.elementHtml;
          alignmentInfo = {
            version: 1,
            source: 'auto',
            matchedBy: result.matchedBy,
            matchedOn: result.matchedOn,
            matchedLines: result.matchedLines,
            totalLines: result.totalLines,
            diffLines: result.diffLines,
            rate: result.rate
          };
          lastAlignmentInfo = alignmentInfo;
          alignmentFile = new File([alignmentHtml], 'whispersync-alignment.html', { type: 'text/html;charset=utf-8' });
   
        } catch (matchError) {
          alignmentWarning = `Automatic matching failed: ${errorMessage(matchError)}. Files will still be uploaded so you can match manually.`;
          lastAlignmentInfo = undefined;
          alignmentFile = undefined;
          alignmentInfo = undefined;
          alignmentHtml = undefined;
        }
      }

      status = 'Uploading…';
      const book = await addBookToCloud(api, {
        title: uploadTitle.trim(),
        author: uploadAuthor.trim() || undefined,
        epub: epubFile,
        audio: audioFile,
        subtitles: subtitleFile,
        cover: coverFile,
        audioCover: audioCoverFile,
        alignment: alignmentFile,
        alignmentInfo,
        audioMetadata,
        signal: uploadController.signal,
        onUploadProgress: (label, done, total) => {
          uploadLabel = label;
          uploadDone = done;
          uploadTotal = total;
        }
      });

      // The cloud copy is canonical. Do not create a local Ttsu copy just because
      // the user uploaded a title; a per-device cache is created lazily on first open.
      resetUploadForm();
      showUpload = false;
      status = '';
      await refresh();
    } catch (caught) {
      uploadFailed = true;
      error = uploadController?.signal.aborted
        ? 'Upload cancelled. You can retry with the same files.'
        : errorMessage(caught);
      status = '';
      // Refresh immediately so a successfully aborted multipart reservation
      // disappears from the footer instead of looking like a phantom upload.
      await refresh().catch(() => undefined);
    } finally {
      uploading = false;
      uploadController = undefined;
    }
  }

  function cancelUpload() {
    if (uploading && uploadController) {
      status = 'Cancelling upload…';
      uploadController.abort();
      return;
    }
    resetUploadForm();
    uploadFailed = false;
    error = '';
    showUpload = false;
  }

  async function clearStuckUploads() {
    if (!api || uploading) return;
    if (!confirm('Abort and clear all cloud upload reservations?\n\nOnly use this when no device is actively uploading. Already committed files are not deleted.')) return;
    loading = true;
    error = '';
    status = 'Clearing stuck uploads…';
    try {
      quota = await api.clearStuckUploads();
      status = '';
      await refreshAfterMutation();
    } catch (caught) {
      error = errorMessage(caught);
      status = '';
    } finally {
      loading = false;
    }
  }

  async function openCloudBook(book: CloudBook) {
    if (!api || loading) return;
    loading = true;
    error = '';
    status = `Opening ${book.title}…`;

    try {
      // Fetch one fresh bulk snapshot immediately before opening. This keeps the
      // cloud copy authoritative even if another device moved since the manager
      // was first rendered, without doing a progress request per title.
      const freshSnapshot = await api.getLibrarySnapshot();
      applyLibrarySnapshot(freshSnapshot);
      const freshBook = freshSnapshot.library.books.find((candidate) => candidate.id === book.id) || book;
      const progressSnapshot = freshSnapshot.progress[book.id] || {};
      seedCloudProgressSession(book.id, progressSnapshot, api);

      const localBookId = await ensureCloudBookLocal(document, api, freshBook, {
        onStatus: (message) => (status = message)
      });
      linkCloudBook(book.id, localBookId, freshBook.title);

      status = 'Restoring reading position…';
      await applyRemoteReaderProgress(api, book.id, localBookId, progressSnapshot);
      await database.putLastItem(localBookId);
      await goto(`${pagePath}/b?id=${localBookId}`);
    } catch (caught) {
      error = errorMessage(caught);
      status = '';
      loading = false;
    }
  }

  async function deleteCloudBook(book: CloudBook) {
    if (!api || !confirm(`Delete “${book.title}” from your cloud library?\n\nThis removes the stored EPUB/audiobook/subtitles and its cloud history.`)) {
      return;
    }

    loading = true;
    error = '';
    status = `Deleting ${book.title}…`;
    try {
      await api.deleteBook(book.id);
      unlinkCloudBook(book.id);
      clearCloudProgressSession(book.id);
      await refreshAfterMutation();
    } catch (caught) {
      error = errorMessage(caught);
    } finally {
      status = '';
      loading = false;
    }
  }

  async function moveToHistory(book: CloudBook) {
    if (!api || loading) return;
    loading = true;
    error = '';
    status = `Adding ${book.title} to reading history…`;
    try {
      await api.upsertBook({
        id: book.id,
        title: book.title,
        shelf: 'history',
        finishedAt: Date.now()
      });
      await refreshAfterMutation();
    } catch (caught) {
      error = errorMessage(caught);
    } finally {
      status = '';
      loading = false;
    }
  }

  async function restoreFromHistory(book: CloudBook) {
    if (!api || loading) return;
    loading = true;
    error = '';
    status = `Returning ${book.title} to your library…`;
    try {
      await api.upsertBook({ id: book.id, title: book.title, shelf: 'library' });
      await refreshAfterMutation();
    } catch (caught) {
      error = errorMessage(caught);
    } finally {
      status = '';
      loading = false;
    }
  }

  async function refreshAfterMutation() {
    // refresh() normally protects itself while another operation owns the loading
    // flag. Shelf mutations already own that flag, so briefly yield it here.
    loading = false;
    await refresh();
    loading = true;
  }

  function sortCloudBooks(books: CloudBook[], sort: CloudSortState): CloudBook[] {
    return books.slice().sort((a, b) => {
      let result = 0;
      switch (sort.key) {
        case 'title':
          result = a.title.localeCompare(b.title, 'ja-JP', { numeric: true });
          break;
        case 'added':
          result = a.addedAt - b.addedAt;
          break;
        case 'progress':
          result = progressPercent(a) - progressPercent(b);
          break;
        default:
          result = recentTimestamp(a) - recentTimestamp(b);
          break;
      }

      if (sort.direction === 'desc') result *= -1;
      return result || a.title.localeCompare(b.title, 'ja-JP', { numeric: true });
    });
  }

  function recentTimestamp(book: CloudBook): number {
    const progress = progressByBook.get(book.id);
    return Math.max(
      book.finishedAt || 0,
      progress?.reader?.updatedAt || 0,
      progress?.audiobook?.updatedAt || 0,
      book.updatedAt || 0
    );
  }

  function updateShelfEdge(el: HTMLDivElement | undefined, shelf: 'library' | 'history') {
    if (!el) return;
    const canScroll = el.scrollWidth > el.clientWidth + 2;
    const left = canScroll && el.scrollLeft > 2;
    const right = canScroll && el.scrollLeft + el.clientWidth < el.scrollWidth - 2;

    if (shelf === 'library') {
      libraryFadeLeft = left;
      libraryFadeRight = right;
    } else {
      historyFadeLeft = left;
      historyFadeRight = right;
    }
  }

  function updateShelfEdges() {
    updateShelfEdge(libraryScroller, 'library');
    updateShelfEdge(historyScroller, 'history');
  }

  function shelfMaskClass(left: boolean, right: boolean): string {
    if (left && right) return 'cloud-shelf-mask-both';
    if (left) return 'cloud-shelf-mask-left';
    if (right) return 'cloud-shelf-mask-right';
    return '';
  }

  function onShelfWheel(event: WheelEvent, el: HTMLDivElement | undefined) {
    if (!el || Math.abs(event.deltaY) <= Math.abs(event.deltaX) || event.ctrlKey) return;
    if (el.scrollWidth <= el.clientWidth + 2) return;
    event.preventDefault();
    el.scrollBy({ left: event.deltaY, behavior: 'auto' });
  }

  function resetUploadForm() {
    epubFile = undefined;
    audioFile = undefined;
    subtitleFile = undefined;
    coverFile = undefined;
    audioCoverFile = undefined;
    epubElementHtml = '';
    lastAlignmentInfo = undefined;
    alignmentWarning = '';
    uploadTitle = '';
    uploadAuthor = '';
    uploadFailed = false;
    uploadLabel = '';
    uploadDone = 0;
    uploadTotal = 0;
  }

  function progressPercent(book: CloudBook): number {
    const progress = progressByBook.get(book.id);
    const reader = progress?.reader?.percentage;
    const readerPercent = typeof reader === 'number' && Number.isFinite(reader) ? clamp(reader) : 0;

    const seconds = progress?.audiobook?.seconds;
    const duration = progress?.audiobook?.duration || book.audio?.duration;
    const audioPercent = typeof seconds === 'number' && duration ? clamp(seconds / duration) : 0;
    return Math.max(readerPercent, audioPercent);
  }

  function progressText(book: CloudBook): string {
    const progress = progressByBook.get(book.id);
    if (progress?.audiobook?.seconds) return `Audio ${formatTime(progress.audiobook.seconds)}`;
    const percentage = progressPercent(book);
    return percentage ? `${(percentage * 100).toFixed(1)}%` : 'Not started';
  }

  function clamp(value: number) {
    return Math.min(1, Math.max(0, value));
  }

  function formatTime(seconds: number): string {
    const whole = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    const rest = whole % 60;
    return [hours, minutes, rest].map((part) => String(part).padStart(2, '0')).join(':');
  }

  function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 GB';
    if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(bytes >= 10_000_000_000 ? 0 : 1)} GB`;
    if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
    return `${Math.ceil(bytes / 1000)} KB`;
  }

  function formatFinishedDate(timestamp?: number): string {
    if (!timestamp) return 'Finished';
    return `Finished ${new Date(timestamp).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`;
  }

  function extensionForMime(mime: string): string {
    if (mime.includes('png')) return '.png';
    if (mime.includes('webp')) return '.webp';
    if (mime.includes('gif')) return '.gif';
    return '.jpg';
  }

  function errorMessage(value: unknown): string {
    return value instanceof Error ? value.message : String(value);
  }
</script>

<section class="cloud-library-shell relative z-[1] grid h-full min-h-0 grid-rows-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 py-2">
  {#if showUpload && api}
    <div class="absolute inset-0 z-30 flex items-start justify-center bg-[#E3F2FD]/85 px-2 pt-3 backdrop-blur-[2px]">
      <div class="w-full max-w-3xl rounded-2xl border border-[#90CAF9] bg-[#F7FBFF] p-4 shadow-xl">
        <div class="mb-3 flex items-center justify-between gap-3">
          <h2 class="font-semibold">Add to cloud library</h2>
          <button
            class="rounded-xl px-3 py-1.5 text-sm transition hover:bg-[#E3F2FD]"
            on:click={cancelUpload}
          >
            {uploading ? 'Stop upload' : 'Cancel'}
          </button>
        </div>

        <div class="grid gap-3 md:grid-cols-2">
          <label class="text-xs">
            <span class="mb-1 block opacity-70">EPUB</span>
            <input type="file" accept="application/epub+zip,.epub" on:change={(event) => void onEpubChanged(event)} disabled={uploading} />
          </label>
          <label class="text-xs">
            <span class="mb-1 block opacity-70">Audiobook (optional)</span>
            <input type="file" accept="audio/*,.m4b,.m4a,.mp3,.aac,.flac,.ogg,.opus" on:change={onAudioChanged} disabled={uploading} />
          </label>
          <label class="text-xs">
            <span class="mb-1 block opacity-70">Subtitles (optional)</span>
            <input type="file" accept=".srt,.vtt,.txt,text/plain,text/vtt" on:change={onSubtitleChanged} disabled={uploading} />
          </label>
          <div class="grid grid-cols-2 gap-2">
            <label class="text-xs">
              <span class="mb-1 block opacity-70">Title</span>
              <input class="w-full rounded-lg border border-[#90CAF9] bg-white/70 px-2 py-1.5" bind:value={uploadTitle} disabled={uploading || inspectingEpub} />
            </label>
            <label class="text-xs">
              <span class="mb-1 block opacity-70">Author (optional)</span>
              <input class="w-full rounded-lg border border-[#90CAF9] bg-white/70 px-2 py-1.5" bind:value={uploadAuthor} disabled={uploading} />
            </label>
          </div>
        </div>

        <div class="mt-4 flex flex-wrap items-center gap-3">
          <button
            class="rounded-xl bg-[#2196F3] px-4 py-2 text-sm font-medium text-white transition hover:bg-[#0D47A1] disabled:opacity-50"
            on:click={() => void uploadBook()}
            disabled={!epubFile || !uploadTitle.trim() || uploading || inspectingEpub}
          >
            {uploading ? 'Uploading…' : uploadFailed ? 'Retry upload' : 'Upload to cloud'}
          </button>
          {#if coverFile}<span class="text-xs opacity-60">EPUB cover detected</span>{/if}
          {#if audioCoverFile}<span class="text-xs opacity-60">Audiobook cover detected</span>{/if}
          {#if lastAlignmentInfo}
            <span class="text-xs opacity-70">Auto match: {(lastAlignmentInfo.rate * 100).toFixed(1)}% ({lastAlignmentInfo.matchedLines}/{lastAlignmentInfo.totalLines})</span>
          {/if}
          {#if alignmentWarning}<span class="text-xs text-amber-700">{alignmentWarning}</span>{/if}
          {#if uploadLabel && uploadTotal}
            <span class="text-xs opacity-70">{uploadLabel}: {((uploadDone / uploadTotal) * 100).toFixed(0)}%</span>
          {/if}
          {#if error}
            <span class="basis-full text-xs text-red-600">{error}</span>
          {/if}
        </div>
      </div>
    </div>
  {/if}

  <div class="cloud-shelf min-h-0">
    <div class="mb-1.5 flex items-center gap-2 px-0.5">
      <h2 class="text-sm font-semibold">Library</h2>
      <span class="text-xs opacity-45">{libraryBooks.length}</span>
    </div>

    {#if api && libraryBooks.length}
      <div class="min-h-0 flex-1 overflow-hidden">
        <div
          class="cloud-shelf-scroll {shelfMaskClass(libraryFadeLeft, libraryFadeRight)} flex h-full gap-3 overflow-x-auto overflow-y-hidden py-1 pr-1"
          bind:this={libraryScroller}
          on:scroll={() => updateShelfEdge(libraryScroller, 'library')}
          on:wheel|nonpassive={(event) => onShelfWheel(event, libraryScroller)}
        >
          {#each libraryBooks as book (book.id)}
            <article class="cloud-book-card group relative flex-none overflow-hidden rounded-xl border border-[#90CAF9]/65 bg-[#E3F2FD]/70 shadow-sm">
              <button class="block w-full text-left" on:click={() => void openCloudBook(book)} disabled={loading} title={`Open ${book.title}`}>
                <div class="aspect-[2/3] bg-[#E3F2FD]/80">
                  {#if coverUrlByBook.get(book.id)}
                    <img
                      class="book-cover h-full w-full object-cover"
                      src={coverUrlByBook.get(book.id)}
                      alt={`${book.title} cover`}
                      decoding="async"
                      loading="lazy"
                      referrerpolicy="no-referrer"
                      style="image-rendering: auto;"
                    />
                  {:else}
                    <div class="flex h-full items-center justify-center text-4xl opacity-25"><Fa icon={faCloud} /></div>
                  {/if}
                </div>
                <div class="bg-[#E3F2FD] p-2.5">
                  <div class="line-clamp-2 min-h-[2.5rem] text-sm font-medium">{book.title}</div>
                  {#if book.author}<div class="mt-0.5 line-clamp-1 text-xs opacity-50">{book.author}</div>{/if}
                  <div class="mt-1.5 text-xs opacity-60">{progressText(book)}</div>
                  <div class="mt-1.5 h-1 overflow-hidden rounded-full bg-[#90CAF9]/45">
                    <div class="h-full rounded-full bg-[#2196F3]" style:width={`${progressPercent(book) * 100}%`} />
                  </div>
                </div>
              </button>

              <div class="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                <button
                  class="rounded-lg bg-black/60 p-1.5 text-xs text-white hover:bg-black/75"
                  title="Mark as finished"
                  aria-label={`Mark ${book.title} as finished`}
                  on:click|stopPropagation={() => void moveToHistory(book)}
                  disabled={loading}
                >
                  <Fa icon={faCheck} />
                </button>
                <button
                  class="rounded-lg bg-black/60 p-1.5 text-xs text-white hover:bg-black/75"
                  title="Delete from cloud"
                  aria-label={`Delete ${book.title} from cloud`}
                  on:click|stopPropagation={() => void deleteCloudBook(book)}
                  disabled={loading}
                >
                  <Fa icon={faTrash} />
                </button>
              </div>
            </article>
          {/each}
        </div>
      </div>
    {:else if api && !loading}
      <div class="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-dashed border-[#90CAF9]/60 text-sm opacity-55">
        Your cloud library is empty. Use + in the top bar to add a book.
      </div>
    {:else if !api}
      <div class="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-dashed border-[#90CAF9]/60 text-center text-sm opacity-60">
        Configure Cloud in Settings to connect your library.
      </div>
    {/if}
  </div>

  <div class="cloud-shelf min-h-0 border-t border-[#90CAF9]/35 pt-2">
    <div class="mb-1.5 flex items-center gap-2 px-0.5">
      <h2 class="text-sm font-semibold">Reading history</h2>
      <span class="text-xs opacity-45">{historyBooks.length}</span>
    </div>

    {#if api && historyBooks.length}
      <div class="min-h-0 flex-1 overflow-hidden">
        <div
          class="cloud-shelf-scroll {shelfMaskClass(historyFadeLeft, historyFadeRight)} flex h-full gap-3 overflow-x-auto overflow-y-hidden py-1 pr-1"
          bind:this={historyScroller}
          on:scroll={() => updateShelfEdge(historyScroller, 'history')}
          on:wheel|nonpassive={(event) => onShelfWheel(event, historyScroller)}
        >
          {#each historyBooks as book (book.id)}
            <article class="cloud-book-card group relative flex-none overflow-hidden rounded-xl border border-[#90CAF9]/65 bg-[#E3F2FD]/70 shadow-sm">
              <button class="block w-full text-left" on:click={() => void openCloudBook(book)} disabled={loading} title={`Open ${book.title}`}>
                <div class="relative aspect-[2/3] bg-[#E3F2FD]/80">
                  {#if coverUrlByBook.get(book.id)}
                    <img
                      class="book-cover h-full w-full object-cover"
                      src={coverUrlByBook.get(book.id)}
                      alt={`${book.title} cover`}
                      decoding="async"
                      loading="lazy"
                      referrerpolicy="no-referrer"
                      style="image-rendering: auto;"
                    />
                  {:else}
                    <div class="flex h-full items-center justify-center text-4xl opacity-25"><Fa icon={faCloud} /></div>
                  {/if}
                  <span class="absolute bottom-2 left-2 rounded-lg bg-black/65 px-2 py-1 text-[0.65rem] text-white">Read</span>
                </div>
                <div class="bg-[#E3F2FD] p-2.5">
                  <div class="line-clamp-2 min-h-[2.5rem] text-sm font-medium">{book.title}</div>
                  {#if book.author}<div class="mt-0.5 line-clamp-1 text-xs opacity-50">{book.author}</div>{/if}
                  <div class="mt-1.5 text-xs opacity-60">{formatFinishedDate(book.finishedAt)}</div>
                </div>
              </button>

              <div class="absolute right-1.5 top-1.5 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                <button
                  class="rounded-lg bg-black/60 p-1.5 text-xs text-white hover:bg-black/75"
                  title="Return to library"
                  aria-label={`Return ${book.title} to library`}
                  on:click|stopPropagation={() => void restoreFromHistory(book)}
                  disabled={loading}
                >
                  <Fa icon={faRotate} />
                </button>
                <button
                  class="rounded-lg bg-black/60 p-1.5 text-xs text-white hover:bg-black/75"
                  title="Delete from cloud"
                  aria-label={`Delete ${book.title} from cloud`}
                  on:click|stopPropagation={() => void deleteCloudBook(book)}
                  disabled={loading}
                >
                  <Fa icon={faTrash} />
                </button>
              </div>
            </article>
          {/each}
        </div>
      </div>
    {:else}
      <div class="flex min-h-0 flex-1 items-center justify-center text-sm opacity-45">
        Finished books will appear here and sync across devices.
      </div>
    {/if}
  </div>

  <footer class="flex min-h-8 items-center justify-between gap-3 border-t border-[#90CAF9]/45 px-0.5 text-xs">
    <div class="min-w-0 truncate opacity-60">
      {#if api && quota}
        Cloud · {formatBytes(quota.usedBytes)} used{quota.reservedBytes ? ` + ${formatBytes(quota.reservedBytes)} uploading` : ''} · {formatBytes(quota.remainingBytes)} free · {formatBytes(quota.maxBytes)} cap
        {#if quota.reservedBytes && !uploading}
          <button
            class="ml-2 rounded-md px-1.5 py-0.5 font-medium text-[#0D47A1] underline decoration-[#90CAF9] underline-offset-2 hover:bg-[#90CAF9]/20"
            on:click={() => void clearStuckUploads()}
            disabled={loading}
          >
            Clear stuck upload
          </button>
        {/if}
      {:else if api}
        Cloud connected · {libraryBooks.length} current · {historyBooks.length} read
      {:else}
        Cloud not configured
      {/if}
    </div>

    {#if error}
      <div class="max-w-[50%] truncate text-red-600" title={error}>{error}</div>
    {:else if status}
      <div class="max-w-[50%] truncate opacity-60">{status}</div>
    {:else if api}
      <div class="shrink-0 opacity-45">{libraryBooks.length} current · {historyBooks.length} read</div>
    {/if}
  </footer>
</section>

<style>
  .cloud-shelf {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .cloud-shelf-scroll {
    scrollbar-width: none;
    overscroll-behavior-inline: contain;
    scroll-behavior: smooth;
  }

  .cloud-shelf-scroll::-webkit-scrollbar {
    display: none;
  }

  .cloud-shelf-mask-right {
    -webkit-mask-image: linear-gradient(to right, #000 0, #000 calc(100% - 32px), transparent 100%);
    mask-image: linear-gradient(to right, #000 0, #000 calc(100% - 32px), transparent 100%);
  }

  .cloud-shelf-mask-left {
    -webkit-mask-image: linear-gradient(to right, transparent 0, #000 32px, #000 100%);
    mask-image: linear-gradient(to right, transparent 0, #000 32px, #000 100%);
  }

  .cloud-shelf-mask-both {
    -webkit-mask-image: linear-gradient(to right, transparent 0, #000 32px, #000 calc(100% - 32px), transparent 100%);
    mask-image: linear-gradient(to right, transparent 0, #000 32px, #000 calc(100% - 32px), transparent 100%);
  }

  .cloud-book-card {
    /* Fit one card comfortably inside half of the remaining viewport while
       still allowing the larger covers on normal desktop heights. */
    width: clamp(135px, calc(33.333dvh - 93px), 200px);
  }
</style>
