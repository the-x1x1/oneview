import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FlightRouteAnswer } from '@worldview/provider-sdk';
import {
  AVIATION_REFERENCE_FILE,
  EMPTY_REFERENCE,
  REFERENCE_CREDIT,
  SEED_AIRPORTS_CREDIT,
  SEED_AIRPORTS_FILE,
  buildFlightInfo,
  loadAviationReference,
  objectCallsign,
  parseAviationReference,
  parseSeedAirports,
  splitFlightCallsign,
  type AviationReference,
} from './flight-info.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** The tables the application ships, read the way the runtime reads them. */
async function shipped(): Promise<AviationReference> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wv-flight-'));
  try {
    copyFileSync(
      path.join(root, 'fixtures', 'aviation', 'aviation-reference.json'),
      path.join(dir, AVIATION_REFERENCE_FILE),
    );
    copyFileSync(path.join(root, 'fixtures', 'airports', 'seed-airports.geojson'), path.join(dir, SEED_AIRPORTS_FILE));
    return await loadAviationReference(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const aircraft = (props: Record<string, string>) => ({
  id: 'aircraft:icao24:abc123',
  labels: {},
  properties: props,
});

/** Invented route answers in the SDK shape. */
const route = (airports: FlightRouteAnswer['airports'], extra: Partial<FlightRouteAnswer> = {}): FlightRouteAnswer => ({
  label: 'test routes',
  attribution: 'Test routes (invented)',
  callsign: 'BAW123',
  airports,
  ...extra,
});

test('the shipped tables name airlines by ICAO designator and types by designator', async () => {
  const ref = await shipped();
  assert.ok(ref.airlines.size > 1000, 'thousands of airlines');
  assert.deepEqual(ref.airlines.get('BAW'), { name: 'British Airways', iata: 'BA' });
  assert.equal(ref.airlines.get('UAL')?.name, 'United Airlines');
  assert.equal(ref.types.get('B738'), 'Boeing 737-800');
  assert.equal(ref.types.get('A20N'), 'Airbus A-320neo');
  assert.equal(ref.airports.get('PHNL')?.iata, 'HNL');
  assert.deepEqual(await loadAviationReference(undefined), EMPTY_REFERENCE);
  assert.deepEqual(
    (await loadAviationReference(path.join(os.tmpdir(), 'wv-no-such-dir'))).airlines.size,
    0,
    'a missing file is an empty table',
  );
});

test('parse: a wrong format or malformed rows are skipped, not trusted', () => {
  assert.equal(parseAviationReference({ format: 'other', airlines: [['BAW', 'x']] }).airlines.size, 0);
  const t = parseAviationReference({
    format: 'worldview-aviation-reference@1',
    airlines: [['BAW', 'British Airways', 'BA'], ['bad', 'x'], ['TST'], 'row', ['NOI', 'No IATA', '']],
    types: [['B738', 'Boeing 737-800'], ['toolong', 'x'], ['A1']],
  });
  assert.deepEqual([...t.airlines.keys()], ['BAW', 'NOI']);
  assert.deepEqual(t.airlines.get('NOI'), { name: 'No IATA' });
  assert.deepEqual([...t.types.keys()], ['B738']);
  assert.equal(parseSeedAirports({ features: [{ properties: { icao: 'x' } }, null] }).size, 0);
});

test('callsigns: airline flights split; registrations do not', () => {
  assert.equal(objectCallsign({ labels: {}, properties: { callsign: ' baw 123 ' } }), 'BAW123');
  assert.equal(objectCallsign({ labels: { callsign: 'UAL1' }, properties: {} }), 'UAL1');
  assert.deepEqual(splitFlightCallsign('BAW123'), { designator: 'BAW', suffix: '123' });
  assert.deepEqual(splitFlightCallsign('EZY12AB'), { designator: 'EZY', suffix: '12AB' });
  assert.equal(splitFlightCallsign('N123AB'), undefined);
  assert.equal(splitFlightCallsign('GABCD'), undefined);
});

test('buildFlightInfo: airline, flight number, type and a found route, credited', async () => {
  const ref = await shipped();
  const info = buildFlightInfo(
    aircraft({ callsign: 'BAW0123', typeCode: 'b77w' }),
    ref,
    route(
      [
        { code: 'EGLL', icao: 'EGLL', iata: 'LHR', name: 'London Heathrow', latitude: 51.47, longitude: -0.46 },
        { code: 'KJFK', icao: 'KJFK' },
      ],
      { flightNumber: '123', plausible: true },
    ),
    true,
  );
  assert.equal(info.routeStatus, 'found');
  assert.deepEqual(info.airline, { icao: 'BAW', name: 'British Airways', iata: 'BA' });
  assert.equal(info.flightNumber, 'BA 123');
  assert.deepEqual(info.aircraftType, { code: 'B77W', name: 'Boeing 777-300ER' });
  assert.equal(info.route?.airports[0]!.describedBy, 'route');
  // KJFK was only a code in the answer: named and placed from the seed airports, and said so.
  assert.equal(info.route?.airports[1]!.describedBy, 'reference');
  assert.equal(info.route?.airports[1]!.iata, 'JFK');
  assert.ok(info.route?.airports[1]!.latitude !== undefined);
  assert.equal(info.route?.plausible, true);
  assert.match(info.route?.note ?? '', /Planned route from test routes.*charter or diverted/);
  assert.equal(info.referenceAttribution, `${REFERENCE_CREDIT} · ${SEED_AIRPORTS_CREDIT}`);
});

test('buildFlightInfo: unknown, unavailable and not-applicable are told apart', async () => {
  const ref = await shipped();
  const unknown = buildFlightInfo(aircraft({ callsign: 'UAL1' }), ref, route([]), true);
  assert.equal(unknown.routeStatus, 'unknown');
  assert.equal(unknown.route, undefined);
  assert.equal(unknown.flightNumber, 'UA 1', 'the callsign number when the source has none');
  const failed = buildFlightInfo(aircraft({ callsign: 'UAL1' }), ref, undefined, true);
  assert.equal(failed.routeStatus, 'unavailable');
  // A private aircraft flying its registration: no airline, no lookup, nothing inferred.
  const priv = buildFlightInfo(aircraft({ callsign: 'N123AB', typeCode: 'C172' }), ref, undefined, false);
  assert.equal(priv.routeStatus, 'not-applicable');
  assert.equal(priv.airline, undefined);
  assert.equal(priv.flightNumber, undefined);
  assert.equal(priv.aircraftType?.name, 'Cessna 172');
  // A designator the table does not know is still shown, without a name.
  const odd = buildFlightInfo(aircraft({ callsign: 'QQQ12A' }), EMPTY_REFERENCE, undefined, true);
  assert.deepEqual(odd.airline, { icao: 'QQQ' });
  assert.equal(odd.flightNumber, undefined, 'an alphanumeric suffix is not a flight number');
  assert.equal(odd.referenceAttribution, undefined);
});
