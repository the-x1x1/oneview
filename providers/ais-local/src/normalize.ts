import { isValidLatLon, type JsonValue } from '@worldview/world-model';
import type { ObservationDraft } from '@worldview/provider-sdk';
import type { AisMessage, Dimensions } from './aivdm.js';

/**
 * Decoded AIS messages → vessel observation drafts, in the payload the AISStream provider
 * writes (`mmsi`, `speedMps`, `courseDegrees`, `headingDegrees`, `navStatus`, `name`,
 * `callSign`, `shipType`, `lengthM`, …) so a ship heard by both is one object with one
 * vocabulary. DUPLICATED ON PURPOSE from providers/ais/src/normalize.ts (the tables below):
 * providers never import each other.
 *
 * Position reports become observations. Static reports (types 5, 24, and 19's static half)
 * carry no position; they are remembered per MMSI and added to that ship's next position.
 * AIS gives only the second of the minute a position was taken: the observation is dated at
 * the latest moment with that second up to the time of receipt, or at receipt when absent.
 */
export const KNOT_TO_MPS = 0.514444;

export const NAV_STATUS_TEXT: Readonly<Record<number, string>> = Object.freeze({
  0: 'under way using engine',
  1: 'at anchor',
  2: 'not under command',
  3: 'restricted manoeuvrability',
  4: 'constrained by draught',
  5: 'moored',
  6: 'aground',
  7: 'engaged in fishing',
  8: 'under way sailing',
  9: 'reserved (HSC)',
  10: 'reserved (WIG)',
  11: 'power-driven vessel towing astern',
  12: 'power-driven vessel pushing ahead',
  13: 'reserved',
  14: 'AIS-SART / MOB / EPIRB',
});

export function shipTypeText(code: number): string | undefined {
  if (!Number.isInteger(code) || code <= 0 || code > 99) return undefined;
  if (code < 20) return 'reserved';
  if (code < 30) return 'wing in ground';
  const thirties: Record<number, string> = {
    30: 'fishing',
    31: 'towing',
    32: 'towing',
    33: 'dredging',
    34: 'diving operations',
    35: 'military',
    36: 'sailing',
    37: 'pleasure craft',
  };
  if (code < 40) return thirties[code] ?? 'reserved';
  if (code < 50) return 'high-speed craft';
  const fifties: Record<number, string> = {
    50: 'pilot vessel',
    51: 'search and rescue',
    52: 'tug',
    53: 'port tender',
    54: 'anti-pollution',
    55: 'law enforcement',
    58: 'medical transport',
    59: 'non-combatant ship',
  };
  if (code < 60) return fifties[code] ?? 'spare';
  if (code < 70) return 'passenger';
  if (code < 80) return 'cargo';
  if (code < 90) return 'tanker';
  return 'other';
}

export interface StaticInfo {
  name?: string;
  callSign?: string;
  imo?: number;
  shipType?: number;
  dimensions?: Dimensions;
  draughtM?: number;
  destination?: string;
  eta?: { month: number; day: number; hour: number; minute: number };
}

const MAX_SHIPS = 20_000;

/** What each ship has said about itself, bounded (the oldest-heard forgotten first). */
export class StaticStore {
  private readonly byMmsi = new Map<string, StaticInfo>();

  merge(mmsi: string, info: StaticInfo): void {
    const prev = this.byMmsi.get(mmsi);
    this.byMmsi.delete(mmsi);
    this.byMmsi.set(mmsi, { ...prev, ...info });
    if (this.byMmsi.size > MAX_SHIPS) this.byMmsi.delete(this.byMmsi.keys().next().value!);
  }

  get(mmsi: string): StaticInfo | undefined {
    return this.byMmsi.get(mmsi);
  }

  get size(): number {
    return this.byMmsi.size;
  }
}

export function mmsiString(mmsi: number): string | undefined {
  if (!Number.isInteger(mmsi) || mmsi <= 0 || mmsi > 999_999_999) return undefined;
  return String(mmsi).padStart(9, '0');
}

/** The latest instant ≤ `receivedMs` whose UTC second is `second`. */
export function timeFromSecond(receivedMs: number, second: number | undefined): number {
  if (second === undefined) return receivedMs;
  const minute = Math.floor(receivedMs / 60_000) * 60_000;
  const t = minute + second * 1000;
  return t <= receivedMs ? t : t - 60_000;
}

function staticOf(m: AisMessage): StaticInfo | undefined {
  const s: StaticInfo = {};
  if (m.type === 5) {
    if (m.shipName) s.name = m.shipName;
    if (m.callSign) s.callSign = m.callSign;
    if (m.imo) s.imo = m.imo;
    if (m.shipType) s.shipType = m.shipType;
    if (m.dimensions) s.dimensions = m.dimensions;
    if (m.draughtM) s.draughtM = m.draughtM;
    if (m.destination) s.destination = m.destination;
    if (m.eta) s.eta = m.eta;
  } else if (m.type === 24) {
    if (m.part === 'A' && m.shipName) s.name = m.shipName;
    if (m.part === 'B') {
      if (m.shipType) s.shipType = m.shipType;
      if (m.callSign) s.callSign = m.callSign;
      if (m.dimensions) s.dimensions = m.dimensions;
    }
  } else if (m.type === 19) {
    if (m.shipName) s.name = m.shipName;
    if (m.shipType) s.shipType = m.shipType;
    if (m.dimensions) s.dimensions = m.dimensions;
  }
  return Object.keys(s).length ? s : undefined;
}

export type MessageOutcome =
  { kind: 'position'; draft: ObservationDraft } | { kind: 'static' } | { kind: 'skipped'; reason: string };

/** One decoded message: remember what it says about the ship; a position becomes a draft. */
export function messageToDraft(
  m: AisMessage,
  store: StaticStore,
  opts: { receivedMs: number; sourceRef?: string },
): MessageOutcome {
  const mmsi = mmsiString(m.mmsi);
  if (!mmsi) return { kind: 'skipped', reason: 'invalid MMSI' };
  const info = staticOf(m);
  if (info) store.merge(mmsi, info);
  if (m.type === 5 || m.type === 24) return { kind: 'static' };
  if (m.latitude === undefined || m.longitude === undefined || !isValidLatLon(m.latitude, m.longitude))
    return { kind: 'skipped', reason: 'position not available' };

  const payload: Record<string, JsonValue> = { mmsi, aisClass: m.type === 18 || m.type === 19 ? 'B' : 'A' };
  if (m.speedKnots !== undefined && m.speedKnots < 102.3)
    payload['speedMps'] = Math.round(m.speedKnots * KNOT_TO_MPS * 100) / 100;
  if (m.courseDeg !== undefined) payload['courseDegrees'] = m.courseDeg;
  if (m.headingDeg !== undefined) payload['headingDegrees'] = m.headingDeg;
  else if (m.courseDeg !== undefined && (m.speedKnots ?? 0) > 0.5) payload['headingDegrees'] = m.courseDeg;
  if ('navStatus' in m && m.navStatus !== undefined && NAV_STATUS_TEXT[m.navStatus]) {
    payload['navStatus'] = m.navStatus;
    payload['navStatusText'] = NAV_STATUS_TEXT[m.navStatus]!;
  }
  if ('rateOfTurn' in m && m.rateOfTurn !== undefined && Math.abs(m.rateOfTurn) <= 126)
    payload['rateOfTurnDegPerMin'] = Math.round(Math.sign(m.rateOfTurn) * (m.rateOfTurn / 4.733) ** 2 * 10) / 10;
  const s = store.get(mmsi);
  if (s?.name) payload['name'] = s.name;
  if (s?.callSign) payload['callSign'] = s.callSign;
  if (s?.imo) payload['imo'] = String(s.imo);
  if (s?.shipType) {
    payload['shipType'] = s.shipType;
    const label = shipTypeText(s.shipType);
    if (label) payload['shipTypeText'] = label;
  }
  if (s?.destination) payload['destination'] = s.destination;
  if (s?.dimensions) {
    const d = s.dimensions;
    if (d.toBow + d.toStern > 0) payload['lengthM'] = d.toBow + d.toStern;
    if (d.toPort + d.toStarboard > 0) payload['beamM'] = d.toPort + d.toStarboard;
  }
  if (s?.draughtM) payload['draughtM'] = s.draughtM;

  const observedMs = timeFromSecond(opts.receivedMs, m.second);
  const flags: string[] = [];
  if (m.second === undefined) flags.push('time-from-receipt');
  const draft: ObservationDraft = {
    externalId: mmsi,
    objectType: 'vessel',
    observedAt: new Date(observedMs).toISOString(),
    position: { latitude: m.latitude, longitude: m.longitude, altitudeM: 0, altitudeDatum: 'sea-surface' },
    payload,
    quality: {
      complete: s?.name !== undefined,
      sourceQuality: 'authoritative',
      positionAccuracyM: m.accuracy ? 10 : 100,
      ...(flags.length ? { flags } : {}),
    },
    origin: 'local',
  };
  if (opts.sourceRef) draft.sourceRef = opts.sourceRef;
  return { kind: 'position', draft };
}
