import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testing, type ProviderHealth, type ProviderManifest } from '@worldview/provider-sdk';
import { SourceHealthRegistry } from './index.js';

function manifest(id: string, required = false): ProviderManifest {
  return {
    id,
    name: id,
    categories: ['test'],
    transport: 'http',
    credentials: required ? [{ key: `${id}.key`, label: 'Key', required: true }] : [],
    attribution: { text: id },
    dataPolicy: { cacheAllowed: true },
    refreshPolicy: { intervalMs: 60_000 },
    commercialReview: 'not-required',
  } as unknown as ProviderManifest;
}

function health(providerId: string, patch: Partial<ProviderHealth>): ProviderHealth {
  return {
    providerId,
    status: 'LIVE',
    errorRate: 0,
    rateLimitState: { limited: false },
    credentialState: 'not-required',
    ...patch,
  };
}

test('connection: a source waiting for a key nobody entered does not make the app DEGRADED', () => {
  const r = new SourceHealthRegistry(new testing.VirtualClock(0));
  r.register(manifest('usgs'), { enabled: true, locality: 'remote' });
  r.register(manifest('ais', true), { enabled: true, locality: 'remote' });
  r.update(health('usgs', {}));
  r.update(health('ais', { status: 'AUTH_REQUIRED', credentialState: 'missing' }));
  assert.equal(r.connection().state, 'CONNECTED');
  assert.equal(r.connection().remoteTotal, 1);

  // A key that was entered and refused is a failure the badge should show.
  r.update(health('ais', { status: 'AUTH_REQUIRED', credentialState: 'invalid' }));
  assert.equal(r.connection().state, 'DEGRADED');
});
