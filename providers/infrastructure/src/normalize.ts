import {
  isIsoTimestamp,
  isValidLatLon,
  stableStringify,
  type IsoTimestamp,
  type JsonValue,
  type Observation,
} from '@worldview/world-model';
import { buildObservation, type ObservationDraft, type ProviderManifest } from '@worldview/provider-sdk';
import { SEED_AIRPORTS_DATASET_DATE } from './manifest.js';

/**
 * Seed airports GeoJSON → airport observations.
 * Feature: Point geometry, properties { id, name, iata, icao, type, municipality, countryCode }.
 * The collection's `datasetDate` is the observation time (airports are long-lived facts).
 * externalId is the ICAO code; @worldview/identity joins airports authoritatively on it
 * as `airport:icao:<ICAO4>` (ADR-011), so the same airport from another source is one object.
 */
export interface AirportNormalizeOptions {
  receivedAt: IsoTimestamp;
  hash?: (input: string) => string;
  sourceRef?: string;
}

export interface AirportNormalizeResult {
  observations: Observation[];
  total: number;
  rejected: Array<{ index: number; reason: string }>;
  datasetDate: IsoTimestamp;
}

const ICAO = /^[A-Z0-9]{4}$/;
const IATA = /^[A-Z0-9]{3}$/;
const COUNTRY = /^[A-Z]{2}$/;
const AIRPORT_TYPES = new Set(['large_airport', 'medium_airport', 'small_airport', 'heliport', 'seaplane_base']);

function text(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
}

/** Codes are validated whole (never truncated into a different, valid-looking code). */
function code(v: unknown, re: RegExp): string | undefined {
  const t = typeof v === 'string' ? v.trim().toUpperCase() : '';
  return re.test(t) ? t : undefined;
}

/** Parse the collection; returns a reason string when the payload is not a FeatureCollection. */
export function normalizeAirportCollection(
  payload: unknown,
  manifest: ProviderManifest,
  opts: AirportNormalizeOptions,
): AirportNormalizeResult | string {
  if (!payload || typeof payload !== 'object' || (payload as { type?: unknown }).type !== 'FeatureCollection')
    return 'not a FeatureCollection';
  const collection = payload as { features?: unknown; datasetDate?: unknown };
  if (!Array.isArray(collection.features)) return 'FeatureCollection has no features array';
  const datasetDate = normalizeDatasetDate(collection.datasetDate);
  if (!datasetDate) return 'invalid datasetDate';
  const observations: Observation[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  const seen = new Set<string>();
  (collection.features as unknown[]).forEach((raw, index) => {
    const draft = airportFeatureToDraft(raw, datasetDate, opts);
    if (typeof draft === 'string') {
      rejected.push({ index, reason: draft });
      return;
    }
    if (seen.has(draft.externalId)) {
      rejected.push({ index, reason: `duplicate icao ${draft.externalId}` });
      return;
    }
    seen.add(draft.externalId);
    observations.push(buildObservation(manifest, opts.receivedAt, draft));
  });
  return { observations, total: collection.features.length, rejected, datasetDate };
}

export function normalizeDatasetDate(value: unknown): IsoTimestamp | undefined {
  if (value === undefined || value === null) return SEED_AIRPORTS_DATASET_DATE;
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  const iso = new Date(ms).toISOString();
  return isIsoTimestamp(iso) ? iso : undefined;
}

export function airportFeatureToDraft(
  raw: unknown,
  datasetDate: IsoTimestamp,
  opts: AirportNormalizeOptions,
): ObservationDraft | string {
  if (!raw || typeof raw !== 'object') return 'feature not an object';
  const f = raw as {
    type?: unknown;
    geometry?: { type?: unknown; coordinates?: unknown } | null;
    properties?: Record<string, unknown> | null;
  };
  const p = f.properties;
  if (!p || typeof p !== 'object') return 'missing properties';
  if (f.geometry?.type !== 'Point' || !Array.isArray(f.geometry.coordinates)) return 'missing point geometry';
  const [lon, lat] = f.geometry.coordinates as unknown[];
  if (!isValidLatLon(lat, lon)) return 'invalid coordinates';
  const icaoRaw = typeof p['icao'] === 'string' ? p['icao'].trim() : '';
  if (!ICAO.test(icaoRaw)) return 'invalid icao';
  const icao = icaoRaw;
  const name = text(p['name'], 120);
  if (!name) return 'missing name';
  const payload: Record<string, JsonValue> = { name, icao };
  const iata = code(p['iata'], IATA);
  if (iata) payload['iata'] = iata;
  const type = text(p['type'], 32);
  if (type && AIRPORT_TYPES.has(type)) payload['type'] = type;
  const municipality = text(p['municipality'], 80);
  if (municipality) payload['municipality'] = municipality;
  const countryCode = code(p['countryCode'], COUNTRY);
  if (countryCode) payload['countryCode'] = countryCode;
  const draft: ObservationDraft = {
    externalId: icao,
    objectType: 'airport',
    observedAt: datasetDate,
    position: { latitude: lat, longitude: lon as number },
    payload,
    quality: { complete: true, sourceQuality: 'authoritative', positionAccuracyM: 1000 },
    origin: 'local',
  };
  if (opts.sourceRef) draft.sourceRef = opts.sourceRef;
  if (opts.hash) draft.rawPayloadHash = opts.hash(stableStringify(raw as JsonValue));
  return draft;
}
