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
import { derivedProvenance, refsOf, shortUtc, stringProp, type ObjectRule } from './types.js';

/**
 * aircraftEmergencyRule — an event while an aircraft broadcasts an emergency: squawk 7700
 * (general emergency), 7600 (radio failure) or 7500 (unlawful interference), or the ADS-B
 * emergency status (`emergency` as adsb.lol and readsb give it: general, minfuel, nordo,
 * unlawful, downed). The flight trackers' "squawk 7700" alert, from what the aircraft sends.
 *
 *   id        event:aircraft-emergency:<namespace>:<value>-<start, epoch seconds> — one per
 *             episode of one aircraft
 *   raised    on a report that carries one of them; the most serious one names it
 *   severity  unlawful interference, general emergency and downed SEVERE; radio failure and
 *             minimum fuel MODERATE. Lifeguard (a medical flight's priority) is not an
 *             emergency, and is not raised
 *   follows   the aircraft, at most once a minute (its position and when it was last heard),
 *             and at once when what it broadcasts changes
 *   ends      on a report without it ("cleared"), or once the aircraft has not been heard for
 *             AIRCRAFT_EMERGENCY_QUIET_MS ("no longer heard") — judged whenever aircraft reports
 *             arrive, since a rule over changed objects is not told when one leaves
 *
 * As broadcast: a squawk is set by hand and is sometimes set by mistake and cleared within
 * minutes; the summary says so.
 */
export const AIRCRAFT_EMERGENCY_QUIET_MS = 10 * 60_000;
/** How often an open event follows its aircraft (position, last heard). */
export const AIRCRAFT_EMERGENCY_FOLLOW_MS = 60_000;

export type EmergencyKind = 'unlawful' | 'general' | 'downed' | 'nordo' | 'minfuel';

const KINDS: Readonly<Record<EmergencyKind, { label: string; squawk?: string; severity: SeverityClass }>> = {
  unlawful: { label: 'unlawful interference', squawk: '7500', severity: 'SEVERE' },
  general: { label: 'general emergency', squawk: '7700', severity: 'SEVERE' },
  downed: { label: 'downed aircraft', severity: 'SEVERE' },
  nordo: { label: 'radio failure', squawk: '7600', severity: 'MODERATE' },
  minfuel: { label: 'minimum fuel', severity: 'MODERATE' },
};
/** Most serious first: the one an aircraft sending two is named by. */
const ORDER: readonly EmergencyKind[] = ['unlawful', 'general', 'downed', 'nordo', 'minfuel'];
const BY_SQUAWK: Readonly<Record<string, EmergencyKind>> = { '7500': 'unlawful', '7700': 'general', '7600': 'nordo' };

/** What emergency an aircraft's last report broadcasts, the most serious if two; undefined for none. */
export function emergencyOf(o: WorldObject): EmergencyKind | undefined {
  const squawk = o.properties['squawk'];
  const status = o.properties['emergency'];
  const kinds = new Set<EmergencyKind>();
  if (typeof squawk === 'string' && BY_SQUAWK[squawk]) kinds.add(BY_SQUAWK[squawk]);
  if (typeof status === 'string' && Object.hasOwn(KINDS, status.toLowerCase()))
    kinds.add(status.toLowerCase() as EmergencyKind);
  return ORDER.find((k) => kinds.has(k));
}

export const aircraftEmergencyRule: ObjectRule = {
  id: 'aircraft-emergency',
  objectTypes: [ObjectTypes.Aircraft],
  eventTypes: [EventTypes.AircraftEmergency],
  scope: 'changed',
  evaluate(objects, ctx) {
    const open = new Map<string, WorldEvent>();
    for (const e of ctx.existing(EventTypes.AircraftEmergency))
      if (!e.endAt && e.objectIds[0]) open.set(e.objectIds[0], e);
    const out: WorldEvent[] = [];
    const heard = new Set<string>();
    for (const o of objects) {
      if (!o.position) continue;
      heard.add(o.id);
      const kind = emergencyOf(o);
      const previous = open.get(o.id);
      if (!kind) {
        if (previous) out.push(ended(previous, o.observedAt, 'cleared'));
        continue;
      }
      if (!previous) {
        const parsed = parseObjectId(o.id);
        if (!parsed) continue;
        const startSec = Math.floor(Date.parse(o.observedAt) / 1000);
        const id = makeEventId(EventTypes.AircraftEmergency, parsed.namespace, `${parsed.value}-${startSec}`);
        out.push(emergencyEvent(id, o, kind, o.observedAt, ctx.nowIso));
        continue;
      }
      const lastHeard = Date.parse(String(previous.properties?.['lastHeardAt'] ?? previous.startAt));
      const changed = previous.properties?.['kind'] !== kind;
      if (changed || Date.parse(o.observedAt) - lastHeard >= AIRCRAFT_EMERGENCY_FOLLOW_MS)
        out.push(emergencyEvent(previous.id, o, kind, previous.startAt, ctx.nowIso));
    }
    for (const [objectId, e] of open) {
      if (heard.has(objectId)) continue;
      const last = String(e.properties?.['lastHeardAt'] ?? e.startAt);
      if (ctx.now - Date.parse(last) > AIRCRAFT_EMERGENCY_QUIET_MS) out.push(ended(e, last, 'no longer heard'));
    }
    return out;
  },
};

/** "UAL123", else the registration, else the ICAO address. */
function aircraftName(o: WorldObject): string {
  return (
    stringProp(o, 'callsign', 'flight', 'registration') ??
    (typeof o.properties['icao24'] === 'string' ? o.properties['icao24'].toUpperCase() : 'An aircraft')
  );
}

function emergencyEvent(id: string, o: WorldObject, kind: EmergencyKind, startAt: string, nowIso: string): WorldEvent {
  const k = KINDS[kind];
  const name = aircraftName(o);
  const squawk = typeof o.properties['squawk'] === 'string' ? o.properties['squawk'] : undefined;
  const code = k.squawk && squawk === k.squawk ? ` (squawk ${squawk})` : '';
  const properties: Record<string, JsonValue> = { kind, lastHeardAt: o.observedAt, name };
  if (squawk) properties['squawk'] = squawk;
  if (o.position!.altitudeM !== undefined) properties['altitudeM'] = o.position!.altitudeM;
  return {
    id,
    type: EventTypes.AircraftEmergency,
    title: `${name}: ${k.label}${code}`,
    startAt,
    objectIds: [o.id],
    observationRefs: refsOf([o]),
    confidence: classifyConfidence(o.confidence),
    severity: k.severity,
    summary:
      `${name} has broadcast ${k.label}${code} since ${shortUtc(startAt)}. As broadcast: a squawk is set by ` +
      'hand and is sometimes set by mistake and cleared within minutes.',
    properties,
    geometry: { type: 'Point', coordinates: [o.position!.longitude, o.position!.latitude] },
    provenance: derivedProvenance([o], nowIso, refsOf([o])),
  };
}

function ended(e: WorldEvent, at: string, why: 'cleared' | 'no longer heard'): WorldEvent {
  const end = why === 'cleared' ? `Cleared at ${shortUtc(at)}.` : `No longer heard after ${shortUtc(at)}.`;
  return { ...e, endAt: at, summary: `${e.summary} ${end}` };
}
