<script lang="ts">
  import {
    faCircleQuestion,
    faFilter,
    faLeftLong,
    faRightLong,
    faXmark
  } from '@fortawesome/free-solid-svg-icons';
  import Popover from '$lib/components/popover/popover.svelte';
  import {
    type StatisticsDateChange,
    statisticsRangeTemplates,
    statisticsDataAggregrationModes,
    exportStatisticsData$,
    statisticsActionInProgress$,
    statisticsTitleFilterEnabled$,
    statisticsTitleFilterIsOpen$,
    setStatisticsDatesToAllTime$
  } from '$lib/components/statistics/statistics-types';
  import { daysOfWeek } from '$lib/components/statistics/statistics-heatmap/statistics-heatmap';
  import { dialogManager } from '$lib/data/dialog-manager';
  import {
    lastPrimaryReadingDataAggregationMode$,
    lastStartDayOfWeek$,
    lastStatisticsEndDate$,
    lastStatisticsRangeTemplate$,
    lastStatisticsStartDate$
  } from '$lib/data/store';
  import { createEventDispatcher, onMount } from 'svelte';
  import Fa from 'svelte-fa';

  const dispatch = createEventDispatcher<{
    close: void;
    statisticsDateChange: StatisticsDateChange;
  }>();

  const weekDays = [...daysOfWeek.slice(1, 7), daysOfWeek[0]].map((day, index) => {
    if (day === 'Sunday') {
      return { day, index: 0 };
    }
    return { day, index: index + 1 };
  });

  $: selectedStatisticsStartDate = $lastStatisticsStartDate$;

  $: selectedStatisticsEndDate = $lastStatisticsEndDate$;

  onMount(() => {
    dialogManager.dialogs$.next([{ component: '<div/>' }]);

    return () => dialogManager.dialogs$.next([]);
  });

  async function exportStatisticsData(exportAllStatisticsData = true) {
    $statisticsActionInProgress$ = true;

    exportStatisticsData$.next(exportAllStatisticsData);
  }

</script>

<div class="flex items-center p-4">
  <button class="flex items-end md:items-center" on:click={() => dispatch('close')}>
    <Fa icon={faXmark} />
  </button>
  <div class="flex flex-1 items-center justify-end gap-3">
    <span class="hidden text-xs opacity-60 sm:inline">Filters, date range and summary grouping</span>
    <button class="hover:text-[#90CAF9]" on:click={() => exportStatisticsData(false)}>
      Export Selection
    </button>
    <button class="hover:text-[#90CAF9]" on:click={() => exportStatisticsData()}>
      Export All
    </button>
  </div>
</div>
<div class="flex-1 p-4 overflow-auto">
  <button
    class="mb-5 flex w-full items-center justify-between rounded-lg border border-white/25 px-3 py-2 text-left hover:border-[#90CAF9] hover:text-[#90CAF9] disabled:cursor-not-allowed disabled:opacity-40"
    disabled={!$statisticsTitleFilterEnabled$}
    on:click={() => {
      if (!$statisticsTitleFilterEnabled$) return;
      dispatch('close');
      $statisticsTitleFilterIsOpen$ = true;
    }}
  >
    <span>Book titles</span>
    <Fa icon={faFilter} />
  </button>
  <div class="flex flex-col mb-6">
    <label for="datesTemplate">Template</label>
    <select id="datesTemplate" class="text-black" bind:value={$lastStatisticsRangeTemplate$}>
      {#each statisticsRangeTemplates as statisticsRangeTemplate (statisticsRangeTemplate)}
        <option value={statisticsRangeTemplate}>
          {statisticsRangeTemplate}
        </option>
      {/each}
    </select>
  </div>
  <div class="flex flex-col mb-4 sm:hidden">
    <label for="weekDay">Start of Week</label>
    <select id="weekDay" class="text-black" bind:value={$lastStartDayOfWeek$}>
      {#each weekDays as weekDay (weekDay.day)}
        <option value={weekDay.index}>
          {weekDay.day}
        </option>
      {/each}
    </select>
  </div>
  <div class="flex justify-between sm:flex-row">
    <div class="flex flex-col">
      <label for="fromDate">From</label>
      <input
        id="fromDate"
        type="date"
        class="text-black"
        bind:value={selectedStatisticsStartDate}
        on:change={() =>
          dispatch('statisticsDateChange', {
            isStartDate: true,
            dateString: selectedStatisticsStartDate
          })}
      />
    </div>
    <div class="flex flex-col justify-between pt-4 mx-2 text-xl sm:mx-0">
      <button
        on:click={() =>
          dispatch('statisticsDateChange', {
            isStartDate: false,
            dateString: selectedStatisticsStartDate
          })}
      >
        <Fa icon={faRightLong} />
      </button>
      <button
        on:click={() =>
          dispatch('statisticsDateChange', {
            isStartDate: true,
            dateString: selectedStatisticsEndDate
          })}
      >
        <Fa icon={faLeftLong} />
      </button>
    </div>
    <div class="flex flex-col">
      <label for="toDate">To</label>
      <input
        id="toDate"
        type="date"
        class="text-black"
        bind:value={selectedStatisticsEndDate}
        on:change={() =>
          dispatch('statisticsDateChange', {
            isStartDate: false,
            dateString: selectedStatisticsEndDate
          })}
      />
    </div>
    <div class="flex-col hidden sm:flex">
      <label for="weekDay">Start of Week</label>
      <select id="weekDay" class="text-black" bind:value={$lastStartDayOfWeek$}>
        {#each weekDays as weekDay (weekDay.day)}
          <option value={weekDay.index}>
            {weekDay.day}
          </option>
        {/each}
      </select>
    </div>
  </div>
  <button
    class="text-left mt-3 hover:text-red-500"
    on:click={() => setStatisticsDatesToAllTime$.next()}
  >
    Set to All Time for selected Book Titles
  </button>
  <div class="flex flex-col mt-4">
    <Popover
      contentText={'Groups the Summary tab by individual entries, date, or book title.'}
      contentStyles="padding: 0.5rem;"
    >
      <Fa icon={faCircleQuestion} slot="icon" class="mx-2" />
      <label for="primaryAggregration">Summary Grouping</label>
    </Popover>
    <select
      id="primaryAggregration"
      class="text-black"
      bind:value={$lastPrimaryReadingDataAggregationMode$}
    >
      {#each statisticsDataAggregrationModes as statisticsDataAggregrationMode (statisticsDataAggregrationMode)}
        <option value={statisticsDataAggregrationMode}>
          {statisticsDataAggregrationMode}
        </option>
      {/each}
    </select>
  </div>
</div>
