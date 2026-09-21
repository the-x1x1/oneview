import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testing } from '@worldview/provider-sdk';
import {
  ConnectionMonitor, WorldPackBuilder, WorldPackRegistry, placeHitToSearchResult, seedPolicies, verifyWorldPack,
} from '../../src/index.js';
import { USGS, USGS_POLICY, seededHistory } from '../helpers/history.js';

/**
 * Offline proof (ADR-007): build a Hawaii pack from the bundled seed fixtures,
 * install it into a fresh data directory and, with WORLDVIEW_NETWORK=off and every
 * network primitive disabled, show that the pack loads, local search answers and the
 * attribution travels with the data. Evidence is written to
 * artifacts/verification/offline/worldpack-build-report.json.
 */
process.env['WORLDVIEW_NETWORK'] ??= 'off';

const { VirtualClock } = testing;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const EVIDENCE = path.join(root, 'artifacts', 'verification', 'offline', 'worldpack-build-report.json');

test('offline: Hawaii world pack builds, installs and serves local search with the network off', async () => {
  const startedAt = Date.now();
  assert.equal(process.env['WORLDVIEW_NETWORK'], 'off');
  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { networkCalls++; throw new Error('network is off (WORLDVIEW_NETWORK=off)'); }) as typeof fetch;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'worldview-offline-'));
  try {
    const clock = new VirtualClock(Date.parse('2026-09-21T12:00:00Z'));
    const policies = (id: string) => ({ ...seedPolicies(), [USGS]: USGS_POLICY })[id];
    const history = await seededHistory(path.join(tmp, 'history-source'), clock, policies);

    // 1. build
    const outputPath = path.join(tmp, 'hawaii.worldpack');
    const report = await new WorldPackBuilder().build({
      id: 'hawaii', name: 'Hawaiian Islands', version: '1.0.0', region: { preset: 'hawaii' },
      include: ['places', 'airports', 'earthquakes'],
      sources: {
        placesGeoJsonPath: path.join(root, 'fixtures', 'places', 'seed-places.geojson'),
        airportsGeoJsonPath: path.join(root, 'fixtures', 'airports', 'seed-airports.geojson'),
        history: history.store, earthquakeWindowDays: 30,
      },
      policies, licenses: (id) => (id === USGS ? 'U.S. Government work — public domain' : 'MIT'),
      outputPath, clock,
    });
    await history.store.close();
    assert.equal(report.ok, true);
    assert.equal(report.layers.earthquakes?.rows, history.inside);
    assert.equal(report.layers.airports?.kept, 5);

    // 2. verify + install into a fresh data directory
    const verification = await verifyWorldPack(outputPath, { appVersion: '0.1.0', now: clock.now() });
    assert.equal(verification.ok, true, verification.issues.join('; '));
    const dataDir = path.join(tmp, 'data');
    const registry = new WorldPackRegistry({ dataDir, appVersion: '0.1.0', clock, flags: () => ({ history: true, collections: true, localAircraft: false }) });
    await registry.refresh();
    const installed = await registry.install(outputPath);
    assert.ok(installed.installed, installed.issues.join('; '));
    assert.equal(installed.installed?.status, 'active');
    assert.deepEqual(installed.issues, []);

    // 3. pack loads, local search answers, attribution present, capabilities
    const pack = registry.get('hawaii');
    assert.ok(pack?.manifest);
    const attribution = pack!.manifest!.sourcePolicies.map((p) => p.attribution);
    assert.ok(attribution.some((a) => /U\.S\. Geological Survey/.test(a)), 'USGS attribution travels with the pack');
    assert.ok(attribution.some((a) => /WORLDVIEW project \(MIT\)/.test(a)), 'seed attribution travels with the pack');
    const notices = await fs.readFile(path.join(pack!.dir, 'licenses', 'NOTICES.md'), 'utf8');
    assert.match(notices, /Geological Survey/);

    const index = registry.placeIndex();
    const honolulu = index.search('Honolulu', { limit: 3 });
    const hnl = index.search('HNL', { limit: 3 });
    const oahu = index.search('Oahu', { limit: 3 });
    const kilauea = index.search('kilauea', { limit: 3 });
    assert.equal(honolulu[0]?.entry.name, 'Honolulu');
    assert.equal(hnl[0]?.entry.icao, 'PHNL');
    assert.equal(oahu[0]?.entry.name, 'Oʻahu');
    assert.equal(kilauea[0]?.entry.name, 'Kīlauea');
    assert.equal(index.search('Tokyo').length, 0, 'Tokyo is outside the pack bounds');
    const searchResult = placeHitToSearchResult(hnl[0]!);
    assert.equal(searchResult.source, 'worldpack');

    const capabilities = registry.capabilities();
    assert.equal(capabilities.localSearch, true);
    assert.equal(capabilities.localMap, false, 'no basemap extract is bundled in the repository (see docs/OFFLINE-PACKS.md)');
    assert.equal(capabilities.history, true);
    const quakes = registry.dataFiles('ndjson', 'earthquake');
    assert.equal(quakes.length, 1);
    assert.equal(quakes[0]?.rowCount, history.inside);

    // 4. the application connection state is OFFLINE when the OS says so; no probe or fetch ran
    const monitor = new ConnectionMonitor({ network: { isOnline: () => false }, probe: async () => { networkCalls++; return true; }, clock });
    await monitor.tick();
    assert.equal(monitor.state(), 'OFFLINE');
    const status = registry.status(monitor.snapshot());
    assert.equal(status.connection.state, 'OFFLINE');
    assert.equal(status.packs.length, 1);
    assert.equal(networkCalls, 0, 'nothing touched the network');

    const durationMs = Date.now() - startedAt;
    assert.ok(durationMs < 5000, `offline test took ${durationMs} ms`);

    // 5. evidence
    await fs.mkdir(path.dirname(EVIDENCE), { recursive: true });
    await fs.writeFile(EVIDENCE, JSON.stringify({
      ranAt: new Date().toISOString(),
      env: { WORLDVIEW_NETWORK: process.env['WORLDVIEW_NETWORK'], node: process.version },
      durationMs,
      networkCalls,
      build: { ...report, outputPath: path.basename(report.outputPath), reportPath: path.basename(report.reportPath), layers: { ...report.layers } },
      verification: { ok: verification.ok, entries: verification.entries.map((e) => ({ path: e.path, kind: e.kind, sizeBytes: e.sizeBytes, sha256: e.sha256 })), warnings: verification.warnings },
      installed: installed.installed,
      capabilities,
      connection: status.connection,
      search: {
        Honolulu: honolulu.map((h) => ({ id: h.entry.id, name: h.entry.name, score: h.score, match: h.match })),
        HNL: hnl.map((h) => ({ id: h.entry.id, name: h.entry.name, iata: h.entry.iata, score: h.score, match: h.match })),
        Oahu: oahu.map((h) => ({ id: h.entry.id, name: h.entry.name, score: h.score, match: h.match })),
        Tokyo: index.search('Tokyo').length,
      },
      attribution,
      skips: [],
      notes: [
        'The map layer (PMTiles) is not exercised here: no basemap extract is bundled in the repository. capabilities.localMap is therefore false in this run; the builder unit test covers the map include with a PMTiles v3 header stub.',
        'Earthquake rows come from an NDJSON history store seeded by the test (5 inside the Hawaii bounds, 3 outside), not from a live feed.',
      ],
    }, null, 2) + '\n');
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
