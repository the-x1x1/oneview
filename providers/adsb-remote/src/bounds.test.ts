import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineMeters } from '@worldview/world-model';
import { parseHomePosition, pointQueryForBounds } from './bounds.js';
import { pointQueryUrl } from './manifest.js';

test('pointQueryForBounds: centre is quantised and radius covers every corner with margin', () => {
  const bounds = { west: -158.5, south: 20.9, east: -157.3, north: 21.8 };
  const q = pointQueryForBounds(bounds);
  assert.ok(q);
  assert.deepEqual([q.latitude, q.longitude], [21.4, -157.9]);
  assert.equal(q.clipped, false);
  assert.equal(q.radiusNm % 5, 0);
  for (const c of [[21.8, -157.3], [21.8, -158.5], [20.9, -157.3], [20.9, -158.5]] as const) {
    const nm = haversineMeters({ latitude: q.latitude, longitude: q.longitude }, { latitude: c[0], longitude: c[1] }) / 1852;
    assert.ok(nm < q.radiusNm, `corner ${c.join(',')} at ${nm.toFixed(1)} nm outside ${q.radiusNm} nm`);
  }
});

test('pointQueryForBounds: viewport jitter below the quantisation step keeps the same endpoint', () => {
  const a = pointQueryForBounds({ west: -158.5, south: 20.9, east: -157.3, north: 21.8 })!;
  const b = pointQueryForBounds({ west: -158.52, south: 20.91, east: -157.32, north: 21.81 })!;
  assert.equal(pointQueryUrl(a.latitude, a.longitude, a.radiusNm), pointQueryUrl(b.latitude, b.longitude, b.radiusNm));
});

test('pointQueryForBounds: large viewports are clipped to 250 nm; invalid bounds rejected', () => {
  const q = pointQueryForBounds({ west: -170, south: 10, east: -140, north: 35 });
  assert.ok(q);
  assert.equal(q.radiusNm, 250);
  assert.equal(q.clipped, true);
  assert.equal(pointQueryForBounds({ west: 0, south: 10, east: 1, north: 5 }), undefined);
  assert.equal(pointQueryForBounds({ west: 0, south: Number.NaN, east: 1, north: 5 }), undefined);
});

test('pointQueryForBounds: antimeridian-crossing bounds centre on the dateline', () => {
  const q = pointQueryForBounds({ west: 178, south: -20, east: -178, north: -16 });
  assert.ok(q);
  assert.equal(q.latitude, -18);
  assert.ok(q.longitude === 180 || q.longitude === -180, `centre longitude ${q.longitude}`);
});

test('pointQueryUrl: rounds and caps the radius, two-decimal coordinates', () => {
  assert.equal(pointQueryUrl(21.3187, -157.9224, 150.4), 'https://api.adsb.lol/v2/lat/21.32/lon/-157.92/dist/150');
  assert.equal(pointQueryUrl(0, 0, 9999), 'https://api.adsb.lol/v2/lat/0.00/lon/0.00/dist/250');
  assert.equal(pointQueryUrl(0, 0, 0), 'https://api.adsb.lol/v2/lat/0.00/lon/0.00/dist/1');
});

test('parseHomePosition: validates coordinates and radius', () => {
  assert.deepEqual(parseHomePosition({ latitude: 21.32, longitude: -157.92 }), { latitude: 21.32, longitude: -157.92, radiusNm: 100 });
  assert.deepEqual(parseHomePosition({ latitude: 21.32, longitude: -157.92, radiusNm: 900 }), { latitude: 21.32, longitude: -157.92, radiusNm: 250 });
  assert.equal(parseHomePosition({ latitude: 91, longitude: 0 }), undefined);
  assert.equal(parseHomePosition('21.32,-157.92'), undefined);
  assert.equal(parseHomePosition(undefined), undefined);
});
