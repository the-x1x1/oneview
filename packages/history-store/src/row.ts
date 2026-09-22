import {
  geometryCentroid,
  isIsoTimestamp,
  isValidLatLon,
  type IsoTimestamp,
  type JsonValue,
  type Observation,
  type ObservationQuality,
  type ProvenanceOrigin,
  type WorldGeometry,
} from '@worldview/world-model';

/**
 * HistoryRow — the flat, backend-neutral record persisted for every observation.
 *
 * The first block is the frozen minimum (ADR-005); the second block holds optional
 * columns that make replay faithful (external id for identity resolution, geometry
 * for non-point observations, the source quality tier) and the downsampling ordinal.
 * Every column is JSON-serialisable so a row is one NDJSON line or one Parquet row.
 * Timestamps are normalised to millisecond-precision UTC ISO so that lexicographic
 * order equals chronological order in every backend.
 */
export interface HistoryRow {
  observationId: string;
  objectId: string;
  providerId: string;
  objectType: string;
  observedAt: IsoTimestamp;
  receivedAt: IsoTimestamp;
  lat?: number;
  lon?: number;
  altitudeM?: number;
  payloadJson: string;
  /** Present only when the provider's data policy allows raw payload retention. */
  rawPayloadHash?: string;
  origin: ProvenanceOrigin;

  externalId?: string;
  /** GeoJSON geometry (stringified) for observations that carry geometry. */
  geometryJson?: string;
  sourceQuality?: ObservationQuality['sourceQuality'];
  /** Per-object ordinal inside its partition, assigned by the first downsampling rewrite. */
  seq?: number;
}

export const HISTORY_ROW_COLUMNS = [
  'observationId',
  'objectId',
  'providerId',
  'objectType',
  'observedAt',
  'receivedAt',
  'lat',
  'lon',
  'altitudeM',
  'payloadJson',
  'rawPayloadHash',
  'origin',
  'externalId',
  'geometryJson',
  'sourceQuality',
  'seq',
] as const;
export type HistoryRowColumn = (typeof HISTORY_ROW_COLUMNS)[number];

const ORIGINS: ReadonlySet<string> = new Set<ProvenanceOrigin>([
  'live',
  'cached',
  'historical',
  'recorded',
  'local',
  'derived',
  'user',
]);
const QUALITIES: ReadonlySet<string> = new Set<ObservationQuality['sourceQuality']>([
  'authoritative',
  'crowdsourced',
  'derived',
  'unknown',
]);

/** Millisecond-precision UTC ISO; throws on unparsable input. */
export function normalizeIso(iso: string): IsoTimestamp {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`invalid timestamp "${iso}"`);
  return new Date(ms).toISOString();
}

export interface ObservationToRowOptions {
  /** Governed by ProviderDataPolicy.rawPayloadRetentionAllowed. */
  includeRawHash: boolean;
}

export function observationToRow(obs: Observation, objectId: string, opts: ObservationToRowOptions): HistoryRow {
  const position = obs.position ?? (obs.geometry ? geometryCentroid(obs.geometry) : undefined);
  const row: HistoryRow = {
    observationId: obs.id,
    objectId,
    providerId: obs.providerId,
    objectType: obs.objectType,
    observedAt: normalizeIso(obs.observedAt),
    receivedAt: normalizeIso(obs.receivedAt),
    payloadJson: JSON.stringify(obs.payload),
    origin: obs.provenance.origin,
    sourceQuality: obs.quality.sourceQuality,
  };
  if (position && isValidLatLon(position.latitude, position.longitude)) {
    row.lat = position.latitude;
    row.lon = position.longitude;
    if (position.altitudeM !== undefined && Number.isFinite(position.altitudeM)) row.altitudeM = position.altitudeM;
  }
  if (opts.includeRawHash && obs.rawPayloadHash) row.rawPayloadHash = obs.rawPayloadHash;
  if (obs.externalId) row.externalId = obs.externalId;
  if (obs.geometry) row.geometryJson = JSON.stringify(obs.geometry);
  return row;
}

export interface RowToObservationOptions {
  sourceName?: string;
  attribution?: string;
  licenseId?: string;
  termsUrl?: string;
}

/** Minimal Observation reconstructed from a row: enough for identity resolution and object rebuild. */
export function rowToObservation(row: HistoryRow, opts: RowToObservationOptions = {}): Observation {
  const obs: Observation = {
    id: row.observationId,
    providerId: row.providerId,
    objectType: row.objectType,
    observedAt: row.observedAt,
    receivedAt: row.receivedAt,
    payload: parsePayload(row.payloadJson),
    quality: { complete: true, sourceQuality: row.sourceQuality ?? 'unknown' },
    provenance: {
      providerId: row.providerId,
      sourceName: opts.sourceName ?? row.providerId,
      origin: 'historical',
      receivedAt: row.receivedAt,
      ...(opts.attribution !== undefined ? { attribution: opts.attribution } : {}),
      ...(opts.licenseId !== undefined ? { licenseId: opts.licenseId } : {}),
      ...(opts.termsUrl !== undefined ? { termsUrl: opts.termsUrl } : {}),
    },
  };
  if (row.externalId !== undefined) obs.externalId = row.externalId;
  if (row.lat !== undefined && row.lon !== undefined) {
    obs.position = {
      latitude: row.lat,
      longitude: row.lon,
      ...(row.altitudeM !== undefined ? { altitudeM: row.altitudeM } : {}),
    };
  }
  const geometry = parseGeometry(row.geometryJson);
  if (geometry) obs.geometry = geometry;
  if (row.rawPayloadHash !== undefined) obs.rawPayloadHash = row.rawPayloadHash;
  return obs;
}

function parsePayload(json: string): Record<string, JsonValue> {
  try {
    const v: unknown = JSON.parse(json);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, JsonValue>) : {};
  } catch {
    return {};
  }
}

function parseGeometry(json: string | undefined): WorldGeometry | undefined {
  if (!json) return undefined;
  try {
    const v: unknown = JSON.parse(json);
    if (typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string' && 'coordinates' in v)
      return v as WorldGeometry;
  } catch {
    /* malformed geometry is dropped, not fatal */
  }
  return undefined;
}

/** Structural validation for rows read back from disk (NDJSON lines, Parquet rows). */
export function isHistoryRow(v: unknown): v is HistoryRow {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  if (
    !isNonEmptyString(r['observationId']) ||
    !isNonEmptyString(r['objectId']) ||
    !isNonEmptyString(r['providerId']) ||
    !isNonEmptyString(r['objectType'])
  )
    return false;
  if (!isIsoTimestamp(r['observedAt']) || !isIsoTimestamp(r['receivedAt'])) return false;
  if (typeof r['payloadJson'] !== 'string') return false;
  if (typeof r['origin'] !== 'string' || !ORIGINS.has(r['origin'])) return false;
  if (r['lat'] !== undefined && r['lon'] !== undefined && !isValidLatLon(r['lat'], r['lon'])) return false;
  if ((r['lat'] === undefined) !== (r['lon'] === undefined)) return false;
  if (r['altitudeM'] !== undefined && !isFiniteNumber(r['altitudeM'])) return false;
  if (r['rawPayloadHash'] !== undefined && typeof r['rawPayloadHash'] !== 'string') return false;
  if (r['externalId'] !== undefined && typeof r['externalId'] !== 'string') return false;
  if (r['geometryJson'] !== undefined && typeof r['geometryJson'] !== 'string') return false;
  if (
    r['sourceQuality'] !== undefined &&
    (typeof r['sourceQuality'] !== 'string' || !QUALITIES.has(r['sourceQuality']))
  )
    return false;
  if (r['seq'] !== undefined && !(isFiniteNumber(r['seq']) && Number.isInteger(r['seq']) && r['seq'] >= 0))
    return false;
  return true;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Strip `undefined`/`null` members so a row serialises to a compact NDJSON line. */
export function compactRow(v: Record<string, unknown>): HistoryRow | undefined {
  const out: Record<string, unknown> = {};
  for (const col of HISTORY_ROW_COLUMNS) {
    const x = v[col];
    if (x === undefined || x === null) continue;
    out[col] = typeof x === 'bigint' ? Number(x) : x;
  }
  return isHistoryRow(out) ? out : undefined;
}

export function rowToLine(row: HistoryRow): string {
  return JSON.stringify(row);
}

/** Parse one NDJSON line; undefined when malformed (callers count, never crash). */
export function lineToRow(line: string): HistoryRow | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isHistoryRow(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
