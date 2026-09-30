import type { FlightRouteAirport, FlightRouteAnswer } from '@worldview/provider-sdk';
import { FOOT_TO_M } from './normalize.js';

/**
 * The planned route of one flight, from the static route files adsb.lol publishes:
 *
 *   GET https://vrs-standing-data.adsb.lol/routes/<first two characters>/<CALLSIGN>.json
 *
 * One JSON object per callsign; a callsign the database does not know answers HTTP 404. The
 * object (recorded for RYR7YT on 2026-09-29, fixtures/adsb-lol/README.md):
 *
 *   callsign            the callsign
 *   number              the flight number ("7YT"), or "unknown"
 *   airline_code        the airline's ICAO designator ("RYR"), or "unknown"
 *   airport_codes       the route as airport codes joined by "-" ("LEAL-EDLV", or three for a
 *                       stop), or "unknown"
 *   _airport_codes_iata the same with IATA codes where known ("ALC-NRN")
 *   _airports           the airports it could describe, in route order: { name, icao, iata,
 *                       location (city), countryiso2, lat, lon, alt_feet, alt_meters }
 *
 * Until 2026-09-28 this came from the API's `POST /api/0/routeset`, which took the aircraft's
 * position as well and said whether it was plausible. On 2026-09-29 that endpoint answered
 * every request with an empty `201 Created`, and its GET twin (`/api/0/route/<callsign>`)
 * redirects here with `#deprecated` on the link — so every route read "Unavailable". The
 * static file is the same data, and asking for it sends nobody the aircraft's position: the
 * route's fit is judged in the panel instead, from the great circle (context/flight.tsx).
 *
 * The routes are Virtual Radar Server's standing data (github.com/vradarserver/standing-data,
 * CC0 1.0), which adsb.lol loads and serves; what adsb.lol publishes is ODbL 1.0. A route there
 * is the callsign's *scheduled* route — it says nothing about today's flight, so a charter, a
 * diversion or a reused callsign makes it wrong — and the runtime labels it as planned.
 *
 * Asked only for the aircraft the operator selected (FlightRouteSource, host-bounded), one
 * callsign a request, never in bulk.
 */
export const ROUTES_BASE_URL = 'https://vrs-standing-data.adsb.lol/routes';
export const ROUTES_LABEL = 'adsb.lol routes';
/** Shown with every route: whose database it is and under which terms. */
export const ROUTES_ATTRIBUTION =
  'Flight routes: adsb.lol (ODbL 1.0), from Virtual Radar Server standing data (CC0 1.0)';

/**
 * A callsign shaped like an airline flight: a three-letter ICAO telephony designator and a
 * flight number of up to four characters that starts with a digit (`BAW123`, `DLH4AB`,
 * `RCH871`). A registration flown as a callsign (`N123AB`, `GABCD`, `DIABC`) is not, and is
 * never looked up — a route database has nothing for it, and asking would only tell a
 * third party which private aircraft the operator is looking at.
 */
const FLIGHT_CALLSIGN = /^[A-Z]{3}[0-9][0-9A-Z]{0,3}$/;

/** The callsign normalised for a lookup (upper-case, no spaces), or undefined when it is not an airline flight's. */
export function flightCallsign(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const c = raw.replace(/\s+/g, '').toUpperCase();
  return FLIGHT_CALLSIGN.test(c) ? c : undefined;
}

/** The static route file for a callsign (already normalised by `flightCallsign`). */
export function routeUrl(callsign: string): string {
  return `${ROUTES_BASE_URL}/${callsign.slice(0, 2)}/${callsign}.json`;
}

/** The answer for a callsign the database does not know (its file is missing): no airports. */
export function unknownRoute(callsign: string, attribution?: string): FlightRouteAnswer {
  return { label: ROUTES_LABEL, callsign, airports: [], ...(attribution ? { attribution } : {}) };
}

/**
 * The route for `callsign` from its route file, or the reason the payload is unusable. A file
 * whose route is "unknown" is an answer with no airports (not an error).
 */
export function parseRoute(
  payload: unknown,
  callsign: string,
  opts: { attribution?: string } = {},
): FlightRouteAnswer | string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'route answer is not an object';
  const row = payload as Record<string, unknown>;
  const c = row['callsign'];
  if (typeof c !== 'string' || c.trim().toUpperCase() !== callsign) return 'route answer is for another callsign';
  const answer = unknownRoute(callsign, opts.attribution);
  const airline = known(row['airline_code']);
  if (airline && /^[A-Z]{3}$/.test(airline)) answer.airlineCode = airline;
  const number = known(row['number']);
  if (number && /^[0-9A-Z]{1,5}$/.test(number)) answer.flightNumber = number;
  const codes = known(row['airport_codes']);
  if (!codes) return answer;
  const described = Array.isArray(row['_airports']) ? (row['_airports'] as unknown[]) : [];
  const list = codes
    .split('-')
    .map((code) => code.trim().toUpperCase())
    .filter((code) => /^[A-Z0-9]{3,4}$/.test(code));
  if (list.length < 2) return answer;
  answer.airports = list.map((code) => airport(code, described));
  return answer;
}

/** One airport of the route: what `_airports` says of `code`, or only the code. */
function airport(code: string, described: readonly unknown[]): FlightRouteAirport {
  const match = described.find((d): d is Record<string, unknown> => {
    if (!d || typeof d !== 'object') return false;
    const a = d as Record<string, unknown>;
    return (
      (typeof a['icao'] === 'string' && a['icao'].toUpperCase() === code) ||
      (code.length === 3 && typeof a['iata'] === 'string' && a['iata'].toUpperCase() === code)
    );
  });
  const out: FlightRouteAirport = { code };
  if (code.length === 4) out.icao = code;
  if (!match) return out;
  const icao = text(match['icao'], 4)?.toUpperCase();
  if (icao && /^[A-Z0-9]{4}$/.test(icao)) out.icao = icao;
  const iata = text(match['iata'], 3)?.toUpperCase();
  if (iata && /^[A-Z0-9]{3}$/.test(iata)) out.iata = iata;
  const name = text(match['name'], 120);
  if (name) out.name = name;
  const city = text(match['location'], 80);
  if (city) out.city = city;
  const country = text(match['countryiso2'], 2)?.toUpperCase();
  if (country && /^[A-Z]{2}$/.test(country)) out.countryCode = country;
  const lat = match['lat'];
  const lon = match['lon'];
  if (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 &&
    !(lat === 0 && lon === 0)
  ) {
    out.latitude = lat;
    out.longitude = lon;
  }
  const metres = match['alt_meters'];
  const feet = match['alt_feet'];
  if (typeof metres === 'number' && Number.isFinite(metres)) out.elevationM = metres;
  else if (typeof feet === 'number' && Number.isFinite(feet)) out.elevationM = round(feet * FOOT_TO_M, 1);
  return out;
}

/** A string field, or undefined when absent, empty or adsb.lol's "unknown". */
function known(v: unknown): string | undefined {
  const s = text(v, 64);
  return s && s.toLowerCase() !== 'unknown' ? s.toUpperCase() : undefined;
}

function text(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
