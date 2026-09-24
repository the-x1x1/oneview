import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JsonValue, Observation, WorldObject, WorldQuery } from '@worldview/world-model';
import { testing, type ProviderDataPolicy } from '@worldview/provider-sdk';
import { HistoryStore, NdjsonBackend } from '@worldview/history-store';
import { downsample, projectReadings, readings, withLatest, type HistoryQuery, type ReadingPoint } from './index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURE = path.join(root, 'fixtures', 'connectors', 'telemetry', 'local-sensors-history.json');

interface Fixture {
  sources: Record<
    string,
    { providerId: string; objectType: string; position: { latitude: number; longitude: number } }
  >;
  observations: Array<{ externalId: string; observedAt: string; payload: Record<string, JsonValue> }>;
}

const OPEN: ProviderDataPolicy = {
  cacheAllowed: true,
  rawPayloadRetentionAllowed: false,
  normalizedRetentionAllowed: true,
  redistributionAllowed: false,
  offlinePackAllowed: false,
  exportAllowed: false,
  commercialUseAllowed: false,
  attributionRequired: false,
};

const STATION = 'weather-station:weatherlink-local:001D0A7100A1-1';
const NEIGHBOUR = 'weather-station:weatherlink-local:001D0A7100B2-1';
const SENSOR = 'sensor:purpleair-local:pa-3f-21';
const WINDOW = { startMs: Date.parse('2026-09-20T00:00:00.000Z'), endMs: Date.parse('2026-09-20T06:00:00.000Z') };

async function loadFixture(): Promise<{ fixture: Fixture; observations: Observation[] }> {
  const fixture = JSON.parse(await fs.readFile(FIXTURE, 'utf8')) as Fixture;
  const observations = fixture.observations.map((o): Observation => {
    const src = fixture.sources[o.externalId]!;
    return {
      id: `${src.providerId}:${o.externalId}:${o.observedAt}`,
      providerId: src.providerId,
      externalId: o.externalId,
      objectType: src.objectType,
      observedAt: o.observedAt,
      receivedAt: o.observedAt,
      position: { ...src.position },
      payload: o.payload,
      quality: { complete: true, sourceQuality: 'authoritative' },
      provenance: { providerId: src.providerId, sourceName: src.providerId, origin: 'local', receivedAt: o.observedAt },
    };
  });
  return { fixture, observations };
}

/** A real history store (NDJSON backend) holding the fixture, answering `history.query` as the runtime does. */
async function storeWithFixture(): Promise<{ query: HistoryQuery; calls: WorldQuery[]; close: () => Promise<void> }> {
  const { observations } = await loadFixture();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worldview-telemetry-'));
  const clock = new testing.VirtualClock(Date.parse('2026-09-20T07:00:00.000Z'));
  const store = new HistoryStore({
    dataDir,
    backend: new NdjsonBackend({ dataDir, clock }),
    clock,
    policies: () => OPEN,
  });
  await store.open();
  for (const providerId of ['weatherlink-local', 'purpleair-local']) {
    const mine = observations.filter((o) => o.providerId === providerId);
    store.writeBatch({ providerId, observations: mine, snapshot: false, receivedAt: mine[0]!.receivedAt, rejected: 0 });
  }
  await store.flush();
  const calls: WorldQuery[] = [];
  return {
    query: (q) => {
      calls.push(q);
      return store.queryObjects(q);
    },
    calls,
    close: async () => {
      await store.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    },
  };
}

test('projection: payload[key] over observedAt for one object, window inclusive, one point per instant', () => {
  const items = [
    { id: 'a', observedAt: '2026-09-20T00:10:00.000Z', properties: { t: 2, h: 'x' } },
    { id: 'a', observedAt: '2026-09-20T00:00:00.000Z', properties: { t: 1, h: 50 } },
    { id: 'b', observedAt: '2026-09-20T00:05:00.000Z', properties: { t: 99 } },
    { id: 'a', observedAt: '2026-09-20T00:10:00.000Z', properties: { t: 3 } },
    { id: 'a', observedAt: 'not a time', properties: { t: 4 } },
    { observedAt: '2026-09-20T00:20:00.000Z', payload: { t: Number.NaN, h: 51 } },
    { id: 'a', observedAt: '2026-09-20T00:30:00.001Z', properties: { t: 5 } },
  ];
  const window = { startMs: Date.parse('2026-09-20T00:00:00.000Z'), endMs: Date.parse('2026-09-20T00:30:00.000Z') };
  const out = projectReadings(items, 'a', ['t', 'h'], window);
  assert.deepEqual(out.get('t'), [
    [window.startMs, 1],
    [window.startMs + 600_000, 3],
  ]);
  assert.deepEqual(out.get('h'), [
    [window.startMs, 50],
    [window.startMs + 1_200_000, 51],
  ]);
});

test('readings over a real history store: one point per observed slice, the neighbour and the gap left out', async () => {
  const { query, calls, close } = await storeWithFixture();
  try {
    const { observations } = await loadFixture();
    const result = await readings(
      query,
      {
        objectId: STATION,
        objectType: 'weather-station',
        providerIds: ['weatherlink-local'],
        position: { latitude: 21.3069, longitude: -157.8583 },
      },
      ['temperatureC', 'windSpeedMps', 'notThere'],
      WINDOW,
      { samples: 36 },
    );
    assert.equal(result.failed, 0);
    assert.equal(result.stepMs, 600_000);
    assert.equal(calls.length, 37, 'one slice per step and one ending at the window’s start');
    for (const q of calls) {
      assert.deepEqual(q.objectTypes, ['weather-station']);
      assert.deepEqual(q.providerIds, ['weatherlink-local']);
      assert.equal(q.region?.kind, 'circle');
      assert.equal(Date.parse(q.time!.end) - Date.parse(q.time!.start), 600_000);
    }
    // Every station observation in the window is one slice's latest, so the projection
    // reads exactly what history holds for it — and nothing of the neighbour's.
    const expected = observations
      .filter((o) => o.externalId === '001D0A7100A1-1')
      .map((o) => [Date.parse(o.observedAt), o.payload['temperatureC']] as const);
    const temps = result.series.get('temperatureC')!;
    assert.deepEqual(temps, expected);
    assert.equal(temps.length, 31, '37 ten-minute readings less the six in the 03:00–04:00 gap');
    assert.ok(
      !temps.some(([t]) => t > Date.parse('2026-09-20T03:00:00.000Z') && t < Date.parse('2026-09-20T04:00:00.000Z')),
    );
    assert.ok(
      result.series.get('windSpeedMps')!.some(([, v]) => v === 14.2),
      'the spike is there',
    );
    assert.deepEqual(result.series.get('notThere'), []);
  } finally {
    await close();
  }
});

test('readings: a coarse sample keeps each slice’s last reading; the sensor is read the same way', async () => {
  const { query, close } = await storeWithFixture();
  try {
    const station = await readings(
      query,
      { objectId: STATION, objectType: 'weather-station' },
      ['temperatureC'],
      WINDOW,
      {
        samples: 6,
      },
    );
    const hours = station.series.get('temperatureC')!.map(([t]) => new Date(t).toISOString().slice(11, 16));
    // Slices end at 00:00 … 06:00 and each keeps its latest reading: the 02:00–03:00 slice
    // ends in the gap, so its latest is 02:50, and 04:00 closes the 03:00–04:00 slice.
    assert.deepEqual(hours, ['00:00', '01:00', '02:00', '02:50', '04:00', '05:00', '06:00']);

    const sensor = await readings(query, { objectId: SENSOR, objectType: 'sensor' }, ['aqiUs'], WINDOW);
    assert.equal(sensor.series.get('aqiUs')!.length, 13);
    assert.equal(sensor.series.get('aqiUs')!.at(-1)![1], 133);

    const neighbour = await readings(
      query,
      { objectId: NEIGHBOUR, objectType: 'weather-station' },
      ['temperatureC'],
      WINDOW,
      {
        samples: 72,
      },
    );
    assert.equal(neighbour.series.get('temperatureC')!.length, 11);
  } finally {
    await close();
  }
});

test('readings: failed slices are counted, not invented; an abort stops the reads; a backwards window is refused', async () => {
  let n = 0;
  const flaky: HistoryQuery = async (q) => {
    n++;
    if (n % 2 === 0) throw new Error('backend unavailable');
    const end = q.time!.end;
    const o = { id: 'x', observedAt: end, properties: { v: n } } as unknown as WorldObject;
    return { items: [o], total: 1, truncated: false, basis: 'historical', evaluatedAt: end };
  };
  const r = await readings(flaky, { objectId: 'x', objectType: 'sensor' }, ['v'], WINDOW, {
    samples: 10,
    concurrency: 1,
  });
  assert.equal(r.failed, 5);
  assert.equal(r.series.get('v')!.length, 6, 'eleven slices, the even-numbered requests failed');

  const controller = new AbortController();
  controller.abort(new Error('closed'));
  await assert.rejects(
    readings(flaky, { objectId: 'x', objectType: 'sensor' }, ['v'], WINDOW, { signal: controller.signal }),
    /closed/,
  );
  await assert.rejects(
    readings(flaky, { objectId: 'x', objectType: 'sensor' }, ['v'], { startMs: 10, endMs: 10 }),
    RangeError,
  );
});

test('withLatest: the live object’s newer reading is appended, an older or out-of-window one is not', () => {
  const series = new Map<string, ReadingPoint[]>([
    ['t', [[WINDOW.startMs, 1]]],
    ['h', []],
  ]);
  const later = { observedAt: '2026-09-20T05:00:00.000Z', properties: { t: 2, h: 'wet' } };
  const out = withLatest(series, later, WINDOW);
  assert.deepEqual(out.get('t'), [
    [WINDOW.startMs, 1],
    [Date.parse(later.observedAt), 2],
  ]);
  assert.deepEqual(out.get('h'), []);
  assert.deepEqual(
    withLatest(series, { observedAt: '2026-09-20T00:00:00.000Z', properties: { t: 9 } }, WINDOW).get('t'),
    [[WINDOW.startMs, 1]],
  );
  assert.deepEqual(
    withLatest(series, { observedAt: '2026-09-20T07:00:00.000Z', properties: { t: 9 } }, WINDOW).get('t'),
    [[WINDOW.startMs, 1]],
  );
});

test('downsample: at most the cap, first and last kept, every bucket’s extremes survive', () => {
  const points: ReadingPoint[] = [];
  for (let i = 0; i < 10_000; i++) points.push([i * 1000, Math.sin(i / 50)]);
  points[4321] = [4321 * 1000, 42];
  points[7000] = [7000 * 1000, -42];
  const out = downsample(points, 2_000);
  assert.ok(out.length <= 2_000);
  assert.deepEqual(out[0], points[0]);
  assert.deepEqual(out.at(-1), points.at(-1));
  assert.ok(out.some(([, v]) => v === 42) && out.some(([, v]) => v === -42));
  for (let i = 1; i < out.length; i++) assert.ok(out[i]![0] > out[i - 1]![0], 'time ascending, no repeats');
  const small: ReadingPoint[] = [
    [0, 1],
    [1, 2],
  ];
  assert.deepEqual(downsample(small, 2_000), small);
});
