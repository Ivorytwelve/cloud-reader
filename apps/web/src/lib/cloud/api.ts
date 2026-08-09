import type { AssetKind, CloudBook, CloudProgress, CloudQuotaStatus, CloudStatisticAggregate, CloudStatisticSnapshot, LibraryManifest, ProgressSnapshot } from './types';

export interface CloudApiOptions {
  baseUrl: string;
  token: string;
}

export interface UploadOptions {
  partSize?: number;
  concurrency?: number;
  retries?: number;
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

export class TtsuCloudApi {
  readonly baseUrl: string;
  private readonly token: string;

  constructor(options: CloudApiOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<{ data: T; response: Response }> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${this.token}`);
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers });

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

  async getQuota(): Promise<CloudQuotaStatus> {
    return (await this.request<CloudQuotaStatus>('/v1/quota')).data;
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
      const response = await fetch(`${this.baseUrl}${directPath}`, { method: 'PUT', headers, body: file });
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
    const { data: created } = await this.request<{ uploadId: string }>(createPath, { method: 'POST' });
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
            { method: 'PUT', body: chunk },
          );
          uploadedBytes += chunk.size;
          options.onProgress?.(Math.min(uploadedBytes, file.size), file.size);
          return data;
        } catch (error) {
          lastError = error;
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
        },
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
