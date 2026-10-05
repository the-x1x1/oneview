import type { WorldGeometry } from './geo.js';
import type { IsoTimestamp } from './time.js';
import type { ObservationReference, Provenance } from './provenance.js';
import type { ConfidenceClass } from './confidence.js';
import type { JsonValue } from './json.js';

/**
 * WorldEvent — something that happened. Derived deterministically from observations
 * and objects by the event engine (rules-based correlation). Frozen contract.
 */
export type SeverityClass = 'INFO' | 'MINOR' | 'MODERATE' | 'SEVERE' | 'EXTREME';

export const SEVERITY_ORDER: Readonly<Record<SeverityClass, number>> = Object.freeze({
  INFO: 0,
  MINOR: 1,
  MODERATE: 2,
  SEVERE: 3,
  EXTREME: 4,
});

export interface WorldEvent {
  /** Deterministic: `event:<type>:<namespace>:<value>` e.g. `event:earthquake:usgs:us7000abcd`. */
  id: string;
  type: string;
  title: string;

  startAt: IsoTimestamp;
  endAt?: IsoTimestamp;

  geometry?: WorldGeometry;

  objectIds: string[];
  observationRefs: ObservationReference[];

  confidence: ConfidenceClass;
  severity?: SeverityClass;

  /** Short, factual, generated from known data only. */
  summary: string;

  /** Structured attributes (magnitude, depth, detection count, ...). */
  properties?: Record<string, JsonValue>;

  provenance: Provenance;
}

export const EventTypes = {
  Earthquake: 'earthquake',
  WildfireCluster: 'wildfire-cluster',
  WeatherAlert: 'weather-alert',
  /** A tropical cyclone, with the track of its advisory positions (event-engine stormRule). */
  Storm: 'storm',
  /** Unhealthy air at an air-quality sensor, one event per episode (event-engine airQualityRule). */
  AirQuality: 'air-quality',
  /** A sensor's or station's reading past a limit its source declares (event-engine readingLimitRule). */
  ReadingLimit: 'reading-limit',
  /** An aircraft broadcasting an emergency: squawk 7700/7600/7500 or its ADS-B status (event-engine aircraftEmergencyRule). */
  AircraftEmergency: 'aircraft-emergency',
  Launch: 'launch',
  SatelliteDecay: 'satellite-decay',
  WatchZoneEntry: 'watch-zone-entry',
  SourceStatusChange: 'source-status-change',
} as const;
export type EventType = (typeof EventTypes)[keyof typeof EventTypes];

export function makeEventId(type: string, namespace: string, value: string): string {
  return `event:${type}:${namespace}:${value}`;
}
