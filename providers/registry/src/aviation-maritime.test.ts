import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manifestSchema, testing, type ProviderError } from '@worldview/provider-sdk';
import { AVIATION_MARITIME_PROVIDER_IDS, aviationMaritimeProviders } from './aviation-maritime.js';

test('aviation/maritime partial map: keys equal manifest ids, manifests validate, fresh instance per call', () => {
  const map = aviationMaritimeProviders();
  assert.deepEqual(Object.keys(map), [...AVIATION_MARITIME_PROVIDER_IDS]);
  for (const [id, factory] of Object.entries(map)) {
    const a = factory();
    const b = factory();
    assert.notEqual(a, b, `${id} factory must not share instances`);
    const parsed = manifestSchema.parse(a.manifest);
    assert.ok(parsed.ok, `${id} manifest invalid`);
    assert.equal(a.manifest.id, id);
  }
  assert.equal(map['aisstream-io']!().manifest.enabledByDefault, false, 'AISStream stays off until reviewed');
});

test('aviation/maritime partial map: AIS secret resolver is threaded through to the provider', async () => {
  const withKey = aviationMaritimeProviders({ aisSecretResolver: async () => 'k', ais: { flushIntervalMs: 0 } })[
    'aisstream-io'
  ]!();
  const ctx = testing.createFixtureContext({ providerId: 'aisstream-io', credentials: ['aisstream.apiKey'] });
  await withKey.initialize(ctx);
  await withKey.start();
  const unsub = await withKey.subscribe!({ signal: new AbortController().signal }, () => {});
  assert.equal(ctx.sockets.opened.length, 1);
  unsub();
  // Without the injected seam the provider asks the runtime to resolve the credential on the
  // socket instead (ADR-003 onOpen ctx.secret); it must not refuse to subscribe.
  const without = aviationMaritimeProviders()['aisstream-io']!();
  const plainCtx = testing.createFixtureContext({ providerId: 'aisstream-io', credentials: ['aisstream.apiKey'] });
  await without.initialize(plainCtx);
  await without.start();
  const off = await without.subscribe!({ signal: new AbortController().signal }, () => {});
  assert.deepEqual(plainCtx.sockets.opened[0]?.credential, { key: 'aisstream.apiKey' });
  off();

  // No credential at all is still AUTH, from either construction.
  const noCredential = aviationMaritimeProviders({ aisSecretResolver: async () => 'k' })['aisstream-io']!();
  await noCredential.initialize(testing.createFixtureContext({ providerId: 'aisstream-io' }));
  await noCredential.start();
  await assert.rejects(
    noCredential.subscribe!({ signal: new AbortController().signal }, () => {}),
    (e: ProviderError) => e.code === 'AUTH',
  );
});
