import { EventTypes, ObjectTypes, classifyConfidence, haversineMeters, makeEventId, parseObjectId, positionToGeometry, type JsonValue, type WorldEvent, type WorldObject } from '@worldview/world-model';
import { magnitudeSeverity } from '../severity.js';
import { derivedProvenance, numberProp, refsOf, shortUtc, stringProp, type ObjectRule, type RuleContext } from './types.js';

/**
 * earthquakeRule — one event per earthquake object.
 *
 *   id        event:earthquake:<namespace>:<value>   (earthquake:usgs:us7000abcd → event:earthquake:usgs:us7000abcd)
 *   severity  magnitude < 3 INFO · < 4.5 MINOR · < 5.5 MODERATE · < 7 SEVERE · else EXTREME
 *   title     "M5.7 earthquake — <place>"
 *   aftershock: an earthquake within 100 km and ≤ 7 days after a ≥ 5.5 mainshock of larger magnitude
 *               gets properties.mainshockEventId = nearest such mainshock (ties: larger magnitude, then id).
 */
export const AFTERSHOCK_RADIUS_M = 100_000;
export const AFTERSHOCK_WINDOW_MS = 7 * 86_400_000;
export const MAINSHOCK_MIN_MAGNITUDE = 5.5;

export const earthquakeRule: ObjectRule = {
  id: 'earthquake',
  objectTypes: [ObjectTypes.Earthquake],
  eventTypes: [EventTypes.Earthquake],
  scope: 'changed',
  evaluate(objects, ctx) {
    const fresh = new Map<string, WorldEvent>();
    for (const o of objects) {
      if (o.type !== ObjectTypes.Earthquake) continue;
      const e = earthquakeEvent(o, ctx);
      if (e) fresh.set(e.id, e);
    }
    if (fresh.size === 0) return [];
    const existing = ctx.existing(EventTypes.Earthquake);
    const pool = new Map<string, WorldEvent>();
    for (const e of existing) pool.set(e.id, e);
    for (const e of fresh.values()) pool.set(e.id, e);
    const out: WorldEvent[] = [];
    for (const e of fresh.values()) out.push(withMainshock(e, pool));
    // A newly seen mainshock may claim earlier-stored later quakes (out-of-order arrival).
    for (const m of fresh.values()) {
      if ((numberOf(m, 'magnitude') ?? 0) < MAINSHOCK_MIN_MAGNITUDE) continue;
      for (const e of existing) {
        if (fresh.has(e.id)) continue;
        const linked = withMainshock(e, pool);
        if (linked.properties?.['mainshockEventId'] !== e.properties?.['mainshockEventId']) out.push(linked);
      }
    }
    return out;
  },
};

function earthquakeEvent(o: WorldObject, ctx: RuleContext): WorldEvent | undefined {
  const parsed = parseObjectId(o.id);
  if (!parsed) return undefined;
  const magnitude = numberProp(o, 'magnitude', 'mag');
  const depthKm = numberProp(o, 'depthKm', 'depth');
  const place = stringProp(o, 'place') ?? stringProp(o, 'title');
  const magType = stringProp(o, 'magType');
  const status = stringProp(o, 'status');
  const tsunami = o.properties['tsunami'] === true || o.properties['tsunami'] === 1;
  const magText = magnitude !== undefined ? `M${magnitude.toFixed(1)}` : undefined;
  const title = `${magText ? `${magText} earthquake` : 'Earthquake'}${place ? ` — ${place}` : ''}`;
  const parts: string[] = [];
  if (magnitude !== undefined) parts.push(`Magnitude ${magnitude.toFixed(1)}${magType ? ` (${magType})` : ''}`);
  if (depthKm !== undefined) parts.push(`depth ${Math.round(depthKm)} km`);
  parts.push(shortUtc(o.observedAt));
  let summary = parts.join(', ') + '.';
  if (status) summary += ` Status: ${status}.`;
  if (tsunami) summary += ' Tsunami flag set by the source.';
  const properties: Record<string, JsonValue> = {};
  if (magnitude !== undefined) properties['magnitude'] = magnitude;
  if (depthKm !== undefined) properties['depthKm'] = depthKm;
  if (place) properties['place'] = place;
  if (magType) properties['magType'] = magType;
  if (status) properties['status'] = status;
  if (tsunami) properties['tsunami'] = true;
  const event: WorldEvent = {
    id: makeEventId(EventTypes.Earthquake, parsed.namespace, parsed.value),
    type: EventTypes.Earthquake,
    title,
    startAt: o.observedAt,
    objectIds: [o.id],
    observationRefs: refsOf([o]),
    confidence: classifyConfidence(o.confidence),
    severity: magnitudeSeverity(magnitude),
    summary,
    properties,
    provenance: derivedProvenance([o], ctx.nowIso, refsOf([o])),
  };
  if (o.position) event.geometry = positionToGeometry(o.position);
  else if (o.geometry) event.geometry = o.geometry;
  return event;
}

function numberOf(e: WorldEvent, key: string): number | undefined {
  const v = e.properties?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function pointOf(e: WorldEvent): { latitude: number; longitude: number } | undefined {
  if (e.geometry?.type === 'Point') return { latitude: e.geometry.coordinates[1], longitude: e.geometry.coordinates[0] };
  return undefined;
}

/** Returns `e` with properties.mainshockEventId set/removed according to the pool. Pure. */
export function withMainshock(e: WorldEvent, pool: ReadonlyMap<string, WorldEvent>): WorldEvent {
  const mag = numberOf(e, 'magnitude');
  const p = pointOf(e);
  const t = Date.parse(e.startAt);
  let best: { id: string; distance: number; magnitude: number } | undefined;
  if (p && Number.isFinite(t)) {
    for (const m of pool.values()) {
      if (m.id === e.id || m.type !== EventTypes.Earthquake) continue;
      const mm = numberOf(m, 'magnitude');
      if (mm === undefined || mm < MAINSHOCK_MIN_MAGNITUDE) continue;
      if (mag !== undefined && mm <= mag) continue;
      const mt = Date.parse(m.startAt);
      if (!Number.isFinite(mt) || mt >= t || t - mt > AFTERSHOCK_WINDOW_MS) continue;
      const mp = pointOf(m);
      if (!mp) continue;
      const d = haversineMeters(p, mp);
      if (d > AFTERSHOCK_RADIUS_M) continue;
      if (!best || d < best.distance || (d === best.distance && (mm > best.magnitude || (mm === best.magnitude && m.id < best.id)))) best = { id: m.id, distance: d, magnitude: mm };
    }
  }
  const current = e.properties?.['mainshockEventId'];
  if (best?.id === current) return e;
  const properties: Record<string, JsonValue> = { ...(e.properties ?? {}) };
  if (best) properties['mainshockEventId'] = best.id; else delete properties['mainshockEventId'];
  return { ...e, properties };
}
