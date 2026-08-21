/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import { BlurMode } from '$lib/data/blur-mode';
import type { BooksDbBookData } from '$lib/data/database/books-db/versions/books-db';
import { Observable } from 'rxjs';
import { BaseStorageHandler } from '$lib/data/storage/handler/base-handler';
import buildDummyBookImage from '$lib/functions/file-loaders/utils/build-dummy-book-image';
import { isElementGaiji } from '$lib/functions/is-element-gaiji';
import { map } from 'rxjs/operators';
import {
  readerImageGalleryPictures$,
  type ReaderImageGalleryPicture
} from '$lib/components/book-reader/book-reader-image-gallery/book-reader-image-gallery';

export default function formatBookDataHtml(
  bookData: BooksDbBookData,
  document: Document,
  isPaginated: boolean,
  blurMode: BlurMode
) {
  return getHtmlWithImageSource(bookData, isPaginated, document).pipe(
    map((elementHtml) => {
      const element = document.createElement('div');
      element.innerHTML = elementHtml;

      addImageResourceKeys(element, bookData.blobs);
      addImageContainerClass(element);
      // combineImagePairs(element);
      removeSvgDimensions(element);
      addSpoilerTags(element, document, blurMode);
      removeOldBrTagSolution(element);

      return element.innerHTML;
    })
  );
}

function getHtmlWithImageSource(bookData: BooksDbBookData, isPaginated: boolean, document: Document) {
  return new Observable<string>((subscriber) => {
    const { blobs } = bookData;
    const objectUrls: string[] = [];
    const urlIndexes = new Map<string, number>();

    let { elementHtml } = bookData;

    const objectUrlByBlobKey = new Map<string, string>();

    Object.entries(blobs).forEach(([key, value]) => {
      const url = URL.createObjectURL(
        value.type
          ? value
          : new Blob([value], { type: BaseStorageHandler.getImageMimeTypeFromExtension(key) })
      );
      const dummyUrl = buildDummyBookImage(key);
      const escapedKey = key.replace(/"/g, '&quot;');
      const imageMarker = `data-ttu-book-image-key="${escapedKey}"`;

      objectUrls.push(url);
      objectUrlByBlobKey.set(key, url);
      urlIndexes.set(url, elementHtml.indexOf(dummyUrl));

      elementHtml = elementHtml
        .replaceAll(`src="${dummyUrl}"`, `src="${url}" ${imageMarker}`)
        .replaceAll(`src='${dummyUrl}'`, `src='${url}' ${imageMarker}`)
        .replaceAll(`href="${dummyUrl}"`, `href="${url}" ${imageMarker}`)
        .replaceAll(`href='${dummyUrl}'`, `href='${url}' ${imageMarker}`)
        .replaceAll(`xlink:href="${dummyUrl}"`, `xlink:href="${url}" ${imageMarker}`)
        .replaceAll(`xlink:href='${dummyUrl}'`, `xlink:href='${url}' ${imageMarker}`)
        .replaceAll(dummyUrl, url)
        .replaceAll(`ttu:${key}`, url);
    });

    // Cloud alignments produced outside TTSU (notably Audiobook Center's
    // Python matcher) can contain normal EPUB-relative image references rather
    // than TTSU's data:image/...;ttu:<blob-key> placeholders. The EPUB import
    // still preserved all image blobs, so reconnect those references here.
    // This is deliberately a render-time compatibility repair: it fixes books
    // that were already cached with an external alignment without rewriting the
    // user's local book database or requiring a re-upload.
    elementHtml = reconnectRelativeBookImages(
      elementHtml,
      Object.keys(blobs),
      objectUrlByBlobKey,
      document
    );

    for (const url of objectUrls) {
      if ((urlIndexes.get(url) ?? -1) < 0) urlIndexes.set(url, elementHtml.indexOf(url));
    }

    subscriber.next(elementHtml);

    const readerImageGalleryPictures: ReaderImageGalleryPicture[] = objectUrls.map((url) => ({
      url,
      unspoilered: !isPaginated
    }));

    readerImageGalleryPictures.sort((picture1, picture2) => {
      const index1 = urlIndexes.get(picture1.url) || 0;
      const index2 = urlIndexes.get(picture2.url) || 0;

      return index1 - index2;
    });

    readerImageGalleryPictures$.next(readerImageGalleryPictures);

    return () => {
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  });
}

function reconnectRelativeBookImages(
  elementHtml: string,
  blobKeys: string[],
  objectUrlByBlobKey: Map<string, string>,
  document: Document
): string {
  if (!elementHtml || !blobKeys.length) return elementHtml;

  const root = document.createElement('div');
  root.innerHTML = elementHtml;
  const images = [...root.querySelectorAll<HTMLElement>('img, image')];

  for (const image of images) {
    const attributes = ['src', 'href', 'xlink:href'];
    for (const attribute of attributes) {
      const reference = image.getAttribute(attribute);
      if (!reference) continue;

      // External alignments can contain a valid TTSU dummy-image URL whose
      // embedded key is expressed from a different EPUB path root than the
      // locally imported blob key. Exact replaceAll() above cannot repair that
      // case, even though the underlying image blob is present. Resolve the key
      // carried inside the dummy URL with the same suffix/basename matching used
      // for ordinary EPUB-relative paths.
      const dummyKey = extractDummyBookImageKey(reference);
      if (dummyKey) {
        const key = findBlobKeyForImageReference(dummyKey, blobKeys);
        const url = key ? objectUrlByBlobKey.get(key) : undefined;
        if (!key || !url) continue;
        image.setAttribute(attribute, url);
        image.setAttribute('data-ttu-book-image-key', key);
        break;
      }

      if (isAlreadyResolvedImageReference(reference)) continue;

      const key = findBlobKeyForImageReference(reference, blobKeys);
      const url = key ? objectUrlByBlobKey.get(key) : undefined;
      if (!key || !url) continue;

      image.setAttribute(attribute, url);
      image.setAttribute('data-ttu-book-image-key', key);
      break;
    }
  }

  return root.innerHTML;
}

function extractDummyBookImageKey(reference: string): string | undefined {
  const match = reference.trim().match(/^data:image\/gif;ttu:([^;]+);base64,/i);
  return match?.[1];
}

function isAlreadyResolvedImageReference(reference: string): boolean {
  return /^(?:blob:|data:|https?:)/i.test(reference.trim());
}

function findBlobKeyForImageReference(reference: string, blobKeys: string[]): string | undefined {
  const normalizedReference = normalizeBookImageReference(reference);
  if (!normalizedReference) return undefined;

  const normalizedKeys = blobKeys.map((key) => ({ key, normalized: normalizeBookImageReference(key) }));
  const exact = normalizedKeys.find(({ normalized }) => normalized === normalizedReference);
  if (exact) return exact.key;

  const suffixMatches = normalizedKeys.filter(
    ({ normalized }) =>
      normalized.endsWith(`/${normalizedReference}`) ||
      normalizedReference.endsWith(`/${normalized}`)
  );
  if (suffixMatches.length === 1) return suffixMatches[0].key;

  const basename = normalizedReference.split('/').pop();
  if (!basename) return undefined;
  const basenameMatches = normalizedKeys.filter(
    ({ normalized }) => normalized.split('/').pop() === basename
  );
  return basenameMatches.length === 1 ? basenameMatches[0].key : undefined;
}

function normalizeBookImageReference(value: string): string {
  const withoutFragment = value.trim().replaceAll('\\', '/').replace(/[?#].*$/, '');
  let decoded = withoutFragment;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    // Keep the original string when malformed percent escapes are present.
  }

  const parts: string[] = [];
  for (const part of decoded.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/').toLowerCase();
}

/** Keep the original EPUB blob key on rendered images so the listening mode can
 * resolve a cloud-stored illustration without depending on a device-local
 * object URL. */
function addImageResourceKeys(el: HTMLElement, blobs: Record<string, Blob>) {
  const images = [...el.querySelectorAll<HTMLElement>('img, svg image')];
  for (const image of images) {
    const reference =
      image.getAttribute('src') ||
      image.getAttribute('href') ||
      image.getAttribute('xlink:href') ||
      '';
    const key = Object.keys(blobs).find((candidate) => reference.includes(`ttu:${candidate}`));
    if (key) image.setAttribute('data-ttu-book-image-key', key);
  }
}

function addImageContainerClass(el: HTMLElement) {
  Array.from(el.getElementsByTagName('img'))
    .map((imgEl) => ({ parentEl: imgEl.parentElement, isGaiji: isElementGaiji(imgEl) }))
    .forEach(({ parentEl, isGaiji }) => {
      parentEl?.classList.add('ttu-img-container');

      if (!isGaiji) {
        parentEl?.classList.add('ttu-illustration-container');
      }
    });
}

function removeSvgDimensions(el: HTMLElement) {
  Array.from(el.getElementsByTagName('svg')).forEach((tag) => {
    tag.removeAttribute('width');
    tag.removeAttribute('height');
  });
}

function addSpoilerTags(el: HTMLElement, document: Document, blurMode: BlurMode) {
  const getChildNodesAfterTableOfContents = () => {
    let childNodes = [...el.children];
    const afterContentsDivIndex =
      childNodes.findIndex((childNode) => childNode.getElementsByTagName('a').length > 1) + 1;
    if (afterContentsDivIndex > 0 && afterContentsDivIndex < childNodes.length) {
      childNodes = childNodes.slice(afterContentsDivIndex);
    }
    return childNodes;
  };

  const createWrapper = (tag: Element, childNode: Element) => {
    const imgWrapper = document.createElement('span');
    const parentElement = tag.parentElement || childNode;

    imgWrapper.classList.add('ttu-img-parent');
    imgWrapper.toggleAttribute('data-ttu-spoiler-img');

    parentElement.insertBefore(imgWrapper, tag);
    imgWrapper.appendChild(tag);
  };

  (blurMode === BlurMode.AFTER_TOC
    ? getChildNodesAfterTableOfContents()
    : [...el.children]
  ).forEach((childNode) => {
    Array.from(childNode.getElementsByTagName('img'))
      .filter((tag) => !isElementGaiji(tag))
      .forEach((tag) => createWrapper(tag, childNode));

    Array.from(childNode.getElementsByTagName('svg'))
      .filter((tag) => tag.getElementsByTagName('image').length)
      .forEach((tag) => createWrapper(tag, childNode));
  });
}

function removeOldBrTagSolution(el: HTMLElement) {
  el.querySelectorAll('.placeholder-br').forEach((placeholderEl) => {
    placeholderEl.parentElement!.removeChild(placeholderEl);
  });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function combineImagePairs(el: HTMLElement) {
  const imagePairs: [Element, Element][] = [];

  let startingIndex = 1;

  if (el.children.item(0)?.id.startsWith('ttu-')) {
    // Skip first page (index 0) as it's probably cover
    startingIndex = 2;
  }

  for (let i = startingIndex; i < el.children.length; i += 2) {
    const leftChild = el.children.item(i - 1)!;
    const rightChild = el.children.item(i)!;

    if (
      hasNoText(leftChild) &&
      hasNoText(rightChild) &&
      hasSingleImage(leftChild) &&
      hasSingleImage(rightChild)
    ) {
      imagePairs.push([leftChild, rightChild]);
    }
  }

  if (
    imagePairs.some(([leftPair, rightPair]) => {
      const leftImages = leftPair.querySelectorAll('image');
      const rightImages = rightPair.querySelectorAll('image');

      if (leftImages.length !== 1 || rightImages.length !== 1) {
        // Not supported
        return true;
      }

      if (!isImagePortrait(leftImages[0]) || !isImagePortrait(rightImages[0])) {
        return true;
      }

      return false;
    })
  ) {
    return;
  }

  imagePairs.forEach(([leftPair, rightPair]) => {
    el.removeChild(rightPair);

    leftPair.classList.add('grouped-image');

    const images = extractImageChildren(leftPair).concat(extractImageChildren(rightPair));

    clearChildren(leftPair);

    images.forEach((image) => leftPair.appendChild(image));
  });
}

function hasNoText(el: Element) {
  return typeof el.textContent === 'string' ? el.textContent.trim().length === 0 : !el.textContent;
}

function getImageChildren(el: Element) {
  const imageChilds = el.querySelectorAll('svg');
  return imageChilds;
}

function hasSingleImage(el: Element) {
  return getImageChildren(el).length === 1;
}

function extractImageChildren(el: Element) {
  const imageChildren = getImageChildren(el);
  const result: Element[] = [];
  imageChildren.forEach((child) => {
    if (child.parentNode) {
      child.parentNode.removeChild(child);
      result.push(child);
    }
  });
  return result;
}

function clearChildren(el: Element) {
  Array.from(el.children).forEach((child) => {
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
  });
  return el;
}

function isImagePortrait(el: SVGImageElement) {
  return el.height.baseVal.value > el.width.baseVal.value;
}
