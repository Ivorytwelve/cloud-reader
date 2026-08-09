<script lang="ts">
  import StatisticsContent from '$lib/components/statistics/statistics-content.svelte';
  import { syncCloudStatisticsToLocal } from '$lib/cloud/cloud-statistics';
  import StatisticsHeader from '$lib/components/statistics/statistics-header.svelte';
  import StatisticsSettings from '$lib/components/statistics/statistics-settings.svelte';
  import {
    StatisticsRangeTemplate,
    type StatisticsDateChange,
    preFilteredTitlesForStatistics$,
    statisticsActionInProgress$
  } from '$lib/components/statistics/statistics-types';
  import { pxScreen } from '$lib/css-classes';
  import {
    database,
    lastStartDayOfWeek$,
    lastStatisticsEndDate$,
    lastStatisticsRangeTemplate$,
    lastStatisticsStartDate$,
    startDayHoursForTracker$
  } from '$lib/data/store';
  import {
    advanceDateDays,
    getDateKey,
    getDateString,
    getStartHoursDate
  } from '$lib/functions/statistic-util';
  import { clickOutside } from '$lib/functions/use-click-outside';
  import { map, share } from 'rxjs';
  import { onDestroy, onMount, tick } from 'svelte';
  import { quintInOut } from 'svelte/easing';
  import { fly } from 'svelte/transition';

  const currentBookId$ = database.lastItem$.pipe(
    map((item) => item?.dataId),
    share()
  );

  let showStatisticsSettings = false;
  let cloudStatisticsReady = false;
  let cloudStatisticsError = '';

  onMount(async () => {
    try {
      await syncCloudStatisticsToLocal();
    } catch (error) {
      cloudStatisticsError = error instanceof Error ? error.message : String(error);
    } finally {
      cloudStatisticsReady = true;
    }
  });

  $: if ($lastStatisticsRangeTemplate$ || $lastStartDayOfWeek$ > -1) {
    tick().then(() => setSelectedStatisticsDays());
  }

  onDestroy(() => ($preFilteredTitlesForStatistics$ = new Set()));

  function handleSelectedStatisticsDateChange({
    detail: { dateString, isStartDate }
  }: CustomEvent<StatisticsDateChange>) {
    const referenceDate = getStartHoursDate($startDayHoursForTracker$);
    const todayKey = getDateKey($startDayHoursForTracker$, referenceDate);

    $lastStatisticsRangeTemplate$ = StatisticsRangeTemplate.CUSTOM;

    if (isStartDate) {
      $lastStatisticsStartDate$ = dateString || todayKey;
    } else {
      $lastStatisticsEndDate$ = dateString || todayKey;
    }

    if ($lastStatisticsStartDate$ > $lastStatisticsEndDate$) {
      const originalStartDate = $lastStatisticsStartDate$;
      const originalEndDate = $lastStatisticsEndDate$;

      $lastStatisticsStartDate$ = originalEndDate;
      $lastStatisticsEndDate$ = originalStartDate;
    }

    setSelectedStatisticsDays(referenceDate);
  }

  function setSelectedStatisticsDays(referenceDate = getStartHoursDate($startDayHoursForTracker$)) {
    switch ($lastStatisticsRangeTemplate$) {
      case StatisticsRangeTemplate.TODAY: {
        const dateKey = getDateString(referenceDate);

        $lastStatisticsStartDate$ = dateKey;
        $lastStatisticsEndDate$ = dateKey;
        break;
      }
      case StatisticsRangeTemplate.WEEK: {
        const dayIndex = referenceDate.getDay();

        let dayDiff = 0;

        if ($lastStartDayOfWeek$ !== dayIndex) {
          if (!$lastStartDayOfWeek$) {
            dayDiff = -dayIndex;
          } else if (!dayIndex) {
            dayDiff = $lastStartDayOfWeek$ - 7;
          } else {
            dayDiff =
              $lastStartDayOfWeek$ > dayIndex
                ? $lastStartDayOfWeek$ - dayIndex - 7
                : $lastStartDayOfWeek$ - dayIndex;
          }
        }

        ({ dateString: $lastStatisticsStartDate$ } = advanceDateDays(referenceDate, dayDiff));
        ({ dateString: $lastStatisticsEndDate$ } = advanceDateDays(referenceDate, 6));
        break;
      }
      case StatisticsRangeTemplate.MONTH: {
        referenceDate.setDate(1);

        $lastStatisticsStartDate$ = getDateString(referenceDate);

        referenceDate.setMonth(referenceDate.getMonth() + 1);

        ({ dateString: $lastStatisticsEndDate$ } = advanceDateDays(referenceDate, -1));
        break;
      }
      case StatisticsRangeTemplate.YEAR: {
        referenceDate.setMonth(0);
        referenceDate.setDate(1);

        $lastStatisticsStartDate$ = getDateString(referenceDate);

        referenceDate.setFullYear(referenceDate.getFullYear() + 1);

        ({ dateString: $lastStatisticsEndDate$ } = advanceDateDays(referenceDate, -1));
        break;
      }
      default:
        break;
    }
  }
</script>

<StatisticsHeader currentBookId={$currentBookId$} bind:showStatisticsSettings />

<div class="{pxScreen} flex flex-col pt-16 h-full xl:pt-14">
  {#if cloudStatisticsReady}
    {#if cloudStatisticsError}
      <div class="mb-3 rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-700">
        Cloud statistics sync failed: {cloudStatisticsError}. Showing the local cache.
      </div>
    {/if}
    <StatisticsContent />
  {:else}
    <div class="py-8 text-sm opacity-60">Syncing cloud statistics…</div>
  {/if}
</div>

{#if showStatisticsSettings}
  <div
    class="writing-horizontal-tb fixed top-0 right-0 z-[60] flex h-full w-full max-w-xl flex-col justify-between bg-gray-700 text-white"
    in:fly|local={{ x: 100, duration: 100, easing: quintInOut }}
    use:clickOutside={() => {
      if (!$statisticsActionInProgress$) {
        showStatisticsSettings = false;
      }
    }}
  >
    <StatisticsSettings
      on:statisticsDateChange={handleSelectedStatisticsDateChange}
      on:close={() => (showStatisticsSettings = false)}
    />
  </div>
{/if}
