import { isValidLatLon, type GeoPosition, type JsonValue, type Observation } from '@worldview/world-model';
import { buildObservation, type ObservationDraft, type ProviderManifest } from '@worldview/provider-sdk';

/**
 * A PurpleAir sensor's local `/json` → one sensor observation.
 *
 * Fields as PurpleAir documents them (https://community.purpleair.com/t/sensor-json-documentation/6917):
 * `SensorId` (the MAC address), `DateTime` (UTC), `lat`/`lon` (roughly the registered
 * position), `place` (`inside`/`outside`), per laser channel A and B (`_b`) the mass
 * concentrations `pm1_0_*`, `pm2_5_*`, `pm10_0_*` in µg/m³ under the ATM and CF=1 density
 * estimates and the device's US EPA PM2.5 AQI (`pm2.5_aqi`), and the BME sensor's uncorrected
 * `current_temp_f`, `current_humidity`, `current_dewpoint_f` and `pressure` (millibar).
 *
 * Which estimate: ATM outdoors, CF=1 indoors — the convention PurpleAir's own AQI follows.
 * Two channels are averaged when both read; when they disagree by more than 5 µg/m³ *and*
 * 70 % (the A/B consistency check of Barkjohn et al. 2021, used for the U.S. EPA's Fire and
 * Smoke Map) the observation is flagged `channels-disagree` and both are kept. The sensor's
 * temperature reads high (the case warms it); it is reported as measured and labelled
 * uncorrected, never adjusted here.
 */
export interface PurpleAirNormalizeOptions {
  receivedAt: string;
  nowMs: number;
  /** A position the user set; otherwise the sensor's own. */
  position?: GeoPosition;
  name: string;
  sourceRef?: string;
  hash?: (s: string) => string;
}

export type PurpleAirResult = { observation: Observation } | { error: string };

const FUTURE_SKEW_MS = 10 * 60_000;

function num(r: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = r[key];
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined;
}

const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;
const fToC = (f: number) => round(((f - 32) * 5) / 9, 1);

/** "2026/09/23T21:48:10z" (the firmware's form) or ISO 8601 → epoch ms. */
export function parseSensorTime(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const m = /^(\d{4})[/-](\d{2})[/-](\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:z|Z|\+00:00)$/.exec(v.trim());
  if (!m) return undefined;
  const t = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
  return Number.isFinite(t) ? t : undefined;
}

/** The MAC address as an id: twelve hex digits, lower case. */
export function sensorKey(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const hex = v.toLowerCase().replace(/[:\-\s]/g, '');
  return /^[0-9a-f]{12}$/.test(hex) ? hex : undefined;
}

/** Channels A and B combined: the mean, and whether they agree. */
export function combineChannels(
  a: number | undefined,
  b: number | undefined,
): { value: number; agreement: 'agree' | 'disagree' | 'single' } | undefined {
  if (a === undefined && b === undefined) return undefined;
  if (a === undefined || b === undefined) return { value: (a ?? b)!, agreement: 'single' };
  const diff = Math.abs(a - b);
  const mean = (a + b) / 2;
  const disagree = diff > 5 && mean > 0 && diff / mean > 0.7;
  return { value: mean, agreement: disagree ? 'disagree' : 'agree' };
}

const PM_MAX = 2000;

export function normalizeSensorJson(
  payload: unknown,
  manifest: ProviderManifest,
  opts: PurpleAirNormalizeOptions,
): PurpleAirResult {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return { error: 'not a sensor /json response' };
  const r = payload as Record<string, unknown>;
  const key = sensorKey(r['SensorId']);
  if (!key) return { error: 'missing or invalid SensorId' };
  const place = r['place'] === 'inside' ? 'indoor' : r['place'] === 'outside' ? 'outdoor' : undefined;
  const indoor = place === 'indoor';

  const own = { latitude: r['lat'], longitude: r['lon'] };
  const reported =
    typeof own.latitude === 'number' &&
    typeof own.longitude === 'number' &&
    isValidLatLon(own.latitude, own.longitude) &&
    !(own.latitude === 0 && own.longitude === 0)
      ? { latitude: own.latitude, longitude: own.longitude }
      : undefined;
  const position = opts.position ?? reported;
  if (!position || !isValidLatLon(position.latitude, position.longitude))
    return { error: 'the sensor reports no position: set its latitude and longitude in this source’s settings' };

  let observedMs = parseSensorTime(r['DateTime']);
  const flags: string[] = [];
  if (observedMs === undefined) {
    observedMs = opts.nowMs;
    flags.push('fetch-time');
  } else if (observedMs > opts.nowMs + FUTURE_SKEW_MS) return { error: 'DateTime is in the future (sensor clock?)' };

  const est = indoor ? 'cf_1' : 'atm';
  const pm = (size: '1_0' | '2_5' | '10_0') =>
    combineChannels(num(r, `pm${size}_${est}`, 0, PM_MAX), num(r, `pm${size}_${est}_b`, 0, PM_MAX));
  const pm25 = pm('2_5');
  if (!pm25) return { error: 'no PM2.5 reading' };

  const out: Record<string, JsonValue> = {
    name: opts.name,
    sensorId: key,
    sensorKind: 'air-quality',
    pm25Ugm3: round(pm25.value, 1),
    pmEstimate: indoor ? 'CF=1' : 'ATM',
    channels: pm25.agreement,
  };
  if (place) out['placement'] = place;
  if (pm25.agreement !== 'single') {
    out['pm25AUgm3'] = round(num(r, `pm2_5_${est}`, 0, PM_MAX)!, 1);
    out['pm25BUgm3'] = round(num(r, `pm2_5_${est}_b`, 0, PM_MAX)!, 1);
  }
  if (pm25.agreement === 'disagree') flags.push('channels-disagree');
  const pm10 = pm('10_0');
  if (pm10) out['pm10Ugm3'] = round(pm10.value, 1);
  const pm1 = pm('1_0');
  if (pm1) out['pm1Ugm3'] = round(pm1.value, 1);
  const aqi = combineChannels(num(r, 'pm2.5_aqi', 0, 999), num(r, 'pm2.5_aqi_b', 0, 999));
  if (aqi) out['aqiUs'] = Math.round(aqi.value);
  const t = num(r, 'current_temp_f', -60, 200);
  if (t !== undefined) out['temperatureC'] = fToC(t);
  const hum = num(r, 'current_humidity', 0, 100);
  if (hum !== undefined) out['humidityPct'] = round(hum, 1);
  const dew = num(r, 'current_dewpoint_f', -100, 200);
  if (dew !== undefined) out['dewPointC'] = fToC(dew);
  const p = num(r, 'pressure', 300, 1100);
  if (p !== undefined) out['pressureHpa'] = round(p, 1);
  if (indoor) flags.push('indoor');

  const draft: ObservationDraft = {
    externalId: key,
    objectType: 'sensor',
    observedAt: new Date(observedMs).toISOString(),
    position: { latitude: position.latitude, longitude: position.longitude },
    payload: out,
    quality: {
      complete: aqi !== undefined,
      sourceQuality: 'authoritative',
      ...(flags.length ? { flags } : {}),
    },
    origin: 'local',
  };
  if (opts.sourceRef) draft.sourceRef = opts.sourceRef;
  if (opts.hash) draft.rawPayloadHash = opts.hash(JSON.stringify(payload));
  return { observation: buildObservation(manifest, opts.receivedAt, draft) };
}
