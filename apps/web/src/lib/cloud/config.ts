const WORKER_URL_KEY = 'ttu-cloud-worker-url';
const TOKEN_KEY = 'ttu-cloud-token';

export interface SavedCloudConfig {
  workerUrl: string;
  token: string;
}

export function loadCloudConfig(storage: Storage = localStorage): SavedCloudConfig | undefined {
  const workerUrl = storage.getItem(WORKER_URL_KEY)?.trim();
  const token = storage.getItem(TOKEN_KEY) || '';
  return workerUrl && token ? { workerUrl, token } : undefined;
}

export function saveCloudConfig(config: SavedCloudConfig, storage: Storage = localStorage): void {
  storage.setItem(WORKER_URL_KEY, config.workerUrl.replace(/\/+$/, ''));
  storage.setItem(TOKEN_KEY, config.token);
}

export function clearCloudConfig(storage: Storage = localStorage): void {
  storage.removeItem(WORKER_URL_KEY);
  storage.removeItem(TOKEN_KEY);
}
