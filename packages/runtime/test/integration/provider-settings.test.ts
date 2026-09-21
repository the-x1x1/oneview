import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRuntime, tableFetch } from '../helpers/harness.js';

/**
 * `sources.settings.get` / `.set` were implemented, validated, persisted and tested, and
 * no interface code called either — the operator guide told operators to change settings
 * that nothing could change. The source panel renders a provider's declared settings, so
 * these hold the loop together: a value written through the contract reaches the
 * provider and changes what it asks the network for.
 */

const EMPTY_FEED = JSON.stringify({ type: 'FeatureCollection', features: [] });

function feedFetch(): { impl: typeof fetch; calls: string[] } {
  const { impl, calls } = tableFetch({ 'https://': () => new Response(EMPTY_FEED, { status: 200, headers: { 'content-type': 'application/geo+json' } }) });
  return { impl, calls };
}

test('provider settings: a value written through the contract reaches the provider', async () => {
  const fetchImpl = feedFetch();
  const h = await startRuntime({ fetchImpl: fetchImpl.impl });
  try {
    const before = await h.client.request('sources.settings.get', { providerId: 'usgs-earthquakes' });
    assert.deepEqual(before, {}, 'a provider starts on its own defaults');

    await h.client.request('sources.settings.set', { providerId: 'usgs-earthquakes', settings: { feed: 'week', minMagnitude: 4.5 } });
    assert.deepEqual(await h.client.request('sources.settings.get', { providerId: 'usgs-earthquakes' }), { feed: 'week', minMagnitude: 4.5 });

    fetchImpl.calls.length = 0;
    await h.client.request('sources.refresh', { providerId: 'usgs-earthquakes' });
    const requested = fetchImpl.calls.find((u) => u.includes('earthquake.usgs.gov'));
    assert.ok(requested, 'the provider polled');
    assert.match(requested, /all_week/, 'the feed window the operator chose is the one requested');
  } finally { await h.dispose(); }
});

test('provider settings: every declared setting is reachable through the contract', async () => {
  const h = await startRuntime({ fetchImpl: feedFetch().impl });
  try {
    const sources = await h.client.request('sources.list', undefined);
    let checked = 0;
    for (const source of sources) {
      const manifest = await h.client.request('sources.manifest', { providerId: source.providerId });
      for (const def of manifest?.settings ?? []) {
        const value = def.kind === 'boolean' ? false
          : def.kind === 'number' ? (def.min ?? 1)
          : def.kind === 'enum' ? def.options![0]!.value
          : def.kind === 'multi-enum' ? [def.options![0]!.value]
          : 'x';
        const key = def.key.split('.');
        const settings = key.length === 1 ? { [def.key]: value } : { [key[0]!]: { [key[1]!]: value } };
        await h.client.request('sources.settings.set', { providerId: source.providerId, settings });
        const read = await h.client.request('sources.settings.get', { providerId: source.providerId });
        assert.deepEqual(read, settings, `${source.providerId}.${def.key} does not round-trip`);
        checked++;
      }
    }
    assert.ok(checked >= 10, `expected declared settings to be exercised, checked ${checked}`);
  } finally { await h.dispose(); }
});

test('provider settings: a hostile settings payload is rejected, not stored', async () => {
  const h = await startRuntime({ fetchImpl: feedFetch().impl });
  try {
    for (const bad of [null, 'string', 42, ['array']]) {
      await assert.rejects(
        () => h.client.request('sources.settings.set', { providerId: 'usgs-earthquakes', settings: bad as never }),
        /settings must be an object/,
      );
    }
    // Settings for a provider that is not loaded are stored rather than refused: they
    // belong to the id, so they survive a composition without it and are read when it
    // returns. That is what makes them persist across a restart.
    await h.client.request('sources.settings.set', { providerId: 'not-loaded-here', settings: { x: 1 } });
    assert.deepEqual(await h.client.request('sources.settings.get', { providerId: 'not-loaded-here' }), { x: 1 });

    // A value the provider will not accept is stored but ignored by it — the provider's
    // own parser is the validator, and it keeps its default rather than breaking.
    await h.client.request('sources.settings.set', { providerId: 'usgs-earthquakes', settings: { feed: 'decade', minMagnitude: 99 } });
    await h.client.request('sources.refresh', { providerId: 'usgs-earthquakes' });
    const health = (await h.client.request('sources.list', undefined)).find((s) => s.providerId === 'usgs-earthquakes');
    assert.notEqual(health?.health.status, 'ERROR', 'an unusable setting does not break the provider');
  } finally { await h.dispose(); }
});
