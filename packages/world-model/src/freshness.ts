import { ObjectTypes } from './observation.js';

/**
 * Freshness is provider/object-type specific. There is deliberately no global timeout.
 * A policy declares age thresholds (seconds) after which an object moves from
 * LIVE → RECENT → STALE. HISTORICAL is assigned by the timeline/replay layer for
 * objects loaded from history; UNKNOWN when observedAt is missing/invalid.
 */
export type FreshnessClass = 'LIVE' | 'RECENT' | 'STALE' | 'HISTORICAL' | 'UNKNOWN';

export interface FreshnessPolicy {
  /** Age (seconds) up to which the object counts as LIVE. */
  liveSeconds: number;
  /** Age (seconds) up to which the object counts as RECENT. Beyond → STALE. */
  recentSeconds: number;
  /** Age (seconds) after which the object is expired from live state (undefined = never auto-expire). */
  expireSeconds?: number;
}

/** Default policies per object type. Providers may override through their manifest refreshPolicy. */
export const DEFAULT_FRESHNESS_POLICIES: Readonly<Record<string, FreshnessPolicy>> = Object.freeze({
  [ObjectTypes.Aircraft]: { liveSeconds: 30, recentSeconds: 90, expireSeconds: 600 },
  [ObjectTypes.Vessel]: { liveSeconds: 180, recentSeconds: 900, expireSeconds: 3 * 3600 },
  [ObjectTypes.Satellite]: { liveSeconds: 15, recentSeconds: 120, expireSeconds: 7 * 24 * 3600 },
  [ObjectTypes.Earthquake]: { liveSeconds: 3600, recentSeconds: 24 * 3600 },
  [ObjectTypes.FireDetection]: { liveSeconds: 3 * 3600, recentSeconds: 24 * 3600, expireSeconds: 7 * 24 * 3600 },
  [ObjectTypes.Storm]: { liveSeconds: 1800, recentSeconds: 6 * 3600, expireSeconds: 48 * 3600 },
  [ObjectTypes.WeatherStation]: { liveSeconds: 1800, recentSeconds: 3 * 3600, expireSeconds: 24 * 3600 },
  [ObjectTypes.WeatherAlert]: { liveSeconds: 1800, recentSeconds: 6 * 3600, expireSeconds: 48 * 3600 },
  [ObjectTypes.Camera]: { liveSeconds: 120, recentSeconds: 1800 },
  [ObjectTypes.TransitVehicle]: { liveSeconds: 30, recentSeconds: 120, expireSeconds: 900 },
  [ObjectTypes.TrafficSegment]: { liveSeconds: 300, recentSeconds: 1800, expireSeconds: 3 * 3600 },
  [ObjectTypes.Infrastructure]: { liveSeconds: 365 * 24 * 3600, recentSeconds: 3 * 365 * 24 * 3600 },
  [ObjectTypes.Airport]: { liveSeconds: 365 * 24 * 3600, recentSeconds: 3 * 365 * 24 * 3600 },
  [ObjectTypes.Port]: { liveSeconds: 365 * 24 * 3600, recentSeconds: 3 * 365 * 24 * 3600 },
  [ObjectTypes.Place]: { liveSeconds: 365 * 24 * 3600, recentSeconds: 3 * 365 * 24 * 3600 },
  [ObjectTypes.Launch]: { liveSeconds: 3600, recentSeconds: 24 * 3600, expireSeconds: 30 * 24 * 3600 },
  [ObjectTypes.Sensor]: { liveSeconds: 60, recentSeconds: 600, expireSeconds: 24 * 3600 },
});

export const FALLBACK_FRESHNESS_POLICY: FreshnessPolicy = Object.freeze({ liveSeconds: 300, recentSeconds: 3600, expireSeconds: 24 * 3600 });

export function freshnessPolicyFor(objectType: string, overrides?: Readonly<Record<string, FreshnessPolicy>>): FreshnessPolicy {
  return overrides?.[objectType] ?? DEFAULT_FRESHNESS_POLICIES[objectType] ?? FALLBACK_FRESHNESS_POLICY;
}

/** Classify by age. `observedAtMs` NaN → UNKNOWN. */
export function classifyFreshness(observedAtMs: number, nowMs: number, policy: FreshnessPolicy): FreshnessClass {
  if (!Number.isFinite(observedAtMs)) return 'UNKNOWN';
  const age = (nowMs - observedAtMs) / 1000;
  if (age <= policy.liveSeconds) return 'LIVE';
  if (age <= policy.recentSeconds) return 'RECENT';
  return 'STALE';
}

export function isExpired(observedAtMs: number, nowMs: number, policy: FreshnessPolicy): boolean {
  if (policy.expireSeconds === undefined) return false;
  if (!Number.isFinite(observedAtMs)) return true;
  return (nowMs - observedAtMs) / 1000 > policy.expireSeconds;
}
