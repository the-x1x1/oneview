import { isValidLatLon, type IsoTimestamp, type JsonValue } from '@worldview/world-model';
import type { ObservationDraft } from '@worldview/provider-sdk';
import { parseAisTimestamp } from './time.js';

/**
 * AISStream envelope → observation draft.
 *
 *   { MessageType, MetaData: { MMSI, ShipName, latitude, longitude, time_utc },
 *     Message: { PositionReport: {...} | ShipStaticData: {...} } }
 *
 * ITU-R M.1371 "not available" sentinels are dropped rather than emitted: SOG 102.3 kt,
 * COG 360°, heading 511, ROT −128, lat 91 / lon 181. Field mapping adapted from
 * gods-eye-view server/providers/vessels/ais-store.js (MIT).
 */
export const KNOT_TO_MPS = 0.514444;

export type AisFrameResult =
  | { kind: 'observation'; draft: ObservationDraft; messageType: string }
  | { kind: 'ignored'; messageType: string }
  | { kind: 'error'; auth: boolean; message: string }
  | { kind: 'malformed'; reason: string };

export interface AisNormalizeOptions {
  receivedAt: IsoTimestamp;
}

const MMSI_DIGITS = /^\d{1,9}$/;
const POSITION_TYPES = new Set(['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'LongRangeAisBroadcastMessage']);
const STATIC_TYPES = new Set(['ShipStaticData', 'StaticDataReport']);

export const NAV_STATUS_TEXT: Readonly<Record<number, string>> = Object.freeze({
  0: 'under way using engine', 1: 'at anchor', 2: 'not under command', 3: 'restricted manoeuvrability', 4: 'constrained by draught',
  5: 'moored', 6: 'aground', 7: 'engaged in fishing', 8: 'under way sailing', 9: 'reserved (HSC)', 10: 'reserved (WIG)',
  11: 'power-driven vessel towing astern', 12: 'power-driven vessel pushing ahead', 13: 'reserved', 14: 'AIS-SART / MOB / EPIRB', 15: 'not defined',
});

/** Coarse ITU ship-type classes (first digit of the two-digit code, with the 50s spelled out). */
export function shipTypeText(code: number): string | undefined {
  if (!Number.isInteger(code) || code < 0 || code > 99) return undefined;
  if (code === 0) return 'not available';
  if (code < 20) return 'reserved';
  if (code < 30) return 'wing in ground';
  if (code === 30) return 'fishing';
  if (code === 31 || code === 32) return 'towing';
  if (code === 33) return 'dredging';
  if (code === 34) return 'diving operations';
  if (code === 35) return 'military';
  if (code === 36) return 'sailing';
  if (code === 37) return 'pleasure craft';
  if (code < 40) return 'reserved';
  if (code < 50) return 'high-speed craft';
  const fifties: Record<number, string> = { 50: 'pilot vessel', 51: 'search and rescue', 52: 'tug', 53: 'port tender', 54: 'anti-pollution', 55: 'law enforcement', 56: 'spare', 57: 'spare', 58: 'medical transport', 59: 'non-combatant ship' };
  if (code < 60) return fifties[code];
  if (code < 70) return 'passenger';
  if (code < 80) return 'cargo';
  if (code < 90) return 'tanker';
  return 'other';
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** AIS text fields are '@'-padded six-bit strings; trim padding and whitespace. */
function aisText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.replace(/@+$/g, '').trim();
  return t ? t.slice(0, max) : undefined;
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Decode a websocket frame into JSON; undefined when it is not valid JSON. */
export function decodeAisFrame(data: string | Uint8Array): unknown {
  const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

export function normalizeMmsi(v: unknown): string | undefined {
  const s = typeof v === 'number' && Number.isInteger(v) && v >= 0 ? String(v) : typeof v === 'string' ? v.trim() : '';
  if (!MMSI_DIGITS.test(s)) return undefined;
  const padded = s.padStart(9, '0');
  return padded === '000000000' ? undefined : padded;
}

export function normalizeAisEnvelope(raw: unknown, opts: AisNormalizeOptions): AisFrameResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'malformed', reason: 'envelope is not an object' };
  const env = raw as Record<string, unknown>;
  if (typeof env['error'] === 'string') {
    const message = env['error'].slice(0, 200);
    return { kind: 'error', auth: /api\s*key|unauthori[sz]ed|forbidden|invalid key/i.test(message), message };
  }
  const messageType = typeof env['MessageType'] === 'string' ? env['MessageType'] : undefined;
  if (!messageType) return { kind: 'malformed', reason: 'missing MessageType' };
  const meta = (env['MetaData'] ?? env['Metadata']) as Record<string, unknown> | undefined;
  if (!meta || typeof meta !== 'object') return { kind: 'malformed', reason: 'missing MetaData' };
  const messages = env['Message'] as Record<string, unknown> | undefined;
  const message = messages && typeof messages === 'object' ? (messages[messageType] as Record<string, unknown> | undefined) : undefined;
  if (!message || typeof message !== 'object') return { kind: 'malformed', reason: `missing Message.${messageType}` };

  const mmsi = normalizeMmsi(meta['MMSI'] ?? message['UserID']);
  if (!mmsi) return { kind: 'malformed', reason: 'invalid MMSI' };

  const isPosition = POSITION_TYPES.has(messageType);
  const isStatic = STATIC_TYPES.has(messageType);
  if (!isPosition && !isStatic) return { kind: 'ignored', messageType };

  const flags: string[] = [];
  let observedAt = parseAisTimestamp(meta['time_utc'] ?? meta['TimeUtc']);
  if (!observedAt) { observedAt = opts.receivedAt; flags.push('time-from-receipt'); }

  const lat = num(meta['latitude'] ?? meta['Latitude'] ?? message['Latitude']);
  const lon = num(meta['longitude'] ?? meta['Longitude'] ?? message['Longitude']);
  const hasPosition = isValidLatLon(lat, lon) && !(lat === 91 || lon === 181);
  if (isPosition && !hasPosition) return { kind: 'malformed', reason: 'position not available' };

  const payload: Record<string, JsonValue> = { mmsi };
  const name = aisText(meta['ShipName'], 40) ?? aisText(message['Name'], 40);
  if (name) payload['name'] = name;

  if (isPosition) {
    const sog = num(message['Sog'] ?? message['SOG']);
    if (sog !== undefined && sog >= 0 && sog < 102.3) payload['speedMps'] = round(sog * KNOT_TO_MPS, 2);
    const cog = num(message['Cog'] ?? message['COG']);
    const course = cog !== undefined && cog >= 0 && cog < 360 ? round(cog, 1) : undefined;
    if (course !== undefined) payload['courseDegrees'] = course;
    const th = num(message['TrueHeading'] ?? message['Heading']);
    const heading = th !== undefined && th >= 0 && th < 360 ? th : undefined;
    if (heading !== undefined) payload['headingDegrees'] = heading;
    else if (course !== undefined) { payload['headingDegrees'] = course; flags.push('heading-from-cog'); }
    const nav = num(message['NavigationalStatus']);
    if (nav !== undefined && Number.isInteger(nav) && nav >= 0 && nav <= 15) { payload['navStatus'] = nav; payload['navStatusText'] = NAV_STATUS_TEXT[nav]!; }
    const rot = num(message['RateOfTurn']);
    if (rot !== undefined && rot > -127 && rot < 127) payload['rateOfTurnDegPerMin'] = round(Math.sign(rot) * (rot / 4.733) ** 2, 1);
    else if (rot === 127 || rot === -127) flags.push(rot > 0 ? 'turning-right' : 'turning-left');
  } else {
    flags.push('static-data');
    const imo = num(message['ImoNumber']); if (imo !== undefined && imo > 0) payload['imo'] = String(Math.trunc(imo));
    const callSign = aisText(message['CallSign'], 10); if (callSign) payload['callSign'] = callSign;
    const type = num(message['Type']);
    if (type !== undefined) { const label = shipTypeText(type); if (label) { payload['shipType'] = type; payload['shipTypeText'] = label; } }
    const destination = aisText(message['Destination'], 40); if (destination) payload['destination'] = destination;
    const dim = message['Dimension'] as Record<string, unknown> | undefined;
    if (dim && typeof dim === 'object') {
      const a = num(dim['A']) ?? 0, b = num(dim['B']) ?? 0, c = num(dim['C']) ?? 0, d = num(dim['D']) ?? 0;
      if (a + b > 0) payload['lengthM'] = a + b;
      if (c + d > 0) payload['beamM'] = c + d;
    }
    const draught = num(message['MaximumStaticDraught']); if (draught !== undefined && draught > 0) payload['draughtM'] = round(draught, 1);
    const eta = message['Eta'] as Record<string, unknown> | undefined;
    if (eta && typeof eta === 'object') {
      const month = num(eta['Month']), day = num(eta['Day']), hour = num(eta['Hour']), minute = num(eta['Minute']);
      if (month !== undefined && month >= 1 && month <= 12 && day !== undefined && day >= 1 && day <= 31) {
        payload['eta'] = { month, day, ...(hour !== undefined && hour <= 23 ? { hour } : {}), ...(minute !== undefined && minute <= 59 ? { minute } : {}) };
      }
    }
  }

  const draft: ObservationDraft = {
    externalId: mmsi,
    objectType: 'vessel',
    observedAt,
    payload,
    quality: { complete: isPosition, sourceQuality: 'crowdsourced', ...(flags.length ? { flags } : {}) },
    origin: 'live',
  };
  if (hasPosition) draft.position = { latitude: lat as number, longitude: lon as number, altitudeM: 0, altitudeDatum: 'sea-surface' };
  return { kind: 'observation', draft, messageType };
}
