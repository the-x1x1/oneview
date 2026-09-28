import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildObservation,
  type ObjectTrackAnswer,
  type ObjectTrackRequest,
  type ProviderContext,
  type ProviderHealth,
  type ProviderManifest,
  type ProviderQuery,
  type WorldProvider,
} from '@worldview/provider-sdk';
import type { Observation } from '@worldview/world-model';
import { settle, startRuntime } from '../helpers/harness.js';
import { GAP_TOLERANCE_MS, mergeObjectTrack, nearest } from '../../src/support/object-track.js';

/**
 * `world.track` with `selected`: the object's source is asked what it can add (provider-sdk
 * object-track.ts), and only then. A fake provider stands in for adsb.lol: one aircraft, and
 * an invented history that begins an hour before the runtime's first sight of it.
 */
const MANIFEST: ProviderManifest = {
  id: 'track-test-provider',
  name: 'Object track test provider',
  version: '0.0.0',
  description: 'One aircraft and an invented history for it. Exists only for this test.',
  objectTypes: ['aircraft'],
  categories: ['aviation'],
  transport: 'filesystem',
  capabilities: { live: true, historical: false, offline: false, boundsQuery: false },
  credentials: [],
  refreshPolicy: {
    intervalMs: 60_000,
    minIntervalMs: 60_000,
    timeoutMs: 5_000,
    maxRetries: 0,
    maxRequestsPerMinute: 10,
    staleWhileErrorMs: 0,
  },
  dataPolicy: {
    cacheAllowed: false,
    rawPayloadRetentionAllowed: false,
    normalizedRetentionAllowed: false,
    redistributionAllowed: false,
    offlinePackAllowed: false,
    exportAllowed: false,
    commercialUseAllowed: false,
    attributionRequired: false,
  },
  attribution: { text: 'Object track test provider' },
  commercialReview: 'approved',
  enabledByDefault: true,
  allowedHosts: [],
};

class TrackProvider implements WorldProvider {
  readonly manifest = MANIFEST;
  asked: ObjectTrackRequest[] = [];
  private context!: ProviderContext;
  async initialize(context: ProviderContext): Promise<void> {
    this.context = context;
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async health(): Promise<ProviderHealth> {
    return { providerId: MANIFEST.id, status: 'LIVE', objectCount: 1 } as ProviderHealth;
  }
  async query(_request: ProviderQuery): Promise<Observation[]> {
    const now = this.context.clock.now();
    return [
      buildObservation(MANIFEST, new Date(now).toISOString(), {
        externalId: 'ae5f01',
        objectType: 'aircraft',
        observedAt: new Date(now - 1000).toISOString(),
        position: { latitude: 39.1, longitude: -75.4, altitudeM: 3000, altitudeDatum: 'barometric' },
        payload: { icao24: 'ae5f01', callsign: 'TEST01' },
      }),
    ];
  }
  async objectTrack(request: ObjectTrackRequest): Promise<ObjectTrackAnswer | undefined> {
    this.asked.push(request);
    const now = this.context.clock.now();
    return {
      kind: 'history',
      label: 'test history',
      points: [0, 1, 2].map((i) => ({
        observedAt: new Date(now - 3600_000 + i * 60_000).toISOString(),
        latitude: 39 + i * 0.01,
        longitude: -75,
        altitudeM: 1000,
      })),
    };
  }
}

test('world.track: a source is asked about the selected object only, and its points are labelled', async () => {
  const provider = new TrackProvider();
  const h = await startRuntime({ providerInstances: [provider] });
  try {
    await h.client.request('sources.refresh', { providerId: MANIFEST.id });
    await settle();
    const objectId = (await h.client.request('world.query', { objectTypes: ['aircraft'] })).items[0]!.id;

    const plain = await h.client.request('world.track', { objectId });
    assert.equal(provider.asked.length, 0, 'not selected, not asked');
    assert.ok(plain.every((p) => p.source === undefined));

    const selected = await h.client.request('world.track', { objectId, selected: true });
    assert.equal(provider.asked.length, 1);
    assert.equal(provider.asked[0]!.objectType, 'aircraft');
    assert.equal(provider.asked[0]!.properties['icao24'], 'ae5f01');
    const extra = selected.filter((p) => p.source === 'test history');
    assert.equal(extra.length, 3, 'the hour before first sight is filled in');
    assert.ok(selected.length > extra.length, "and WORLDVIEW's own points are kept");
    const times = selected.map((p) => Date.parse(p.observedAt));
    assert.deepEqual(
      times,
      [...times].sort((a, b) => a - b),
      'in time order',
    );
  } finally {
    await h.dispose();
  }
});

test('mergeObjectTrack: history fills gaps only; a prediction follows the last own point, marked', () => {
  const t0 = Date.parse('2026-09-27T08:00:00.000Z');
  const iso = (ms: number) => new Date(ms).toISOString();
  const own = [
    { observedAt: iso(t0), latitude: 1, longitude: 1 },
    { observedAt: iso(t0 + 60_000), latitude: 1.1, longitude: 1 },
  ];
  const range = { start: iso(t0 - 3600_000), end: iso(t0 + 60_000) };
  const history: ObjectTrackAnswer = {
    kind: 'history',
    label: 'adsb.lol history',
    attribution: 'Aircraft positions: adsb.lol contributors (ODbL 1.0)',
    points: [
      { observedAt: iso(t0 - 7200_000), latitude: 0, longitude: 0 }, // outside the window
      { observedAt: iso(t0 - 600_000), latitude: 0.5, longitude: 1 }, // a gap: kept
      { observedAt: iso(t0 + 5_000), latitude: 1.01, longitude: 1 }, // next to an own point: dropped
      { observedAt: iso(t0 + 30_000), latitude: 1.05, longitude: 1 }, // 30 s from both (> GAP_TOLERANCE_MS): kept
    ],
  };
  const prediction: ObjectTrackAnswer = {
    kind: 'prediction',
    label: 'Predicted orbit',
    points: [
      { observedAt: iso(t0 + 30_000), latitude: 9, longitude: 9 }, // before the last own point: dropped
      { observedAt: iso(t0 + 120_000), latitude: 1.2, longitude: 1 },
    ],
  };
  const merged = mergeObjectTrack(own, [history, undefined, prediction], range);
  assert.deepEqual(
    merged.map((p) => [p.latitude, p.source ?? null, p.predicted ?? false]),
    [
      [0.5, 'adsb.lol history', false],
      [1, null, false],
      [1.05, 'adsb.lol history', false],
      [1.1, null, false],
      [1.2, 'Predicted orbit', true],
    ],
  );
  assert.equal(merged[0]!.sourceAttribution, 'Aircraft positions: adsb.lol contributors (ODbL 1.0)');
  assert.equal(merged[4]!.sourceAttribution, undefined, 'the prediction named none');
  assert.deepEqual(mergeObjectTrack(own, [], range), own, 'nothing to add, nothing changed');
  assert.ok(GAP_TOLERANCE_MS < 30_000);
});

test('nearest: distance to the closest sorted time', () => {
  assert.equal(nearest([10, 20, 40], 26), 6);
  assert.equal(nearest([10, 20, 40], 5), 5);
  assert.equal(nearest([10, 20, 40], 99), 59);
  assert.equal(nearest([], 1), Infinity);
});
