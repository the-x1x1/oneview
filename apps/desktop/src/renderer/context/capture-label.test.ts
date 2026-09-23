import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureLabel } from './sections.js';

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
