import type { ObjectTrackPoint } from '@worldview/provider-sdk';
import { FOOT_TO_M } from './normalize.js';

/**
 * adsb.lol's recent history of one aircraft: the readsb "trace" file its tar1090 map loads
 * when you click an aircraft, `https://adsb.lol/data/traces/<last two hex digits>/trace_full_<hex>.json`
 * — about the last day of positions. The URL is not part of adsb.lol's documented API (it is
 * the map's own data), so it is treated as best effort: asked for only for the aircraft the
 * operator selected, once a minute at most per aircraft, with a short timeout and a size cap,
 * on a host in the provider's allow-list, and any failure leaves the track as WORLDVIEW
 * recorded it. The data is adsb.lol's, ODbL 1.0, like the rest of this provider's.
 *
 * The format is readsb's (README-json.md, "trace jsons"): `{ icao, timestamp, trace: [...] }`,
 * `timestamp` in seconds since the epoch, and each trace point an array
 *
 *   [0] seconds after `timestamp`   [1] latitude   [2] longitude
 *   [3] altitude: feet (barometric unless flag 8), "ground", or null
 *   [4] ground speed kt   [5] track   [6] flags   [7] vertical rate   [8] detail object | null
 *   [9] position type   [10] geometric altitude ft   ... (later fields unused here)
 *
 * The altitude kept is the one WORLDVIEW's live points carry — barometric feet in metres,
 * 0 on the ground — so history and live tail sit on one profile. GEV's tracks.js
 * (normalizeAircraftTrack, MIT) reads the same fields the same way.
 */
export const ADSB_LOL_TRACE_HOST = 'adsb.lol';

/** The trace file for one ICAO 24-bit address, or undefined for anything that is not one. */
export function traceUrl(hex: string): string | undefined {
  const h = hex.trim().toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(h)) return undefined;
  return `https://${ADSB_LOL_TRACE_HOST}/data/traces/${h.slice(-2)}/trace_full_${h}.json`;
}

export interface TraceParseOptions {
  /** Keep points in [fromMs, toMs]. */
  fromMs: number;
  toMs: number;
  /** Thin to at most this many points (every n-th, the newest always kept). */
  maxPoints: number;
  /** The address asked for; a file about another aircraft is refused. */
  hex?: string;
}

/** Trace points in time order, or the reason the payload is unusable. */
export function parseTrace(payload: unknown, opts: TraceParseOptions): ObjectTrackPoint[] | string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'trace is not an object';
  const body = payload as { icao?: unknown; timestamp?: unknown; trace?: unknown };
  if (opts.hex && typeof body.icao === 'string' && body.icao.toLowerCase() !== opts.hex.toLowerCase())
    return 'trace is for another aircraft';
  const base = typeof body.timestamp === 'number' && Number.isFinite(body.timestamp) ? body.timestamp : undefined;
  if (base === undefined || base <= 0) return 'trace has no timestamp';
  if (!Array.isArray(body.trace)) return 'trace has no "trace" array';
  const out: ObjectTrackPoint[] = [];
  for (const row of body.trace) {
    if (!Array.isArray(row)) continue;
    const [offset, lat, lon, alt] = row as unknown[];
    if (typeof offset !== 'number' || !Number.isFinite(offset)) continue;
    if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const atMs = Math.round((base + offset) * 1000);
    if (atMs < opts.fromMs || atMs > opts.toMs) continue;
    const point: ObjectTrackPoint = { observedAt: new Date(atMs).toISOString(), latitude: lat, longitude: lon };
    if (alt === 'ground') point.altitudeM = 0;
    else if (typeof alt === 'number' && Number.isFinite(alt)) point.altitudeM = Math.round(alt * FOOT_TO_M * 10) / 10;
    out.push(point);
  }
  out.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  return thin(out, opts.maxPoints);
}

/** Every n-th point so at most `max` remain; the newest is always kept (it meets the live track). */
export function thin<T>(points: T[], max: number): T[] {
  if (max <= 0) return [];
  if (points.length <= max) return points;
  const stride = Math.ceil(points.length / max);
  const out: T[] = [];
  const last = points.length - 1;
  for (let i = last; i >= 0 && out.length < max; i -= stride) out.push(points[i]!);
  return out.reverse();
}
