import type { JsonValue } from '@worldview/world-model';
import type { MqttPreset } from './contract.js';

/**
 * Payload presets: named readers for message formats common on a home broker, chosen by a
 * definition's `mqtt.preset`. A closed registry, like the mapping's transforms — nothing in
 * a definition runs. Each turns one parsed JSON message into zero or more records for the
 * mapping, adding fields that start with `_` (the source's own fields are left as they are):
 *
 *   `_device`  a stable id for the device the message is about
 *   `_time`    the message's own time as ISO 8601 — only when it is unambiguous
 *   `_class`   (rtl_433) `weather-station`, `sensor` or `other`, for a definition's filter
 *   readings in one unit whatever unit the device sent (`_temperature_C`, `_wind_avg_m_s`, …)
 *
 * A message a preset does not read (another event type, a text message) is skipped and
 * counted, never mapped.
 */
export type PresetRecord = Record<string, JsonValue>;
export type PresetResult = { records: PresetRecord[] } | { skipped: string };

export interface PayloadPreset {
  readonly id: MqttPreset;
  read(body: unknown, topic: string, levels: readonly string[]): PresetResult;
}

const isObject = (v: unknown): v is Record<string, JsonValue> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
};
const round = (n: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};
/** The first of `keys` that holds a number, converted; undefined when none does. */
function firstNumber(o: Record<string, JsonValue>, keys: Array<[string, (n: number) => number]>, digits = 2) {
  for (const [key, convert] of keys) {
    const n = num(o[key]);
    if (n !== undefined) return round(convert(n), digits);
  }
  return undefined;
}
const same = (n: number) => n;

const ZONED = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?)(Z|[+-]\d{2}:?\d{2})$/;
const MIN_EPOCH_S = 946_684_800; // 2000-01-01: smaller numbers are not a clock
const MAX_EPOCH_S = 4_102_444_800; // 2100-01-01

/**
 * A time a message carries, as ISO 8601 — or undefined when it cannot be placed without
 * guessing a zone. Unix seconds (a number or a numeric string; milliseconds when too large
 * to be seconds) and a date-time with `Z` or an offset are read; `2026-09-24 07:12:01`
 * (rtl_433's default, the receiver's local time) is not, and the arrival time is used.
 */
export function unambiguousTime(v: unknown): string | undefined {
  const n = num(v);
  if (n !== undefined) {
    const seconds = n > MAX_EPOCH_S ? n / 1000 : n;
    if (seconds < MIN_EPOCH_S || seconds > MAX_EPOCH_S) return undefined;
    return new Date(Math.round(seconds * 1000)).toISOString();
  }
  if (typeof v !== 'string') return undefined;
  const m = ZONED.exec(v.trim());
  if (!m) return undefined;
  const zone = m[3] === 'Z' ? 'Z' : `${m[3]!.slice(0, 3)}:${m[3]!.slice(-2)}`;
  const ms = Date.parse(`${m[1]}T${m[2]}${zone}`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

// ── rtl_433 ─────────────────────────────────────────────────────────────────

const MAX_DEVICES = 4096;
const WIND_OR_RAIN = /^(wind_|rain_|gust_)/;
const SENSOR_KEYS = /^(temperature_|humidity|pressure_|moisture|light_lux|uv|uvi|dew_point)/;

/**
 * rtl_433's JSON events (`rtl_433 -F json` and `-F mqtt`'s `…/events` topic): one object per
 * decoded transmission with `model`, usually `id`, sometimes `channel`, and readings named
 * with their unit (`temperature_C`, `wind_avg_km_h`, `rain_in`, …). The device is
 * `model:channel:id` (the parts it has); `_class` is `weather-station` when the device
 * reports wind or rain, `sensor` when it reports temperature, humidity, pressure, moisture
 * or light, `other` otherwise (door contacts, remotes, tyre sensors). Some stations split
 * their readings over several message types (an Acurite 5-in-1 sends temperature in one and
 * rain in the other), so readings are merged per device: each record is the device's latest
 * value of every field it has sent, dated by the message that just arrived. The per-field
 * topics (`…/devices/<model>/<id>/<field>`) carry one number each and are not read.
 */
export function createRtl433Preset(): PayloadPreset {
  const devices = new Map<string, PresetRecord>();
  return {
    id: 'rtl_433',
    read(body) {
      if (!isObject(body) || typeof body['model'] !== 'string' || !body['model'])
        return { skipped: 'not an rtl_433 event (no model)' };
      const model = body['model'];
      const parts = [model];
      for (const key of ['channel', 'id'] as const) {
        const v = body[key];
        if (typeof v === 'number' || (typeof v === 'string' && v !== '')) parts.push(String(v));
      }
      const device = parts.join(':');
      const merged: PresetRecord = { ...(devices.get(device) ?? {}), ...body };
      devices.delete(device); // re-inserted below: least recently heard first
      // Only this message's own time dates the record; an older one must not survive the merge.
      delete merged['_time'];
      const keys = Object.keys(merged);
      const cls = keys.some((k) => WIND_OR_RAIN.test(k))
        ? 'weather-station'
        : keys.some((k) => SENSOR_KEYS.test(k))
          ? 'sensor'
          : 'other';
      const out: PresetRecord = { ...merged, _device: device, _class: cls };
      const time = unambiguousTime(body['time']);
      if (time) out['_time'] = time;
      const add = (key: string, value: number | undefined) => {
        if (value !== undefined) out[key] = value;
      };
      add(
        '_temperature_C',
        firstNumber(merged, [
          ['temperature_C', same],
          ['temperature_F', (f) => ((f - 32) * 5) / 9],
        ]),
      );
      add(
        '_pressure_hPa',
        firstNumber(merged, [
          ['pressure_hPa', same],
          ['pressure_kPa', (k) => k * 10],
          ['pressure_inHg', (i) => i * 33.8639],
        ]),
      );
      add(
        '_wind_avg_m_s',
        firstNumber(merged, [
          ['wind_avg_m_s', same],
          ['wind_avg_km_h', (k) => k / 3.6],
          ['wind_avg_mi_h', (m) => m * 0.44704],
        ]),
      );
      add(
        '_wind_max_m_s',
        firstNumber(merged, [
          ['wind_max_m_s', same],
          ['wind_max_km_h', (k) => k / 3.6],
          ['wind_max_mi_h', (m) => m * 0.44704],
        ]),
      );
      add(
        '_rain_mm',
        firstNumber(merged, [
          ['rain_mm', same],
          ['rain_in', (i) => i * 25.4],
        ]),
      );
      add(
        '_rain_rate_mm_h',
        firstNumber(merged, [
          ['rain_rate_mm_h', same],
          ['rain_rate_in_h', (i) => i * 25.4],
        ]),
      );
      devices.set(device, merged);
      if (devices.size > MAX_DEVICES) devices.delete(devices.keys().next().value!);
      return { records: [out] };
    },
  };
}

// ── OwnTracks ───────────────────────────────────────────────────────────────

/**
 * OwnTracks location messages on `owntracks/<user>/<device>`: `_type: "location"` with
 * `lat`, `lon`, `tst` (Unix seconds), `acc`, `alt`, `batt`, `vel` (km/h), `cog`. The device
 * is `<user>/<device>` from the topic; `_time` is `tst`; `_speed_m_s` is `vel` in m/s. Every
 * other `_type` (transitions, waypoints, cards, last-will) is skipped, and so is an
 * encrypted payload, which the connector cannot read.
 */
export const ownTracksPreset: PayloadPreset = {
  id: 'owntracks',
  read(body, topic, levels) {
    if (!isObject(body)) return { skipped: 'not an OwnTracks message' };
    const type = body['_type'];
    if (type === 'encrypted') return { skipped: 'encrypted OwnTracks payload (not readable here)' };
    if (type !== 'location') return { skipped: `OwnTracks ${typeof type === 'string' ? type : 'message'}` };
    const out: PresetRecord = {
      ...body,
      _device: levels.length >= 3 && levels[0] === 'owntracks' ? `${levels[1]}/${levels[2]}` : topic,
    };
    const time = unambiguousTime(body['tst']);
    if (time) out['_time'] = time;
    const vel = num(body['vel']);
    if (vel !== undefined && vel >= 0) out['_speed_m_s'] = round(vel / 3.6, 3);
    return { records: [out] };
  },
};

// ── Meshtastic ──────────────────────────────────────────────────────────────

interface NodeState {
  name?: string;
  shortName?: string;
  hardware?: JsonValue;
  lat?: number;
  lon?: number;
  alt?: number;
  positionTime?: string;
  battery?: number;
  voltage?: number;
  temperatureC?: number;
  humidityPct?: number;
  pressureHpa?: number;
  channelUtilization?: number;
  airUtilTx?: number;
}

/**
 * A Meshtastic MQTT gateway's JSON output (`msh/<region>/2/json/<channel>/<gateway>`, JSON
 * enabled on the gateway): one object per packet with `from` (the node number), `type` and
 * `payload`. `position` (`latitude_i`/`longitude_i` in 1e-7 degrees, `altitude`, `time`),
 * `nodeinfo` (`longname`, `shortname`, `hardware`) and `telemetry` (battery, voltage,
 * environment) packets are read and merged per node, so every record is the node's latest
 * state — a telemetry packet is placed where the node last reported itself. The device is the
 * node id as Meshtastic writes it (`!` and eight hex digits). Text messages and every other
 * packet type are skipped: the connector never reads what people send each other.
 */
export function createMeshtasticPreset(): PayloadPreset {
  const nodes = new Map<string, NodeState>();
  return {
    id: 'meshtastic',
    read(body) {
      if (!isObject(body)) return { skipped: 'not a Meshtastic packet' };
      const from = num(body['from']);
      const type = body['type'];
      if (from === undefined || !Number.isInteger(from) || from < 0 || from > 0xffffffff || typeof type !== 'string')
        return { skipped: 'not a Meshtastic packet (no from/type)' };
      if (type !== 'position' && type !== 'nodeinfo' && type !== 'telemetry')
        return { skipped: `Meshtastic ${type || 'packet'} (not read)` };
      const device = `!${from.toString(16).padStart(8, '0')}`;
      const payload = isObject(body['payload']) ? body['payload'] : {};
      const state: NodeState = nodes.get(device) ?? {};
      nodes.delete(device); // re-inserted below: the map is kept in least-recently-heard order
      if (type === 'position') {
        const lat = num(payload['latitude_i']);
        const lon = num(payload['longitude_i']);
        // 0/0 is what a node without a fix (or with position sharing off) sends.
        if (lat !== undefined && lon !== undefined && (lat !== 0 || lon !== 0)) {
          state.lat = round(lat / 1e7, 7);
          state.lon = round(lon / 1e7, 7);
          const alt = num(payload['altitude']);
          if (alt !== undefined) state.alt = alt;
          else delete state.alt;
          const t = unambiguousTime(payload['time']);
          if (t) state.positionTime = t;
        }
      } else if (type === 'nodeinfo') {
        if (typeof payload['longname'] === 'string') state.name = payload['longname'];
        if (typeof payload['shortname'] === 'string') state.shortName = payload['shortname'];
        if (payload['hardware'] !== undefined) state.hardware = payload['hardware'];
      } else {
        const set = <K extends keyof NodeState>(key: K, v: unknown) => {
          const n = num(v);
          if (n !== undefined) (state as Record<string, unknown>)[key] = n;
        };
        set('battery', payload['battery_level']);
        set('voltage', payload['voltage']);
        set('temperatureC', payload['temperature']);
        set('humidityPct', payload['relative_humidity']);
        set('pressureHpa', payload['barometric_pressure']);
        set('channelUtilization', payload['channel_utilization']);
        set('airUtilTx', payload['air_util_tx']);
      }
      nodes.set(device, state);
      if (nodes.size > MAX_DEVICES) nodes.delete(nodes.keys().next().value!);
      const out: PresetRecord = { ...body, _device: device, _type: type };
      const time = (type === 'position' ? state.positionTime : undefined) ?? unambiguousTime(body['timestamp']);
      if (time) out['_time'] = time;
      const copy: Array<[keyof NodeState, string]> = [
        ['name', '_name'],
        ['shortName', '_shortName'],
        ['hardware', '_hardware'],
        ['lat', '_lat'],
        ['lon', '_lon'],
        ['alt', '_alt'],
        ['battery', '_battery'],
        ['voltage', '_voltage'],
        ['temperatureC', '_temperature_C'],
        ['humidityPct', '_humidity'],
        ['pressureHpa', '_pressure_hPa'],
        ['channelUtilization', '_channel_utilization'],
        ['airUtilTx', '_air_util_tx'],
      ];
      for (const [key, to] of copy) if (state[key] !== undefined) out[to] = state[key] as JsonValue;
      return { records: [out] };
    },
  };
}

/** A fresh reader for `id`: the rtl_433 and Meshtastic readers keep per-device state, so one per provider. */
export function createPreset(id: MqttPreset): PayloadPreset {
  switch (id) {
    case 'rtl_433':
      return createRtl433Preset();
    case 'owntracks':
      return ownTracksPreset;
    case 'meshtastic':
      return createMeshtasticPreset();
  }
}
