import type { MemorySnapshot } from '@worldview/ipc-contract';

/**
 * Process memory, sampled every ten minutes, for Diagnostics and the application log.
 *
 * The QA checklist asks for "memory in Diagnostics is stable, not climbing" after thirty
 * minutes on the aviation lens, and Diagnostics had no memory at all: the check could not be
 * made. Electron's `app.getAppMetrics()` gives every process's working set (what the
 * operating system counts against the app, in KB); the main process's JavaScript heap comes
 * from `process.memoryUsage()`. The last six hours of totals are kept, so a leak shows as a
 * climb rather than as one large number.
 */

/** The parts of Electron's `ProcessMetric` this reads. */
export interface ProcessMetricLike {
  type: string;
  memory: { workingSetSize: number };
}

export const MEMORY_SAMPLE_MS = 10 * 60_000;
export const MEMORY_HISTORY = 36;

const mb = (kb: number) => Math.round((kb / 1024) * 10) / 10;

/** One sample from the process list: megabytes per process kind, largest first. */
export function summariseMetrics(
  metrics: readonly ProcessMetricLike[],
  mainHeapBytes: number,
  at: string,
): Omit<MemorySnapshot, 'history'> {
  const byType = new Map<string, { count: number; kb: number }>();
  for (const m of metrics) {
    const kb = Number.isFinite(m.memory?.workingSetSize) ? m.memory.workingSetSize : 0;
    const t = byType.get(m.type) ?? { count: 0, kb: 0 };
    t.count++;
    t.kb += kb;
    byType.set(m.type, t);
  }
  const processes = [...byType.entries()]
    .map(([type, t]) => ({ type, count: t.count, workingSetMB: mb(t.kb) }))
    .sort((a, b) => b.workingSetMB - a.workingSetMB || (a.type < b.type ? -1 : 1));
  const totalKb = [...byType.values()].reduce((n, t) => n + t.kb, 0);
  return {
    sampledAt: at,
    processes,
    totalMB: mb(totalKb),
    mainHeapMB: Math.round((mainHeapBytes / 1024 / 1024) * 10) / 10,
  };
}

export class MemoryMonitor {
  private readonly history: Array<{ at: string; totalMB: number }> = [];
  private last: Omit<MemorySnapshot, 'history'> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly deps: {
      metrics: () => readonly ProcessMetricLike[];
      heapUsed: () => number;
      now: () => number;
      log?: (fields: Record<string, number | string>) => void;
    },
  ) {}

  start(intervalMs = MEMORY_SAMPLE_MS): void {
    this.sample();
    this.timer = setInterval(() => this.sample(), intervalMs);
    if (typeof this.timer === 'object' && 'unref' in this.timer) (this.timer as { unref(): void }).unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Take a sample now: into the history, and into the log. */
  sample(): void {
    let metrics: readonly ProcessMetricLike[];
    try {
      metrics = this.deps.metrics();
    } catch {
      return;
    }
    const s = summariseMetrics(metrics, this.deps.heapUsed(), new Date(this.deps.now()).toISOString());
    this.last = s;
    this.history.push({ at: s.sampledAt, totalMB: s.totalMB });
    if (this.history.length > MEMORY_HISTORY) this.history.splice(0, this.history.length - MEMORY_HISTORY);
    const fields: Record<string, number | string> = { totalMB: s.totalMB, mainHeapMB: s.mainHeapMB };
    for (const p of s.processes.slice(0, 5)) fields[`${p.type.replace(/\W+/g, '').toLowerCase()}MB`] = p.workingSetMB;
    this.deps.log?.(fields);
  }

  /** The latest sample with the recent totals; a fresh one is read for the processes. */
  snapshot(): MemorySnapshot | undefined {
    let current = this.last;
    try {
      current = summariseMetrics(this.deps.metrics(), this.deps.heapUsed(), new Date(this.deps.now()).toISOString());
    } catch {
      // keep the last sample
    }
    if (!current) return undefined;
    return { ...current, history: [...this.history] };
  }
}
