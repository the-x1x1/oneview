import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeAisFrame, normalizeAisEnvelope, normalizeMmsi, shipTypeText } from './normalize.js';
import { boundingBoxesFor, buildSubscriptionFrame } from './subscription.js';

const opts = { receivedAt: '2026-09-21T08:00:10.000Z' };
const position = (over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) => ({
  MessageType: 'PositionReport',
  MetaData: {
    MMSI: 366123456,
    ShipName: 'KALIHI TRADER      ',
    latitude: 21.3044,
    longitude: -157.8735,
    time_utc: '2026-09-21 08:00:03.123456789 +0000 UTC',
    ...meta,
  },
  Message: {
    PositionReport: {
      Cog: 254.3,
      Sog: 11.4,
      TrueHeading: 252,
      NavigationalStatus: 0,
      RateOfTurn: 0,
      UserID: 366123456,
      ...over,
    },
  },
});

test('normalizeMmsi: digits only, zero-padded to 9, rejects empty/long/zero', () => {
  assert.equal(normalizeMmsi(366123456), '366123456');
  assert.equal(normalizeMmsi(2320001), '002320001');
  assert.equal(normalizeMmsi(' 244660744 '), '244660744');
  assert.equal(normalizeMmsi(1234567890), undefined);
  assert.equal(normalizeMmsi('abc'), undefined);
  assert.equal(normalizeMmsi(0), undefined);
  assert.equal(normalizeMmsi(-1), undefined);
  assert.equal(normalizeMmsi(12.5), undefined);
});

test('position report → vessel draft with SI units, sea-surface position, nav status text', () => {
  const r = normalizeAisEnvelope(position(), opts);
  assert.equal(r.kind, 'observation');
  if (r.kind !== 'observation') return;
  const d = r.draft;
  assert.equal(d.externalId, '366123456');
  assert.equal(d.objectType, 'vessel');
  assert.equal(d.observedAt, '2026-09-21T08:00:03.123Z');
  assert.deepEqual(d.position, { latitude: 21.3044, longitude: -157.8735, altitudeM: 0, altitudeDatum: 'sea-surface' });
  assert.equal(d.payload['mmsi'], '366123456');
  assert.equal(d.payload['name'], 'KALIHI TRADER');
  assert.equal(d.payload['speedMps'], 5.86);
  assert.equal(d.payload['courseDegrees'], 254.3);
  assert.equal(d.payload['headingDegrees'], 252);
  assert.equal(d.payload['navStatus'], 0);
  assert.equal(d.payload['navStatusText'], 'under way using engine');
  assert.equal(d.payload['rateOfTurnDegPerMin'], 0);
  assert.equal(d.quality?.complete, true);
  assert.equal(d.quality?.sourceQuality, 'crowdsourced');
  assert.equal(d.quality?.flags, undefined);
});

test('sentinels: heading 511 → COG fallback, SOG 102.3 / COG 360 / ROT ±127 & −128 dropped', () => {
  const a = normalizeAisEnvelope(position({ TrueHeading: 511, RateOfTurn: -128 }), opts);
  assert.ok(a.kind === 'observation');
  assert.equal(a.draft.payload['headingDegrees'], 254.3);
  assert.deepEqual(a.draft.quality?.flags, ['heading-from-cog']);
  assert.equal(a.draft.payload['rateOfTurnDegPerMin'], undefined);
  const b = normalizeAisEnvelope(position({ TrueHeading: 511, Cog: 360, Sog: 102.3, RateOfTurn: 127 }), opts);
  assert.ok(b.kind === 'observation');
  assert.equal(b.draft.payload['headingDegrees'], undefined);
  assert.equal(b.draft.payload['courseDegrees'], undefined);
  assert.equal(b.draft.payload['speedMps'], undefined);
  assert.deepEqual(b.draft.quality?.flags, ['turning-right']);
  const c = normalizeAisEnvelope(position({ RateOfTurn: -20 }), opts);
  assert.ok(c.kind === 'observation');
  assert.equal(c.draft.payload['rateOfTurnDegPerMin'], -17.9);
});

test('time_utc unparsable → receivedAt with flag; position not available → malformed', () => {
  const a = normalizeAisEnvelope(position({}, { time_utc: 'soon' }), opts);
  assert.ok(a.kind === 'observation');
  assert.equal(a.draft.observedAt, opts.receivedAt);
  assert.deepEqual(a.draft.quality?.flags, ['time-from-receipt']);
  assert.deepEqual(normalizeAisEnvelope(position({}, { latitude: 91, longitude: 181 }), opts), {
    kind: 'malformed',
    reason: 'position not available',
  });
  assert.deepEqual(normalizeAisEnvelope(position({}, { latitude: 'north' }), opts), {
    kind: 'malformed',
    reason: 'position not available',
  });
});

test('ShipStaticData → incomplete observation with identity/dimension payload', () => {
  const r = normalizeAisEnvelope(
    {
      MessageType: 'ShipStaticData',
      MetaData: {
        MMSI: 366123456,
        ShipName: 'KALIHI TRADER',
        latitude: 21.3044,
        longitude: -157.8735,
        time_utc: '2026-09-21 08:00:06.25 +0000 UTC',
      },
      Message: {
        ShipStaticData: {
          CallSign: 'WDK4421',
          Destination: 'HONOLULU@@@',
          Dimension: { A: 120, B: 42, C: 12, D: 13 },
          Eta: { Day: 21, Hour: 14, Minute: 30, Month: 9 },
          ImoNumber: 9312345,
          MaximumStaticDraught: 8.4,
          Name: 'KALIHI TRADER      ',
          Type: 70,
          UserID: 366123456,
        },
      },
    },
    opts,
  );
  assert.ok(r.kind === 'observation');
  const p = r.draft.payload;
  assert.equal(r.draft.observedAt, '2026-09-21T08:00:06.250Z');
  assert.deepEqual(p, {
    mmsi: '366123456',
    name: 'KALIHI TRADER',
    imo: '9312345',
    callSign: 'WDK4421',
    shipType: 70,
    shipTypeText: 'cargo',
    destination: 'HONOLULU',
    lengthM: 162,
    beamM: 25,
    draughtM: 8.4,
    eta: { month: 9, day: 21, hour: 14, minute: 30 },
  });
  assert.equal(r.draft.quality?.complete, false);
  assert.deepEqual(r.draft.quality?.flags, ['static-data']);
  assert.equal(r.draft.position?.latitude, 21.3044);
  // Static data without a usable position is still an observation (identity only).
  const noPos = normalizeAisEnvelope(
    {
      MessageType: 'ShipStaticData',
      MetaData: { MMSI: 366123456, time_utc: '2026-09-21 08:00:06 +0000 UTC' },
      Message: {
        ShipStaticData: {
          Name: 'X',
          Type: 37,
          Dimension: { A: 0, B: 0, C: 0, D: 0 },
          MaximumStaticDraught: 0,
          ImoNumber: 0,
        },
      },
    },
    opts,
  );
  assert.ok(noPos.kind === 'observation');
  assert.equal(noPos.draft.position, undefined);
  assert.deepEqual(noPos.draft.payload, { mmsi: '366123456', name: 'X', shipType: 37, shipTypeText: 'pleasure craft' });
});

test('error envelopes are classified; unsupported types ignored; malformed reasons explicit', () => {
  assert.deepEqual(normalizeAisEnvelope({ error: 'Api Key Is Not Valid' }, opts), {
    kind: 'error',
    auth: true,
    message: 'Api Key Is Not Valid',
  });
  assert.deepEqual(normalizeAisEnvelope({ error: 'Bounding box invalid' }, opts), {
    kind: 'error',
    auth: false,
    message: 'Bounding box invalid',
  });
  assert.deepEqual(
    normalizeAisEnvelope(
      {
        MessageType: 'BaseStationReport',
        MetaData: { MMSI: 2320001, time_utc: '2026-09-21 08:00:00 +0000 UTC' },
        Message: { BaseStationReport: {} },
      },
      opts,
    ),
    { kind: 'ignored', messageType: 'BaseStationReport' },
  );
  assert.deepEqual(normalizeAisEnvelope(null, opts), { kind: 'malformed', reason: 'envelope is not an object' });
  assert.deepEqual(normalizeAisEnvelope([], opts), { kind: 'malformed', reason: 'envelope is not an object' });
  assert.deepEqual(normalizeAisEnvelope({ MetaData: {} }, opts), { kind: 'malformed', reason: 'missing MessageType' });
  assert.deepEqual(normalizeAisEnvelope({ MessageType: 'PositionReport' }, opts), {
    kind: 'malformed',
    reason: 'missing MetaData',
  });
  assert.deepEqual(normalizeAisEnvelope({ MessageType: 'PositionReport', MetaData: {}, Message: {} }, opts), {
    kind: 'malformed',
    reason: 'missing Message.PositionReport',
  });
  assert.deepEqual(
    normalizeAisEnvelope(
      { MessageType: 'PositionReport', MetaData: { MMSI: 'x' }, Message: { PositionReport: {} } },
      opts,
    ),
    { kind: 'malformed', reason: 'invalid MMSI' },
  );
});

test('decodeAisFrame handles text and binary frames', () => {
  assert.deepEqual(decodeAisFrame('{"a":1}'), { a: 1 });
  assert.deepEqual(decodeAisFrame(new TextEncoder().encode('{"a":2}')), { a: 2 });
  assert.equal(decodeAisFrame('{"a":'), undefined);
});

test('shipTypeText covers the ITU classes', () => {
  assert.equal(shipTypeText(0), 'not available');
  assert.equal(shipTypeText(30), 'fishing');
  assert.equal(shipTypeText(52), 'tug');
  assert.equal(shipTypeText(65), 'passenger');
  assert.equal(shipTypeText(89), 'tanker');
  assert.equal(shipTypeText(99), 'other');
  assert.equal(shipTypeText(100), undefined);
  assert.equal(shipTypeText(-1), undefined);
});

test('subscription frame: key, bounding boxes ([lat, lon] pairs, antimeridian split) and filters', () => {
  const frame = JSON.parse(buildSubscriptionFrame('k', { west: -158.3, south: 21.1, east: -157.6, north: 21.5 })) as {
    APIKey: string;
    BoundingBoxes: number[][][];
    FilterMessageTypes: string[];
  };
  assert.equal(frame.APIKey, 'k');
  assert.deepEqual(frame.BoundingBoxes, [
    [
      [21.1, -158.3],
      [21.5, -157.6],
    ],
  ]);
  assert.deepEqual(frame.FilterMessageTypes, ['PositionReport', 'ShipStaticData']);
  assert.deepEqual(boundingBoxesFor(undefined), [
    [
      [-90, -180],
      [90, 180],
    ],
  ]);
  assert.deepEqual(boundingBoxesFor({ west: 178, south: -20, east: -178, north: -16 }), [
    [
      [-20, 178],
      [-16, 180],
    ],
    [
      [-20, -180],
      [-16, -178],
    ],
  ]);
  assert.deepEqual(
    boundingBoxesFor({ west: 0, south: 10, east: 1, north: 5 }),
    [
      [
        [-90, -180],
        [90, 180],
      ],
    ],
    'invalid bounds → world',
  );
});
