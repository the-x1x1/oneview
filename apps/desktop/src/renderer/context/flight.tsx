import { useEffect, type ReactNode } from 'react';
import type { WorldObject } from '@worldview/world-model';
import type { WorldFlightAirport, WorldFlightInfo } from '@worldview/ipc-contract';
import {
  FieldList,
  formatAltitude,
  formatDistance,
  formatDuration,
  formatSpeed,
  formatUtcTime,
  formatVerticalRate,
} from '@worldview/ui';
import {
  AIRCRAFT_CLASS_LABELS,
  aircraftClass,
  estimateArrivalMs,
  routeProgress,
  type RouteProgress,
} from '@worldview/render-core';
import type { ShellActions } from '../store/actions.js';
import type { FlightState } from '../store/types.js';
import { bool, num, str, yesNo } from './props.js';

/**
 * The Aircraft section: who is flying (airline, flight number), from where to where (the
 * planned route's airports), how far along (great-circle distance flown and to go, an arrival
 * estimate), and what (type, registration, squawk, altitude, class, the military flag).
 *
 * Every line is best effort and says where it came from when that matters: the route is a
 * planned route from its source — a schedule, which a charter or diversion makes wrong — and
 * the distances and time are great-circle estimates. Nothing is inferred about who owns or
 * operates an aircraft beyond what its callsign's airline designator says (§73).
 */

/** A route whose position fits worse than this (origin → aircraft → next airport against the leg) is flagged. */
export const ROUTE_DETOUR_WARN_M = 300_000;

/** Squawk codes with a meaning every operator should see spelled out. */
const SPECIAL_SQUAWKS: Readonly<Record<string, string>> = {
  '7500': 'unlawful interference',
  '7600': 'radio failure',
  '7700': 'emergency',
};

export interface FlightFacts {
  progress?: RouteProgress;
  /** Epoch ms of the arrival estimate at the next airport (the destination unless a stop comes first). */
  etaMs?: number;
  /** The airport the estimate is for. */
  etaTo?: WorldFlightAirport;
}

/** Progress and arrival estimate for the aircraft's current position, when the route's airports are placed. */
export function flightFacts(object: WorldObject, info: WorldFlightInfo | null, nowMs: number): FlightFacts {
  const airports = info?.route?.airports ?? [];
  const placed = airports.every((a) => a.latitude !== undefined && a.longitude !== undefined);
  if (!object.position || airports.length < 2 || !placed) return {};
  const points = airports.map((a) => ({ latitude: a.latitude!, longitude: a.longitude! }));
  const progress = routeProgress(object.position, points);
  if (!progress) return {};
  const onGround = bool(object, 'onGround') === true;
  const speed = object.motion?.speedMps ?? num(object, 'speedMps');
  const etaMs = onGround ? undefined : estimateArrivalMs(progress.toNextM, speed, nowMs);
  return { progress, ...(etaMs !== undefined ? { etaMs, etaTo: airports[progress.leg + 1]! } : {}) };
}

/** "London Heathrow Airport (LHR) · London, GB", or the code alone when nothing else is known. */
export function airportText(a: WorldFlightAirport): string {
  const code = a.iata ?? a.icao ?? a.code;
  const where = [a.city, a.countryCode].filter(Boolean).join(', ');
  const name = a.name ? `${a.name} (${code})` : code;
  return where ? `${name} · ${where}` : name;
}

/** The short code the map labels an airport with. */
export function airportCode(a: WorldFlightAirport): string {
  return a.iata ?? a.icao ?? a.code;
}

/** What the panel says about the route when it has none to show. */
export function routeStatusText(flight: FlightState | null): string | undefined {
  if (!flight || (flight.loading && !flight.info)) return 'Looking up the planned route…';
  switch (flight.info?.routeStatus) {
    case 'found':
      return undefined;
    case 'unknown':
      return 'Unknown — the route source has no route for this callsign.';
    case 'not-applicable':
      return 'Not looked up — the callsign is not an airline flight number (a private or military aircraft, or none broadcast).';
    case 'unavailable':
    default:
      return 'Unavailable — the route source could not be asked (offline) or did not answer.';
  }
}

export function aircraftRows(
  object: WorldObject,
  flight: FlightState | null,
  nowMs: number,
): Array<{ label: string; value: ReactNode | undefined; mono?: boolean; title?: string }> {
  const info = flight?.objectId === object.id ? flight.info : null;
  const facts = flightFacts(object, info, nowMs);
  const route = info?.route;
  const airports = route?.airports ?? [];
  const origin = airports[0];
  const destination = airports.length >= 2 ? airports[airports.length - 1] : undefined;
  const stops = airports.slice(1, -1);
  const airline = info?.airline;
  const squawk = str(object, 'squawk');
  const cls = aircraftClass(object.properties);
  const typeCode = str(object, 'typeCode') ?? str(object, 'aircraftType');
  const altitude = object.position?.altitudeM;
  const vs = object.motion?.verticalSpeedMps ?? num(object, 'verticalSpeedMps');
  const speed = object.motion?.speedMps ?? num(object, 'speedMps');
  const p = facts.progress;
  return [
    { label: 'Flight', value: info?.flightNumber, mono: true },
    {
      label: 'Airline',
      value: airline
        ? `${airline.name ?? 'Unknown airline'} (${[airline.icao, airline.iata].filter(Boolean).join(' / ')})`
        : undefined,
      title: 'From the callsign’s ICAO airline designator',
    },
    { label: 'Callsign', value: object.labels['callsign'] ?? str(object, 'callsign'), mono: true },
    { label: 'From', value: origin ? airportText(origin) : undefined },
    ...stops.map((s, i) => ({ label: stops.length > 1 ? `Via (${i + 1})` : 'Via', value: airportText(s) })),
    { label: 'To', value: destination ? airportText(destination) : undefined },
    { label: 'Route', value: routeStatusText(flight) },
    {
      label: 'Flown',
      value: p ? `${formatDistance(p.flownM)} of ${formatDistance(p.totalM)} (great-circle)` : undefined,
    },
    {
      label: 'To go',
      value: p
        ? `${formatDistance(p.remainingM)}${stops.length && p.toNextM !== p.remainingM ? ` (${formatDistance(p.toNextM)} to ${airportCode(airports[p.leg + 1]!)})` : ''}`
        : undefined,
    },
    {
      label: 'Arrival (estimate)',
      value:
        facts.etaMs !== undefined && facts.etaTo
          ? `${formatUtcTime(facts.etaMs, false)} UTC at ${airportCode(facts.etaTo)} — in ${formatDuration(facts.etaMs - nowMs)} at ${formatSpeed(speed, 'kt')} ground speed over the great-circle distance`
          : undefined,
      title: 'Great-circle distance to go at the current ground speed: real routings are longer and speeds change',
    },
    {
      label: 'Route check',
      value:
        route?.plausible === false
          ? `${route.source} says the aircraft’s position does not fit this route: it may be flying something else today.`
          : p && p.detourM > ROUTE_DETOUR_WARN_M
            ? `The aircraft is ${formatDistance(p.detourM)} off this route’s great circle: the route may not be today’s.`
            : undefined,
    },
    {
      label: 'Aircraft type',
      value: info?.aircraftType ? `${info.aircraftType.name} (${info.aircraftType.code})` : typeCode,
    },
    { label: 'Registration', value: object.labels['registration'] ?? str(object, 'registration'), mono: true },
    { label: 'ICAO 24', value: str(object, 'icao24') ?? object.id.split(':')[2], mono: true },
    { label: 'Class', value: cls === 'unknown' ? undefined : AIRCRAFT_CLASS_LABELS[cls] },
    {
      label: 'Military',
      // adsb.lol's database flag (or its military list); absent from sources without one.
      value: bool(object, 'military') === true ? 'Yes — registered military (adsb.lol database)' : undefined,
    },
    {
      label: 'Squawk',
      value: squawk ? (SPECIAL_SQUAWKS[squawk] ? `${squawk} — ${SPECIAL_SQUAWKS[squawk]}` : squawk) : undefined,
      mono: true,
    },
    {
      label: 'Altitude',
      value:
        altitude !== undefined && altitude >= 0 && bool(object, 'onGround') !== true
          ? `${formatAltitude(altitude, 'ft')}${object.position?.altitudeDatum ? ` (${object.position.altitudeDatum})` : ''}`
          : undefined,
    },
    { label: 'Vertical rate', value: formatVerticalRate(vs) },
    { label: 'Ground speed', value: formatSpeed(speed, 'kt') },
    { label: 'On ground', value: yesNo(bool(object, 'onGround')) },
    { label: 'Category', value: str(object, 'category') },
    { label: 'Origin country', value: str(object, 'originCountry') },
    { label: 'Barometric altitude', value: formatAltitude(num(object, 'baroAltitudeM'), 'ft') },
  ];
}

/** The callsign as the runtime normalises it, to tell when the flight must be asked again. */
function callsignKey(object: WorldObject): string | undefined {
  const raw = object.properties['callsign'] ?? object.labels['callsign'];
  return typeof raw === 'string' && raw.trim() ? raw.replace(/\s+/g, '').toUpperCase() : undefined;
}

export function AircraftDetails({
  object,
  flight,
  actions,
  nowMs,
}: {
  object: WorldObject;
  flight: FlightState | null;
  actions: Pick<ShellActions, 'loadFlight'>;
  nowMs: number;
}) {
  const callsign = callsignKey(object);
  const mine = flight?.objectId === object.id ? flight : null;
  // Asked on selection by the store; asked again here when the panel shows an aircraft the
  // store has nothing for (a selection restored at start-up) or whose callsign has changed
  // since (ADS-B often sends the callsign a little after the first position).
  const stale = !mine || (!mine.loading && !!callsign && mine.info?.callsign !== callsign && !!mine.info);
  // Settles: a request marks the flight loading (not stale), and its answer carries the
  // callsign it was for; a failed one leaves no info, which is not asked about again.
  useEffect(() => {
    if (stale) void actions.loadFlight(object.id);
  }, [stale, actions, object.id]);
  const info = mine?.info ?? null;
  const notes = [
    info?.route ? info.route.note : undefined,
    info?.route?.attribution,
    info?.referenceAttribution,
  ].filter((n): n is string => !!n);
  return (
    <div className="wv-ctx-stack">
      <FieldList rows={aircraftRows(object, mine, nowMs)} />
      {notes.map((n) => (
        <p key={n} className="wv-ctx-muted">
          {n}
        </p>
      ))}
    </div>
  );
}
