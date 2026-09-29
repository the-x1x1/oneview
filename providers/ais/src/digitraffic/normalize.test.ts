import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeEta, locationToDraft, parseLocations, parseVessels, vesselStatic } from './normalize.js';

const NOW = Date.parse('2026-09-28T10:00:00.000Z');
const opts = { receivedAt: new Date(NOW).toISOString(), nowMs: NOW };
const feature = (props: Record<string, unknown>, coords: unknown[] = [24.95, 60.14], mmsi: unknown = 230145250) => ({
  type: 'Feature',
  mmsi,
  geometry: { type: 'Point', coordinates: coords },
  properties: { mmsi, ...props },
});

test('decodeEta: Digitraffic bit packing, with "not available" parts left out', () => {
  // The two examples on digitraffic.fi (MQTT metadata 733376; REST vessels 416128).
  assert.deepEqual(decodeEta(733376), { month: 11, day: 6, hour: 3, minute: 0 });
  assert.deepEqual(decodeEta(416128), { month: 6, day: 11, hour: 6, minute: 0 });
  assert.deepEqual(decodeEta((12 << 16) | (1 << 11) | (24 << 6) | 60), { month: 12, day: 1 });
  assert.equal(decodeEta(0), undefined);
  assert.equal(decodeEta((0 << 16) | (5 << 11)), undefined, 'month 0 is not available');
  assert.equal(decodeEta((3 << 16) | (0 << 11)), undefined, 'day 0 is not available');
  assert.equal(decodeEta('733376'), undefined);
  assert.equal(decodeEta(-1), undefined);
});

test('vesselStatic: both reference-point spellings, draught in tenths, sentinels dropped', () => {
  const rest = vesselStatic({
    mmsi: 230145250,
    name: 'TESTFERRY@@@',
    callSign: ' OJTS1 ',
    imo: 9999001,
    shipType: 60,
    draught: 68,
    destination: 'HELSINKI',
    referencePointA: 120,
    referencePointB: 30,
    referencePointC: 12,
    referencePointD: 15,
    timestamp: NOW - 1000,
  });
  assert.deepEqual(rest, {
    mmsi: '230145250',
    timestampMs: NOW - 1000,
    fields: {
      name: 'TESTFERRY',
      callSign: 'OJTS1',
      imo: '9999001',
      shipType: 60,
      shipTypeText: 'passenger',
      destination: 'HELSINKI',
      draughtM: 6.8,
      lengthM: 150,
      beamM: 27,
    },
  });
  const mqtt = vesselStatic({ mmsi: 276829000, type: 70, refA: 100, refB: 20, refC: 10, refD: 8, draught: 255 });
  assert.equal(mqtt?.fields['shipTypeText'], 'cargo');
  assert.equal(mqtt?.fields['lengthM'], 120);
  assert.equal(mqtt?.fields['beamM'], 18);
  assert.equal(mqtt?.fields['draughtM'], 25.5);
  const empty = vesselStatic({
    mmsi: 212345000,
    imo: 0,
    shipType: 0,
    draught: 0,
    eta: 0,
    name: '',
    destination: '@@@',
  });
  assert.deepEqual(empty?.fields, {});
  assert.equal(vesselStatic({ mmsi: 'x' }), undefined);
  assert.equal(vesselStatic({ mmsi: 0 }), undefined);
  assert.equal(vesselStatic('junk'), undefined);
});

test('locationToDraft: AIS sentinels, heading from COG, turn flags, accuracy', () => {
  const r = locationToDraft(
    feature({
      sog: 102.3,
      cog: 360,
      heading: 511,
      navStat: 15,
      rot: 127,
      posAcc: false,
      timestampExternal: NOW - 5000,
    }),
    new Map(),
    opts,
  );
  assert.equal(r.kind, 'observation');
  if (r.kind !== 'observation') return;
  const p = r.draft.payload;
  assert.equal(p['speedMps'], undefined);
  assert.equal(p['courseDegrees'], undefined);
  assert.equal(p['headingDegrees'], undefined, 'no heading and no course: nothing to point with');
  assert.equal(p['navStatusText'], 'not defined');
  assert.deepEqual(r.draft.quality?.flags, ['turning-right']);
  assert.equal(r.draft.quality?.positionAccuracyM, 100);
  assert.equal(r.draft.observedAt, '2026-09-28T09:59:55.000Z');
  assert.deepEqual(r.draft.position, { latitude: 60.14, longitude: 24.95, altitudeM: 0, altitudeDatum: 'sea-surface' });
  assert.equal(p['flag'], 'Finland');

  const moving = locationToDraft(
    feature({ sog: 10, cog: 90.04, heading: 511, rot: -128, posAcc: true, timestampExternal: NOW }),
    new Map(),
    opts,
  );
  assert.equal(moving.kind, 'observation');
  if (moving.kind !== 'observation') return;
  assert.equal(moving.draft.payload['speedMps'], 5.14);
  assert.equal(moving.draft.payload['headingDegrees'], 90);
  assert.deepEqual(moving.draft.quality?.flags, ['heading-from-cog']);
  assert.equal(moving.draft.payload['rateOfTurnDegPerMin'], undefined, 'ROT −128 is not available');
  assert.equal(moving.draft.quality?.positionAccuracyM, 10);
});

test('locationToDraft: static data folded in; a position field wins over a static one of the same name', () => {
  const statics = new Map([['230145250', { name: 'TESTFERRY', mmsi: 'bogus' }]]);
  const r = locationToDraft(feature({ timestampExternal: NOW }), statics, opts);
  assert.equal(r.kind, 'observation');
  if (r.kind !== 'observation') return;
  assert.equal(r.draft.payload['name'], 'TESTFERRY');
  assert.equal(r.draft.payload['mmsi'], '230145250');
});

test('locationToDraft: rejects what is not a ship position, never throws', () => {
  const reason = (f: unknown) => {
    const r = locationToDraft(f, new Map(), opts);
    return r.kind === 'rejected' ? r.reason : 'admitted';
  };
  assert.equal(reason('junk'), 'feature is not an object');
  assert.equal(reason(feature({}, [24, 60], 0)), 'invalid MMSI');
  assert.equal(reason(feature({}, [24, 60], 'abc')), 'invalid MMSI');
  assert.equal(reason(feature({}, [181, 60])), 'position not available');
  assert.equal(reason(feature({}, [24, 91])), 'position not available');
  assert.equal(reason(feature({}, ['24', 60])), 'position not available');
  assert.equal(reason({ type: 'Feature', mmsi: 230145250 }), 'position not available');
  assert.equal(reason(feature({ timestampExternal: NOW + 3_600_000 })), 'report dated in the future');
  // A minute ahead is clock skew: admitted, dated now.
  const skew = locationToDraft(feature({ timestampExternal: NOW + 60_000 }), new Map(), opts);
  assert.equal(skew.kind === 'observation' && skew.draft.observedAt, opts.receivedAt);
  const undated = locationToDraft(feature({}), new Map(), opts);
  assert.deepEqual(undated.kind === 'observation' && undated.draft.quality?.flags, ['time-from-receipt']);
});

test('parseLocations / parseVessels: the answer shapes', () => {
  assert.deepEqual(parseLocations({ type: 'FeatureCollection', features: [] }), []);
  assert.equal(typeof parseLocations({ vessels: [] }), 'string');
  assert.equal(typeof parseLocations([]), 'string');
  assert.deepEqual(parseVessels([{ mmsi: 1 }]), [{ mmsi: 1 }]);
  assert.equal(typeof parseVessels({ features: [] }), 'string');
});
