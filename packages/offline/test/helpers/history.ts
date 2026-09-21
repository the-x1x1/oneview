import type { Observation } from '@worldview/world-model';
import type { ProviderDataPolicy } from '@worldview/provider-sdk';
import { HistoryStore, NdjsonBackend } from '@worldview/history-store';

/** Test-only: an NDJSON-backed history store seeded with earthquake observations. */
export const USGS = 'usgs-earthquakes';

export const USGS_POLICY: ProviderDataPolicy = {
  cacheAllowed: true, rawPayloadRetentionAllowed: true, normalizedRetentionAllowed: true,
  redistributionAllowed: true, offlinePackAllowed: true, exportAllowed: true, commercialUseAllowed: true,
  attributionRequired: false, attributionText: 'Data courtesy of the U.S. Geological Survey',
  termsUrl: 'https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits',
};

export function quake(id: string, observedAt: string, lat: number, lon: number, magnitude: number, providerId = USGS): Observation {
  return {
    id: `${providerId}:${id}:${observedAt}`,
    providerId,
    externalId: id,
    objectType: 'earthquake',
    observedAt,
    receivedAt: observedAt,
    position: { latitude: lat, longitude: lon, altitudeM: -8000 },
    payload: { magnitude, place: `test ${id}`, title: `M ${magnitude} — test ${id}` },
    quality: { complete: true, sourceQuality: 'authoritative' },
    provenance: { providerId, sourceName: 'USGS Earthquakes', origin: 'live', receivedAt: observedAt },
  };
}

export interface SeededHistory { store: HistoryStore; inside: number; outside: number }

/** Seeds quakes: `inside` within the Hawaii bounds, `outside` in Japan, all inside the last 30 days of `nowMs`. */
export async function seededHistory(dataDir: string, clock: { now(): number }, policies: (id: string) => ProviderDataPolicy | undefined): Promise<SeededHistory> {
  const backend = new NdjsonBackend({ dataDir, clock });
  const store = new HistoryStore({ dataDir, backend, clock, policies });
  await store.open();
  const now = clock.now();
  const obs: Observation[] = [];
  const hawaii: Array<[number, number]> = [[19.42, -155.29], [19.48, -155.61], [20.7, -156.2], [21.3, -157.9], [19.2, -155.4]];
  const japan: Array<[number, number]> = [[35.7, 139.7], [38.3, 142.4], [34.7, 135.5]];
  hawaii.forEach(([lat, lon], i) => obs.push(quake(`hv${i}`, new Date(now - (i + 1) * 86_400_000).toISOString(), lat, lon, 2.5 + i * 0.4)));
  japan.forEach(([lat, lon], i) => obs.push(quake(`jp${i}`, new Date(now - (i + 2) * 86_400_000).toISOString(), lat, lon, 4.0 + i)));
  store.writeBatch(HistoryStore.batchOf(USGS, obs, new Date(now).toISOString()));
  await store.flush();
  return { store, inside: hawaii.length, outside: japan.length };
}
