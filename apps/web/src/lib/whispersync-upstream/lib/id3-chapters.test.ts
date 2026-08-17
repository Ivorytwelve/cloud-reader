import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Node's strip-types test runner needs explicit .ts extensions.
import { extractMp3Id3ChaptersFromBytes } from './id3-chapters.ts';

const ascii = (value: string) => Uint8Array.from([...value].map((character) => character.charCodeAt(0)));
const be32 = (value: number) =>
  Uint8Array.from([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
const syncSafe32 = (value: number) =>
  Uint8Array.from([(value >>> 21) & 127, (value >>> 14) & 127, (value >>> 7) & 127, value & 127]);
const concat = (...parts: Uint8Array[]) => {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};
const frame = (id: string, payload: Uint8Array, version = 3) =>
  concat(ascii(id), version === 4 ? syncSafe32(payload.length) : be32(payload.length), Uint8Array.of(0, 0), payload);
const titleFrame = (title: string, version = 3) =>
  frame('TIT2', concat(Uint8Array.of(3), new TextEncoder().encode(title)), version);
const chapterFrame = (id: string, startMilliseconds: number, title: string, version = 3) =>
  frame(
    'CHAP',
    concat(
      ascii(id),
      Uint8Array.of(0),
      be32(startMilliseconds),
      be32(startMilliseconds + 1000),
      be32(0xffffffff),
      be32(0xffffffff),
      titleFrame(title, version)
    ),
    version
  );

test('parses MP3 ID3v2.3 CHAP/TIT2 chapter metadata', () => {
  const body = concat(
    chapterFrame('ch1', 0, 'プロローグ'),
    chapterFrame('ch2', 123456, '第二章')
  );
  const tag = concat(ascii('ID3'), Uint8Array.of(3, 0, 0), syncSafe32(body.length), body);
  const chapters = extractMp3Id3ChaptersFromBytes(tag);

  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].label, 'プロローグ');
  assert.equal(chapters[0].startSeconds, 0);
  assert.equal(chapters[1].label, '第二章');
  assert.equal(chapters[1].startSeconds, 123.456);
});


test('parses MP3 ID3v2.4 CHAP/TIT2 chapter metadata', () => {
  const body = concat(
    chapterFrame('ch1', 0, '序章', 4),
    chapterFrame('ch2', 654321, '第三章', 4)
  );
  const tag = concat(ascii('ID3'), Uint8Array.of(4, 0, 0), syncSafe32(body.length), body);
  const chapters = extractMp3Id3ChaptersFromBytes(tag);

  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].label, '序章');
  assert.equal(chapters[1].label, '第三章');
  assert.equal(chapters[1].startSeconds, 654.321);
});
