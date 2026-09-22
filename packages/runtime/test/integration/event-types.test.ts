import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRuntime } from '../helpers/harness.js';

/**
 * `events.types.list` exists because the watch-zone panel used to carry a hardcoded
 * list: it offered `satellite-decay` (no rule anywhere produces it) and `launch` (a rule
 * exists, no launch provider ships), and omitted `watch-zone-entry`, which the evaluator
 * requires before it will raise an entry alert at all. Two boxes did nothing; the one
 * that mattered could not be ticked.
 */

test('event types: what is offered is what this build can actually produce', async () => {
  const h = await startRuntime({});
  try {
    const types = await h.client.request('events.types.list', undefined);
    const by = new Map(types.map((t) => [t.type, t]));

    assert.ok(by.has('watch-zone-entry'), 'the entry event a zone needs is offered');
    assert.equal(by.get('watch-zone-entry')?.available, true, 'the engine raises it itself, so it always works');
    assert.equal(by.get('source-status-change')?.available, true);

    const decay = by.get('satellite-decay');
    assert.ok(decay, 'a type the model defines is listed rather than hidden');
    assert.equal(decay.available, false);
    assert.match(decay.unavailableReason ?? '', /no rule/i);

    const launch = by.get('launch');
    assert.equal(launch?.available, false, 'a rule with no provider behind it cannot fire');
    assert.match(launch?.unavailableReason ?? '', /source/i);

    for (const t of types) {
      assert.ok(t.label && t.label !== t.type.toUpperCase(), `${t.type} has readable wording`);
      if (!t.available) assert.ok(t.unavailableReason, `${t.type} says why it is unavailable`);
    }
  } finally {
    await h.dispose();
  }
});

test('event types: availability follows which sources are enabled', async () => {
  const h = await startRuntime({});
  try {
    const before = await h.client.request('events.types.list', undefined);
    assert.equal(before.find((t) => t.type === 'earthquake')?.available, true, 'USGS is on by default');

    await h.client.request('sources.setEnabled', { providerId: 'usgs-earthquakes', enabled: false });
    const after = await h.client.request('events.types.list', undefined);
    const quake = after.find((t) => t.type === 'earthquake');
    assert.equal(quake?.available, false, 'with no source for the object type, the rule cannot fire');
    assert.match(quake?.unavailableReason ?? '', /earthquake/);
    assert.deepEqual(quake?.objectTypes, ['earthquake'], 'and says which object type it needs');

    await h.client.request('sources.setEnabled', { providerId: 'usgs-earthquakes', enabled: true });
    assert.equal(
      (await h.client.request('events.types.list', undefined)).find((t) => t.type === 'earthquake')?.available,
      true,
    );
  } finally {
    await h.dispose();
  }
});

test('event types: a zone subscribed to an available type is one the evaluator will act on', async () => {
  const h = await startRuntime({});
  try {
    const types = await h.client.request('events.types.list', undefined);
    const available = types.filter((t) => t.available).map((t) => t.type);
    await h.client.request('watchzones.save', {
      id: 'zone-1',
      name: 'Everything available',
      geometry: { kind: 'circle', center: { latitude: 21.3, longitude: -157.8 }, radiusM: 50_000 },
      eventTypes: available,
      notifications: { inApp: true, desktop: false },
      enabled: true,
      createdAt: '2026-09-21T08:00:00.000Z',
    });
    const zones = await h.client.request('watchzones.list', undefined);
    assert.deepEqual(
      zones[0]?.eventTypes.sort(),
      [...available].sort(),
      'every offered type round-trips through the contract',
    );
    assert.ok(available.includes('watch-zone-entry'), 'including the one object-entry alerts need');
  } finally {
    await h.dispose();
  }
});
