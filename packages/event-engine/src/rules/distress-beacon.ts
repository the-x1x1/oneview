import {
  EventTypes,
  ObjectTypes,
  classifyConfidence,
  makeEventId,
  parseObjectId,
  type JsonValue,
  type WorldEvent,
  type WorldObject,
} from '@worldview/world-model';
import { derivedProvenance, refsOf, shortUtc, type ObjectRule } from './types.js';

/**
 * distressBeaconRule — an event while an AIS distress beacon is transmitting in earnest: an
 * AIS-SART (search and rescue transmitter, MMSI 970…), a man-overboard device (972…) or an
 * EPIRB-AIS (974…) whose position reports say "active" (navigational status 14, ITU-R M.1371).
 * Its test transmissions say "not defined" (15) instead and raise nothing, nor does a report
 * that gives no status, so a beacon being serviced in a marina is not taken for a person in
 * the water.
 *
 *   id        event:distress-beacon:<namespace>:<mmsi>-<start, epoch seconds> — one per
 *             episode of one beacon
 *   severity  SEVERE: someone may be in the water
 *   follows   the beacon's position (it drifts), at most once a minute
 *   ends      on a report that is no longer "active" ("stopped"), or once the beacon has not
 *             been heard for DISTRESS_BEACON_QUIET_MS (an active beacon sends every minute) —
 *             judged whenever vessel reports arrive
 */
export const DISTRESS_BEACON_QUIET_MS = 10 * 60_000;
export const DISTRESS_BEACON_FOLLOW_MS = 60_000;
/** Navigational status 14: AIS-SART / MOB / EPIRB active. */
const ACTIVE = 14;

export type BeaconKind = 'sart' | 'mob' | 'epirb';

const KINDS: Readonly<Record<BeaconKind, { what: string; title: string }>> = {
  sart: { what: 'An AIS-SART (search and rescue transmitter)', title: 'AIS-SART active' },
  mob: { what: 'A man-overboard beacon (AIS MOB)', title: 'Man overboard' },
  epirb: { what: 'An EPIRB-AIS', title: 'EPIRB-AIS active' },
};

/** What kind of distress beacon an MMSI belongs to; undefined for anything else. */
export function beaconKindOf(mmsi: string | undefined): BeaconKind | undefined {
  if (!mmsi || !/^\d{9}$/.test(mmsi)) return undefined;
  if (mmsi.startsWith('970')) return 'sart';
  if (mmsi.startsWith('972')) return 'mob';
  if (mmsi.startsWith('974')) return 'epirb';
  return undefined;
}

function mmsiOf(o: WorldObject): string | undefined {
  const m = o.properties['mmsi'];
  if (typeof m === 'string') return m;
  if (typeof m === 'number' && Number.isInteger(m)) return String(m).padStart(9, '0');
  return undefined;
}

export const distressBeaconRule: ObjectRule = {
  id: 'distress-beacon',
  objectTypes: [ObjectTypes.Vessel],
  eventTypes: [EventTypes.DistressBeacon],
  scope: 'changed',
  evaluate(objects, ctx) {
    const open = new Map<string, WorldEvent>();
    for (const e of ctx.existing(EventTypes.DistressBeacon))
      if (!e.endAt && e.objectIds[0]) open.set(e.objectIds[0], e);
    const out: WorldEvent[] = [];
    const heard = new Set<string>();
    for (const o of objects) {
      const mmsi = mmsiOf(o);
      const kind = beaconKindOf(mmsi);
      if (!kind || !o.position) continue;
      heard.add(o.id);
      const active = o.properties['navStatus'] === ACTIVE;
      const previous = open.get(o.id);
      if (!active) {
        if (previous) out.push(ended(previous, o.observedAt, 'stopped'));
        continue;
      }
      if (!previous) {
        const parsed = parseObjectId(o.id);
        if (!parsed) continue;
        const startSec = Math.floor(Date.parse(o.observedAt) / 1000);
        const id = makeEventId(EventTypes.DistressBeacon, parsed.namespace, `${parsed.value}-${startSec}`);
        out.push(beaconEvent(id, o, kind, mmsi!, o.observedAt, ctx.nowIso));
        continue;
      }
      const lastHeard = Date.parse(String(previous.properties?.['lastHeardAt'] ?? previous.startAt));
      if (Date.parse(o.observedAt) - lastHeard >= DISTRESS_BEACON_FOLLOW_MS)
        out.push(beaconEvent(previous.id, o, kind, mmsi!, previous.startAt, ctx.nowIso));
    }
    for (const [objectId, e] of open) {
      if (heard.has(objectId)) continue;
      const last = String(e.properties?.['lastHeardAt'] ?? e.startAt);
      if (ctx.now - Date.parse(last) > DISTRESS_BEACON_QUIET_MS) out.push(ended(e, last, 'no longer heard'));
    }
    return out;
  },
};

function beaconEvent(
  id: string,
  o: WorldObject,
  kind: BeaconKind,
  mmsi: string,
  startAt: string,
  nowIso: string,
): WorldEvent {
  const { what, title } = KINDS[kind];
  const name =
    typeof o.properties['name'] === 'string' && o.properties['name'].trim() ? o.properties['name'].trim() : '';
  const properties: Record<string, JsonValue> = { kind, mmsi, lastHeardAt: o.observedAt };
  if (name) properties['name'] = name;
  return {
    id,
    type: EventTypes.DistressBeacon,
    title: `${title}: ${mmsi}${name ? ` (${name})` : ''}`,
    startAt,
    objectIds: [o.id],
    observationRefs: refsOf([o]),
    confidence: classifyConfidence(o.confidence),
    severity: 'SEVERE',
    summary:
      `${what}, MMSI ${mmsi}, has been transmitting as active since ${shortUtc(startAt)}, last heard ` +
      `${shortUtc(o.observedAt)}. As broadcast and relayed by the AIS source; the coastguard is not told by this app.`,
    properties,
    geometry: { type: 'Point', coordinates: [o.position!.longitude, o.position!.latitude] },
    provenance: derivedProvenance([o], nowIso, refsOf([o])),
  };
}

function ended(e: WorldEvent, at: string, why: 'stopped' | 'no longer heard'): WorldEvent {
  const end =
    why === 'stopped'
      ? `No longer transmitting as active at ${shortUtc(at)}.`
      : `No longer heard after ${shortUtc(at)}.`;
  return { ...e, endAt: at, summary: `${e.summary} ${end}` };
}
