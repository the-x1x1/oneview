import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WorldObject } from '@worldview/world-model';
import type { WorldFlightInfo } from '@worldview/ipc-contract';
import { greatCirclePoint } from '@worldview/render-core';
import { contextRegistry } from './index.js';
import { AircraftDetails, aircraftRows, airportText, flightFacts, routeStatusText } from './flight.js';
import { presentedRoute } from '../map/route-overlay.js';
import type { FlightState } from '../store/types.js';

/**
 * The Aircraft section with an INVENTED flight: callsign TST123 of an invented airline,
 * Honolulu → San Francisco, a third of the way there. Airport names and positions are the
 * public facts the seed airports carry (rounded to 0.01°).
 */
const NOW = Date.parse('2026-09-28T08:00:00.000Z');
const HNL = { latitude: 21.32, longitude: -157.92 };
const SFO = { latitude: 37.62, longitude: -122.38 };
const at = greatCirclePoint(HNL, SFO, 1 / 3);

function aircraft(props: Record<string, string | number | boolean> = {}): WorldObject {
  return {
    id: 'aircraft:icao24:a1b2c3',
    type: 'aircraft',
    sourceRefs: [{ observationId: 'x', providerId: 'adsb-lol', observedAt: new Date(NOW).toISOString() }],
    observedAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    freshness: 'LIVE',
    confidence: 0.9,
    labels: { callsign: 'TST123' },
    properties: {
      icao24: 'a1b2c3',
      callsign: 'TST123',
      typeCode: 'B789',
      registration: 'N0TEST',
      squawk: '7700',
      ...props,
    },
    position: { ...at, altitudeM: 11_000, altitudeDatum: 'barometric' },
    motion: { speedMps: 250, headingDegrees: 60, verticalSpeedMps: -2.54 },
    provenance: {
      providerId: 'adsb-lol',
      sourceName: 'adsb.lol',
      origin: 'live',
      receivedAt: new Date(NOW).toISOString(),
    },
  } as WorldObject;
}

const found: WorldFlightInfo = {
  objectId: 'aircraft:icao24:a1b2c3',
  callsign: 'TST123',
  airline: { icao: 'TST', name: 'Test Air', iata: 'T1' },
  flightNumber: 'T1 123',
  aircraftType: { code: 'B789', name: 'Boeing 787-9' },
  routeStatus: 'found',
  route: {
    airports: [
      {
        code: 'PHNL',
        icao: 'PHNL',
        iata: 'HNL',
        name: 'Daniel K. Inouye International Airport',
        city: 'Honolulu',
        countryCode: 'US',
        ...HNL,
        describedBy: 'route',
      },
      {
        code: 'KSFO',
        icao: 'KSFO',
        iata: 'SFO',
        name: 'San Francisco International Airport',
        city: 'San Francisco',
        countryCode: 'US',
        ...SFO,
        describedBy: 'route',
      },
    ],
    source: 'adsb.lol routes',
    attribution: 'Flight routes: adsb.lol (ODbL 1.0), from Virtual Radar Server standing data (CC0 1.0)',
    plausible: true,
    note: 'Planned route from adsb.lol routes: a schedule for this callsign, not today’s flight plan — it may be wrong for charter or diverted flights.',
  },
  referenceAttribution: 'Airline and aircraft type names: Virtual Radar Server standing data (CC0 1.0)',
};

const state = (info: WorldFlightInfo | null, loading = false): FlightState => ({
  objectId: 'aircraft:icao24:a1b2c3',
  loading,
  info,
});
const actions = { loadFlight: async () => {} };
const render = (object: WorldObject, flight: FlightState | null) =>
  renderToStaticMarkup(createElement(AircraftDetails, { object, flight, actions, nowMs: NOW }));
const row = (html: string, label: string) => {
  const m = new RegExp(`<dt class="wv-fields__label">${label.replace(/[()]/g, '\\$&')}</dt><dd[^>]*>([^<]*)</dd>`).exec(
    html,
  );
  return m?.[1];
};

test('the Aircraft section: flight, airline, from → to, distance, estimate, type, squawk and credits', () => {
  const html = render(aircraft(), state(found));
  assert.equal(row(html, 'Flight'), 'T1 123');
  assert.equal(row(html, 'Airline'), 'Test Air (TST / T1)');
  assert.equal(row(html, 'From'), 'Daniel K. Inouye International Airport (HNL) · Honolulu, US');
  assert.equal(row(html, 'To'), 'San Francisco International Airport (SFO) · San Francisco, US');
  assert.equal(row(html, 'Route'), undefined, 'a found route needs no status line');
  // HNL–SFO is about 3,850 km great-circle; a third flown.
  assert.match(row(html, 'Flown') ?? '', /^1,28\d km of 3,8\d\d km \(great-circle\)$/);
  assert.match(row(html, 'To go') ?? '', /^2,5\d\d km$/);
  // 2,56x km at 250 m/s ≈ 2 h 51 min.
  assert.match(row(html, 'Arrival (estimate)') ?? '', /^10:5\d UTC at SFO — in 2h 5\dm at 486 kt ground speed/);
  assert.equal(row(html, 'Aircraft type'), 'Boeing 787-9 (B789)');
  assert.equal(row(html, 'Squawk'), '7700 — emergency');
  assert.equal(row(html, 'Registration'), 'N0TEST');
  assert.equal(row(html, 'Vertical rate'), '-500 ft/min');
  assert.equal(row(html, 'Altitude'), '36,089 ft (barometric)');
  assert.ok(html.includes('may be wrong for charter or diverted flights'), 'the planned-route caveat');
  assert.ok(html.includes('adsb.lol (ODbL 1.0)'), 'the route attribution');
  assert.ok(html.includes('Virtual Radar Server standing data (CC0 1.0)'), 'the reference credit');
  assert.equal(row(html, 'Route check'), undefined, 'plausible and on the great circle');
});

test('unknown states say what is unknown and why', () => {
  assert.equal(routeStatusText(null), 'Looking up the planned route…');
  assert.equal(routeStatusText(state(null, true)), 'Looking up the planned route…');
  assert.match(routeStatusText(state({ objectId: 'x', routeStatus: 'unknown' }))!, /^Unknown — /);
  assert.match(routeStatusText(state({ objectId: 'x', routeStatus: 'unavailable' }))!, /^Unavailable — /);
  assert.match(routeStatusText(state(null))!, /^Unavailable — /, 'a failed request');
  assert.match(routeStatusText(state({ objectId: 'x', routeStatus: 'not-applicable' }))!, /^Not looked up — /);

  const priv = render(
    aircraft({ callsign: 'N123AB', typeCode: 'C172' }),
    state({ objectId: 'aircraft:icao24:a1b2c3', callsign: 'N123AB', routeStatus: 'not-applicable' }),
  );
  assert.equal(row(priv, 'Airline'), undefined, 'no airline inferred for a private aircraft');
  assert.equal(row(priv, 'Flight'), undefined);
  assert.match(row(priv, 'Route') ?? '', /^Not looked up/);
  assert.equal(row(priv, 'Aircraft type'), 'C172', 'the designator alone when no name is known');

  const onGround = aircraft({ onGround: true });
  assert.equal(flightFacts(onGround, found, NOW).etaMs, undefined, 'no arrival estimate on the ground');
});

test('a route the aircraft does not fit is flagged', () => {
  const html = render(aircraft(), state({ ...found, route: { ...found.route!, plausible: false } }));
  assert.match(row(html, 'Route check') ?? '', /does not fit this route/);
  const far = { ...aircraft(), position: { latitude: -33.9, longitude: 151.2 } } as WorldObject;
  const rows = aircraftRows(far, state(found), NOW);
  assert.match(String(rows.find((r) => r.label === 'Route check')?.value), /km off this route/);
});

test('a stop is listed between origin and destination', () => {
  const withStop: WorldFlightInfo = {
    ...found,
    route: {
      ...found.route!,
      airports: [
        found.route!.airports[0]!,
        { code: 'PHOG', icao: 'PHOG', iata: 'OGG', latitude: 20.9, longitude: -156.43 },
        found.route!.airports[1]!,
      ],
    },
  };
  const html = render(aircraft(), state(withStop));
  assert.equal(row(html, 'Via'), 'OGG');
  assert.equal(airportText({ code: 'ZZZZ' }), 'ZZZZ');
});

test('the registry gives aircraft this section, and the map gets the rest of the route', () => {
  const section = contextRegistry.sectionsFor('aircraft').find((s) => s.id === 'aircraft');
  assert.ok(section);
  const route = presentedRoute(aircraft(), state(found))!;
  assert.deepEqual(
    route.airports.map((a) => [a.label, a.role]),
    [
      ['HNL', 'origin'],
      ['SFO', 'destination'],
    ],
  );
  assert.equal(route.remaining[0]!.latitude, at.latitude, 'from where the aircraft is');
  assert.equal(route.remaining[0]!.altitudeM, 11_000);
  assert.deepEqual(route.remaining.at(-1), { ...SFO, altitudeM: 0 });
  assert.equal(presentedRoute(aircraft(), state({ ...found, route: undefined as never })), undefined);
  assert.equal(presentedRoute(aircraft(), { ...state(found), objectId: 'aircraft:icao24:other' }), undefined);
});
