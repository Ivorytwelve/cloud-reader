import { browser } from '$app/environment';
import { writable } from 'svelte/store';

export type CloudSortKey = 'recent' | 'added' | 'title' | 'progress';
export type CloudSortDirection = 'asc' | 'desc';

export interface CloudSortState {
  key: CloudSortKey;
  direction: CloudSortDirection;
}

const SORT_KEY = 'ttu-cloud-library-sort';
const defaultSort: CloudSortState = { key: 'recent', direction: 'desc' };

function loadSort(): CloudSortState {
  if (!browser) return defaultSort;
  try {
    const parsed = JSON.parse(localStorage.getItem(SORT_KEY) || '') as Partial<CloudSortState>;
    if (
      ['recent', 'added', 'title', 'progress'].includes(parsed.key || '') &&
      (parsed.direction === 'asc' || parsed.direction === 'desc')
    ) {
      return parsed as CloudSortState;
    }
  } catch {
    // Ignore invalid/stale local settings.
  }
  return defaultSort;
}

export const cloudSort$ = writable<CloudSortState>(loadSort());
export const cloudAddRequest$ = writable(0);
export const cloudRefreshRequest$ = writable(0);

if (browser) {
  cloudSort$.subscribe((value) => localStorage.setItem(SORT_KEY, JSON.stringify(value)));
}

export function requestCloudAdd() {
  cloudAddRequest$.update((value) => value + 1);
}

export function requestCloudRefresh() {
  cloudRefreshRequest$.update((value) => value + 1);
}
