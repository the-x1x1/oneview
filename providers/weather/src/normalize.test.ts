import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { observationSchema, formatIssues } from '@worldview/world-model';
import {
  alertUrn,
  featureToDraft,
  isoOrUndefined,
  mapSeverity,
  normalizeNwsAlerts,
  toGeometry,
  REJECT_NO_GEOMETRY,
  REJECT_ZONE_ONLY,
} from './normalize.js';

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'weather');
const load = (name: string): unknown => JSON.parse(readFileSync(path.join(fixtures, name), 'utf8'));
const NOW = Date.parse('2026-09-21T08:05:00Z');
const opts = {
  receivedAt: new Date(NOW).toISOString(),
  nowMs: NOW,
  sourceRef: 'https://api.weather.gov/alerts/active?status=actual&message_type=alert,update',
};

test('the normal feed yields the seven polygon alerts and explains the two skipped ones', () => {
  const r = normalizeNwsAlerts(load('normal.geojson'), {
    ...opts,
    hash: (s) => 'c'.repeat(63) + String(s.length % 10),
  });
  assert.equal(r.total, 9);
  assert.equal(r.observations.length, 7);
  assert.deepEqual(
    r.rejected.map((x) => x.reason),
    [REJECT_ZONE_ONLY, REJECT_NO_GEOMETRY],
  );
  assert.equal(r.updatedAt, '2026-09-21T07:58:12.000Z');
  for (const o of r.observations) {
    const v = observationSchema.parse(o);
    assert.ok(v.ok, v.ok ? '' : formatIssues(v.issues));
    assert.equal(o.objectType, 'weather-alert');
    assert.equal(o.position !== undefined && o.geometry?.type === 'Polygon', true);
    assert.equal(o.payload['title'], o.payload['event']);
    assert.match(o.rawPayloadHash!, /^c{63}\d$/);
  }
  const marine = r.observations.find((o) => o.payload['event'] === 'Special Marine Warning')!;
  assert.deepEqual(marine.payload['sameCodes'], []);
  assert.deepEqual(marine.payload['ugcCodes'], ['GMZ150']);
  assert.equal(marine.payload['severity'], 'MODERATE');
  assert.equal(marine.payload['nwsSeverity'], 'Moderate');
});

test('timestamps: local offsets → UTC; onset/effective and ends/expires precedence; expiry grace', () => {
  assert.equal(isoOrUndefined('2026-09-21T02:45:00-05:00'), '2026-09-21T07:45:00.000Z');
  assert.equal(isoOrUndefined('2026-09-21T07:58:12+00:00'), '2026-09-21T07:58:12.000Z');
  assert.equal(isoOrUndefined(''), undefined);
  assert.equal(isoOrUndefined('soon'), undefined);
  const feature = (
    over: Record<string, unknown>,
    geometry: unknown = {
      type: 'Polygon',
      coordinates: [
        [
          [-97, 30],
          [-96, 30],
          [-96, 31],
          [-97, 31],
          [-97, 30],
        ],
      ],
    },
  ) => ({
    id: 'https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.abc.001.1',
    type: 'Feature',
    geometry,
    properties: {
      id: 'urn:oid:2.49.0.1.840.0.abc.001.1',
      event: 'Flood Warning',
      sent: '2026-09-21T02:00:00-05:00',
      effective: '2026-09-21T02:00:00-05:00',
      expires: '2026-09-21T05:00:00-05:00',
      severity: 'Severe',
      certainty: 'Likely',
      urgency: 'Expected',
      areaDesc: 'X',
      senderName: 'NWS X',
      description: 'd',
      messageType: 'Alert',
      category: 'Met',
      geocode: { SAME: ['012345'], UGC: ['TXC001'] },
      ...over,
    },
  });
  const plain = featureToDraft(feature({}), opts);
  assert.ok(typeof plain !== 'string');
  assert.equal(plain.observedAt, '2026-09-21T07:00:00.000Z');
  assert.equal(plain.effectiveFrom, '2026-09-21T07:00:00.000Z');
  assert.equal(plain.effectiveUntil, '2026-09-21T10:00:00.000Z');
  const withOnset = featureToDraft(
    feature({ onset: '2026-09-21T04:00:00-05:00', ends: '2026-09-22T00:00:00-05:00' }),
    opts,
  );
  assert.ok(typeof withOnset !== 'string');
  assert.equal(withOnset.effectiveFrom, '2026-09-21T09:00:00.000Z');
  assert.equal(withOnset.effectiveUntil, '2026-09-22T05:00:00.000Z');
  assert.equal(featureToDraft(feature({ ends: '2026-09-21T01:30:00-05:00' }), opts), 'expired', 'ended > 1 h ago');
  const justEnded = featureToDraft(feature({ ends: '2026-09-21T02:30:00-05:00' }), opts);
  assert.ok(typeof justEnded !== 'string', 'ended 35 min ago is still within the grace period');
  assert.equal(featureToDraft(feature({ sent: null }), opts), 'invalid sent timestamp');
  assert.equal(featureToDraft(feature({ expires: undefined, ends: undefined }), opts), 'missing expires/ends');
  assert.equal(featureToDraft(feature({ onset: '2026-09-21T06:00:00-05:00' }), opts), 'onset after end');
  assert.equal(featureToDraft(feature({ status: 'Test' }), opts), 'status Test is not Actual');
  const future = featureToDraft(
    feature({ sent: '2026-09-21T04:00:00-05:00', expires: '2026-09-21T09:00:00-05:00' }),
    opts,
  );
  assert.ok(
    typeof future !== 'string' && future.observedAt === '2026-09-21T08:05:00.000Z',
    'observedAt clamped to now; payload keeps sent',
  );
  assert.equal(typeof future !== 'string' && future.payload['sent'], '2026-09-21T09:00:00.000Z');
});

test('geometry policy: polygons only; zone-only and geometry-less alerts reject with distinct reasons', () => {
  assert.equal(toGeometry(null), undefined);
  assert.equal(toGeometry({ type: 'Point', coordinates: [1, 2] }), 'unsupported geometry Point');
  assert.equal(
    toGeometry({
      type: 'Polygon',
      coordinates: [
        [
          [-97, 95],
          [-96, 30],
          [-96, 31],
          [-97, 95],
        ],
      ],
    }),
    'invalid polygon coordinates',
  );
  assert.equal(
    toGeometry({
      type: 'Polygon',
      coordinates: [
        [
          [-97, 30],
          [-96, 30],
          [-97, 30],
        ],
      ],
    }),
    'polygon ring too short',
  );
  const multi = toGeometry({
    type: 'MultiPolygon',
    coordinates: [
      [
        [
          [-97, 30],
          [-96, 30],
          [-96, 31],
          [-97, 30],
        ],
      ],
      [
        [
          [-90, 40],
          [-89, 40],
          [-89, 41],
          [-90, 40],
        ],
      ],
    ],
  });
  assert.ok(typeof multi === 'object' && multi.type === 'MultiPolygon');
  const rows = normalizeNwsAlerts(load('malformed-rows.geojson'), opts);
  assert.equal(rows.total, 8);
  assert.equal(rows.observations.length, 1);
  assert.deepEqual(
    rows.rejected.map((x) => x.reason),
    [
      'invalid polygon coordinates',
      'unsupported geometry LineString',
      'expired',
      'invalid sent timestamp',
      'invalid alert id',
      'feature not an object',
      'duplicate alert urn:oid:2.49.0.1.840.0.8ea5b47ac7ab2ff0f8f3d5d6c9c0d5c8f4e3b4b6.001.1',
    ],
  );
  assert.equal(normalizeNwsAlerts(load('malformed-shape.json'), opts).rejected[0]?.index, -1);
  assert.equal(normalizeNwsAlerts('nope', opts).rejected[0]?.reason, 'not a FeatureCollection');
});

test('severity mapping and alert ids', () => {
  assert.equal(mapSeverity('Extreme'), 'EXTREME');
  assert.equal(mapSeverity('severe'), 'SEVERE');
  assert.equal(mapSeverity('Moderate'), 'MODERATE');
  assert.equal(mapSeverity('Minor'), 'MINOR');
  assert.equal(mapSeverity('Unknown'), 'INFO');
  assert.equal(mapSeverity(undefined), 'INFO');
  assert.equal(
    alertUrn({ id: 'https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.abc.001.1', properties: {} }),
    'urn:oid:2.49.0.1.840.0.abc.001.1',
  );
  assert.equal(
    alertUrn({ properties: { id: 'urn:oid:2.49.0.1.840.0.abc.001.1' } }),
    'urn:oid:2.49.0.1.840.0.abc.001.1',
  );
  assert.equal(alertUrn({ id: 'https://api.weather.gov/alerts/has space', properties: { id: 'also bad' } }), undefined);
  assert.equal(alertUrn({ properties: {} }), undefined);
});

test('an update keeps the messages it references (CAP references), so the chain can be linked', () => {
  const r = normalizeNwsAlerts(load('normal.geojson'), opts);
  const update = r.observations.find((o) => o.payload['messageType'] === 'Update');
  assert.ok(update, 'the fixture has an Update');
  assert.deepEqual(update.payload['references'], [
    'urn:oid:2.49.0.1.840.0.0000000000000000000000000000000000000001.001.1',
  ]);
  const plain = r.observations.find((o) => o.payload['messageType'] === 'Alert');
  assert.equal(plain?.payload['references'], undefined, 'no references, no property');
});
