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
  const factors = tiers.slice(Math.min(tier, tiers.length) - 1).map((t) => Math.max(1, Math.floor(t.keepEvery)));
  const byObject = new Map<string, HistoryRow[]>();
  for (const r of rows) {
    let list = byObject.get(r.objectId);
    if (!list) {
      list = [];
      byObject.set(r.objectId, list);
    }
    list.push(r);
  }
  const out: HistoryRow[] = [];
  let removed = 0;
  for (const list of byObject.values()) {
    list.sort((a, b) =>
      a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : a.observationId < b.observationId ? -1 : 1,
    );
    assignSeq(list);
    const last = list.length - 1;
    list.forEach((r, i) => {
      const seq = r.seq ?? i;
      const keep = i === 0 || i === last || r.origin === 'user' || factors.some((f) => seq % f === 0);
      if (keep) out.push(r);
      else removed++;
    });
  }
  return { rows: out, removed };
}

/** Assign per-object ordinals once; rows already numbered keep their seq, late arrivals continue after the max. */
function assignSeq(sorted: HistoryRow[]): void {
  let next = 0;
  for (const r of sorted) if (r.seq !== undefined && r.seq >= next) next = r.seq + 1;
  for (const r of sorted) if (r.seq === undefined) r.seq = next++;
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
