import { CloudApiError, TtsuCloudApi } from './api';
import { announceCloudProgressUpdated } from './cloud-events';
import type {
  CloudAudiobookProgress,
  CloudProgress,
  CloudReaderProgress
} from './types';

export type ProgressConflictHandler = (remote: CloudProgress | undefined) => void;

type ReaderUpdate = Omit<CloudReaderProgress, 'updatedAt'> & { updatedAt?: number };
type AudiobookUpdate = Omit<CloudAudiobookProgress, 'updatedAt'> & { updatedAt?: number };

interface ProgressUpdate {
  reader?: ReaderUpdate;
  audiobook?: AudiobookUpdate;
}

export class CloudProgressSync {
  private etag?: string;
  private latest?: CloudProgress;
  private saving?: Promise<void>;
  private queued?: ProgressUpdate;
  private audiobookConflictRevisionValue = 0;

  constructor(
    private readonly api: TtsuCloudApi,
    readonly bookId: string,
    readonly deviceId: string,
    private readonly onConflict?: ProgressConflictHandler
  ) {}

  async load(): Promise<CloudProgress | undefined> {
    const snapshot = await this.api.getProgress(this.bookId);
    this.etag = snapshot.etag;
    this.latest = snapshot.progress;
    return snapshot.progress;
  }

  /** Seed the session from a bulk library snapshot without another network request. */
  seed(progress?: CloudProgress, etag?: string): void {
    const currentUpdatedAt = this.latest?.updatedAt || 0;
    const seededUpdatedAt = progress?.updatedAt || 0;
    if (this.latest && seededUpdatedAt < currentUpdatedAt) return;
    this.latest = progress;
    this.etag = etag;
  }

  get current(): CloudProgress | undefined {
    return this.latest;
  }

  /**
   * Monotonically increases only when a 412 shows that the remote audiobook
   * field itself changed. Callers can use this to distinguish a real same-field
   * conflict from a successful save that merely returned a newer coalesced
   * snapshot from this session.
   */
  get audiobookConflictRevision(): number {
    return this.audiobookConflictRevisionValue;
  }

  async save(input: ProgressUpdate): Promise<CloudProgress | undefined> {
    const now = Date.now();
    this.queued = mergeUpdates(this.queued, {
      reader: input.reader ? { ...input.reader, updatedAt: input.reader.updatedAt || now } : undefined,
      audiobook: input.audiobook
        ? { ...input.audiobook, updatedAt: input.audiobook.updatedAt || now }
        : undefined
    });

    // `saving` represents the whole queue drain, not just the current HTTP PUT.
    // Every concurrent caller therefore waits until the update it contributed has
    // either been committed, resolved as a 412 conflict, or failed. Previously a
    // second caller could wake up after the first PUT and return an older snapshot
    // while the first caller was only then starting the queued second PUT.
    if (!this.saving) {
      this.saving = this.drainQueued().finally(() => {
        this.saving = undefined;
      });
    }

    await this.saving;
    return this.latest;
  }

  private async drainQueued(): Promise<void> {
    while (this.queued) {
      const pending = this.queued;
      this.queued = undefined;
      const base = this.latest;
      const next = this.composePayload(pending);

      try {
        const snapshot = await this.api.putProgress(this.bookId, next, this.etag);
        this.etag = snapshot.etag;
        this.latest = snapshot.progress;
        announceCloudProgressUpdated(this.bookId, this.latest);
      } catch (error) {
        if (error instanceof CloudApiError && error.status === 412) {
          const remote = await this.api.getProgress(this.bookId);
          this.etag = remote.etag;
          this.latest = remote.progress;
          this.onConflict?.(remote.progress);

          // A 412 means another device wrote after the version we started from.
          // Retry a pending field only if that particular field did NOT change
          // remotely. This lets reader+audio updates merge without allowing an
          // old device to rewind a newer position in the same field.
          const retry = fieldsUnchangedRemotely(pending, base, remote.progress);
          if (pending.audiobook && !retry?.audiobook) {
            this.audiobookConflictRevisionValue += 1;
          }
          this.queued = mergeUpdates(retry, this.queued);
          continue;
        }

        // Transient failures (notably 429s) must not silently discard the last
        // progress snapshot. Keep it queued; a later save/explicit retry will
        // merge in anything newer and try again. Permanent 4xx failures are not
        // retained, otherwise a later unrelated reader save could resurrect a
        // rejected/stale audiobook field.
        if (isRetryableProgressError(error)) {
          this.queued = mergeUpdates(pending, this.queued);
        }
        throw error;
      }
    }
  }

  private composePayload(update: ProgressUpdate) {
    return {
      deviceId: this.deviceId,
      reader: update.reader
        ? ({ ...this.latest?.reader, ...update.reader } as CloudReaderProgress)
        : this.latest?.reader,
      audiobook: update.audiobook
        ? ({ ...this.latest?.audiobook, ...update.audiobook } as CloudAudiobookProgress)
        : this.latest?.audiobook
    };
  }
}


function isRetryableProgressError(error: unknown): boolean {
  if (!(error instanceof CloudApiError)) return true;
  return error.status === 408 || error.status === 429 || error.status >= 500;
}

function fieldsUnchangedRemotely(
  update: ProgressUpdate,
  base: CloudProgress | undefined,
  remote: CloudProgress | undefined
): ProgressUpdate | undefined {
  const readerChanged = (base?.reader?.updatedAt || 0) !== (remote?.reader?.updatedAt || 0);
  const audiobookChanged =
    (base?.audiobook?.updatedAt || 0) !== (remote?.audiobook?.updatedAt || 0);

  const reader = update.reader && !readerChanged ? update.reader : undefined;
  const audiobook = update.audiobook && !audiobookChanged ? update.audiobook : undefined;
  return reader || audiobook ? { reader, audiobook } : undefined;
}

function mergeUpdates(first?: ProgressUpdate, second?: ProgressUpdate): ProgressUpdate | undefined {
  if (!first) return second;
  if (!second) return first;

  const firstReaderAt = first.reader?.updatedAt || 0;
  const secondReaderAt = second.reader?.updatedAt || 0;
  const firstAudioAt = first.audiobook?.updatedAt || 0;
  const secondAudioAt = second.audiobook?.updatedAt || 0;

  const reader = secondReaderAt >= firstReaderAt ? second.reader || first.reader : first.reader;
  const audiobook = secondAudioAt >= firstAudioAt ? second.audiobook || first.audiobook : first.audiobook;
  return { reader, audiobook };
}

export function getOrCreateDeviceId(storage: Storage = localStorage): string {
  const key = 'ttu-cloud-device-id';
  let id = storage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    storage.setItem(key, id);
  }
  return id;
}
