import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildObservation,
  type FlightRouteAnswer,
  type FlightRouteRequest,
  type ProviderContext,
  type ProviderHealth,
  type ProviderManifest,
  type ProviderQuery,
  type WorldProvider,
} from '@worldview/provider-sdk';
import type { Observation } from '@worldview/world-model';
import { settle, startRuntime } from '../helpers/harness.js';

/**
 * `world.flight`: the selected aircraft's airline and type from the bundled tables, and its
 * planned route from a route source (provider-sdk flight-route.ts). A fake provider stands in
 * for adsb.lol: two invented aircraft — an airline flight and a private aircraft flying its
 * registration — and an invented route for the first.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const MANIFEST: ProviderManifest = {
  id: 'route-test-provider',
  name: 'Flight route test provider',
  version: '0.0.0',
  description: 'Two aircraft and an invented route. Exists only for this test.',
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
  attribution: { text: 'Flight route test provider' },
  commercialReview: 'approved',
  enabledByDefault: true,
  allowedHosts: [],
};

class RouteProvider implements WorldProvider {
  readonly manifest = MANIFEST;
  asked: FlightRouteRequest[] = [];
  private context!: ProviderContext;
  async initialize(context: ProviderContext): Promise<void> {
    this.context = context;
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async health(): Promise<ProviderHealth> {
    return { providerId: MANIFEST.id, status: 'LIVE', objectCount: 2 } as ProviderHealth;
  }
  async query(_request: ProviderQuery): Promise<Observation[]> {
    const now = this.context.clock.now();
    const at = new Date(now - 1000).toISOString();
    const make = (externalId: string, callsign: string, typeCode: string) =>
      buildObservation(MANIFEST, new Date(now).toISOString(), {
        externalId,
        objectType: 'aircraft',
        observedAt: at,
        position: { latitude: 30, longitude: -140, altitudeM: 11_000, altitudeDatum: 'barometric' },
        payload: { icao24: externalId, callsign, typeCode },
      });
    return [make('a1b2c3', 'UAL1', 'B789'), make('a1b2c4', 'N123AB', 'C172')];
  }
  async flightRoute(request: FlightRouteRequest): Promise<FlightRouteAnswer | undefined> {
    this.asked.push(request);
    return {
      label: 'test routes',
      attribution: 'Test routes (invented)',
      callsign: request.callsign,
      airlineCode: 'UAL',
      flightNumber: '1',
      airports: [
        { code: 'KSFO', icao: 'KSFO', name: 'San Francisco Intl', latitude: 37.62, longitude: -122.38 },
        { code: 'PHNL', icao: 'PHNL' },
      ],
    };
  }
}

test('world.flight: the selected airline flight is named, typed and routed; a registration is not looked up', async () => {
  const resources = mkdtempSync(path.join(os.tmpdir(), 'wv-flight-res-'));
  copyFileSync(
    path.join(root, 'fixtures', 'aviation', 'aviation-reference.json'),
    path.join(resources, 'aviation-reference.json'),
  );
  copyFileSync(
    path.join(root, 'fixtures', 'airports', 'seed-airports.geojson'),
    path.join(resources, 'airports.geojson'),
  );
  const provider = new RouteProvider();
  const h = await startRuntime({ providerInstances: [provider], resourcesDir: resources });
  try {
    await h.client.request('sources.refresh', { providerId: MANIFEST.id });
    await settle();
    const items = (await h.client.request('world.query', { objectTypes: ['aircraft'] })).items;
    const airline = items.find((o) => o.properties['callsign'] === 'UAL1')!;
    const priv = items.find((o) => o.properties['callsign'] === 'N123AB')!;

    const info = await h.client.request('world.flight', { objectId: airline.id });
    assert.ok(info);
    assert.equal(info.routeStatus, 'found');
    assert.equal(info.airline?.name, 'United Airlines');
    assert.equal(info.flightNumber, 'UA 1');
    assert.equal(info.aircraftType?.name, 'Boeing 787-9');
    assert.deepEqual(
      info.route?.airports.map((a) => [a.code, a.describedBy]),
      [
        ['KSFO', 'route'],
        ['PHNL', 'reference'],
      ],
    );
    assert.equal(provider.asked.length, 1);
    assert.deepEqual(provider.asked[0]!.position, { latitude: 30, longitude: -140 });

    const none = await h.client.request('world.flight', { objectId: priv.id });
    assert.equal(none?.routeStatus, 'not-applicable');
    assert.equal(none?.airline, undefined);
    assert.equal(provider.asked.length, 1, 'the private aircraft was never sent to the route source');

    assert.equal(await h.client.request('world.flight', { objectId: 'earthquake:usgs:nope' }), null);
  } finally {
    await h.dispose();
    rmSync(resources, { recursive: true, force: true });
  }
});
