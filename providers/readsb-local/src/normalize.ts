import {
  isValidLatLon,
  stableStringify,
  type IsoTimestamp,
  type JsonValue,
  type Observation,
  type ProvenanceOrigin,
} from '@worldview/world-model';
import { buildObservation, type ObservationDraft, type ProviderManifest } from '@worldview/provider-sdk';

/**
 * Normalizer for readsb aircraft.json rows (`hex, flight, r, t, alt_baro ('ground'|ft),
 * alt_geom, gs (kt), track, baro_rate (ft/min), lat, lon, seen_pos, seen, category, squawk,
 * emergency, rssi, dbFlags`). Adapted from gods-eye-view src/sources/live/aircraft.js
 * `normalizeReadsbAircraft` (MIT).
 *
 * DUPLICATED ON PURPOSE: providers/adsb-remote/src/normalize.ts carries the same row rules
 * for adsb.lol (which serves readsb-shaped rows). Providers never import each other and the
 * provider-sdk contract is frozen, so the ~60 lines live twice. Keep both copies in step.
 */
export const FOOT_TO_M = 0.3048;
export const KNOT_TO_MPS = 0.514444;
export const FPM_TO_MPS = 0.00508;

/** Positions older than this (seconds since the last position message) are flagged. */
export const STALE_POSITION_SECONDS = 60;

export interface AircraftNormalizeOptions {
  /** Snapshot epoch (ms) that `seen` / `seen_pos` ages are relative to. */
  nowMs: number;
  receivedAt: IsoTimestamp;
  sourceQuality: 'crowdsourced' | 'authoritative';
  positionAccuracyM?: number;
  origin?: ProvenanceOrigin;
  sourceRef?: string;
  hash?: (input: string) => string;
}

export interface AircraftNormalizeResult {
  observations: Observation[];
  total: number;
  rejected: Array<{ index: number; reason: string }>;
}

const ICAO24 = /^[0-9a-f]{6}$/;
const NON_ICAO = /^~([0-9a-f]{6})$/;
const SQUAWK = /^[0-7]{4}$/;
const CATEGORY = /^[A-D][0-7]$/;

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function text(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
}

/** Normalize a list of aircraft rows against one manifest. Never throws; invalid rows are reported. */
export function normalizeAircraftRows(
  rows: unknown,
  manifest: ProviderManifest,
  opts: AircraftNormalizeOptions,
): AircraftNormalizeResult {
  const list = Array.isArray(rows) ? (rows as unknown[]) : [];
  const observations: Observation[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  const seen = new Set<string>();
  list.forEach((raw, index) => {
    const draft = aircraftRowToDraft(raw, opts);
    if (typeof draft === 'string') {
      rejected.push({ index, reason: draft });
      return;
    }
    if (seen.has(draft.externalId)) {
      rejected.push({ index, reason: `duplicate hex ${draft.externalId}` });
      return;
    }
    seen.add(draft.externalId);
    observations.push(buildObservation(manifest, opts.receivedAt, draft));
  });
  return { observations, total: list.length, rejected };
}

/** One row → observation draft, or a rejection reason. */
export function aircraftRowToDraft(raw: unknown, opts: AircraftNormalizeOptions): ObservationDraft | string {
  if (!raw || typeof raw !== 'object') return 'row not an object';
  const row = raw as Record<string, unknown>;
  const hexRaw = typeof row['hex'] === 'string' ? row['hex'].trim().toLowerCase() : '';
  const nonIcao = NON_ICAO.exec(hexRaw);
  const icao24 = ICAO24.test(hexRaw) ? hexRaw : undefined;
  if (!icao24 && !nonIcao) return 'invalid hex';
  const lat = row['lat'];
  const lon = row['lon'];
  if (!isValidLatLon(lat, lon)) return 'missing position';
  const seenPos = Math.max(0, num(row['seen_pos']) ?? 0);
  const observedMs = opts.nowMs - seenPos * 1000;
  if (!Number.isFinite(observedMs) || observedMs <= 0) return 'invalid snapshot time';

  const altBaro = row['alt_baro'];
  const onGround = typeof altBaro === 'string' && altBaro.trim().toLowerCase() === 'ground';
  const baroFt = num(altBaro);
  const geomFt = num(row['alt_geom']);
  const gs = num(row['gs']);
  const track = num(row['track']);
  const rate = num(row['baro_rate']);
  const seenAll = num(row['seen']);
  const dbFlags = num(row['dbFlags']) ?? 0;
  const positionType = text(row['type'], 16)?.toLowerCase();

  const payload: Record<string, JsonValue> = { onGround, military: (dbFlags & 1) === 1 };
  if (icao24) payload['icao24'] = icao24;
  const callsign = text(row['flight'], 12);
  if (callsign) payload['callsign'] = callsign;
  const registration = text(row['r'], 16);
  if (registration) payload['registration'] = registration;
  const typeCode = text(row['t'], 8);
  if (typeCode) payload['typeCode'] = typeCode.toUpperCase();
  const category = text(row['category'], 2)?.toUpperCase();
  if (category && CATEGORY.test(category)) payload['category'] = category;
  const squawk = text(row['squawk'], 4);
  if (squawk && SQUAWK.test(squawk)) payload['squawk'] = squawk;
  const emergency = text(row['emergency'], 16)?.toLowerCase();
  if (emergency) payload['emergency'] = emergency;
  if (gs !== undefined && gs >= 0) payload['speedMps'] = round(gs * KNOT_TO_MPS, 2);
  if (track !== undefined && track >= 0 && track <= 360) payload['headingDegrees'] = track % 360;
  if (rate !== undefined) payload['verticalSpeedMps'] = round(rate * FPM_TO_MPS, 2);
  if (geomFt !== undefined) payload['altitudeGeomM'] = round(geomFt * FOOT_TO_M, 1);
  if (seenAll !== undefined && seenAll >= 0) payload['seenSeconds'] = seenAll;
  payload['seenPositionSeconds'] = seenPos;
  const rssi = num(row['rssi']);
  if (rssi !== undefined && rssi <= 0) payload['rssiDb'] = rssi;

  const position: ObservationDraft['position'] = { latitude: lat, longitude: lon as number };
  if (onGround) {
    position.altitudeM = 0;
    position.altitudeDatum = 'ground';
  } else if (baroFt !== undefined) {
    position.altitudeM = round(baroFt * FOOT_TO_M, 1);
    position.altitudeDatum = 'barometric';
  }

  const flags: string[] = [];
  if (seenPos > STALE_POSITION_SECONDS) flags.push('stale-position');
  if (!icao24) flags.push('non-icao-address');
  if (positionType?.startsWith('mlat')) flags.push('mlat');
  if (positionType?.startsWith('tisb')) flags.push('tisb');
  if (emergency && emergency !== 'none') flags.push(`emergency:${emergency}`);

  const draft: ObservationDraft = {
    externalId: icao24 ?? `nonicao-${nonIcao![1]}`,
    objectType: 'aircraft',
    observedAt: new Date(observedMs).toISOString(),
    position,
    payload,
    quality: {
      complete: true,
      sourceQuality: opts.sourceQuality,
      ...(opts.positionAccuracyM !== undefined ? { positionAccuracyM: opts.positionAccuracyM } : {}),
      ...(flags.length ? { flags } : {}),
    },
    origin: opts.origin ?? 'live',
  };
  if (opts.sourceRef) draft.sourceRef = opts.sourceRef;
  if (opts.hash) draft.rawPayloadHash = opts.hash(stableStringify(raw as JsonValue));
  return draft;
}

/** readsb aircraft.json envelope: `{ now: <seconds>, messages, aircraft: [...] }`. */
export function parseReadsbAircraftJson(
  payload: unknown,
): { rows: unknown[]; nowMs: number; messages?: number } | string {
  if (!payload || typeof payload !== 'object') return 'aircraft.json is not an object';
  const body = payload as { aircraft?: unknown; now?: unknown; messages?: unknown };
  if (!Array.isArray(body.aircraft)) return 'aircraft.json has no "aircraft" array';
  const now = num(body.now);
  if (now === undefined || now <= 0) return 'aircraft.json has no "now" timestamp';
  const messages = num(body.messages);
  return { rows: body.aircraft, nowMs: Math.round(now * 1000), ...(messages !== undefined ? { messages } : {}) };
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
