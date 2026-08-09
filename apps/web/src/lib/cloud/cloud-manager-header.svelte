<script lang="ts">
  import { goto } from '$app/navigation';
  import {
    faArrowDownShortWide,
    faArrowDownWideShort,
    faGear,
    faPlus,
    faRotate,
    faSortDown,
    faSortUp
  } from '@fortawesome/free-solid-svg-icons';
  import Fa from 'svelte-fa';
  import Popover from '$lib/components/popover/popover.svelte';
  import { baseHeaderClasses, pxScreen } from '$lib/css-classes';
  import { mergeEntries } from '$lib/components/merged-header-icon/merged-entries';
  import { pagePath } from '$lib/data/env';
  import cloudReaderLogo from '$lib/assets/cloud-reader-logo.png';
  import {
    cloudSort$,
    requestCloudAdd,
    requestCloudRefresh,
    type CloudSortDirection,
    type CloudSortKey
  } from './ui-state';

  let sortPopover: Popover;

  const sortOptions: { key: CloudSortKey; label: string }[] = [
    { key: 'recent', label: 'Last read' },
    { key: 'added', label: 'Added' },
    { key: 'title', label: 'Title' },
    { key: 'progress', label: 'Progress' }
  ];

  function setSort(key: CloudSortKey, direction: CloudSortDirection) {
    cloudSort$.set({ key, direction });
    sortPopover?.toggleOpen();
  }

  const iconButton =
    'flex h-10 w-10 items-center justify-center rounded-xl text-lg opacity-75 transition hover:bg-white hover:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#0D47A1]';
</script>

<header class={baseHeaderClasses}>
  <div class="{pxScreen} flex h-full items-center justify-between">
    <div
      class="flex items-center gap-2 text-[1.12rem] tracking-[0.01em]"
      style="font-family: 'Segoe UI Variable', 'Segoe UI', Arial, sans-serif; font-weight: 650;"
      aria-label="Cloud Reader"
    >
      <img
        src={cloudReaderLogo}
        alt=""
        aria-hidden="true"
        class="h-7 w-7 shrink-0"
      />
      <span>Cloud Reader</span>
    </div>

    <div class="flex h-full items-center gap-1 py-1">
      <button class={iconButton} title="Add to cloud library" aria-label="Add to cloud library" on:click={requestCloudAdd}>
        <Fa icon={faPlus} />
      </button>

      <button class={iconButton} title="Refresh cloud library" aria-label="Refresh cloud library" on:click={requestCloudRefresh}>
        <Fa icon={faRotate} />
      </button>

      <Popover
        placement="bottom-end"
        fallbackPlacements={['bottom', 'bottom-start']}
        yOffset={2}
        bind:this={sortPopover}
      >
        <div slot="icon" class={iconButton} title="Sort cloud library" aria-label="Sort cloud library">
          {#if $cloudSort$.direction === 'asc'}
            <Fa icon={faArrowDownShortWide} />
          {:else}
            <Fa icon={faArrowDownWideShort} />
          {/if}
        </div>

        <div slot="content" class="w-44 overflow-hidden rounded-xl bg-gray-700 p-1 shadow-lg">
          {#each sortOptions as option (option.key)}
            {@const active = $cloudSort$.key === option.key}
            <div
              class="grid grid-cols-[2.25rem_1fr_2.25rem] items-center rounded-lg text-sm transition hover:bg-white hover:text-gray-700"
              class:bg-white={active}
              class:text-gray-700={active}
            >
              <button
                class="flex h-9 items-center justify-center rounded-lg opacity-70 hover:opacity-100"
                style:color={active && $cloudSort$.direction === 'asc' ? '#2196F3' : undefined}
                title={`${option.label}, ascending`}
                on:click={() => setSort(option.key, 'asc')}
              >
                <Fa icon={faSortUp} />
              </button>
              <span class="py-2">{option.label}</span>
              <button
                class="flex h-9 items-center justify-center rounded-lg opacity-70 hover:opacity-100"
                style:color={active && $cloudSort$.direction === 'desc' ? '#2196F3' : undefined}
                title={`${option.label}, descending`}
                on:click={() => setSort(option.key, 'desc')}
              >
                <Fa icon={faSortDown} />
              </button>
            </div>
          {/each}
        </div>
      </Popover>

      <button
        class={iconButton}
        title="Settings"
        aria-label="Settings"
        on:click={() => goto(`${pagePath}${mergeEntries.SETTINGS.routeId}`)}
      >
        <Fa icon={faGear} />
      </button>
    </div>
  </div>
</header>
