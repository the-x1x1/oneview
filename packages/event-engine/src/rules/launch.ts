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
import { derivedProvenance, refsOf, shortUtc, stringProp, type ObjectRule, type RuleContext } from './types.js';

/**
 * launchRule — one INFO event per launch object (when a launch provider exists).
 *
 *   id       event:launch:<namespace>:<value>
 *   startAt  properties.net | windowStart | observedAt;  endAt = properties.windowEnd (when present)
 *   title    labels.name | properties.mission | "Launch"
 */
export const launchRule: ObjectRule = {
  id: 'launch',
  objectTypes: [ObjectTypes.Launch],
  eventTypes: [EventTypes.Launch],
  scope: 'changed',
  evaluate(objects, ctx) {
    const out: WorldEvent[] = [];
    for (const o of objects) {
      if (o.type !== ObjectTypes.Launch) continue;
      const e = launchEvent(o, ctx);
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

function launchEvent(o: WorldObject, ctx: RuleContext): WorldEvent | undefined {
  const parsed = parseObjectId(o.id);
  if (!parsed) return undefined;
  const name = stringProp(o, 'name') ?? stringProp(o, 'mission') ?? 'Launch';
  const provider = stringProp(o, 'launchProvider', 'agency', 'operator');
  const vehicle = stringProp(o, 'vehicle', 'rocket');
  const pad = stringProp(o, 'pad', 'site', 'place');
  const status = stringProp(o, 'status');
  const startAt = isoProp(o, 'net', 'windowStart', 'launchAt') ?? o.observedAt;
  const endAt = isoProp(o, 'windowEnd');
  const parts: string[] = [];
  if (vehicle) parts.push(vehicle);
  if (provider) parts.push(`by ${provider}`);
  if (pad) parts.push(`from ${pad}`);
  parts.push(`NET ${shortUtc(startAt)}`);
  let summary = parts.join(' ') + '.';
  if (status) summary += ` Status: ${status}.`;
  const properties: Record<string, JsonValue> = {};
  if (provider) properties['launchProvider'] = provider;
  if (vehicle) properties['vehicle'] = vehicle;
  if (pad) properties['pad'] = pad;
  if (status) properties['status'] = status;
  const event: WorldEvent = {
    id: makeEventId(EventTypes.Launch, parsed.namespace, parsed.value),
    type: EventTypes.Launch,
    title: `Launch — ${name}`,
    startAt,
    objectIds: [o.id],
    observationRefs: refsOf([o]),
    confidence: classifyConfidence(o.confidence),
    severity: 'INFO',
    summary,
    properties,
    provenance: derivedProvenance([o], ctx.nowIso, refsOf([o])),
  };
  if (endAt) event.endAt = endAt;
  if (o.position) event.geometry = positionToGeometry(o.position);
  else if (o.geometry) event.geometry = o.geometry;
  return event;
}
