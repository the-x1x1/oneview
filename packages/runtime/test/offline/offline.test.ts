import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testing } from '@worldview/provider-sdk';
import { HistoryStore, NdjsonBackend } from '@worldview/history-store';
import { WorldPackBuilder, seedPolicies } from '@worldview/offline';
import { createProvider as createUsgs } from '@worldview/provider-usgs';
import { createProvider as createSeedAirports, SEED_AIRPORTS_FILE } from '@worldview/provider-infrastructure';
import type { ProviderDataPolicy } from '@worldview/provider-sdk';
import type { Observation } from '@worldview/world-model';
import type { ConnectionSnapshot } from '@worldview/source-health';
import { fixture, offlineFetch, settle, startRuntime } from '../helpers/harness.js';

/**
 * (ii) Offline proof for the composed runtime (ADR-007). With WORLDVIEW_NETWORK=off and
 * every fetch failing:
 *
 *   - the connection state goes OFFLINE and remote providers report OFFLINE
 *   - local/filesystem providers keep answering from the granted bundle
 *   - `offline.status` reports the installed pack and the real capabilities
 *   - search still answers from the pack's place index
 */
process.env['WORLDVIEW_NETWORK'] ??= 'off';

const USGS_POLICY: ProviderDataPolicy = {
  cacheAllowed: true, rawPayloadRetentionAllowed: true, normalizedRetentionAllowed: true,
  redistributionAllowed: true, offlinePackAllowed: true, exportAllowed: true, commercialUseAllowed: true,
  attributionRequired: false, attributionText: 'Data courtesy of the U.S. Geological Survey',
};

function quake(id: string, observedAt: string, latitude: number, longitude: number, magnitude: number): Observation {
  return {
    id: `usgs-earthquakes:${id}:${observedAt}`,
    providerId: 'usgs-earthquakes',
    externalId: id,
    objectType: 'earthquake',
    observedAt,
    receivedAt: observedAt,
    position: { latitude, longitude, altitudeM: -8000 },
    payload: { magnitude, place: `test ${id}`, title: `M ${magnitude} — test ${id}` },
    quality: { complete: true, sourceQuality: 'authoritative' },
    provenance: { providerId: 'usgs-earthquakes', sourceName: 'USGS Earthquakes', origin: 'live', receivedAt: observedAt },
  };
}

/** Build a Hawaii pack from the bundled seed fixtures with tools/worldpack's builder. */
async function buildHawaiiPack(tmp: string, clock: testing.VirtualClock): Promise<string> {
  const historyDir = path.join(tmp, 'pack-history');
  const backend = new NdjsonBackend({ dataDir: historyDir, clock });
  const policies = (id: string) => ({ ...seedPolicies(), 'usgs-earthquakes': USGS_POLICY })[id];
  const store = new HistoryStore({ dataDir: historyDir, backend, clock, policies });
  await store.open();
  const now = clock.now();
  const observations = ([[19.42, -155.29], [19.48, -155.61], [20.7, -156.2]] as Array<[number, number]>)
    .map(([lat, lon], i) => quake(`hv${i}`, new Date(now - (i + 1) * 86_400_000).toISOString(), lat, lon, 2.5 + i * 0.4));
  store.writeBatch(HistoryStore.batchOf('usgs-earthquakes', observations, new Date(now).toISOString()));
  await store.flush();

  const outputPath = path.join(tmp, 'hawaii.worldpack');
  await new WorldPackBuilder().build({
    id: 'hawaii', name: 'Hawaiian Islands', version: '1.0.0', region: { preset: 'hawaii' },
    include: ['places', 'airports', 'earthquakes'],
    sources: {
      placesGeoJsonPath: fixture('places', 'seed-places.geojson'),
      airportsGeoJsonPath: fixture('airports', 'seed-airports.geojson'),
      history: store, earthquakeWindowDays: 30,
    },
    policies,
    licenses: (id) => (id === 'usgs-earthquakes' ? 'U.S. Government work — public domain' : 'MIT'),
    outputPath, clock,
  });
  await store.close();
  return outputPath;
}

test('offline: the composed runtime goes OFFLINE, keeps local providers answering and searches its packs', async () => {
  assert.equal(process.env['WORLDVIEW_NETWORK'], 'off');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'worldview-runtime-offline-'));
  const networkCalls = { count: 0 };
  try {
    const clock = new testing.VirtualClock(Date.parse('2026-09-21T12:00:00.000Z'));
    const packPath = await buildHawaiiPack(tmp, clock);

    // The bundled resources directory granted to filesystem providers.
    const resourcesDir = path.join(tmp, 'resources');
    await fs.mkdir(resourcesDir, { recursive: true });
    await fs.copyFile(fixture('airports', 'seed-airports.geojson'), path.join(resourcesDir, SEED_AIRPORTS_FILE));

    const h = await startRuntime({
      dataDir: path.join(tmp, 'data'),
      clock,
      resourcesDir,
      fetchImpl: offlineFetch(networkCalls),
      // The OS says there is no network; nothing may call out regardless.
      network: { isOnline: () => false },
      providerInstances: [createUsgs(), createSeedAirports()],
    });

    try {
      // --- install the pack (through the host bridge, like the shell would) --------
      h.host.openQueue.push(packPath);
      const install = await h.client.request('offline.installPack', undefined);
      assert.ok(install.installed, install.issues.join('; '));
      assert.equal(install.installed?.status, 'active');
      assert.equal(install.installed?.id, 'hawaii');

      // --- the connection is OFFLINE ------------------------------------------------
      const snapshots: ConnectionSnapshot[] = [];
      h.runtime.on('connection.changed', (s) => snapshots.push(s));
      h.runtime.setNetworkOnline(false);
      await settle();
      const connection = await h.client.request('sources.connection', undefined);
      assert.equal(connection.state, 'OFFLINE');
      assert.equal(connection.networkOnline, false);

      // --- the remote provider reports OFFLINE, the filesystem provider keeps working -
      await h.client.request('sources.refresh', { providerId: 'usgs-earthquakes' });
      await h.client.request('sources.refresh', { providerId: 'worldview-seed-airports' });
      await settle();

      const sources = await h.client.request('sources.list', undefined);
      const usgs = sources.find((s) => s.providerId === 'usgs-earthquakes');
      const airports = sources.find((s) => s.providerId === 'worldview-seed-airports');
      assert.equal(usgs?.health.status, 'OFFLINE', 'the remote source says OFFLINE rather than pretending');
      assert.equal(usgs?.locality, 'remote');
      assert.equal(airports?.health.status, 'LIVE', 'the bundled filesystem source keeps answering');
      assert.equal(airports?.locality, 'bundled');

      const bundled = await h.client.request('world.query', { objectTypes: ['airport'] });
      assert.ok(bundled.items.length >= 80, `the bundled airports are served offline (got ${bundled.items.length})`);
      assert.ok(bundled.items.some((o) => o.id === 'airport:icao:PHNL'), 'airports join on their ICAO code (ADR-011)');
      assert.equal((await h.client.request('world.query', { objectTypes: ['earthquake'] })).items.length, 0, 'no live earthquakes offline, and none invented');

      // --- offline.status reports the pack and the real capabilities -----------------
      const status = await h.client.request('offline.status', undefined);
      assert.equal(status.connection.state, 'OFFLINE');
      assert.equal(status.packs.length, 1);
      assert.equal(status.packs[0]?.id, 'hawaii');
      assert.equal(status.packs[0]?.status, 'active');
      assert.deepEqual(status.packs[0]?.contents, ['data/places.geojson', 'data/airports.geojson', 'data/earthquakes.ndjson', 'search/index.json', 'licenses/NOTICES.md']);
      assert.equal(status.capabilities.localSearch, true);
      assert.equal(status.capabilities.history, true);
      assert.equal(status.capabilities.localMap, false, 'no basemap extract ships in the repository (docs/OFFLINE-PACKS.md)');

      // --- search still answers from the pack index -----------------------------------
      const honolulu = await h.client.request('search.query', { text: 'Honolulu' });
      assert.ok(honolulu.length > 0);
      assert.ok(honolulu.some((r) => r.source === 'worldpack'), 'the answer came from the installed pack');

      const hnl = await h.client.request('search.query', { text: 'HNL' });
      assert.ok(hnl.some((r) => r.kind === 'place' && /Honolulu|Inouye/.test(r.title)), 'airport codes resolve offline');

      const oahu = await h.client.request('search.query', { text: 'Oahu' });
      assert.ok(oahu.some((r) => r.source === 'worldpack'), 'pack-only places are found');

      // Disabling the pack removes its answers — the capability report follows the data.
      await h.client.request('offline.setPackEnabled', { id: 'hawaii', enabled: false });
      assert.equal((await h.client.request('offline.status', undefined)).capabilities.localSearch, false);
      assert.equal((await h.client.request('search.query', { text: 'Oahu' })).some((r) => r.source === 'worldpack'), false);
      await h.client.request('offline.setPackEnabled', { id: 'hawaii', enabled: true });
      assert.equal((await h.client.request('offline.status', undefined)).capabilities.localSearch, true);

      // --- diagnostics is honest offline ------------------------------------------------
      const diagnostics = await h.client.request('diagnostics.get', undefined);
      assert.equal(diagnostics.offline.connection.state, 'OFFLINE');
      assert.equal(diagnostics.offline.packs.length, 1);

      assert.equal(networkCalls.count, 0, 'nothing reached the network while offline');
    } finally {
      await h.dispose();
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
});
