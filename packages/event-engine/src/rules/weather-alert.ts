import {
  EventTypes,
  ObjectTypes,
  classifyConfidence,
  isIsoTimestamp,
  makeEventId,
  parseObjectId,
  positionToGeometry,
  type JsonValue,
  type WorldEvent,
  type WorldObject,
} from '@worldview/world-model';
import { payloadSeverity } from '../severity.js';
import { derivedProvenance, refsOf, shortUtc, stringProp, type ObjectRule, type RuleContext } from './types.js';

/**
 * weatherAlertRule — one event per weather-alert object.
 *
 *   id        event:weather-alert:<namespace>:<value>
 *   severity  properties.severity (Extreme/Severe/Moderate/Minor/Unknown, CAP style) → class; unknown → INFO
 *   startAt   properties.effectiveFrom | onset | observedAt;  endAt = object.validUntil | properties.expires | ends
 *   issuedAt  properties.sent | issued, when known (event properties)
 *   title     labels.title | properties.headline | properties.event | "Weather alert"
 */
export const weatherAlertRule: ObjectRule = {
  id: 'weather-alert',
  objectTypes: [ObjectTypes.WeatherAlert],
  eventTypes: [EventTypes.WeatherAlert],
  scope: 'changed',
  evaluate(objects, ctx) {
    const out: WorldEvent[] = [];
    for (const o of objects) {
      if (o.type !== ObjectTypes.WeatherAlert) continue;
      const e = alertEvent(o, ctx);
      if (e) out.push(e);
    }
    return out;
  },
};

function isoProp(o: WorldObject, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o.properties[k];
    if (typeof v === 'string' && isIsoTimestamp(v)) return v;
  }
  return undefined;
}

function alertEvent(o: WorldObject, ctx: RuleContext): WorldEvent | undefined {
  const parsed = parseObjectId(o.id);
  if (!parsed) return undefined;
  const eventName = stringProp(o, 'event', 'eventType');
  const title = stringProp(o, 'title') ?? stringProp(o, 'headline') ?? eventName ?? 'Weather alert';
  const area = stringProp(o, 'areaDesc', 'area', 'region');
  const sender = stringProp(o, 'senderName', 'sender', 'issuer');
  const urgency = stringProp(o, 'urgency');
  const certainty = stringProp(o, 'certainty');
  const startAt = isoProp(o, 'effectiveFrom', 'onset', 'effective') ?? o.observedAt;
  const endAt = o.validUntil ?? isoProp(o, 'expires', 'ends', 'validUntil');
  const severityText = stringProp(o, 'severity');
  const parts: string[] = [];
  if (eventName && eventName !== title) parts.push(eventName);
  if (area) parts.push(`for ${area}`);
  parts.push(`from ${shortUtc(startAt)}${endAt ? ` until ${shortUtc(endAt)}` : ''}`);
  let summary = parts.join(' ') + '.';
  if (severityText) summary += ` Severity: ${severityText}.`;
  if (sender) summary += ` Issued by ${sender}.`;
  const properties: Record<string, JsonValue> = {};
  if (eventName) properties['event'] = eventName;
  if (area) properties['areaDesc'] = area;
  if (sender) properties['senderName'] = sender;
  if (urgency) properties['urgency'] = urgency;
  if (certainty) properties['certainty'] = certainty;
  if (severityText) properties['severity'] = severityText;
  // When it was issued: a watch issued this morning for the day after tomorrow is news now,
  // not in two days (feed.ts orders and ages it by this).
  const issuedAt = isoProp(o, 'sent', 'issued');
  if (issuedAt) properties['issuedAt'] = issuedAt;
  const event: WorldEvent = {
    id: makeEventId(EventTypes.WeatherAlert, parsed.namespace, parsed.value),
    type: EventTypes.WeatherAlert,
    title,
    startAt,
    objectIds: [o.id],
    observationRefs: refsOf([o]),
    confidence: classifyConfidence(o.confidence),
    severity: payloadSeverity(o.properties['severity']),
    summary,
    properties,
    provenance: derivedProvenance([o], ctx.nowIso, refsOf([o])),
  };
  if (endAt) event.endAt = endAt;
  if (o.geometry) event.geometry = o.geometry;
  else if (o.position) event.geometry = positionToGeometry(o.position);
  return event;
}
