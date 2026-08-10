import type { AssetKind, CloudBook, CloudLibrarySnapshot, CloudProgress, CloudQuotaStatus, CloudStatisticAggregate, CloudStatisticSnapshot, LibraryManifest, ProgressSnapshot } from './types';

export interface CloudApiOptions {
  baseUrl: string;
  token: string;
}

export interface UploadOptions {
  partSize?: number;
  concurrency?: number;
  retries?: number;
  signal?: AbortSignal;
  onProgress?: (uploadedBytes: number, totalBytes: number) => void;
}

interface UploadedPart {
  partNumber: number;
  etag: string;
}

export class CloudApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    const detail =
      body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : '';
    super(detail ? `${message}: ${detail}` : message);
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DIRECT_UPLOAD_TIMEOUT_MS = 5 * 60_000;
const MULTIPART_PART_TIMEOUT_MS = 3 * 60_000;
const MULTIPART_COMPLETE_TIMEOUT_MS = 60_000;

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const externalSignal = init.signal;
  let timedOut = false;
  const onExternalAbort = () => controller.abort(externalSignal?.reason);

  if (externalSignal?.aborted) {
    controller.abort(externalSignal.reason);
  } else {
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  }

  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut && !externalSignal?.aborted) {
      throw new Error(`Cloud request timed out after ${Math.round(timeoutMs / 1000)} seconds`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

export class TtsuCloudApi {
  readonly baseUrl: string;
  private readonly token: string;

  constructor(options: CloudApiOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<{ data: T; response: Response }> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${this.token}`);
    const response = await fetchWithTimeout(`${this.baseUrl}${path}`, { ...init, headers }, timeoutMs);

    if (!response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = await response.text().catch(() => undefined);
      }
      throw new CloudApiError(`Cloud request failed (${response.status})`, response.status, body);
    }

    if (response.status === 204) return { data: undefined as T, response };
    return { data: (await response.json()) as T, response };
  }

  async getLibrary(): Promise<LibraryManifest> {
    return (await this.request<LibraryManifest>('/v1/library')).data;
  }

  async getLibrarySnapshot(): Promise<CloudLibrarySnapshot> {
    try {
      return (await this.request<CloudLibrarySnapshot>('/v1/library/snapshot')).data;
    } catch (error) {
      // Allow the frontend and Worker to be deployed in either order. Older
      // Workers do not have the bulk endpoint, so temporarily fall back to the
      // pre-v0.1.1 request pattern instead of breaking the library.
      if (!(error instanceof CloudApiError) || error.status !== 404) throw error;

      const [library, quota] = await Promise.all([this.getLibrary(), this.getQuota()]);
      const progress: CloudLibrarySnapshot['progress'] = {};
      const coverUrls: Record<string, string> = {};
      await Promise.all(
        library.books.map(async (book) => {
          progress[book.id] = await this.getProgress(book.id).catch(() => ({}));
          if (book.assets.cover) {
            const url = await this.getSignedAssetUrl(book.id, 'cover').catch(() => '');
            if (url) coverUrls[book.id] = url;
          }
        })
      );
      return { version: 1, generatedAt: Date.now(), library, quota, progress, coverUrls };
    }
  }

  async getQuota(): Promise<CloudQuotaStatus> {
    return (await this.request<CloudQuotaStatus>('/v1/quota')).data;
  }

  async clearStuckUploads(): Promise<CloudQuotaStatus> {
    return (
      await this.request<CloudQuotaStatus>('/v1/uploads/cleanup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force: true }),
      })
    ).data;
  }

  async upsertBook(book: Pick<CloudBook, 'id' | 'title'> & Partial<CloudBook>): Promise<CloudBook> {
    return (
      await this.request<CloudBook>(`/v1/books/${encodeURIComponent(book.id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(book),
      })
    ).data;
  }

  async deleteBook(bookId: string): Promise<void> {
    await this.request<void>(`/v1/books/${encodeURIComponent(bookId)}`, { method: 'DELETE' });
  }

  async getSignedAssetUrl(bookId: string, kind: AssetKind): Promise<string> {
    const { data } = await this.request<{ url: string }>(
      `/v1/books/${encodeURIComponent(bookId)}/assets/${kind}/signed-url`,
      { method: 'POST' },
    );
    return data.url;
  }

  async fetchAsset(bookId: string, kind: AssetKind): Promise<Blob> {
    const headers = new Headers({ authorization: `Bearer ${this.token}` });
    const response = await fetch(`${this.baseUrl}/v1/books/${encodeURIComponent(bookId)}/assets/${kind}`, { headers });
    if (!response.ok) throw new CloudApiError(`Asset download failed (${response.status})`, response.status);
    return response.blob();
  }

  async uploadAsset(bookId: string, kind: AssetKind, file: File, options: UploadOptions = {}): Promise<void> {
    const partSize = Math.max(options.partSize ?? 10 * 1024 * 1024, 5 * 1024 * 1024);
    const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 8));
    const retries = Math.max(0, options.retries ?? 3);

    // Tiny files do not need multipart. Keep the large-audiobook path multipart/resumable.
    if (file.size <= partSize) {
      const headers = new Headers({
        authorization: `Bearer ${this.token}`,
        'content-type': file.type || 'application/octet-stream',
      });
      // Header values are ByteStrings in browsers. A raw filename header fails for
      // Japanese and other non-Latin-1 names, so filenames always travel URL-encoded.
      const directPath =
        `/v1/books/${encodeURIComponent(bookId)}/assets/${kind}/direct` +
        `?size=${file.size}&fileName=${encodeURIComponent(file.name)}`;
      const response = await fetchWithTimeout(
        `${this.baseUrl}${directPath}`,
        { method: 'PUT', headers, body: file, signal: options.signal },
        DIRECT_UPLOAD_TIMEOUT_MS,
      );
      if (!response.ok) {
        const body = await response.json().catch(() => undefined);
        throw new CloudApiError(`Asset upload failed (${response.status})`, response.status, body);
      }
      options.onProgress?.(file.size, file.size);
      return;
    }

    const createPath =
      `/v1/books/${encodeURIComponent(bookId)}/assets/${kind}/multipart/create` +
      `?fileName=${encodeURIComponent(file.name)}&contentType=${encodeURIComponent(file.type || 'application/octet-stream')}` +
      `&size=${file.size}`;
    const { data: created } = await this.request<{ uploadId: string }>(
      createPath,
      { method: 'POST', signal: options.signal },
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    const uploadId = created.uploadId;
    const totalParts = Math.ceil(file.size / partSize);
    const parts: UploadedPart[] = new Array(totalParts);
    let nextPart = 0;
    let uploadedBytes = 0;

    const uploadOne = async (index: number): Promise<UploadedPart> => {
      const start = index * partSize;
      const end = Math.min(file.size, start + partSize);
      const chunk = file.slice(start, end);
      let lastError: unknown;

      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          const { data } = await this.request<UploadedPart>(
            `/v1/books/${encodeURIComponent(bookId)}/assets/${kind}/multipart/part` +
              `?uploadId=${encodeURIComponent(uploadId)}&partNumber=${index + 1}`,
            { method: 'PUT', body: chunk, signal: options.signal },
            MULTIPART_PART_TIMEOUT_MS,
          );
          uploadedBytes += chunk.size;
          options.onProgress?.(Math.min(uploadedBytes, file.size), file.size);
          return data;
        } catch (error) {
          lastError = error;
          if (options.signal?.aborted) throw error;
          if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        }
      }
      throw lastError;
    };

    const worker = async () => {
      while (true) {
        const index = nextPart++;
        if (index >= totalParts) return;
        parts[index] = await uploadOne(index);
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, totalParts) }, () => worker()));
      await this.request<{ etag: string }>(
        `/v1/books/${encodeURIComponent(bookId)}/assets/${kind}/multipart/complete?uploadId=${encodeURIComponent(uploadId)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            parts,
            fileName: file.name,
            contentType: file.type || 'application/octet-stream',
            size: file.size,
          }),
          signal: options.signal,
        },
        MULTIPART_COMPLETE_TIMEOUT_MS,
      );
    } catch (error) {
      await this.request<void>(
        `/v1/books/${encodeURIComponent(bookId)}/assets/${kind}/multipart/abort?uploadId=${encodeURIComponent(uploadId)}`,
        { method: 'DELETE' },
      ).catch(() => undefined);
      throw error;
    }
  }


  async getStatistics(): Promise<CloudStatisticAggregate[]> {
    const { data } = await this.request<{ version: 1; statistics: CloudStatisticAggregate[] }>('/v1/stats');
    return data.statistics || [];
  }

  async putStatisticSnapshot(snapshot: CloudStatisticSnapshot): Promise<CloudStatisticSnapshot> {
    const path =
      `/v1/stats/snapshot/${encodeURIComponent(snapshot.deviceId)}` +
      `/${encodeURIComponent(snapshot.bookId)}/${encodeURIComponent(snapshot.dateKey)}`;
    return (
      await this.request<CloudStatisticSnapshot>(path, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(snapshot),
      })
    ).data;
  }

  async getProgress(bookId: string): Promise<ProgressSnapshot> {
    const headers = new Headers({ authorization: `Bearer ${this.token}` });
    const response = await fetch(`${this.baseUrl}/v1/progress/${encodeURIComponent(bookId)}`, { headers });
    if (response.status === 204) return {};
    if (!response.ok) throw new CloudApiError(`Progress load failed (${response.status})`, response.status);
    return {
      progress: (await response.json()) as CloudProgress,
      etag: response.headers.get('etag') || undefined,
    };
  }

  async putProgress(
    bookId: string,
    progress: Omit<CloudProgress, 'version' | 'bookId' | 'updatedAt'>,
    etag?: string,
  ): Promise<ProgressSnapshot> {
    const headers = new Headers({
      authorization: `Bearer ${this.token}`,
      'content-type': 'application/json',
    });
    if (etag) headers.set('if-match', etag);
    const response = await fetch(`${this.baseUrl}/v1/progress/${encodeURIComponent(bookId)}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(progress),
    });
    if (response.status === 412) throw new CloudApiError('Progress changed on another device', 412);
    if (!response.ok) throw new CloudApiError(`Progress save failed (${response.status})`, response.status);
    return {
      progress: (await response.json()) as CloudProgress,
      etag: response.headers.get('etag') || undefined,
    };
  }
}
