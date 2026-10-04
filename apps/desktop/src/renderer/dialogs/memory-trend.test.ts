import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEMORY_WARM_UP_MIN, memoryTrend, processLabel, providerErrors } from './diagnostics-dialog.js';

test('memory trend: the change in total after the warm-up, and the words for process kinds', () => {
  assert.equal(MEMORY_WARM_UP_MIN, 30);
  // The laptop's hour in use on 2026-09-29: the climb to 1.9 GB is warm-up, not a trend.
  const hour = [113, 1537, 1642, 1827, 1900, 1930, 1940].map((totalMB, i) => ({
    at: new Date(Date.parse('2026-09-29T13:17:55Z') + i * 600_000).toISOString(),
    totalMB,
  }));
  assert.equal(memoryTrend(hour), '+113 MB over 30 min after warm-up (4 samples)');
  assert.equal(
    memoryTrend([
      { at: '2026-09-23T10:00:00.000Z', totalMB: 100 },
      { at: '2026-09-23T10:30:00.000Z', totalMB: 1400 },
      { at: '2026-09-23T11:30:00.000Z', totalMB: 1410 },
      { at: '2026-09-23T13:40:00.000Z', totalMB: 1442.4 },
    ]),
    '+42 MB over 3 h 10 min after warm-up (3 samples)',
  );
  assert.equal(
    memoryTrend([
      { at: '2026-09-23T10:00:00.000Z', totalMB: 100 },
      { at: '2026-09-23T10:10:00.000Z', totalMB: 1380 },
    ]),
    'warming up — the trend starts 30 minutes after start (20 min to go)',
  );
  assert.match(memoryTrend([{ at: '2026-09-23T10:00:00.000Z', totalMB: 1 }]), /one sample so far/);
  assert.equal(processLabel('Browser', 1), 'Main process');
  assert.equal(processLabel('Tab', 2), 'Pages (2)');
  assert.equal(processLabel('Utility', 3), 'Utility processes (3)');
});

test('a source waiting for the operator says so instead of an error rate', () => {
  assert.equal(
    providerErrors({ status: 'NEEDS_SETUP', errorRate: 0, lastError: { code: 'HOST_NOT_ALLOWED' } }),
    'waiting for setup',
  );
  assert.equal(
    providerErrors({ status: 'AUTH_REQUIRED', errorRate: 0, credentialState: 'missing', lastError: { code: 'AUTH' } }),
    'waiting for a key',
  );
  assert.equal(
    providerErrors({ status: 'AUTH_REQUIRED', errorRate: 1, credentialState: 'present', lastError: { code: 'AUTH' } }),
    '100% · AUTH',
    'a key that is refused is a failure',
  );
  assert.equal(providerErrors({ status: 'LIVE', errorRate: 0.05, lastError: { code: 'NETWORK' } }), '5% · NETWORK');
  assert.equal(providerErrors({ status: 'LIVE', errorRate: 0 }), '0%');
});
