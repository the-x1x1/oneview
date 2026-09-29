import { isValidLatLon, type IsoTimestamp, type JsonValue } from '@worldview/world-model';
import type { ObservationDraft } from '@worldview/provider-sdk';
import { KNOT_TO_MPS, NAV_STATUS_TEXT, flagFields, normalizeMmsi, shipTypeText } from '../normalize.js';

/**
 * Digitraffic Marine AIS → vessel observation drafts, in the payload the AISStream and
 * local-receiver providers write (`mmsi`, `flag`, `speedMps`, `courseDegrees`,
 * `headingDegrees`, `navStatus`, `name`, `callSign`, `imo`, `shipType`, `destination`,
 * `eta`, `draughtM`, `lengthM`, `beamM`), so a ship heard by several sources is one object
 * (packages/identity: vessel ← payload.mmsi) described in one vocabulary.
 *
 * Field meanings are Digitraffic's OpenAPI (https://meri.digitraffic.fi/swagger/, read
 * 2026-09-28); they are the raw ITU-R M.1371 values, so the same "not available" sentinels
 * are dropped: SOG 102.3 kn, COG 360°, heading 511, ROT −128. A location is
 *
 *   { type: 'Feature', mmsi, geometry: { type: 'Point', coordinates: [lon, lat] },
 *     properties: { mmsi, sog, cog, navStat, rot, posAcc, raim, heading, timestamp,
 *                   timestampExternal } }
 *
 * where `timestampExternal` is when the report was received (ms since the epoch) and
 * `timestamp` only the second of the minute. Static data is one row per ship:
 *
 *   { mmsi, name, callSign, imo, shipType, draught (1/10 m), eta (bit-packed), destination,
 *     posType, referencePointA…D (m from the antenna), timestamp (ms) }
 *
 * The MQTT feed spells the reference points `refA`…`refD` and the type `type`; both
 * spellings are read, so a recorded MQTT sample normalises the same way.
 */

/** Static data remembered per ship, already in payload vocabulary. */
export type VesselStatic = Readonly<Record<string, JsonValue>>;

export type LocationResult = { kind: 'observation'; draft: ObservationDraft } | { kind: 'rejected'; reason: string };

export interface LocationNormalizeOptions {
  receivedAt: IsoTimestamp;
  /** Now, for rejecting reports dated in the future. */
  nowMs: number;
}

/** A report dated further ahead than this is a clock error at the source, not a position. */
const MAX_FUTURE_MS = 5 * 60_000;
/** AIS position accuracy flag: 1 = better than 10 m (DGNSS), 0 = worse than 10 m. */
const HIGH_ACCURACY_M = 10;
const LOW_ACCURACY_M = 100;

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Six-bit AIS text: trim '@' padding and whitespace; undefined when nothing is left. */
function aisText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.replace(/@+$/g, '').trim();
  return t ? t.slice(0, max) : undefined;
}

/** The feature list of a locations answer, or why the answer is not one. */
export function parseLocations(payload: unknown): unknown[] | string {
  if (!isObject(payload)) return 'locations answer is not an object';
  const features = payload['features'];
  if (!Array.isArray(features)) return 'locations answer has no features array';
  return features;
}

/** The rows of a vessels answer, or why the answer is not one. */
export function parseVessels(payload: unknown): unknown[] | string {
  if (!Array.isArray(payload)) return 'vessels answer is not an array';
  return payload;
}

/**
 * ETA as Digitraffic packs it: "MMDDHHMM UTC; month bits 19-16, day bits 15-11, hour bits
 * 10-6, minute bits 5-0". Month 0 or day 0 is "not available"; hour 24 and minute 60 are too.
 * Same shape as the AISStream provider's `eta` (no year: AIS does not send one).
 */
export function decodeEta(eta: unknown): Record<string, JsonValue> | undefined {
  const v = num(eta);
  if (v === undefined || !Number.isInteger(v) || v <= 0) return undefined;
  const month = (v >> 16) & 0xf;
  const day = (v >> 11) & 0x1f;
  const hour = (v >> 6) & 0x1f;
  const minute = v & 0x3f;
  if (month < 1 || month > 12 || day < 1) return undefined;
  return { month, day, ...(hour <= 23 ? { hour } : {}), ...(minute <= 59 ? { minute } : {}) };
}

/** One static-data row → its MMSI and payload fields; undefined for a row without a usable MMSI. */
export function vesselStatic(row: unknown): { mmsi: string; fields: VesselStatic; timestampMs?: number } | undefined {
  if (!isObject(row)) return undefined;
  const mmsi = normalizeMmsi(row['mmsi']);
  if (!mmsi) return undefined;
  const out: Record<string, JsonValue> = {};
  const name = aisText(row['name'], 40);
  if (name) out['name'] = name;
  const callSign = aisText(row['callSign'], 10);
  if (callSign) out['callSign'] = callSign;
  const imo = num(row['imo']);
  if (imo !== undefined && imo > 0 && Number.isInteger(imo)) out['imo'] = String(imo);
  const type = num(row['shipType'] ?? row['type']);
  if (type !== undefined) {
    const label = shipTypeText(type);
    // 0 is "not available": said by leaving the type out, as the AISStream provider does
    // for everything but an explicit 0 there.
    if (label && type !== 0) {
      out['shipType'] = type;
      out['shipTypeText'] = label;
    }
  }
  const destination = aisText(row['destination'], 40);
  if (destination) out['destination'] = destination;
  const eta = decodeEta(row['eta']);
  if (eta) out['eta'] = eta;
  // Tenths of a metre; 0 is "not available", 255 is "25.5 m or more" (kept as 25.5).
  const draught = num(row['draught']);
  if (draught !== undefined && draught > 0) out['draughtM'] = round(draught / 10, 1);
  const ref = (long: string, short: string) => num(row[long] ?? row[short]) ?? 0;
  const a = ref('referencePointA', 'refA');
  const b = ref('referencePointB', 'refB');
  const c = ref('referencePointC', 'refC');
  const d = ref('referencePointD', 'refD');
  if (a >= 0 && b >= 0 && a + b > 0) out['lengthM'] = a + b;
  if (c >= 0 && d >= 0 && c + d > 0) out['beamM'] = c + d;
  const ts = num(row['timestamp']);
  return { mmsi, fields: out, ...(ts !== undefined && ts > 0 ? { timestampMs: ts } : {}) };
}

/**
 * One location feature → a vessel draft, with the ship's remembered static data (if any)
 * folded into the payload. A feature without a usable MMSI or position is rejected with a
 * reason, never thrown.
 */
export function locationToDraft(
  feature: unknown,
  statics: ReadonlyMap<string, VesselStatic>,
  opts: LocationNormalizeOptions,
): LocationResult {
  if (!isObject(feature)) return { kind: 'rejected', reason: 'feature is not an object' };
  const props = isObject(feature['properties']) ? feature['properties'] : {};
  const mmsi = normalizeMmsi(feature['mmsi'] ?? props['mmsi']);
  if (!mmsi) return { kind: 'rejected', reason: 'invalid MMSI' };
  const geometry = feature['geometry'];
  const coords = isObject(geometry) && Array.isArray(geometry['coordinates']) ? geometry['coordinates'] : undefined;
  const lon = num(coords?.[0]);
  const lat = num(coords?.[1]);
  if (!isValidLatLon(lat, lon) || lat === 91 || lon === 181)
    return { kind: 'rejected', reason: 'position not available' };

  const flags: string[] = [];
  const at = num(props['timestampExternal']);
  let observedAt: IsoTimestamp;
  if (at !== undefined && at > 0) {
    if (at > opts.nowMs + MAX_FUTURE_MS) return { kind: 'rejected', reason: 'report dated in the future' };
    observedAt = new Date(Math.min(at, opts.nowMs)).toISOString();
  } else {
    observedAt = opts.receivedAt;
    flags.push('time-from-receipt');
  }

  // Static data first, so a position's own fields win if the two ever overlap.
  const payload: Record<string, JsonValue> = { ...(statics.get(mmsi) ?? {}), mmsi, ...flagFields(mmsi) };
  const sog = num(props['sog']);
  if (sog !== undefined && sog >= 0 && sog < 102.3) payload['speedMps'] = round(sog * KNOT_TO_MPS, 2);
  const cog = num(props['cog']);
  const course = cog !== undefined && cog >= 0 && cog < 360 ? round(cog, 1) : undefined;
  if (course !== undefined) payload['courseDegrees'] = course;
  const th = num(props['heading']);
  if (th !== undefined && th >= 0 && th < 360) payload['headingDegrees'] = th;
  else if (course !== undefined) {
    payload['headingDegrees'] = course;
    flags.push('heading-from-cog');
  }
  const nav = num(props['navStat']);
  if (nav !== undefined && Number.isInteger(nav) && nav >= 0 && nav <= 15) {
    payload['navStatus'] = nav;
    payload['navStatusText'] = NAV_STATUS_TEXT[nav]!;
  }
  const rot = num(props['rot']);
  if (rot !== undefined && rot > -127 && rot < 127)
    payload['rateOfTurnDegPerMin'] = round(Math.sign(rot) * (rot / 4.733) ** 2, 1);
  else if (rot === 127 || rot === -127) flags.push(rot > 0 ? 'turning-right' : 'turning-left');

  const posAcc = props['posAcc'];
  const draft: ObservationDraft = {
    externalId: mmsi,
    objectType: 'vessel',
    observedAt,
    payload,
    position: { latitude: lat as number, longitude: lon as number, altitudeM: 0, altitudeDatum: 'sea-surface' },
    quality: {
      complete: true,
      // Fintraffic's own coastal base stations, not a volunteer network. What the ship
      // broadcasts is still the ship's own claim; the confidence model weighs that in the
      // same way for every AIS source.
      sourceQuality: 'authoritative',
      ...(typeof posAcc === 'boolean' ? { positionAccuracyM: posAcc ? HIGH_ACCURACY_M : LOW_ACCURACY_M } : {}),
      ...(flags.length ? { flags } : {}),
    },
    origin: 'live',
  };
  return { kind: 'observation', draft };
}
