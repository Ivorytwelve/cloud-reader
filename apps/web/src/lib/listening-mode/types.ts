/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

/**
 * Shared types and pure settings resolution for the audiobook listening mode.
 *
 * The cloud value is deliberately nullable per field: null means "inherit the
 * current device default" rather than "turn this feature off".
 */

export type ListeningOpeningMode = 'reading' | 'listening';
export type ListeningProgressBar = 'chapter' | 'book';

export type CloudListeningSettingValue<T> = T | null;

export interface CloudListeningSettings {
  openingMode?: CloudListeningSettingValue<ListeningOpeningMode>;
  progressBar?: CloudListeningSettingValue<ListeningProgressBar>;
  showSentence?: CloudListeningSettingValue<boolean>;
  keepReaderActive?: CloudListeningSettingValue<boolean>;
  showIllustrations?: CloudListeningSettingValue<boolean>;
  illustrationNotification?: CloudListeningSettingValue<boolean>;
  /** Seconds used by the listening-mode rewind/forward buttons. */
  skipSeconds?: CloudListeningSettingValue<number>;
}

export interface ResolvedListeningSettings {
  openingMode: ListeningOpeningMode;
  progressBar: ListeningProgressBar;
  showSentence: boolean;
  keepReaderActive: boolean;
  showIllustrations: boolean;
  illustrationNotification: boolean;
  skipSeconds: number;
}

export interface IllustrationTimelineEntry {
  /** Stable ordinal for the inferred image in document order. */
  id: string;
  /** Playback time at which the image becomes relevant. */
  triggerSeconds: number;
  /** Original EPUB image reference, kept so each device can resolve its own URL. */
  href: string;
  /** EPUB blob key when it can be recovered from the reference. */
  resourceKey?: string;
  alt?: string;
  confidence: 'high' | 'medium';
  beforeSubtitleId?: string;
  afterSubtitleId?: string;
}

export const defaultListeningSettings: ResolvedListeningSettings = {
  openingMode: 'reading',
  progressBar: 'chapter',
  showSentence: false,
  keepReaderActive: true,
  showIllustrations: true,
  illustrationNotification: false,
  skipSeconds: 10
};

/**
 * Resolve a cloud book's optional overrides against the device defaults.
 * Undefined and null have the same inheritance meaning. This function is kept
 * pure so it can be used by the UI and unit-tested without browser state.
 */
export function resolveListeningSettings(
  overrides: CloudListeningSettings | undefined,
  defaults: ResolvedListeningSettings = defaultListeningSettings
): ResolvedListeningSettings {
  return {
    openingMode: overrides?.openingMode ?? defaults.openingMode,
    progressBar: overrides?.progressBar ?? defaults.progressBar,
    showSentence: overrides?.showSentence ?? defaults.showSentence,
    keepReaderActive: overrides?.keepReaderActive ?? defaults.keepReaderActive,
    showIllustrations: overrides?.showIllustrations ?? defaults.showIllustrations,
    illustrationNotification:
      overrides?.illustrationNotification ?? defaults.illustrationNotification,
    skipSeconds: normalizeSkipSeconds(overrides?.skipSeconds ?? defaults.skipSeconds)
  };
}

export function normalizeSkipSeconds(value: number): number {
  if (!Number.isFinite(value)) return 10;
  return Math.max(1, Math.min(120, Math.round(value)));
}
