/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { IllustrationTimelineEntry } from '$lib/listening-mode/types';

export interface IllustrationAnchor {
  href: string;
  resourceKey?: string;
  alt?: string;
  beforeSubtitleId?: string;
  afterSubtitleId?: string;
}

export interface TimelineSubtitle {
  id: string;
  startSeconds: number;
  endSeconds: number;
}

/** Pure part of the inference pipeline; useful for deterministic tests and for
 * future importers that already have document-order image anchors. */
export function buildIllustrationTimeline(
  anchors: IllustrationAnchor[],
  subtitles: TimelineSubtitle[]
): IllustrationTimelineEntry[] {
  const subtitleById = new Map(subtitles.map((subtitle) => [subtitle.id, subtitle]));
  const result: IllustrationTimelineEntry[] = [];
  const seen = new Set<string>();

  for (const anchor of anchors) {
    const beforeSubtitle = anchor.beforeSubtitleId
      ? subtitleById.get(anchor.beforeSubtitleId)
      : undefined;
    const afterSubtitle = anchor.afterSubtitleId
      ? subtitleById.get(anchor.afterSubtitleId)
      : undefined;
    if (!beforeSubtitle && !afterSubtitle) continue;

    // An EPUB illustration appears at a document boundary. When both sides are
    // aligned, the most natural listening cue is the instant narration finishes
    // the text immediately before the image. Midpoint timing can delay the cue by
    // the entire pause between paragraphs/chapters.
    const triggerSeconds = beforeSubtitle
      ? Math.max(0, beforeSubtitle.endSeconds)
      : Math.max(0, afterSubtitle!.startSeconds);
    const dedupeKey = `${anchor.resourceKey || anchor.href}|${Math.round(triggerSeconds * 10)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    result.push({
      id: `illustration-${result.length + 1}`,
      triggerSeconds,
      href: anchor.href,
      ...(anchor.resourceKey ? { resourceKey: anchor.resourceKey } : {}),
      ...(anchor.alt ? { alt: anchor.alt } : {}),
      confidence: beforeSubtitle && afterSubtitle ? 'high' : 'medium',
      ...(beforeSubtitle ? { beforeSubtitleId: beforeSubtitle.id } : {}),
      ...(afterSubtitle ? { afterSubtitleId: afterSubtitle.id } : {})
    });
  }

  return result.sort((first, second) => first.triggerSeconds - second.triggerSeconds);
}
