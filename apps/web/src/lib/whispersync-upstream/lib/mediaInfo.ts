import { type MediaInfo, type MediaInfoType, type ReadChunkFunc } from 'mediainfo.js';
import type { AudioChapter } from './general';
import MediaInfoFactory from 'mediainfo.js';
import mediaInfoWasmUrl from '../assets/js/MediaInfoModule_0.2.1.wasm?url';
import {
	extractMp3Id3Chapters,
	normalizeAudioChapters,
} from './id3-chapters';
export { extractMp3Id3Chapters, extractMp3Id3ChaptersFromBytes, getRemoteMp3Id3Chapters } from './id3-chapters';

const imageMagicNumbers: Map<string, string> = new Map([
	['/9j/', 'image/jpg'],
	['iVBORw0KGgo', 'image/png'],
	['UklGR', 'image/webp'],
	['R0lGODdh', 'image/gif'],
	['R0lGODlh', 'image/gif'],
]);

let mediaInfoInstance: MediaInfo;

function getImageMimeType(base64: string | undefined) {
	if (!base64) {
		return undefined;
	}

	const magicNumberKeys = [...imageMagicNumbers.keys()];
	const imageMagicNumber = magicNumberKeys.find((magicNumberKey) => base64.startsWith(magicNumberKey)) || '';

	return imageMagicNumbers.get(imageMagicNumber);
}

export function setMediaInfoInstance(
	coverData: boolean,
	resetInstance: boolean,
	mediaInfoUrl: string | undefined,
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (mediaInfoInstance && !resetInstance) {
			return resolve();
		}

		MediaInfoFactory(
			{
				coverData,
				format: 'object',
				locateFile: () => mediaInfoUrl || mediaInfoWasmUrl,
			},
			(mediainfo: MediaInfo) => {
				if (mediaInfoInstance) {
					try {
						mediaInfoInstance.close();
					} catch (_) {
						// no-op
					}
				}

				mediaInfoInstance = mediainfo;

				resolve();
			},
			({ message }: any) => reject(new Error(`Failed to create MediaInfo instance - ${message}`)),
		);
	});
}

export async function getAudioMetadata(file: File, coverData: boolean, mediaInfoUrl = ''): Promise<MediaInfoType> {
	await setMediaInfoInstance(coverData, false, mediaInfoUrl);

	return new Promise<MediaInfoType>((resolve, reject) => {
		const getSize = () => file.size;
		const readChunk: ReadChunkFunc = (chunkSize, offset) =>
			new Promise((resolve, reject) => {
				const fileReader = new FileReader();

				fileReader.addEventListener('loadend', (event) => {
					if (!event.target) {
						return reject(new Error('No FileReader data'));
					} else if (event.target.error) {
						return reject(new Error(`Error reading file - ${event.target.error.message}`));
					}

					resolve(new Uint8Array(event.target.result as ArrayBuffer));
				});

				fileReader.addEventListener('error', () => {
					reject(new Error('Error reading file'));
				});

				fileReader.readAsArrayBuffer(file.slice(offset, offset + chunkSize));
			});

		mediaInfoInstance
			.analyzeData(getSize, readChunk)
			.then((metadata) => resolve(metadata))
			.catch(({ message }: any) => reject(new Error(`Failed to get audio metadata - ${message}`)));
	});
}

export function getMediaInfoCover(coverData: string | undefined) {
	if (!coverData) {
		return '';
	}

	const coverMimeType = getImageMimeType(coverData);

	if (!coverMimeType) {
		return '';
	}

	const binary = atob(coverData);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}

	return URL.createObjectURL(new Blob([bytes], { type: coverMimeType }));
}

/** Extract chapter entries from MediaInfo Menu tracks. */
export function extractAudioChaptersFromMediaInfo(metadata: MediaInfoType | undefined): AudioChapter[] {
	const chapters: AudioChapter[] = [];
	for (const track of metadata?.media?.track || []) {
		if (track['@type'] !== 'Menu') continue;
		for (const extraKey of Object.keys(track.extra || {})) {
			const match = extraKey.match(/_(\d{2})_(\d{2})_(\d{2})_(\d{3})(?:_|$)/);
			if (!match) continue;
			const [, hours, minutes, seconds, milliseconds] = match;
			const startSeconds =
				Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + Number(milliseconds) / 1000;
			const label = String(track.extra?.[extraKey] || '').trim() || `Chapter ${chapters.length + 1}`;
			chapters.push({
				key: `${label}_${startSeconds}`,
				label,
				startSeconds,
				startText: '',
			});
		}
	}
	return normalizeAudioChapters(chapters);
}

/**
 * Extract embedded audiobook artwork independently from the legacy player
 * "show cover" preference. Listening Mode needs artwork even when that older
 * UI option is disabled, so reuse the same MediaInfo parser but explicitly
 * request cover data for this one metadata read.
 */
export async function getEmbeddedAudioCoverUrl(file: File): Promise<string> {
	try {
		// An existing MediaInfo instance may have been created with coverData=false.
		// Recreate it once with cover support so Cover_Data is actually populated.
		await setMediaInfoInstance(true, true, undefined);
		const metadata = await getAudioMetadata(file, true);
		const generalTrack = metadata?.media?.track?.find((entry) => entry['@type'] === 'General');
		return getMediaInfoCover(generalTrack?.Cover_Data);
	} catch {
		return '';
	}
}


/**
 * Listening Mode chapter extraction is deliberately independent of the legacy
 * "Enable chapters" player preference. MP3 CHAP frames are tried first, then
 * MediaInfo's generic Menu-track representation is used as a fallback.
 */
export async function getEmbeddedAudioChapters(file: File): Promise<AudioChapter[]> {
	const id3 = await extractMp3Id3Chapters(file).catch(() => []);
	if (id3.length) return id3;
	try {
		const metadata = await getAudioMetadata(file, false);
		return extractAudioChaptersFromMediaInfo(metadata);
	} catch {
		return [];
	}
}
