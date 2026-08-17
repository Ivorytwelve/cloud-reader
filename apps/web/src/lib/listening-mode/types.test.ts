/**
 * @license BSD-3-Clause
 * Copyright (c) 2026, ッツ Reader Authors
 * All rights reserved.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
// @ts-expect-error Node's strip-types test runner needs explicit .ts extensions.
import { buildIllustrationTimeline } from '../cloud/illustration-timeline-logic.ts';
// @ts-expect-error Node's strip-types test runner needs explicit .ts extensions.
import { defaultListeningSettings, resolveListeningSettings } from './types.ts';

const subtitle = (id: string, startSeconds: number, endSeconds: number) => ({
  id,
  originalStartSeconds: startSeconds,
  startSeconds,
  startTime: '',
  originalEndSeconds: endSeconds,
  endSeconds,
  endTime: '',
  originalText: id,
  text: id,
  subIndex: 0
});

test('listening settings inherit local defaults field by field', () => {
  const result = resolveListeningSettings(
    {
      openingMode: 'listening',
      progressBar: null,
      showSentence: false,
      keepReaderActive: null,
      skipSeconds: 25
    },
    defaultListeningSettings
  );

  assert.equal(result.openingMode, 'listening');
  assert.equal(result.progressBar, defaultListeningSettings.progressBar);
  assert.equal(result.showSentence, false);
  assert.equal(result.keepReaderActive, defaultListeningSettings.keepReaderActive);
  assert.equal(result.skipSeconds, 25);
  const serialized = JSON.parse(
    JSON.stringify({ listeningSettings: { progressBar: null, showSentence: false } })
  );
  assert.equal(serialized.listeningSettings.progressBar, null);
  assert.equal(serialized.listeningSettings.showSentence, false);
});

test('illustration anchors trigger at the preceding text boundary or use a one-sided fallback', () => {
  const result = buildIllustrationTimeline(
    [
      { href: 'a.jpg', resourceKey: 'a.jpg', beforeSubtitleId: 'one', afterSubtitleId: 'two' },
      { href: 'b.jpg', resourceKey: 'b.jpg', afterSubtitleId: 'two' },
      { href: 'ignored.jpg', beforeSubtitleId: 'missing' }
    ],
    [subtitle('one', 0, 10), subtitle('two', 20, 30)]
  );

  assert.equal(result.length, 2);
  assert.equal(result[0].triggerSeconds, 10);
  assert.equal(result[0].confidence, 'high');
  assert.equal(result[1].triggerSeconds, 20);
  assert.equal(result[1].confidence, 'medium');
});

test('listening mode does not introduce a second audio engine', async () => {
  const playerPath = new URL('../whispersync-upstream/components/Player.svelte', import.meta.url);
  const listeningPath = new URL(
    '../components/listening-mode/listening-mode.svelte',
    import.meta.url
  );
  const [player, listening] = await Promise.all([
    readFile(playerPath, 'utf8'),
    readFile(listeningPath, 'utf8')
  ]);
  assert.equal((player.match(/<audio\b/g) || []).length, 1);
  assert.equal((listening.match(/<audio\b/g) || []).length, 0);
});
