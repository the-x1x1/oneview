import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAisTimestamp } from './time.js';

test('parseAisTimestamp: Go time.String() shapes with nanoseconds and zone suffixes', () => {
  assert.equal(parseAisTimestamp('2026-09-21 08:00:03.123456789 +0000 UTC'), '2026-09-21T08:00:03.123Z');
  assert.equal(parseAisTimestamp('2026-09-21 08:00:03 +0000 UTC'), '2026-09-21T08:00:03.000Z');
  assert.equal(parseAisTimestamp('2026-09-21 08:00:03.5 +0000 +0000'), '2026-09-21T08:00:03.500Z');
  assert.equal(parseAisTimestamp('2026-09-21 08:00:03.999999 +0000 UTC m=+12.345'), '2026-09-21T08:00:03.999Z');
  assert.equal(parseAisTimestamp('  2026-09-21 08:00:03 UTC '), '2026-09-21T08:00:03.000Z');
});

test('parseAisTimestamp: ISO 8601 with Z and numeric offsets', () => {
  assert.equal(parseAisTimestamp('2026-09-21T08:00:03Z'), '2026-09-21T08:00:03.000Z');
  assert.equal(parseAisTimestamp('2026-09-21T10:00:03.250+02:00'), '2026-09-21T08:00:03.250Z');
  assert.equal(parseAisTimestamp('2026-09-21 03:30:03 -0430'), '2026-09-21T08:00:03.000Z');
});

test('parseAisTimestamp: epoch seconds and milliseconds', () => {
  assert.equal(parseAisTimestamp(1789977603), '2026-09-21T08:00:03.000Z');
  assert.equal(parseAisTimestamp(1789977603123), '2026-09-21T08:00:03.123Z');
  assert.equal(parseAisTimestamp(0), undefined);
  assert.equal(parseAisTimestamp(-5), undefined);
});

test('parseAisTimestamp: garbage, impossible dates and out-of-range values are rejected', () => {
  assert.equal(parseAisTimestamp(''), undefined);
  assert.equal(parseAisTimestamp('yesterday'), undefined);
  assert.equal(parseAisTimestamp('2026-02-30 08:00:03 +0000 UTC'), undefined);
  assert.equal(parseAisTimestamp('2026-13-01 08:00:03 +0000 UTC'), undefined);
  assert.equal(parseAisTimestamp('2026-09-21 25:00:03 +0000 UTC'), undefined);
  assert.equal(parseAisTimestamp('1999-12-31 23:59:59 +0000 UTC'), undefined);
  assert.equal(parseAisTimestamp(null), undefined);
  assert.equal(parseAisTimestamp({}), undefined);
});
