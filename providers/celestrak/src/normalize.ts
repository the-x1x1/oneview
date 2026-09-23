import { isValidLatLon, stableStringify, type JsonValue, type Observation } from '@worldview/world-model';
import { buildObservation, type ObservationDraft } from '@worldview/provider-sdk';
import { CELESTRAK_MANIFEST, ELEMENT_VALIDITY_MS } from './manifest.js';
import { orbitSummary, type GpElements } from './elements.js';
import type { Propagator } from './propagator.js';

export interface NormalizeOptions {
  /** ISO timestamp WORLDVIEW received the catalog (or ran the propagation). */
  receivedAt: string;
  /** Propagation instant (ms). */
  nowMs: number;
  propagator: Propagator;
  group: string;
  hash?: (input: string) => string;
  origin?: 'live' | 'cached' | 'historical' | 'recorded';
  sourceRef?: string;
  /** Element sets older than this are skipped (default 30 days). */
  maxElementAgeMs?: number;
  /**
   * Also propagate to `nowMs + leadMs` and carry it as `nextPosition` ([lat, lon, altM, atMs]):
   * where the satellite will be when the next poll comes, so the globe can move it there
   * continuously instead of in 15-second jumps. Both ends are SGP4, so drawing the chord
   * between them is off the true arc by ~0.2 km for a low orbit over 15 s.
   */
  leadMs?: number;
}

export interface NormalizeResult {
  observations: Observation[];
  total: number;
  rejected: Array<{ index: number; reason: string }>;
}

const DEFAULT_MAX_ELEMENT_AGE_MS = 30 * 24 * 3600_000;
const AGING_AFTER_MS = 3 * 24 * 3600_000;
const MAX_ALTITUDE_M = 100_000_000; // world-model position schema bound

/**
 * Propagate every element set to `nowMs` and emit one satellite observation each.
 * `observedAt` = element epoch (clamped to now), position = propagated state.
 */
/**
 * An element set's hash, once per element set rather than once per poll: the catalog is
 * fetched every couple of hours and propagated every 15 s, so the same objects come back
 * each time and a SHA-256 of each one's canonical JSON was being recomputed thousands of
 * times a minute to the same answer.
 */
const HASHES = new WeakMap<GpElements, { hash: (input: string) => string; value: string }>();
function elementsHash(e: GpElements, hash: (input: string) => string): string {
  const cached = HASHES.get(e);
  if (cached && cached.hash === hash) return cached.value;
  const value = hash(stableStringify(elementsToJson(e)));
  HASHES.set(e, { hash, value });
  return value;
}

export function normalizeElements(elements: GpElements[], opts: NormalizeOptions): NormalizeResult {
  const observations: Observation[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  const seen = new Set<number>();
  elements.forEach((e, index) => {
    if (seen.has(e.noradId)) {
      rejected.push({ index, reason: `duplicate NORAD id ${e.noradId}` });
      return;
    }
    const draft = elementsToDraft(e, opts);
    if (typeof draft === 'string') {
      rejected.push({ index, reason: draft });
      return;
    }
    seen.add(e.noradId);
    observations.push(buildObservation(CELESTRAK_MANIFEST, opts.receivedAt, draft));
  });
  return { observations, total: elements.length, rejected };
}

export function elementsToDraft(e: GpElements, opts: NormalizeOptions): ObservationDraft | string {
  const epochMs = Date.parse(e.epoch);
  if (!Number.isFinite(epochMs)) return 'invalid epoch';
  const age = opts.nowMs - epochMs;
  if (age > (opts.maxElementAgeMs ?? DEFAULT_MAX_ELEMENT_AGE_MS)) return 'element set too old to propagate';
  if (age < -ELEMENT_VALIDITY_MS) return 'element set epoch too far in the future';
  let state;
  try {
    state = opts.propagator.propagate(e, opts.nowMs);
  } catch {
    state = undefined;
  }
  if (!state) return 'propagation failed (decayed or invalid element set)';
  if (!isValidLatLon(state.latitude, state.longitude)) return 'propagated position invalid';
  if (!Number.isFinite(state.altitudeM) || state.altitudeM < 0 || state.altitudeM > MAX_ALTITUDE_M)
    return 'propagated altitude out of range';

  const orbit = orbitSummary(e);
  const payload: Record<string, JsonValue> = {
    name: e.name,
    noradId: e.noradId,
    epoch: e.epoch,
    meanMotion: e.meanMotion,
    eccentricity: e.eccentricity,
    inclination: e.inclination,
    raan: e.raan,
    argPerigee: e.argPerigee,
    meanAnomaly: e.meanAnomaly,
    periodMinutes: round(orbit.periodMinutes, 3),
    apogeeKm: round(orbit.apogeeKm, 1),
    perigeeKm: round(orbit.perigeeKm, 1),
    speedMps: round(state.speedMps, 1),
    group: opts.group,
    propagatedAt: new Date(opts.nowMs).toISOString(),
    propagator: opts.propagator.name,
  };
  if (e.intlDesignator) payload['intlDesignator'] = e.intlDesignator;
  if (e.line1) payload['line1'] = e.line1;
  if (e.line2) payload['line2'] = e.line2;
  if (e.bstar !== undefined) payload['bstar'] = e.bstar;
  if (e.classification) payload['classification'] = e.classification;
  if (state.headingDegrees !== undefined && Number.isFinite(state.headingDegrees))
    payload['headingDegrees'] = round(state.headingDegrees, 1);
  const next =
    opts.leadMs && opts.leadMs > 0 ? propagateSafely(opts.propagator, e, opts.nowMs + opts.leadMs) : undefined;
  if (next)
    payload['nextPosition'] = [
      round(next.latitude, 5),
      round(next.longitude, 5),
      Math.round(next.altitudeM),
      opts.nowMs + opts.leadMs!,
    ];

  const flags = ['propagated'];
  if (age > ELEMENT_VALIDITY_MS) flags.push('elements-expired');
  else if (age > AGING_AFTER_MS) flags.push('elements-aging');

  const draft: ObservationDraft = {
    externalId: String(e.noradId),
    objectType: 'satellite',
    observedAt: new Date(Math.min(epochMs, opts.nowMs)).toISOString(),
    position: {
      latitude: state.latitude,
      longitude: state.longitude,
      altitudeM: Math.round(state.altitudeM),
      altitudeDatum: 'orbit',
    },
    effectiveFrom: e.epoch,
    effectiveUntil: new Date(epochMs + ELEMENT_VALIDITY_MS).toISOString(),
    payload,
    quality: { complete: true, sourceQuality: 'authoritative', flags },
    origin: opts.origin ?? 'live',
  };
  if (opts.sourceRef) draft.sourceRef = opts.sourceRef;
  if (opts.hash) draft.rawPayloadHash = elementsHash(e, opts.hash);
  return draft;
}

function propagateSafely(propagator: Propagator, e: GpElements, atMs: number) {
  let state;
  try {
    state = propagator.propagate(e, atMs);
  } catch {
    return undefined;
  }
  if (!state || !isValidLatLon(state.latitude, state.longitude)) return undefined;
  if (!Number.isFinite(state.altitudeM) || state.altitudeM < 0 || state.altitudeM > MAX_ALTITUDE_M) return undefined;
  return state;
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Element sets are plain data; this keeps the JSON conversion explicit for hashing and caching. */
export function elementsToJson(e: GpElements): { [key: string]: JsonValue } {
  const out: { [key: string]: JsonValue } = {};
  for (const [k, v] of Object.entries(e)) if (v !== undefined) out[k] = v;
  return out;
}
