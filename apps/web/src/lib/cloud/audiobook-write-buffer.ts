export interface AudiobookProgressValue {
  seconds: number;
  duration?: number;
  playbackRate?: number;
}

export interface BufferedAudiobookProgress extends AudiobookProgressValue {
  sequence: number;
  updatedAt: number;
}

export class AudiobookWriteBuffer {
  private sequence = 0;
  private lastTimestamp = 0;
  private pendingValue?: BufferedAudiobookProgress;
  private committedSignature?: string;

  reset(): void {
    this.sequence = 0;
    this.lastTimestamp = 0;
    this.pendingValue = undefined;
    this.committedSignature = undefined;
  }

  queue(value: AudiobookProgressValue, now = Date.now()): BufferedAudiobookProgress | undefined {
    if (!Number.isFinite(value.seconds)) return this.pendingValue;

    const normalized: AudiobookProgressValue = {
      seconds: Math.max(0, value.seconds),
      duration: Number.isFinite(value.duration) && Number(value.duration) > 0 ? Number(value.duration) : undefined,
      playbackRate:
        Number.isFinite(value.playbackRate) && Number(value.playbackRate) > 0
          ? Number(value.playbackRate)
          : undefined
    };
    const signature = audiobookProgressSignature(normalized);

    if (this.pendingValue && audiobookProgressSignature(this.pendingValue) === signature) {
      return this.pendingValue;
    }
    if (!this.pendingValue && this.committedSignature === signature) return undefined;

    this.lastTimestamp = Math.max(now, this.lastTimestamp + 1);
    this.pendingValue = {
      ...normalized,
      sequence: ++this.sequence,
      updatedAt: this.lastTimestamp
    };
    return this.pendingValue;
  }

  get pending(): BufferedAudiobookProgress | undefined {
    return this.pendingValue;
  }

  seedCommitted(value: AudiobookProgressValue | undefined): void {
    this.pendingValue = undefined;
    this.committedSignature = value ? audiobookProgressSignature(value) : undefined;
  }

  acknowledge(sequence: number): boolean {
    if (!this.pendingValue || this.pendingValue.sequence !== sequence) return false;
    this.committedSignature = audiobookProgressSignature(this.pendingValue);
    this.pendingValue = undefined;
    return true;
  }

  acknowledgeSent(value: BufferedAudiobookProgress): void {
    this.committedSignature = audiobookProgressSignature(value);
    if (this.pendingValue?.sequence === value.sequence) this.pendingValue = undefined;
  }

  discardPending(): void {
    this.pendingValue = undefined;
  }
}

export function audiobookProgressSignature(value: AudiobookProgressValue): string {
  return `${value.seconds}|${value.duration ?? ''}|${value.playbackRate ?? ''}`;
}
