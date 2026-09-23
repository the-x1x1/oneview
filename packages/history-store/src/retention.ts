import { ObjectTypes } from '@worldview/world-model';
import { retentionCapSeconds, type ProviderDataPolicy } from '@worldview/provider-sdk';
import type { HistoryRow } from './row.js';

/**
 * Retention (directive §34, ADR-005).
 *
 * A retention policy is per object type; a provider's ProviderDataPolicy can only
 * shorten it (retentionCapSeconds), never extend it. Movement types additionally
 * carry a tiered downsampling schedule applied to partitions once they are entirely
 * older than a tier boundary.
 */
export const INDEFINITE = 'indefinite' as const;
export type RetentionSeconds = number | typeof INDEFINITE;

export interface DownsampleTier {
  /** Applied to partitions whose newest row is at least this old (seconds). */
  afterSeconds: number;
  /** Keep every n-th point of each object's sequence (first and last are always kept). */
  keepEvery: number;
}

export interface RetentionPolicy {
  /** Total retention. 0 = never persisted (e.g. camera snapshots). */
  retainSeconds: RetentionSeconds;
  /** rawPayloadHash is kept only this long; stripped by the next rewrite past it. */
  rawSeconds?: number;
  /** Tiered track downsampling (movement types only). Tiers must be ordered by afterSeconds ascending. */
  downsample?: readonly DownsampleTier[];
}

const HOUR = 3600,
  DAY = 86_400;

/** 0–5 min full, 5–30 min every 3rd, 30 min–24 h (and beyond) every 10th. */
export const TRACK_DOWNSAMPLE_TIERS: readonly DownsampleTier[] = Object.freeze([
  { afterSeconds: 5 * 60, keepEvery: 3 },
  { afterSeconds: 30 * 60, keepEvery: 10 },
]);

export const DEFAULT_RETENTION_POLICIES: Readonly<Record<string, RetentionPolicy>> = Object.freeze({
  [ObjectTypes.Aircraft]: { retainSeconds: 30 * DAY, rawSeconds: 24 * HOUR, downsample: TRACK_DOWNSAMPLE_TIERS },
  [ObjectTypes.Vessel]: { retainSeconds: 30 * DAY, rawSeconds: 24 * HOUR, downsample: TRACK_DOWNSAMPLE_TIERS },
  [ObjectTypes.TransitVehicle]: { retainSeconds: 7 * DAY, rawSeconds: 24 * HOUR, downsample: TRACK_DOWNSAMPLE_TIERS },
  [ObjectTypes.Satellite]: { retainSeconds: 7 * DAY },
  [ObjectTypes.Earthquake]: { retainSeconds: INDEFINITE },
  [ObjectTypes.FireDetection]: { retainSeconds: 90 * DAY },
  [ObjectTypes.WeatherAlert]: { retainSeconds: 30 * DAY },
  [ObjectTypes.Storm]: { retainSeconds: 30 * DAY },
  [ObjectTypes.WeatherStation]: { retainSeconds: 30 * DAY },
  [ObjectTypes.Camera]: { retainSeconds: 0 },
  [ObjectTypes.TrafficSegment]: { retainSeconds: 7 * DAY },
  [ObjectTypes.Sensor]: { retainSeconds: 7 * DAY },
  [ObjectTypes.Launch]: { retainSeconds: 90 * DAY },
  [ObjectTypes.Infrastructure]: { retainSeconds: INDEFINITE },
  [ObjectTypes.Airport]: { retainSeconds: INDEFINITE },
  [ObjectTypes.Port]: { retainSeconds: INDEFINITE },
  [ObjectTypes.Place]: { retainSeconds: INDEFINITE },
});

export const FALLBACK_RETENTION_POLICY: RetentionPolicy = Object.freeze({ retainSeconds: 7 * DAY });

/** Provider ids whose rows are the user's own data (collections, notes, local sensors): kept indefinitely. */
export const USER_DATA_PROVIDER_IDS: readonly string[] = Object.freeze(['user', 'worldview-user', 'local-user']);

export type RetentionOverrides = Readonly<Record<string, Partial<RetentionPolicy>>>;

export function retentionPolicyFor(objectType: string, overrides?: RetentionOverrides): RetentionPolicy {
  const base = DEFAULT_RETENTION_POLICIES[objectType] ?? FALLBACK_RETENTION_POLICY;
  const o = overrides?.[objectType];
  return o ? { ...base, ...o } : base;
}

/**
 * Effective total retention for (objectType, provider): the type policy capped by the
 * provider's data policy. Returns 0 when nothing may be persisted. Providers without a
 * data policy are treated as "not allowed" — persistence must be opt-in by policy.
 */
export function effectiveRetentionSeconds(
  policy: RetentionPolicy,
  dataPolicy: ProviderDataPolicy | undefined,
  providerId?: string,
): RetentionSeconds {
  if (providerId !== undefined && USER_DATA_PROVIDER_IDS.includes(providerId)) return INDEFINITE;
  if (!dataPolicy) return 0;
  const requested = policy.retainSeconds === INDEFINITE ? undefined : policy.retainSeconds;
  const capped = retentionCapSeconds(dataPolicy, requested);
  return capped === undefined ? INDEFINITE : capped;
}

/** Index (1-based) of the coarsest tier whose boundary the age has passed; 0 = full resolution. */
export function tierForAge(policy: RetentionPolicy, ageSeconds: number): number {
  const tiers = policy.downsample ?? [];
  let tier = 0;
  for (let i = 0; i < tiers.length; i++) if (ageSeconds >= tiers[i]!.afterSeconds) tier = i + 1;
  return tier;
}

export interface DownsampleResult {
  rows: HistoryRow[];
  removed: number;
}

/**
 * Thin a partition's rows to `tier` (1-based). Deterministic and composable: each
 * object's rows are ordered by observedAt and numbered (`seq`, assigned once and
 * carried through later rewrites); a row survives tier t when its seq is a multiple of
 * keepEvery for tier t OR any coarser tier, so moving from tier 1 to tier 2 later
 * yields exactly "every keepEvery(tier 2)-th of the original", never a thinning of a
 * thinning. The first and last point of every object are always kept; rows with
 * origin 'user' are never removed.
 */
export function downsampleRows(rows: HistoryRow[], tiers: readonly DownsampleTier[], tier: number): DownsampleResult {
  if (tier <= 0 || tiers.length === 0) return { rows, removed: 0 };
  const keys = new Map<string, number>();
  const cols: ThinColumns = {
    length: rows.length,
    objectKey: new Int32Array(rows.length),
    time: new Float64Array(rows.length),
    seq: new Int32Array(rows.length),
    user: new Uint8Array(rows.length),
    tieBreak: (a, b) => (rows[a]!.observationId < rows[b]!.observationId ? -1 : 1),
  };
  rows.forEach((r, i) => {
    let k = keys.get(r.objectId);
    if (k === undefined) keys.set(r.objectId, (k = keys.size));
    cols.objectKey[i] = k;
    cols.time[i] = Date.parse(r.observedAt);
    cols.seq[i] = r.seq ?? -1;
    cols.user[i] = r.origin === 'user' ? 1 : 0;
  });
  const plan = planThinning(cols, tiers, tier);
  const out: HistoryRow[] = [];
  rows.forEach((r, i) => {
    r.seq = plan.seq[i]!;
    if (plan.keep[i]) out.push(r);
  });
  return { rows: out, removed: plan.removed };
}

/**
 * What thinning needs to know about a partition's rows, by row index, in columns — so a
 * large partition can be thinned without holding its rows: the NDJSON backend streams
 * the file once to fill these and once more to write the kept lines.
 */
export interface ThinColumns {
  length: number;
  /** The row's object, interned to a number. */
  objectKey: Int32Array;
  /** observedAt, epoch milliseconds. */
  time: Float64Array;
  /** The row's per-object ordinal from an earlier thinning, or −1. */
  seq: Int32Array;
  /** 1 for origin 'user': never removed. */
  user: Uint8Array;
  /** Order of two rows of one object at the same time; index order when absent. */
  tieBreak?: (a: number, b: number) => number;
}

export interface ThinPlan {
  /** 1 = keep the row at this index. */
  keep: Uint8Array;
  /** Every row's per-object ordinal (assigned on the first thinning, carried after); −1 when unnumbered. */
  seq: Int32Array;
  removed: number;
}

export function planThinning(cols: ThinColumns, tiers: readonly DownsampleTier[], tier: number): ThinPlan {
  const n = cols.length;
  const keep = new Uint8Array(n);
  const seq = new Int32Array(n);
  if (tier <= 0 || tiers.length === 0) {
    // Nothing thinned, nothing numbered: ordinals are only assigned by a real thinning.
    keep.fill(1);
    seq.set(cols.seq.subarray(0, n));
    return { keep, seq, removed: 0 };
  }
  const factors = tiers.slice(Math.min(tier, tiers.length) - 1).map((t) => Math.max(1, Math.floor(t.keepEvery)));
  const byObject = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const k = cols.objectKey[i]!;
    let list = byObject.get(k);
    if (!list) byObject.set(k, (list = []));
    list.push(i);
  }
  const tie = cols.tieBreak ?? ((a: number, b: number) => a - b);
  let removed = 0;
  for (const list of byObject.values()) {
    list.sort((a, b) => cols.time[a]! - cols.time[b]! || tie(a, b));
    // Ordinals are assigned once; rows already numbered keep theirs, late arrivals continue after the max.
    let next = 0;
    for (const i of list) if (cols.seq[i]! >= next) next = cols.seq[i]! + 1;
    for (const i of list) seq[i] = cols.seq[i]! >= 0 ? cols.seq[i]! : next++;
    const last = list.length - 1;
    list.forEach((i, k) => {
      const kept = k === 0 || k === last || cols.user[i] === 1 || factors.some((f) => seq[i]! % f === 0);
      if (kept) keep[i] = 1;
      else removed++;
    });
  }
  return { keep, seq, removed };
}

export function stripRawHash(rows: HistoryRow[]): number {
  let n = 0;
  for (const r of rows)
    if (r.rawPayloadHash !== undefined) {
      delete r.rawPayloadHash;
      n++;
    }
  return n;
}
