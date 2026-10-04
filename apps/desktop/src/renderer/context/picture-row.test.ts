import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pictureRow, registeredCameraId } from './sections.js';

const now = Date.parse('2026-10-03T22:00:00Z');

test('a registered camera says whether its picture is being served, and when it last was', () => {
  assert.equal(pictureRow(undefined, now), undefined, 'a public camera has no picture health');
  assert.equal(pictureRow({ status: 'unknown' }, now), 'Not fetched yet');
  assert.equal(pictureRow({ status: 'ok' }, now), 'Served');
  assert.equal(
    pictureRow({ status: 'ok', lastSuccessAt: '2026-10-03T21:59:30Z' }, now),
    'Served · last good frame 30s ago',
  );
});

test('a failing picture says why, and keeps the last good frame in view', () => {
  assert.equal(
    pictureRow(
      {
        status: 'degraded',
        lastSuccessAt: '2026-10-03T21:50:00Z',
        lastErrorAt: '2026-10-03T21:59:00Z',
        lastError: { code: 'timeout', message: 'upstream timed out' },
      },
      now,
    ),
    'Failing — upstream timed out · last good frame 10m ago',
  );
  assert.equal(
    pictureRow(
      {
        status: 'unavailable',
        lastErrorAt: '2026-10-03T20:00:00Z',
        lastError: { code: 'unreachable', message: 'connection refused' },
      },
      now,
    ),
    'Unavailable — connection refused · since 2026-10-03 20:00:00 UTC',
    'a camera that never served a frame has no last good frame to show',
  );
});

test('the panel finds its camera in the list by the bare id behind its media ref', () => {
  assert.equal(registeredCameraId('camera:eab6d677839d'), 'eab6d677839d');
  assert.equal(registeredCameraId('eab6d677839d'), 'eab6d677839d');
  assert.equal(registeredCameraId('public:fintraffic:C0150200'), 'public:fintraffic:C0150200');
});
