export interface QuotaReservation {
  id: string;
  key: string;
  bookId: string;
  kind: string;
  newSize: number;
  oldSize: number;
  reservedBytes: number;
  createdAt: number;
  expiresAt: number;
  uploadId?: string;
  parts: Record<string, number>;
  uploadedBytes: number;
}

interface PendingCommit {
  id: string;
  key: string;
  delta: number;
  positiveApplied: number;
  startedAt: number;
}

interface QuotaStateData {
  initialized: boolean;
  usedBytes: number;
  reservations: Record<string, QuotaReservation>;
  pendingCommits: Record<string, PendingCommit>;
  minuteWindowStart: number;
  minuteReads: number;
  minuteWrites: number;
  dayKey: string;
  dayReads: number;
  dayWrites: number;
}

interface DurableStorageLike {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  setAlarm(timestamp: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
}

interface DurableStateLike {
  storage: DurableStorageLike;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

interface R2MultipartUploadLike {
  abort(): Promise<void>;
}

interface R2BucketLike {
  resumeMultipartUpload(key: string, uploadId: string): R2MultipartUploadLike;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ objects: Array<{ size: number }>; truncated: boolean; cursor?: string }>;
}

interface QuotaEnv {
  LIBRARY: R2BucketLike;
  MAX_STORAGE_BYTES?: string;
  MAX_WRITE_OPS_PER_DAY?: string;
  MAX_READ_OPS_PER_DAY?: string;
  MAX_WRITE_OPS_PER_MINUTE?: string;
  MAX_READ_OPS_PER_MINUTE?: string;
  MULTIPART_RESERVATION_TTL_SECONDS?: string;
}

const STATE_KEY = 'quota-state-v1';
const PENDING_COMMIT_RECONCILE_MS = 60 * 60 * 1000;

function defaultState(): QuotaStateData {
  return {
    initialized: false,
    usedBytes: 0,
    reservations: {},
    pendingCommits: {},
    minuteWindowStart: Date.now(),
    minuteReads: 0,
    minuteWrites: 0,
    dayKey: utcDayKey(Date.now()),
    dayReads: 0,
    dayWrites: 0,
  };
}

function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export class QuotaGuard {
  private readonly state: DurableStateLike;
  private readonly env: QuotaEnv;
  private data = defaultState();
  private readonly ready: Promise<void>;

  constructor(state: DurableStateLike, env: QuotaEnv) {
    this.state = state;
    this.env = env;
    this.ready = state.blockConcurrencyWhile(async () => {
      this.data = (await state.storage.get<QuotaStateData>(STATE_KEY)) || defaultState();
      this.normalizeCounters(Date.now());
    });
  }

  private get maxStorageBytes(): number {
    return positiveInt(this.env.MAX_STORAGE_BYTES, 9_500_000_000);
  }

  private get maxWriteOpsPerDay(): number {
    return positiveInt(this.env.MAX_WRITE_OPS_PER_DAY, 5_000);
  }

  private get maxReadOpsPerDay(): number {
    return positiveInt(this.env.MAX_READ_OPS_PER_DAY, 20_000);
  }

  private get maxWriteOpsPerMinute(): number {
    return positiveInt(this.env.MAX_WRITE_OPS_PER_MINUTE, 120);
  }

  private get maxReadOpsPerMinute(): number {
    return positiveInt(this.env.MAX_READ_OPS_PER_MINUTE, 600);
  }

  private get reservationTtlMs(): number {
    return positiveInt(this.env.MULTIPART_RESERVATION_TTL_SECONDS, 24 * 60 * 60) * 1000;
  }

  private normalizeCounters(now: number): void {
    if (now - this.data.minuteWindowStart >= 60_000) {
      this.data.minuteWindowStart = now;
      this.data.minuteReads = 0;
      this.data.minuteWrites = 0;
    }
    const day = utcDayKey(now);
    if (this.data.dayKey !== day) {
      this.data.dayKey = day;
      this.data.dayReads = 0;
      this.data.dayWrites = 0;
    }
  }

  private reservedBytes(): number {
    return Object.values(this.data.reservations).reduce((sum, item) => sum + item.reservedBytes, 0);
  }

  private async persist(): Promise<void> {
    await this.state.storage.put(STATE_KEY, this.data);
  }

  private async scheduleCleanup(): Promise<void> {
    const expiries = [
      ...Object.values(this.data.reservations).map((item) => item.expiresAt),
      ...Object.values(this.data.pendingCommits).map((item) => item.startedAt + PENDING_COMMIT_RECONCILE_MS),
    ];
    if (!expiries.length) {
      await this.state.storage.deleteAlarm();
      return;
    }
    await this.state.storage.setAlarm(Math.min(...expiries));
  }

  private status() {
    return {
      initialized: this.data.initialized,
      usedBytes: this.data.usedBytes,
      reservedBytes: this.reservedBytes(),
      projectedBytes: this.data.usedBytes + this.reservedBytes(),
      maxBytes: this.maxStorageBytes,
      remainingBytes: Math.max(0, this.maxStorageBytes - this.data.usedBytes - this.reservedBytes()),
      activeUploads: Object.keys(this.data.reservations).length,
      budgets: {
        readsToday: this.data.dayReads,
        maxReadsPerDay: this.maxReadOpsPerDay,
        writesToday: this.data.dayWrites,
        maxWritesPerDay: this.maxWriteOpsPerDay,
      },
    };
  }

  private consumeBudget(kind: 'read' | 'write', cost: number): Response {
    const now = Date.now();
    this.normalizeCounters(now);
    const safeCost = Math.max(1, Math.min(100, Math.floor(cost || 1)));

    if (kind === 'write') {
      if (this.data.minuteWrites + safeCost > this.maxWriteOpsPerMinute) {
        return json({ error: 'Upload/write rate limit reached. Try again in a minute.' }, 429);
      }
      if (this.data.dayWrites + safeCost > this.maxWriteOpsPerDay) {
        return json({ error: 'Daily cloud write budget reached. Try again after 00:00 UTC.' }, 429);
      }
      this.data.minuteWrites += safeCost;
      this.data.dayWrites += safeCost;
    } else {
      if (this.data.minuteReads + safeCost > this.maxReadOpsPerMinute) {
        return json({ error: 'Cloud read rate limit reached. Try again in a minute.' }, 429);
      }
      if (this.data.dayReads + safeCost > this.maxReadOpsPerDay) {
        return json({ error: 'Daily cloud read budget reached. Try again after 00:00 UTC.' }, 429);
      }
      this.data.minuteReads += safeCost;
      this.data.dayReads += safeCost;
    }

    return json({ ok: true });
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'GET' && path === '/status') {
      this.normalizeCounters(Date.now());
      return json(this.status());
    }

    if (request.method === 'POST' && path === '/initialize') {
      const body = (await request.json()) as { usedBytes?: number };
      if (!this.data.initialized) {
        const usedBytes = Number(body.usedBytes);
        if (!Number.isSafeInteger(usedBytes) || usedBytes < 0) return json({ error: 'Invalid usedBytes' }, 400);
        this.data.usedBytes = usedBytes;
        this.data.initialized = true;
        await this.persist();
      }
      return json(this.status());
    }

    if (request.method === 'POST' && path === '/consume') {
      const body = (await request.json()) as { kind?: 'read' | 'write'; cost?: number };
      if (body.kind !== 'read' && body.kind !== 'write') return json({ error: 'Invalid budget kind' }, 400);
      const response = this.consumeBudget(body.kind, Number(body.cost || 1));
      if (response.ok) await this.persist();
      return response;
    }

    if (request.method === 'POST' && path === '/reserve') {
      const body = (await request.json()) as {
        id?: string;
        key?: string;
        bookId?: string;
        kind?: string;
        newSize?: number;
        oldSize?: number;
      };
      const newSize = Number(body.newSize);
      const oldSize = Number(body.oldSize || 0);
      if (!body.id || !body.key || !body.bookId || !body.kind) return json({ error: 'Invalid reservation' }, 400);
      if (!Number.isSafeInteger(newSize) || newSize < 0 || !Number.isSafeInteger(oldSize) || oldSize < 0) {
        return json({ error: 'Invalid reservation size' }, 400);
      }
      if (this.data.reservations[body.id] || this.data.pendingCommits[body.id]) {
        return json({ error: 'Duplicate reservation id' }, 409);
      }
      const keyBusy =
        Object.values(this.data.reservations).some((item) => item.key === body.key) ||
        Object.values(this.data.pendingCommits).some((item) => item.key === body.key);
      if (keyBusy) return json({ error: 'Another upload for this asset is already in progress' }, 409);

      const reservedBytes = Math.max(0, newSize - oldSize);
      const projected = this.data.usedBytes + this.reservedBytes() + reservedBytes;
      if (projected > this.maxStorageBytes) {
        return json(
          {
            error: 'Cloud storage hard limit reached',
            maxBytes: this.maxStorageBytes,
            usedBytes: this.data.usedBytes,
            reservedBytes: this.reservedBytes(),
            requestedBytes: reservedBytes,
          },
          507,
        );
      }

      const now = Date.now();
      this.data.reservations[body.id] = {
        id: body.id,
        key: body.key,
        bookId: body.bookId,
        kind: body.kind,
        newSize,
        oldSize,
        reservedBytes,
        createdAt: now,
        expiresAt: now + this.reservationTtlMs,
        parts: {},
        uploadedBytes: 0,
      };
      await this.persist();
      await this.scheduleCleanup();
      return json(this.data.reservations[body.id]);
    }

    if (request.method === 'POST' && path === '/bind-upload') {
      const body = (await request.json()) as { id?: string; uploadId?: string };
      const reservation = body.id ? this.data.reservations[body.id] : undefined;
      if (!reservation || !body.uploadId) return json({ error: 'Reservation not found' }, 404);
      reservation.uploadId = body.uploadId;
      await this.persist();
      return json({ ok: true });
    }

    if (request.method === 'POST' && path === '/record-part') {
      const body = (await request.json()) as { uploadId?: string; partNumber?: number; size?: number };
      const reservation = Object.values(this.data.reservations).find((item) => item.uploadId === body.uploadId);
      const partNumber = Number(body.partNumber);
      const size = Number(body.size);
      if (!reservation) return json({ error: 'Upload reservation not found or expired' }, 410);
      if (!Number.isInteger(partNumber) || partNumber < 1 || !Number.isSafeInteger(size) || size < 0) {
        return json({ error: 'Invalid part' }, 400);
      }
      const previous = reservation.parts[String(partNumber)] || 0;
      const nextTotal = reservation.uploadedBytes - previous + size;
      if (nextTotal > reservation.newSize) {
        return json({ error: 'Uploaded bytes exceed declared file size' }, 413);
      }
      reservation.parts[String(partNumber)] = size;
      reservation.uploadedBytes = nextTotal;
      reservation.expiresAt = Date.now() + this.reservationTtlMs;
      await this.persist();
      await this.scheduleCleanup();
      return json({ uploadedBytes: nextTotal, expectedBytes: reservation.newSize });
    }

    if (request.method === 'POST' && path === '/prepare-commit') {
      const body = (await request.json()) as { id?: string; uploadId?: string; requireExactUploadedBytes?: boolean };
      const reservation = body.id
        ? this.data.reservations[body.id]
        : Object.values(this.data.reservations).find((item) => item.uploadId === body.uploadId);
      if (!reservation) return json({ error: 'Reservation not found or expired' }, 410);
      if (body.requireExactUploadedBytes && reservation.uploadedBytes !== reservation.newSize) {
        return json(
          { error: 'Multipart upload size does not match declared file size', uploadedBytes: reservation.uploadedBytes, expectedBytes: reservation.newSize },
          409,
        );
      }

      const delta = reservation.newSize - reservation.oldSize;
      const positiveApplied = Math.max(0, delta);
      if (positiveApplied > 0) this.data.usedBytes += positiveApplied;
      this.data.pendingCommits[reservation.id] = {
        id: reservation.id,
        key: reservation.key,
        delta,
        positiveApplied,
        startedAt: Date.now(),
      };
      delete this.data.reservations[reservation.id];
      await this.persist();
      await this.scheduleCleanup();
      return json({ id: reservation.id, delta });
    }

    if (request.method === 'POST' && path === '/finalize-commit') {
      const body = (await request.json()) as { id?: string };
      const pending = body.id ? this.data.pendingCommits[body.id] : undefined;
      if (!pending) return json({ error: 'Pending commit not found' }, 404);
      if (pending.delta < 0) this.data.usedBytes = Math.max(0, this.data.usedBytes + pending.delta);
      delete this.data.pendingCommits[pending.id];
      await this.persist();
      await this.scheduleCleanup();
      return json(this.status());
    }

    if (request.method === 'POST' && path === '/rollback-commit') {
      const body = (await request.json()) as { id?: string };
      const pending = body.id ? this.data.pendingCommits[body.id] : undefined;
      if (!pending) return json({ ok: true });
      if (pending.positiveApplied > 0) this.data.usedBytes = Math.max(0, this.data.usedBytes - pending.positiveApplied);
      delete this.data.pendingCommits[pending.id];
      await this.persist();
      await this.scheduleCleanup();
      return json(this.status());
    }

    if (request.method === 'POST' && path === '/release') {
      const body = (await request.json()) as { id?: string; uploadId?: string };
      const reservation = body.id
        ? this.data.reservations[body.id]
        : Object.values(this.data.reservations).find((item) => item.uploadId === body.uploadId);
      if (reservation) {
        delete this.data.reservations[reservation.id];
        await this.persist();
        await this.scheduleCleanup();
      }
      return json(this.status());
    }

    if (request.method === 'POST' && path === '/adjust-used') {
      const body = (await request.json()) as { delta?: number };
      const delta = Number(body.delta);
      if (!Number.isSafeInteger(delta)) return json({ error: 'Invalid delta' }, 400);
      this.data.usedBytes = Math.max(0, this.data.usedBytes + delta);
      await this.persist();
      return json(this.status());
    }

    return json({ error: 'Not found' }, 404);
  }

  async alarm(): Promise<void> {
    await this.ready;
    const now = Date.now();
    let changed = false;
    for (const reservation of Object.values(this.data.reservations)) {
      if (reservation.expiresAt > now) continue;
      if (reservation.uploadId) {
        try {
          await this.env.LIBRARY.resumeMultipartUpload(reservation.key, reservation.uploadId).abort();
        } catch {
          // It may already be complete/aborted. The reservation still expires.
        }
      }
      delete this.data.reservations[reservation.id];
      changed = true;
    }

    const stalePending = Object.values(this.data.pendingCommits).some(
      (item) => item.startedAt + PENDING_COMMIT_RECONCILE_MS <= now,
    );
    if (stalePending) {
      let usedBytes = 0;
      let cursor: string | undefined;
      do {
        const result = await this.env.LIBRARY.list({ prefix: 'books/', cursor, limit: 1000 });
        usedBytes += result.objects.reduce((sum, object) => sum + object.size, 0);
        cursor = result.truncated ? result.cursor : undefined;
      } while (cursor);
      this.data.usedBytes = usedBytes;
      this.data.pendingCommits = {};
      changed = true;
    }

    if (changed) await this.persist();
    await this.scheduleCleanup();
  }
}
