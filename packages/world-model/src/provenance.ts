import type { IsoTimestamp } from './time.js';

/**
 * Provenance travels with every observation, object and event. It answers:
 * where did this come from, when, under which terms, and is it live, cached,
 * historical, recorded (demo) or local.
 */
export type ProvenanceOrigin = 'live' | 'cached' | 'historical' | 'recorded' | 'local' | 'derived' | 'user';

export interface Provenance {
  /** Provider id (manifest.id) that produced the data, or 'worldview' for derived data. */
  providerId: string;
  /** Human-readable source name for attribution (e.g. "USGS Earthquake Hazards Program"). */
  sourceName: string;
  origin: ProvenanceOrigin;
  /** Endpoint, file or device that produced the data. Never contains secrets. */
  sourceRef?: string;
  /** Attribution text required by the data policy (rendered in Data & Attribution). */
  attribution?: string;
  licenseId?: string;
  termsUrl?: string;
  /** When WORLDVIEW received the data (UTC ISO). */
  receivedAt: IsoTimestamp;
  /** Provenance of inputs for derived data (events, correlations). */
  derivedFrom?: ObservationReference[];
}

/** Pointer from an object/event back to the observations that support it. */
export interface ObservationReference {
  observationId: string;
  providerId: string;
  observedAt: IsoTimestamp;
}
