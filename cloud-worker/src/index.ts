import type {
  AssetKind,
  AudioChapter,
  CloudBook,
  CloudProgress,
  CloudStatisticAggregate,
  CloudStatisticSnapshot,
  LibraryManifest,
  MultipartCompleteBody,
} from './types';
import { QuotaGuard } from './quota';

export { QuotaGuard } from './quota';

interface R2ObjectMetadataLike {
  etag: string;
  httpEtag: string;
  size: number;
  writeHttpMetadata(headers: Headers): void;
}

interface R2ObjectLike extends R2ObjectMetadataLike {
  body: ReadableStream;
  range?: { offset?: number; length?: number };
  json<T>(): Promise<T>;
  text(): Promise<string>;
}

interface R2UploadedPartLike {
  partNumber: number;
  etag: string;
}

interface R2MultipartUploadLike {
  key: string;
  uploadId: string;
  uploadPart(partNumber: number, value: ReadableStream | ArrayBuffer): Promise<R2UploadedPartLike>;
  complete(parts: R2UploadedPartLike[]): Promise<R2ObjectMetadataLike>;
  abort(): Promise<void>;
}

interface R2ListResultLike {
  objects: Array<{ key: string; size: number }>;
  truncated: boolean;
  cursor?: string;
}

interface R2BucketLike {
  get(key: string, options?: { range?: Headers; onlyIf?: { etagMatches?: string } }): Promise<R2ObjectLike | null>;
  head(key: string): Promise<R2ObjectMetadataLike | null>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<R2ListResultLike>;
  put(
    key: string,
    value: string | ReadableStream | ArrayBuffer,
    options?: {
      httpMetadata?: { contentType?: string; cacheControl?: string };
      customMetadata?: Record<string, string>;
      onlyIf?: { etagMatches?: string };
    },
  ): Promise<R2ObjectMetadataLike | null>;
  delete(key: string): Promise<void>;
  createMultipartUpload(
    key: string,
    options?: {
      httpMetadata?: { contentType?: string; cacheControl?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<R2MultipartUploadLike>;
  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUploadLike;
}

interface DurableObjectStubLike {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

export interface Env {
  LIBRARY: R2BucketLike;
  QUOTA: DurableObjectNamespaceLike;
  AUTH_TOKEN: string;
  SIGNING_KEY: string;
  ALLOWED_ORIGIN: string;
  MAX_STORAGE_BYTES?: string;
  MAX_WRITE_OPS_PER_DAY?: string;
  MAX_READ_OPS_PER_DAY?: string;
  MAX_WRITE_OPS_PER_MINUTE?: string;
  MAX_READ_OPS_PER_MINUTE?: string;
  MULTIPART_RESERVATION_TTL_SECONDS?: string;
}

interface QuotaStatus {
  initialized: boolean;
  usedBytes: number;
  reservedBytes: number;
  projectedBytes: number;
  maxBytes: number;
  remainingBytes: number;
  activeUploads: number;
  budgets: {
    readsToday: number;
    maxReadsPerDay: number;
    writesToday: number;
    maxWritesPerDay: number;
  };
}

interface QuotaReservationResult {
  id: string;
  newSize: number;
  oldSize: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly data: unknown,
  ) {
    super(typeof data === 'object' && data && 'error' in data ? String((data as { error: unknown }).error) : `HTTP ${status}`);
  }
}

const MANIFEST_KEY = '_meta/library.json';
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const ASSET_KINDS = new Set<AssetKind>(['epub', 'audio', 'subtitles', 'cover', 'audioCover', 'alignment']);
const SIGNED_URL_TTL_SECONDS = 24 * 60 * 60;
const MAX_BOOKS = 100;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_COMPLETE_JSON_BYTES = 256 * 1024;
const MAX_MULTIPART_PART_BYTES = 32 * 1024 * 1024;
const MAX_ASSET_BYTES: Record<AssetKind, number> = {
  epub: 100_000_000,
  audio: 4_000_000_000,
  subtitles: 50_000_000,
  cover: 20_000_000,
  audioCover: 20_000_000,
  alignment: 100_000_000,
};

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...(headers || {}) },
  });
}

function withCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', origin);
  headers.set('vary', 'Origin');
  headers.set('access-control-expose-headers', 'etag, content-range, accept-ranges');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function corsOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get('origin');
  const allowed = env.ALLOWED_ORIGIN.split(',').map((x) => x.trim()).filter(Boolean);
  if (!origin) return allowed[0] || null;
  return allowed.includes(origin) ? origin : null;
}

function isBearerAuthorized(request: Request, env: Env): boolean {
  return request.headers.get('authorization') === `Bearer ${env.AUTH_TOKEN}`;
}

function safeId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,100}$/.test(value);
}

function assetKey(bookId: string, kind: AssetKind): string {
  return `books/${bookId}/${kind}`;
}

function progressKey(bookId: string): string {
  return `progress/${bookId}.json`;
}

const STATS_PREFIX = '_stats/devices/';
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function statsSnapshotKey(deviceId: string, bookId: string, dateKey: string): string {
  return `${STATS_PREFIX}${deviceId}/${bookId}/${dateKey}.json`;
}

function sanitizeFiniteNumber(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function sanitizeStatisticSnapshot(
  input: Partial<CloudStatisticSnapshot>,
  deviceId: string,
  bookId: string,
  dateKey: string,
): CloudStatisticSnapshot {
  const title = String(input.title || '').trim().slice(0, 500);
  if (!title) throw new HttpError(400, { error: 'Statistic title is required' });

  const completedBook = Number(input.completedBook) > 0 ? 1 : undefined;
  const completedData = input.completedData && typeof input.completedData === 'object'
    ? {
        dateKey: String(input.completedData.dateKey || dateKey).slice(0, 20),
        charactersRead: Math.max(0, sanitizeFiniteNumber(input.completedData.charactersRead)),
        readingTime: Math.max(0, sanitizeFiniteNumber(input.completedData.readingTime)),
        minReadingSpeed: Math.max(0, sanitizeFiniteNumber(input.completedData.minReadingSpeed)),
        altMinReadingSpeed: Math.max(0, sanitizeFiniteNumber(input.completedData.altMinReadingSpeed)),
        lastReadingSpeed: Math.max(0, sanitizeFiniteNumber(input.completedData.lastReadingSpeed)),
        maxReadingSpeed: Math.max(0, sanitizeFiniteNumber(input.completedData.maxReadingSpeed)),
        ...(Number(input.completedData.completedBook) > 0 ? { completedBook: 1 } : {}),
      }
    : undefined;

  return {
    version: 1,
    deviceId,
    bookId,
    title,
    dateKey,
    // Device contributions may be negative after an undo/backward seek. The
    // cloud aggregate is clamped to >= 0 after all devices are summed.
    readingTime: sanitizeFiniteNumber(input.readingTime),
    charactersRead: sanitizeFiniteNumber(input.charactersRead),
    lastStatisticModified: Math.max(0, Math.floor(sanitizeFiniteNumber(input.lastStatisticModified, Date.now()))),
    ...(completedBook ? { completedBook } : {}),
    ...(completedData ? { completedData } : {}),
  };
}

async function readStatisticSnapshots(env: Env): Promise<CloudStatisticSnapshot[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await env.LIBRARY.list({ prefix: STATS_PREFIX, cursor, limit: 1000 });
    for (const object of result.objects) keys.push(object.key);
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor && keys.length < 10_000);

  if (keys.length > 10_000) throw new HttpError(413, { error: 'Too many statistic snapshots' });
  await consumeBudget(env, 'read', Math.max(1, Math.ceil(keys.length / 25)));

  const snapshots: CloudStatisticSnapshot[] = [];
  for (let offset = 0; offset < keys.length; offset += 50) {
    const objects = await Promise.all(keys.slice(offset, offset + 50).map((key) => env.LIBRARY.get(key)));
    for (const object of objects) {
      if (!object) continue;
      const value = await object.json<CloudStatisticSnapshot>().catch(() => undefined);
      if (value?.version === 1 && value.title && value.dateKey) snapshots.push(value);
    }
  }
  return snapshots;
}

function aggregateStatisticSnapshots(snapshots: CloudStatisticSnapshot[]): CloudStatisticAggregate[] {
  const aggregates = new Map<string, CloudStatisticAggregate>();

  for (const snapshot of snapshots) {
    const key = `${snapshot.bookId}\u0000${snapshot.dateKey}`;
    let aggregate = aggregates.get(key);
    if (!aggregate) {
      aggregate = {
        bookId: snapshot.bookId,
        title: snapshot.title,
        dateKey: snapshot.dateKey,
        readingTime: 0,
        charactersRead: 0,
        minReadingSpeed: 0,
        altMinReadingSpeed: 0,
        lastReadingSpeed: 0,
        maxReadingSpeed: 0,
        lastStatisticModified: 0,
      };
      aggregates.set(key, aggregate);
    }

    aggregate.title = snapshot.title || aggregate.title;
    aggregate.readingTime += snapshot.readingTime;
    aggregate.charactersRead += snapshot.charactersRead;
    aggregate.lastStatisticModified = Math.max(aggregate.lastStatisticModified, snapshot.lastStatisticModified);
    if (snapshot.completedBook) aggregate.completedBook = 1;
    if (snapshot.completedData && snapshot.lastStatisticModified >= aggregate.lastStatisticModified) {
      aggregate.completedData = snapshot.completedData;
    }
  }

  for (const aggregate of aggregates.values()) {
    aggregate.readingTime = Math.max(0, Math.round(aggregate.readingTime * 1000) / 1000);
    aggregate.charactersRead = Math.max(0, Math.round(aggregate.charactersRead));
    const speed = aggregate.readingTime > 0
      ? Math.ceil((3600 * aggregate.charactersRead) / aggregate.readingTime)
      : 0;
    aggregate.lastReadingSpeed = speed;
    aggregate.minReadingSpeed = speed;
    aggregate.altMinReadingSpeed = speed;
    aggregate.maxReadingSpeed = speed;
  }

  return [...aggregates.values()].sort((a, b) =>
    a.dateKey === b.dateKey ? a.title.localeCompare(b.title) : a.dateKey.localeCompare(b.dateKey)
  );
}

function quotaStub(env: Env): DurableObjectStubLike {
  return env.QUOTA.get(env.QUOTA.idFromName('ttu-cloud-global-quota'));
}

async function quotaCall<T>(env: Env, path: string, body?: unknown): Promise<T> {
  const response = await quotaStub(env).fetch(`https://quota.internal${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({ error: `Quota guard failed (${response.status})` }))) as T;
  if (!response.ok) throw new HttpError(response.status, data);
  return data;
}

async function ensureQuotaInitialized(env: Env): Promise<QuotaStatus> {
  const status = await quotaCall<QuotaStatus>(env, '/status');
  if (status.initialized) return status;

  let usedBytes = 0;
  let cursor: string | undefined;
  do {
    const result = await env.LIBRARY.list({ prefix: 'books/', cursor, limit: 1000 });
    usedBytes += result.objects.reduce((sum, object) => sum + object.size, 0);
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);

  return quotaCall<QuotaStatus>(env, '/initialize', { usedBytes });
}

async function consumeBudget(env: Env, kind: 'read' | 'write', cost = 1): Promise<void> {
  await quotaCall(env, '/consume', { kind, cost });
}

async function reserveAsset(
  env: Env,
  input: { id: string; key: string; bookId: string; kind: AssetKind; newSize: number; oldSize: number },
): Promise<QuotaReservationResult> {
  await ensureQuotaInitialized(env);
  return quotaCall<QuotaReservationResult>(env, '/reserve', input);
}

function validateAssetSize(kind: AssetKind, size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(400, { error: 'Invalid file size' });
  const max = MAX_ASSET_BYTES[kind];
  if (size > max) {
    throw new HttpError(413, { error: `${kind} exceeds the per-file limit`, maxBytes: max, requestedBytes: size });
  }
}

async function readBodyExact(request: Request, expectedBytes: number, absoluteMax: number): Promise<ArrayBuffer> {
  if (expectedBytes > absoluteMax) throw new HttpError(413, { error: 'Request body exceeds limit' });
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > absoluteMax) {
    throw new HttpError(413, { error: 'Request body exceeds limit' });
  }
  if (!request.body) throw new HttpError(400, { error: 'Missing body' });

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > absoluteMax || total > expectedBytes) {
      await reader.cancel('body too large').catch(() => undefined);
      throw new HttpError(413, { error: 'Uploaded bytes exceed declared size' });
    }
    chunks.push(value);
  }
  if (total !== expectedBytes) {
    throw new HttpError(400, { error: 'Uploaded size does not match declared size', expectedBytes, receivedBytes: total });
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output.buffer;
}

async function readBodyLimited(request: Request, absoluteMax: number): Promise<ArrayBuffer> {
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > absoluteMax) {
    throw new HttpError(413, { error: 'Multipart part exceeds limit' });
  }
  if (!request.body) throw new HttpError(400, { error: 'Missing body' });

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > absoluteMax) {
      await reader.cancel('body too large').catch(() => undefined);
      throw new HttpError(413, { error: 'Multipart part exceeds limit', maxBytes: absoluteMax });
    }
    chunks.push(value);
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output.buffer;
}

async function readJsonLimited<T>(request: Request, maxBytes = MAX_JSON_BYTES): Promise<T> {
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new HttpError(413, { error: 'JSON body too large' });
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new HttpError(413, { error: 'JSON body too large' });
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, { error: 'Invalid JSON' });
  }
}

function sanitizeAudio(input: unknown): CloudBook['audio'] | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as { duration?: unknown; chapters?: unknown };
  const duration = Number(raw.duration);
  const chapters = Array.isArray(raw.chapters)
    ? raw.chapters.slice(0, 5000).flatMap((chapter): AudioChapter[] => {
        if (!chapter || typeof chapter !== 'object') return [];
        const item = chapter as { key?: unknown; label?: unknown; startSeconds?: unknown; startText?: unknown };
        const startSeconds = Number(item.startSeconds);
        if (!Number.isFinite(startSeconds) || startSeconds < 0) return [];
        return [{
          key: String(item.key ?? '').slice(0, 200),
          label: String(item.label ?? '').slice(0, 500),
          startSeconds,
          ...(item.startText == null ? {} : { startText: String(item.startText).slice(0, 1000) }),
        }];
      })
    : undefined;
  if (!Number.isFinite(duration) && !chapters?.length) return undefined;
  return {
    ...(Number.isFinite(duration) && duration >= 0 ? { duration } : {}),
    ...(chapters?.length ? { chapters } : {}),
  };
}

function sanitizeAlignment(input: unknown): CloudBook['alignment'] | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = input as Record<string, unknown>;
  const source = raw.source === 'manual' ? 'manual' : raw.source === 'auto' ? 'auto' : undefined;
  if (!source) return undefined;
  const matchedLines = Math.max(0, Math.floor(Number(raw.matchedLines) || 0));
  const totalLines = Math.max(0, Math.floor(Number(raw.totalLines) || 0));
  const diffLines = Math.max(0, Math.floor(Number(raw.diffLines) || 0));
  const rate = totalLines ? Math.min(1, Math.max(0, Number(raw.rate) || matchedLines / totalLines)) : 0;
  return {
    version: 1,
    source,
    matchedBy: String(raw.matchedBy || '').slice(0, 1000),
    matchedOn: Math.max(0, Math.floor(Number(raw.matchedOn) || Date.now())),
    matchedLines,
    totalLines,
    diffLines,
    rate,
  };
}

async function readManifest(env: Env): Promise<{ manifest: LibraryManifest; etag?: string }> {
  const object = await env.LIBRARY.get(MANIFEST_KEY);
  if (!object) {
    return { manifest: { version: 1, updatedAt: Date.now(), books: [] } };
  }
  return { manifest: await object.json<LibraryManifest>(), etag: object.etag };
}

async function writeManifest(env: Env, manifest: LibraryManifest, etag?: string): Promise<string> {
  manifest.updatedAt = Date.now();
  const saved = await env.LIBRARY.put(MANIFEST_KEY, JSON.stringify(manifest), {
    httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
    ...(etag ? { onlyIf: { etagMatches: etag } } : {}),
  });
  if (!saved) throw new Error('Manifest changed concurrently. Retry the request.');
  return saved.httpEtag;
}

async function updateBook(env: Env, bookId: string, updater: (book: CloudBook | undefined) => CloudBook): Promise<CloudBook> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { manifest, etag } = await readManifest(env);
    const index = manifest.books.findIndex((book) => book.id === bookId);
    const next = updater(index >= 0 ? manifest.books[index] : undefined);
    if (index < 0 && manifest.books.length >= MAX_BOOKS) throw new HttpError(409, { error: `Cloud library is limited to ${MAX_BOOKS} books` });
    if (index >= 0) manifest.books[index] = next;
    else manifest.books.push(next);
    try {
      await writeManifest(env, manifest, etag);
      return next;
    } catch (error) {
      if (error instanceof HttpError || attempt === 2) throw error;
    }
  }
  throw new Error('Failed to update book');
}

async function requireBook(env: Env, bookId: string): Promise<CloudBook> {
  const book = (await readManifest(env)).manifest.books.find((candidate) => candidate.id === bookId);
  if (!book) throw new HttpError(404, { error: 'Book not found' });
  return book;
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sign(path: string, expires: number, key: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(`${path}\n${expires}`)));
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

async function isSignedAuthorized(url: URL, env: Env): Promise<boolean> {
  const expires = Number(url.searchParams.get('expires'));
  const signature = url.searchParams.get('sig') || '';
  if (!Number.isSafeInteger(expires) || expires < Math.floor(Date.now() / 1000)) return false;
  if (expires > Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_SECONDS + 60) return false;
  const expected = await sign(url.pathname, expires, env.SIGNING_KEY);
  return constantTimeEqualHex(signature, expected);
}

async function streamAsset(request: Request, env: Env, bookId: string, kind: AssetKind): Promise<Response> {
  await consumeBudget(env, 'read', 1);
  const object = await env.LIBRARY.get(assetKey(bookId, kind), { range: request.headers });
  if (!object) return json({ error: 'Asset not found' }, 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('accept-ranges', 'bytes');

  let status = 200;
  if (request.headers.has('range') && object.range) {
    const offset = object.range.offset ?? 0;
    const length = object.range.length ?? object.size;
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set('content-length', String(length));
    status = 206;
  } else {
    headers.set('content-length', String(object.size));
  }
  return new Response(request.method === 'HEAD' ? null : object.body, { status, headers });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);

  if (url.pathname === '/health') return json({ ok: true });

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'access-control-allow-methods': 'GET, HEAD, PUT, POST, DELETE, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type, if-match, range, x-file-name',
        'access-control-max-age': '86400',
      },
    });
  }

  const isAssetRead =
    (request.method === 'GET' || request.method === 'HEAD') &&
    parts[0] === 'v1' &&
    parts[1] === 'books' &&
    parts[3] === 'assets';
  if (!isBearerAuthorized(request, env) && !(isAssetRead && (await isSignedAuthorized(url, env)))) {
    return json({ error: 'Unauthorized' }, 401);
  }

  if (request.method === 'GET' && url.pathname === '/v1/quota') {
    return json(await ensureQuotaInitialized(env));
  }

  if (request.method === 'GET' && url.pathname === '/v1/library') {
    await consumeBudget(env, 'read', 1);
    return json((await readManifest(env)).manifest);
  }

  if (parts[0] === 'v1' && parts[1] === 'books' && parts.length === 3) {
    const bookId = parts[2];
    if (!safeId(bookId)) return json({ error: 'Invalid book id' }, 400);

    if (request.method === 'PUT') {
      await consumeBudget(env, 'write', 1);
      const body = await readJsonLimited<Partial<CloudBook>>(request);
      const requestedTitle = String(body.title || '').trim().slice(0, 500);
      const author = body.author == null ? undefined : String(body.author).trim().slice(0, 500) || undefined;
      const audio = sanitizeAudio(body.audio);
      const alignment = sanitizeAlignment(body.alignment);
      const requestedShelf = body.shelf === 'history' || body.shelf === 'library' ? body.shelf : undefined;
      const requestedFinishedAt = Number(body.finishedAt);
      const finishedAt = Number.isFinite(requestedFinishedAt) && requestedFinishedAt > 0
        ? Math.floor(requestedFinishedAt)
        : undefined;
      const now = Date.now();
      const book = await updateBook(env, bookId, (old) => {
        if (!requestedTitle && !old?.title) throw new HttpError(400, { error: 'title is required' });
        const shelf = requestedShelf ?? old?.shelf ?? 'library';
        return {
          id: bookId,
          title: requestedTitle || old!.title,
          author: author ?? old?.author,
          addedAt: old?.addedAt ?? now,
          updatedAt: now,
          assets: old?.assets || {},
          audio: audio ?? old?.audio,
          alignment: alignment ?? old?.alignment,
          shelf,
          finishedAt: shelf === 'history' ? (finishedAt ?? old?.finishedAt ?? now) : undefined,
        };
      });
      return json(book);
    }

    if (request.method === 'DELETE') {
      await consumeBudget(env, 'write', 1);
      await ensureQuotaInitialized(env);
      const { manifest, etag } = await readManifest(env);
      const existing = manifest.books.find((book) => book.id === bookId);
      if (!existing) return new Response(null, { status: 204 });

      const heads = await Promise.all([...ASSET_KINDS].map((kind) => env.LIBRARY.head(assetKey(bookId, kind))));
      const deletedBytes = heads.reduce((sum, object) => sum + (object?.size || 0), 0);
      await Promise.all([...ASSET_KINDS].map((kind) => env.LIBRARY.delete(assetKey(bookId, kind))));
      await env.LIBRARY.delete(progressKey(bookId));
      manifest.books = manifest.books.filter((book) => book.id !== bookId);
      await writeManifest(env, manifest, etag);
      if (deletedBytes) await quotaCall(env, '/adjust-used', { delta: -deletedBytes });
      return new Response(null, { status: 204 });
    }
  }

  if (parts[0] === 'v1' && parts[1] === 'books' && parts[3] === 'assets' && parts.length >= 5) {
    const bookId = parts[2];
    const kind = parts[4] as AssetKind;
    if (!safeId(bookId) || !ASSET_KINDS.has(kind)) return json({ error: 'Invalid asset path' }, 400);
    const key = assetKey(bookId, kind);

    if ((request.method === 'GET' || request.method === 'HEAD') && parts.length === 5) {
      return streamAsset(request, env, bookId, kind);
    }

    if (request.method === 'POST' && parts[5] === 'signed-url') {
      await requireBook(env, bookId);
      const expires = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_SECONDS;
      const path = `/v1/books/${bookId}/assets/${kind}`;
      const sig = await sign(path, expires, env.SIGNING_KEY);
      return json({ url: `${url.origin}${path}?expires=${expires}&sig=${sig}`, expires });
    }

    if (request.method === 'PUT' && parts[5] === 'direct') {
      await requireBook(env, bookId);
      const size = Number(url.searchParams.get('size'));
      validateAssetSize(kind, size);
      await consumeBudget(env, 'write', 2);
      const bytes = await readBodyExact(request, size, Math.min(MAX_ASSET_BYTES[kind], 32 * 1024 * 1024));
      const contentType = (request.headers.get('content-type') || 'application/octet-stream').slice(0, 200);
      // Prefer URL metadata so Unicode filenames never have to be encoded as HTTP
      // header values. Keep the old header as a compatibility fallback.
      const fileName = (url.searchParams.get('fileName') || request.headers.get('x-file-name') || kind).slice(0, 1000);
      const oldSize = (await env.LIBRARY.head(key))?.size || 0;
      const reservationId = crypto.randomUUID();
      await reserveAsset(env, { id: reservationId, key, bookId, kind, newSize: size, oldSize });
      await quotaCall(env, '/prepare-commit', { id: reservationId, requireExactUploadedBytes: false });

      try {
        const object = await env.LIBRARY.put(key, bytes, {
          httpMetadata: { contentType, cacheControl: kind === 'audio' ? 'private, max-age=3600' : 'private, max-age=86400' },
          customMetadata: { fileName },
        });
        if (!object) throw new Error('R2 did not return uploaded object metadata');
        await quotaCall(env, '/finalize-commit', { id: reservationId });
        await updateBook(env, bookId, (old) => {
          if (!old) throw new HttpError(404, { error: 'Book not found' });
          return {
            ...old,
            updatedAt: Date.now(),
            assets: {
              ...old.assets,
              [kind]: { kind, fileName, contentType, size: object.size, etag: object.httpEtag },
            },
          };
        });
        return json({ etag: object.httpEtag });
      } catch (error) {
        await quotaCall(env, '/rollback-commit', { id: reservationId }).catch(() => undefined);
        throw error;
      }
    }

    if (parts[5] === 'multipart') {
      const action = parts[6];
      if (request.method === 'POST' && action === 'create') {
        await requireBook(env, bookId);
        const size = Number(url.searchParams.get('size'));
        validateAssetSize(kind, size);
        await consumeBudget(env, 'write', 1);
        const contentType = (url.searchParams.get('contentType') || 'application/octet-stream').slice(0, 200);
        const fileName = (url.searchParams.get('fileName') || kind).slice(0, 1000);
        const oldSize = (await env.LIBRARY.head(key))?.size || 0;
        const reservationId = crypto.randomUUID();
        await reserveAsset(env, { id: reservationId, key, bookId, kind, newSize: size, oldSize });

        try {
          const upload = await env.LIBRARY.createMultipartUpload(key, {
            httpMetadata: { contentType, cacheControl: 'private, max-age=3600' },
            customMetadata: { fileName },
          });
          await quotaCall(env, '/bind-upload', { id: reservationId, uploadId: upload.uploadId });
          return json({ uploadId: upload.uploadId, key: upload.key });
        } catch (error) {
          await quotaCall(env, '/release', { id: reservationId }).catch(() => undefined);
          throw error;
        }
      }

      const uploadId = url.searchParams.get('uploadId');
      if (!uploadId) return json({ error: 'Missing uploadId' }, 400);
      const upload = env.LIBRARY.resumeMultipartUpload(key, uploadId);

      if (request.method === 'PUT' && action === 'part') {
        const partNumber = Number(url.searchParams.get('partNumber'));
        if (!Number.isInteger(partNumber) || partNumber < 1) return json({ error: 'Invalid part' }, 400);
        await consumeBudget(env, 'write', 1);
        const bytes = await readBodyLimited(request, MAX_MULTIPART_PART_BYTES);
        if (!bytes.byteLength) return json({ error: 'Empty multipart part' }, 400);
        await quotaCall(env, '/record-part', { uploadId, partNumber, size: bytes.byteLength });
        return json(await upload.uploadPart(partNumber, bytes));
      }

      if (request.method === 'POST' && action === 'complete') {
        await consumeBudget(env, 'write', 2);
        const body = await readJsonLimited<MultipartCompleteBody>(request, MAX_COMPLETE_JSON_BYTES);
        if (!Array.isArray(body.parts) || !body.parts.length || body.parts.length > 10_000) {
          return json({ error: 'Invalid multipart completion' }, 400);
        }
        const fileName = String(body.fileName || kind).slice(0, 1000);
        const contentType = String(body.contentType || 'application/octet-stream').slice(0, 200);
        const prepared = await quotaCall<{ id: string }>(env, '/prepare-commit', {
          uploadId,
          requireExactUploadedBytes: true,
        });

        try {
          const object = await upload.complete(body.parts);
          await quotaCall(env, '/finalize-commit', { id: prepared.id });
          const now = Date.now();
          await updateBook(env, bookId, (old) => {
            if (!old) throw new HttpError(404, { error: 'Book not found' });
            return {
              ...old,
              updatedAt: now,
              assets: {
                ...old.assets,
                [kind]: {
                  kind,
                  fileName,
                  contentType,
                  size: object.size,
                  etag: object.httpEtag,
                },
              },
            };
          });
          return json({ etag: object.httpEtag });
        } catch (error) {
          await quotaCall(env, '/rollback-commit', { id: prepared.id }).catch(() => undefined);
          throw error;
        }
      }

      if (request.method === 'DELETE' && action === 'abort') {
        await consumeBudget(env, 'write', 1);
        await upload.abort().catch(() => undefined);
        await quotaCall(env, '/release', { uploadId });
        return new Response(null, { status: 204 });
      }
    }
  }

  if (request.method === 'GET' && url.pathname === '/v1/stats') {
    return json({ version: 1, statistics: aggregateStatisticSnapshots(await readStatisticSnapshots(env)) });
  }

  if (parts[0] === 'v1' && parts[1] === 'stats' && parts[2] === 'snapshot' && parts.length === 6) {
    const deviceId = parts[3];
    const bookId = parts[4];
    const dateKey = parts[5];
    if (!safeId(deviceId) || !safeId(bookId) || !DATE_KEY_RE.test(dateKey)) {
      return json({ error: 'Invalid statistics path' }, 400);
    }

    if (request.method === 'PUT') {
      await requireBook(env, bookId);
      await consumeBudget(env, 'write', 1);
      const input = await readJsonLimited<Partial<CloudStatisticSnapshot>>(request);
      const snapshot = sanitizeStatisticSnapshot(input, deviceId, bookId, dateKey);
      const serialized = JSON.stringify(snapshot);
      if (new TextEncoder().encode(serialized).byteLength > MAX_JSON_BYTES) {
        throw new HttpError(413, { error: 'Statistic snapshot too large' });
      }
      await env.LIBRARY.put(statsSnapshotKey(deviceId, bookId, dateKey), serialized, {
        httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
      });
      return json(snapshot);
    }
  }

  if (parts[0] === 'v1' && parts[1] === 'progress' && parts.length === 3) {
    const bookId = parts[2];
    if (!safeId(bookId)) return json({ error: 'Invalid book id' }, 400);
    const key = progressKey(bookId);

    if (request.method === 'GET') {
      await consumeBudget(env, 'read', 1);
      const object = await env.LIBRARY.get(key);
      if (!object) return new Response(null, { status: 204 });
      return json(await object.json<CloudProgress>(), 200, { etag: object.httpEtag });
    }

    if (request.method === 'PUT') {
      await requireBook(env, bookId);
      await consumeBudget(env, 'write', 1);
      const input = await readJsonLimited<Omit<CloudProgress, 'version' | 'bookId' | 'updatedAt'>>(request);
      const progress: CloudProgress = {
        ...input,
        version: 1,
        bookId,
        updatedAt: Date.now(),
      };
      const serialized = JSON.stringify(progress);
      if (new TextEncoder().encode(serialized).byteLength > MAX_JSON_BYTES) throw new HttpError(413, { error: 'Progress data too large' });
      const ifMatch = request.headers.get('if-match') || undefined;
      const saved = await env.LIBRARY.put(key, serialized, {
        httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
        ...(ifMatch ? { onlyIf: { etagMatches: ifMatch.replace(/^W\//, '').replaceAll('"', '') } } : {}),
      });
      if (!saved) return json({ error: 'Progress changed on another device' }, 412);
      return json(progress, 200, { etag: saved.httpEtag });
    }
  }

  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = corsOrigin(request, env);
    if (!origin) return json({ error: 'Origin not allowed' }, 403);
    try {
      return withCors(await route(request, env), origin);
    } catch (error) {
      if (error instanceof HttpError) return withCors(json(error.data, error.status), origin);
      const message = error instanceof Error ? error.message : String(error);
      return withCors(json({ error: message }, 500), origin);
    }
  },
};
