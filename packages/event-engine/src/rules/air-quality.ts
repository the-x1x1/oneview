import {
  EventTypes,
  ObjectTypes,
  classifyConfidence,
  makeEventId,
  parseObjectId,
  type JsonValue,
  type SeverityClass,
  type WorldEvent,
  type WorldObject,
} from '@worldview/world-model';
import {
  derivedProvenance,
  numberProp,
  refsOf,
  shortUtc,
  stringProp,
  type ObjectRule,
  type RuleContext,
} from './types.js';

/**
 * airQualityRule — an event while the air at a sensor is unhealthy (roadmap 0.5: a local
 * sensor's reading becomes something a watch zone and the feed can act on).
 *
 *   id        event:air-quality:<namespace>:<value>-<start, epoch seconds> — one per episode, so
 *             a second bad afternoon at the same sensor is a new event, not the first one reopened
 *             (sensor:purpleair-local:68c63a8e5a1b → event:air-quality:purpleair-local:68c63a8e5a1b-1790193490)
 *   raised    when an air-quality sensor's US EPA AQI (properties.aqiUs) reaches 101 —
 *             "Unhealthy for sensitive groups" — on a reading its laser channels agree on
 *   severity  101–150 MINOR · 151–200 MODERATE · 201–300 SEVERE · 301+ EXTREME, following the
 *             reading up and down (a zone escalates when it rises)
 *   title     "<category> air at <sensor name>" (+ " (indoors)"): it changes only when the
 *             category does; the numbers are in the summary and properties
 *   ends      when the AQI is back to 90 or below — not 100, so a reading hovering at the line
 *             does not open and close an event every two minutes — or the sensor is gone
 *   ignored   a reading whose channels disagree (channels-disagree) neither raises, moves
 *             nor ends an event: one laser is not to be trusted on its own
 */
export const AIR_QUALITY_RAISE_AQI = 101;
export const AIR_QUALITY_CLEAR_AQI = 90;

export function aqiCategoryName(aqi: number): string {
  if (aqi <= 50) return 'Good';
  if (aqi <= 100) return 'Moderate';
  if (aqi <= 150) return 'Unhealthy for sensitive groups';
  if (aqi <= 200) return 'Unhealthy';
  if (aqi <= 300) return 'Very unhealthy';
  return 'Hazardous';
}

export function aqiSeverity(aqi: number): SeverityClass {
  if (aqi > 300) return 'EXTREME';
  if (aqi > 200) return 'SEVERE';
  if (aqi > 150) return 'MODERATE';
  return 'MINOR';
}

export const airQualityRule: ObjectRule = {
  id: 'air-quality',
  objectTypes: [ObjectTypes.Sensor],
  eventTypes: [EventTypes.AirQuality],
  scope: 'all',
  evaluate(objects, ctx) {
    // The open episode of each sensor, by the sensor's object id.
    const active = new Map<string, WorldEvent>();
    for (const e of ctx.existing(EventTypes.AirQuality)) if (!e.endAt && e.objectIds[0]) active.set(e.objectIds[0], e);
    const out: WorldEvent[] = [];
    const seen = new Set<string>();
    for (const o of objects) {
      if (o.type !== ObjectTypes.Sensor || stringProp(o, 'sensorKind') !== 'air-quality' || !o.position) continue;
      const parsed = parseObjectId(o.id);
      if (!parsed) continue;
      seen.add(o.id);
      const previous = active.get(o.id);
      const aqi = numberProp(o, 'aqiUs');
      const trusted = stringProp(o, 'channels') !== 'disagree';
      if (aqi === undefined || !trusted) continue;
      if (!previous) {
        if (aqi < AIR_QUALITY_RAISE_AQI) continue;
        const startSec = Math.floor(Date.parse(o.observedAt) / 1000);
        const id = makeEventId(EventTypes.AirQuality, parsed.namespace, `${parsed.value}-${startSec}`);
        out.push(airEvent(id, o, aqi, undefined, ctx));
        continue;
      }
      if (aqi <= AIR_QUALITY_CLEAR_AQI) {
        out.push({
          ...previous,
          endAt: o.observedAt,
          summary: `${previous.summary} Cleared at AQI ${aqi}, ${shortUtc(o.observedAt)}.`,
        });
        continue;
      }
      const next = airEvent(previous.id, o, aqi, previous, ctx);
      if (!sameEvent(previous, next)) out.push(next);
    }
    for (const [objectId, e] of active) if (!seen.has(objectId)) out.push({ ...e, endAt: ctx.nowIso });
    return out;
  },
};

function airEvent(
  id: string,
  o: WorldObject,
  aqi: number,
  previous: WorldEvent | undefined,
  ctx: RuleContext,
): WorldEvent {
  const name = stringProp(o, 'name') ?? 'air-quality sensor';
  const indoor = stringProp(o, 'placement') === 'indoor';
  const category = aqiCategoryName(aqi);
  const prevPeak = previous?.properties?.['peakAqi'];
  const peak = Math.max(aqi, typeof prevPeak === 'number' ? prevPeak : aqi);
  const pm25 = numberProp(o, 'pm25Ugm3');
  const since = previous?.startAt ?? o.observedAt;
  const properties: Record<string, JsonValue> = { aqi, peakAqi: peak, category };
  if (pm25 !== undefined) properties['pm25Ugm3'] = pm25;
  if (indoor) properties['placement'] = 'indoor';
  let summary = `US EPA AQI ${aqi} (${category})${pm25 !== undefined ? `, PM2.5 ${pm25} µg/m³` : ''}.`;
  summary += ` Above 100 since ${shortUtc(since)}${peak > aqi ? `; peak ${peak}` : ''}.`;
  return {
    id,
    type: EventTypes.AirQuality,
    title: `${category} air at ${name}${indoor ? ' (indoors)' : ''}`,
    startAt: since,
    objectIds: [o.id],
    observationRefs: refsOf([o]),
    confidence: classifyConfidence(o.confidence),
    severity: aqiSeverity(aqi),
    summary,
    properties,
    geometry: { type: 'Point', coordinates: [o.position!.longitude, o.position!.latitude] },
    provenance: derivedProvenance([o], ctx.nowIso, refsOf([o])),
  };
}

/** Nothing the operator would see changed: no new event (the rule runs over every sensor every batch). */
function sameEvent(a: WorldEvent, b: WorldEvent): boolean {
  return (
    a.title === b.title &&
    a.severity === b.severity &&
    a.startAt === b.startAt &&
    !a.endAt &&
    a.summary === b.summary &&
    JSON.stringify(a.properties ?? {}) === JSON.stringify(b.properties ?? {}) &&
    JSON.stringify(a.geometry) === JSON.stringify(b.geometry)
  );
}
