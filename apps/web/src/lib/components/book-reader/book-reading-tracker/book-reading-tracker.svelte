<script lang="ts">
  import {
    getDefaultStatistic,
    isTrackerPaused$,
    type TrackingHistory,
    isTrackerMenuOpen$,
    TrackerSkipThresholdAction,
    TrackerAutoPause
  } from '$lib/components/book-reader/book-reading-tracker/book-reading-tracker';
  import BookTimerMenu from '$lib/components/book-reader/book-reading-tracker/book-reading-tracker-menu.svelte';
  import type { SectionWithProgress } from '$lib/components/book-reader/book-toc/book-toc';
  import type { AutoScroller } from '$lib/components/book-reader/types';
  import type {
    BooksDbReadingGoal,
    BooksDbStatistic
  } from '$lib/data/database/books-db/versions/books-db';
  import { dialogManager } from '$lib/data/dialog-manager';
  import {
    CLOUD_AUDIOBOOK_PROGRESS_EVENT,
    activeCloudBookId$,
    cloudAudiobookTrackingActive$,
    type CloudAudiobookPlaybackDetail
  } from '$lib/cloud/audiobook-tracking';
  import {
    clearCloudCompletion,
    flushPendingCloudStatistics,
    recordCloudCompletion,
    recordCloudStatisticDelta
  } from '$lib/cloud/cloud-statistics';
  import { PAGE_CHANGE } from '$lib/data/events';
  import { logger } from '$lib/data/logger';
  import { MergeMode } from '$lib/data/merge-mode';
  import { getReadingGoalWindow, type ReadingGoal } from '$lib/data/reading-goal';
  import {
    adjustStatisticsAfterIdleTime$,
    audiobookCountShortPauses$,
    audiobookShortPauseSeconds$,
    database,
    readingGoal$,
    startDayHoursForTracker$,
    trackerAutoPause$,
    trackerBackwardSkipThreshold$,
    trackerForwardSkipThreshold$,
    trackerIdleTime$,
    trackerPopupDetection$,
    trackerSkipThresholdAction$
  } from '$lib/data/store';
  import { ReplicationSaveBehavior } from '$lib/functions/replication/replication-options';
  import { reduceToEmptyString } from '$lib/functions/rxjs/reduce-to-empty-string';
  import {
    getDate,
    getDateKey,
    getDateTimeString,
    getPreviousDayKey,
    getSecondsToDate,
    toTimeString
  } from '$lib/functions/statistic-util';
  import { clickOutside } from '$lib/functions/use-click-outside';
  import { filterNotNullAndNotUndefined } from '$lib/functions/utils';
  import {
    combineLatest,
    fromEvent,
    interval,
    merge,
    NEVER,
    Observable,
    startWith,
    switchMap,
    tap,
    throttleTime
  } from 'rxjs';
  import { createEventDispatcher, onDestroy, onMount, tick } from 'svelte';
  import { quintInOut } from 'svelte/easing';
  import { fly } from 'svelte/transition';

  export let fontColor: string;
  export let backgroundColor: string;
  export let bookTitle: string;
  export let wasTrackerPaused: boolean;
  export let exploredCharCount: number;
  export let bookCharCount: number;
  export let sectionData: SectionWithProgress[];
  export let frozenPosition: number;
  export let autoScroller: AutoScroller | undefined;
  export let blockDataUpdates: boolean;

  export function processStatistics(
    characterDiff: number,
    timeDiff = 1,
    referenceTick = Date.now(),
    flushData = true
  ) {
    const todayDate = new Date();
    const absoluteTimeDiff = Math.abs(timeDiff);
    const isNegativeTimeDiff = timeDiff < 0;
    const referenceDate = new Date(referenceTick);
    const referenceDateKey = getDateKey($startDayHoursForTracker$, referenceDate);
    const lastStatisticModified = referenceDate.getTime();
    const secondsOnDay = getSecondsToDate($startDayHoursForTracker$, referenceDate) || 1;
    const overlappedDay = absoluteTimeDiff > secondsOnDay;
    const timeDiffForToday = overlappedDay ? secondsOnDay : absoluteTimeDiff;
    const dateTimeKey = getDateTimeString(lastStatisticModified);
    const characterDiffForReferenceDay = overlappedDay && absoluteTimeDiff > 0
      ? Math.round(characterDiff * (timeDiffForToday / absoluteTimeDiff))
      : characterDiff;
    const characterDiffForOtherDay = characterDiff - characterDiffForReferenceDay;
    const trackerHistory: TrackingHistory[] = [
      {
        id: lastStatisticModified * Math.random(),
        dateKey: referenceDateKey,
        dateTimeKey,
        timeDiff: isNegativeTimeDiff ? -timeDiffForToday : timeDiffForToday,
        characterDiff: characterDiffForReferenceDay,
        saved: false
      }
    ];

    todayKey = getDateKey($startDayHoursForTracker$, todayDate);

    if (overlappedDay || referenceDateKey !== todayKey) {
      let otherDayTimeDiff = 0;

      if (overlappedDay) {
        otherDayTimeDiff = isNegativeTimeDiff
          ? -(absoluteTimeDiff - secondsOnDay)
          : absoluteTimeDiff - secondsOnDay;
      } else {
        otherDayTimeDiff = isNegativeTimeDiff ? -timeDiffForToday : timeDiffForToday;
      }

      const otherDayKey = overlappedDay
        ? getPreviousDayKey($startDayHoursForTracker$, referenceDate)
        : referenceDateKey;
      const otherDayStatistics =
        statistics.get(otherDayKey) || getDefaultStatistic(bookTitle, otherDayKey);

      updateStatistic(
        otherDayStatistics,
        otherDayTimeDiff,
        overlappedDay ? characterDiffForOtherDay : characterDiff,
        lastStatisticModified
      );

      statistics.set(otherDayKey, otherDayStatistics);
      statisticsToStore.add(otherDayKey);

      if (overlappedDay) {
        trackerHistory.unshift({
          id: lastStatisticModified * Math.random(),
          dateKey: otherDayStatistics.dateKey,
          dateTimeKey,
          timeDiff: otherDayTimeDiff,
          characterDiff: characterDiffForOtherDay,
          saved: false
        });
      }
    }

    todaysStatistics =
      todaysStatistics.dateKey === todayKey
        ? todaysStatistics
        : statistics.get(todayKey) || getDefaultStatistic(bookTitle, todayKey);

    if (todayKey === referenceDateKey) {
      updateStatistic(
        todaysStatistics,
        isNegativeTimeDiff ? -timeDiffForToday : timeDiffForToday,
        characterDiffForReferenceDay,
        lastStatisticModified
      );
    } else {
      updateStatistic(todaysStatistics, 0, 0, lastStatisticModified);
    }

    statistics.set(todayKey, todaysStatistics);
    statisticsToStore.add(todayKey);

    updateStatistic(sessionStatistics, timeDiff, characterDiff, lastStatisticModified);
    updateStatistic(allTimeStatistics, timeDiff, characterDiff, lastStatisticModified);

    for (let index = 0, { length } = trackerHistory; index < length; index += 1) {
      if (historyIndex > 59) {
        historyIndex = 0;
      }

      if (trackingHistory.length < 60) {
        trackingHistory.unshift(trackerHistory[index]);
      } else {
        trackingHistory[historyIndex] = trackerHistory[index];
        trackingHistory.sort((t1, t2) => (t2.dateTimeKey > t1.dateTimeKey ? 1 : -1));
        historyIndex += 1;
      }
    }

    updateTimeToFinishBook();

    if ($activeCloudBookId$) {
      for (const item of trackerHistory) {
        recordCloudStatisticDelta({
          bookId: $activeCloudBookId$,
          title: bookTitle,
          dateKey: item.dateKey,
          readingTimeDelta: item.timeDiff,
          characterDelta: item.characterDiff
        });
      }
    }

    return flushData ? flushUpdates() : Promise.resolve([false, 0]);
  }

  export async function flushUpdates(force = false) {
    if (!statisticsToStore.size || (blockDataUpdates && !force)) {
      return [false, 0];
    }

    actionInProgress = true;
    hadError = false;

    const toUpdate: string[] = JSON.parse(JSON.stringify([...statisticsToStore]));
    const itemsToStore = toUpdate
      .map((statisticToStore) => statistics.get(statisticToStore))
      .filter(filterNotNullAndNotUndefined);

    statisticsToStore.clear();

    try {
      await database.storeStatistics(
        bookTitle,
        itemsToStore,
        ReplicationSaveBehavior.Overwrite,
        MergeMode.LOCAL
      );

      trackingHistory = trackingHistory.map((item) => {
        const oldItem = item;

        oldItem.saved = toUpdate.some((dateKey) => dateKey === item.dateKey);

        return oldItem;
      });

      dispatch('statisticsSaved');
    } catch (error: any) {
      hadError = true;
      statisticsToStore = new Set([...statisticsToStore, ...toUpdate]);
      logger.error(`Error updating statistics: ${error.message}`);
    } finally {
      actionInProgress = false;
      lastTrackerFlushTime = Date.now();

      if ($isTrackerMenuOpen$) {
        updateReadingGoalWindow();
      }
    }

    return [hadError, toUpdate.length];
  }

  export function updateCompletedBook(
    completedBookStatistics: BooksDbStatistic,
    oldCompletedBookStatistics?: BooksDbStatistic
  ) {
    bookCompletionStatistics = completedBookStatistics.completedData;

    let statistic = statistics.get(completedBookStatistics.dateKey);

    if (statistic) {
      statistic = {
        ...statistic,
        ...{ completedBook: 1, completedData: bookCompletionStatistics }
      };
      statistics.set(completedBookStatistics.dateKey, statistic);
    } else {
      statistics.set(completedBookStatistics.dateKey, completedBookStatistics);
    }

    if (oldCompletedBookStatistics) {
      statistics.set(oldCompletedBookStatistics.dateKey, oldCompletedBookStatistics);
    }

    if ($activeCloudBookId$ && completedBookStatistics.completedData) {
      if (oldCompletedBookStatistics?.dateKey && oldCompletedBookStatistics.dateKey !== completedBookStatistics.dateKey) {
        clearCloudCompletion({
          bookId: $activeCloudBookId$,
          title: bookTitle,
          dateKey: oldCompletedBookStatistics.dateKey
        });
      }
      recordCloudCompletion({
        bookId: $activeCloudBookId$,
        title: bookTitle,
        dateKey: completedBookStatistics.dateKey,
        completedData: completedBookStatistics.completedData
      });
    }
  }

  let yomiPopover: HTMLElement | null;
  let jpdbPopover: HTMLElement | null;
  let actionInProgress = false;
  let hadError = false;
  let pausedByAutoPause = false;
  let visibilityState: DocumentVisibilityState;
  let currentReadingGoalStart = '';
  let currentReadingGoalEnd = '';
  let remainingTimeInReadingGoalWindow = '';
  let currentReadingGoal: ReadingGoal | undefined;
  let currentTimeGoal = 0;
  let currentCharacterGoal = 0;
  let statistics = new Map<string, BooksDbStatistic>();
  let todayKey = getDateKey($startDayHoursForTracker$);
  let sessionStatistics = getDefaultStatistic(bookTitle, todayKey);
  let todaysStatistics = getDefaultStatistic(bookTitle, todayKey);
  let allTimeStatistics = getDefaultStatistic(bookTitle, todayKey);
  let bookCompletionStatistics:
    | Omit<BooksDbStatistic, 'title' | 'lastStatisticModified'>
    | undefined;
  let bookStartDate = todayKey;
  let timeToFinishBook = 'N/A';
  let lastExploredCharCount = exploredCharCount;
  let previousLastExploredCharCount = 0;
  let trackingHistory: TrackingHistory[] = [];
  let historyIndex = 0;
  let autoScrollerStatistics: BooksDbStatistic | undefined;
  let autoScrollerTimer$: Observable<''> | undefined;
  let lastExploredCharCountScroller = exploredCharCount;
  let statisticsToStore = new Set<string>();
  let lastTrackerTick = 0;
  let lastTrackerFlushTime = 0;
  let trackerIdleTime = 0;

  // Cloud audiobook statistics use media movement as the clock. This excludes
  // buffering and, after dividing by playback rate, records real wall-clock
  // listening time rather than audiobook timeline time.
  let trackerInitialized = false;
  let audiobookTrackingWasActive = false;
  let audiobookLastExploredCharCount = exploredCharCount;
  let audiobookPendingCharacters = 0;
  let audiobookPendingTime = 0;
  // Time since the last positive EPUB-character movement, grouped by reading
  // day. Audio can keep advancing while a mobile browser throttles the hidden
  // reader; when the reader catches up later, these buckets let us credit those
  // characters to the days on which the listening actually happened instead
  // of dumping the whole catch-up onto the foreground-return day.
  const audiobookUnattributedTimeByDate = new Map<
    string,
    { seconds: number; referenceTick: number }
  >();
  // Set while playback is backgrounded. Mobile browsers may throttle the
  // hidden reader and then advance it in one large jump on return; that catch-up
  // is real reading progress, not a manual forward skip.
  let audiobookBackgroundCharacterCatchupPending = false;
  let audiobookLastStatProcessAt = 0;
  let audiobookPauseStartedAt = 0;
  let audiobookSample:
    | { seconds: number; at: number; paused: boolean; playbackRate: number }
    | undefined;

  const dispatch = createEventDispatcher<{
    trackerAvailable: void;
    statisticsSaved: void;
    trackerMenuClosed: void;
  }>();
  const yomiObserver = new MutationObserver(handleYomiMutation);
  const dictionaryObserver = new MutationObserver(handleMutation);

  const readingTracker$ = combineLatest([isTrackerPaused$, cloudAudiobookTrackingActive$]).pipe(
    switchMap(([isPaused, audiobookActive]) => {
      if (audiobookActive) {
        // The cloud audiobook has its own media-driven tracker below. Keeping the
        // classic 1-second timer alive here would double-count time.
        trackerIdleTime = 0;
        return NEVER;
      }

      if (isPaused) {
        trackerIdleTime = 0;

        flushUpdates();

        return NEVER;
      }

      const now = Date.now();

      lastTrackerFlushTime = now;
      lastTrackerTick = now;

      return interval(1000);
    }),
    tap(processTicks),
    reduceToEmptyString()
  );

  const updateTrackerIdleTime$ = combineLatest([isTrackerPaused$, cloudAudiobookTrackingActive$]).pipe(
    switchMap(([isPaused, audiobookActive]) =>
      isPaused || audiobookActive || $trackerIdleTime$ <= 0
        ? NEVER
        : merge(
            fromEvent(document, PAGE_CHANGE),
            fromEvent<PointerEvent>(window, 'pointermove'),
            fromEvent<Event>(document, 'selectionchange')
          ).pipe(
            startWith(true),
            throttleTime(1000),
            tap(() => (trackerIdleTime = Date.now() + $trackerIdleTime$ * 1000))
          )
    ),
    reduceToEmptyString()
  );

  const audiobookProgressTracker$ = cloudAudiobookTrackingActive$.pipe(
    switchMap((active) =>
      active
        ? fromEvent<CustomEvent<CloudAudiobookPlaybackDetail>>(
            document,
            CLOUD_AUDIOBOOK_PROGRESS_EVENT
          )
        : NEVER
    ),
    tap(handleAudiobookProgress),
    reduceToEmptyString()
  );

  const audiobookCharacterTracker$ = cloudAudiobookTrackingActive$.pipe(
    switchMap((active) => (active ? fromEvent(document, PAGE_CHANGE) : NEVER)),
    tap(() => {
      collectAudiobookCharacters();
      flushAudiobookPending();
    }),
    reduceToEmptyString()
  );

  $: if ($cloudAudiobookTrackingActive$ !== audiobookTrackingWasActive) {
    audiobookTrackingWasActive = $cloudAudiobookTrackingActive$;
    if (audiobookTrackingWasActive) {
      resetAudiobookTracking();
    } else {
      flushAudiobookPending(true);
      resetAudiobookTracking();
    }
  }

  $: hasReadingGoal = !!($readingGoal$.goalStartDate && todayKey >= $readingGoal$.goalStartDate);

  $: handleVisibilityChange(visibilityState);

  $: updateReadingGoalWindowForPausedState($isTrackerMenuOpen$);

  $: if (!$isTrackerPaused$) {
    updateLastExploredCharCount();
  }

  $: if (autoScroller && !autoScrollerTimer$) {
    autoScrollerTimer$ = autoScroller.wasAutoScrollerEnabled$.pipe(
      tap((isEnabled) => {
        if (isEnabled) {
          todayKey = getDateKey($startDayHoursForTracker$);
          autoScrollerStatistics = getDefaultStatistic(bookTitle, todayKey);
          lastExploredCharCountScroller = exploredCharCount;
        } else {
          autoScrollerStatistics = undefined;
        }
      }),
      switchMap((isEnabled) => (isEnabled ? interval(1000) : NEVER)),
      tap(() => {
        if (!autoScrollerStatistics) {
          return;
        }

        const diff = exploredCharCount - lastExploredCharCountScroller;

        lastExploredCharCountScroller = exploredCharCount;
        autoScrollerStatistics = {
          ...updateStatistic(autoScrollerStatistics, 1, diff, Date.now())
        };
      }),
      reduceToEmptyString()
    );
  }

  $: if ($trackerAutoPause$ !== TrackerAutoPause.OFF && !yomiPopover) {
    yomiPopover = document.querySelector(
      '.yomichan-popup,.yomichan-float,.yomitan-popup,.yomitan-float'
    );

    if (!yomiPopover) {
      yomiObserver.observe(document.body, { childList: true, subtree: false });
    }
  } else {
    yomiObserver.disconnect();
  }

  $: if ($trackerAutoPause$ !== TrackerAutoPause.OFF && !$trackerPopupDetection$) {
    if (yomiPopover) {
      dictionaryObserver.observe(yomiPopover, { attributes: true });
    }

    if (jpdbPopover) {
      dictionaryObserver.observe(jpdbPopover, { attributes: true });
    }
  } else {
    dictionaryObserver.disconnect();
  }

  onMount(init);

  onDestroy(() => {
    flushAudiobookPending(true);
    void flushPendingCloudStatistics().catch(() => undefined);
    yomiObserver.disconnect();
    dictionaryObserver.disconnect();
  });

  function handleYomiMutation() {
    yomiPopover = document.querySelector(
      '.yomichan-popup,.yomichan-float,.yomitan-popup,.yomitan-float'
    );

    if (yomiPopover) {
      yomiObserver.disconnect();
    }
  }

  function handleMutation() {
    if (!jpdbPopover && !yomiPopover) {
      return;
    }

    const isDisplayed = isDictionaryDisplayed();

    if (isDisplayed && !$isTrackerPaused$) {
      pausedByAutoPause = true;
      isTrackerPaused$.next(true);
    } else if (!isDisplayed && $isTrackerPaused$ && !wasTrackerPaused && pausedByAutoPause) {
      pausedByAutoPause = false;
      isTrackerPaused$.next(false);
    }
  }

  function isDictionaryDisplayed() {
    return (
      (yomiPopover && yomiPopover.style.visibility !== 'hidden') ||
      (jpdbPopover && jpdbPopover.style.opacity !== '0')
    );
  }

  function handleBlur() {
    if (
      $isTrackerPaused$ ||
      $trackerAutoPause$ !== TrackerAutoPause.STRICT ||
      ($trackerPopupDetection$ && isDictionaryDisplayed())
    ) {
      return;
    }

    pausedByAutoPause = true;
    isTrackerPaused$.next(true);
  }

  function handleFocus() {
    if (
      !$isTrackerPaused$ ||
      !pausedByAutoPause ||
      wasTrackerPaused ||
      $trackerAutoPause$ !== TrackerAutoPause.STRICT ||
      (!$trackerPopupDetection$ && isDictionaryDisplayed())
    ) {
      return;
    }

    pausedByAutoPause = false;
    isTrackerPaused$.next(false);
  }

  function updateLastExploredCharCount() {
    const referenceCharCount = frozenPosition !== -1 ? frozenPosition : exploredCharCount;

    if (lastExploredCharCount !== referenceCharCount) {
      previousLastExploredCharCount = lastExploredCharCount;
      lastExploredCharCount = referenceCharCount;
    }
  }

  function revertTrackerHistory({ detail: historyItem }: CustomEvent<TrackingHistory>) {
    const entry = statistics.get(historyItem.dateKey);

    if (!entry) {
      trackingHistory = trackingHistory.filter((item) => item.id !== historyItem.id);
      return;
    }

    actionInProgress = true;

    const lastStatisticModified = Date.now();

    updateStatistic(
      entry,
      -historyItem.timeDiff,
      -historyItem.characterDiff,
      lastStatisticModified
    );
    updateStatistic(
      sessionStatistics,
      -historyItem.timeDiff,
      -historyItem.characterDiff,
      lastStatisticModified
    );
    updateStatistic(
      allTimeStatistics,
      -historyItem.timeDiff,
      -historyItem.characterDiff,
      lastStatisticModified
    );

    statistics.set(entry.dateKey, entry);
    statisticsToStore.add(entry.dateKey);

    trackingHistory = trackingHistory.map((item) =>
      item.id === historyItem.id
        ? {
            id: historyItem.id,
            dateKey: historyItem.dateKey,
            dateTimeKey: getDateTimeString(lastStatisticModified),
            timeDiff: -historyItem.timeDiff,
            characterDiff: -historyItem.characterDiff,
            saved: false
          }
        : item
    );
    trackingHistory.sort((t1, t2) => (t2.dateTimeKey > t1.dateTimeKey ? 1 : -1));
    sessionStatistics = { ...sessionStatistics };

    updateTimeToFinishBook();
    if ($activeCloudBookId$) {
      recordCloudStatisticDelta({
        bookId: $activeCloudBookId$,
        title: bookTitle,
        dateKey: historyItem.dateKey,
        readingTimeDelta: -historyItem.timeDiff,
        characterDelta: -historyItem.characterDiff
      });
    }
    flushUpdates();
  }

  function handleVisibilityChange(state: DocumentVisibilityState) {
    if (
      state === 'hidden' &&
      $cloudAudiobookTrackingActive$ &&
      audiobookSample &&
      !audiobookSample.paused
    ) {
      audiobookBackgroundCharacterCatchupPending = true;
    }

    if ($trackerAutoPause$ !== TrackerAutoPause.MODERATE) {
      return;
    }

    if (
      state === 'hidden' &&
      !$isTrackerPaused$ &&
      (!$trackerPopupDetection$ || !isDictionaryDisplayed())
    ) {
      pausedByAutoPause = true;
      isTrackerPaused$.next(true);
    } else if (
      state === 'visible' &&
      $isTrackerPaused$ &&
      pausedByAutoPause &&
      !wasTrackerPaused &&
      ($trackerPopupDetection$ || !isDictionaryDisplayed())
    ) {
      pausedByAutoPause = false;
      isTrackerPaused$.next(false);
    }
  }

  function updateReadingGoalWindowForPausedState(isTrackerMenuOpen: boolean) {
    if (isTrackerMenuOpen && wasTrackerPaused) {
      updateReadingGoalWindow();
    }
  }

  async function init() {
    try {
      todayKey = getDateKey($startDayHoursForTracker$);
      jpdbPopover = document.getElementById('jpdb-popup');

      const statisticsForTitle = await database.getStatisticsForBook(bookTitle);
      const setFirstBookReadResult = await database.setFirstBookRead(
        bookTitle,
        $startDayHoursForTracker$,
        statisticsForTitle[0]
      );

      bookStartDate = setFirstBookReadResult[0] as string;

      if (setFirstBookReadResult[1]) {
        dispatch('statisticsSaved');
      }

      for (let index = 0, { length } = statisticsForTitle; index < length; index += 1) {
        const statisticEntry = statisticsForTitle[index];

        statistics.set(statisticEntry.dateKey, statisticEntry);

        addToStatistic(allTimeStatistics, statisticEntry);

        if (todayKey === statisticEntry.dateKey) {
          addToStatistic(todaysStatistics, statisticEntry);
        }

        if (statisticEntry.completedBook && statisticEntry.completedData) {
          bookCompletionStatistics = statisticEntry.completedData;
        }
      }

      trackerInitialized = true;
      resetAudiobookTracking();
      dispatch('trackerAvailable');
    } catch ({ message }: any) {
      logger.error(`Error initializing timer: ${message}`);
    }
  }

  async function updateReadingGoalWindow() {
    todayKey = getDateKey($startDayHoursForTracker$);
    todaysStatistics = statistics.get(todayKey) || getDefaultStatistic(bookTitle, todayKey);

    try {
      await tick();

      let currentClosedReadingGoal: BooksDbReadingGoal | undefined;

      if (!hasReadingGoal) {
        currentClosedReadingGoal = await database.getCurrentClosedReadingGoal(todayKey);

        if (!currentClosedReadingGoal) {
          return;
        }
      }

      currentReadingGoal = currentClosedReadingGoal || $readingGoal$;
      [currentReadingGoalStart, currentReadingGoalEnd, remainingTimeInReadingGoalWindow] =
        getReadingGoalWindow(todayKey, $startDayHoursForTracker$, currentReadingGoal);

      if (
        currentClosedReadingGoal?.goalEndDate &&
        currentClosedReadingGoal.goalEndDate < currentReadingGoalEnd
      ) {
        currentReadingGoalEnd = currentClosedReadingGoal.goalEndDate;

        const adjustedEndDate = getDate(currentReadingGoalEnd, $startDayHoursForTracker$);

        remainingTimeInReadingGoalWindow = toTimeString(
          (adjustedEndDate.getTime() + 8.64e7 - Date.now()) / 1000
        );
      }

      const statisticsForTimeWindow = await database.getStatisticsForTimeWindow(
        currentReadingGoalStart,
        currentReadingGoalEnd
      );

      currentTimeGoal = 0;
      currentCharacterGoal = 0;

      for (let index = 0, { length } = statisticsForTimeWindow; index < length; index += 1) {
        const statistic = statisticsForTimeWindow[index];

        currentTimeGoal += statistic.readingTime;
        currentCharacterGoal += statistic.charactersRead;
      }
    } catch ({ message }: any) {
      logger.error(`Error updating Goal Data: ${message}`);
    }
  }

  function resetAudiobookTracking() {
    audiobookSample = undefined;
    audiobookPauseStartedAt = 0;
    audiobookPendingTime = 0;
    audiobookPendingCharacters = 0;
    audiobookUnattributedTimeByDate.clear();
    audiobookBackgroundCharacterCatchupPending = false;
    audiobookLastExploredCharCount = exploredCharCount;
    audiobookLastStatProcessAt = Date.now();
  }

  function handleAudiobookProgress(event: CustomEvent<CloudAudiobookPlaybackDetail>) {
    if (!$cloudAudiobookTrackingActive$) return;

    const detail = event.detail;
    if (!detail || !Number.isFinite(detail.seconds)) return;

    const now = Date.now();
    const current = {
      seconds: detail.seconds,
      at: now,
      paused: detail.paused !== false,
      playbackRate:
        typeof detail.playbackRate === 'number' &&
        Number.isFinite(detail.playbackRate) &&
        detail.playbackRate > 0
          ? detail.playbackRate
          : 1
    };
    const previous = audiobookSample;

    if (!previous) {
      audiobookSample = current;
      audiobookPauseStartedAt = current.paused ? now : 0;
      audiobookLastExploredCharCount = exploredCharCount;
      return;
    }

    // Count only time for which the media timeline actually advanced. This
    // naturally excludes buffering. Divide by rate so 60 seconds at 2x counts
    // as roughly 30 seconds of actual listening time.
    if (!previous.paused) {
      const mediaDelta = current.seconds - previous.seconds;
      const wallDelta = Math.max(0, (now - previous.at) / 1000);
      const expectedMediaDelta = wallDelta * previous.playbackRate;
      const maxNaturalMediaDelta = Math.max(3, expectedMediaDelta * 2.5 + 1);

      // A much larger delta is a seek, not listening time.
      if (mediaDelta > 0 && mediaDelta <= maxNaturalMediaDelta) {
        const playedWallTime = Math.min(
          mediaDelta / previous.playbackRate,
          wallDelta + 0.5
        );
        const naturalListeningTime = Math.max(0, playedWallTime);
        audiobookPendingTime += naturalListeningTime;
        accumulateAudiobookUnattributedTime(naturalListeningTime, now);
        if (document.visibilityState === 'hidden') {
          audiobookBackgroundCharacterCatchupPending = true;
        }
      }
    }

    if (current.paused && !previous.paused) {
      audiobookPauseStartedAt = now;
      collectAudiobookCharacters();
      flushAudiobookPending(true);
    } else if (!current.paused && previous.paused) {
      const pauseDuration = Math.max(
        0,
        (now - (audiobookPauseStartedAt || previous.at)) / 1000
      );
      const pauseLimit = Math.max(1, Number($audiobookShortPauseSeconds$) || 10);

      if ($audiobookCountShortPauses$ && pauseDuration <= pauseLimit) {
        audiobookPendingTime += pauseDuration;
      }
      audiobookPauseStartedAt = 0;
    }

    audiobookSample = current;
    collectAudiobookCharacters();
    flushAudiobookPending();
  }

  function accumulateAudiobookUnattributedTime(seconds: number, referenceTick: number) {
    let remaining = Math.max(0, seconds);
    if (!remaining) return;

    let cursor = new Date(referenceTick);
    while (remaining > 0.000001) {
      // getSecondsToDate() is the distance back to the configured reading-day
      // boundary. Split a delayed media sample across that boundary so later
      // character catch-up can be assigned to the correct date(s).
      const secondsOnDay = Math.max(0.001, getSecondsToDate($startDayHoursForTracker$, cursor));
      const slice = Math.min(remaining, secondsOnDay);
      const dateKey = getDateKey($startDayHoursForTracker$, cursor);
      const existing = audiobookUnattributedTimeByDate.get(dateKey);
      audiobookUnattributedTimeByDate.set(dateKey, {
        seconds: (existing?.seconds || 0) + slice,
        referenceTick: existing?.referenceTick || cursor.getTime()
      });

      remaining -= slice;
      if (remaining <= 0.000001) break;
      cursor = new Date(cursor.getTime() - slice * 1000 - 1);
    }
  }

  function attributeAudiobookCharactersToListeningDays(characterDiff: number): boolean {
    if (characterDiff <= 0 || !audiobookUnattributedTimeByDate.size) return false;

    const buckets = [...audiobookUnattributedTimeByDate.values()].filter(
      (bucket) => bucket.seconds > 0
    );
    const totalSeconds = buckets.reduce((sum, bucket) => sum + bucket.seconds, 0);
    if (!(totalSeconds > 0)) return false;

    let charactersRemaining = characterDiff;
    for (let index = 0; index < buckets.length; index += 1) {
      const bucket = buckets[index];
      const charactersForBucket =
        index === buckets.length - 1
          ? charactersRemaining
          : Math.round(characterDiff * (bucket.seconds / totalSeconds));
      charactersRemaining -= charactersForBucket;
      if (!charactersForBucket) continue;

      // Time was already recorded continuously from the media timeline. This is
      // a character-only correction, deliberately using the original listening
      // day's timestamp rather than the time at which the hidden EPUB caught up.
      void processStatistics(charactersForBucket, 0, bucket.referenceTick, false);
    }

    audiobookUnattributedTimeByDate.clear();
    return true;
  }

  function collectAudiobookCharacters() {
    if (!trackerInitialized || !$cloudAudiobookTrackingActive$) return;

    const current = exploredCharCount;
    const difference = current - audiobookLastExploredCharCount;
    if (!difference) return;

    // Always move the baseline. A small rewind is treated as a correction:
    // subtract it now, then replaying the same text adds it back, so the net
    // character count stays roughly unchanged. A large backward jump is
    // intentional rereading/navigation, so do not subtract it; consuming that
    // earlier section again will count again.
    audiobookLastExploredCharCount = current;

    if (difference < 0) {
      // A rewind starts a new text/audio relationship. Do not carry listening
      // buckets from the pre-rewind position into the next forward movement.
      audiobookUnattributedTimeByDate.clear();
    }

    if (
      difference > 0 &&
      $trackerForwardSkipThreshold$ &&
      difference >= $trackerForwardSkipThreshold$ &&
      !audiobookBackgroundCharacterCatchupPending
    ) {
      // A deliberate/manual jump breaks the relationship between elapsed audio
      // time and EPUB distance, so do not let old time buckets contaminate the
      // next genuine character movement.
      audiobookUnattributedTimeByDate.clear();
      audiobookBackgroundCharacterCatchupPending = false;
      return;
    }

    if (
      difference < 0 &&
      $trackerBackwardSkipThreshold$ &&
      Math.abs(difference) >= $trackerBackwardSkipThreshold$
    ) {
      audiobookBackgroundCharacterCatchupPending = false;
      return;
    }

    if (!attributeAudiobookCharactersToListeningDays(difference)) {
      audiobookPendingCharacters += difference;
    }
    audiobookBackgroundCharacterCatchupPending = false;
  }

  function flushAudiobookPending(force = false) {
    if (!trackerInitialized) return;

    const now = Date.now();
    const wholeSeconds = Math.floor(audiobookPendingTime);
    const shouldProcessCharacters =
      audiobookPendingCharacters !== 0 && (force || now - audiobookLastStatProcessAt >= 750);

    if (!wholeSeconds && !shouldProcessCharacters) return;

    const timeDiff = wholeSeconds;
    const characterDiff = shouldProcessCharacters ? audiobookPendingCharacters : 0;
    audiobookPendingTime = Math.max(0, audiobookPendingTime - wholeSeconds);
    if (shouldProcessCharacters) audiobookPendingCharacters = 0;
    audiobookLastStatProcessAt = now;

    void processStatistics(
      characterDiff,
      timeDiff,
      now,
      force || now - lastTrackerFlushTime > 10_000
    );
  }

  function processTicks() {
    const now = Date.now();
    const nowTick = trackerIdleTime ? Math.min(trackerIdleTime, now) : now;
    const trackerIdleTimeReached = trackerIdleTime && nowTick >= trackerIdleTime;
    const elapsed = Math.round((nowTick - lastTrackerTick) / 1000);

    lastTrackerTick = nowTick;

    if (trackerIdleTimeReached) {
      wasTrackerPaused = true;
      isTrackerPaused$.next(true);

      if (frozenPosition === -1) {
        if ($adjustStatisticsAfterIdleTime$) {
          processStatistics(0, elapsed - $trackerIdleTime$, lastTrackerTick, true);
        } else if (elapsed) {
          processStatistics(0, elapsed, lastTrackerTick, true);
        }
      }

      return;
    }

    if (frozenPosition === -1) {
      const characterDiff = exploredCharCount - lastExploredCharCount;
      let finalCharacterDiff =
        characterDiff < 0 && Math.abs(characterDiff) > sessionStatistics.charactersRead
          ? -sessionStatistics.charactersRead
          : characterDiff;

      if (
        (finalCharacterDiff > 0 &&
          $trackerForwardSkipThreshold$ &&
          finalCharacterDiff >= $trackerForwardSkipThreshold$) ||
        (finalCharacterDiff < 0 &&
          $trackerBackwardSkipThreshold$ &&
          finalCharacterDiff <= -Math.abs($trackerBackwardSkipThreshold$))
      ) {
        if ($trackerSkipThresholdAction$ === TrackerSkipThresholdAction.PAUSE) {
          wasTrackerPaused = true;
          isTrackerPaused$.next(true);
          return;
        }
        finalCharacterDiff = 0;
      }

      previousLastExploredCharCount = lastExploredCharCount;
      lastExploredCharCount = exploredCharCount;

      processStatistics(
        finalCharacterDiff,
        elapsed,
        lastTrackerTick,
        now - lastTrackerFlushTime > 10000
      );
    }
  }

  function addToStatistic(statisticObject: BooksDbStatistic, entry: BooksDbStatistic) {
    const statistic = statisticObject;

    statistic.title = entry.title;
    statistic.readingTime += entry.readingTime;
    statistic.charactersRead += entry.charactersRead;
    statistic.lastReadingSpeed = statistic.readingTime
      ? Math.ceil((3600 * statistic.charactersRead) / statistic.readingTime)
      : 0;
    statistic.minReadingSpeed = statistic.minReadingSpeed
      ? Math.min(statistic.minReadingSpeed, statistic.lastReadingSpeed)
      : statistic.lastReadingSpeed;
    statistic.altMinReadingSpeed = statistic.altMinReadingSpeed
      ? Math.min(statistic.altMinReadingSpeed, statistic.lastReadingSpeed)
      : statistic.lastReadingSpeed;
    statistic.maxReadingSpeed = Math.max(statistic.maxReadingSpeed, statistic.lastReadingSpeed);
    statistic.lastStatisticModified = Math.max(
      statistic.lastStatisticModified,
      entry.lastStatisticModified
    );
  }

  function updateStatistic(
    statisticObject: BooksDbStatistic,
    timeDiff: number,
    characterDiff: number,
    lastStatisticModified: number
  ) {
    const statistic = statisticObject;

    statistic.readingTime = Math.max(0, statistic.readingTime + timeDiff);
    statistic.charactersRead = Math.max(0, statistic.charactersRead + characterDiff);
    statistic.lastReadingSpeed = statistic.readingTime
      ? Math.ceil((3600 * statistic.charactersRead) / statistic.readingTime)
      : 0;
    statistic.minReadingSpeed = statistic.minReadingSpeed
      ? Math.min(statistic.minReadingSpeed, statistic.lastReadingSpeed)
      : statistic.lastReadingSpeed;
    statistic.maxReadingSpeed = Math.max(statistic.maxReadingSpeed, statistic.lastReadingSpeed);
    statistic.lastStatisticModified = lastStatisticModified;

    if (characterDiff) {
      statistic.altMinReadingSpeed = statistic.altMinReadingSpeed
        ? Math.min(statistic.altMinReadingSpeed, statistic.lastReadingSpeed)
        : statistic.lastReadingSpeed;
    }

    return statistic;
  }

  function updateTimeToFinishBook() {
    timeToFinishBook = sessionStatistics.lastReadingSpeed
      ? toTimeString(
          Math.max(
            0,
            Math.floor(
              (bookCharCount - exploredCharCount) / (sessionStatistics.lastReadingSpeed / 3600)
            )
          )
        )
      : 'N/A';
  }
</script>

{$readingTracker$ ?? ''}
{$updateTrackerIdleTime$ ?? ''}
{$audiobookProgressTracker$ ?? ''}
{$audiobookCharacterTracker$ ?? ''}
{$autoScrollerTimer$ ?? ''}

<svelte:window on:blur={handleBlur} on:focus={handleFocus} />
<svelte:document bind:visibilityState />

{#if $isTrackerMenuOpen$}
  <div
    class="writing-horizontal-tb fixed top-0 left-0 z-[60] flex h-full w-full max-w-xl flex-col justify-between"
    style:color={fontColor}
    style:background-color={backgroundColor}
    in:fly|local={{ x: -100, duration: 100, easing: quintInOut }}
    use:clickOutside={() => {
      if (!actionInProgress) {
        dialogManager.dialogs$.next([]);
        dispatch('trackerMenuClosed');
      }
    }}
  >
    <BookTimerMenu
      {fontColor}
      {backgroundColor}
      {actionInProgress}
      {hadError}
      {currentReadingGoal}
      {currentTimeGoal}
      {currentCharacterGoal}
      {currentReadingGoalStart}
      {currentReadingGoalEnd}
      {remainingTimeInReadingGoalWindow}
      {timeToFinishBook}
      {exploredCharCount}
      {lastExploredCharCount}
      {previousLastExploredCharCount}
      {frozenPosition}
      {trackingHistory}
      {sessionStatistics}
      {todaysStatistics}
      {allTimeStatistics}
      {bookCompletionStatistics}
      {autoScrollerStatistics}
      {bookStartDate}
      {sectionData}
      canSaveStatistics={statisticsToStore.size > 0}
      bind:wasTrackerPaused
      on:trackerMenuClosed
      on:freezeCurrentLocation
      on:updateCurrentLocation={updateLastExploredCharCount}
      on:saveStatistics={() => flushUpdates()}
      on:revertStatistic={revertTrackerHistory}
    />
  </div>
{/if}
