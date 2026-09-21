import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProvider as createUsgs } from '@worldview/provider-usgs';
import type { TimelineState, WorldChangedEvent } from '@worldview/ipc-contract';
import { readFixture, settle, startRuntime, tableFetch } from '../helpers/harness.js';

/**
 * (iii) Timeline replay. History is written from a live poll, the shell switches to
 * REPLAY, and the same `world.*` channels serve reconstructed historical objects —
 * freshness HISTORICAL, provenance origin 'historical' — through the single
 * `activeObjects()` seam, so the shell never branches on the mode. Availability is
 * reported from real partition metadata, never invented.
 */
test('integration: REPLAY serves historical objects with honest freshness and availability', async () => {
  const body = await readFixture('usgs', 'normal.geojson');
  const { impl: fetchImpl } = tableFetch({
    'https://earthquake.usgs.gov/': () => new Response(body, { status: 200, headers: { 'content-type': 'application/geo+json' } }),
  });
  const h = await startRuntime({ fetchImpl, providerInstances: [createUsgs()] });
  try {
    // --- write history from one live poll -------------------------------------
    await h.client.request('sources.refresh', { providerId: 'usgs-earthquakes' });
    await settle();
    await h.runtime.core.history.flush();
    assert.equal(h.runtime.core.history.getStats().writtenRows, 8);

    const live = await h.client.request('world.query', { objectTypes: ['earthquake'] });
    assert.equal(live.basis, 'live');
    assert.ok(live.items.every((o) => o.freshness !== 'HISTORICAL'));

    // --- availability comes from the partitions that actually exist -------------
    const availability = await h.client.request('history.availability', {});
    assert.equal(availability.length, 1, 'only earthquakes have history');
    const quakeRanges = availability[0]!;
    assert.equal(quakeRanges.objectType, 'earthquake');
    assert.equal(quakeRanges.ranges.length >= 1, true);
    for (const range of quakeRanges.ranges) {
      assert.ok(Date.parse(range.start) <= Date.parse(range.end), 'availability ranges are ordered');
      assert.ok(Date.parse(range.end) <= h.clock.now() + 1000, 'availability never claims the future');
    }
    assert.deepEqual((await h.client.request('history.availability', { objectTypes: ['aircraft'] })), [{ objectType: 'aircraft', ranges: [] }], 'a type with no partitions reports no ranges, not an invented window');

    // --- switch to REPLAY --------------------------------------------------------
    const timelineStates: TimelineState[] = [];
    h.runtime.on('timeline.changed', (s) => timelineStates.push(s));
    const deltas: WorldChangedEvent[] = [];
    h.runtime.on('world.changed', (d, clientId) => { if (clientId === 'test-client') deltas.push(d); });
    await h.client.request('world.subscribe', { objectTypes: ['earthquake'] });
    deltas.length = 0;

    const cursor = new Date(h.clock.now() - 60_000).toISOString();
    const replay = await h.client.request('timeline.set', { mode: 'REPLAY', cursor, speed: 5 });
    assert.equal(replay.mode, 'REPLAY');
    assert.equal(replay.speed, 5);
    assert.ok(timelineStates.some((s) => s.mode === 'REPLAY'), 'timeline.changed was emitted');

    // --- the same channels now serve history -------------------------------------
    const replayed = await h.client.request('world.query', { objectTypes: ['earthquake'] });
    assert.equal(replayed.basis, 'historical');
    assert.equal(replayed.items.length, 8, 'the same eight earthquakes, reconstructed from history');
    assert.ok(replayed.items.every((o) => o.freshness === 'HISTORICAL'), 'replayed objects are never presented as live');
    assert.ok(replayed.items.every((o) => o.provenance.origin === 'historical'));
    assert.ok(replayed.items.every((o) => o.provenance.providerId === 'usgs-earthquakes'), 'provenance survives the round trip');

    const one = await h.client.request('world.get', { objectId: 'earthquake:usgs:us7000wv02' });
    assert.equal(one?.freshness, 'HISTORICAL');

    // The subscriber was fed the reconstructed set through the same delta channel.
    assert.ok(deltas.length >= 1, 'the replay projection reached the subscriber');
    assert.ok(deltas.some((d) => d.objects.some((o) => o.freshness === 'HISTORICAL')));

    // --- HISTORICAL scrubbing before any data exists is honestly empty -------------
    await h.client.request('timeline.set', { mode: 'HISTORICAL', cursor: '2020-01-01T00:00:00.000Z' });
    const empty = await h.client.request('world.query', { objectTypes: ['earthquake'] });
    assert.equal(empty.items.length, 0, 'no data before the record starts — and nothing invented');

    // --- back to LIVE ---------------------------------------------------------------
    const back = await h.client.request('timeline.set', { mode: 'LIVE' });
    assert.equal(back.mode, 'LIVE');
    const liveAgain = await h.client.request('world.query', { objectTypes: ['earthquake'] });
    assert.equal(liveAgain.basis, 'live');
    assert.equal(liveAgain.items.length, 8);
    assert.ok(liveAgain.items.every((o) => o.freshness !== 'HISTORICAL'));

    // An invalid timeline request is refused, not silently clamped to something wrong.
    await assert.rejects(h.client.request('timeline.set', { speed: 3 as unknown as TimelineState['speed'] }), /invalid timeline speed/);
  } finally {
    await h.dispose();
  }
});
