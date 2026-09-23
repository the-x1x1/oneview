import { isValidLatLon, type GeoPosition, type JsonValue, type Observation } from '@worldview/world-model';
import { buildObservation, type ObservationDraft, type ProviderManifest } from '@worldview/provider-sdk';

/**
 * WeatherLink Live `/v1/current_conditions` → weather-station observations.
 *
 * The response is `{ data: { did, ts, conditions: [...] }, error }`; each condition record
 * carries a `data_structure_type`:
 *   1  ISS (the outdoor sensor suite, one per transmitter id) — becomes one station
 *   3  the device's barometer — its pressure is added to every station
 *   2  leaf/soil and 4 indoor temperature/humidity — not used: soil probes are not a map
 *      reading, and the inside of the user's house is nobody's weather
 *
 * Davis reports in US units, named here once and converted to SI in the payload (the world
 * model's convention): °F, mph, inches of mercury, and rain in "counts" of the collector's
 * size (`rain_size` 1 = 0.01 in, 2 = 0.2 mm, 3 = 0.1 mm, 4 = 0.001 in). A reading the device
 * sends as null, or out of any physical range, is left out rather than guessed.
 */
export const MPH_TO_MPS = 0.44704;
export const INHG_TO_HPA = 33.8639;
export const RAIN_COUNT_MM: Readonly<Record<number, number>> = Object.freeze({
  1: 0.254,
  2: 0.2,
  3: 0.1,
  4: 0.0254,
});
const FUTURE_SKEW_MS = 10 * 60_000;
const DEVICE_ID = /^[0-9a-z]{4,32}$/i;

export interface ParsedConditions {
  did: string;
  tsMs: number;
  conditions: unknown[];
}

/** The response envelope, or why it is not one. */
export function parseCurrentConditions(payload: unknown): ParsedConditions | string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'not a current_conditions response';
  const root = payload as Record<string, unknown>;
  const error = root['error'];
  if (error !== null && error !== undefined) {
    const e = (typeof error === 'object' ? error : {}) as Record<string, unknown>;
    const code = typeof e['code'] === 'number' ? ` ${e['code']}` : '';
    const message = typeof e['message'] === 'string' ? `: ${e['message'].slice(0, 120)}` : '';
    return `the device reported an error${code}${message}`;
  }
  const data = root['data'];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'not a current_conditions response (no data)';
  const d = data as Record<string, unknown>;
  const did = typeof d['did'] === 'string' ? d['did'].trim() : '';
  if (!DEVICE_ID.test(did)) return 'missing or invalid device id';
  const ts = d['ts'];
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return 'missing or invalid ts';
  if (!Array.isArray(d['conditions'])) return 'conditions is not a list';
  return { did: did.toLowerCase(), tsMs: Math.round(ts * 1000), conditions: d['conditions'] };
}

export interface StationNormalizeOptions {
  receivedAt: string;
  nowMs: number;
  position: GeoPosition;
  name: string;
  sourceRef?: string;
  hash?: (s: string) => string;
}

export interface StationNormalizeResult {
  observations: Observation[];
  /** ISS records seen (the rows admission is judged on). */
  total: number;
  rejected: Array<{ index: number; reason: string }>;
}

function num(r: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = r[key];
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined;
}

const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;
const fToC = (f: number) => round(((f - 32) * 5) / 9, 1);

function tempC(r: Record<string, unknown>, key: string): number | undefined {
  const f = num(r, key, -100, 160);
  return f === undefined ? undefined : fToC(f);
}

/** An ISS record's readings in SI, or why it has none. */
function issReadings(r: Record<string, unknown>): Record<string, JsonValue> | string {
  const out: Record<string, JsonValue> = {};
  const t = tempC(r, 'temp');
  if (t !== undefined) out['temperatureC'] = t;
  const hum = num(r, 'hum', 0, 100);
  if (hum !== undefined) out['humidityPct'] = round(hum, 1);
  for (const [key, field] of [
    ['dew_point', 'dewPointC'],
    ['heat_index', 'heatIndexC'],
    ['wind_chill', 'windChillC'],
  ] as const) {
    const c = tempC(r, key);
    if (c !== undefined) out[field] = c;
  }
  const wind = num(r, 'wind_speed_avg_last_1_min', 0, 250) ?? num(r, 'wind_speed_last', 0, 250);
  if (wind !== undefined) out['windSpeedMps'] = round(wind * MPH_TO_MPS, 1);
  const dir = num(r, 'wind_dir_scalar_avg_last_1_min', 0, 360) ?? num(r, 'wind_dir_last', 0, 360);
  if (dir !== undefined && wind !== undefined && wind > 0) out['windDirDeg'] = Math.round(dir) % 360;
  const gust = num(r, 'wind_speed_hi_last_10_min', 0, 250);
  if (gust !== undefined) out['windGustMps'] = round(gust * MPH_TO_MPS, 1);
  const size = RAIN_COUNT_MM[num(r, 'rain_size', 1, 4) ?? 0];
  if (size !== undefined) {
    const rate = num(r, 'rain_rate_last', 0, 1e6);
    if (rate !== undefined) out['rainRateMmH'] = round(rate * size, 1);
    const today = num(r, 'rainfall_daily', 0, 1e7);
    if (today !== undefined) out['rainTodayMm'] = round(today * size, 1);
    const day = num(r, 'rainfall_last_24_hr', 0, 1e7);
    if (day !== undefined) out['rain24hMm'] = round(day * size, 1);
  }
  const solar = num(r, 'solar_rad', 0, 2000);
  if (solar !== undefined) out['solarRadiationWm2'] = Math.round(solar);
  const uv = num(r, 'uv_index', 0, 25);
  if (uv !== undefined) out['uvIndex'] = round(uv, 1);
  if (Object.keys(out).length === 0) return 'no readings';
  const battery = r['trans_battery_flag'];
  if (battery === 1) out['batteryLow'] = true;
  const rx = r['rx_state'];
  if (rx === 0 || rx === 1 || rx === 2) out['reception'] = rx === 0 ? 'tracking' : rx === 1 ? 'synced' : 'scanning';
  return out;
}

function barometer(r: Record<string, unknown>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  const sea = num(r, 'bar_sea_level', 25, 33);
  if (sea !== undefined) out['pressureSeaLevelHpa'] = round(sea * INHG_TO_HPA, 1);
  const trend = num(r, 'bar_trend', -3, 3);
  if (trend !== undefined) out['pressureTrend3hHpa'] = round(trend * INHG_TO_HPA, 1);
  return out;
}

export function normalizeConditions(
  parsed: ParsedConditions,
  manifest: ProviderManifest,
  opts: StationNormalizeOptions,
): StationNormalizeResult {
  const rejected: Array<{ index: number; reason: string }> = [];
  if (!isValidLatLon(opts.position.latitude, opts.position.longitude))
    return { observations: [], total: 0, rejected: [{ index: -1, reason: 'invalid station position' }] };
  if (parsed.tsMs > opts.nowMs + FUTURE_SKEW_MS)
    return { observations: [], total: 0, rejected: [{ index: -1, reason: 'ts is in the future (device clock?)' }] };
  const observedAt = new Date(parsed.tsMs).toISOString();

  let bar: Record<string, JsonValue> = {};
  const iss: Array<{ index: number; txid: number; readings: Record<string, JsonValue> }> = [];
  let total = 0;
  const seen = new Set<number>();
  parsed.conditions.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      rejected.push({ index, reason: 'not an object' });
      return;
    }
    const r = raw as Record<string, unknown>;
    const type = r['data_structure_type'];
    if (type === 3) {
      bar = barometer(r);
      return;
    }
    if (type !== 1) return; // leaf/soil, indoor: not used (see above)
    total++;
    const txid = r['txid'];
    if (typeof txid !== 'number' || !Number.isInteger(txid) || txid < 1 || txid > 8) {
      rejected.push({ index, reason: 'missing or invalid txid' });
      return;
    }
    if (seen.has(txid)) {
      rejected.push({ index, reason: `duplicate transmitter ${txid}` });
      return;
    }
    const readings = issReadings(r);
    if (typeof readings === 'string') {
      rejected.push({ index, reason: readings });
      return;
    }
    seen.add(txid);
    iss.push({ index, txid, readings });
  });

  const stations: Array<{ externalId: string; label: string; readings: Record<string, JsonValue>; raw?: unknown }> =
    iss.map((s) => ({
      externalId: `${parsed.did}-${s.txid}`,
      label: iss.length > 1 ? `${opts.name} (transmitter ${s.txid})` : opts.name,
      readings: { ...s.readings, transmitterId: s.txid },
      raw: parsed.conditions[s.index],
    }));
  // A device whose outdoor suite is not reporting still has its barometer.
  if (stations.length === 0 && total === 0 && Object.keys(bar).length > 0)
    stations.push({ externalId: `${parsed.did}-base`, label: opts.name, readings: {} });

  const observations = stations.map((s) => {
    const payload: Record<string, JsonValue> = { name: s.label, stationId: parsed.did, ...s.readings, ...bar };
    const flags: string[] = [];
    if (payload['batteryLow'] === true) flags.push('battery-low');
    if (payload['reception'] === 'scanning') flags.push('not-receiving');
    const draft: ObservationDraft = {
      externalId: s.externalId,
      objectType: 'weather-station',
      observedAt,
      position: { latitude: opts.position.latitude, longitude: opts.position.longitude },
      payload,
      quality: {
        complete: payload['temperatureC'] !== undefined,
        sourceQuality: 'authoritative',
        ...(flags.length ? { flags } : {}),
      },
      origin: 'local',
    };
    if (opts.sourceRef) draft.sourceRef = opts.sourceRef;
    if (opts.hash && s.raw !== undefined) draft.rawPayloadHash = opts.hash(JSON.stringify(s.raw));
    return buildObservation(manifest, opts.receivedAt, draft);
  });
  return { observations, total, rejected };
}
