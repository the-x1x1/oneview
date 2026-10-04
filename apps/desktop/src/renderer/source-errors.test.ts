import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorRateRow, providerErrors } from './source-errors.js';

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

test('Source health has no error rate for a source that waits for the operator', () => {
  assert.equal(errorRateRow({ status: 'AUTH_REQUIRED', errorRate: 1, credentialState: 'missing' }), undefined);
  assert.equal(errorRateRow({ status: 'NEEDS_SETUP', errorRate: 1 }), undefined);
  assert.equal(errorRateRow({ status: 'LIVE', errorRate: 0 }), undefined);
  assert.equal(errorRateRow({ status: 'DEGRADED', errorRate: 0.25 }), '25%');
});
