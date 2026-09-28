import {
  geometryCentroid,
  geometrySchema,
  stableStringify,
  type JsonValue,
  type Observation,
  type SeverityClass,
  type WorldGeometry,
} from '@worldview/world-model';
import { buildObservation, type ObservationDraft } from '@worldview/provider-sdk';
import { NWS_MANIFEST } from './manifest.js';
import { combineZoneGeometries, ZONE_SIMPLIFY_DEG, zoneRefsOf } from './zones.js';

/**
 * Normalizer for api.weather.gov `/alerts/active` (GeoJSON FeatureCollection of
 * wx:Alert features, CAP-derived properties).
 *
 * Geometry policy: an alert becomes an observation when it carries its own polygon, or
 * when the geometry of every zone it names is already resolved (see zones.ts). A
 * zone-based alert whose zones are not yet resolved is rejected with a distinct reason
 * and its zone ids are reported in `zonesNeeded`, so the caller can fetch them and
 * normalize again rather than the alert being dropped silently. An alert with neither a
 * polygon nor zones is rejected outright. Every case is counted, so the health log shows
 * exactly how much of the feed is not on screen and why.
 */
export interface NormalizeOptions {
  receivedAt: string;
  /** Alerts whose validity ended more than an hour before this instant are rejected as expired. */
  nowMs: number;
  hash?: (input: string) => string;
  origin?: 'live' | 'cached' | 'historical' | 'recorded';
  sourceRef?: string;
  /** Already-resolved zone outlines, by `forecast/TXZ123`-style id. Missing ids are not fetched here. */
  zoneGeometry?: (zoneId: string) => WorldGeometry | undefined;
}

export interface NormalizeResult {
  observations: Observation[];
  total: number;
  rejected: Array<{ index: number; reason: string }>;
  /** Zone ids referenced by alerts that were skipped only because those zones are unresolved. */
  zonesNeeded: string[];
  /** Alerts admitted with geometry assembled from their zones rather than their own polygon. */
  fromZones: number;
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
    return {
      observations: [],
      total: 0,
      rejected: [{ index: -1, reason: 'not a FeatureCollection' }],
      zonesNeeded: [],
      fromZones: 0,
    };
  }
  const collection = payload as { features?: unknown; updated?: unknown };
  const features = Array.isArray(collection.features) ? (collection.features as unknown[]) : [];
  const observations: Observation[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  const seen = new Set<string>();
  const zonesNeeded: string[] = [];
  let fromZones = 0;
  features.forEach((raw, index) => {
    const draft = featureToDraft(raw, opts);
    if (typeof draft === 'string') {
      rejected.push({ index, reason: draft });
      if (draft === REJECT_ZONE_ONLY) {
        for (const id of zoneRefsOf((raw as { properties?: Record<string, unknown> })?.properties?.['affectedZones'])) {
          if (!zonesNeeded.includes(id)) zonesNeeded.push(id);
        }
      }
      return;
    }
    if (seen.has(draft.externalId)) {
      rejected.push({ index, reason: `duplicate alert ${draft.externalId}` });
      return;
    }
    seen.add(draft.externalId);
    if (draft.payload['geometrySource'] === 'zones') fromZones++;
    observations.push(buildObservation(NWS_MANIFEST, opts.receivedAt, draft));
  });
  const updatedAt = isoOrUndefined(collection.updated);
  return {
    observations,
    total: features.length,
    rejected,
    zonesNeeded,
    fromZones,
    ...(updatedAt ? { updatedAt } : {}),
  };
}

/** NWS timestamps carry local offsets (`2026-09-21T02:45:00-05:00`); normalize to UTC ISO. */
export function isoOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

export function mapSeverity(raw: unknown): SeverityClass {
  switch (typeof raw === 'string' ? raw.trim().toLowerCase() : '') {
    case 'extreme':
      return 'EXTREME';
    case 'severe':
      return 'SEVERE';
    case 'moderate':
      return 'MODERATE';
    case 'minor':
      return 'MINOR';
    default:
      return 'INFO';
  }
}

function text(v: unknown, max = 300): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
}

/** CAP references → the referenced alerts' URNs (at most 32, never the alert itself). */
export function referencesOf(v: unknown, self: string): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const r of v) {
    const id = r && typeof r === 'object' ? text((r as Record<string, unknown>)['identifier'], 256) : undefined;
    if (!id || !ID_RE.test(id) || id === self || out.includes(id)) continue;
    out.push(id);
    if (out.length >= 32) break;
  }
  return out;
}

function codes(v: unknown, pattern: RegExp, max = 200): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const c of v)
    if (typeof c === 'string' && pattern.test(c) && !out.includes(c)) {
      out.push(c);
      if (out.length >= max) break;
    }
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

/**
 * The first value of a CAP parameter as api.weather.gov writes it (`parameters.tornadoDamageThreat:
 * ["CONSIDERABLE"]`), trimmed and upper-cased, or undefined.
 */
function parameter(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  const first = Array.isArray(v) ? v[0] : v;
  return typeof first === 'string' && first.trim() ? first.trim().toUpperCase().slice(0, 64) : undefined;
}

/**
 * What kind of warning this is, for the few that need action in minutes and must be told
 * apart on the map at a glance (render-core WEATHER_ALERT_SUFFIXES, theme.ts): tornado — with
 * its "particularly dangerous situation" (damage threat CONSIDERABLE) and tornado emergency
 * (CATASTROPHIC) tiers — severe thunderstorm (DESTRUCTIVE tier), flash flood (emergency when
 * CATASTROPHIC), extreme wind, hurricane and typhoon, storm surge, tropical storm, and the
 * tornado, severe thunderstorm and hurricane watches. The tiers come from the IBW damage-threat
 * tags NWS puts in `parameters`, and, for an office that writes them only into the text, from
 * the words TORNADO EMERGENCY, FLASH FLOOD EMERGENCY and PARTICULARLY DANGEROUS SITUATION in
 * the headline or description. Undefined for everything else, which keeps its severity colour.
 */
export function alertKindOf(event: string, params: Record<string, unknown>, text: string = ''): string | undefined {
  const e = event.trim().toLowerCase();
  const t = text.toUpperCase();
  switch (e) {
    case 'tornado warning': {
      const threat = parameter(params, 'tornadoDamageThreat');
      if (threat === 'CATASTROPHIC' || t.includes('TORNADO EMERGENCY')) return 'tornado-emergency';
      if (threat === 'CONSIDERABLE' || t.includes('PARTICULARLY DANGEROUS SITUATION')) return 'tornado-pds';
      return 'tornado-warning';
    }
    case 'severe thunderstorm warning':
      return parameter(params, 'thunderstormDamageThreat') === 'DESTRUCTIVE'
        ? 'severe-thunderstorm-destructive'
        : 'severe-thunderstorm-warning';
    case 'flash flood warning':
      return parameter(params, 'flashFloodDamageThreat') === 'CATASTROPHIC' || t.includes('FLASH FLOOD EMERGENCY')
        ? 'flash-flood-emergency'
        : 'flash-flood-warning';
    case 'extreme wind warning':
      return 'extreme-wind-warning';
    case 'hurricane warning':
    case 'typhoon warning':
      return 'hurricane-warning';
    case 'storm surge warning':
      return 'storm-surge-warning';
    case 'tropical storm warning':
      return 'tropical-storm-warning';
    case 'hurricane watch':
    case 'typhoon watch':
      return 'hurricane-watch';
    case 'tornado watch':
      return 'tornado-watch';
    case 'severe thunderstorm watch':
      return 'severe-thunderstorm-watch';
    default:
      return undefined;
  }
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

  const own = toGeometry(f.geometry);
  if (typeof own === 'string') return own;
  // An alert without its own polygon is drawn from the zones it names, but only from
  // zones already resolved: a partial outline would understate where the alert applies,
  // so anything short of every zone is skipped and reported instead.
  const zoneIds = own ? [] : zoneRefsOf(props['affectedZones']);
  let geometry = own;
  let geometrySource: 'alert' | 'zones' = 'alert';
  if (!geometry) {
    if (zoneIds.length === 0) return REJECT_NO_GEOMETRY;
    const resolve = opts.zoneGeometry;
    if (!resolve) return REJECT_ZONE_ONLY;
    const parts: WorldGeometry[] = [];
    for (const id of zoneIds) {
      const g = resolve(id);
      if (!g) return REJECT_ZONE_ONLY;
      parts.push(g);
    }
    const combined = combineZoneGeometries(parts);
    if (!combined) return REJECT_ZONE_ONLY;
    geometry = combined;
    geometrySource = 'zones';
  }
  const position = geometryCentroid(geometry);
  if (!position) return 'empty geometry';

  const geocode =
    props['geocode'] && typeof props['geocode'] === 'object' ? (props['geocode'] as Record<string, unknown>) : {};
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
    // Where the outline on screen came from, so the shape is never mistaken for a
    // polygon the forecaster drew when it is actually the union of NWS zone outlines.
    geometrySource,
  };
  if (geometrySource === 'zones') {
    payload['zones'] = zoneIds;
    // The zone outlines are generalised (zones.ts); say by how much, beside the claim above.
    payload['outlineToleranceDeg'] = ZONE_SIMPLIFY_DEG;
  }
  // The earlier messages this one updates or cancels (CAP `references`), as alert URNs — the
  // event engine ends them and links the chain, so the feed shows one alert, not each message.
  const references = referencesOf(props['references'], externalId);
  if (references.length) payload['references'] = references;
  const headline = text(props['headline'], 300);
  if (headline) payload['headline'] = headline;
  const instruction = text(props['instruction'], TEXT_MAX);
  if (instruction) payload['instruction'] = instruction;
  const response = text(props['response'], 16);
  if (response) payload['response'] = response;
  // The warning's kind and the storm-based tags that go with it: what the map colours by and
  // the alert panel shows (a tornado "radar indicated" or "observed", its damage threat, the
  // gust and hail the forecaster expects).
  const params =
    props['parameters'] && typeof props['parameters'] === 'object' && !Array.isArray(props['parameters'])
      ? (props['parameters'] as Record<string, unknown>)
      : {};
  const kind = alertKindOf(event, params, `${headline ?? ''}\n${text(props['description'], TEXT_MAX) ?? ''}`);
  if (kind) payload['alertKind'] = kind;
  const detection = parameter(params, 'tornadoDetection');
  if (detection) payload['tornadoDetection'] = detection;
  const threat =
    parameter(params, 'tornadoDamageThreat') ??
    parameter(params, 'thunderstormDamageThreat') ??
    parameter(params, 'flashFloodDamageThreat');
  if (threat) payload['damageThreat'] = threat;
  const gust = parameter(params, 'maxWindGust');
  if (gust) payload['maxWindGust'] = gust.toLowerCase();
  // Inches, as NWS writes it ("1.75"); "Up to" forms are kept as written.
  const hail = parameter(params, 'maxHailSize');
  if (hail) payload['maxHailSize'] = hail.toLowerCase();
  if (ends) payload['ends'] = ends;
  if (onset) payload['onset'] = onset;

  const flags: string[] = [];
  if ((payload['messageType'] as string).toLowerCase() === 'update') flags.push('update');
  if (geometrySource === 'zones') flags.push('zone-geometry');

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
  if (g.type === 'MultiPolygon' && g.coordinates.some((poly) => poly.some((ring) => ring.length < 4)))
    return 'polygon ring too short';
  return g;
}
