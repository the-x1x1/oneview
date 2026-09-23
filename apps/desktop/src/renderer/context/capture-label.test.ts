import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureLabel, snapshotPollMs } from './sections.js';

test('camera still label: the image’s own time and age, or plainly the fetch time', () => {
  const at = '2026-09-23T06:00:00.000Z';
  const fetched = Date.parse(at) + 6 * 60_000;
  assert.equal(captureLabel({ capturedAt: null }), '');
  assert.match(
    captureLabel({ capturedAt: at, source: 'upstream', fetchedAtMs: fetched }),
    /^Captured .* · 6m old when fetched$/,
  );
  assert.match(
    captureLabel({ capturedAt: at, source: 'upstream', fetchedAtMs: Date.parse(at) + 20_000 }),
    /^Captured [^·]*$/,
    'under a minute old: no age',
  );
  assert.match(
    captureLabel({ capturedAt: at, source: 'fetched', fetchedAtMs: fetched }),
    /^Fetched .* publishes no capture time$/,
  );
  assert.match(captureLabel({ capturedAt: at }), /^Captured /, 'a user camera makes the image when asked');
});

test('an open snapshot refreshes at the camera’s own interval, kept between 30 s and 10 min', () => {
  const cam = (refreshSeconds?: number) =>
    ({ properties: refreshSeconds === undefined ? {} : { refreshSeconds } }) as unknown as Parameters<
      typeof snapshotPollMs
    >[0];
  assert.equal(snapshotPollMs(cam(120)), 120_000, 'Hong Kong: every two minutes');
  assert.equal(snapshotPollMs(cam(5)), 30_000, 'never faster than every 30 s');
  assert.equal(snapshotPollMs(cam(3600)), 600_000, 'never slower than every 10 min');
  assert.equal(snapshotPollMs(cam()), undefined, 'no stated interval: the button only');
});
