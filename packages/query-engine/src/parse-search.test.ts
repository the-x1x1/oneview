import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BuiltinGazetteer } from './builtin-gazetteer.js';
import { ISS_NORAD_ID, matchCommands, parseSearch, type SearchIntent } from './parse-search.js';
import { DEFAULT_COMMANDS } from './vocabulary.js';
import { T0 } from './test-fixtures.js';

const gazetteer = new BuiltinGazetteer();
const ctx = { gazetteer, now: () => T0 };
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const first = (text: string, kind: SearchIntent['kind']) => parseSearch(text, ctx).intents.find((i) => i.kind === kind);

test('parseSearch: "Honolulu" → place (city first), "HNL" → airport, coordinates → place', () => {
  const honolulu = parseSearch('Honolulu', ctx);
  assert.equal(honolulu.intents[0]!.kind, 'place');
  assert.equal(honolulu.intents[0]!.place!.id, 'place:builtin:honolulu');
  assert.equal(honolulu.intents[0]!.confidence, 'HIGH');

  const hnl = parseSearch('HNL', ctx);
  assert.equal(hnl.intents.length, 1);
  assert.equal(hnl.intents[0]!.kind, 'place');
  assert.equal(hnl.intents[0]!.place!.id, 'airport:iata:HNL');
  assert.equal(hnl.intents[0]!.place!.kind, 'airport');
  assert.equal(parseSearch('PHNL', ctx).intents[0]!.place!.id, 'airport:iata:HNL', 'ICAO code');
  assert.equal(
    parseSearch('hnl', ctx).intents[0]!.place!.id,
    'airport:iata:HNL',
    'lower-case code still resolves through the gazetteer',
  );

  const coord = parseSearch('21.3,-157.9', ctx);
  assert.equal(coord.intents.length, 1);
  assert.equal(coord.intents[0]!.kind, 'place');
  assert.deepEqual(coord.intents[0]!.place!.position, { latitude: 21.3, longitude: -157.9 });
  assert.equal(coord.intents[0]!.place!.kind, 'coordinate');
  assert.deepEqual(parseSearch('N 21.3 W 157.9', ctx).intents[0]!.place!.position, {
    latitude: 21.3,
    longitude: -157.9,
  });
  const dms = parseSearch('21°18\'25"N 157°51\'30"W', ctx).intents[0]!.place!.position;
  assert.ok(Math.abs(dms.latitude - 21.3069) < 0.001 && Math.abs(dms.longitude + 157.8583) < 0.001);
  const mgrs = parseSearch('4QFJ 12345 67890', ctx);
  assert.equal(mgrs.intents.length, 0);
  assert.match(mgrs.notes[0]!, /MGRS/);
  assert.equal(
    parseSearch('12junk, 34oops', ctx).intents.some((i) => i.place?.kind === 'coordinate'),
    false,
    'never guesses coordinates',
  );
});

test('parseSearch: identifiers — ISS, icao24, callsign, MMSI, NORAD', () => {
  const iss = parseSearch('ISS', ctx);
  assert.equal(iss.intents[0]!.kind, 'object');
  assert.deepEqual(iss.intents[0]!.objectHint, { type: 'satellite', idCandidates: [ISS_NORAD_ID] });
  assert.equal(iss.intents[0]!.confidence, 'HIGH');

  const hex = parseSearch('a1b2c3', ctx);
  assert.equal(hex.intents.length, 1);
  assert.deepEqual(hex.intents[0]!.objectHint, { type: 'aircraft', idCandidates: ['aircraft:icao24:a1b2c3'] });
  assert.deepEqual(
    parseSearch('A1B2C3', ctx).intents[0]!.objectHint!.idCandidates,
    ['aircraft:icao24:a1b2c3'],
    'hex is lower-cased',
  );

  const cs = first('UA123', 'query')!;
  assert.deepEqual(cs.query, {
    objectTypes: ['aircraft'],
    filters: [{ field: 'labels.callsign', op: 'eq', value: 'UA123' }],
  });
  assert.equal(
    parseSearch('UA123', ctx).intents.some((i) => i.kind === 'object'),
    false,
    'callsign is a filter, never an id (ADR-011)',
  );
  assert.deepEqual(first('ual123', 'query')!.query!.filters![0]!.value, 'UAL123');

  const both = parseSearch('AB1234', ctx);
  assert.ok(
    both.intents.some((i) => i.kind === 'object') && both.intents.some((i) => i.kind === 'query'),
    'ambiguous hex/callsign yields both candidates',
  );

  assert.deepEqual(first('366123456', 'object')!.objectHint, {
    type: 'vessel',
    idCandidates: ['vessel:mmsi:366123456'],
  });
  assert.deepEqual(first('norad 25544', 'object')!.objectHint, {
    type: 'satellite',
    idCandidates: ['satellite:norad:25544'],
  });
  assert.deepEqual(first('sat 25544', 'object')!.objectHint, {
    type: 'satellite',
    idCandidates: ['satellite:norad:25544'],
  });
  assert.deepEqual(first('NORAD:48274', 'object')!.objectHint, {
    type: 'satellite',
    idCandidates: ['satellite:norad:48274'],
  });
});

test('parseSearch: object types with spatial phrases', () => {
  const japan = first('earthquakes near Japan', 'query')!;
  assert.equal(japan.confidence, 'HIGH');
  assert.equal(japan.title, 'Earthquakes near Japan');
  assert.deepEqual(japan.query!.objectTypes, ['earthquake']);
  assert.equal(japan.query!.region!.kind, 'bounds');
  assert.deepEqual(japan.query!.region, {
    kind: 'bounds',
    bounds: { west: 122.9, south: 24, east: 146.1, north: 45.6 },
  });

  const la = first('fires near Los Angeles', 'query')!;
  assert.deepEqual(la.query!.objectTypes, ['fire-detection']);
  assert.deepEqual(la.query!.region, {
    kind: 'circle',
    center: { latitude: 34.0522, longitude: -118.2437 },
    radiusM: 100_000,
  });
  assert.equal(la.title, 'Fires near Los Angeles');

  const hawaii = first('satellites over Hawaii', 'query')!;
  assert.deepEqual(hawaii.query!.objectTypes, ['satellite']);
  assert.deepEqual(hawaii.query!.region, {
    kind: 'bounds',
    bounds: { west: -160.3, south: 18.9, east: -154.8, north: 22.3 },
  });

  const oahu = first('ships near Oahu', 'query')!;
  assert.deepEqual(oahu.query!.objectTypes, ['vessel']);
  assert.equal(oahu.query!.region!.kind, 'circle');
  assert.equal((oahu.query!.region as { radiusM: number }).radiusM, 100_000);

  const within = first('aircraft within 50 km of HNL', 'query')!;
  assert.deepEqual(within.query!.region, {
    kind: 'circle',
    center: { latitude: 21.3187, longitude: -157.9224 },
    radiusM: 50_000,
  });
  assert.deepEqual(first('vessels within 20 nm of Pearl Harbor', 'query')!.query!.region, {
    kind: 'circle',
    center: { latitude: 21.3649, longitude: -157.9527 },
    radiusM: 37_040,
  });

  const inCal = first('quakes in California', 'query')!;
  assert.equal(inCal.query!.region!.kind, 'bounds');
  assert.deepEqual(
    first('earthquakes Japan', 'query')!.query!.region,
    japan.query!.region,
    'place without preposition still becomes a region',
  );
  assert.deepEqual(first('planes around Seattle', 'query')!.query!.region, {
    kind: 'circle',
    center: { latitude: 47.6062, longitude: -122.3321 },
    radiusM: 100_000,
  });

  const unknown = parseSearch('planes near Nowheresville', ctx);
  const q = unknown.intents.find((i) => i.kind === 'query')!;
  assert.equal(q.confidence, 'MEDIUM');
  assert.equal(q.query!.region, undefined);
  assert.match(unknown.notes[0]!, /Unknown place/);

  assert.deepEqual(first('webcams', 'query')!.query!.objectTypes, ['camera']);
  assert.deepEqual(first('storms and alerts', 'query')!.query!.objectTypes!.sort(), ['storm', 'weather-alert']);
  assert.deepEqual(first('hotspots', 'query')!.query!.objectTypes, ['fire-detection']);
  assert.deepEqual(first('sats', 'query')!.query!.objectTypes, ['satellite']);
  assert.deepEqual(first('boats', 'query')!.query!.objectTypes, ['vessel']);
  assert.deepEqual(first('seismic activity', 'query')!.query!.objectTypes, ['earthquake']);
});

test('parseSearch: thresholds and time phrases', () => {
  const m5 = first('M5+ earthquakes last 24 hours', 'query')!;
  assert.equal(m5.confidence, 'HIGH');
  assert.deepEqual(m5.query!.objectTypes, ['earthquake']);
  assert.deepEqual(m5.query!.filters, [{ field: 'properties.magnitude', op: 'gte', value: 5 }]);
  assert.deepEqual(m5.query!.time, { start: iso(-86_400_000), end: iso(0) });
  assert.equal(m5.title, 'M5+ earthquakes (last 24 hours)');

  assert.deepEqual(first('M6.5 quakes', 'query')!.query!.filters, [
    { field: 'properties.magnitude', op: 'gte', value: 6.5 },
  ]);
  assert.deepEqual(first('earthquakes above 5', 'query')!.query!.filters, [
    { field: 'properties.magnitude', op: 'gte', value: 5 },
  ]);
  assert.deepEqual(first('magnitude > 4 earthquakes', 'query')!.query!.filters, [
    { field: 'properties.magnitude', op: 'gt', value: 4 },
  ]);
  assert.deepEqual(first('earthquakes below 3', 'query')!.query!.filters, [
    { field: 'properties.magnitude', op: 'lte', value: 3 },
  ]);
  assert.deepEqual(first('M5+', 'query')!.query!.objectTypes, ['earthquake'], 'M-form implies earthquakes');

  assert.deepEqual(first('aircraft > 10000 ft', 'query')!.query!.filters, [
    { field: 'position.altitudeM', op: 'gt', value: 3048 },
  ]);
  assert.deepEqual(first('aircraft above 30000 feet', 'query')!.query!.filters, [
    { field: 'position.altitudeM', op: 'gte', value: 9144 },
  ]);
  assert.deepEqual(first('planes >10000ft', 'query')!.query!.filters, [
    { field: 'position.altitudeM', op: 'gt', value: 3048 },
  ]);
  assert.deepEqual(first('ships faster than 20 kt', 'query')!.query!.filters, [
    { field: 'motion.speedMps', op: 'gt', value: 10.289 },
  ]);
  assert.deepEqual(first('aircraft at least 500 knots', 'query')!.query!.filters, [
    { field: 'motion.speedMps', op: 'gte', value: 257.222 },
  ]);
  assert.equal(first('aircraft above 30000 ft', 'query')!.title, 'Aircraft at least 30000 ft');
  const noUnit = parseSearch('aircraft above 5', ctx);
  assert.equal(noUnit.intents.find((i) => i.kind === 'query')!.query!.filters, undefined);
  assert.match(noUnit.notes[0]!, /no unit/);

  assert.deepEqual(first('fires today', 'query')!.query!.time, { start: '2026-09-21T00:00:00.000Z', end: iso(0) });
  assert.deepEqual(first('fires yesterday', 'query')!.query!.time, {
    start: '2026-09-20T00:00:00.000Z',
    end: '2026-09-21T00:00:00.000Z',
  });
  assert.deepEqual(first('alerts since yesterday', 'query')!.query!.time, {
    start: '2026-09-20T00:00:00.000Z',
    end: iso(0),
  });
  assert.deepEqual(first('quakes past week', 'query')!.query!.time, { start: iso(-7 * 86_400_000), end: iso(0) });
  assert.deepEqual(first('quakes in the last 3 days', 'query')!.query!.time, {
    start: iso(-3 * 86_400_000),
    end: iso(0),
  });
  assert.deepEqual(first('quakes last hour', 'query')!.query!.time, { start: iso(-3_600_000), end: iso(0) });
  assert.deepEqual(first('quakes last 12h', 'query')!.query!.time, { start: iso(-12 * 3_600_000), end: iso(0) });
  assert.deepEqual(
    first('quakes this week', 'query')!.query!.time,
    { start: '2026-09-21T00:00:00.000Z', end: iso(0) },
    '2026-09-21 is a Monday',
  );
  const combo = first('M4+ earthquakes near Tokyo in the past 2 days', 'query')!;
  assert.deepEqual(combo.query!.region, {
    kind: 'circle',
    center: { latitude: 35.6762, longitude: 139.6503 },
    radiusM: 100_000,
  });
  assert.deepEqual(combo.query!.time, { start: iso(-2 * 86_400_000), end: iso(0) });
  assert.equal(combo.title, 'M4+ earthquakes near Tokyo (last 2 days)');
});

test('parseSearch: free text, stop words and commands', () => {
  const free = parseSearch('show me the Aloha Star', ctx);
  const q = free.intents.find((i) => i.kind === 'query')!;
  assert.equal(q.confidence, 'LOW');
  assert.equal(q.query!.text, 'Aloha Star');

  const typed = first('aircraft united', 'query')!;
  assert.deepEqual(typed.query, { objectTypes: ['aircraft'], text: 'united' });

  const cmds = parseSearch('source health', ctx).intents.filter((i) => i.kind === 'command');
  assert.equal(cmds[0]!.command, 'open-source-health');
  assert.equal(cmds.length, 1);
  assert.equal(parseSearch('Open Source Health', ctx).intents.find((i) => i.kind === 'command')!.confidence, 'HIGH');
  assert.equal(parseSearch('go live', ctx).intents.find((i) => i.kind === 'command')!.command, 'go-live');
  assert.equal(parseSearch('3d', ctx).intents.find((i) => i.kind === 'command')!.command, 'switch-3d');
  assert.equal(parseSearch('diag', ctx).intents.find((i) => i.kind === 'command')!.command, 'open-diagnostics');
  assert.equal(
    parseSearch('offline pack', ctx).intents.find((i) => i.kind === 'command')!.command,
    'download-offline-pack',
  );
  assert.deepEqual(
    matchCommands('avi', DEFAULT_COMMANDS).map((m) => m.command.id),
    ['lens-aviation'],
  );
  assert.equal(
    parseSearch('fires', { ...ctx, commands: [] }).intents.some((i) => i.kind === 'command'),
    false,
  );
  assert.equal(parseSearch('   ', ctx).intents.length, 0);
});

test('parseSearch is deterministic and pure', () => {
  const a = parseSearch('M5+ earthquakes near Japan last 24 hours', ctx);
  const b = parseSearch('M5+ earthquakes near Japan last 24 hours', ctx);
  assert.deepEqual(a, b);
  const later = parseSearch('M5+ earthquakes near Japan last 24 hours', { ...ctx, now: () => T0 + 60_000 });
  assert.notDeepEqual(later, a, 'time phrases are relative to the injected clock');
});
