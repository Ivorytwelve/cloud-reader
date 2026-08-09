import type { CloudProgress } from './types';

export const CLOUD_PROGRESS_UPDATED_EVENT = 'ttu-cloud:progress-updated';
export const CLOUD_PROGRESS_REVISION_KEY = 'ttu-cloud-progress-revision';

export interface CloudProgressUpdatedDetail {
  bookId: string;
  progress?: CloudProgress;
  revision: number;
}

/**
 * Tell the current tab (and other tabs through localStorage's storage event)
 * that cloud progress changed. This lets the manager update immediately after
 * leaving the reader instead of showing stale "Not started" data.
 */
export function announceCloudProgressUpdated(bookId: string, progress?: CloudProgress): void {
  if (typeof window === 'undefined') return;

  const revision = Date.now();
  try {
    localStorage.setItem(CLOUD_PROGRESS_REVISION_KEY, `${revision}:${bookId}`);
  } catch {
    // A progress save must never fail because localStorage is unavailable.
  }

  document.dispatchEvent(
    new CustomEvent<CloudProgressUpdatedDetail>(CLOUD_PROGRESS_UPDATED_EVENT, {
      detail: { bookId, progress, revision }
    })
  );
}
