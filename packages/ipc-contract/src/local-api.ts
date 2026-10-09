/**
 * The local read-only API, version 1 (docs/adr/ADR-014-local-api.md, docs/cyberdeck M6): what
 * another program of the same user on this computer — Formicaria, later — may read from a running
 * WORLDVIEW. HTTP/1.1 GET over a Unix socket; JSON in every answer. Nothing can be changed
 * through it, nothing it answers is outside the data policies, and it is off unless the operator
 * turns it on.
 *
 *   GET /v1                 LocalApiIndex
 *   GET /v1/health          LocalApiHealth
 *   GET /v1/sources         LocalApiSources
 *   GET /v1/objects?…       LocalApiObjects   lat, lon, radiusKm (≤ 500), type, since, limit (≤ 500), cursor
 *   GET /v1/track?…         LocalApiTrack     id, from, to (≤ 24 h)
 *   GET /v1/offline         LocalApiOffline
 *   GET /v1/own-position    LocalApiOwnPosition   only when separately allowed
 *
 * Errors: `{ "error": { "code", "message" } }` with 400 (bad query), 403 (not allowed: a source
 * whose data may not leave the app, or own position not allowed), 404, 405 (not GET), 413
 * (request too large), 429 (more than 120 requests a minute), 503 (the app is shutting down).
 */

export const LOCAL_API_VERSION = 1;

export interface LocalApiError {
  error: {
    code: 'bad-request' | 'forbidden' | 'not-found' | 'method' | 'too-large' | 'rate-limited' | 'unavailable';
    message: string;
  };
}

export interface LocalApiIndex {
  api: 'worldview-local';
  version: 1;
  app: { version: string; channel: string; commit: string };
  endpoints: string[];
  /** Whether `/v1/own-position` will answer (the operator's separate permission). */
  ownPosition: boolean;
  limits: { maxObjects: number; maxRadiusKm: number; maxTrackHours: number; requestsPerMinute: number };
}

export interface LocalApiHealth {
  at: string;
  /** Everything shown is recorded or synthetic (demo mode): never live. */
  recorded: boolean;
  connection: { state: 'CONNECTED' | 'DEGRADED' | 'OFFLINE'; workOffline: boolean; networkOnline: boolean };
  sources: { live: number; total: number };
}

export interface LocalApiSource {
  providerId: string;
  name: string;
  locality: 'remote' | 'local' | 'bundled';
  enabled: boolean;
  status: string;
  /** Only for a readable source. */
  lastObservation?: string;
  /** Only for a readable source. */
  objectCount?: number;
  /** Whether this source's objects may be read through this API (its data policy allows export). */
  readable: boolean;
}

export interface LocalApiSources {
  at: string;
  sources: LocalApiSource[];
}

export interface LocalApiObject {
  id: string;
  type: string;
  position?: { latitude: number; longitude: number; altitudeM?: number };
  observedAt: string;
  freshness: string;
  labels: Record<string, string>;
  motion?: { speedMps?: number; headingDegrees?: number; verticalSpeedMps?: number };
  provenance: {
    providerId: string;
    sourceName: string;
    origin: string;
    attribution?: string;
    licenseId?: string;
    receivedAt: string;
  };
  /** Every source behind it (all of them allow export, or it is not listed). */
  sources: string[];
}

export interface LocalApiObjects {
  at: string;
  basis: 'live';
  recorded: boolean;
  /**
   * Only objects whose every source allows its data out of the app. Others are left out without
   * a trace — not even a count, which under a query's filters would say where they are.
   */
  objects: LocalApiObject[];
  /** Pass as `cursor` for the next page; absent on the last. */
  next?: string;
}

export interface LocalApiTrack {
  id: string;
  from: string;
  to: string;
  points: Array<{ at: string; latitude: number; longitude: number; altitudeM?: number; source?: string }>;
}

export interface LocalApiOffline {
  at: string;
  connection: 'CONNECTED' | 'DEGRADED' | 'OFFLINE';
  workOffline: boolean;
  capabilities: Record<string, boolean>;
  packs: Array<{ id: string; name: string; status: string }>;
  vaults: Array<{ label: string; state: string; freeBytes?: number }>;
}

export interface LocalApiOwnPosition {
  at: string;
  state: 'fix' | 'stale' | 'unknown-age' | 'no-fix' | 'manual' | 'not-gnss' | 'no-source';
  /** Present only with a position to give: never for NO FIX. */
  position?: { latitude: number; longitude: number; altitudeM?: number };
  fixAt?: string;
  satellites?: number;
  fixType?: '2D' | '3D';
  accuracyM?: number;
  source?: { providerId: string; node?: string };
}
