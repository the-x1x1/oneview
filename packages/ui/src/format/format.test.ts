import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAgo, formatAltitude, formatBytes, formatCoordinates, formatDepthKm, formatDistance, formatDuration, formatHeading, formatMagnitude, formatObjectType, formatRelativeAge, formatSpeed, formatUtcDateTime, formatVerticalRate } from './format.js';

test('relative age: 12s / 8m / 23m / hours / days', () => {
  assert.equal(formatRelativeAge(12_000), '12s');
  assert.equal(formatRelativeAge(8 * 60_000), '8m');
  assert.equal(formatRelativeAge(23 * 60_000 + 40_000), '23m');
  assert.equal(formatRelativeAge(3 * 3600_000), '3h');
  assert.equal(formatRelativeAge(50 * 3600_000), '2d');
  assert.equal(formatRelativeAge(-5000), '0s');
  assert.equal(formatRelativeAge(Number.NaN), 'unknown');
  const now = Date.parse('2026-09-21T08:00:00Z');
  assert.equal(formatAgo('2026-09-21T07:52:00Z', now), '8m ago');
  assert.equal(formatAgo('not-a-date', now), 'unknown');
  assert.equal(formatAgo(undefined, now), 'unknown');
});

test('altitude, speed, vertical rate, heading', () => {
  assert.equal(formatAltitude(10_668), '35,000 ft');
  assert.equal(formatAltitude(10_668, 'm'), '10,668 m');
  assert.equal(formatAltitude(undefined), undefined);
  assert.equal(formatSpeed(231.5), '450 kt');
  assert.equal(formatSpeed(27.78, 'km/h'), '100 km/h');
  assert.equal(formatSpeed(1.234, 'm/s'), '1.2 m/s');
  assert.equal(formatVerticalRate(-5.08), '-1,000 ft/min');
  assert.equal(formatVerticalRate(2.54), '+500 ft/min');
  assert.equal(formatHeading(0), '000° N');
  assert.equal(formatHeading(272), '272° W');
  assert.equal(formatHeading(-90), '270° W');
});

test('coordinates, distance, depth, magnitude, bytes, duration, dates, type labels', () => {
  assert.equal(formatCoordinates(19.4067, -155.2833), '19.4067° N, 155.2833° W');
  assert.equal(formatCoordinates(-33.9, 151.2, 2), '33.90° S, 151.20° E');
  assert.equal(formatCoordinates(Number.NaN, 1), 'unknown');
  assert.equal(formatDistance(850), '850 m');
  assert.equal(formatDistance(12_345), '12.3 km');
  assert.equal(formatDistance(1_234_567), '1,235 km');
  assert.equal(formatDepthKm(7.25), '7.3 km');
  assert.equal(formatDepthKm(45.3), '45 km');
  assert.equal(formatMagnitude(5.7, 'mww'), 'M 5.7 mww');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(40 * 1024 * 1024 * 1024), '40 GB');
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(200_000), '3m 20s');
  assert.equal(formatDuration(3900_000), '1h 05m');
  assert.equal(formatUtcDateTime('2026-09-21T08:00:00.000Z'), '2026-09-21 08:00:00 UTC');
  assert.equal(formatUtcDateTime(undefined), 'unknown');
  assert.equal(formatObjectType('fire-detection'), 'Fire detection');
});
