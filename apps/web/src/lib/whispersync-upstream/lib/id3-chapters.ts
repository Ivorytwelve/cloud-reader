import type { AudioChapter } from './general';

function toChapterTimeString(seconds: number): string {
	const whole = Math.max(0, Math.floor(seconds));
	const hours = Math.floor(whole / 3600);
	const minutes = Math.floor((whole % 3600) / 60);
	const secs = whole % 60;
	return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function chapterKey(label: string, startSeconds: number): string {
	return `${label}_${startSeconds}`;
}

export function normalizeAudioChapters(chapters: AudioChapter[]): AudioChapter[] {
	const seen = new Set<string>();
	return chapters
		.filter((chapter) => Number.isFinite(chapter.startSeconds) && chapter.startSeconds >= 0)
		.sort((first, second) => first.startSeconds - second.startSeconds)
		.filter((chapter) => {
			const key = `${Math.round(chapter.startSeconds * 1000)}|${chapter.label}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.map((chapter, index) => {
			const label = chapter.label.trim() || `Chapter ${index + 1}`;
			return {
				...chapter,
				label,
				key: chapterKey(label, chapter.startSeconds),
				startText: chapter.startText || toChapterTimeString(chapter.startSeconds),
			};
		});
}

function readSyncSafe32(bytes: Uint8Array, offset: number): number {
	return (
		((bytes[offset] || 0) & 0x7f) * 0x200000 +
		((bytes[offset + 1] || 0) & 0x7f) * 0x4000 +
		((bytes[offset + 2] || 0) & 0x7f) * 0x80 +
		((bytes[offset + 3] || 0) & 0x7f)
	);
}

function readUInt32BE(bytes: Uint8Array, offset: number): number {
	return (
		(bytes[offset] || 0) * 0x1000000 +
		((bytes[offset + 1] || 0) << 16) +
		((bytes[offset + 2] || 0) << 8) +
		(bytes[offset + 3] || 0)
	) >>> 0;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
	let result = '';
	for (let index = start; index < Math.min(bytes.length, start + length); index += 1) {
		result += String.fromCharCode(bytes[index]);
	}
	return result;
}

function findZero(bytes: Uint8Array, start: number): number {
	for (let index = start; index < bytes.length; index += 1) {
		if (bytes[index] === 0) return index;
	}
	return -1;
}

function trimId3Text(value: string): string {
	return value.replace(/^\uFEFF/, '').replace(/\0+$/g, '').trim();
}

function decodeId3Text(payload: Uint8Array): string {
	if (!payload.length) return '';
	const encoding = payload[0];
	let bytes = payload.slice(1);
	try {
		if (encoding === 0) return trimId3Text(new TextDecoder('iso-8859-1').decode(bytes));
		if (encoding === 3) return trimId3Text(new TextDecoder('utf-8').decode(bytes));
		if (encoding === 2) return trimId3Text(new TextDecoder('utf-16be').decode(bytes));
		if (encoding === 1) {
			if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
				bytes = bytes.slice(2);
				return trimId3Text(new TextDecoder('utf-16le').decode(bytes));
			}
			if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
				bytes = bytes.slice(2);
				return trimId3Text(new TextDecoder('utf-16be').decode(bytes));
			}
			return trimId3Text(new TextDecoder('utf-16le').decode(bytes));
		}
	} catch {
		// Fall through to a conservative byte-to-string fallback below.
	}
	return trimId3Text(ascii(bytes, 0, bytes.length));
}

function parseId3Frames(
	bytes: Uint8Array,
	start: number,
	end: number,
	version: number,
	onFrame: (id: string, payload: Uint8Array) => void,
): void {
	let offset = start;
	while (offset + 10 <= end && offset + 10 <= bytes.length) {
		const id = ascii(bytes, offset, 4);
		if (!/^[A-Z0-9]{4}$/.test(id)) break;
		const size = version === 4 ? readSyncSafe32(bytes, offset + 4) : readUInt32BE(bytes, offset + 4);
		if (!size) break;
		const payloadStart = offset + 10;
		const payloadEnd = payloadStart + size;
		if (payloadEnd > end || payloadEnd > bytes.length) break;
		onFrame(id, bytes.slice(payloadStart, payloadEnd));
		offset = payloadEnd;
	}
}

/** Parse ID3v2.3/v2.4 CHAP frames directly. */
export function extractMp3Id3ChaptersFromBytes(bytes: Uint8Array): AudioChapter[] {
	if (bytes.length < 10 || ascii(bytes, 0, 3) !== 'ID3') return [];
	const version = bytes[3];
	if (version !== 3 && version !== 4) return [];
	const tagSize = readSyncSafe32(bytes, 6);
	const tagEnd = Math.min(bytes.length, 10 + tagSize);
	let frameStart = 10;
	const flags = bytes[5] || 0;
	if ((flags & 0x40) !== 0 && frameStart + 4 <= tagEnd) {
		const extendedSize = version === 4 ? readSyncSafe32(bytes, frameStart) : readUInt32BE(bytes, frameStart);
		frameStart += version === 4 ? Math.max(4, extendedSize) : 4 + extendedSize;
	}

	const raw: Array<{ label: string; startSeconds: number }> = [];
	parseId3Frames(bytes, frameStart, tagEnd, version, (id, payload) => {
		if (id !== 'CHAP') return;
		const elementEnd = findZero(payload, 0);
		if (elementEnd < 0 || elementEnd + 17 > payload.length) return;
		const startMilliseconds = readUInt32BE(payload, elementEnd + 1);
		let label = '';
		parseId3Frames(payload, elementEnd + 17, payload.length, version, (nestedId, nestedPayload) => {
			if (!label && nestedId === 'TIT2') label = decodeId3Text(nestedPayload);
		});
		if (!label) label = trimId3Text(ascii(payload, 0, elementEnd));
		raw.push({ label, startSeconds: startMilliseconds / 1000 });
	});

	return normalizeAudioChapters(
		raw.map(({ label, startSeconds }, index) => ({
			key: chapterKey(label || `Chapter ${index + 1}`, startSeconds),
			label: label || `Chapter ${index + 1}`,
			startSeconds,
			startText: toChapterTimeString(startSeconds),
		})),
	);
}

export async function extractMp3Id3Chapters(file: File): Promise<AudioChapter[]> {
	if (!/\.mp3$/i.test(file.name) && file.type !== 'audio/mpeg') return [];
	const header = new Uint8Array(await file.slice(0, 10).arrayBuffer());
	if (header.length < 10 || ascii(header, 0, 3) !== 'ID3') return [];
	const tagSize = readSyncSafe32(header, 6);
	const totalSize = Math.min(file.size, 10 + tagSize, 32 * 1024 * 1024);
	if (totalSize <= 10) return [];
	return extractMp3Id3ChaptersFromBytes(new Uint8Array(await file.slice(0, totalSize).arrayBuffer()));
}

/**
 * Read only the leading ID3 tag from a remote MP3 using HTTP Range. If the
 * server does not honor ranges, do not download an audiobook just for chapters.
 */
export async function getRemoteMp3Id3Chapters(url: string, fileName = ''): Promise<AudioChapter[]> {
	if (!url || (fileName && !/\.mp3$/i.test(fileName))) return [];
	const initialEnd = 256 * 1024 - 1;
	const initial = await fetch(url, { headers: { Range: `bytes=0-${initialEnd}` } });
	if (initial.status !== 206) {
		if (initial.body) await initial.body.cancel().catch(() => undefined);
		return [];
	}
	let bytes = new Uint8Array(await initial.arrayBuffer());
	if (bytes.length < 10 || ascii(bytes, 0, 3) !== 'ID3') return [];
	const tagSize = readSyncSafe32(bytes, 6);
	const requiredSize = 10 + tagSize;
	if (requiredSize > 32 * 1024 * 1024) return [];
	if (bytes.length < requiredSize) {
		const response = await fetch(url, { headers: { Range: `bytes=0-${requiredSize - 1}` } });
		if (response.status !== 206) {
			if (response.body) await response.body.cancel().catch(() => undefined);
			return [];
		}
		bytes = new Uint8Array(await response.arrayBuffer());
	}
	return extractMp3Id3ChaptersFromBytes(bytes.slice(0, requiredSize));
}
