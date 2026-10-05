import { isValidLatLon, mmsiFlag, type JsonValue } from '@worldview/world-model';
import type { ObservationDraft } from '@worldview/provider-sdk';
import type { AisPositionMessage, AisStaticMessage, N2kMessage } from './pgns.js';

/**
 * What the boat's own network says, turned into map objects: the boat itself — its GNSS
 * position, course and speed over ground, heading, depth, wind, water and air temperature and
 * pressure, whichever its instruments send — and the ships its AIS receiver hears.
 *
 * The AIS vocabulary (payload keys, navigation status and ship type words, flag fields) is the
 * one the AIS providers write, DUPLICATED ON PURPOSE from providers/ais-local/src/normalize.ts:
 * providers never import each other.
 */

const MPS_TO_KNOTS = 1 / 0.514444;

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

export function mmsiString(mmsi: number): string | undefined {
  if (!Number.isInteger(mmsi) || mmsi <= 0 || mmsi > 999_999_999) return undefined;
  return String(mmsi).padStart(9, '0');
}

function flagFields(mmsi: string): Record<string, JsonValue> {
  const f = mmsiFlag(mmsi);
  if (!f) return {};
  const out: Record<string, JsonValue> = {};
  if (f.kind !== 'ship') out['mmsiKind'] = f.kind;
  if (f.country && f.mid) {
    out['flag'] = f.country;
    out['flagMid'] = f.mid;
  }
  return out;
}

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;
const norm360 = (d: number) => ((d % 360) + 360) % 360;

// ---- the boat itself ---------------------------------------------------------------------

/** How long a reading stays part of the boat's picture after its instrument goes quiet. */
export const READING_TTL_MS = 60_000;
/** Positions from another device are taken only once the one in use has been quiet this long. */
export const POSITION_SOURCE_HOLD_MS = 30_000;

interface Stamped<T> {
  value: T;
  at: number;
}

/**
 * The own boat's latest picture, merged from every instrument on the bus. Position comes from
 * one device at a time — the first heard, until it is quiet for `POSITION_SOURCE_HOLD_MS` —
 * so two GNSS receivers a few metres apart do not make the boat jitter; GNSS position data
 * (129029) is preferred to the rapid update (129025) from the same device. Each other reading
 * is dropped `READING_TTL_MS` after it was last sent.
 */
export class OwnVessel {
  private position?: Stamped<{
    latitude: number;
    longitude: number;
    source: number;
    precise: boolean;
    fixTime?: number;
    satellites?: number;
    hdop?: number;
  }>;
  private course?: Stamped<{ courseDeg?: number; magnetic: boolean; speedMps?: number }>;
  private heading?: Stamped<{ headingDeg: number; magnetic: boolean; variationDeg?: number }>;
  private variation?: Stamped<number>;
  private depth?: Stamped<{ depthM: number; offsetM?: number }>;
  private stw?: Stamped<number>;
  private apparentWind?: Stamped<{ speedMps?: number; angleDeg?: number }>;
  private trueWind?: Stamped<{ speedMps?: number; directionDeg?: number }>;
  private water?: Stamped<number>;
  private air?: Stamped<number>;
  private pressure?: Stamped<number>;

  /** Take one message in; true when it changed what the boat's object would say. */
  update(message: N2kMessage, source: number, nowMs: number): boolean {
    switch (message.kind) {
      case 'position': {
        const cur = this.position;
        const sameSource = cur?.value.source === source;
        if (cur && !sameSource && nowMs - cur.at < POSITION_SOURCE_HOLD_MS) return false;
        // From the same device, a rapid update does not overwrite a fresher precise fix's extras.
        if (cur && sameSource && cur.value.precise && !message.precise && nowMs - cur.at < 2_000) {
          cur.value = { ...cur.value, latitude: message.latitude, longitude: message.longitude };
          cur.at = nowMs;
          return true;
        }
        this.position = {
          value: {
            latitude: message.latitude,
            longitude: message.longitude,
            source,
            precise: message.precise === true,
            ...(message.fixTime !== undefined ? { fixTime: message.fixTime } : {}),
            ...(message.satellites !== undefined ? { satellites: message.satellites } : {}),
            ...(message.hdop !== undefined ? { hdop: message.hdop } : {}),
          },
          at: nowMs,
        };
        return true;
      }
      case 'course':
        this.course = { value: { ...message }, at: nowMs };
        return true;
      case 'heading':
        if (message.variationDeg !== undefined) this.variation = { value: message.variationDeg, at: nowMs };
        if (message.headingDeg === undefined) return false;
        this.heading = {
          value: {
            headingDeg: message.headingDeg,
            magnetic: message.magnetic,
            ...(message.variationDeg !== undefined ? { variationDeg: message.variationDeg } : {}),
          },
          at: nowMs,
        };
        return true;
      case 'depth':
        if (message.depthM === undefined) return false;
        this.depth = {
          value: { depthM: message.depthM, ...(message.offsetM !== undefined ? { offsetM: message.offsetM } : {}) },
          at: nowMs,
        };
        return true;
      case 'speed':
        if (message.throughWaterMps === undefined) return false;
        this.stw = { value: message.throughWaterMps, at: nowMs };
        return true;
      case 'wind':
        if (message.reference === 2) {
          this.apparentWind = {
            value: {
              ...(message.speedMps !== undefined ? { speedMps: message.speedMps } : {}),
              ...(message.angleDeg !== undefined ? { angleDeg: message.angleDeg } : {}),
            },
            at: nowMs,
          };
          return true;
        }
        // True wind referenced to true north over the ground (0), or to magnetic north (1).
        if (message.reference === 0 || message.reference === 1) {
          let direction = message.angleDeg;
          if (direction !== undefined && message.reference === 1) {
            const variation = this.fresh(this.variation, nowMs);
            direction = variation === undefined ? undefined : norm360(direction + variation);
          }
          this.trueWind = {
            value: {
              ...(message.speedMps !== undefined ? { speedMps: message.speedMps } : {}),
              ...(direction !== undefined ? { directionDeg: direction } : {}),
            },
            at: nowMs,
          };
          return true;
        }
        return false;
      case 'environment': {
        let changed = false;
        if (message.waterTemperatureC !== undefined) {
          this.water = { value: message.waterTemperatureC, at: nowMs };
          changed = true;
        }
        if (message.airTemperatureC !== undefined) {
          this.air = { value: message.airTemperatureC, at: nowMs };
          changed = true;
        }
        if (message.pressureHpa !== undefined) {
          this.pressure = { value: message.pressureHpa, at: nowMs };
          changed = true;
        }
        return changed;
      }
      default:
        return false;
    }
  }

  private fresh<T>(s: Stamped<T> | undefined, nowMs: number): T | undefined {
    return s && nowMs - s.at <= READING_TTL_MS ? s.value : undefined;
  }

  /**
   * When the newest reading in the picture was heard: the boat's object is dated by it, so each
   * update the provider sends (at most one a second) carries a time of its own.
   */
  private newest(nowMs: number): number {
    let t = this.position!.at;
    for (const r of [
      this.course,
      this.heading,
      this.depth,
      this.stw,
      this.apparentWind,
      this.trueWind,
      this.water,
      this.air,
      this.pressure,
    ])
      if (r && nowMs - r.at <= READING_TTL_MS && r.at > t) t = r.at;
    return t;
  }

  /** The boat as a draft, or undefined until a position has been heard (or it has gone quiet). */
  draft(
    nowMs: number,
    opts: { externalId: string; name: string; mmsi?: string; sourceRef?: string },
  ): ObservationDraft | undefined {
    const p = this.fresh(this.position, nowMs);
    if (!p || !isValidLatLon(p.latitude, p.longitude)) return undefined;
    const payload: Record<string, JsonValue> = { name: opts.name, ownVessel: true, positionSource: p.source };
    if (opts.mmsi) {
      payload['mmsi'] = opts.mmsi;
      Object.assign(payload, flagFields(opts.mmsi));
    }
    if (p.satellites !== undefined) payload['gnssSatellites'] = p.satellites;
    if (p.hdop !== undefined) payload['gnssHdop'] = p.hdop;

    const variation = this.fresh(this.variation, nowMs);
    const course = this.fresh(this.course, nowMs);
    if (course?.speedMps !== undefined) payload['speedMps'] = round(course.speedMps, 2);
    if (course?.courseDeg !== undefined) {
      const cog = course.magnetic
        ? variation === undefined
          ? undefined
          : norm360(course.courseDeg + variation)
        : course.courseDeg;
      if (cog !== undefined) payload['courseDegrees'] = round(cog, 1);
    }
    const heading = this.fresh(this.heading, nowMs);
    if (heading) {
      const v = heading.variationDeg ?? variation;
      const hdg = heading.magnetic
        ? v === undefined
          ? undefined
          : norm360(heading.headingDeg + v)
        : heading.headingDeg;
      if (hdg !== undefined) payload['headingDegrees'] = round(hdg, 1);
    } else if (payload['courseDegrees'] !== undefined && (course?.speedMps ?? 0) > 0.5) {
      payload['headingDegrees'] = payload['courseDegrees'];
    }
    if (variation !== undefined) payload['magneticVariationDeg'] = round(variation, 1);
    const depth = this.fresh(this.depth, nowMs);
    if (depth) {
      payload['depthM'] = depth.depthM;
      if (depth.offsetM !== undefined) {
        payload['depthOffsetM'] = depth.offsetM;
        if (depth.offsetM > 0) payload['depthBelowSurfaceM'] = round(depth.depthM + depth.offsetM, 2);
        else if (depth.offsetM < 0) payload['depthBelowKeelM'] = round(depth.depthM + depth.offsetM, 2);
      }
    }
    const stw = this.fresh(this.stw, nowMs);
    if (stw !== undefined) payload['speedThroughWaterMps'] = stw;
    const aw = this.fresh(this.apparentWind, nowMs);
    if (aw?.speedMps !== undefined) payload['apparentWindSpeedMps'] = aw.speedMps;
    if (aw?.angleDeg !== undefined) payload['apparentWindAngleDeg'] = round(aw.angleDeg, 1);
    const tw = this.fresh(this.trueWind, nowMs);
    if (tw?.speedMps !== undefined) payload['windSpeedMps'] = tw.speedMps;
    if (tw?.directionDeg !== undefined) payload['windDirectionDegrees'] = round(tw.directionDeg, 1);
    const water = this.fresh(this.water, nowMs);
    if (water !== undefined) payload['waterTemperatureC'] = water;
    const air = this.fresh(this.air, nowMs);
    if (air !== undefined) payload['temperatureC'] = air;
    const pressure = this.fresh(this.pressure, nowMs);
    if (pressure !== undefined) payload['pressureHpa'] = pressure;

    const draft: ObservationDraft = {
      externalId: opts.externalId,
      objectType: 'vessel',
      observedAt: new Date(this.newest(nowMs)).toISOString(),
      position: { latitude: p.latitude, longitude: p.longitude, altitudeM: 0, altitudeDatum: 'sea-surface' },
      payload,
      quality: {
        complete: true,
        sourceQuality: 'authoritative',
        ...(p.hdop !== undefined ? { positionAccuracyM: Math.max(2, Math.round(p.hdop * 5)) } : {}),
      },
      origin: 'local',
    };
    if (opts.sourceRef) draft.sourceRef = opts.sourceRef;
    return draft;
  }
}

// ---- ships the boat's AIS hears -------------------------------------------------------------

export interface StaticInfo {
  name?: string;
  callSign?: string;
  imo?: number;
  shipType?: number;
  lengthM?: number;
  beamM?: number;
  draughtM?: number;
  destination?: string;
  eta?: { month: number; day: number; hour: number; minute: number };
}

const MAX_SHIPS = 20_000;

/** What each ship has said about itself, bounded (the oldest heard forgotten first). */
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

/** A 129794/129809/129810 message as what it says about the ship. */
export function staticInfo(m: AisStaticMessage): StaticInfo {
  const s: StaticInfo = {};
  if (m.name) s.name = m.name;
  if (m.callSign) s.callSign = m.callSign;
  if (m.imo) s.imo = m.imo;
  if (m.shipType) s.shipType = m.shipType;
  if (m.lengthM) s.lengthM = m.lengthM;
  if (m.beamM) s.beamM = m.beamM;
  if (m.draughtM) s.draughtM = m.draughtM;
  if (m.destination) s.destination = m.destination;
  if (m.etaDays !== undefined && m.etaDays > 0) {
    // An AIS ETA has no year; the panel shows month, day and time as the crew entered them.
    const d = new Date(m.etaDays * 86_400_000 + Math.round((m.etaSeconds ?? 0) * 1000));
    s.eta = { month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
  }
  return s;
}

/** The latest instant ≤ `receivedMs` whose UTC second is `second`. */
export function timeFromSecond(receivedMs: number, second: number | undefined): number {
  if (second === undefined) return receivedMs;
  const minute = Math.floor(receivedMs / 60_000) * 60_000;
  const t = minute + second * 1000;
  return t <= receivedMs ? t : t - 60_000;
}

/** An AIS position report heard on the bus as a ship draft (with what it said about itself). */
export function aisDraft(
  m: AisPositionMessage,
  store: StaticStore,
  opts: { receivedMs: number; sourceRef?: string },
): ObservationDraft | undefined {
  const mmsi = mmsiString(m.mmsi);
  if (!mmsi || m.latitude === undefined || m.longitude === undefined || !isValidLatLon(m.latitude, m.longitude))
    return undefined;
  const payload: Record<string, JsonValue> = { mmsi, aisClass: m.aisClass, ...flagFields(mmsi) };
  if (m.speedMps !== undefined && m.speedMps * MPS_TO_KNOTS < 102.3) payload['speedMps'] = round(m.speedMps, 2);
  if (m.courseDeg !== undefined) payload['courseDegrees'] = round(m.courseDeg, 1);
  if (m.headingDeg !== undefined) payload['headingDegrees'] = round(m.headingDeg, 1);
  else if (m.courseDeg !== undefined && (m.speedMps ?? 0) * MPS_TO_KNOTS > 0.5)
    payload['headingDegrees'] = round(m.courseDeg, 1);
  if (m.navStatus !== undefined && NAV_STATUS_TEXT[m.navStatus]) {
    payload['navStatus'] = m.navStatus;
    payload['navStatusText'] = NAV_STATUS_TEXT[m.navStatus]!;
  }
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
  if (s?.lengthM) payload['lengthM'] = round(s.lengthM, 1);
  if (s?.beamM) payload['beamM'] = round(s.beamM, 1);
  if (s?.draughtM) payload['draughtM'] = s.draughtM;
  if (s?.eta) payload['eta'] = { ...s.eta };
  const flags = m.second === undefined ? ['time-from-receipt'] : [];
  const draft: ObservationDraft = {
    externalId: mmsi,
    objectType: 'vessel',
    observedAt: new Date(timeFromSecond(opts.receivedMs, m.second)).toISOString(),
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
  return draft;
}
