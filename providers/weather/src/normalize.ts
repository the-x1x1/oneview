import { geometryCentroid, geometrySchema, stableStringify, type JsonValue, type Observation, type SeverityClass, type WorldGeometry } from '@worldview/world-model';
import { buildObservation, type ObservationDraft } from '@worldview/provider-sdk';
import { NWS_MANIFEST } from './manifest.js';

/**
 * Normalizer for api.weather.gov `/alerts/active` (GeoJSON FeatureCollection of
 * wx:Alert features, CAP-derived properties).
 *
 * Geometry policy: only alerts that carry their own polygon become observations.
 * Zone-based alerts (geometry null, `affectedZones` present) are rejected with a
 * distinct reason — resolving them needs the zone geometry endpoint
 * (api.weather.gov/zones/…), which is a separate, cacheable lookup not implemented
 * in this version. Both cases are counted so the health log shows how much of the
 * feed is skipped.
 */
export interface NormalizeOptions {
  receivedAt: string;
  /** Alerts whose validity ended more than an hour before this instant are rejected as expired. */
  nowMs: number;
  hash?: (input: string) => string;
  origin?: 'live' | 'cached' | 'historical' | 'recorded';
  sourceRef?: string;
}

export interface NormalizeResult {
  observations: Observation[];
  total: number;
  rejected: Array<{ index: number; reason: string }>;
  /** Feed-level `updated` timestamp when present. */
  updatedAt?: string;
}

export const REJECT_NO_GEOMETRY = 'no geometry';
export const REJECT_ZONE_ONLY = 'zone-only alert (affectedZones present; zone geometry not resolved)';

const TEXT_MAX = 2000;
const EXPIRED_GRACE_MS = 3600_000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:+@-]{0,255}$/;

export function normalizeNwsAlerts(payload: unknown, opts: NormalizeOptions): NormalizeResult {
  if (!payload || typeof payload !== 'object' || (payload as { type?: unknown }).type !== 'FeatureCollection') {
    return { observations: [], total: 0, rejected: [{ index: -1, reason: 'not a FeatureCollection' }] };
  }
  const collection = payload as { features?: unknown; updated?: unknown };
  const features = Array.isArray(collection.features) ? (collection.features as unknown[]) : [];
  const observations: Observation[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  const seen = new Set<string>();
  features.forEach((raw, index) => {
    const draft = featureToDraft(raw, opts);
    if (typeof draft === 'string') { rejected.push({ index, reason: draft }); return; }
    if (seen.has(draft.externalId)) { rejected.push({ index, reason: `duplicate alert ${draft.externalId}` }); return; }
    seen.add(draft.externalId);
    observations.push(buildObservation(NWS_MANIFEST, opts.receivedAt, draft));
  });
  const updatedAt = isoOrUndefined(collection.updated);
  return { observations, total: features.length, rejected, ...(updatedAt ? { updatedAt } : {}) };
}

/** NWS timestamps carry local offsets (`2026-09-21T02:45:00-05:00`); normalize to UTC ISO. */
export function isoOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

export function mapSeverity(raw: unknown): SeverityClass {
  switch (typeof raw === 'string' ? raw.trim().toLowerCase() : '') {
    case 'extreme': return 'EXTREME';
    case 'severe': return 'SEVERE';
    case 'moderate': return 'MODERATE';
    case 'minor': return 'MINOR';
    default: return 'INFO';
  }
}

function text(v: unknown, max = 300): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
}

function codes(v: unknown, pattern: RegExp, max = 200): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const c of v) if (typeof c === 'string' && pattern.test(c) && !out.includes(c)) { out.push(c); if (out.length >= max) break; }
  return out;
}

/** Feature ids are URLs (`https://api.weather.gov/alerts/urn:oid:…`); properties.id is the bare URN. */
export function alertUrn(feature: { id?: unknown; properties: Record<string, unknown> }): string | undefined {
  const fromProps = text(feature.properties['id'], 256);
  if (fromProps && ID_RE.test(fromProps)) return fromProps;
  const fromId = text(feature.id, 512);
  if (!fromId) return undefined;
  const tail = fromId.replace(/^https?:\/\/api\.weather\.gov\/alerts\//, '');
  return ID_RE.test(tail) ? tail : undefined;
}

export function featureToDraft(raw: unknown, opts: NormalizeOptions): ObservationDraft | string {
  if (!raw || typeof raw !== 'object') return 'feature not an object';
  const f = raw as { type?: unknown; id?: unknown; geometry?: unknown; properties?: unknown };
  if (f.type !== 'Feature') return 'not a Feature';
  const p = f.properties;
  if (!p || typeof p !== 'object') return 'missing properties';
  const props = p as Record<string, unknown>;
  const externalId = alertUrn({ id: f.id, properties: props });
  if (!externalId) return 'invalid alert id';

  const sent = isoOrUndefined(props['sent']);
  if (!sent) return 'invalid sent timestamp';
  const effective = isoOrUndefined(props['effective']);
  const onset = isoOrUndefined(props['onset']);
  const expires = isoOrUndefined(props['expires']);
  const ends = isoOrUndefined(props['ends']);
  const effectiveFrom = onset ?? effective ?? sent;
  const effectiveUntil = ends ?? expires;
  if (!effectiveUntil) return 'missing expires/ends';
  if (Date.parse(effectiveUntil) < opts.nowMs - EXPIRED_GRACE_MS) return 'expired';
  if (Date.parse(effectiveFrom) > Date.parse(effectiveUntil)) return 'onset after end';

  const event = text(props['event'], 120);
  if (!event) return 'missing event';
  const status = text(props['status'], 16);
  if (status && status.toLowerCase() !== 'actual') return `status ${status} is not Actual`;

  const geometry = toGeometry(f.geometry);
  if (typeof geometry === 'string') return geometry;
  if (!geometry) {
    const zones = Array.isArray(props['affectedZones']) ? props['affectedZones'].length : 0;
    return zones > 0 ? REJECT_ZONE_ONLY : REJECT_NO_GEOMETRY;
  }
  const position = geometryCentroid(geometry);
  if (!position) return 'empty geometry';

  const geocode = props['geocode'] && typeof props['geocode'] === 'object' ? (props['geocode'] as Record<string, unknown>) : {};
  const payload: Record<string, JsonValue> = {
    event,
    title: event,
    severity: mapSeverity(props['severity']),
    nwsSeverity: text(props['severity'], 16) ?? 'Unknown',
    certainty: text(props['certainty'], 16) ?? 'Unknown',
    urgency: text(props['urgency'], 16) ?? 'Unknown',
    areaDesc: text(props['areaDesc'], 1000) ?? '',
    senderName: text(props['senderName'], 120) ?? '',
    description: text(props['description'], TEXT_MAX) ?? '',
    messageType: text(props['messageType'], 16) ?? 'Alert',
    category: text(props['category'], 16) ?? 'Met',
    sameCodes: codes(geocode['SAME'], /^\d{6}$/),
    ugcCodes: codes(geocode['UGC'], /^[A-Z]{2}[CZ]\d{3}$/),
    sent,
    expires: expires ?? effectiveUntil,
  };
  const headline = text(props['headline'], 300); if (headline) payload['headline'] = headline;
  const instruction = text(props['instruction'], TEXT_MAX); if (instruction) payload['instruction'] = instruction;
  const response = text(props['response'], 16); if (response) payload['response'] = response;
  if (ends) payload['ends'] = ends;
  if (onset) payload['onset'] = onset;

  const flags: string[] = [];
  if ((payload['messageType'] as string).toLowerCase() === 'update') flags.push('update');

  const draft: ObservationDraft = {
    externalId,
    objectType: 'weather-alert',
    observedAt: new Date(Math.min(Date.parse(sent), opts.nowMs)).toISOString(),
    position,
    geometry,
    effectiveFrom,
    effectiveUntil,
    payload,
    quality: { complete: true, sourceQuality: 'authoritative', ...(flags.length ? { flags } : {}) },
    origin: opts.origin ?? 'live',
  };
  if (opts.sourceRef) draft.sourceRef = opts.sourceRef;
  if (opts.hash) draft.rawPayloadHash = opts.hash(stableStringify(raw as JsonValue));
  return draft;
}

/** GeoJSON geometry → WorldGeometry (Polygon/MultiPolygon only); null → undefined; anything else → reason. */
export function toGeometry(raw: unknown): WorldGeometry | undefined | string {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== 'object') return 'geometry not an object';
  const type = (raw as { type?: unknown }).type;
  if (type !== 'Polygon' && type !== 'MultiPolygon') return `unsupported geometry ${String(type)}`;
  const r = geometrySchema.parse(raw);
  if (!r.ok) return 'invalid polygon coordinates';
  const g = r.value;
  if (g.type === 'Polygon' && g.coordinates.some((ring) => ring.length < 4)) return 'polygon ring too short';
  if (g.type === 'MultiPolygon' && g.coordinates.some((poly) => poly.some((ring) => ring.length < 4))) return 'polygon ring too short';
  return g;
}
