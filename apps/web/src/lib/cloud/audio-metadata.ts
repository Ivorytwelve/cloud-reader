import { getAudioMetadata, setMediaInfoInstance } from '$lib/whispersync-upstream/lib/mediaInfo';
import type { AudioChapter } from './types';

const coverMimeTypes: Array<[string, string]> = [
  ['/9j/', 'image/jpeg'],
  ['iVBORw0KGgo', 'image/png'],
  ['UklGR', 'image/webp'],
  ['R0lGODdh', 'image/gif'],
  ['R0lGODlh', 'image/gif']
];

export async function extractCloudAudioMetadata(file: File): Promise<{
  chapters: AudioChapter[];
  duration?: number;
  cover?: Blob;
}> {
  // Cover data is extracted only once, during cloud ingestion. The cloud player
  // later streams the audio file and never needs to scan the full remote object.
  await setMediaInfoInstance(true, true, undefined);
  const metadata = await getAudioMetadata(file, true);
  const chapters: AudioChapter[] = [];
  let cover: Blob | undefined;

  for (const track of metadata.media?.track || []) {
    const extraKeys = Object.keys(track.extra || {});
    if (track['@type'] === 'General' && !cover) {
      cover = coverBlob(String(track.Cover_Data || ''));
    }

    if (track['@type'] !== 'Menu' || !extraKeys.length) continue;
    for (const extraKey of extraKeys) {
      const match = extraKey.match(/_(\d{2})_(\d{2})_(\d{2})_(\d{3})/);
      if (!match) continue;
      const [, hours, minutes, seconds, milliseconds] = match;
      const startSeconds =
        Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(milliseconds) / 1000;
      const label = String(track.extra?.[extraKey] || `Chapter ${chapters.length + 1}`);
      chapters.push({
        key: `${label}_${startSeconds}`,
        label,
        startSeconds,
        startText: formatTimestamp(startSeconds)
      });
    }
  }

  const duration = await getBrowserAudioDuration(file).catch(() => undefined);
  return { chapters, duration, cover };
}

function coverBlob(base64: string): Blob | undefined {
  if (!base64) return undefined;
  const mime = coverMimeTypes.find(([prefix]) => base64.startsWith(prefix))?.[1];
  if (!mime) return undefined;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mime });
}

function getBrowserAudioDuration(file: File): Promise<number | undefined> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement('audio');
    const finish = (value?: number) => {
      URL.revokeObjectURL(url);
      audio.removeAttribute('src');
      resolve(value && Number.isFinite(value) ? value : undefined);
    };
    const timer = window.setTimeout(() => finish(), 5000);
    audio.preload = 'metadata';
    audio.addEventListener('loadedmetadata', () => {
      window.clearTimeout(timer);
      finish(audio.duration);
    }, { once: true });
    audio.addEventListener('error', () => {
      window.clearTimeout(timer);
      finish();
    }, { once: true });
    audio.src = url;
  });
}

function formatTimestamp(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  return [h, m, s].map((part) => String(part).padStart(2, '0')).join(':');
}
