import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { JsonValue, Observation } from '@worldview/world-model';
import type { ProviderDataPolicy } from '@worldview/provider-sdk';
import { LoggerHub, RingBufferSink } from '@worldview/core';
import type { ObservationBatch } from '@worldview/provider-runtime';
import { observationToRow, partitionKeyFor, type HistoryBackend, type HistoryRow, type PartitionKey } from '../../src/index.js';
import { defaultIdentityResolver } from '@worldview/identity';

export const AIRCRAFT_PROVIDER = 'opensky';
export const QUAKE_PROVIDER = 'usgs-earthquakes';

export const OPEN_POLICY: ProviderDataPolicy = {
  cacheAllowed: true, rawPayloadRetentionAllowed: true, normalizedRetentionAllowed: true,
  redistributionAllowed: true, offlinePackAllowed: true, exportAllowed: true, commercialUseAllowed: true, attributionRequired: false,
};
export const NO_RAW_POLICY: ProviderDataPolicy = { ...OPEN_POLICY, rawPayloadRetentionAllowed: false };
export const NO_RETAIN_POLICY: ProviderDataPolicy = { ...OPEN_POLICY, normalizedRetentionAllowed: false, rawPayloadRetentionAllowed: false };
export const CAPPED_POLICY: ProviderDataPolicy = { ...OPEN_POLICY, maxRetentionSeconds: 3600 };

export function policies(map: Record<string, ProviderDataPolicy>): (providerId: string) => ProviderDataPolicy | undefined {
  return (id) => map[id];
}

export async function tempDir(prefix = 'worldview-history-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export function makeLogger(): { hub: LoggerHub; sink: RingBufferSink } {
  const sink = new RingBufferSink();
  return { hub: new LoggerHub({ level: 'debug', sinks: [sink] }), sink };
}

export function aircraftObs(icao24: string, observedAt: string, lat: number, lon: number, extra: Record<string, JsonValue> = {}, providerId = AIRCRAFT_PROVIDER): Observation {
  return {
    id: `${providerId}:${icao24}:${observedAt}`,
    providerId,
    externalId: icao24,
    objectType: 'aircraft',
    observedAt,
    receivedAt: observedAt,
    position: { latitude: lat, longitude: lon, altitudeM: 10_000 },
    payload: { icao24, callsign: `WV${icao24.slice(-3).toUpperCase()}`, speedMps: 230, headingDegrees: 90, ...extra },
    quality: { complete: true, sourceQuality: 'crowdsourced' },
    rawPayloadHash: `hash-${icao24}-${observedAt}`,
    provenance: { providerId, sourceName: 'OpenSky Network', origin: 'live', receivedAt: observedAt },
  };
}

export function quakeObs(eventId: string, observedAt: string, lat: number, lon: number, magnitude: number, providerId = QUAKE_PROVIDER): Observation {
  return {
    id: `${providerId}:${eventId}:${observedAt}`,
    providerId,
    externalId: eventId,
    objectType: 'earthquake',
    observedAt,
    receivedAt: observedAt,
    position: { latitude: lat, longitude: lon },
    payload: { magnitude, place: `${magnitude} km test region`, title: `M ${magnitude}` },
    quality: { complete: true, sourceQuality: 'authoritative' },
    rawPayloadHash: `hash-${eventId}`,
    provenance: { providerId, sourceName: 'USGS', origin: 'live', receivedAt: observedAt },
  };
}

export function batch(providerId: string, observations: Observation[], receivedAt = observations[0]?.observedAt ?? '2026-09-21T00:00:00.000Z'): ObservationBatch {
  return { providerId, observations, snapshot: false, receivedAt, rejected: 0 };
}

export function rowsFor(observations: Observation[], includeRawHash = true): Array<{ key: PartitionKey; row: HistoryRow }> {
  return observations.map((o) => {
    const row = observationToRow(o, defaultIdentityResolver.resolve(o).objectId, { includeRawHash });
    return { key: partitionKeyFor(o.objectType, o.providerId, row.observedAt, 60), row };
  });
}

export function iso(base: string, plusSeconds: number): string {
  return new Date(Date.parse(base) + plusSeconds * 1000).toISOString();
}

/** Explicit delegation wrapper so failure-injection overrides never touch the inner backend's `this`. */
export function wrapBackend(inner: HistoryBackend, overrides: Partial<HistoryBackend>): HistoryBackend {
  return {
    kind: inner.kind,
    open: () => inner.open(),
    flush: () => inner.flush(),
    close: () => inner.close(),
    append: (k, r) => inner.append(k, r),
    listPartitions: (f) => inner.listPartitions(f),
    readPartition: (k) => inner.readPartition(k),
    deletePartition: (k) => inner.deletePartition(k),
    rewritePartition: (k, r, m) => inner.rewritePartition(k, r, m),
    objectsAt: (c, o) => inner.objectsAt(c, o),
    track: (id, r) => inner.track(id, r),
    availability: (t) => inner.availability(t),
    counts: (q) => inner.counts(q),
    observationsInRange: (q) => inner.observationsInRange(q),
    diagnostics: () => inner.diagnostics(),
    ...overrides,
  };
}
