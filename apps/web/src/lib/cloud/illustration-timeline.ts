/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import type { Subtitle } from '$lib/whispersync-upstream/lib/general';
import { getSubtitleIdFromElement, getLineCSSSelector } from '$lib/whispersync-upstream/lib/util';
import type { IllustrationTimelineEntry } from '$lib/listening-mode/types';
import { buildIllustrationTimeline, type IllustrationAnchor } from './illustration-timeline-logic';

export { buildIllustrationTimeline } from './illustration-timeline-logic';
export type { IllustrationAnchor } from './illustration-timeline-logic';

const MAX_ILLUSTRATIONS = 1500;
const SMALL_IMAGE_DIMENSION = 64;
const DECORATIVE_TOKEN =
  /(?:^|[\s/_.-])(cover|logo|icon|separator|divider|ornament|decoration|spacer|blank|gaiji)(?:$|[\s/_.-])/i;

/**
 * Infer a compact illustration timeline from the already aligned EPUB HTML.
 * The operation is intentionally one-shot: the output belongs in cloud
 * alignment metadata and is not recomputed during playback.
 */
export function inferIllustrationTimeline(
  elementHtml: string,
  subtitles: Subtitle[],
  ownerDocument: Document = document
): IllustrationTimelineEntry[] {
  if (!elementHtml || !subtitles.length || typeof ownerDocument?.createElement !== 'function') {
    return [];
  }

  const parsedDocument = ownerDocument.implementation.createHTMLDocument('Cloud Reader alignment');
  const root = parsedDocument.createElement('div');
  root.innerHTML = elementHtml;

  const subtitleById = new Map(subtitles.map((subtitle) => [subtitle.id, subtitle]));
  const lines = [...root.querySelectorAll(getLineCSSSelector())];
  if (!lines.length) return [];

  const candidates = [...root.querySelectorAll<HTMLElement>('img, svg image')].filter((image) =>
    isMeaningfulImage(image)
  );
  const anchors: IllustrationAnchor[] = [];
  const seen = new Set<string>();

  for (const image of candidates) {
    if (anchors.length >= MAX_ILLUSTRATIONS) break;

    // A line containing an image is generally a decorative inline icon rather
    // than a chapter illustration. The surrounding reader remains available for
    // extensions, but such images should not interrupt playback.
    if (image.closest(getLineCSSSelector())) continue;

    const beforeLine = lines.findLast((line) => isBefore(line, image));
    const afterLine = lines.find((line) => isBefore(image, line));
    const beforeSubtitle = beforeLine
      ? subtitleById.get(getSubtitleIdFromElement(beforeLine))
      : undefined;
    const afterSubtitle = afterLine
      ? subtitleById.get(getSubtitleIdFromElement(afterLine))
      : undefined;

    if (!beforeSubtitle && !afterSubtitle) continue;

    const triggerSeconds = beforeSubtitle
      ? Math.max(0, beforeSubtitle.endSeconds)
      : Math.max(0, afterSubtitle!.startSeconds);
    const href = getImageReference(image);
    if (!href) continue;

    const resourceKey = extractResourceKey(href, image.getAttribute('data-ttu-book-image-key'));
    const dedupeKey = `${resourceKey || href}|${Math.round(triggerSeconds * 10)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    anchors.push({
      href,
      ...(resourceKey ? { resourceKey } : {}),
      ...(image.getAttribute('alt') ? { alt: image.getAttribute('alt') || undefined } : {}),
      ...(beforeSubtitle ? { beforeSubtitleId: beforeSubtitle.id } : {}),
      ...(afterSubtitle ? { afterSubtitleId: afterSubtitle.id } : {})
    });
  }

  return buildIllustrationTimeline(anchors, subtitles);
}

function isBefore(first: Element, second: Element): boolean {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}

function isMeaningfulImage(image: HTMLElement): boolean {
  const descriptor = [
    image.getAttribute('alt'),
    image.getAttribute('title'),
    image.getAttribute('class'),
    image.getAttribute('id'),
    image.getAttribute('src'),
    image.getAttribute('href'),
    image.getAttribute('xlink:href')
  ]
    .filter(Boolean)
    .join(' ');

  if (DECORATIVE_TOKEN.test(descriptor)) return false;
  if (image.getAttribute('aria-hidden') === 'true') return false;

  const width = Number.parseFloat(image.getAttribute('width') || 'NaN');
  const height = Number.parseFloat(image.getAttribute('height') || 'NaN');
  if (
    (Number.isFinite(width) && width <= SMALL_IMAGE_DIMENSION) ||
    (Number.isFinite(height) && height <= SMALL_IMAGE_DIMENSION)
  ) {
    return false;
  }

  return Boolean(getImageReference(image));
}

function getImageReference(image: Element): string {
  return (
    image.getAttribute('src') ||
    image.getAttribute('href') ||
    image.getAttribute('xlink:href') ||
    image.getAttribute('data-src') ||
    ''
  ).trim();
}

function extractResourceKey(href: string, explicitKey: string | null): string | undefined {
  if (explicitKey) return explicitKey;
  const marker = href.match(/(?:^|[;?])ttu:([^;?"']+)/i);
  if (marker?.[1]) return decodeURIComponent(marker[1]);
  return undefined;
}
