import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILT_IN_LENSES, lensById } from '@worldview/render-core';
import { OVERVIEW_LAYERS, layerCounts, layerNotes, lensFilter, withLayer } from './overview-layers.js';
import type { SourceHealthEntry } from '@worldview/source-health';

const overview = lensById('overview')!;

test('overview layers: one per built-in category lens, not the Overview itself', () => {
  assert.deepEqual(
    OVERVIEW_LAYERS.map((l) => l.id),
    BUILT_IN_LENSES.filter((l) => l.id !== 'overview').map((l) => l.id),
  );
  assert.ok(OVERVIEW_LAYERS.some((l) => l.id === 'aviation'));
});

test('overview layers: nothing hidden shows everything; hiding a layer hides only what no shown layer claims', () => {
  const all = lensFilter(overview, []);
  assert.deepEqual([...all.objectTypes].sort(), [...overview.objectTypes].sort());

  const noSpace = lensFilter(overview, ['space']);
  assert.equal(noSpace.objectTypes.has('satellite'), false);
  assert.equal(noSpace.eventTypes.has('launch'), false);
  assert.equal(noSpace.objectTypes.has('aircraft'), true);

  // Airports belong to Aviation, Transportation and Infrastructure: they stay while any is on.
  const noAviation = lensFilter(overview, ['aviation']);
  assert.equal(noAviation.objectTypes.has('aircraft'), false);
  assert.equal(noAviation.objectTypes.has('airport'), true);
  const onlySpace = lensFilter(
    overview,
    OVERVIEW_LAYERS.filter((l) => l.id !== 'space').map((l) => l.id),
  );
  assert.equal(onlySpace.objectTypes.has('airport'), false);
  assert.equal(onlySpace.objectTypes.has('satellite'), true);
  // "Aviation and disasters" — the combination the operator asked for.
  const pair = lensFilter(
    overview,
    OVERVIEW_LAYERS.filter((l) => l.id !== 'aviation' && l.id !== 'disasters').map((l) => l.id),
  );
  for (const t of ['aircraft', 'airport', 'earthquake', 'fire-detection', 'weather-alert'])
    assert.ok(pair.objectTypes.has(t), t);
  for (const t of ['satellite', 'vessel', 'camera']) assert.ok(!pair.objectTypes.has(t), t);
});

test('overview layers: a type no layer claims is never switched off', () => {
  const none = lensFilter(
    overview,
    OVERVIEW_LAYERS.map((l) => l.id),
  );
  assert.deepEqual([...none.objectTypes], ['place'], 'search places have no switch, so they stay');
});

test('overview layers: another lens is its own filter; counts and toggling', () => {
  const aviation = lensById('aviation')!;
  assert.deepEqual([...lensFilter(aviation, ['aviation']).objectTypes].sort(), ['aircraft', 'airport']);
  const counts = layerCounts([{ type: 'aircraft' }, { type: 'aircraft' }, { type: 'airport' }, { type: 'satellite' }]);
  assert.equal(counts['aviation'], 3);
  assert.equal(counts['space'], 1);
  assert.equal(counts['transportation'], 1, 'the airport counts wherever it is shown');
  assert.deepEqual(withLayer([], 'space', false), ['space']);
  assert.deepEqual(withLayer(['space', 'maritime'], 'space', true), ['maritime']);
  assert.deepEqual(withLayer(['space'], 'space', false), ['space'], 'no duplicates');
});

test('overview layers: a live source’s note is shown on its layer; a fault is not a note', () => {
  const entry = (providerId: string, name: string, status: SourceHealthEntry['health']['status'], message?: string) =>
    ({
      providerId,
      name,
      categories: ['aviation'],
      locality: 'remote',
      enabled: true,
      health: {
        providerId,
        status,
        errorRate: 0,
        rateLimitState: { limited: false },
        credentialState: 'not-required',
        ...(message ? { message } : {}),
      },
      transitions: [],
      meta: {
        attribution: '',
        refreshIntervalMs: 10_000,
        cacheAllowed: true,
        credentialsRequired: [],
        commercialReview: 'approved',
      },
    }) as SourceHealthEntry;
  const entries = [
    entry('adsb-lol', 'adsb.lol', 'LIVE', 'Aircraft within 250 nm of the view centre only'),
    entry('readsb-local', 'readsb (local)', 'OFFLINE', 'readsb not detected'),
    entry('seed', 'Airports', 'LIVE'),
  ];
  assert.deepEqual(layerNotes(entries, 'aviation'), ['adsb.lol: Aircraft within 250 nm of the view centre only']);
  assert.deepEqual(layerNotes(entries, 'space'), []);
  assert.deepEqual(layerNotes([{ ...entries[0]!, enabled: false }], 'aviation'), [], 'a disabled source says nothing');
});
