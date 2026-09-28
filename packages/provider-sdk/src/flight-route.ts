import type { WorldProvider } from './provider.js';

/**
 * Flight routes on demand (ADR-003 amendment 2026-09-28) — optional and additive, like
 * object-track.ts: no existing type changed, `WorldProvider` untouched. A provider that can
 * say where a flight is scheduled to fly — origin, stops, destination — from its callsign
 * implements `flightRoute`. The host asks it only for the aircraft the operator selected,
 * one callsign at a time; a provider never lists routes in bulk.
 *
 * Route databases are schedule-based (a callsign's usual route), so an answer is a *planned*
 * route: a charter, a diversion or a callsign reused on another day can make it wrong. The
 * runtime says so wherever it shows one.
 */
export interface FlightRouteRequest {
  /** WORLDVIEW object id of the selected aircraft. */
  objectId: string;
  /**
   * The callsign as the aircraft broadcasts it, upper-case and trimmed (`BAW123`). The
   * runtime asks only about callsigns shaped like an airline flight — three letters and a
   * flight number — never a registration used as a callsign.
   */
  callsign: string;
  /** Where the aircraft is now, when known (a source may check the route against it). */
  position?: { latitude: number; longitude: number };
  signal: AbortSignal;
}

export interface FlightRouteAirport {
  /** ICAO location indicator (`EGLL`), or the source's own code when it has no ICAO one. */
  code: string;
  icao?: string;
  iata?: string;
  name?: string;
  /** The city or town the airport serves. */
  city?: string;
  /** ISO 3166-1 alpha-2. */
  countryCode?: string;
  latitude?: number;
  longitude?: number;
  elevationM?: number;
}

export interface FlightRouteAnswer {
  /** Short label for the source, shown with the route ("adsb.lol routes"). */
  label: string;
  /** Licence/attribution line the source requires. */
  attribution?: string;
  callsign: string;
  /** Airline ICAO designator the source files the flight under (`BAW`). */
  airlineCode?: string;
  /** The flight number as the source writes it (`123`). */
  flightNumber?: string;
  /**
   * Origin, any intermediate stops, destination — in order. Fewer than two means the source
   * has no route for this callsign (an answer, not a failure).
   */
  airports: FlightRouteAirport[];
  /**
   * The source's own check of the aircraft's position against the route, when it makes one
   * (adsb.lol: whether the position lies plausibly along one of the route's legs).
   */
  plausible?: boolean;
}

export interface FlightRouteSource {
  /**
   * Resolve undefined when the lookup could not be made (offline, refused, malformed) — the
   * runtime reports the route as unavailable, not unknown. Throwing is allowed; the host
   * logs it and treats it as undefined.
   */
  flightRoute(request: FlightRouteRequest): Promise<FlightRouteAnswer | undefined>;
}

export function isFlightRouteSource(provider: WorldProvider): provider is WorldProvider & FlightRouteSource {
  return typeof (provider as Partial<FlightRouteSource>).flightRoute === 'function';
}

/** At most this many airports in one answer (a milk run with many stops); the rest are dropped. */
export const MAX_FLIGHT_ROUTE_AIRPORTS = 12;
