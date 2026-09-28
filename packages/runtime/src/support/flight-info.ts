import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { WorldObject } from '@worldview/world-model';
import type { FlightRouteAnswer } from '@worldview/provider-sdk';
import type { WorldFlightAirport, WorldFlightInfo, WorldFlightRoute } from '@worldview/ipc-contract';

/**
 * What is known of the selected aircraft's flight (`world.flight`): its airline and aircraft
 * type, named from tables bundled with the application, and its planned route, from a route
 * source (provider-sdk flight-route.ts; adsb.lol's routeset today).
 *
 * The bundled tables (resources/data):
 *   aviation-reference.json — airline names by ICAO designator and aircraft type names by
 *     ICAO type designator, built from Virtual Radar Server standing data (CC0 1.0) by
 *     tools/dev/aviation-reference/build.mjs;
 *   airports.geojson — WORLDVIEW's seed airports (MIT), used to name and place a route's
 *     airport the route source did not describe.
 * Either may be missing (a test runtime, a damaged install): the answer then has less in it,
 * never an error.
 *
 * Privacy (§73): the airline is what the callsign's own designator says, nothing more. A
 * callsign that is a registration (a private aircraft) names no airline and is never sent to
 * a route source; nothing here looks up an owner or operator.
 */
export const AVIATION_REFERENCE_FILE = 'aviation-reference.json';
export const AVIATION_REFERENCE_FORMAT = 'worldview-aviation-reference@1';
export const SEED_AIRPORTS_FILE = 'airports.geojson';
export const REFERENCE_CREDIT = 'Airline and aircraft type names: Virtual Radar Server standing data (CC0 1.0)';
export const SEED_AIRPORTS_CREDIT = 'Airports: WORLDVIEW seed dataset';

/** A callsign shaped like an airline flight: ICAO designator + flight number (routes.ts in adsb-remote keeps the same rule). */
const FLIGHT_CALLSIGN = /^([A-Z]{3})([0-9][0-9A-Z]{0,3})$/;

export interface ReferenceAirport {
  icao: string;
  iata?: string;
  name: string;
  city?: string;
  countryCode?: string;
  latitude: number;
  longitude: number;
}

export interface AviationReference {
  airlines: ReadonlyMap<string, { name: string; iata?: string }>;
  types: ReadonlyMap<string, string>;
  airports: ReadonlyMap<string, ReferenceAirport>;
}

export const EMPTY_REFERENCE: AviationReference = { airlines: new Map(), types: new Map(), airports: new Map() };

/** The airline and type tables from aviation-reference.json; empty tables for anything unusable. */
export function parseAviationReference(doc: unknown): Pick<AviationReference, 'airlines' | 'types'> {
  const airlines = new Map<string, { name: string; iata?: string }>();
  const types = new Map<string, string>();
  if (!doc || typeof doc !== 'object') return { airlines, types };
  const d = doc as { format?: unknown; airlines?: unknown; types?: unknown };
  if (d.format !== AVIATION_REFERENCE_FORMAT) return { airlines, types };
  for (const row of Array.isArray(d.airlines) ? d.airlines : []) {
    if (!Array.isArray(row)) continue;
    const [icao, name, iata] = row as unknown[];
    if (typeof icao !== 'string' || !/^[A-Z]{3}$/.test(icao) || typeof name !== 'string' || !name) continue;
    airlines.set(icao, typeof iata === 'string' && /^[A-Z0-9]{2}$/.test(iata) ? { name, iata } : { name });
  }
  for (const row of Array.isArray(d.types) ? d.types : []) {
    if (!Array.isArray(row)) continue;
    const [code, name] = row as unknown[];
    if (typeof code === 'string' && /^[A-Z0-9]{2,4}$/.test(code) && typeof name === 'string' && name)
      types.set(code, name);
  }
  return { airlines, types };
}

/** The seed airports by ICAO code, from the bundled GeoJSON (fixtures/airports/README.md). */
export function parseSeedAirports(doc: unknown): Map<string, ReferenceAirport> {
  const out = new Map<string, ReferenceAirport>();
  const features = (doc as { features?: unknown } | null)?.features;
  for (const f of Array.isArray(features) ? features : []) {
    const props = (f as { properties?: Record<string, unknown> })?.properties;
    const coords = (f as { geometry?: { type?: unknown; coordinates?: unknown } })?.geometry;
    if (!props || coords?.type !== 'Point' || !Array.isArray(coords.coordinates)) continue;
    const [lon, lat] = coords.coordinates as unknown[];
    const icao = props['icao'];
    const name = props['name'];
    if (typeof icao !== 'string' || !/^[A-Z0-9]{4}$/.test(icao) || typeof name !== 'string') continue;
    if (typeof lat !== 'number' || typeof lon !== 'number' || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const a: ReferenceAirport = { icao, name, latitude: lat, longitude: lon };
    if (typeof props['iata'] === 'string' && props['iata']) a.iata = props['iata'];
    if (typeof props['municipality'] === 'string' && props['municipality']) a.city = props['municipality'];
    if (typeof props['countryCode'] === 'string' && props['countryCode']) a.countryCode = props['countryCode'];
    out.set(icao, a);
  }
  return out;
}

/** Both bundled files from the resources directory; whatever cannot be read is left empty. */
export async function loadAviationReference(resourcesDir: string | undefined): Promise<AviationReference> {
  if (!resourcesDir) return EMPTY_REFERENCE;
  const read = async (file: string): Promise<unknown> => {
    try {
      return JSON.parse(await fs.readFile(path.join(resourcesDir, file), 'utf8')) as unknown;
    } catch {
      return undefined;
    }
  };
  const [reference, airports] = await Promise.all([read(AVIATION_REFERENCE_FILE), read(SEED_AIRPORTS_FILE)]);
  return { ...parseAviationReference(reference), airports: parseSeedAirports(airports) };
}

/** The object's callsign, upper-case without spaces, or undefined. */
export function objectCallsign(object: Pick<WorldObject, 'labels' | 'properties'>): string | undefined {
  const raw = object.properties['callsign'] ?? object.labels['callsign'];
  if (typeof raw !== 'string') return undefined;
  const c = raw.replace(/\s+/g, '').toUpperCase();
  return c || undefined;
}

/** The callsign split as an airline flight (`BAW123` → `BAW`, `123`), or undefined. */
export function splitFlightCallsign(callsign: string | undefined): { designator: string; suffix: string } | undefined {
  const m = callsign ? FLIGHT_CALLSIGN.exec(callsign) : null;
  return m ? { designator: m[1]!, suffix: m[2]! } : undefined;
}

/**
 * The flight answer for one aircraft. `route` is the route source's answer: undefined when
 * no source could be asked or the lookup failed, and `lookedUp` false when there was nothing
 * to look up (no airline callsign).
 */
export function buildFlightInfo(
  object: Pick<WorldObject, 'id' | 'labels' | 'properties'>,
  reference: AviationReference,
  route: FlightRouteAnswer | undefined,
  lookedUp: boolean,
): WorldFlightInfo {
  const callsign = objectCallsign(object);
  const flight = splitFlightCallsign(callsign);
  const info: WorldFlightInfo = {
    objectId: object.id,
    routeStatus: !lookedUp
      ? 'not-applicable'
      : !route
        ? 'unavailable'
        : route.airports.length >= 2
          ? 'found'
          : 'unknown',
  };
  if (callsign) info.callsign = callsign;
  const credits = new Set<string>();

  // The airline: the callsign's own designator first — that is what the aircraft says it
  // is — then the route source's filing of it. Nothing for a registration callsign.
  const designator = flight?.designator ?? route?.airlineCode;
  if (designator) {
    const known = reference.airlines.get(designator);
    info.airline = {
      icao: designator,
      ...(known ? { name: known.name } : {}),
      ...(known?.iata ? { iata: known.iata } : {}),
    };
    if (known) credits.add(REFERENCE_CREDIT);
  }
  const number = route?.flightNumber ?? (flight && /^[0-9]+$/.test(flight.suffix) ? flight.suffix : undefined);
  if (info.airline && number) {
    const n = number.replace(/^0+(?=\d)/, '');
    info.flightNumber = info.airline.iata ? `${info.airline.iata} ${n}` : `${info.airline.icao} ${n}`;
  }

  const typeCode = text(object.properties['typeCode']) ?? text(object.properties['aircraftType']);
  if (typeCode) {
    const name = reference.types.get(typeCode.toUpperCase());
    if (name) {
      info.aircraftType = { code: typeCode.toUpperCase(), name };
      credits.add(REFERENCE_CREDIT);
    }
  }

  if (route && route.airports.length >= 2) {
    const airports = route.airports.map((a) => describeAirport(a, reference, credits));
    const r: WorldFlightRoute = {
      airports,
      source: route.label,
      note: `Planned route from ${route.label}: a schedule for this callsign, not today's flight plan — it may be wrong for charter or diverted flights.`,
    };
    if (route.attribution) r.attribution = route.attribution;
    if (route.plausible !== undefined) r.plausible = route.plausible;
    info.route = r;
  }
  if (credits.size) info.referenceAttribution = [...credits].join(' · ');
  return info;
}

/** A route airport as the source described it, completed from the seed airports where it said less. */
function describeAirport(
  a: FlightRouteAnswer['airports'][number],
  reference: AviationReference,
  credits: Set<string>,
): WorldFlightAirport {
  const out: WorldFlightAirport = { ...a };
  const hasPlace = a.latitude !== undefined && a.longitude !== undefined;
  if (a.name || hasPlace) out.describedBy = 'route';
  const seed = reference.airports.get(a.icao ?? a.code);
  if (!seed || (a.name && hasPlace)) return out;
  if (!out.name) out.name = seed.name;
  if (!out.iata && seed.iata) out.iata = seed.iata;
  if (!out.city && seed.city) out.city = seed.city;
  if (!out.countryCode && seed.countryCode) out.countryCode = seed.countryCode;
  if (!hasPlace) {
    out.latitude = seed.latitude;
    out.longitude = seed.longitude;
    // Placed by WORLDVIEW's table, not the source: say so (the panel shows it).
    out.describedBy = 'reference';
  } else out.describedBy ??= 'reference';
  credits.add(SEED_AIRPORTS_CREDIT);
  return out;
}

function text(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
