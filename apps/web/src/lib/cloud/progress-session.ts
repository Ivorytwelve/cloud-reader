import { TtsuCloudApi } from './api';
import { loadCloudConfig } from './config';
import { CloudProgressSync, getOrCreateDeviceId } from './progress-sync';
import type { ProgressSnapshot } from './types';

interface SessionEntry {
  sync: CloudProgressSync;
  loaded: Promise<void>;
}

const sessions = new Map<string, SessionEntry>();

export function getConfiguredCloudApi(): TtsuCloudApi | undefined {
  const config = loadCloudConfig();
  return config ? new TtsuCloudApi({ baseUrl: config.workerUrl, token: config.token }) : undefined;
}

export function getCloudProgressSession(
  bookId: string,
  api: TtsuCloudApi = getConfiguredCloudApi() as TtsuCloudApi
): SessionEntry | undefined {
  if (!api) return undefined;

  const existing = sessions.get(bookId);
  if (existing) return existing;

  const sync = new CloudProgressSync(api, bookId, getOrCreateDeviceId());
  const entry: SessionEntry = {
    sync,
    loaded: sync.load().then(() => undefined)
  };
  sessions.set(bookId, entry);
  return entry;
}

export function clearCloudProgressSession(bookId?: string): void {
  if (bookId) sessions.delete(bookId);
  else sessions.clear();
}

export function seedCloudProgressSession(
  bookId: string,
  snapshot: ProgressSnapshot,
  api: TtsuCloudApi = getConfiguredCloudApi() as TtsuCloudApi
): SessionEntry | undefined {
  if (!api) return undefined;

  const existing = sessions.get(bookId);
  if (existing) {
    existing.sync.seed(snapshot.progress, snapshot.etag);
    return existing;
  }

  const sync = new CloudProgressSync(api, bookId, getOrCreateDeviceId());
  sync.seed(snapshot.progress, snapshot.etag);
  const entry: SessionEntry = { sync, loaded: Promise.resolve() };
  sessions.set(bookId, entry);
  return entry;
}
