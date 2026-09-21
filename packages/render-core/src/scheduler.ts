/**
 * Frame scheduling shared by the renderer host and the adapters: presentation and
 * source updates are coalesced to at most one run per animation frame. The default
 * uses `requestAnimationFrame` when the host provides it and falls back to a timer
 * (Node tests, hidden windows). `ManualScheduler` drives frames explicitly in tests.
 */
export interface FrameScheduler {
  request(callback: (timestampMs: number) => void): number;
  cancel(handle: number): void;
  now(): number;
}

export function createFrameScheduler(frameMs = 16): FrameScheduler {
  const g = globalThis as { requestAnimationFrame?: (cb: (t: number) => void) => number; cancelAnimationFrame?: (h: number) => void; performance?: { now(): number } };
  const now = () => (g.performance ? g.performance.now() : Date.now());
  if (typeof g.requestAnimationFrame === 'function' && typeof g.cancelAnimationFrame === 'function') {
    const raf = g.requestAnimationFrame, caf = g.cancelAnimationFrame;
    return { request: (cb) => raf(cb), cancel: (h) => caf(h), now };
  }
  return {
    request: (cb) => { const h = setTimeout(() => cb(now()), frameMs); return Number(h); },
    cancel: (h) => clearTimeout(h),
    now,
  };
}

/** Test scheduler: callbacks run only when `flush()` is called. */
export class ManualScheduler implements FrameScheduler {
  private next = 1;
  private pending = new Map<number, (t: number) => void>();
  private time = 0;
  request(callback: (timestampMs: number) => void): number {
    const h = this.next++;
    this.pending.set(h, callback);
    return h;
  }
  cancel(handle: number): void { this.pending.delete(handle); }
  now(): number { return this.time; }
  get pendingCount(): number { return this.pending.size; }
  /** Run everything queued before this call (callbacks queued during flush run on the next flush). */
  flush(advanceMs = 16): number {
    this.time += advanceMs;
    const batch = [...this.pending.entries()];
    this.pending.clear();
    for (const [, cb] of batch) cb(this.time);
    return batch.length;
  }
}

/** Coalesce many `schedule()` calls into one callback per frame. */
export class FrameCoalescer {
  private handle: number | null = null;
  constructor(private readonly scheduler: FrameScheduler, private readonly run: (t: number) => void) {}
  schedule(): void {
    if (this.handle !== null) return;
    this.handle = this.scheduler.request((t) => { this.handle = null; this.run(t); });
  }
  get scheduled(): boolean { return this.handle !== null; }
  cancel(): void {
    if (this.handle !== null) this.scheduler.cancel(this.handle);
    this.handle = null;
  }
}
