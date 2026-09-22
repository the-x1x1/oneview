import { systemClock, type Clock, type IsoTimestamp, type TimeRange, type WorldObject } from '@worldview/world-model';
import type { TimelineMode, TimelineState } from '@worldview/ipc-contract';
import type { TypeAvailability } from './backend.js';
import type { SnapshotOptions } from './store.js';

/**
 * TimelineController — LIVE | PAUSED | REPLAY | HISTORICAL over a HistoryStore.
 *
 *   LIVE        cursor follows the wall clock; the world is the live state
 *   PAUSED      cursor frozen where it was
 *   REPLAY      cursor advances by `speed` × real time; reaching now jumps to LIVE
 *   HISTORICAL  cursor placed by the user (scrubbing); frozen until changed
 *
 * The controller reports availability straight from partition metadata and never
 * invents ranges; a snapshot at a cursor with no partitions is simply empty.
 */
export type TimelineSpeed = TimelineState['speed'];
export const TIMELINE_SPEEDS: readonly TimelineSpeed[] = Object.freeze([0.25, 1, 5, 20, 60]);

export interface TimelineHistory {
  availability(objectTypes?: string[]): Promise<TypeAvailability[]>;
  snapshotAt(cursor: IsoTimestamp, opts?: SnapshotOptions): Promise<WorldObject[]>;
}

export interface TimelineControllerOptions {
  history: TimelineHistory;
  clock?: Clock;
  /** Initial visible range length (seconds) ending at now. Default 24 h. */
  rangeSeconds?: number;
  /** Object types the availability strip reports (undefined = every type with data). */
  objectTypes?: string[];
  onChange?: (state: TimelineState) => void;
}

export type TimelineUpdate = Partial<Pick<TimelineState, 'mode' | 'cursor' | 'speed' | 'range'>>;

export class TimelineController {
  private readonly history: TimelineHistory;
  private readonly clock: Clock;
  private readonly objectTypes: string[] | undefined;
  private readonly listeners = new Set<(state: TimelineState) => void>();
  private mode: TimelineMode = 'LIVE';
  private cursorMs: number;
  private speed: TimelineSpeed = 1;
  private range: TimeRange;
  private availabilityCache: TypeAvailability[] = [];
  private lastTickMs: number | undefined;

  constructor(opts: TimelineControllerOptions) {
    this.history = opts.history;
    this.clock = opts.clock ?? systemClock;
    this.objectTypes = opts.objectTypes;
    const now = this.clock.now();
    this.cursorMs = now;
    this.range = {
      start: new Date(now - (opts.rangeSeconds ?? 86_400) * 1000).toISOString(),
      end: new Date(now).toISOString(),
    };
    if (opts.onChange) this.listeners.add(opts.onChange);
  }

  onChange(listener: (state: TimelineState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  state(): TimelineState {
    return {
      mode: this.mode,
      cursor: new Date(this.cursorMs).toISOString(),
      speed: this.speed,
      range: { ...this.range },
      availability: this.availabilityCache.map((a) => ({
        objectType: a.objectType,
        ranges: a.ranges.map((r) => ({ ...r })),
      })),
    };
  }

  get cursor(): IsoTimestamp {
    return new Date(this.cursorMs).toISOString();
  }
  get currentMode(): TimelineMode {
    return this.mode;
  }

  /** Serves `timeline.set`. Invalid speeds/cursors are rejected with an Error (the IPC layer maps it to INVALID_REQUEST). */
  set(update: TimelineUpdate): TimelineState {
    if (update.speed !== undefined) {
      if (!TIMELINE_SPEEDS.includes(update.speed)) throw new Error(`invalid timeline speed ${String(update.speed)}`);
      this.speed = update.speed;
    }
    if (update.range !== undefined) {
      const s = Date.parse(update.range.start),
        e = Date.parse(update.range.end);
      if (!Number.isFinite(s) || !Number.isFinite(e) || s > e) throw new Error('invalid timeline range');
      this.range = { start: new Date(s).toISOString(), end: new Date(e).toISOString() };
    }
    if (update.cursor !== undefined) {
      const c = Date.parse(update.cursor);
      if (!Number.isFinite(c)) throw new Error(`invalid timeline cursor "${update.cursor}"`);
      this.cursorMs = Math.min(c, this.clock.now());
      if (update.mode === undefined && this.mode === 'LIVE') this.mode = 'HISTORICAL';
    }
    if (update.mode !== undefined) {
      switch (update.mode) {
        case 'LIVE':
          this.cursorMs = this.clock.now();
          break;
        case 'PAUSED':
        case 'HISTORICAL':
          break;
        case 'REPLAY':
          this.lastTickMs = this.clock.now();
          break;
      }
      this.mode = update.mode;
    }
    return this.emit();
  }

  pause(): TimelineState {
    return this.set({ mode: 'PAUSED' });
  }

  play(speed?: TimelineSpeed): TimelineState {
    return this.set({ mode: 'REPLAY', ...(speed !== undefined ? { speed } : {}) });
  }

  jumpToLive(): TimelineState {
    const now = this.clock.now();
    if (Date.parse(this.range.end) < now) {
      const len = Date.parse(this.range.end) - Date.parse(this.range.start);
      this.range = { start: new Date(now - len).toISOString(), end: new Date(now).toISOString() };
    }
    this.lastTickMs = undefined;
    return this.set({ mode: 'LIVE' });
  }

  /**
   * Advance the cursor. `realNowMs` is wall-clock time (tests pass a virtual clock).
   * REPLAY moves by elapsed × speed; catching up with now switches to LIVE.
   * Returns the new state when something changed, otherwise undefined.
   */
  tick(realNowMs: number = this.clock.now()): TimelineState | undefined {
    const last = this.lastTickMs;
    this.lastTickMs = realNowMs;
    switch (this.mode) {
      case 'LIVE': {
        if (this.cursorMs === realNowMs) return undefined;
        this.cursorMs = realNowMs;
        return this.emit();
      }
      case 'REPLAY': {
        if (last === undefined) return undefined;
        const elapsed = Math.max(0, realNowMs - last);
        if (elapsed === 0) return undefined;
        const next = this.cursorMs + elapsed * this.speed;
        if (next >= realNowMs) {
          this.cursorMs = realNowMs;
          this.mode = 'LIVE';
        } else this.cursorMs = next;
        return this.emit();
      }
      case 'PAUSED':
      case 'HISTORICAL':
        return undefined;
    }
  }

  /** Refresh availability from the store (partition metadata) and emit if it changed. */
  async refreshAvailability(): Promise<TypeAvailability[]> {
    const next = await this.history.availability(this.objectTypes);
    const changed = JSON.stringify(next) !== JSON.stringify(this.availabilityCache);
    this.availabilityCache = next;
    if (changed) this.emit();
    return next;
  }

  availability(): TypeAvailability[] {
    return this.availabilityCache;
  }

  /** Objects as known at the cursor (or an explicit time). Always HISTORICAL freshness. */
  snapshotAt(cursor: IsoTimestamp = this.cursor, opts?: SnapshotOptions): Promise<WorldObject[]> {
    return this.history.snapshotAt(cursor, opts);
  }

  private emit(): TimelineState {
    const s = this.state();
    for (const l of [...this.listeners]) {
      try {
        l(s);
      } catch (err) {
        queueMicrotask(() => {
          throw err;
        });
      }
    }
    return s;
  }
}
