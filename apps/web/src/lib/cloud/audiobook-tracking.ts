import { writableSubject } from '$lib/functions/svelte/store';

/**
 * True while the currently open cloud book has a cloud-hosted audiobook attached.
 * The reading tracker uses this to switch from Ttsu's page-open timer to
 * media-driven consumption tracking.
 */
export const cloudAudiobookTrackingActive$ = writableSubject(false);

/** Stable cloud UUID of the book currently open in the reader. */
export const activeCloudBookId$ = writableSubject<string | undefined>(undefined);

export interface CloudAudiobookPlaybackDetail {
  seconds: number;
  duration?: number;
  playbackRate?: number;
  paused?: boolean;
}

export const CLOUD_AUDIOBOOK_PROGRESS_EVENT = 'ttu-cloud:audiobook-progress';
