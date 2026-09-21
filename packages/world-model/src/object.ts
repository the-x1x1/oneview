import type { JsonValue } from './json.js';
import type { GeoPosition, WorldGeometry } from './geo.js';
import type { IsoTimestamp } from './time.js';
import type { ObservationReference, Provenance } from './provenance.js';
import type { FreshnessClass } from './freshness.js';

/**
 * WorldObject — an entity in the world, resolved from one or more observations.
 * Frozen contract (architecture-contract-v1).
 */
export interface WorldObject {
  /** Deterministic identity (see identifiers.ts): `aircraft:icao24:a1b2c3`. */
  id: string;
  type: string;

  /** Observations that currently support this object (bounded, most recent first). */
  sourceRefs: ObservationReference[];

  position?: GeoPosition;
  geometry?: WorldGeometry;

  motion?: {
    speedMps?: number;
    headingDegrees?: number;
    verticalSpeedMps?: number;
  };

  /** Most recent observedAt among sourceRefs. */
  observedAt: IsoTimestamp;
  /** Last time state changed (UTC ISO). */
  updatedAt: IsoTimestamp;
  /** After this time the object is expired from live state (per-type policy or source validity). */
  validUntil?: IsoTimestamp;

  freshness: FreshnessClass;
  /** Deterministic 0..1 score — see confidence.ts for the documented method. UI shows the class, not the number. */
  confidence: number;

  /** Short display strings (name, callsign, registration, ...). Never used as identity. */
  labels: Record<string, string>;
  /** Normalized attributes merged from observations (last-writer-wins per key, by observedAt). */
  properties: Record<string, JsonValue>;

  media?: WorldMedia[];
  links?: WorldLink[];

  provenance: Provenance;
}

export interface WorldMedia {
  kind: 'image' | 'stream' | 'snapshot' | 'audio';
  /** Capability reference resolved through the camera gateway or asset service — never a raw credentialed URL. */
  ref: string;
  label?: string;
  mimeType?: string;
}

export interface WorldLink {
  rel: 'source' | 'terms' | 'details' | 'related' | 'attribution';
  href: string;
  label?: string;
}
