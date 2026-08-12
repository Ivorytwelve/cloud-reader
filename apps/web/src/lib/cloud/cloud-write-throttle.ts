export type CloudWriteThrottleReason = 'minute' | 'daily' | 'temporary';

export interface CloudWriteThrottleState {
  reason: CloudWriteThrottleReason;
  blockedUntil: number;
  startedAt: number;
}

export interface CloudWriteThrottleEventDetail {
  state: CloudWriteThrottleState;
  message: string;
}

export const CLOUD_WRITE_THROTTLED_EVENT = 'ttu-cloud:write-throttled';
export const CLOUD_WRITE_RECOVERED_EVENT = 'ttu-cloud:write-recovered';

const STORAGE_KEY = 'ttu-cloud-write-throttle-v1';
const OLD_WORKER_MINUTE_BACKOFF_MS = 65_000;
const DAILY_RESET_GRACE_MS = 2_000;

let throttleState: CloudWriteThrottleState | undefined = loadPersistedState();

function storageAvailable(): boolean {
  return typeof localStorage !== 'undefined';
}

function loadPersistedState(): CloudWriteThrottleState | undefined {
  if (!storageAvailable()) return undefined;
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as Partial<CloudWriteThrottleState> | null;
    if (!parsed) return undefined;
    const blockedUntil = Number(parsed.blockedUntil);
    const startedAt = Number(parsed.startedAt);
    const reason = parsed.reason;
    if (
      !Number.isFinite(blockedUntil) ||
      !Number.isFinite(startedAt) ||
      (reason !== 'minute' && reason !== 'daily' && reason !== 'temporary')
    ) {
      return undefined;
    }
    return { reason, blockedUntil, startedAt };
  } catch {
    return undefined;
  }
}

function persistState(state: CloudWriteThrottleState | undefined): void {
  if (!storageAvailable()) return;
  try {
    if (state) localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Rate limiting still works in-memory when storage is unavailable.
  }
}

function emit(name: string, detail?: CloudWriteThrottleEventDetail): void {
  if (typeof document === 'undefined') return;
  document.dispatchEvent(new CustomEvent(name, { detail }));
}

function nextUtcMidnight(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1) + DAILY_RESET_GRACE_MS;
}

function asRecord(body: unknown): Record<string, unknown> | undefined {
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : undefined;
}

function getRateLimitMessage(body: unknown): string {
  const record = asRecord(body);
  return record?.error == null ? '' : String(record.error);
}

export function classifyCloudWriteRateLimit(
  body: unknown,
  now = Date.now(),
): CloudWriteThrottleState {
  const record = asRecord(body);
  const code = record?.code == null ? '' : String(record.code);
  const message = getRateLimitMessage(body).toLowerCase();
  const retryAt = Number(record?.retryAt);
  const retryAfterMs = Number(record?.retryAfterMs);

  const daily = code === 'WRITE_BUDGET_DAILY' || message.includes('daily cloud write budget');
  const reason: CloudWriteThrottleReason = daily ? 'daily' : code === 'WRITE_RATE_LIMIT_MINUTE' ? 'minute' : 'temporary';

  let blockedUntil: number;
  if (Number.isFinite(retryAt) && retryAt > now) {
    blockedUntil = retryAt;
  } else if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    blockedUntil = now + retryAfterMs;
  } else if (daily) {
    blockedUntil = nextUtcMidnight(now);
  } else {
    // Compatibility with Workers deployed before structured 429 responses.
    blockedUntil = now + OLD_WORKER_MINUTE_BACKOFF_MS;
  }

  return { reason, blockedUntil, startedAt: now };
}

export function cloudWriteThrottleMessage(state: CloudWriteThrottleState): string {
  if (state.reason === 'daily') {
    return 'Cloud sync paused — daily write limit reached. Reading can continue; cloud writes will retry automatically after the limit resets.';
  }
  return 'Cloud sync paused — too many requests. Reading can continue; cloud writes will retry automatically.';
}

export function getCloudWriteThrottleState(now = Date.now()): CloudWriteThrottleState | undefined {
  if (!throttleState || throttleState.blockedUntil <= now) return undefined;
  return { ...throttleState };
}

export function getCloudWriteRetryDelayMs(now = Date.now()): number {
  return Math.max(0, (throttleState?.blockedUntil || 0) - now);
}

export function noteCloudWriteRateLimit(body: unknown, now = Date.now()): CloudWriteThrottleState {
  const next = classifyCloudWriteRateLimit(body, now);
  const wasBlocked = !!throttleState && throttleState.blockedUntil > now;

  // Several requests may already be in flight when the first 429 arrives. Let
  // those responses extend the same breaker, but never shorten it or show a
  // stack of duplicate toasts.
  if (wasBlocked && throttleState) {
    const reason = throttleState.reason === 'daily' || next.reason === 'daily' ? 'daily' : throttleState.reason;
    throttleState = {
      reason,
      startedAt: Math.min(throttleState.startedAt, next.startedAt),
      blockedUntil: Math.max(throttleState.blockedUntil, next.blockedUntil),
    };
  } else {
    throttleState = next;
  }

  persistState(throttleState);
  if (!wasBlocked) {
    emit(CLOUD_WRITE_THROTTLED_EVENT, {
      state: { ...throttleState },
      message: cloudWriteThrottleMessage(throttleState),
    });
  }
  return { ...throttleState };
}

export function noteCloudWriteSuccess(now = Date.now()): void {
  if (!throttleState || throttleState.blockedUntil > now) return;
  throttleState = undefined;
  persistState(undefined);
  emit(CLOUD_WRITE_RECOVERED_EVENT);
}

// A rate limit is a shared Worker-side write budget, not a per-tab condition.
// Propagate it through localStorage so another open reader tab stops immediately.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return;
    const now = Date.now();
    const wasBlocked = !!throttleState && throttleState.blockedUntil > now;
    throttleState = loadPersistedState();
    const isBlocked = !!throttleState && throttleState.blockedUntil > now;

    if (!wasBlocked && isBlocked && throttleState) {
      emit(CLOUD_WRITE_THROTTLED_EVENT, {
        state: { ...throttleState },
        message: cloudWriteThrottleMessage(throttleState),
      });
    }
  });
}
