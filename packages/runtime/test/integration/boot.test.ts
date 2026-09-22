import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProvider as createUsgs } from '@worldview/provider-usgs';
import type { WorldChangedEvent } from '@worldview/ipc-contract';
import { readFixture, startRuntime, settle, tableFetch } from '../helpers/harness.js';

/**
 * (i) Boot the composed runtime with the real USGS provider against its fixture and
 * prove the whole graph is wired: world state, per-client subscriptions, history,
 * events, the feed and source health all see the same single poll.
 */
test('integration: one USGS poll reaches state, subscribers, history, events, the feed and source health', async () => {
  const body = await readFixture('usgs', 'normal.geojson');
  const { impl: fetchImpl, calls } = tableFetch({
    'https://earthquake.usgs.gov/': () =>
      new Response(body, { status: 200, headers: { 'content-type': 'application/geo+json', etag: '"abc"' } }),
  });

  const h = await startRuntime({ fetchImpl, providerInstances: [createUsgs()] });
  try {
    // --- the shell subscribes before any data arrives -------------------------
    const deltas: WorldChangedEvent[] = [];
    h.runtime.on('world.changed', (payload, clientId) => {
      if (clientId === 'test-client') deltas.push(payload);
    });
    const initial = await h.client.request('world.subscribe', { objectTypes: ['earthquake'] });
    assert.equal(initial.count, 0, 'nothing is known before the first poll');

    // --- one poll -------------------------------------------------------------
    await h.client.request('sources.refresh', { providerId: 'usgs-earthquakes' });
    await settle();
    assert.equal(calls.length, 1, 'exactly one upstream request');

    // --- world.query ----------------------------------------------------------
    const quakes = await h.client.request('world.query', { objectTypes: ['earthquake'] });
    assert.equal(quakes.items.length, 8, 'the fixture has eight earthquakes');
    assert.equal(quakes.basis, 'live');
    assert.equal(quakes.truncated, false);
    assert.ok(
      quakes.items.every((o) => o.id.startsWith('earthquake:usgs:')),
      'identity is the authoritative USGS event id',
    );
    const honshu = quakes.items.find((o) => o.id === 'earthquake:usgs:us7000wv02');
    assert.equal(honshu?.labels.place, 'Near the east coast of Honshu, Japan');
    assert.equal(honshu?.provenance.origin, 'live');

    // world.get and world.related answer for the same object.
    assert.equal(
      (await h.client.request('world.get', { objectId: 'earthquake:usgs:us7000wv02' }))?.id,
      'earthquake:usgs:us7000wv02',
    );
    const related = await h.client.request('world.related', { objectId: 'earthquake:usgs:us7000wv02' });
    assert.ok(related.events.length >= 1, 'the earthquake rule produced an event for this object');

    // --- world.changed deltas reached the subscriber --------------------------
    assert.ok(deltas.length >= 1, 'the subscriber received a delta');
    const allAdded = new Set(deltas.flatMap((d) => d.added));
    assert.equal(allAdded.size, 8);
    assert.ok(
      deltas.every((d) => d.objects.every((o) => o.type === 'earthquake')),
      'only subscribed types are pushed',
    );

    // A client subscribed to a different region gets nothing from the same batch.
    const other = await h.client.request('world.subscribe', { bounds: { west: -1, south: -1, east: 1, north: 1 } });
    assert.equal(other.count, 0, 'the Gulf of Guinea has no earthquakes in this fixture');

    // --- history received the batch -------------------------------------------
    await h.runtime.core.history.flush();
    const stats = h.runtime.core.history.getStats();
    assert.equal(stats.writtenRows, 8, 'every observation was persisted (USGS allows normalized retention)');
    assert.equal(stats.droppedRows, 0);
    const availability = await h.client.request('history.availability', { objectTypes: ['earthquake'] });
    assert.equal(availability[0]?.objectType, 'earthquake');
    assert.ok((availability[0]?.ranges.length ?? 0) >= 1, 'history reports a real availability window');

    // --- events and the feed ---------------------------------------------------
    const events = await h.client.request('world.events', { eventTypes: ['earthquake'] });
    assert.ok(events.items.length >= 1, 'the deterministic earthquake rule produced events');
    assert.ok(
      events.items.every((e) => e.provenance.origin === 'derived'),
      'rule output is derived, never presented as a source',
    );
    const feed = await h.client.request('feed.recent', { limit: 50 });
    assert.ok(feed.length >= 1, 'the feed has at least one item');
    assert.ok(
      feed.every((i) => !i.recorded),
      'live data is not labelled as recorded',
    );
    assert.ok(
      feed.some((i) => events.items.some((e) => e.id === i.eventId)),
      'feed items reference real events',
    );

    // --- search ----------------------------------------------------------------
    const results = await h.client.request('search.query', { text: 'Honolulu' });
    const place = results.find((r) => r.kind === 'place');
    assert.ok(place, 'search answers with a place');
    assert.equal(place?.title, 'Honolulu');
    assert.ok(place?.position && Math.abs(place.position.latitude - 21.3) < 0.5);

    // --- source health ----------------------------------------------------------
    const sources = await h.client.request('sources.list', undefined);
    const usgs = sources.find((s) => s.providerId === 'usgs-earthquakes');
    assert.ok(usgs, 'source health lists the provider');
    assert.equal(usgs?.health.status, 'LIVE');
    assert.equal(usgs?.enabled, true);
    assert.equal(usgs?.meta.attribution, 'Data courtesy of the U.S. Geological Survey');
    assert.equal((await h.client.request('sources.connection', undefined)).state, 'CONNECTED');

    // --- diagnostics sees the same world ----------------------------------------
    const diagnostics = await h.client.request('diagnostics.get', undefined);
    assert.equal(diagnostics.app.demoMode, false);
    assert.equal(diagnostics.providers.length, 1);
    assert.equal(diagnostics.database.status === 'error', false);
    assert.equal(diagnostics.offline.connection.state, 'CONNECTED');
  } finally {
    await h.dispose();
  }
});
