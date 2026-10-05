import { EventTypes, ObjectTypes, type WorldObject } from '@worldview/world-model';
import { episodeRule } from './episodes.js';
import { shortUtc } from './types.js';

/**
 * distressBeaconRule — an event while an AIS distress beacon is transmitting in earnest: an
 * AIS-SART (search and rescue transmitter, MMSI 970…), a man-overboard device (972…) or an
 * EPIRB-AIS (974…) whose position reports say "active" (navigational status 14, ITU-R M.1371).
 * Its test transmissions say "not defined" (15) and raise nothing, nor does a report that
 * gives no status, so a beacon being serviced in a marina is not taken for a person in the
 * water. Episodes, following (it drifts), ending and reopening as episodes.ts describes.
 *
 *   id        event:distress-beacon:<namespace>:<mmsi>-<start, epoch seconds>
 *   severity  SEVERE: someone may be in the water
 *   ends      on a report that is no longer "active" ("stopped"), or once the beacon has not
 *             been heard for DISTRESS_BEACON_QUIET_MS (an active beacon sends every minute);
 *             heard again within DISTRESS_BEACON_REOPEN_MS, the same event goes on
 */
export const DISTRESS_BEACON_QUIET_MS = 10 * 60_000;
export const DISTRESS_BEACON_FOLLOW_MS = 60_000;
export const DISTRESS_BEACON_REOPEN_MS = 30 * 60_000;
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

function nameOf(o: WorldObject): string | undefined {
  const n = o.properties['name'];
  return typeof n === 'string' && n.trim() ? n.trim() : undefined;
}

export const distressBeaconRule = episodeRule<BeaconKind>({
  id: 'distress-beacon',
  objectType: ObjectTypes.Vessel,
  eventType: EventTypes.DistressBeacon,
  quietMs: DISTRESS_BEACON_QUIET_MS,
  followMs: DISTRESS_BEACON_FOLLOW_MS,
  reopenMs: DISTRESS_BEACON_REOPEN_MS,
  stateOf: (o) => {
    const kind = beaconKindOf(mmsiOf(o));
    if (!kind) return 'none';
    return o.properties['navStatus'] === ACTIVE ? kind : 'clear';
  },
  severityOf: () => 'SEVERE',
  titleOf: (o, kind) => {
    const name = nameOf(o);
    return `${KINDS[kind].title}: ${mmsiOf(o)}${name ? ` (${name})` : ''}`;
  },
  summaryOf: (o, kind) => `${KINDS[kind].what}, MMSI ${mmsiOf(o)}, has been transmitting as active`,
  caveat: 'As broadcast and relayed by the AIS source; the coastguard is not told by this app.',
  propertiesOf: (o) => {
    const name = nameOf(o);
    return { mmsi: mmsiOf(o) ?? '', ...(name ? { name } : {}) };
  },
  clearText: (at) => `No longer transmitting as active at ${shortUtc(at)}.`,
});
