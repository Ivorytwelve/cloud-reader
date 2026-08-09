import type { DiffDetail, Subtitle } from '$lib/whispersync-upstream/lib/general';
import {
  allIgnoredElements,
  getBaseLineCSSSelectorForId,
  getSubtitleIdFromElement,
  parseHTML
} from '$lib/whispersync-upstream/lib/util';

const singleIgnoredElements = new Set(['rt']);
const normalizeRegex = /[\p{punct}\s]/u;

export interface AutomaticAlignmentOptions {
  similarityThreshold?: number;
  maxAttempts?: number;
  ignoreRp?: boolean;
  onProgress?: (matchedOrProcessed: number, total: number) => void;
}

export interface AutomaticAlignmentResult {
  elementHtml: string;
  matchedBy: string;
  matchedOn: number;
  matchedLines: number;
  totalLines: number;
  diffLines: number;
  rate: number;
  unmatchedSubtitles: Subtitle[];
  adjustedSubtitles: Subtitle[];
  subtitleDiffDetails: DiffDetail[];
}

/**
 * Browser-side extraction of the same alignment markers used by ttu-whispersync.
 * This is intentionally based on Renji-XD/ttu-whispersync's Match.svelte algorithm,
 * but is detached from the UI/stores so it can run once while a cloud book is added.
 */
export async function matchSubtitlesToBookHtml(
  document: Document,
  elementHtml: string,
  subtitles: Subtitle[],
  subtitleFileName: string,
  options: AutomaticAlignmentOptions = {}
): Promise<AutomaticAlignmentResult> {
  const similarityThreshold = options.similarityThreshold ?? 0.9;
  const maxMatchAttempts = Math.min(1000, Math.max(1, Math.floor(options.maxAttempts ?? 200)));
  const ignoredTags = options.ignoreRp ? allIgnoredElements : singleIgnoredElements;
  const ignoredTagsSelector = [...ignoredTags].join(',');
  const allIgnoredSelector = [...allIgnoredElements].join(',');
  const bookHTML = parseHTML(new DOMParser(), elementHtml);
  const totalLines = subtitles.length;
  const matchedOn = Date.now();

  if (!subtitles.length) {
    return {
      elementHtml,
      matchedBy: subtitleFileName,
      matchedOn,
      matchedLines: 0,
      totalLines: 0,
      diffLines: 0,
      rate: 0,
      unmatchedSubtitles: [],
      adjustedSubtitles: [],
      subtitleDiffDetails: []
    };
  }

  const textNodes: Node[] = [];
  const originalElementsMap = new Map<HTMLElement, string>();
  const matchedElementsMap = new Map<HTMLElement, string>();
  const unmatchedSubtitles: Subtitle[] = [];
  const adjustedSubtitles: Subtitle[] = [];
  const subtitleDiffDetails: DiffDetail[] = [];

  const walker = document.createTreeWalker(bookHTML, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const textContent = normalizeString(node.textContent);
      addNodeContentToMap(originalElementsMap, node, textContent);
      if (textContent) textNodes.push(node);
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  while (walker.nextNode()) {}

  const initialAnchor = findInitialAnchor(textNodes, subtitles, ignoredTagsSelector, similarityThreshold);

  let currentNodes: Node[] = [];
  let currentText = '';
  let textInScope = '';
  let currentSubtitleIndex = initialAnchor?.subtitleIndex ?? 0;

  // Some audiobooks contain a spoken title/publisher notice which is not present in
  // the EPUB. If the anchor starts a few subtitle lines later, keep those lines as
  // explicitly unmatched instead of forcing the book matcher to start in the wrong
  // place. This also makes the reported match percentage honest.
  for (let index = 0; index < currentSubtitleIndex; index += 1) {
    unmatchedSubtitles.push(subtitles[index]);
    updateAdjustedSubtitle(subtitles[index], '', adjustedSubtitles, subtitleDiffDetails);
  }

  let { currentSubtitle, currentSubtitleLength } = getSubtitleData(subtitles, currentSubtitleIndex);
  let matchedSubtitles = 0;
  let matchAttempt = 1;
  let currentTextNodeIndex = initialAnchor?.textNodeIndex ?? 0;
  let textNodeIndexAfterLastMatch = currentTextNodeIndex;
  let textNodeCount = textNodes.length;
  let lastYield = currentSubtitleIndex;

  while (currentTextNodeIndex < textNodeCount && currentSubtitleIndex < subtitles.length) {
    if (currentSubtitleIndex - lastYield >= 10) {
      lastYield = currentSubtitleIndex;
      options.onProgress?.(currentSubtitleIndex, totalLines);
      // Keep the upload UI responsive on large novels.
      await new Promise((resolve) => setTimeout(resolve));
    }

    let node = textNodes[currentTextNodeIndex];
    let nodeParent = node.parentElement!;

    if (!nodeParent.closest(ignoredTagsSelector)) currentText += node.textContent;

    const currentNormalizedTextLength = getNormalizedLength(currentText);
    if (currentNormalizedTextLength >= currentSubtitleLength) {
      const textForComparison = getTextForComparison(currentText, currentSubtitleLength);
      const textForComparisonLength = [...textForComparison].length;
      let bestStart = 0;
      let bestEnd = textForComparisonLength;
      let bestValue = getSimilarity(textForComparison, currentSubtitle);

      currentNodes.push(node);
      const similarityResult = findBestSimilarity(
        currentSubtitle,
        currentSubtitleLength,
        textForComparison,
        textForComparisonLength,
        bestStart,
        bestValue,
        currentNodes,
        textNodes,
        currentTextNodeIndex,
        similarityThreshold,
        ignoredTagsSelector
      );
      const isThresholdMet = similarityResult.bestValue >= similarityThreshold;

      if (isThresholdMet) {
        bestStart = similarityResult.bestStart;
        bestEnd = similarityResult.bestEnd;
        currentNodes = similarityResult.currentNodes;
        currentTextNodeIndex = similarityResult.currentTextNodeIndex;
      }

      node = textNodes[currentTextNodeIndex];
      nodeParent = node.parentElement!;
      currentTextNodeIndex += 1;

      while (nodeParent.closest(ignoredTagsSelector) && currentTextNodeIndex < textNodeCount) {
        node = textNodes[currentTextNodeIndex];
        nodeParent = node.parentElement!;
        if (nodeParent.closest(ignoredTagsSelector)) currentNodes.push(node);
        currentTextNodeIndex += 1;
      }
      currentTextNodeIndex -= 1;

      if (isThresholdMet) {
        let charactersToProcess = bestEnd - bestStart;
        let charactersProcessed = 0;
        let hadRemainingCharacters = false;

        if (bestStart !== 0) {
          const nodeToProcess = currentNodes[0];
          const value = nodeToProcess.textContent || '';
          const ignoredTextNode = document.createTextNode([...value].slice(0, bestStart).join(''));
          const remainingTextNode = document.createTextNode([...value].slice(bestStart).join(''));
          nodeToProcess.parentElement!.replaceChild(ignoredTextNode, nodeToProcess);
          ignoredTextNode.after(remainingTextNode);
          currentNodes[0] = remainingTextNode;
        }

        for (let index = 0, { length } = currentNodes; index < length; index += 1) {
          const nodeToProcess = currentNodes[index];
          const parent = nodeToProcess.parentElement!;
          const value = nodeToProcess.textContent || '';
          const valueLength = [...value].length;
          const isIgnoredParent = !!parent.closest(ignoredTagsSelector);
          const matchedContainer = document.createElement('span');
          const matchedText = isIgnoredParent
            ? [...value].join('')
            : [...value].slice(0, charactersToProcess).join('');
          const matchedTextNode = document.createTextNode(matchedText);
          const matchedTextLength = [...matchedText].length;
          const remainingCharacters = valueLength - matchedTextLength;

          if (charactersToProcess) {
            const subtitle = subtitles[currentSubtitleIndex];
            matchedContainer.classList.add(getBaseLineCSSSelectorForId(subtitle.id));
            matchedContainer.appendChild(matchedTextNode);
            parent.replaceChild(matchedContainer, nodeToProcess);
            if (!parent.closest(allIgnoredSelector)) textInScope += matchedText;
          }

          charactersProcessed += isIgnoredParent ? 0 : matchedTextLength;
          charactersToProcess = bestEnd - bestStart - charactersProcessed;

          if (!charactersToProcess && remainingCharacters) {
            const leftOverTextNodes: Text[] = [];
            index += matchedTextLength ? 0 : 1;
            let leftOverLength = matchedTextLength;

            while (index < length) {
              const leftOverNode = currentNodes[index];
              const leftOverContent = leftOverNode.textContent || '';
              const remainingTextNode = document.createTextNode([...leftOverContent].slice(leftOverLength).join(''));
              if (!leftOverContent) throw new Error('Alignment encountered an empty leftover text node');
              if (!leftOverNode.parentElement) {
                matchedContainer.after(remainingTextNode);
                leftOverTextNodes.push(remainingTextNode);
              }
              index += 1;
              leftOverLength = 0;
            }

            if (leftOverTextNodes.length) {
              textNodes.splice(currentTextNodeIndex, leftOverTextNodes.length, ...leftOverTextNodes);
            }
            hadRemainingCharacters = true;
          }
        }

        updateAdjustedSubtitle(subtitles[currentSubtitleIndex], textInScope, adjustedSubtitles, subtitleDiffDetails);
        currentText = '';
        textInScope = '';
        if (!hadRemainingCharacters) currentTextNodeIndex += 1;
        textNodeIndexAfterLastMatch = currentTextNodeIndex;
        currentSubtitleIndex += 1;
        matchedSubtitles += 1;
        matchAttempt = 1;
        if (currentSubtitleIndex < subtitles.length) {
          ({ currentSubtitle, currentSubtitleLength } = getSubtitleData(subtitles, currentSubtitleIndex));
        }
      } else {
        currentTextNodeIndex = textNodeIndexAfterLastMatch + matchAttempt;
        matchAttempt += 1;
        currentText = '';
        textInScope = '';
        const isEndReached = currentTextNodeIndex > textNodes.length;
        const maxAttemptsReached = matchAttempt > maxMatchAttempts;

        if (maxAttemptsReached || isEndReached) {
          unmatchedSubtitles.push(subtitles[currentSubtitleIndex]);
          updateAdjustedSubtitle(subtitles[currentSubtitleIndex], textInScope, adjustedSubtitles, subtitleDiffDetails);
          matchAttempt = 1;
          currentSubtitleIndex += 1;
          if (currentSubtitleIndex < subtitles.length) {
            currentTextNodeIndex = textNodeIndexAfterLastMatch;
            ({ currentSubtitle, currentSubtitleLength } = getSubtitleData(subtitles, currentSubtitleIndex));
          } else {
            currentTextNodeIndex = textNodeCount;
          }
        }
      }

      currentNodes = [];
    } else {
      currentNodes.push(node);
      currentTextNodeIndex += 1;
    }
    textNodeCount = textNodes.length;
  }

  // Ensure the alignment operation never changed the actual book text.
  const matchedWalker = document.createTreeWalker(bookHTML, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      addNodeContentToMap(matchedElementsMap, node, normalizeString(node.textContent));
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  while (matchedWalker.nextNode()) {}

  const originals = [...originalElementsMap.entries()];
  const matched = [...matchedElementsMap.entries()];
  for (let index = 0; index < originals.length; index += 1) {
    const [originalElement, originalContent] = originals[index];
    const [matchedElement, matchedContent] = matched[index] || [];
    if (originalElement !== matchedElement || originalContent !== matchedContent) {
      throw new Error(`Automatic Whispersync alignment changed book text near element ${index}`);
    }
  }

  const lastSubtitle = subtitles[subtitles.length - 1];
  if (currentText && lastSubtitle && !unmatchedSubtitles.includes(lastSubtitle)) unmatchedSubtitles.push(lastSubtitle);
  if (lastSubtitle && adjustedSubtitles.length && adjustedSubtitles[adjustedSubtitles.length - 1].id !== lastSubtitle.id) {
    updateAdjustedSubtitle(lastSubtitle, textInScope, adjustedSubtitles, subtitleDiffDetails);
  }

  if (bookHTML.firstElementChild instanceof HTMLElement) {
    bookHTML.firstElementChild.dataset.ttuWhispersyncMatchedBy = subtitleFileName;
    bookHTML.firstElementChild.dataset.ttuWhispersyncMatchedOn = `${matchedOn}`;
    bookHTML.firstElementChild.dataset.ttuWhispersyncMatchedSource = 'cloud-auto';
    bookHTML.firstElementChild.dataset.ttuWhispersyncMatchedLines = `${matchedSubtitles}`;
    bookHTML.firstElementChild.dataset.ttuWhispersyncTotalLines = `${totalLines}`;
    bookHTML.firstElementChild.dataset.ttuWhispersyncDiffLines = `${subtitleDiffDetails.length}`;
  }

  options.onProgress?.(totalLines, totalLines);
  return {
    elementHtml: bookHTML.innerHTML,
    matchedBy: subtitleFileName,
    matchedOn,
    matchedLines: matchedSubtitles,
    totalLines,
    diffLines: subtitleDiffDetails.length,
    rate: totalLines ? matchedSubtitles / totalLines : 0,
    unmatchedSubtitles,
    adjustedSubtitles,
    subtitleDiffDetails
  };
}


interface InitialAnchor {
  subtitleIndex: number;
  textNodeIndex: number;
  score: number;
}

/**
 * Find a trustworthy starting point before mutating the EPUB.
 *
 * Light novels commonly repeat chapter titles in a navigation/TOC section. The
 * original sequential matcher could accept those first one or two lines and then
 * get stranded before the real chapter. Here we score a *block* of consecutive
 * subtitle text, which strongly favours the actual prose over an isolated TOC hit.
 *
 * We also try the first few subtitle indices. This handles spoken publisher/title
 * notices that exist in the audiobook but not in the EPUB.
 */
function findInitialAnchor(
  textNodes: Node[],
  subtitles: Subtitle[],
  ignoredTagsSelector: string,
  similarityThreshold: number
): InitialAnchor | undefined {
  if (!textNodes.length || !subtitles.length) return undefined;

  const flattenedCharacters: string[] = [];
  const characterToTextNodeIndex: number[] = [];

  for (let textNodeIndex = 0; textNodeIndex < textNodes.length; textNodeIndex += 1) {
    const node = textNodes[textNodeIndex];
    if (node.parentElement?.closest(ignoredTagsSelector)) continue;

    for (const character of [...normalizeAnchorString(node.textContent)]) {
      flattenedCharacters.push(character);
      characterToTextNodeIndex.push(textNodeIndex);
    }
  }

  const bookText = flattenedCharacters.join('');
  if (!bookText) return undefined;

  const maxSubtitleStarts = Math.min(12, subtitles.length);
  const candidates: InitialAnchor[] = [];

  for (let subtitleIndex = 0; subtitleIndex < maxSubtitleStarts; subtitleIndex += 1) {
    const query = buildAnchorQuery(subtitles, subtitleIndex);
    if (query.length < 8) continue;

    // A short exact prefix keeps candidate discovery cheap, while the much longer
    // query below determines which occurrence is actually correct.
    const seedLength = Math.min(24, Math.max(8, Math.floor(query.length / 4)));
    const seed = query.slice(0, seedLength);
    let searchFrom = 0;
    let occurrences = 0;

    while (searchFrom < bookText.length && occurrences < 200) {
      const candidateStart = bookText.indexOf(seed, searchFrom);
      if (candidateStart < 0) break;
      occurrences += 1;

      const candidateText = bookText.slice(candidateStart, candidateStart + query.length);
      const score = getSimilarity(query, candidateText);
      const textNodeIndex = characterToTextNodeIndex[candidateStart];

      if (textNodeIndex !== undefined) {
        candidates.push({ subtitleIndex, textNodeIndex, score });
      }

      searchFrom = candidateStart + 1;
    }
  }

  if (!candidates.length) return undefined;

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.subtitleIndex !== b.subtitleIndex) return a.subtitleIndex - b.subtitleIndex;
    return a.textNodeIndex - b.textNodeIndex;
  });

  const best = candidates[0];
  const runnerUp = candidates.find(
    (candidate) =>
      candidate.subtitleIndex !== best.subtitleIndex || candidate.textNodeIndex !== best.textNodeIndex
  );
  const scoreMargin = best.score - (runnerUp?.score ?? 0);

  // A near-exact multi-line block is safe even when duplicated elsewhere. For
  // fuzzier material, require a useful lead over the next-best occurrence.
  const minimumScore = Math.max(0.82, similarityThreshold - 0.08);
  const isConfident = best.score >= 0.96 || (best.score >= minimumScore && scoreMargin >= 0.06);

  return isConfident ? best : undefined;
}

function buildAnchorQuery(subtitles: Subtitle[], startIndex: number) {
  let query = '';
  let linesUsed = 0;

  for (let index = startIndex; index < subtitles.length && linesUsed < 8; index += 1) {
    const normalized = normalizeAnchorString(subtitles[index].text);
    if (!normalized) continue;
    query += normalized;
    linesUsed += 1;
    if (query.length >= 140 && linesUsed >= 4) break;
  }

  return query;
}

function normalizeAnchorString(value: string | null) {
  return (value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]/gu, '');
}

function getSubtitleData(subtitles: Subtitle[], index: number) {
  const currentSubtitle = subtitles[index].text;
  return { currentSubtitle, currentSubtitleLength: [...currentSubtitle].length };
}

function getNormalizedLength(value: string) {
  return [...normalizeString(value)].length;
}

function normalizeString(value: string | null, toLowerCase = false) {
  const cleanValue = (value || '').replace(/\s/g, '').trim();
  return toLowerCase ? cleanValue.toLowerCase() : cleanValue;
}

function addNodeContentToMap(map: Map<HTMLElement, string>, node: Node, textContent: string) {
  const parent =
    node.parentElement instanceof HTMLSpanElement && getSubtitleIdFromElement(node.parentElement) !== 'not existing'
      ? node.parentElement.parentElement!
      : node.parentElement!;
  map.set(parent, `${map.get(parent) || ''}${textContent}`);
}

function getTextForComparison(currentText: string, targetLength: number) {
  const characters = [...currentText];
  if (characters.length === targetLength) return currentText;
  let textForComparison = '';
  let textForComparisonLength = 0;
  for (const character of characters) {
    textForComparison += character;
    const trimmedCharacter = character.trim();
    if (trimmedCharacter && !normalizeRegex.test(trimmedCharacter)) textForComparisonLength += 1;
    if (textForComparisonLength === targetLength) break;
  }
  return textForComparison;
}

function getSimilarity(str1: string, str2: string) {
  const string1 = normalizeString(str1, true);
  const string2 = normalizeString(str2, true);
  const string1Length = [...string1].length;
  const string2Length = [...string2].length;
  const substringLength = string1Length < 5 ? 1 : 2;
  if (string1 === string2) return 1;
  if (string1Length < substringLength || string2Length < substringLength) return 0;
  const map = new Map<string, number>();
  for (let i = 0; i < string1Length - (substringLength - 1); i += 1) {
    const substring = [...string1].slice(i, i + substringLength).join('');
    map.set(substring, (map.get(substring) || 0) + 1);
  }
  let match = 0;
  for (let j = 0; j < string2Length - (substringLength - 1); j += 1) {
    const substring = [...string2].slice(j, j + substringLength).join('');
    const count = map.get(substring) || 0;
    if (count > 0) {
      map.set(substring, count - 1);
      match += 1;
    }
  }
  return (match * 2) / (string1Length + string2Length - (substringLength - 1) * 2);
}

function findBestSimilarity(
  currentSubtitle: string,
  currentSubtitleLength: number,
  textForComparison: string,
  textForComparisonLength: number,
  currentBestStart: number,
  currentBestValue: number,
  currentNodes: Node[],
  textNodes: Node[],
  currentTextNodeIndex: number,
  threshold: number,
  ignoredTagsSelector: string
): { bestStart: number; bestEnd: number; bestValue: number; currentNodes: Node[]; currentTextNodeIndex: number } {
  let bestStart = currentBestStart;
  let bestEnd = textForComparisonLength;
  let bestValue = currentBestValue;

  if (bestValue !== 1) {
    for (let index = bestEnd; index > currentBestStart; index -= 1) {
      if (normalizeString(currentSubtitle) === normalizeString([...textForComparison].slice(currentBestStart, index).join(''))) {
        bestStart = currentBestStart;
        bestEnd = index;
        bestValue = 1;
        break;
      }
    }
  }

  if (bestValue !== 1) {
    for (let index = currentBestStart; index < bestEnd; index += 1) {
      const candidate = getSimilarity(currentSubtitle, [...textForComparison].slice(index, bestEnd).join(''));
      if (candidate > bestValue) {
        bestStart = index;
        bestEnd = textForComparisonLength;
        bestValue = candidate;
      }
    }
  }

  if (currentBestStart === bestStart || bestValue === 1 || bestValue < threshold) {
    if (bestValue !== 1) {
      bestValue = -1;
      for (let index = bestEnd; index > currentBestStart; index -= 1) {
        const candidate = getSimilarity(currentSubtitle, [...textForComparison].slice(currentBestStart, index).join(''));
        if (candidate > bestValue) {
          bestStart = currentBestStart;
          bestEnd = index;
          bestValue = candidate;
        }
      }
    }

    if (bestValue < threshold || bestValue === 1) {
      return { bestStart, bestEnd, bestValue, currentNodes, currentTextNodeIndex };
    }

    const finalNodes: Node[] = [];
    const originalLength = currentNodes.length;
    const targetCharacterLength = bestEnd - bestStart;
    let characterCount = 0;
    while (characterCount < targetCharacterLength && currentNodes.length) {
      const node = currentNodes.shift()!;
      characterCount += node.parentElement!.closest(ignoredTagsSelector) ? 0 : [...(node.textContent || '')].length;
      finalNodes.push(node);
    }
    return {
      bestStart,
      bestEnd,
      bestValue,
      currentNodes: finalNodes,
      currentTextNodeIndex: currentTextNodeIndex - (originalLength - finalNodes.length)
    };
  }

  let sliceIndex = 0;
  let charactersSeen = 0;
  let startOffset = bestStart;
  for (let index = 0; index < currentNodes.length; index += 1) {
    const node = currentNodes[index];
    const length = node.parentElement!.closest(ignoredTagsSelector) ? 0 : [...(node.textContent || '')].length;
    const offsetDiff = startOffset - length;
    charactersSeen += length;
    startOffset = offsetDiff < 0 ? startOffset : offsetDiff;
    if (charactersSeen >= bestStart) {
      sliceIndex = index + (charactersSeen === bestStart ? 1 : 0);
      break;
    }
  }

  const newNodes: Node[] = [];
  let currentText = '';
  let currentNormalizedTextLength = 0;
  let newTextNodeIndex = currentTextNodeIndex - (currentNodes.length - (sliceIndex + 1));
  while (currentNormalizedTextLength <= currentSubtitleLength && newTextNodeIndex < textNodes.length) {
    const node = textNodes[newTextNodeIndex];
    if (!node.parentElement!.closest(ignoredTagsSelector)) currentText += node.textContent;
    newNodes.push(node);
    newTextNodeIndex += 1;
    currentNormalizedTextLength = getNormalizedLength(currentText);
  }
  newTextNodeIndex -= 1;
  currentText = getTextForComparison(currentText, currentSubtitleLength);
  return findBestSimilarity(
    currentSubtitle,
    currentSubtitleLength,
    currentText,
    [...currentText].length,
    startOffset,
    bestValue,
    newNodes,
    textNodes,
    newTextNodeIndex,
    threshold,
    ignoredTagsSelector
  );
}

function updateAdjustedSubtitle(
  currentSubtitle: Subtitle,
  textInScope: string,
  adjustedSubtitles: Subtitle[],
  subtitleDiffDetails: DiffDetail[]
) {
  const trimmedSubtitle = normalizeString(currentSubtitle.text, true);
  const trimmedTextInScope = normalizeString(textInScope, true);
  adjustedSubtitles.push({ ...currentSubtitle });
  if (textInScope && trimmedSubtitle !== trimmedTextInScope) {
    adjustedSubtitles[adjustedSubtitles.length - 1].text = textInScope;
    subtitleDiffDetails.push({ id: currentSubtitle.id, original: currentSubtitle.text, adjusted: textInScope });
  }
}
