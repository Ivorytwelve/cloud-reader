<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import { faRotate, faTrash, faXmark } from '@fortawesome/free-solid-svg-icons';
  import Fa from 'svelte-fa';
  import { getConfiguredCloudApi } from './progress-session';
  import { syncCloudStatisticsToLocal } from './cloud-statistics';
  import type { CloudStatisticAggregate } from './types';

  const dispatch = createEventDispatcher<{ close: void; changed: void }>();

  let entries: CloudStatisticAggregate[] = [];
  let loading = true;
  let error = '';
  let savingKey = '';
  let drafts = new Map<string, { time: string; characters: string }>();

  onMount(() => void load());

  function key(entry: CloudStatisticAggregate) {
    return `${entry.bookId}\u0000${entry.dateKey}`;
  }

  async function load() {
    const api = getConfiguredCloudApi();
    if (!api) {
      error = 'Cloud is not configured.';
      loading = false;
      return;
    }

    loading = true;
    error = '';
    try {
      entries = (await api.getStatistics()).slice().sort((a, b) =>
        a.dateKey === b.dateKey ? a.title.localeCompare(b.title, 'ja-JP') : b.dateKey.localeCompare(a.dateKey)
      );
      const next = new Map<string, { time: string; characters: string }>();
      for (const entry of entries) {
        next.set(key(entry), {
          time: formatEditableTime(entry.readingTime),
          characters: String(Math.max(0, Math.round(entry.charactersRead)))
        });
      }
      drafts = next;
    } catch (caught) {
      error = errorMessage(caught);
    } finally {
      loading = false;
    }
  }

  async function save(entry: CloudStatisticAggregate) {
    const api = getConfiguredCloudApi();
    const draft = drafts.get(key(entry));
    if (!api || !draft) return;

    const readingTime = parseEditableTime(draft.time);
    const charactersRead = Number(draft.characters);
    if (!Number.isFinite(readingTime) || readingTime < 0) {
      error = 'Time must be HH:MM:SS, MM:SS, or a number of seconds.';
      return;
    }
    if (!Number.isFinite(charactersRead) || charactersRead < 0) {
      error = 'Characters must be zero or greater.';
      return;
    }

    savingKey = key(entry);
    error = '';
    try {
      await api.updateStatisticEntry(entry.bookId, entry.dateKey, {
        title: entry.title,
        readingTime,
        charactersRead: Math.round(charactersRead)
      });
      await syncCloudStatisticsToLocal();
      await load();
      dispatch('changed');
    } catch (caught) {
      error = errorMessage(caught);
    } finally {
      savingKey = '';
    }
  }

  async function remove(entry: CloudStatisticAggregate) {
    const api = getConfiguredCloudApi();
    if (!api) return;
    if (!confirm(`Delete the cloud statistics for “${entry.title}” on ${entry.dateKey}?\n\nFuture reading on that day can still add new statistics.`)) return;

    savingKey = key(entry);
    error = '';
    try {
      await api.deleteStatisticEntry(entry.bookId, entry.dateKey);
      await syncCloudStatisticsToLocal();
      await load();
      dispatch('changed');
    } catch (caught) {
      error = errorMessage(caught);
    } finally {
      savingKey = '';
    }
  }


  function updateDraft(entry: CloudStatisticAggregate, field: 'time' | 'characters', value: string) {
    const current = drafts.get(key(entry));
    if (!current) return;
    const next = new Map(drafts);
    next.set(key(entry), { ...current, [field]: value });
    drafts = next;
  }

  function formatEditableTime(seconds: number) {
    const whole = Math.max(0, Math.round(seconds));
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    const rest = whole % 60;
    return [hours, minutes, rest].map((part) => String(part).padStart(2, '0')).join(':');
  }

  function parseEditableTime(value: string): number {
    const trimmed = value.trim();
    if (!trimmed) return NaN;
    if (!trimmed.includes(':')) return Number(trimmed);
    const parts = trimmed.split(':').map(Number);
    if (parts.some((part) => !Number.isFinite(part) || part < 0)) return NaN;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return NaN;
  }

  function speed(entry: CloudStatisticAggregate, draft = drafts.get(key(entry))) {
    if (!draft) return 0;
    const seconds = parseEditableTime(draft.time);
    const chars = Number(draft.characters);
    return seconds > 0 && Number.isFinite(chars) ? Math.round((chars * 3600) / seconds) : 0;
  }

  function errorMessage(value: unknown) {
    return value instanceof Error ? value.message : String(value);
  }
</script>

<div class="flex h-full min-h-0 flex-col bg-[#E3F2FD] text-[#16283D]">
  <div class="flex h-12 shrink-0 items-center justify-between border-b border-[#90CAF9] px-4">
    <div>
      <div class="font-semibold">Cloud statistics data</div>
      <div class="text-[0.7rem] opacity-55">Edit or delete the canonical cloud totals for a book/day.</div>
    </div>
    <div class="flex items-center gap-1">
      <button class="rounded-lg p-2 hover:bg-white/60" title="Refresh" on:click={() => void load()} disabled={loading}>
        <Fa icon={faRotate} />
      </button>
      <button class="rounded-lg p-2 hover:bg-white/60" title="Close" on:click={() => dispatch('close')}>
        <Fa icon={faXmark} />
      </button>
    </div>
  </div>

  {#if error}
    <div class="mx-4 mt-3 rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
  {/if}

  <div class="min-h-0 flex-1 overflow-auto p-4">
    {#if loading}
      <div class="py-8 text-sm opacity-55">Loading cloud statistics…</div>
    {:else if !entries.length}
      <div class="py-8 text-sm opacity-55">No cloud statistics yet.</div>
    {:else}
      <div class="grid gap-2">
        {#each entries as entry (key(entry))}
          {@const draft = drafts.get(key(entry))}
          {#if draft}
            <div class="grid grid-cols-[minmax(0,1fr)_7.5rem_8rem_auto] items-end gap-2 rounded-xl border border-[#90CAF9]/70 bg-white/45 p-3 max-md:grid-cols-2">
              <div class="min-w-0">
                <div class="truncate text-sm font-medium" title={entry.title}>{entry.title}</div>
                <div class="mt-0.5 text-xs opacity-55">{entry.dateKey} · {speed(entry).toLocaleString()} chars/h</div>
              </div>
              <label class="text-xs">
                <span class="mb-1 block opacity-60">Time</span>
                <input class="w-full rounded-lg border border-[#90CAF9] bg-white px-2 py-1.5" value={draft.time} on:input={(event) => updateDraft(entry, 'time', (event.currentTarget as HTMLInputElement).value)} disabled={savingKey === key(entry)} />
              </label>
              <label class="text-xs">
                <span class="mb-1 block opacity-60">Characters</span>
                <input type="number" min="0" step="1" class="w-full rounded-lg border border-[#90CAF9] bg-white px-2 py-1.5" value={draft.characters} on:input={(event) => updateDraft(entry, 'characters', (event.currentTarget as HTMLInputElement).value)} disabled={savingKey === key(entry)} />
              </label>
              <div class="flex items-center justify-end gap-1">
                <button
                  class="rounded-lg bg-[#2196F3] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#0D47A1] disabled:opacity-50"
                  on:click={() => void save(entry)}
                  disabled={savingKey === key(entry)}
                >Save</button>
                <button
                  class="rounded-lg p-2 text-red-600 hover:bg-red-50 disabled:opacity-50"
                  title="Delete this day"
                  on:click={() => void remove(entry)}
                  disabled={savingKey === key(entry)}
                ><Fa icon={faTrash} /></button>
              </div>
            </div>
          {/if}
        {/each}
      </div>
    {/if}
  </div>
</div>
