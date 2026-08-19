/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { writable } from 'svelte/store';

/** Published by NativeWhispersync after cloud/local audiobook attachment has resolved. */
export const listeningSessionReady$ = writable<{ localBookId: number } | undefined>(undefined);

/** Browser-safe mirror of whether Whispersync currently owns an audiobook source. */
export const listeningAudioAvailable$ = writable(false);

/** True only while the Listening Mode overlay is actively controlling the reader. */
export const listeningModeActive$ = writable(false);
