import type { JsonValue, WorldEvent, WorldObject } from '@worldview/world-model';

/**
 * Field-path resolution for WorldFilter / SortDefinition.
 *
 * Objects:  properties.<k>, labels.<k>, motion.<k>, position.<k>, type, id, freshness,
 *           confidence, observedAt, updatedAt, validUntil, providerId
 * Events:   properties.<k>, type, id, title, severity, confidence, startAt, endAt, providerId
 *
 * A bare `<k>` that is not a top-level field falls back to properties.<k>, so
 * "magnitude" and "properties.magnitude" resolve the same way.
 */
export type FieldValue = JsonValue | undefined;

const OBJECT_TOP: ReadonlySet<string> = new Set([
  'type',
  'id',
  'freshness',
  'confidence',
  'observedAt',
  'updatedAt',
  'validUntil',
  'providerId',
]);
const EVENT_TOP: ReadonlySet<string> = new Set([
  'type',
  'id',
  'title',
  'severity',
  'confidence',
  'startAt',
  'endAt',
  'providerId',
  'summary',
]);

export function resolveObjectField(obj: WorldObject, path: string): FieldValue {
  const [head, ...rest] = path.split('.');
  if (!head) return undefined;
  switch (head) {
    case 'properties':
      return walk(obj.properties, rest);
    case 'labels':
      return walk(obj.labels, rest);
    case 'motion':
      return obj.motion ? walk(motionJson(obj), rest) : undefined;
    case 'position':
      return obj.position ? walk(positionJson(obj), rest) : undefined;
    case 'providerId':
      return obj.provenance.providerId;
    case 'type':
      return obj.type;
    case 'id':
      return obj.id;
    case 'freshness':
      return obj.freshness;
    case 'confidence':
      return obj.confidence;
    case 'observedAt':
      return obj.observedAt;
    case 'updatedAt':
      return obj.updatedAt;
    case 'validUntil':
      return obj.validUntil;
    default:
      if (rest.length === 0 && !OBJECT_TOP.has(head)) return walk(obj.properties, [head]);
      return undefined;
  }
}

export function resolveEventField(event: WorldEvent, path: string): FieldValue {
  const [head, ...rest] = path.split('.');
  if (!head) return undefined;
  switch (head) {
    case 'properties':
      return event.properties ? walk(event.properties, rest) : undefined;
    case 'providerId':
      return event.provenance.providerId;
    case 'type':
      return event.type;
    case 'id':
      return event.id;
    case 'title':
      return event.title;
    case 'summary':
      return event.summary;
    case 'severity':
      return event.severity;
    case 'confidence':
      return event.confidence;
    case 'startAt':
      return event.startAt;
    case 'endAt':
      return event.endAt;
    default:
      if (rest.length === 0 && !EVENT_TOP.has(head))
        return event.properties ? walk(event.properties, [head]) : undefined;
      return undefined;
  }
}

function walk(root: Record<string, JsonValue> | undefined, segments: string[]): FieldValue {
  let cur: JsonValue | undefined = root;
  for (const s of segments) {
    if (cur === undefined || cur === null || typeof cur !== 'object') return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(s);
      cur = Number.isInteger(idx) ? cur[idx] : undefined;
    } else {
      cur = (cur as Record<string, JsonValue>)[s];
    }
  }
  return cur;
}

function motionJson(obj: WorldObject): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  const m = obj.motion;
  if (!m) return out;
  if (m.speedMps !== undefined) out['speedMps'] = m.speedMps;
  if (m.headingDegrees !== undefined) out['headingDegrees'] = m.headingDegrees;
  if (m.verticalSpeedMps !== undefined) out['verticalSpeedMps'] = m.verticalSpeedMps;
  return out;
}

function positionJson(obj: WorldObject): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  const p = obj.position;
  if (!p) return out;
  out['latitude'] = p.latitude;
  out['longitude'] = p.longitude;
  if (p.altitudeM !== undefined) out['altitudeM'] = p.altitudeM;
  if (p.altitudeDatum !== undefined) out['altitudeDatum'] = p.altitudeDatum;
  if (p.accuracyM !== undefined) out['accuracyM'] = p.accuracyM;
  return out;
}

const ISO_LIKE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** Classify a value for type-aware comparison. */
export function comparableKind(v: FieldValue): 'number' | 'date' | 'string' | 'boolean' | 'none' | 'other' {
  if (v === undefined || v === null) return 'none';
  if (typeof v === 'number') return Number.isFinite(v) ? 'number' : 'none';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'string') return ISO_LIKE.test(v) && Number.isFinite(Date.parse(v)) ? 'date' : 'string';
  return 'other';
}

/**
 * Deterministic three-way compare. Numbers numerically, ISO timestamps by instant,
 * strings case-insensitively (then case-sensitively for stability). Mixed kinds compare
 * by kind order so sorting never throws; `none` always sorts last regardless of direction.
 */
export function compareValues(a: FieldValue, b: FieldValue): number {
  const ka = comparableKind(a),
    kb = comparableKind(b);
  if (ka === 'none' && kb === 'none') return 0;
  if (ka === 'none') return 1;
  if (kb === 'none') return -1;
  if (ka === kb) {
    switch (ka) {
      case 'number':
        return (a as number) - (b as number);
      case 'date':
        return Date.parse(a as string) - Date.parse(b as string);
      case 'boolean':
        return Number(a) - Number(b);
      case 'string': {
        const la = (a as string).toLowerCase(),
          lb = (b as string).toLowerCase();
        if (la !== lb) return la < lb ? -1 : 1;
        return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
      }
      default: {
        const sa = JSON.stringify(a),
          sb = JSON.stringify(b);
        return sa < sb ? -1 : sa > sb ? 1 : 0;
      }
    }
  }
  // Numbers vs numeric strings compare numerically.
  const na = toNumber(a),
    nb = toNumber(b);
  if (na !== undefined && nb !== undefined) return na - nb;
  const order = ['number', 'date', 'boolean', 'string', 'other'];
  return order.indexOf(ka) - order.indexOf(kb);
}

export function toNumber(v: FieldValue): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
