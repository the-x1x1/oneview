import { EventTypes, ObjectTypes, type SeverityClass, type WorldObject } from '@worldview/world-model';
import { episodeRule } from './episodes.js';
import { shortUtc, stringProp } from './types.js';

/**
 * aircraftEmergencyRule — an event while an aircraft broadcasts an emergency: squawk 7700
 * (general emergency), 7600 (radio failure) or 7500 (unlawful interference), or the ADS-B
 * emergency status (`emergency` as adsb.lol and readsb give it: general, minfuel, nordo,
 * unlawful, downed). The flight trackers' "squawk 7700" alert, from what the aircraft sends.
 * Episodes, following, ending and reopening as episodes.ts describes.
 *
 *   id        event:aircraft-emergency:<namespace>:<value>-<start, epoch seconds>
 *   raised    on a report that carries one of them; the most serious one names it
 *   severity  unlawful interference, general emergency and downed SEVERE; radio failure and
 *             minimum fuel MODERATE. Lifeguard (a medical flight's priority) is not an
 *             emergency, and is not raised
 *   ends      on a report without it ("cleared"), or once the aircraft has not been heard for
 *             AIRCRAFT_EMERGENCY_QUIET_MS; heard again saying it within
 *             AIRCRAFT_EMERGENCY_REOPEN_MS, the same event goes on
 *
 * A property a report leaves out keeps its last value in the world (state-engine merge), and
 * the ADS-B status is not in every report. The general, radio-failure and unlawful statuses
 * follow the squawk in a transponder, so a known squawk that is none of 7500, 7600 and 7700
 * overrules them: an aircraft that has squawked 2345 since is not left in an emergency it
 * cleared.
 *
 * As broadcast: a squawk is set by hand and is sometimes set by mistake and cleared within
 * minutes; the summary says so.
 */
export const AIRCRAFT_EMERGENCY_QUIET_MS = 15 * 60_000;
/** How often an open event follows its aircraft (position, last heard). */
export const AIRCRAFT_EMERGENCY_FOLLOW_MS = 60_000;
/** Heard again within this of going quiet, an episode goes on (adsb.lol's coverage rotates). */
export const AIRCRAFT_EMERGENCY_REOPEN_MS = 30 * 60_000;

export type EmergencyKind = 'unlawful' | 'general' | 'downed' | 'nordo' | 'minfuel';

const KINDS: Readonly<Record<EmergencyKind, { label: string; squawk?: string; severity: SeverityClass }>> = {
  unlawful: { label: 'unlawful interference', squawk: '7500', severity: 'SEVERE' },
  general: { label: 'general emergency', squawk: '7700', severity: 'SEVERE' },
  downed: { label: 'downed aircraft', severity: 'SEVERE' },
  nordo: { label: 'radio failure', squawk: '7600', severity: 'MODERATE' },
  minfuel: { label: 'minimum fuel', severity: 'MODERATE' },
};
/** Most serious first: the one an aircraft sending two is named by. */
const RANK: Readonly<Record<EmergencyKind, number>> = { unlawful: 0, general: 1, downed: 2, nordo: 3, minfuel: 4 };
const BY_SQUAWK: Readonly<Record<string, EmergencyKind>> = { '7500': 'unlawful', '7700': 'general', '7600': 'nordo' };
/** Statuses a transponder sets from the squawk. */
const FOLLOWS_SQUAWK: ReadonlySet<EmergencyKind> = new Set(['unlawful', 'general', 'nordo']);

/** What emergency an aircraft broadcasts, the most serious if two; undefined for none. */
export function emergencyOf(o: WorldObject): EmergencyKind | undefined {
  const squawk = o.properties['squawk'];
  const status = o.properties['emergency'];
  const bySquawk = typeof squawk === 'string' ? BY_SQUAWK[squawk] : undefined;
  let byStatus: EmergencyKind | undefined;
  if (typeof status === 'string') {
    const s = status.toLowerCase();
    if (Object.hasOwn(KINDS, s)) byStatus = s as EmergencyKind;
  }
  // A status left from earlier reports, contradicted by the squawk now.
  if (byStatus && FOLLOWS_SQUAWK.has(byStatus) && typeof squawk === 'string' && !bySquawk) byStatus = undefined;
  if (bySquawk && byStatus) return RANK[bySquawk] <= RANK[byStatus] ? bySquawk : byStatus;
  return bySquawk ?? byStatus;
}

/** "UAL123", else the registration, else the ICAO address. */
function aircraftName(o: WorldObject): string {
  return (
    stringProp(o, 'callsign', 'flight', 'registration') ??
    (typeof o.properties['icao24'] === 'string' ? o.properties['icao24'].toUpperCase() : 'An aircraft')
  );
}

function what(o: WorldObject, kind: EmergencyKind): string {
  const k = KINDS[kind];
  const squawk = o.properties['squawk'];
  return `${k.label}${k.squawk && squawk === k.squawk ? ` (squawk ${squawk})` : ''}`;
}

export const aircraftEmergencyRule = episodeRule<EmergencyKind>({
  id: 'aircraft-emergency',
  objectType: ObjectTypes.Aircraft,
  eventType: EventTypes.AircraftEmergency,
  quietMs: AIRCRAFT_EMERGENCY_QUIET_MS,
  followMs: AIRCRAFT_EMERGENCY_FOLLOW_MS,
  reopenMs: AIRCRAFT_EMERGENCY_REOPEN_MS,
  stateOf: (o) => emergencyOf(o) ?? 'clear',
  severityOf: (kind) => KINDS[kind].severity,
  titleOf: (o, kind) => `${aircraftName(o)}: ${what(o, kind)}`,
  summaryOf: (o, kind) => `${aircraftName(o)} has broadcast ${what(o, kind)}`,
  caveat: 'As broadcast: a squawk is set by hand and is sometimes set by mistake and cleared within minutes.',
  propertiesOf: (o) => {
    const squawk = o.properties['squawk'];
    const alt = o.position?.altitudeM;
    return {
      name: aircraftName(o),
      ...(typeof squawk === 'string' ? { squawk } : {}),
      ...(alt !== undefined ? { altitudeM: alt } : {}),
    };
  },
  clearText: (at) => `Cleared at ${shortUtc(at)}.`,
});
