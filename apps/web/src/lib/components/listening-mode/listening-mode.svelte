<script lang="ts">
  import { browser } from '$app/environment';
  import { faBookmark as farBookmark } from '@fortawesome/free-regular-svg-icons';
  import {
    faArrowLeft,
    faArrowRight,
    faBookOpen,
    faChevronDown,
    faEllipsisVertical,
    faExpand,
    faFlag,
    faGear,
    faHeadphones,
    faImages,
    faPause,
    faPlay,
    faChartColumn,
    faRotateLeft,
    faRotateRight,
    faXmark
  } from '@fortawesome/free-solid-svg-icons';
  import Fa from 'svelte-fa';
  import { sectionList$ } from '$lib/components/book-reader/book-toc/book-toc';
  import type { Section } from '$lib/data/database/books-db/versions/v6/books-db-v6';
  import { clickOutside } from '$lib/functions/use-click-outside';
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { Action, executeAction } from '$lib/whispersync-upstream/lib/actions';
  import { getDummySubtitle, type AudioChapter, type Subtitle } from '$lib/whispersync-upstream/lib/general';
  import {
    activeSubtitle$,
    audioSeeking$,
    currentAudioChapters$,
    currentAudioFile$,
    currentAudioLoaded$,
    currentRemoteAudioFileName$,
    currentAudioSourceUrl$,
    currentCoverUrl$,
    currentSubtitles$,
    currentTime$,
    duration$,
    paused$,
    playbackRate$
  } from '$lib/whispersync-upstream/lib/stores';
  import { getLineCSSSelector, getLineCSSSelectorForId } from '$lib/whispersync-upstream/lib/util';
  import {
    getEmbeddedAudioChapters,
    getEmbeddedAudioCoverUrl,
    getRemoteMp3Id3Chapters
  } from '$lib/whispersync-upstream/lib/mediaInfo';
  import { inferIllustrationTimeline } from '$lib/cloud/illustration-timeline';
  import {
    audiobookDefaultIllustrationNotification$,
    audiobookDefaultKeepReaderActive$,
    audiobookDefaultOpeningMode$,
    audiobookDefaultProgressBar$,
    audiobookDefaultShowIllustrations$,
    audiobookDefaultShowSentence$,
    audiobookDefaultSkipSeconds$
  } from '$lib/data/store';
  import {
    activeCloudBook$,
    saveCloudBookAudioChapters,
    saveCloudBookListeningSettings,
    type CloudListeningSettingsPatch
  } from '$lib/cloud/listening-settings';
  import type {
    CloudListeningSettings,
    IllustrationTimelineEntry,
    ListeningOpeningMode,
    ListeningProgressBar
  } from '$lib/listening-mode/types';
  import { resolveListeningSettings } from '$lib/listening-mode/types';
  import { listeningSessionReady$ } from '$lib/listening-mode/session-state';

  export let enabled = false;
  export let localBookId = 0;
  export let bookTitle = '';
  export let bookAuthor = '';
  export let bookCover: string | Blob | undefined = undefined;
  export let bookBlobs: Record<string, Blob> = {};
  export let showFullscreenButton = false;
  export let hasImageGallery = false;

  const dispatch = createEventDispatcher<{
    bookmarkClick: void;
    fullscreenClick: void;
    statisticsClick: void;
    readerImageGalleryClick: void;
    readerSettingsClick: void;
    bookManagerClick: void;
    completeBook: void;
  }>();

  let contentRoot: HTMLDivElement | undefined;
  let mirrorElement: HTMLElement | undefined;
  let mirrorHasContent = false;
  let contentObserver: MutationObserver | undefined;
  let contentLookupTimer: number | undefined;
  let coverLookupTimer: number | undefined;
  let mirrorFrame: number | undefined;
  let localCoverInput: string | Blob | undefined;
  let localCoverUrl = '';
  let renderedWhispersyncCoverUrl = '';
  let artworkFailureVersion = 0;
  const failedArtworkUrls = new Set<string>();
  let embeddedAudioCoverUrl = '';
  let embeddedAudioCoverFile: File | undefined;
  let embeddedAudioCoverRequest = 0;
  let embeddedCoverStoreHadCover = false;
  let localIllustrationTimeline: IllustrationTimelineEntry[] = [];
  let localIllustrationTimelineKey = '';
  let defaultBookKey = 0;
  let defaultModeApplied = false;
  let settingsOpen = false;
  let readerActionsOpen = false;
  let speedOpen = false;
  let speedDraft = '1';
  let chaptersOpen = false;
  let chapterAnchorEl: HTMLButtonElement | undefined;
  let chapterPopoverStyle = '';
  let chapterPopoverMaxHeight = 352;
  let showTotalDuration = false;
  let progressBarSessionOverride: ListeningProgressBar | undefined;
  let localAudioChapters: AudioChapter[] = [];
  let chapterProbeFile: File | undefined;
  let chapterProbeRequest = 0;
  let remoteChapterProbeKey = '';
  let suppressIllustrationJump = false;
  let previousAudioSeeking = false;
  let settingsError = '';
  let displayedIllustration: IllustrationTimelineEntry | undefined;
  let displayedIllustrationUrl = '';
  let dismissedIllustrationId: string | undefined;
  let illustrationCursor = -1;
  let previousPlaybackTime: number | undefined;
  let previousEnabled = false;
  let previousShowIllustrations = true;
  let lastIllustrationTimelineSignature = '';
  let illustrationTimelineSignature = '';
  let mediaSessionMetadataKey = '';
  let lightboxOpen = false;
  let lightboxZoom = 1;
  let lightboxPanX = 0;
  let lightboxPanY = 0;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragOriginX = 0;
  let dragOriginY = 0;
  let dragActive = false;
  const lightboxPointers = new Map<number, { x: number; y: number }>();
  let pinchStartDistance = 0;
  let pinchStartZoom = 1;
  let pinchStartCenterX = 0;
  let pinchStartCenterY = 0;
  let pinchStartPanX = 0;
  let pinchStartPanY = 0;
  const localIllustrationUrls = new Map<string, string>();
  let listeningScrollLocked = false;
  let previousDocumentOverflow = '';
  let previousBodyOverflow = '';
  let previousDocumentOverscroll = '';
  let previousBodyOverscroll = '';
  let epubSectionData: Section[] = [];
  let epubChapterTitle = '';

  const settingActions = ['play', 'pause', 'seekbackward', 'seekforward', 'seekto'] as const;
  const mirrorVisualStyleProperties = [
    'color',
    'background-color',
    'text-decoration-line',
    'text-decoration-color',
    'text-decoration-style',
    'text-decoration-thickness',
    'text-shadow',
    'font-weight',
    'font-style',
    'font-family',
    'font-size',
    'letter-spacing',
    'border-bottom-color',
    'border-bottom-style',
    'border-bottom-width',
    'border-radius',
    'box-shadow',
    'opacity',
    'text-emphasis-color',
    'text-emphasis-style',
    '-webkit-text-emphasis-color',
    '-webkit-text-emphasis-style'
  ] as const;

  $: localListeningDefaults = {
    openingMode: $audiobookDefaultOpeningMode$,
    progressBar: $audiobookDefaultProgressBar$,
    showSentence: $audiobookDefaultShowSentence$,
    keepReaderActive: $audiobookDefaultKeepReaderActive$,
    showIllustrations: $audiobookDefaultShowIllustrations$,
    illustrationNotification: $audiobookDefaultIllustrationNotification$,
    skipSeconds: $audiobookDefaultSkipSeconds$
  };
  $: resolvedSettings = resolveListeningSettings(
    $activeCloudBook$?.listeningSettings,
    localListeningDefaults
  );
  $: effectiveProgressBar = progressBarSessionOverride ?? resolvedSettings.progressBar;

  $: chapterSource = $currentAudioChapters$.length
    ? $currentAudioChapters$
    : $activeCloudBook$?.audio?.chapters?.length
      ? $activeCloudBook$.audio.chapters
      : localAudioChapters;
  $: chapterList = [...chapterSource].sort(
    (first, second) => first.startSeconds - second.startSeconds
  );
  $: currentChapterIndex = chapterList.reduce(
    (index, chapter, candidateIndex) =>
      chapter.startSeconds <= $currentTime$ ? candidateIndex : index,
    0
  );
  $: currentChapter = chapterList[currentChapterIndex];
  $: chapterStart = currentChapter?.startSeconds || 0;
  $: nextChapter = chapterList[currentChapterIndex + 1];
  $: chapterEnd = Math.max(
    chapterStart + 0.01,
    nextChapter?.startSeconds || $duration$ || chapterStart + 0.01
  );
  $: progressStart = effectiveProgressBar === 'chapter' ? chapterStart : 0;
  $: progressEnd = Math.max(
    progressStart + 0.01,
    effectiveProgressBar === 'chapter' ? chapterEnd : $duration$ || chapterEnd
  );
  $: progressValue = Math.min(progressEnd, Math.max(progressStart, $currentTime$ || 0));
  $: progressPercent =
    progressEnd > progressStart
      ? ((progressValue - progressStart) / (progressEnd - progressStart)) * 100
      : 0;
  $: chapterTicks =
    effectiveProgressBar === 'book'
      ? chapterList.filter(
          (chapter) => chapter.startSeconds > progressStart && chapter.startSeconds < progressEnd
        )
      : [];
  $: activeSubtitleId = $activeSubtitle$.current || $activeSubtitle$.previous;
  $: currentSentence = getCurrentSentence(activeSubtitleId, $currentTime$);
  $: if (contentRoot && epubSectionData.length && activeSubtitleId) {
    updateEpubChapterTitleFromActiveLine();
  }
  $: cloudIllustrationTimeline = $activeCloudBook$?.alignment?.illustrations;
  $: illustrationEntries = (cloudIllustrationTimeline ?? localIllustrationTimeline)
    .slice()
    .sort((first, second) => first.triggerSeconds - second.triggerSeconds);
  $: illustrationTimelineSignature = illustrationEntries
    .map((entry) => `${entry.id}:${entry.triggerSeconds}:${entry.resourceKey || entry.href}`)
    .join('|');
  $: baseArtworkCandidates = uniqueArtworkUrls([
    $currentCoverUrl$,
    renderedWhispersyncCoverUrl,
    embeddedAudioCoverUrl,
    localCoverUrl
  ]);
  $: baseArtworkUrl = firstWorkingArtwork(baseArtworkCandidates, artworkFailureVersion);
  // An active illustration must render the exact same resource as the lightbox.
  // Do not send it through the cover fallback chain: a transient thumbnail load
  // error used to make the UI say “Illustration” while visibly showing the cover.
  $: artworkUrl = displayedIllustrationUrl || baseArtworkUrl;
  $: resolvedTitle = $activeCloudBook$?.title || bookTitle || 'Audiobook';
  $: resolvedAuthor = bookAuthor || $activeCloudBook$?.author || '';
  $: chapterHeading = getChapterHeading(
    epubChapterTitle,
    currentChapter?.label,
    currentChapterIndex,
    chapterList.length,
    resolvedTitle
  );
  $: mediaSessionMetadataKey = [
    baseArtworkUrl,
    resolvedTitle,
    resolvedAuthor,
    currentChapter?.key || currentChapter?.label || '',
    String(resolvedSettings.skipSeconds)
  ].join('|');
  $: sessionReadyForBook = $listeningSessionReady$?.localBookId === localBookId;
  $: hasAudio = Boolean($currentAudioLoaded$ || $currentAudioSourceUrl$);
  $: if (!speedOpen) speedDraft = formatPlaybackRate($playbackRate$);
  $: if (resolvedSettings.showIllustrations !== previousShowIllustrations) {
    // Turning illustration display on must not resurrect an image that was
    // passed earlier. Images appear only when natural playback crosses them.
    resetIllustrationCursorToTime($currentTime$, true);
    previousPlaybackTime = $currentTime$;
    previousShowIllustrations = resolvedSettings.showIllustrations;
  }
  $: if (illustrationTimelineSignature !== lastIllustrationTimelineSignature) {
    lastIllustrationTimelineSignature = illustrationTimelineSignature;
    resetIllustrationCursorToTime($currentTime$, true);
    previousPlaybackTime = $currentTime$;
  }
  $: if (enabled !== previousEnabled) {
    setListeningScrollLock(enabled);
    if (enabled) {
      // Entering Listening Mode at an arbitrary position is not an illustration
      // event. Arm the next future image without showing a past one.
      resetIllustrationCursorToTime($currentTime$, true);
      previousPlaybackTime = $currentTime$;
      scheduleMirrorRefresh();
    } else {
      settingsOpen = false;
      readerActionsOpen = false;
      lightboxOpen = false;
      displayedIllustration = undefined;
      displayedIllustrationUrl = '';
    }
    previousEnabled = enabled;
  }

  // A mode default is intentionally consulted once, when an audiobook is ready
  // for this local book. Changing the setting while the book is open never
  // unexpectedly switches the reader's current mode.
  $: if (localBookId !== defaultBookKey) {
    defaultBookKey = localBookId;
    defaultModeApplied = false;
    enabled = false;
    settingsOpen = false;
    readerActionsOpen = false;
    displayedIllustration = undefined;
    displayedIllustrationUrl = '';
    dismissedIllustrationId = undefined;
    illustrationCursor = -1;
    previousPlaybackTime = undefined;
    previousShowIllustrations = resolvedSettings.showIllustrations;
    lastIllustrationTimelineSignature = '';
    localIllustrationTimeline = [];
    localIllustrationTimelineKey = '';
    clearLocalIllustrationUrls();
    failedArtworkUrls.clear();
    artworkFailureVersion += 1;
    renderedWhispersyncCoverUrl = '';
    localAudioChapters = [];
    remoteChapterProbeKey = '';
    showTotalDuration = false;
    progressBarSessionOverride = undefined;
  }
  $: if (!defaultModeApplied && localBookId > 0 && sessionReadyForBook && hasAudio) {
    defaultModeApplied = true;
    enabled = resolvedSettings.openingMode === 'listening';
  }
  $: if (enabled && sessionReadyForBook && !hasAudio) enabled = false;

  $: if (contentRoot) {
    contentRoot.classList.toggle(
      'ttu-listening-reader-muted',
      enabled && !resolvedSettings.keepReaderActive
    );
  }
  $: if (hasAudio && (mediaSessionMetadataKey || $currentAudioSourceUrl$)) {
    updateMediaSession();
  }
  $: if (hasAudio) {
    updateMediaSessionPlaybackState($currentTime$, $duration$, $playbackRate$, $paused$);
  } else if (browser) {
    clearMediaSession();
  }
  $: if (enabled && (activeSubtitleId || $currentTime$ || resolvedSettings.showSentence)) {
    scheduleMirrorRefresh();
    updateEpubChapterTitleFromActiveLine();
  }
  $: if (
    $currentAudioFile$ !== embeddedAudioCoverFile ||
    Boolean($currentCoverUrl$) !== embeddedCoverStoreHadCover
  ) {
    embeddedCoverStoreHadCover = Boolean($currentCoverUrl$);
    void refreshEmbeddedAudioCover($currentAudioFile$, $currentCoverUrl$);
  }
  $: if ($currentCoverUrl$ || hasAudio) {
    scheduleRenderedWhispersyncCoverSync();
  }
  $: if ($currentAudioFile$ !== chapterProbeFile) {
    chapterProbeFile = $currentAudioFile$;
    chapterProbeRequest += 1;
    localAudioChapters = [];
    if (chapterProbeFile && !$activeCloudBook$?.audio?.chapters?.length) {
      // Listening Mode chapter navigation is independent of the legacy
      // WhisperSync "Enable chapters" preference. Keep our own extracted list
      // so that preference can clear currentAudioChapters$ without making the
      // listening player lose embedded MP3 chapters.
      void refreshLocalAudioChapters(chapterProbeFile);
    }
  }
  $: if (
    enabled &&
    !$currentAudioFile$ &&
    !$currentAudioChapters$.length &&
    !$activeCloudBook$?.audio?.chapters?.length &&
    $currentRemoteAudioFileName$ &&
    $currentAudioSourceUrl$
  ) {
    const probeKey = `${$activeCloudBook$?.id || ''}|${$currentRemoteAudioFileName$}`;
    if (probeKey !== remoteChapterProbeKey) {
      remoteChapterProbeKey = probeKey;
      void refreshRemoteAudioChapters(
        $currentAudioSourceUrl$,
        $currentRemoteAudioFileName$,
        probeKey
      );
    }
  }
  $: if (contentRoot && $currentSubtitles$.size) {
    ensureLocalIllustrationTimeline();
  }
  $: if ($audioSeeking$ !== previousAudioSeeking) {
    resetIllustrationCursorToTime($currentTime$, true);
    previousPlaybackTime = $currentTime$;
    suppressIllustrationJump = $audioSeeking$;
    previousAudioSeeking = $audioSeeking$;
  }
  $: if ($currentTime$ !== previousPlaybackTime) {
    updateIllustrationForTime($currentTime$);
  }

  onMount(() => {
    if (!browser) return;

    updateLocalCover();
    syncRenderedWhispersyncCover();
    findBookContent();
    const sectionListSubscription = sectionList$.subscribe((sections) => {
      epubSectionData = [...sections];
      updateEpubChapterTitleFromActiveLine();
    });
    return () => {
      sectionListSubscription.unsubscribe();
      if (contentLookupTimer) window.clearTimeout(contentLookupTimer);
      if (coverLookupTimer) window.clearTimeout(coverLookupTimer);
      if (mirrorFrame) window.cancelAnimationFrame(mirrorFrame);
      contentObserver?.disconnect();
      if (localCoverUrl.startsWith('blob:')) URL.revokeObjectURL(localCoverUrl);
      revokeEmbeddedAudioCover();
      clearLocalIllustrationUrls();
      clearMediaSession();
    };
  });

  onDestroy(() => {
    setListeningScrollLock(false);
    if (contentRoot) contentRoot.classList.remove('ttu-listening-reader-muted');
  });

  $: if (bookCover !== localCoverInput) updateLocalCover();

  function setListeningScrollLock(locked: boolean): void {
    if (!browser || locked === listeningScrollLocked) return;
    const root = document.documentElement;
    const body = document.body;
    if (locked) {
      previousDocumentOverflow = root.style.overflow;
      previousBodyOverflow = body.style.overflow;
      previousDocumentOverscroll = root.style.overscrollBehavior;
      previousBodyOverscroll = body.style.overscrollBehavior;
      root.style.overflow = 'hidden';
      body.style.overflow = 'hidden';
      root.style.overscrollBehavior = 'none';
      body.style.overscrollBehavior = 'none';
    } else {
      root.style.overflow = previousDocumentOverflow;
      body.style.overflow = previousBodyOverflow;
      root.style.overscrollBehavior = previousDocumentOverscroll;
      body.style.overscrollBehavior = previousBodyOverscroll;
    }
    listeningScrollLocked = locked;
  }

  function updateEpubChapterTitleFromActiveLine(): void {
    if (!contentRoot || !epubSectionData.length) {
      epubChapterTitle = '';
      return;
    }

    const id = $activeSubtitle$.current || $activeSubtitle$.previous;
    if (!id) {
      epubChapterTitle = '';
      return;
    }

    const source = contentRoot.querySelector<HTMLElement>(getLineCSSSelectorForId(id));
    if (!source) {
      epubChapterTitle = '';
      return;
    }

    const sectionByReference = new Map(
      epubSectionData.map((section) => [section.reference, section] as const)
    );

    let section: Section | undefined;
    let ancestor: HTMLElement | null = source;
    while (ancestor && contentRoot.contains(ancestor)) {
      if (ancestor.id && sectionByReference.has(ancestor.id)) {
        section = sectionByReference.get(ancestor.id);
        break;
      }
      ancestor = ancestor.parentElement;
    }

    if (!section) {
      section = epubSectionData.find((candidate) => {
        const sectionElement = document.getElementById(candidate.reference);
        return Boolean(sectionElement && sectionElement.contains(source));
      });
    }

    if (!section) {
      epubChapterTitle = '';
      return;
    }

    const mainReference = section.parentChapter || section.reference;
    const mainChapter = sectionByReference.get(mainReference);
    epubChapterTitle = mainChapter?.label?.trim() || section.label?.trim() || '';
  }


  function getChapterHeading(
    epubLabel: string,
    audioLabel: string | undefined,
    index: number,
    total: number,
    title: string
  ): string {
    const cleanTitle = title.trim();
    // Listening Mode follows the audiobook timeline first. The EPUB heading is
    // a fallback for files without embedded chapter metadata.
    const cleanAudioLabel = audioLabel?.trim() || '';
    if (
      cleanAudioLabel &&
      cleanAudioLabel.localeCompare(cleanTitle, undefined, { sensitivity: 'base' }) !== 0
    ) {
      return cleanAudioLabel;
    }

    const cleanEpubLabel = epubLabel.trim();
    if (
      cleanEpubLabel &&
      cleanEpubLabel.localeCompare(cleanTitle, undefined, { sensitivity: 'base' }) !== 0
    ) {
      return cleanEpubLabel;
    }

    return total > 1 ? `Chapter ${index + 1}` : '';
  }

  function findBookContent() {
    contentRoot = document.querySelector<HTMLDivElement>('.book-content') || undefined;
    if (!contentRoot) {
      contentLookupTimer = window.setTimeout(findBookContent, 100);
      return;
    }

    contentObserver = new MutationObserver(() => {
      scheduleMirrorRefresh();
      updateEpubChapterTitleFromActiveLine();
      ensureLocalIllustrationTimeline();
    });
    contentObserver.observe(contentRoot, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true
    });
    scheduleMirrorRefresh();
    updateEpubChapterTitleFromActiveLine();
  }

  function clearLocalIllustrationUrls(): void {
    if (!browser) return;
    localIllustrationUrls.forEach((url) => URL.revokeObjectURL(url));
    localIllustrationUrls.clear();
  }

  function uniqueArtworkUrls(urls: Array<string | undefined>): string[] {
    return [...new Set(urls.map((url) => url?.trim() || '').filter(Boolean))];
  }

  function firstWorkingArtwork(urls: string[], _failureVersion: number): string {
    return urls.find((url) => !failedArtworkUrls.has(url)) || '';
  }

  function markArtworkFailed(url: string): void {
    if (!url || failedArtworkUrls.has(url)) return;
    failedArtworkUrls.add(url);
    artworkFailureVersion += 1;
    console.warn('Listening Mode artwork failed to load; trying fallback:', url);
  }

  function markArtworkLoaded(url: string): void {
    if (!url || !failedArtworkUrls.has(url)) return;
    failedArtworkUrls.delete(url);
    artworkFailureVersion += 1;
  }

  function syncRenderedWhispersyncCover(): void {
    if (!browser) return;
    const image = document.querySelector<HTMLImageElement>('#ttu-whispersync-cover');
    const nextUrl = image?.currentSrc || image?.src || '';
    if (nextUrl && nextUrl !== renderedWhispersyncCoverUrl) {
      renderedWhispersyncCoverUrl = nextUrl;
    }
  }

  function scheduleRenderedWhispersyncCoverSync(): void {
    if (!browser || coverLookupTimer) return;
    coverLookupTimer = window.setTimeout(() => {
      coverLookupTimer = undefined;
      syncRenderedWhispersyncCover();
    }, 0);
  }

  function updateLocalCover() {
    if (!browser || bookCover === localCoverInput) return;
    if (localCoverUrl.startsWith('blob:')) URL.revokeObjectURL(localCoverUrl);
    localCoverInput = bookCover;
    localCoverUrl = bookCover instanceof Blob ? URL.createObjectURL(bookCover) : bookCover || '';
  }

  async function refreshEmbeddedAudioCover(file: File | undefined, existingCoverUrl: string) {
    if (!browser) return;
    if (existingCoverUrl) {
      embeddedAudioCoverFile = file;
      revokeEmbeddedAudioCover();
      return;
    }
    if (!file) {
      embeddedAudioCoverFile = undefined;
      revokeEmbeddedAudioCover();
      return;
    }

    embeddedAudioCoverFile = file;
    const request = ++embeddedAudioCoverRequest;
    const nextUrl = await getEmbeddedAudioCoverUrl(file);
    if (request !== embeddedAudioCoverRequest || file !== $currentAudioFile$) {
      if (nextUrl.startsWith('blob:')) URL.revokeObjectURL(nextUrl);
      return;
    }
    revokeEmbeddedAudioCover(false);
    embeddedAudioCoverUrl = nextUrl;
  }

  function revokeEmbeddedAudioCover(invalidateRequest = true) {
    if (invalidateRequest) embeddedAudioCoverRequest += 1;
    if (embeddedAudioCoverUrl.startsWith('blob:')) URL.revokeObjectURL(embeddedAudioCoverUrl);
    embeddedAudioCoverUrl = '';
  }

  async function refreshLocalAudioChapters(file: File): Promise<void> {
    const request = ++chapterProbeRequest;
    const chapters = await getEmbeddedAudioChapters(file).catch(() => []);
    if (request !== chapterProbeRequest || file !== $currentAudioFile$ || !chapters.length) return;
    localAudioChapters = chapters;
    void persistDiscoveredCloudChapters(chapters);
  }

  async function refreshRemoteAudioChapters(
    url: string,
    fileName: string,
    probeKey: string
  ): Promise<void> {
    if (!/\.mp3$/i.test(fileName)) return;
    const chapters = await getRemoteMp3Id3Chapters(url, fileName).catch(() => []);
    if (probeKey !== remoteChapterProbeKey || !chapters.length) return;
    localAudioChapters = chapters;
    currentAudioChapters$.set(chapters);
    void persistDiscoveredCloudChapters(chapters);
  }

  async function persistDiscoveredCloudChapters(chapters: AudioChapter[]): Promise<void> {
    const book = $activeCloudBook$;
    if (!book?.assets.audio || book.audio?.chapters?.length || !chapters.length) return;
    try {
      await saveCloudBookAudioChapters(book.id, chapters, $duration$ || book.audio?.duration);
    } catch {
      // Chapter backfill is an optimization. The local player can keep using
      // the extracted list if a write is temporarily unavailable/rate-limited.
    }
  }

  function ensureLocalIllustrationTimeline() {
    if (!contentRoot || !$currentSubtitles$.size) return;
    const subtitleSignature = [...$currentSubtitles$.values()]
      .map((subtitle) => `${subtitle.id}:${subtitle.startSeconds}:${subtitle.endSeconds}`)
      .join('|');
    const key = `${localBookId}|${subtitleSignature.length}|${contentRoot.querySelectorAll('img, svg image').length}|${contentRoot.querySelectorAll(getLineCSSSelector()).length}`;
    if (key === localIllustrationTimelineKey) return;
    localIllustrationTimelineKey = key;
    localIllustrationTimeline = inferIllustrationTimeline(
      contentRoot.innerHTML,
      [...$currentSubtitles$.values()],
      document
    );
  }

  function getCurrentSentence(id: string, time: number): Subtitle | undefined {
    if (id) {
      const active = $currentSubtitles$.get(id);
      if (active) return active;
    }
    return [...$currentSubtitles$.values()].find(
      (subtitle) => subtitle.startSeconds <= time && subtitle.endSeconds >= time
    );
  }

  function scheduleMirrorRefresh() {
    if (!browser || !mirrorElement || mirrorFrame) return;
    mirrorFrame = window.requestAnimationFrame(() => {
      mirrorFrame = undefined;
      refreshSentenceMirror();
    });
  }

  function refreshSentenceMirror() {
    if (!mirrorElement) return;
    while (mirrorElement.firstChild) mirrorElement.removeChild(mirrorElement.firstChild);
    mirrorHasContent = false;
    if (!enabled || !resolvedSettings.showSentence || !contentRoot) return;

    const id = $activeSubtitle$.current || $activeSubtitle$.previous;
    // Scope the lookup to the real reader. The mirror intentionally keeps the
    // Whispersync line classes, so a document-wide query would otherwise start
    // cloning the mirror itself on the next MutationObserver pass.
    const sourceElements = id
      ? [...contentRoot.querySelectorAll<HTMLElement>(getLineCSSSelectorForId(id))]
      : [];
    const seen = new Set<Element>();
    for (const element of sourceElements) {
      const closestRuby = element.closest('ruby');
      const source = closestRuby && contentRoot.contains(closestRuby) ? closestRuby : element;
      if (seen.has(source)) continue;
      seen.add(source);
      const clone = cloneSentenceForListening(source as HTMLElement);
      mirrorElement.appendChild(clone);
    }
    mirrorHasContent = mirrorElement.childNodes.length > 0;
  }

  function cloneSentenceForListening(source: HTMLElement): HTMLElement {
    const clone = source.cloneNode(true) as HTMLElement;
    copyExtensionVisualStyles(source, clone);
    stripWhisperSyncHighlightPresentation(clone);
    stripDuplicateIds(clone);
    clone.classList.add('ttu-listening-mirror-line');
    forceHorizontalWriting(clone);
    return clone;
  }

  function stripWhisperSyncHighlightPresentation(root: HTMLElement): void {
    const elements = [root, ...root.querySelectorAll<HTMLElement>('*')];
    for (const element of elements) {
      const isWhisperSyncLine = [...element.classList].some((name) =>
        name.startsWith('ttu-whispersync-line-highlight-')
      );
      const isWhisperSyncDecoration = [...element.classList].some((name) =>
        name.startsWith('ttu-whispersync-highlight-')
      );
      element.classList.remove('active', 'menu-open');
      if (!isWhisperSyncLine && !isWhisperSyncDecoration) continue;
      element.classList.remove(
        'ttu-whispersync-highlight-segment',
        'ttu-whispersync-highlight-start',
        'ttu-whispersync-highlight-end',
        'ttu-whispersync-highlight-annotation'
      );
      // These properties are generated by WhisperSync's active-line CSS.
      // Nested extension-added spans remain untouched, so SRS underlines and
      // other third-party markup/styles still survive in the mirrored sentence.
      for (const property of ['background-color', 'box-shadow', 'border-radius']) {
        element.style.removeProperty(property);
      }
      if (isWhisperSyncLine) element.style.removeProperty('color');
    }
  }

  function forceHorizontalWriting(root: HTMLElement): void {
    [root, ...root.querySelectorAll<HTMLElement>('*')].forEach((element) => {
      element.style.setProperty('writing-mode', 'horizontal-tb', 'important');
      element.style.setProperty('text-orientation', 'mixed', 'important');
    });
  }

  /**
   * cloneNode preserves extension-inserted spans/classes/inline styles, but CSS
   * selectors that depend on the reader's ancestor tree may no longer match in
   * the Listening overlay. Copy a small set of computed visual properties so
   * word colours/underlines/highlights survive without importing the reader's
   * vertical layout, positioning or dimensions.
   */
  function copyExtensionVisualStyles(source: HTMLElement, clone: HTMLElement): void {
    if (!browser) return;
    const sources = [source, ...source.querySelectorAll<HTMLElement>('*')];
    const clones = [clone, ...clone.querySelectorAll<HTMLElement>('*')];
    for (let index = 0; index < Math.min(sources.length, clones.length); index += 1) {
      const sourceElement = sources[index];
      const computed = window.getComputedStyle(sourceElement);
      const parentComputed = sourceElement.parentElement
        ? window.getComputedStyle(sourceElement.parentElement)
        : undefined;
      const target = clones[index];
      for (const property of mirrorVisualStyleProperties) {
        const value = computed.getPropertyValue(property);
        if (shouldCopyMirrorStyle(property, value, parentComputed)) {
          target.style.setProperty(property, value, 'important');
        }
      }
    }
  }

  function shouldCopyMirrorStyle(
    property: (typeof mirrorVisualStyleProperties)[number],
    value: string,
    parentComputed: CSSStyleDeclaration | undefined
  ): boolean {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return false;

    if (
      property === 'color' ||
      property === 'font-weight' ||
      property === 'font-style' ||
      property === 'font-family' ||
      property === 'font-size' ||
      property === 'letter-spacing'
    ) {
      return normalized !== parentComputed?.getPropertyValue(property).trim().toLowerCase();
    }
    if (property === 'background-color') {
      return normalized !== 'transparent' && normalized !== 'rgba(0, 0, 0, 0)';
    }
    if (property === 'text-shadow' || property === 'box-shadow') return normalized !== 'none';
    if (property === 'opacity') return normalized !== '1';
    if (property === 'text-decoration-line') return normalized !== 'none';
    if (property === 'text-emphasis-style' || property === '-webkit-text-emphasis-style') {
      return normalized !== 'none';
    }
    if (property === 'border-bottom-width') return normalized !== '0px';

    // Decoration colours/styles/thickness and border details only matter when an
    // associated decoration exists; harmless defaults are skipped to avoid
    // importing the reader theme into the Listening overlay.
    if (property.startsWith('text-decoration-')) {
      return computedDecorationIsActive(parentComputed, 'text-decoration-line') || normalized !== 'none';
    }
    if (property.startsWith('border-bottom-')) {
      return normalized !== 'none' && normalized !== '0px' && normalized !== 'rgba(0, 0, 0, 0)';
    }
    if (property.includes('text-emphasis-')) {
      return computedDecorationIsActive(parentComputed, 'text-emphasis-style') || normalized !== 'none';
    }
    return true;
  }

  function computedDecorationIsActive(
    computed: CSSStyleDeclaration | undefined,
    property: string
  ): boolean {
    const value = computed?.getPropertyValue(property).trim().toLowerCase();
    return Boolean(value && value !== 'none');
  }

  function stripDuplicateIds(root: HTMLElement): void {
    root.removeAttribute('id');
    root.querySelectorAll<HTMLElement>('[id]').forEach((element) => element.removeAttribute('id'));
  }

  function updateIllustrationForTime(time: number) {
    if (!Number.isFinite(time)) return;

    if (previousPlaybackTime === undefined) {
      resetIllustrationCursorToTime(time, true);
      previousPlaybackTime = time;
      return;
    }

    const delta = time - previousPlaybackTime;
    const looksLikeSeek =
      $audioSeeking$ ||
      suppressIllustrationJump ||
      $paused$ ||
      delta < -0.05 ||
      delta > Math.max(3, ($playbackRate$ || 1) * 2.5);

    if (looksLikeSeek) {
      resetIllustrationCursorToTime(time, true);
      suppressIllustrationJump = false;
      previousPlaybackTime = time;
      return;
    }

    if (delta <= 0) {
      previousPlaybackTime = time;
      return;
    }

    // Only a forward, naturally-playing crossing can surface an illustration.
    // Opening the player, restoring progress, or seeking beyond an image merely
    // arms the next future trigger and never displays a past image.
    const crossed = illustrationEntries.filter(
      (entry) =>
        entry.triggerSeconds > previousPlaybackTime! &&
        entry.triggerSeconds <= time + 0.001
    );
    if (enabled && crossed.length) {
      const nextIllustration = crossed[crossed.length - 1];
      const wasDismissed = dismissedIllustrationId === nextIllustration.id;
      if (dismissedIllustrationId && !wasDismissed) dismissedIllustrationId = undefined;

      if (!wasDismissed && resolvedSettings.illustrationNotification) {
        playIllustrationNotification();
      }
      if (!wasDismissed && resolvedSettings.showIllustrations) {
        const nextIllustrationUrl = resolveIllustrationUrl(nextIllustration);
        if (nextIllustrationUrl) {
          displayedIllustration = nextIllustration;
          displayedIllustrationUrl = nextIllustrationUrl;
        }
      }
    }

    resetIllustrationCursorToTime(time, false);
    previousPlaybackTime = time;
  }

  function resetIllustrationCursorToTime(time: number, clearDisplay: boolean): void {
    const nextIndex = illustrationEntries.findIndex((entry) => entry.triggerSeconds > time);
    illustrationCursor = nextIndex === -1 ? illustrationEntries.length - 1 : nextIndex - 1;
    if (clearDisplay) {
      displayedIllustration = undefined;
      displayedIllustrationUrl = '';
    }
  }

  function resolveIllustrationUrl(entry: IllustrationTimelineEntry): string {
    if (entry.href.startsWith('data:') && !entry.resourceKey) return entry.href;
    const resourceKey = normalizeResourceKey(entry.resourceKey || entry.href);
    const matchingBlob = Object.entries(bookBlobs).find(([key]) => {
      const normalizedKey = normalizeResourceKey(key);
      return (
        normalizedKey === resourceKey ||
        normalizedKey.endsWith(`/${resourceKey}`) ||
        resourceKey.endsWith(`/${normalizedKey}`)
      );
    });
    if (matchingBlob) {
      const existing = localIllustrationUrls.get(matchingBlob[0]);
      if (existing) return existing;
      const url = URL.createObjectURL(matchingBlob[1]);
      localIllustrationUrls.set(matchingBlob[0], url);
      return url;
    }

    const renderedImage = [
      ...(contentRoot?.querySelectorAll<HTMLElement>('img, svg image') || [])
    ].find((image) => {
      const key = image.getAttribute('data-ttu-book-image-key');
      const source = image.getAttribute('src') || image.getAttribute('href') || '';
      return (key && normalizeResourceKey(key) === resourceKey) || source === entry.href;
    });
    return (
      renderedImage?.getAttribute('src') ||
      renderedImage?.getAttribute('href') ||
      (!entry.href.includes('ttu:') ? entry.href : '')
    );
  }

  function normalizeResourceKey(value: string): string {
    const marker = value.match(/(?:^|[;?])ttu:([^;?"']+)/i)?.[1] || value;
    try {
      return decodeURIComponent(marker).replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
    } catch {
      return marker.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase();
    }
  }

  function seekTo(seconds: number, subtitle?: Subtitle) {
    const target = Math.min(Math.max(0, seconds), $duration$ || Math.max(0, seconds));
    suppressIllustrationJump = true;
    resetIllustrationCursorToTime(target, true);
    previousPlaybackTime = target;
    executeAction(Action.RESTART_PLAYBACK, subtitle || getDummySubtitle(target), {
      keepPauseState: true
    });
    document.dispatchEvent(new CustomEvent('ttu-cloud:audiobook-user-activity'));
  }

  function togglePlayback() {
    $paused$ = !$paused$;
    document.dispatchEvent(new CustomEvent('ttu-cloud:audiobook-user-activity'));
  }

  function skipBy(seconds: number) {
    seekTo(($currentTime$ || 0) + seconds);
  }

  function currentSubtitleIndex(): number {
    const activeIndex = sortedSubtitles.findIndex((subtitle) => subtitle.id === activeSubtitleId);
    if (activeIndex >= 0) return activeIndex;
    const nextIndex = sortedSubtitles.findIndex((subtitle) => subtitle.startSeconds > $currentTime$);
    return nextIndex === -1 ? sortedSubtitles.length - 1 : Math.max(0, nextIndex - 1);
  }

  function seekPreviousSubtitle() {
    if (!sortedSubtitles.length) return;
    const index = currentSubtitleIndex();
    const target = sortedSubtitles[Math.max(0, index - 1)];
    if (target) seekTo(target.startSeconds, target);
  }

  function seekNextSubtitle() {
    if (!sortedSubtitles.length) return;
    const index = currentSubtitleIndex();
    const target = sortedSubtitles[Math.min(sortedSubtitles.length - 1, index + 1)];
    if (target) seekTo(target.startSeconds, target);
  }

  $: sortedSubtitles = [...$currentSubtitles$.values()].sort(
    (first, second) => first.startSeconds - second.startSeconds
  );

  function seekFromProgress(event: Event) {
    const value = Number((event.currentTarget as HTMLInputElement).value);
    if (Number.isFinite(value)) seekTo(value);
  }

  function toggleChapterList(): void {
    if (!chapterList.length) return;
    chaptersOpen = !chaptersOpen;
    if (chaptersOpen) positionChapterPopover();
  }

  function positionChapterPopover(): void {
    if (!browser || !chaptersOpen || !chapterAnchorEl) return;

    const anchor = chapterAnchorEl.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const edge = 12;
    const gap = 10;
    const width = Math.min(416, Math.max(240, viewportWidth - edge * 2));
    const desiredHeight = Math.min(352, Math.max(180, viewportHeight * 0.46));
    const belowSpace = Math.max(0, viewportHeight - anchor.bottom - gap - edge);
    const aboveSpace = Math.max(0, anchor.top - gap - edge);
    const openBelow = belowSpace >= Math.min(desiredHeight, 220) || belowSpace >= aboveSpace;
    const available = openBelow ? belowSpace : aboveSpace;
    const maxHeight = Math.max(120, Math.min(desiredHeight, available));
    const center = anchor.left + anchor.width / 2;
    const halfWidth = width / 2;
    const left = Math.min(
      viewportWidth - edge - halfWidth,
      Math.max(edge + halfWidth, center)
    );
    const top = openBelow
      ? Math.min(viewportHeight - edge - maxHeight, anchor.bottom + gap)
      : Math.max(edge, anchor.top - gap - maxHeight);

    chapterPopoverMaxHeight = maxHeight;
    chapterPopoverStyle = `left:${left}px;top:${top}px;width:${width}px;`;
  }

  function formatTime(value: number) {
    const seconds = Math.max(0, Math.round(value || 0));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remaining = seconds % 60;
    return hours
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
      : `${minutes}:${String(remaining).padStart(2, '0')}`;
  }


  function clampPlaybackRate(value: number): number {
    if (!Number.isFinite(value)) return Math.max(0.25, Math.min(4, $playbackRate$ || 1));
    return Math.max(0.25, Math.min(4, value));
  }

  function formatPlaybackRate(value: number): string {
    const rounded = Math.round(clampPlaybackRate(value) * 100) / 100;
    return Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(/0+$/, '');
  }

  function setPlaybackRate(value: number): void {
    const next = Math.round(clampPlaybackRate(value) * 100) / 100;
    $playbackRate$ = next;
    speedDraft = formatPlaybackRate(next);
    persistPlaybackRateToCloud();
  }

  function persistPlaybackRateToCloud(): void {
    document.dispatchEvent(new CustomEvent('ttu-cloud:audiobook-user-activity'));
    if (!$activeCloudBook$) return;
    document.dispatchEvent(
      new CustomEvent('ttu-cloud:audiobook-progress', {
        detail: {
          seconds: $currentTime$ || 0,
          duration: $duration$ || undefined,
          playbackRate: $playbackRate$,
          paused: $paused$
        }
      })
    );
    // A speed change is a deliberate per-book preference change. Flush it now
    // even while paused instead of waiting for a later timeupdate.
    document.dispatchEvent(new CustomEvent('ttu-cloud:flush-audiobook-progress'));
  }

  function nudgePlaybackRate(delta: number): void {
    const source = Number(speedDraft);
    setPlaybackRate((Number.isFinite(source) ? source : $playbackRate$ || 1) + delta);
  }

  function commitSpeedDraft(): void {
    const parsed = Number(speedDraft);
    if (!Number.isFinite(parsed)) {
      speedDraft = formatPlaybackRate($playbackRate$);
      return;
    }
    setPlaybackRate(parsed);
  }

  function onSpeedKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitSpeedDraft();
      (event.currentTarget as HTMLInputElement).blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      speedDraft = formatPlaybackRate($playbackRate$);
      speedOpen = false;
    }
  }

  function exitToReading() {
    enabled = false;
    settingsOpen = false;
    speedOpen = false;
    chaptersOpen = false;
    window.setTimeout(() =>
      document.dispatchEvent(new CustomEvent('ttu-whispersync:scroll-to-current'))
    );
  }

  type ReaderAction =
    | 'bookmarkClick'
    | 'fullscreenClick'
    | 'statisticsClick'
    | 'readerImageGalleryClick'
    | 'readerSettingsClick'
    | 'bookManagerClick'
    | 'completeBook';

  function runReaderAction(action: ReaderAction): void {
    readerActionsOpen = false;
    settingsOpen = false;
    dispatch(action);
  }

  function selectSetting(field: keyof CloudListeningSettings, value: string): void {
    const parsedValue = parseSettingValue(field, value);
    if (field === 'progressBar') {
      progressBarSessionOverride =
        parsedValue === null ? undefined : (parsedValue as ListeningProgressBar);
    }
    const parsed: CloudListeningSettingsPatch = {
      [field]: parsedValue
    } as CloudListeningSettingsPatch;
    settingsError = '';
    const book = $activeCloudBook$;
    if (!book) return;
    void saveCloudBookListeningSettings(book.id, parsed).catch((error: unknown) => {
      settingsError = error instanceof Error ? error.message : String(error);
    });
  }

  function toggleProgressBar(): void {
    const nextMode: ListeningProgressBar = effectiveProgressBar === 'chapter' ? 'book' : 'chapter';
    progressBarSessionOverride = nextMode;
    settingsError = '';
    const book = $activeCloudBook$;
    if (!book) return;
    void saveCloudBookListeningSettings(book.id, { progressBar: nextMode }).catch((error: unknown) => {
      settingsError = error instanceof Error ? error.message : String(error);
    });
  }

  function parseSettingValue(
    field: keyof CloudListeningSettings,
    value: string
  ): ListeningOpeningMode | ListeningProgressBar | boolean | number | null {
    if (!value) return null;
    if (field === 'openingMode') return value as ListeningOpeningMode;
    if (field === 'progressBar') return value as ListeningProgressBar;
    if (field === 'skipSeconds') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.max(1, Math.min(120, Math.round(parsed))) : null;
    }
    return value === 'true';
  }

  function settingValue(field: keyof CloudListeningSettings): string {
    const value = $activeCloudBook$?.listeningSettings?.[field];
    return value === null || value === undefined ? '' : String(value);
  }

  function playIllustrationNotification() {
    if (!browser) return;
    const AudioContextConstructor =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) return;
    try {
      const context = new AudioContextConstructor();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = 660;
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.05, context.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.18);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.2);
      oscillator.addEventListener('ended', () => void context.close());
    } catch {
      // Browsers may reject an audio context until a user gesture. Playback is
      // never interrupted by a best-effort notification.
    }
  }

  function updateMediaSession() {
    if (!browser || !('mediaSession' in navigator)) return;
    const mediaSession = (navigator as Navigator & { mediaSession?: any }).mediaSession;
    if (!mediaSession) return;
    try {
      mediaSession.metadata = new MediaMetadata({
        title: resolvedTitle,
        artist: resolvedAuthor || 'Cloud Reader',
        album: currentChapter?.label || resolvedTitle,
        artwork: baseArtworkUrl ? [{ src: baseArtworkUrl }] : []
      });
      mediaSession.setActionHandler('play', () => {
        $paused$ = false;
        document.dispatchEvent(new CustomEvent('ttu-cloud:audiobook-user-activity'));
      });
      mediaSession.setActionHandler('pause', () => {
        $paused$ = true;
        document.dispatchEvent(new CustomEvent('ttu-cloud:audiobook-user-activity'));
        document.dispatchEvent(new CustomEvent('ttu-cloud:flush-audiobook-progress'));
      });
      mediaSession.setActionHandler('seekbackward', (event: any) =>
        skipBy(-(event.seekOffset || resolvedSettings.skipSeconds))
      );
      mediaSession.setActionHandler('seekforward', (event: any) =>
        skipBy(event.seekOffset || resolvedSettings.skipSeconds)
      );
      mediaSession.setActionHandler('seekto', (event: any) => {
        if (Number.isFinite(event.seekTime)) seekTo(event.seekTime);
      });
    } catch {
      // Media Session is optional and differs between browsers.
    }
  }

  function updateMediaSessionPlaybackState(
    position: number,
    duration: number,
    playbackRate: number,
    paused: boolean
  ): void {
    if (!browser || !('mediaSession' in navigator)) return;
    const mediaSession = (navigator as Navigator & { mediaSession?: any }).mediaSession;
    if (!mediaSession) return;
    try {
      mediaSession.playbackState = paused ? 'paused' : 'playing';
      if (Number.isFinite(duration) && duration > 0 && Number.isFinite(position)) {
        mediaSession.setPositionState({
          duration,
          playbackRate: Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1,
          position: Math.min(Math.max(0, position), Math.max(0, duration - 0.001))
        });
      }
    } catch {
      // Optional API; unsupported browsers simply keep the normal audio controls.
    }
  }

  function clearMediaSession() {
    if (!browser || !('mediaSession' in navigator)) return;
    const mediaSession = (navigator as Navigator & { mediaSession?: any }).mediaSession;
    if (!mediaSession) return;
    try {
      mediaSession.metadata = null;
      mediaSession.playbackState = 'none';
      mediaSession.setPositionState();
    } catch {
      // Optional fields vary between browsers.
    }
    for (const action of settingActions) {
      try {
        mediaSession.setActionHandler(action, null);
      } catch {
        // no-op
      }
    }
  }

  function openLightbox() {
    if (!displayedIllustrationUrl) return;
    resetLightboxTransform();
    lightboxOpen = true;
  }

  function closeLightbox() {
    lightboxOpen = false;
    resetLightboxTransform();
  }

  function resetLightboxTransform() {
    lightboxZoom = 1;
    lightboxPanX = 0;
    lightboxPanY = 0;
    dragActive = false;
    lightboxPointers.clear();
    pinchStartDistance = 0;
  }

  function dismissIllustration() {
    dismissedIllustrationId = displayedIllustration?.id;
    displayedIllustration = undefined;
    displayedIllustrationUrl = '';
  }

  function clampLightboxZoom(value: number): number {
    return Math.min(5, Math.max(1, value));
  }

  function lightboxPointerDistance(points: Array<{ x: number; y: number }>): number {
    return Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
  }

  function lightboxPointerCenter(points: Array<{ x: number; y: number }>): { x: number; y: number } {
    return { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
  }

  function beginPinch() {
    const points = [...lightboxPointers.values()];
    if (points.length < 2) return;
    pinchStartDistance = Math.max(1, lightboxPointerDistance(points));
    pinchStartZoom = lightboxZoom;
    const center = lightboxPointerCenter(points);
    pinchStartCenterX = center.x;
    pinchStartCenterY = center.y;
    pinchStartPanX = lightboxPanX;
    pinchStartPanY = lightboxPanY;
    dragActive = false;
  }

  function startDrag(event: PointerEvent) {
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture?.(event.pointerId);
    lightboxPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (lightboxPointers.size >= 2) {
      beginPinch();
      return;
    }

    dragActive = lightboxZoom > 1;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    dragOriginX = lightboxPanX;
    dragOriginY = lightboxPanY;
  }

  function moveDrag(event: PointerEvent) {
    if (!lightboxPointers.has(event.pointerId)) return;
    lightboxPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (lightboxPointers.size >= 2) {
      const points = [...lightboxPointers.values()].slice(0, 2);
      if (!pinchStartDistance) beginPinch();
      const distance = Math.max(1, lightboxPointerDistance(points));
      const center = lightboxPointerCenter(points);
      lightboxZoom = clampLightboxZoom(pinchStartZoom * (distance / pinchStartDistance));
      lightboxPanX = pinchStartPanX + (center.x - pinchStartCenterX);
      lightboxPanY = pinchStartPanY + (center.y - pinchStartCenterY);
      if (lightboxZoom <= 1.001) {
        lightboxZoom = 1;
        lightboxPanX = 0;
        lightboxPanY = 0;
      }
      return;
    }

    if (!dragActive || lightboxZoom <= 1) return;
    lightboxPanX = dragOriginX + event.clientX - dragStartX;
    lightboxPanY = dragOriginY + event.clientY - dragStartY;
  }

  function stopDrag(event?: PointerEvent) {
    if (event) lightboxPointers.delete(event.pointerId);
    if (lightboxPointers.size >= 2) {
      beginPinch();
      return;
    }
    pinchStartDistance = 0;
    if (lightboxPointers.size === 1) {
      const point = [...lightboxPointers.values()][0];
      dragActive = lightboxZoom > 1;
      dragStartX = point.x;
      dragStartY = point.y;
      dragOriginX = lightboxPanX;
      dragOriginY = lightboxPanY;
    } else {
      dragActive = false;
    }
  }

  function zoomLightboxAt(clientX: number, clientY: number, nextZoom: number, stage: HTMLElement) {
    const clamped = clampLightboxZoom(nextZoom);
    if (clamped <= 1.001) {
      lightboxZoom = 1;
      lightboxPanX = 0;
      lightboxPanY = 0;
      return;
    }

    const rect = stage.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const oldZoom = Math.max(1, lightboxZoom);
    const localX = (clientX - centerX - lightboxPanX) / oldZoom;
    const localY = (clientY - centerY - lightboxPanY) / oldZoom;
    lightboxPanX = clientX - centerX - localX * clamped;
    lightboxPanY = clientY - centerY - localY * clamped;
    lightboxZoom = clamped;
  }

  function onLightboxWheel(event: WheelEvent) {
    event.preventDefault();
    const stage = event.currentTarget as HTMLElement;
    const factor = Math.exp(-event.deltaY * 0.0015);
    zoomLightboxAt(event.clientX, event.clientY, lightboxZoom * factor, stage);
  }

  function onLightboxStageClick(event: MouseEvent) {
    if (event.target === event.currentTarget && lightboxZoom === 1) closeLightbox();
  }

  function onKeydown(event: KeyboardEvent) {
    if (!enabled) return;
    if (event.key === 'Escape' && lightboxOpen) {
      event.preventDefault();
      closeLightbox();
      return;
    }
    if (lightboxOpen || isInteractiveKeyboardTarget(event.target)) return;

    if (event.key === ' ') {
      event.preventDefault();
      togglePlayback();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      skipBy(-resolvedSettings.skipSeconds);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      skipBy(resolvedSettings.skipSeconds);
    }
  }

  function isInteractiveKeyboardTarget(target: EventTarget | null): boolean {
    return (
      target instanceof HTMLElement &&
      Boolean(target.closest('button, input, select, textarea, a, [contenteditable="true"]'))
    );
  }
</script>

<svelte:window on:keydown={onKeydown} on:resize={positionChapterPopover} />

{#if enabled}
  <section
    class="listening-mode-shell writing-horizontal-tb fixed inset-0 z-50 overflow-hidden text-white"
    aria-label="Listening Mode"
  >
    <div
      class="listening-mode-backdrop fixed inset-0"
      style={baseArtworkUrl ? `background-image: url("${baseArtworkUrl}")` : ''}
    />
    <div class="listening-mode-scrim fixed inset-0" />

    <div class="relative mx-auto flex min-h-full w-full max-w-5xl flex-col px-4 pb-5 pt-3 sm:px-8">
      <header class="flex items-center justify-between gap-3">
        <div class="flex min-w-0 items-center gap-3">
          <div class="rounded-full bg-white/15 p-2"><Fa icon={faHeadphones} /></div>
          <div class="min-w-0">
            <div class="text-xs uppercase tracking-[0.24em] text-white/65">Listening Mode</div>
            <div class="truncate text-sm font-medium sm:text-base">{resolvedTitle}</div>
          </div>
        </div>
        <div class="flex items-center gap-1">
          <button
            class="listening-icon-button"
            title="Create Bookmark"
            aria-label="Create Bookmark"
            on:click={() => runReaderAction('bookmarkClick')}
          >
            <Fa icon={farBookmark} />
          </button>
          <div
            class="relative"
            use:clickOutside={() => (readerActionsOpen = false)}
          >
            <button
              class="listening-icon-button"
              title="Reader actions"
              aria-label="Reader actions"
              aria-expanded={readerActionsOpen}
              on:click={() => (readerActionsOpen = !readerActionsOpen)}
            >
              <Fa icon={faEllipsisVertical} />
            </button>
            {#if readerActionsOpen}
              <div class="listening-reader-actions absolute right-0 top-full z-20 mt-2 w-52 overflow-hidden rounded-xl py-1 shadow-2xl">
                {#if showFullscreenButton}
                  <button on:click={() => runReaderAction('fullscreenClick')}><Fa icon={faExpand} /><span>Toggle fullscreen</span></button>
                {/if}
                <button on:click={() => runReaderAction('statisticsClick')}><Fa icon={faChartColumn} /><span>Statistics</span></button>
                {#if hasImageGallery}
                  <button on:click={() => runReaderAction('readerImageGalleryClick')}><Fa icon={faImages} /><span>Image gallery</span></button>
                {/if}
                <button on:click={() => runReaderAction('readerSettingsClick')}><Fa icon={faGear} /><span>Reader settings</span></button>
                <button on:click={() => runReaderAction('completeBook')}><Fa icon={faFlag} /><span>Complete book</span></button>
                <button on:click={() => runReaderAction('bookManagerClick')}><Fa icon={faBookOpen} /><span>Manage books</span></button>
              </div>
            {/if}
          </div>
          <button
            class="listening-icon-button"
            title="Listening settings"
            aria-label="Listening settings"
            on:click={() => {
              readerActionsOpen = false;
              settingsOpen = !settingsOpen;
            }}><Fa icon={faGear} /></button
          >
          <button
            class="listening-icon-button"
            title="Return to Reading Mode"
            aria-label="Return to Reading Mode"
            on:click={exitToReading}><Fa icon={faBookOpen} /></button
          >
        </div>
      </header>

      {#if settingsOpen}
        <div class="listening-settings-panel mt-3 rounded-2xl p-4 shadow-xl">
          <div class="mb-3 flex items-center justify-between">
            <h2 class="font-semibold">This book</h2>
            <button
              class="listening-icon-button"
              aria-label="Close settings"
              on:click={() => (settingsOpen = false)}
            >
              <Fa icon={faXmark} />
            </button>
          </div>
          {#if $activeCloudBook$}
            <div class="grid gap-3 sm:grid-cols-2">
              <label
                >Opening mode
                <select
                  value={settingValue('openingMode')}
                  on:change={(event) => selectSetting('openingMode', event.currentTarget.value)}
                >
                  <option value=""
                    >Inherit: {localListeningDefaults.openingMode === 'reading'
                      ? 'Reading'
                      : 'Listening'}</option
                  >
                  <option value="reading">Reading</option>
                  <option value="listening">Listening</option>
                </select>
              </label>
              <label
                >Progress bar
                <select
                  value={settingValue('progressBar')}
                  on:change={(event) => selectSetting('progressBar', event.currentTarget.value)}
                >
                  <option value=""
                    >Inherit: {localListeningDefaults.progressBar === 'chapter'
                      ? 'Chapter'
                      : 'Full book'}</option
                  >
                  <option value="chapter">Chapter</option>
                  <option value="book">Full book</option>
                </select>
              </label>
              <label
                >Current sentence
                <select
                  value={settingValue('showSentence')}
                  on:change={(event) => selectSetting('showSentence', event.currentTarget.value)}
                >
                  <option value="">Inherit: {localListeningDefaults.showSentence ? 'On' : 'Off'}</option>
                  <option value="true">On</option><option value="false">Off</option>
                </select>
              </label>
              <label
                >Keep reader active
                <select
                  value={settingValue('keepReaderActive')}
                  on:change={(event) =>
                    selectSetting('keepReaderActive', event.currentTarget.value)}
                >
                  <option value=""
                    >Inherit: {localListeningDefaults.keepReaderActive ? 'On' : 'Off'}</option
                  >
                  <option value="true">On</option><option value="false">Off</option>
                </select>
              </label>
              <label
                >Show illustrations
                <select
                  value={settingValue('showIllustrations')}
                  on:change={(event) =>
                    selectSetting('showIllustrations', event.currentTarget.value)}
                >
                  <option value=""
                    >Inherit: {localListeningDefaults.showIllustrations ? 'On' : 'Off'}</option
                  >
                  <option value="true">On</option><option value="false">Off</option>
                </select>
              </label>
              <label
                >Illustration sound
                <select
                  value={settingValue('illustrationNotification')}
                  on:change={(event) =>
                    selectSetting('illustrationNotification', event.currentTarget.value)}
                >
                  <option value=""
                    >Inherit: {localListeningDefaults.illustrationNotification ? 'On' : 'Off'}</option
                  >
                  <option value="true">On</option><option value="false">Off</option>
                </select>
              </label>
              <label
                >Skip seconds
                <input
                  type="number"
                  min="1"
                  max="120"
                  step="1"
                  value={settingValue('skipSeconds')}
                  placeholder={`Inherit: ${localListeningDefaults.skipSeconds}`}
                  on:change={(event) => selectSetting('skipSeconds', event.currentTarget.value)}
                />
              </label>
            </div>
            {#if settingsError}<p class="mt-3 text-xs text-red-200">{settingsError}</p>{/if}
          {:else}
            <p class="text-sm text-white/70">
              Per-book overrides are available when this title is linked to Cloud.
            </p>
          {/if}
        </div>
      {/if}

      <main class="listening-player-stage flex min-h-0 flex-1 items-center justify-center py-3 sm:py-5">
        <div class="listening-player-stack flex w-full max-w-3xl flex-col items-center">
          <div class="listening-artwork-zone flex w-full min-h-0 flex-1 items-center justify-center">
            <div
              class="listening-artwork-button relative aspect-square shrink-0 overflow-hidden rounded-2xl shadow-2xl"
            >
            <button
              class="absolute inset-0 h-full w-full cursor-default"
              class:cursor-zoom-in={!!displayedIllustrationUrl}
              aria-label={displayedIllustration ? 'Open current illustration' : 'Audiobook cover'}
              on:click={openLightbox}
            >
              <div
                class="listening-artwork-fallback absolute inset-0 flex items-center justify-center text-7xl text-white/75"
                aria-hidden={!!artworkUrl}
              >
                <Fa icon={faBookOpen} />
              </div>
              {#if artworkUrl}
                <span class="listening-artwork-ambient absolute inset-0" aria-hidden="true">
                  <img src={artworkUrl} alt="" class="h-full w-full object-cover" />
                </span>
                <img
                  src={artworkUrl}
                  alt={displayedIllustration?.alt || `${resolvedTitle} cover`}
                  class="relative z-[1] block h-full w-full object-contain"
                  on:load={() => markArtworkLoaded(artworkUrl)}
                  on:error={() => markArtworkFailed(artworkUrl)}
                />
              {/if}
            </button>
            {#if displayedIllustration}
              <span
                class="pointer-events-none absolute bottom-2 left-2 z-10 rounded-full bg-black/55 px-3 py-1 text-xs"
                >Illustration</span
              >
              <button
                class="absolute right-2 top-2 z-10 rounded-full bg-black/60 px-3 py-2 text-xs text-white"
                aria-label="Dismiss current illustration"
                on:click|stopPropagation={dismissIllustration}
              >
                Dismiss
              </button>
            {/if}
            </div>
          </div>

          <section class="listening-controls-panel w-full">
          <div class="listening-heading w-full max-w-2xl text-center">
            {#if chapterHeading}
              <div class="relative inline-block max-w-full" use:clickOutside={() => (chaptersOpen = false)}>
                <button
                  bind:this={chapterAnchorEl}
                  class="listening-chapter-heading inline-flex max-w-full items-center justify-center gap-2 text-lg font-semibold sm:text-2xl"
                  class:cursor-default={!chapterList.length}
                  aria-label={chapterList.length ? 'Open chapter list' : undefined}
                  aria-expanded={chapterList.length ? chaptersOpen : undefined}
                  on:click={toggleChapterList}
                >
                  <span class="listening-chapter-title-text min-w-0">{chapterHeading}</span>
                  {#if chapterList.length > 1}<span class="chapter-heading-chevron"><Fa icon={faChevronDown} /></span>{/if}
                </button>
                {#if chapterList.length > 1}
                  <div class="mt-1 text-[0.68rem] uppercase tracking-[0.18em] text-white/45">
                    Chapter {currentChapterIndex + 1} of {chapterList.length}
                  </div>
                {/if}
                {#if chaptersOpen && chapterList.length}
                  <div
                    class="listening-chapter-popover fixed z-[80] overflow-hidden rounded-2xl py-2 text-left shadow-2xl"
                    style={chapterPopoverStyle}
                  >
                    <div
                      class="listening-chapter-scroll overflow-y-auto px-2"
                      style={`max-height:${chapterPopoverMaxHeight}px`}
                    >
                      {#each chapterList as chapter, index}
                        <button
                          class="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm hover:bg-white/10"
                          class:active-chapter={index === currentChapterIndex}
                          on:click={() => {
                            chaptersOpen = false;
                            seekTo(chapter.startSeconds);
                          }}
                        >
                          <span class="w-12 shrink-0 text-xs text-white/45">{formatTime(chapter.startSeconds)}</span>
                          <span class="truncate">{chapter.label || `Chapter ${index + 1}`}</span>
                        </button>
                      {/each}
                    </div>
                  </div>
                {/if}
              </div>
            {/if}
            {#if resolvedAuthor}
              <div class:mt-1={!!chapterHeading} class="text-sm text-white/65">{resolvedAuthor}</div>
            {/if}
            {#if resolvedSettings.showSentence}
              <div
                class="listening-sentence-mirror mt-3 min-h-[3rem] rounded-xl px-3 py-2 text-base leading-relaxed sm:text-xl"
                aria-live="polite"
              >
                <span class="contents" bind:this={mirrorElement}></span>
                {#if !mirrorHasContent && currentSentence}
                  <span>{currentSentence.text}</span>
                {/if}
              </div>
            {/if}
          </div>

          <section class="listening-progress-section w-full">
            <div class="mb-1 flex justify-between text-xs text-white/65">
              <span
                >{formatTime(
                  effectiveProgressBar === 'chapter'
                    ? $currentTime$ - chapterStart
                    : $currentTime$
                )}</span
              >
              <button
                class="listening-time-toggle"
                title={showTotalDuration ? 'Show remaining time' : 'Show total duration'}
                aria-label={showTotalDuration ? 'Show remaining time' : 'Show total duration'}
                on:click={() => (showTotalDuration = !showTotalDuration)}
              >
                {#if showTotalDuration}
                  {formatTime(progressEnd - progressStart)}
                {:else}
                  {formatTime(Math.max(0, progressEnd - progressValue))} LEFT
                {/if}
              </button>
            </div>
            <div class="listening-progress-track relative">
              <input
                class="listening-progress block w-full"
                type="range"
                min={progressStart}
                max={progressEnd}
                step="0.1"
                value={progressValue}
                aria-label={effectiveProgressBar === 'chapter'
                  ? 'Chapter progress'
                  : 'Book progress'}
                on:input={seekFromProgress}
              />
              {#each chapterTicks as tick}
                <button
                  class="listening-chapter-tick absolute h-3 w-1 -translate-x-1/2 rounded-full"
                  style={`left: ${((tick.startSeconds - progressStart) / (progressEnd - progressStart)) * 100}%`}
                  title={`${tick.label || 'Chapter'} · ${formatTime(tick.startSeconds)}`}
                  aria-label={`Go to ${tick.label || 'chapter'} at ${formatTime(tick.startSeconds)}`}
                  on:click={() => seekTo(tick.startSeconds)}
                ></button>
              {/each}
            </div>
            <div class="listening-progress-meta mt-1 grid grid-cols-[1fr_auto_1fr] items-start text-[0.68rem] uppercase tracking-[0.18em] text-white/55">
              <span></span>
              <button
                class="listening-progress-mode-toggle pt-0.5 text-center"
                title={effectiveProgressBar === 'chapter' ? 'Switch to book progress' : 'Switch to chapter progress'}
                aria-label={effectiveProgressBar === 'chapter' ? 'Switch to book progress' : 'Switch to chapter progress'}
                on:click={toggleProgressBar}
              >
                {effectiveProgressBar === 'chapter' ? 'Chapter progress' : 'Book progress'} ·
                {Math.round(progressPercent)}%
              </button>
              <div
                class="listening-speed-wrap relative justify-self-end"
                use:clickOutside={() => (speedOpen = false)}
              >
                <button
                  class="listening-speed-text"
                  title="Playback speed"
                  aria-label={`Playback speed ${formatPlaybackRate($playbackRate$)} times`}
                  aria-expanded={speedOpen}
                  on:click={() => {
                    speedDraft = formatPlaybackRate($playbackRate$);
                    speedOpen = !speedOpen;
                  }}
                >{formatPlaybackRate($playbackRate$)}×</button>
                {#if speedOpen}
                  <div class="listening-speed-popover absolute right-0 top-full z-40 mt-2 w-52 text-left">
                    <div class="speed-popover-heading">Speed</div>
                    <div class="speed-editor-row">
                      <button class="speed-step-button" aria-label="Decrease playback speed" on:click={() => nudgePlaybackRate(-0.05)}>−</button>
                      <label class="speed-value-editor">
                        <span class="speed-value-balance" aria-hidden="true">×</span>
                        <input
                          class="speed-number-input"
                          type="text"
                          inputmode="decimal"
                          autocomplete="off"
                          bind:value={speedDraft}
                          aria-label="Custom playback speed"
                          on:change={commitSpeedDraft}
                          on:blur={commitSpeedDraft}
                          on:keydown={onSpeedKeydown}
                        />
                        <span class="speed-value-times" aria-hidden="true">×</span>
                      </label>
                      <button class="speed-step-button" aria-label="Increase playback speed" on:click={() => nudgePlaybackRate(0.05)}>+</button>
                    </div>
                    <div class="speed-preset-row" aria-label="Playback speed presets">
                      {#each [0.75, 1, 1.25, 1.5, 2] as speed}
                        <button
                          class="speed-preset-button"
                          class:active-speed={Math.abs($playbackRate$ - speed) < 0.001}
                          on:click={() => setPlaybackRate(speed)}
                        >{speed}</button>
                      {/each}
                    </div>
                  </div>
                {/if}
              </div>
            </div>
          </section>

          <nav
            class="listening-playback-controls flex w-full items-center justify-center gap-2 sm:gap-4"
            aria-label="Playback controls"
          >
            <button
              class="listening-control-button"
              title="Previous sentence"
              aria-label="Previous sentence"
              on:click={seekPreviousSubtitle}
            >
              <Fa icon={faArrowLeft} />
            </button>
            <button
              class="listening-control-button"
              title={`Back ${resolvedSettings.skipSeconds} seconds`}
              aria-label={`Back ${resolvedSettings.skipSeconds} seconds`}
              on:click={() => skipBy(-resolvedSettings.skipSeconds)}
            >
              <span class="text-[0.65rem] font-semibold">{resolvedSettings.skipSeconds}</span><Fa icon={faRotateLeft} />
            </button>
            <button
              class="listening-play-button"
              title={$paused$ ? 'Play' : 'Pause'}
              aria-label={$paused$ ? 'Play' : 'Pause'}
              on:click={togglePlayback}
            >
              <Fa icon={$paused$ ? faPlay : faPause} />
            </button>
            <button
              class="listening-control-button"
              title={`Forward ${resolvedSettings.skipSeconds} seconds`}
              aria-label={`Forward ${resolvedSettings.skipSeconds} seconds`}
              on:click={() => skipBy(resolvedSettings.skipSeconds)}
            >
              <Fa icon={faRotateRight} /><span class="text-[0.65rem] font-semibold">{resolvedSettings.skipSeconds}</span>
            </button>
            <button
              class="listening-control-button"
              title="Next sentence"
              aria-label="Next sentence"
              on:click={seekNextSubtitle}
            >
              <Fa icon={faArrowRight} />
            </button>
          </nav>
          </section>
        </div>
      </main>

    </div>
  </section>
{/if}

{#if lightboxOpen && displayedIllustrationUrl}
  <dialog
    class="listening-lightbox writing-horizontal-tb fixed inset-0 z-[70] m-0 h-[100dvh] w-screen overflow-hidden bg-black/90 p-0"
    open
  >
    <div
      class="listening-lightbox-stage relative z-10 flex h-[100dvh] w-screen items-center justify-center overflow-hidden"
      role="presentation"
      on:wheel|nonpassive={onLightboxWheel}
      on:pointerdown={startDrag}
      on:pointermove={moveDrag}
      on:pointerup={stopDrag}
      on:pointercancel={stopDrag}
      on:pointerleave={stopDrag}
      on:click={onLightboxStageClick}
    >
      <img
        src={displayedIllustrationUrl}
        alt={displayedIllustration?.alt || 'Current illustration'}
        class="listening-lightbox-image select-none object-contain"
        draggable="false"
        style={`transform: translate(${lightboxPanX}px, ${lightboxPanY}px) scale(${lightboxZoom})`}
      />
    </div>
    <button
      class="listening-lightbox-close absolute right-3 top-3 z-[100] flex h-11 w-11 items-center justify-center rounded-full bg-black/70 text-lg text-white shadow-lg backdrop-blur-sm hover:bg-black/85"
      aria-label="Close illustration"
      title="Close"
      on:pointerdown|stopPropagation={() => {}}
      on:click|stopPropagation={closeLightbox}
    >
      <Fa icon={faXmark} />
    </button>
  </dialog>
{/if}

<style>
  .listening-mode-shell {
    background: #1c1e30;
    writing-mode: horizontal-tb !important;
    text-orientation: mixed !important;
    overflow: hidden !important;
    overscroll-behavior: none;
  }

  .listening-lightbox {
    border: 0;
    writing-mode: horizontal-tb !important;
    text-orientation: mixed !important;
    max-height: none;
    max-width: none;
    touch-action: none;
  }

  .listening-lightbox-stage {
    box-sizing: border-box;
    padding: clamp(0.75rem, 2.5vw, 2rem);
    touch-action: none;
    cursor: default;
  }

  .listening-lightbox-stage:active {
    cursor: grabbing;
  }

  .listening-lightbox-image {
    display: block;
    width: auto;
    height: auto;
    max-width: calc(100vw - clamp(1.5rem, 5vw, 4rem));
    max-height: calc(100dvh - clamp(1.5rem, 5vw, 4rem));
    transform-origin: center center;
    will-change: transform;
    user-select: none;
    -webkit-user-drag: none;
  }

  .listening-lightbox-close {
    writing-mode: horizontal-tb !important;
    pointer-events: auto !important;
  }

  .listening-mode-backdrop {
    background-position: center;
    background-size: cover;
    filter: blur(34px) saturate(1.08);
    opacity: 0.28;
    transform: scale(1.12);
  }

  .listening-mode-scrim {
    background: linear-gradient(135deg, rgba(28, 30, 48, 0.90), rgba(43, 46, 74, 0.76));
  }

  .listening-icon-button,
  .listening-control-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 9999px;
    color: rgba(255, 255, 255, 0.86);
    transition:
      background-color 120ms ease,
      transform 120ms ease;
  }

  .listening-icon-button {
    height: 2.5rem;
    width: 2.5rem;
  }

  .listening-control-button {
    height: 2.8rem;
    min-width: 2.8rem;
    gap: 0.18rem;
    padding: 0 0.65rem;
  }

  .listening-icon-button:hover,
  .listening-control-button:hover {
    background: rgba(33, 150, 243, 0.18);
    transform: translateY(-1px);
  }

  .listening-play-button {
    display: inline-flex;
    height: 4rem;
    width: 4rem;
    align-items: center;
    justify-content: center;
    border-radius: 9999px;
    background: rgba(255, 255, 255, 0.94);
    color: #2b2e4a;
    font-size: 1.2rem;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
  }

  .listening-settings-panel,
  .listening-chapter-popover,
  .listening-speed-popover {
    background: rgba(43, 46, 74, 0.92);
    border: 1px solid rgba(144, 202, 249, 0.34);
    backdrop-filter: blur(18px);
  }

  .listening-settings-panel label {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    color: rgba(255, 255, 255, 0.72);
    font-size: 0.78rem;
  }

  .listening-settings-panel select,
  .listening-settings-panel input {
    border-radius: 0.65rem;
    border: 1px solid rgba(255, 255, 255, 0.18);
    background: rgba(33, 150, 243, 0.14);
    color: white;
    padding: 0.55rem 0.65rem;
  }

  .listening-settings-panel option {
    background: #2b2e4a;
    color: white;
  }

  .listening-player-stage {
    /* The outer shell still locks viewport scrolling. Let overlays escape the
       player stage so chapter/speed popovers are never clipped by this box. */
    overflow: visible;
    overscroll-behavior: none;
    min-height: 0;
    align-items: stretch !important;
    padding-top: 0.55rem !important;
    padding-bottom: 0.55rem !important;
  }

  .listening-player-stack {
    /* Visual rhythm tuned from the mobile mock-up. These are deliberately
       defined on one parent so every major player element shares the same
       center axis and the vertical offsets scale together on short screens. */
    --listening-artwork-y: clamp(12px, 2.2vh, 20px);
    --listening-heading-y: clamp(28px, 4.9vh, 45px);
    --listening-progress-y: clamp(32px, 5.45vh, 50px);
    --listening-controls-y: clamp(46px, 8.05vh, 74px);
    height: 100%;
    min-height: 0;
    gap: 0;
    margin-inline: auto;
    align-items: center;
  }

  .listening-artwork-zone {
    /* Treat the artwork as its own stage instead of a loose item in a tall
       flex column. The stage absorbs the free room between the header and the
       compact transport panel, and the cover is centered inside that room. */
    flex: 1 1 auto;
    min-height: 0;
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-top: clamp(0.35rem, 1vh, 0.7rem);
    padding: clamp(0.8rem, 2.2vh, 1.5rem) clamp(0.65rem, 2vw, 1.2rem);
    position: relative;
    top: var(--listening-artwork-y);
  }

  .listening-controls-panel {
    flex: 0 0 auto;
    display: flex;
    width: 100%;
    flex-direction: column;
    align-items: center;
    padding: clamp(0.72rem, 1.45vh, 1rem) clamp(0.65rem, 2vw, 1rem) clamp(0.85rem, 1.7vh, 1.15rem);
  }

  .listening-heading {
    margin-top: 0;
    position: relative;
    top: var(--listening-heading-y);
    margin-inline: auto;
  }

  .listening-progress-section {
    max-width: 48rem;
    margin-top: clamp(0.45rem, 1vh, 0.75rem);
    margin-inline: auto;
    position: relative;
    top: var(--listening-progress-y);
  }

  .listening-playback-controls {
    margin-top: clamp(0.35rem, 0.8vh, 0.6rem);
    margin-inline: auto;
    position: relative;
    top: var(--listening-controls-y);
  }

  .listening-artwork-button {
    /* Keep the artwork box real even if an aspect-ratio utility is missing or
       overridden by reader styles. Width and height deliberately use the same
       expression rather than relying on inherited layout. */
    width: min(76vw, 23.5rem, 37vh);
    height: min(76vw, 23.5rem, 37vh);
    min-width: 10rem;
    min-height: 10rem;
    aspect-ratio: 1 / 1;
    display: block;
    flex: 0 0 auto;
    align-self: center !important;
    margin-left: auto !important;
    margin-right: auto !important;
    margin-inline: auto !important;
    background: rgba(13, 71, 161, 0.18);
  }

  .listening-time-toggle {
    border: 0;
    background: transparent;
    color: inherit;
    padding: 0;
    font: inherit;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
  }

  .listening-time-toggle:hover,
  .listening-time-toggle:focus-visible {
    color: white;
    outline: none;
  }

  .listening-progress-mode-toggle {
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
    cursor: pointer;
    transition: color 120ms ease;
  }

  .listening-progress-mode-toggle:hover,
  .listening-progress-mode-toggle:focus-visible {
    color: var(--ttu-blue-200, #90caf9);
    outline: none;
  }

  @media (min-width: 640px) {
    .listening-artwork-button {
      width: min(46vw, 27rem, 42vh);
      height: min(46vw, 27rem, 42vh);
    }
  }

  @media (max-width: 639px) {
    .listening-player-stage {
      padding-top: 0.25rem !important;
      padding-bottom: 0 !important;
    }

    .listening-artwork-zone {
      margin-top: 0.35rem;
      padding: clamp(0.75rem, 1.7vh, 1.05rem) 0.7rem;
    }

    .listening-controls-panel {
      padding: 0.78rem 0.75rem 0.95rem;
    }

    .listening-artwork-button {
      width: min(84vw, 21.5rem, 42vh);
      height: min(84vw, 21.5rem, 42vh);
      min-width: 8.5rem;
      min-height: 8.5rem;
    }

    .listening-progress-section {
      margin-top: 0.5rem;
    }

    .listening-progress-meta {
      font-size: 0.62rem;
      letter-spacing: 0.14em;
    }

  .listening-speed-text {
      font-size: 0.76rem;
    }
  }

  @media (max-height: 760px) {
    .listening-player-stack {
      --listening-artwork-y: clamp(8px, 1.5vh, 12px);
      --listening-heading-y: clamp(18px, 3.4vh, 28px);
      --listening-progress-y: clamp(20px, 3.8vh, 32px);
      --listening-controls-y: clamp(30px, 5.4vh, 46px);
    }

    .listening-player-stage {
      padding-top: 0.3rem !important;
      padding-bottom: 0 !important;
    }

    .listening-artwork-zone {
      padding-block: 0.45rem;
    }

    .listening-controls-panel {
      padding-top: 0.55rem;
      padding-bottom: 0.6rem;
    }
  }

  .listening-artwork-fallback {
    background: linear-gradient(135deg, #0d47a1 0%, #2196f3 55%, #2b2e4a 100%);
  }

  .listening-artwork-ambient {
    overflow: hidden;
    background: #1c1e30;
  }

  .listening-artwork-ambient img {
    filter: blur(24px) brightness(0.58) saturate(1.08);
    transform: scale(1.16);
  }

  .listening-artwork-ambient::after {
    position: absolute;
    inset: 0;
    content: '';
    background: rgba(28, 30, 48, 0.24);
  }

  .listening-sentence-mirror {
    background: rgba(0, 0, 0, 0.22);
    color: rgba(255, 255, 255, 0.92);
  }

  .listening-speed-text {
    border: 0;
    background: transparent;
    color: rgba(255, 255, 255, 0.84);
    padding: 0.15rem 0.05rem;
    font-size: 0.78rem;
    font-weight: 700;
    line-height: 1.1;
    letter-spacing: normal;
    text-transform: none;
    cursor: pointer;
  }

  .listening-speed-text:hover,
  .listening-speed-text:focus-visible {
    color: white;
  }

  .listening-speed-text:focus-visible {
    outline: 1px solid rgba(255, 255, 255, 0.4);
    outline-offset: 3px;
    border-radius: 0.2rem;
  }

  .listening-speed-popover {
    color: white;
    letter-spacing: normal;
    text-transform: none;
    background: rgba(43, 46, 74, 0.98);
    border: 1px solid rgba(144, 202, 249, 0.34);
    border-radius: 0.3rem;
    box-shadow: 0 16px 34px rgba(0, 0, 0, 0.38);
    backdrop-filter: blur(14px);
    padding: 0.7rem 0.8rem 0.6rem;
  }

  .speed-popover-heading {
    color: rgba(255, 255, 255, 0.42);
    font-size: 0.58rem;
    font-weight: 700;
    letter-spacing: 0.2em;
    text-transform: uppercase;
  }

  .speed-editor-row {
    display: grid;
    grid-template-columns: 2rem 1fr 2rem;
    align-items: center;
    gap: 0.45rem;
    margin-top: 0.45rem;
    padding-bottom: 0.55rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.12);
  }

  .speed-step-button {
    display: inline-flex;
    height: 2rem;
    align-items: center;
    justify-content: center;
    background: transparent;
    color: rgba(255, 255, 255, 0.68);
    font-size: 1.25rem;
    line-height: 1;
    transition: color 120ms ease, transform 120ms ease;
  }

  .speed-step-button:hover,
  .speed-step-button:focus-visible {
    color: var(--ttu-blue-200, #90caf9);
    outline: none;
  }

  .speed-step-button:active {
    transform: translateY(1px);
  }

  .speed-value-editor {
    display: grid;
    grid-template-columns: 1rem minmax(4.5ch, auto) 1rem;
    align-items: center;
    justify-content: center;
    min-width: 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.28);
    padding: 0.15rem 0 0.2rem;
    color: rgba(255, 255, 255, 0.62);
  }

  .speed-value-balance,
  .speed-value-times {
    pointer-events: none;
    font-size: 0.82rem;
    line-height: 1;
  }

  .speed-value-balance {
    visibility: hidden;
  }

  .speed-value-times {
    justify-self: start;
    margin-left: 0.08rem;
  }

  .speed-value-editor:focus-within {
    border-bottom-color: var(--ttu-blue-500, #2196f3);
    color: var(--ttu-blue-200, #90caf9);
  }

  .speed-number-input {
    width: 4.5ch;
    min-width: 4.5ch;
    justify-self: center;
    border: 0;
    background: transparent;
    color: white;
    padding: 0;
    text-align: center;
    font-size: 1.08rem;
    font-variant-numeric: tabular-nums;
    font-weight: 650;
    outline: none;
  }

  .speed-preset-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.25rem;
    padding-top: 0.48rem;
  }

  .speed-preset-button {
    position: relative;
    padding: 0.15rem 0.08rem 0.24rem;
    background: transparent;
    color: rgba(255, 255, 255, 0.46);
    font-size: 0.65rem;
    font-variant-numeric: tabular-nums;
    transition: color 120ms ease;
  }

  .speed-preset-button::after {
    content: '';
    position: absolute;
    right: 18%;
    bottom: 0;
    left: 18%;
    height: 1px;
    background: transparent;
  }

  .speed-preset-button:hover,
  .speed-preset-button:focus-visible {
    color: rgba(255, 255, 255, 0.9);
    outline: none;
  }

  .speed-preset-button.active-speed {
    color: var(--ttu-blue-200, #90caf9);
  }

  .speed-preset-button.active-speed::after {
    background: var(--ttu-blue-500, #2196f3);
  }

  .listening-chapter-heading {
    color: inherit;
    background: transparent;
  }

  .listening-chapter-heading:not(.cursor-default):hover,
  .listening-chapter-heading:not(.cursor-default):focus-visible {
    color: var(--ttu-blue-200, #90caf9);
    outline: none;
  }

  .chapter-heading-chevron {
    width: 0.62em;
    flex: 0 0 auto;
    color: rgba(255, 255, 255, 0.38);
    font-size: 0.58em;
  }

  .active-chapter {
    background: rgba(33, 150, 243, 0.20);
  }

  .listening-progress-track {
    height: 1rem;
  }

  .listening-progress {
    display: block;
    width: 100%;
    height: 1rem;
    margin: 0;
    accent-color: var(--ttu-blue-500, #2196f3);
  }

  .listening-chapter-tick {
    top: 50%;
    background: #8f95ad;
    transform: translate(-50%, -50%);
    transition: background-color 120ms ease, box-shadow 120ms ease, transform 120ms ease;
  }

  .listening-chapter-tick:hover,
  .listening-chapter-tick:focus-visible {
    background: var(--ttu-blue-400, #42a5f5);
    box-shadow: 0 0 0 2px rgb(66 165 245 / 0.22), 0 0 8px rgb(66 165 245 / 0.55);
    transform: translate(-50%, -50%) scale(1.35);
  }

  :global(.ttu-listening-reader-muted) {
    opacity: 0 !important;
    pointer-events: none !important;
    visibility: hidden !important;
  }

  :global(.ttu-listening-mirror-line),
  :global(.ttu-listening-mirror-line *) {
    writing-mode: horizontal-tb !important;
    text-orientation: mixed !important;
  }

  .listening-reader-actions {
    background: rgba(43, 46, 74, 0.97);
    border: 1px solid rgba(144, 202, 249, 0.32);
    backdrop-filter: blur(18px);
  }

  .listening-reader-actions button {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 0.7rem;
    padding: 0.6rem 0.8rem;
    color: rgba(255, 255, 255, 0.86);
    font-size: 0.82rem;
    text-align: left;
    transition: background-color 120ms ease, color 120ms ease;
  }

  .listening-reader-actions button:hover,
  .listening-reader-actions button:focus-visible {
    background: rgba(33, 150, 243, 0.14);
    color: white;
    outline: none;
  }

  .listening-reader-actions button :global(svg) {
    width: 1rem;
    flex: 0 0 1rem;
  }
</style>
