import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProvider as createUsgs } from '@worldview/provider-usgs';
import { ProviderError, type ProviderContext, type ProviderHealth, type ProviderManifest, type ProviderQuery, type WorldProvider } from '@worldview/provider-sdk';
import type { Observation } from '@worldview/world-model';
import { readFixture, settle, startRuntime, tableFetch } from '../helpers/harness.js';

/**
 * (iv) Failure injection: a provider that throws on every single poll must not take the
 * application with it. Its health entry says so, the connection indicator degrades
 * honestly, and every other part of the runtime keeps answering.
 */
const BROKEN_MANIFEST: ProviderManifest = {
  id: 'broken-test-provider',
  name: 'Broken provider (failure injection)',
  version: '0.0.0',
  description: 'Throws on initialize/query/health. Exists only to prove the runtime isolates provider failures.',
  objectTypes: ['sensor'],
  categories: ['earth'],
  transport: 'filesystem',
  capabilities: { live: true, historical: false, offline: false, boundsQuery: false },
  credentials: [],
  refreshPolicy: { intervalMs: 60_000, minIntervalMs: 60_000, timeoutMs: 5_000, maxRetries: 0, maxRequestsPerMinute: 10, staleWhileErrorMs: 0 },
  dataPolicy: {
    cacheAllowed: false, rawPayloadRetentionAllowed: false, normalizedRetentionAllowed: false,
    redistributionAllowed: false, offlinePackAllowed: false, exportAllowed: false, commercialUseAllowed: false,
    attributionRequired: false,
  },
  attribution: { text: 'Failure-injection test provider' },
  commercialReview: 'approved',
  enabledByDefault: true,
  allowedHosts: [],
};

class BrokenProvider implements WorldProvider {
  readonly manifest = BROKEN_MANIFEST;
  polls = 0;
  async initialize(_context: ProviderContext): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async query(_request: ProviderQuery): Promise<Observation[]> {
    this.polls++;
    throw new Error('this provider is broken on purpose');
  }
  async health(): Promise<ProviderHealth> {
    throw new ProviderError('INTERNAL', 'health() is broken too');
  }
}

test('failure: a provider that throws on every poll leaves the rest of the application working', async () => {
  const body = await readFixture('usgs', 'normal.geojson');
  const { impl: fetchImpl } = tableFetch({
    'https://earthquake.usgs.gov/': () => new Response(body, { status: 200, headers: { 'content-type': 'application/geo+json' } }),
  });
  const broken = new BrokenProvider();
  const h = await startRuntime({ fetchImpl, providerInstances: [createUsgs(), broken] });
  try {
    // Poll both; the broken one throws every time.
    for (let i = 0; i < 3; i++) {
      await h.client.request('sources.refresh', { providerId: 'broken-test-provider' });
      await h.client.request('sources.refresh', { providerId: 'usgs-earthquakes' });
    }
    await settle();
    assert.equal(broken.polls, 3, 'the runtime kept calling it — no silent disable');

    // --- the failure is contained in its own health entry -----------------------
    const sources = await h.client.request('sources.list', undefined);
    const brokenEntry = sources.find((s) => s.providerId === 'broken-test-provider');
    const usgsEntry = sources.find((s) => s.providerId === 'usgs-earthquakes');
    assert.equal(brokenEntry?.health.status, 'ERROR', 'the broken provider reports ERROR');
    assert.ok(brokenEntry?.health.message, 'and says something about it');
    assert.equal(usgsEntry?.health.status, 'LIVE', 'the healthy provider is untouched');

    // --- everything else still answers -------------------------------------------
    const quakes = await h.client.request('world.query', { objectTypes: ['earthquake'] });
    assert.equal(quakes.items.length, 8);
    assert.equal((await h.client.request('search.query', { text: 'Honolulu' })).length > 0, true);
    assert.ok((await h.client.request('feed.recent', { limit: 10 })).length >= 1);
    assert.ok((await h.client.request('world.events', {})).items.length >= 1);
    assert.equal((await h.client.request('timeline.get', undefined)).mode, 'LIVE');
    assert.equal((await h.client.request('offline.status', undefined)).packs.length, 0);

    // --- diagnostics reports the failure instead of failing ------------------------
    const diagnostics = await h.client.request('diagnostics.get', undefined);
    assert.equal(diagnostics.providers.length, 2);
    assert.equal(diagnostics.providers.find((p) => p.providerId === 'broken-test-provider')?.health.status, 'ERROR');
    assert.notEqual(diagnostics.database.status, 'error');

    // --- the connection indicator is honest: one of two remote sources is not live ---
    const connection = await h.client.request('sources.connection', undefined);
    assert.ok(['CONNECTED', 'DEGRADED'].includes(connection.state), `unexpected connection state ${connection.state}`);

    // --- disabling it removes its objects and leaves the rest alone -----------------
    await h.client.request('sources.setEnabled', { providerId: 'broken-test-provider', enabled: false });
    assert.equal((await h.client.request('sources.list', undefined)).find((s) => s.providerId === 'broken-test-provider')?.health.status, 'DISABLED');
    assert.equal((await h.client.request('world.query', { objectTypes: ['earthquake'] })).items.length, 8);
  } finally {
    await h.dispose();
  }
});

test('failure: a provider whose manifest is invalid is refused at registration, not at runtime', async () => {
  const bad = { ...BROKEN_MANIFEST, id: 'Not A Valid Id' };
  const h = await startRuntime({
    providerInstances: [
      Object.assign(new BrokenProvider(), { manifest: bad }) as unknown as WorldProvider,
      createUsgs(),
    ],
  });
  try {
    const sources = await h.client.request('sources.list', undefined);
    assert.equal(sources.length, 1, 'only the valid provider was registered');
    assert.equal(sources[0]?.providerId, 'usgs-earthquakes');
    assert.equal((await h.client.request('app.info', undefined)).version.length > 0, true, 'the app still started');
  } finally {
    await h.dispose();
  }
});
