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
 *
 * Supersession (roadmap 0.4): an alert message that updates or cancels earlier ones (CAP
 * `references`, kept by the provider as `properties.references`) carries
 * `properties.supersedes` — the earlier messages' event ids — and each earlier event it finds
 * gets `properties.supersededBy` and an end no later than the new message was issued. The
 * feed shows the chain once, as its latest message. Out-of-order arrival is linked too: an
 * earlier message seen after its update is superseded on arrival.
 */
export const weatherAlertRule: ObjectRule = {
  id: 'weather-alert',
  objectTypes: [ObjectTypes.WeatherAlert],
  eventTypes: [EventTypes.WeatherAlert],
  scope: 'changed',
  evaluate(objects, ctx) {
    const fresh = new Map<string, WorldEvent>();
    for (const o of objects) {
      if (o.type !== ObjectTypes.WeatherAlert) continue;
      const e = alertEvent(o, ctx);
      if (e) fresh.set(e.id, e);
    }
    if (fresh.size === 0) return [];
    return linkSupersession(fresh, ctx.existing(EventTypes.WeatherAlert));
  },
};

function supersedesOf(e: WorldEvent): string[] {
  const v = e.properties?.['supersedes'];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** When a message was issued, for choosing the latest of several and for ending what it replaces. */
function issuedMs(e: WorldEvent): number {
  const issued = e.properties?.['issuedAt'];
  const t = typeof issued === 'string' ? Date.parse(issued) : Number.NaN;
  return Number.isFinite(t) ? t : Date.parse(e.startAt);
}

/**
 * The fresh events, plus every stored event whose supersession they change, linked. Pure:
 * the same fresh and stored events give the same result.
 */
export function linkSupersession(
  fresh: ReadonlyMap<string, WorldEvent>,
  existing: readonly WorldEvent[],
): WorldEvent[] {
  const pool = new Map<string, WorldEvent>();
  for (const e of existing) pool.set(e.id, e);
  for (const e of fresh.values()) pool.set(e.id, e);
  const referencedBy = new Map<string, WorldEvent[]>();
  for (const e of pool.values())
    for (const target of supersedesOf(e)) {
      if (target === e.id) continue;
      const list = referencedBy.get(target) ?? [];
      list.push(e);
      referencedBy.set(target, list);
    }
  const touched = new Set<string>(fresh.keys());
  for (const e of fresh.values()) for (const t of supersedesOf(e)) touched.add(t);
  const out = new Map<string, WorldEvent>(fresh);
  for (const id of touched) {
    const e = out.get(id) ?? pool.get(id);
    const by = referencedBy.get(id);
    if (!e || !by?.length) continue;
    const latest = [...by].sort((a, b) => issuedMs(b) - issuedMs(a) || (a.id < b.id ? -1 : 1))[0]!;
    const linked = withSupersededBy(e, latest);
    if (linked !== e || out.has(id)) out.set(id, linked);
  }
  return [...out.values()];
}

/** `e` marked as replaced by `by`, ending no later than `by` was issued (never before it began). */
export function withSupersededBy(e: WorldEvent, by: WorldEvent): WorldEvent {
  const startMs = Date.parse(e.startAt);
  const endMs = e.endAt ? Date.parse(e.endAt) : Number.POSITIVE_INFINITY;
  const cut = Math.max(startMs, Math.min(endMs, issuedMs(by)));
  const endAt = Number.isFinite(cut) ? new Date(cut).toISOString() : e.endAt;
  // Compared as instants: a stored end written with an offset ("…-05:00") is the same end.
  const sameEnd = (e.endAt ? Date.parse(e.endAt) : Number.NaN) === cut || (!e.endAt && !endAt);
  if (e.properties?.['supersededBy'] === by.id && sameEnd) return e;
  const out: WorldEvent = { ...e, properties: { ...(e.properties ?? {}), supersededBy: by.id } };
  if (endAt) out.endAt = endAt;
  return out;
}

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
  const messageType = stringProp(o, 'messageType');
  const references = Array.isArray(o.properties['references'])
    ? o.properties['references'].filter((r): r is string => typeof r === 'string' && r.length > 0).slice(0, 32)
    : [];
  const parts: string[] = [];
  if (eventName && eventName !== title) parts.push(eventName);
  if (area) parts.push(`for ${area}`);
  parts.push(`from ${shortUtc(startAt)}${endAt ? ` until ${shortUtc(endAt)}` : ''}`);
  let summary = parts.join(' ') + '.';
  if (severityText) summary += ` Severity: ${severityText}.`;
  if (sender) summary += ` Issued by ${sender}.`;
  if (references.length && messageType?.toLowerCase() === 'cancel')
    summary = `Cancels ${references.length === 1 ? 'an earlier alert' : `${references.length} earlier alerts`}. ${summary}`;
  else if (references.length)
    summary = `Updates ${references.length === 1 ? 'an earlier alert' : `${references.length} earlier alerts`}. ${summary}`;
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
  if (messageType) properties['messageType'] = messageType;
  if (references.length)
    properties['supersedes'] = references.map((r) => makeEventId(EventTypes.WeatherAlert, parsed.namespace, r));
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
