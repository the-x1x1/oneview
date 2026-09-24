import type { JsonValue, WorldObject, WorldQuery, WorldQueryResult } from '@worldview/world-model';
import { projectReadings, type ReadingPoint, type ReadingWindow } from './series.js';

/**
 * The existing `history.query` request (ipc-contract): objects as they were known at
 * `time.end`, each the latest observation within `time`. The projection reads a series
 * through it; nothing here opens a channel of its own.
 */
export type HistoryQuery = (query: WorldQuery) => Promise<WorldQueryResult<WorldObject>>;

/** The object whose readings are read, and what narrows the history query to it. */
export interface ReadingsTarget {
  objectId: string;
  objectType: string;
  /** The providers it came from (`sourceRefs`); the query is limited to them. */
  providerIds?: ReadonlyArray<string>;
  /** Where it is: the query is limited to a small circle around it (a station does not move). */
  position?: { latitude: number; longitude: number };
}

export interface ReadingsOptions {
  /** Instants sampled across the window (default 60, at most 240). */
  samples?: number;
  /** History requests in flight at once (default 4). */
  concurrency?: number;
  signal?: AbortSignal;
}

export interface ReadingsResult {
  series: Map<string, ReadingPoint[]>;
  window: ReadingWindow;
  /** The width of one sample: the finest spacing the result can show. */
  stepMs: number;
  /** Requests that failed; their slices are missing from the series. */
  failed: number;
}

export const DEFAULT_SAMPLES = 60;
export const MAX_SAMPLES = 240;
/** Radius of the circle a positioned object's queries are limited to. */
export const TARGET_RADIUS_M = 250;
/** Objects one slice may return; enough for a circle of stations, small enough to stay cheap. */
const SLICE_LIMIT = 2_000;

/**
 * `readings(objectId, keys, window)` over history: the window is cut into `samples` equal
 * slices and each slice asks `history.query` for the objects known at its end with the
 * slice as look-back, which returns the latest observation of each object inside the slice
 * (one more slice ends at the window's start). Keeping the target's gives one reading per
 * slice per key — the last one — so a series has at most `samples + 1` points and a slice
 * without an observation leaves a gap.
 *
 * What this cannot show is a slice's extremes: two readings in one slice come back as the
 * later one. The request that would return every observation of one object is the brief's
 * amendment request (a `history.readings` channel); `projectReadings` already handles its
 * rows, so only the reader changes when it lands.
 */
export async function readings(
  query: HistoryQuery,
  target: ReadingsTarget,
  keys: ReadonlyArray<string>,
  window: ReadingWindow,
  options: ReadingsOptions = {},
): Promise<ReadingsResult> {
  if (!(window.endMs > window.startMs)) throw new RangeError('readings: the window must end after it starts');
  const samples = Math.max(1, Math.min(MAX_SAMPLES, Math.floor(options.samples ?? DEFAULT_SAMPLES)));
  const concurrency = Math.max(1, Math.min(8, Math.floor(options.concurrency ?? 4)));
  const stepMs = (window.endMs - window.startMs) / samples;
  const base: WorldQuery = {
    objectTypes: [target.objectType],
    limit: SLICE_LIMIT,
    ...(target.providerIds?.length ? { providerIds: [...target.providerIds] } : {}),
    ...(target.position
      ? { region: { kind: 'circle', center: { ...target.position }, radiusM: TARGET_RADIUS_M } }
      : {}),
  };
  const found: Array<{ id: string; observedAt: string; properties: Readonly<Record<string, JsonValue>> }> = [];
  let failed = 0;
  let next = 0;
  // Slice 0 ends at the window's start, so a reading exactly there is read too; the
  // projection drops anything it returns from before the window.
  const slices = samples + 1;
  const worker = async () => {
    while (next < slices) {
      if (options.signal?.aborted) return;
      const i = next++;
      const end = window.startMs + stepMs * i;
      const start = end - stepMs;
      try {
        const result = await query({
          ...base,
          time: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
        });
        for (const o of result.items)
          if (o.id === target.objectId) found.push({ id: o.id, observedAt: o.observedAt, properties: o.properties });
      } catch {
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, slices) }, worker));
  if (options.signal?.aborted) throw abortError(options.signal);
  return { series: projectReadings(found, target.objectId, keys, window), window, stepMs, failed };
}

/**
 * The series grown by the object's current values: the history read is a snapshot of the
 * moment it was made, and a live object keeps reporting. Only a reading newer than the
 * series' last one and inside the window is added.
 */
export function withLatest(
  series: ReadonlyMap<string, ReadonlyArray<ReadingPoint>>,
  object: Pick<WorldObject, 'observedAt' | 'properties'>,
  window: ReadingWindow,
): Map<string, ReadingPoint[]> {
  const t = Date.parse(object.observedAt);
  const out = new Map<string, ReadingPoint[]>();
  for (const [key, points] of series) {
    const v = object.properties[key];
    const last = points[points.length - 1];
    const fits =
      typeof v === 'number' &&
      Number.isFinite(v) &&
      Number.isFinite(t) &&
      t >= window.startMs &&
      t <= window.endMs &&
      (!last || t > last[0]);
    out.set(key, fits ? [...points, [t, v] as const] : [...points]);
  }
  return out;
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error('readings: aborted');
}
