import type { JsonValue } from './json.js';
import type { GeoPosition, WorldGeometry } from './geo.js';
import type { IsoTimestamp } from './time.js';
import type { Provenance } from './provenance.js';

/**
 * Canonical Observation — a single source measurement, normalized by a provider.
 * Frozen contract (architecture-contract-v1). Providers emit these; nothing else
 * in the system sees raw provider payloads.
 */
export interface Observation {
  /** Deterministic: `${providerId}:${externalId or hash}:${observedAt}` — see `observationId()`. */
  id: string;

  providerId: string;
  /** The provider's own identifier for the observed thing (icao24, mmsi, usgs event id, ...). */
  externalId?: string;

  /** Canonical object type this observation describes (see ObjectTypes). */
  objectType: string;

  /** When the phenomenon was observed by the source (UTC ISO). */
  observedAt: IsoTimestamp;
  /** When WORLDVIEW received it (UTC ISO). */
  receivedAt: IsoTimestamp;

  /** Validity window declared by the source (e.g. alerts, TLE epochs). */
  effectiveFrom?: IsoTimestamp;
  effectiveUntil?: IsoTimestamp;

  position?: GeoPosition;
  geometry?: WorldGeometry;

  /** Normalized, provider-independent attributes (see per-type payload conventions). */
  payload: Record<string, JsonValue>;

  quality: ObservationQuality;

  /** SHA-256 (hex) of the raw source record when raw retention is permitted; enables dedup/reproducibility. */
  rawPayloadHash?: string;

  provenance: Provenance;
}

export interface ObservationQuality {
  /** Source-reported or provider-estimated horizontal accuracy in metres. */
  positionAccuracyM?: number;
  /** Source declares the record as complete (true) or partial/interpolated (false). */
  complete: boolean;
  /** Provider-assigned source quality tier — deterministic per manifest, never LLM-assigned. */
  sourceQuality: 'authoritative' | 'crowdsourced' | 'derived' | 'unknown';
  /** Free-form structured flags (e.g. ["interpolated", "low-signal"]). */
  flags?: string[];
}

/**
 * Canonical object types for Release 1. Providers may emit additional types, but
 * lenses, rendering rules and freshness policies key off these strings.
 */
export const ObjectTypes = {
  Aircraft: 'aircraft',
  Vessel: 'vessel',
  Satellite: 'satellite',
  Earthquake: 'earthquake',
  FireDetection: 'fire-detection',
  Storm: 'storm',
  WeatherStation: 'weather-station',
  WeatherAlert: 'weather-alert',
  Camera: 'camera',
  TransitVehicle: 'transit-vehicle',
  TrafficSegment: 'traffic-segment',
  Infrastructure: 'infrastructure',
  Airport: 'airport',
  Port: 'port',
  Place: 'place',
  Launch: 'launch',
  Sensor: 'sensor',
} as const;
export type ObjectType = (typeof ObjectTypes)[keyof typeof ObjectTypes];

/** Deterministic observation id. */
export function observationId(providerId: string, externalId: string, observedAt: IsoTimestamp): string {
  return `${providerId}:${externalId}:${observedAt}`;
}
