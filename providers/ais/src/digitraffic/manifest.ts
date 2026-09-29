import type { ProviderManifest } from '@worldview/provider-sdk';

/**
 * digitraffic-ais — ships in the Baltic from Fintraffic's Digitraffic Marine AIS service,
 * with no key: Finland's traffic agency publishes what its coastal AIS base stations hear as
 * open data (CC BY 4.0, "Source: Fintraffic / digitraffic.fi, license CC 4.0 BY").
 *
 * Two REST endpoints on one host (https://www.digitraffic.fi/en/marine-traffic/, OpenAPI
 * https://meri.digitraffic.fi/swagger/, read 2026-09-28):
 *
 *   GET /api/ais/v1/locations?from=<ms>   GeoJSON: one feature per ship, its latest position
 *   GET /api/ais/v1/vessels?from=<ms>     static data: name, call sign, IMO, type, draught…
 *
 * Every poll asks for the positions of the last LOCATION_WINDOW_MS (a ship at anchor reports
 * every three minutes, so a quarter of an hour keeps every ship in range and drops those that
 * have gone), and the answer is the whole snapshot — no state kept between polls to go wrong.
 * Static data changes rarely and is asked for every quarter of an hour, only what changed
 * since the last answer (`from`), and remembered per MMSI (index.ts).
 *
 * Etiquette (Digitraffic "Instructions", read 2026-09-28): identify with a `Digitraffic-User`
 * header naming the application, never a person (the camera pack's value is reused); gzip
 * is mandatory — the runtime's fetch asks for and decodes it by default; without the header
 * the limit is 60 requests a minute per address. This provider makes one request a minute
 * and a second one a quarter of an hour.
 *
 * Coverage is Finland's AIS network: the Gulf of Finland, the Archipelago and Bothnian Seas
 * and the northern Baltic Proper, with ships further south as reception allows.
 */
export const DIGITRAFFIC_AIS_MANIFEST: ProviderManifest = {
  id: 'digitraffic-ais',
  name: 'Digitraffic Marine AIS (Fintraffic)',
  version: '0.1.0',
  description:
    'Ships in the Baltic from the Finnish Transport Infrastructure Agency’s AIS base stations, published by Fintraffic’s Digitraffic service as open data (CC BY 4.0). No key. Positions every minute; name, call sign, IMO, type, destination, ETA, draught and size from each ship’s static reports. Converted to metric units, with AIS codes shown as text.',
  objectTypes: ['vessel'],
  categories: ['maritime'],
  transport: 'http',
  capabilities: { live: true, historical: false, offline: false, boundsQuery: false },
  credentials: [],
  refreshPolicy: {
    intervalMs: 60_000,
    minIntervalMs: 30_000,
    timeoutMs: 20_000,
    maxRetries: 1,
    // One position request a poll, and every quarter of an hour one static-data request;
    // six covers that with the retry and a manual refresh, a tenth of what Digitraffic
    // allows an unidentified client.
    maxRequestsPerMinute: 6,
    staleWhileErrorMs: 5 * 60_000,
    // Same classes as the AISStream provider: a ship under way reports every 2–10 s, at
    // anchor every three minutes.
    freshness: { vessel: { liveSeconds: 180, recentSeconds: 900, expireSeconds: 3 * 3600 } },
  },
  dataPolicy: {
    cacheAllowed: true,
    rawPayloadRetentionAllowed: true,
    normalizedRetentionAllowed: true,
    redistributionAllowed: true,
    offlinePackAllowed: true,
    exportAllowed: true,
    commercialUseAllowed: true,
    attributionRequired: true,
    attributionText: 'Ships (Baltic): Source: Fintraffic / digitraffic.fi, license CC 4.0 BY',
    termsUrl: 'https://www.digitraffic.fi/en/terms-of-service/',
  },
  attribution: {
    text: 'Ships (Baltic): Source: Fintraffic / digitraffic.fi, license CC 4.0 BY',
    url: 'https://www.digitraffic.fi/en/marine-traffic/',
    licenseId: 'CC-BY-4.0',
  },
  commercialReview: 'approved',
  enabledByDefault: true,
  allowedHosts: ['meri.digitraffic.fi'],
};

export const DIGITRAFFIC_MARINE_BASE = 'https://meri.digitraffic.fi/api/ais/v1';
export const DIGITRAFFIC_LOCATIONS_URL = `${DIGITRAFFIC_MARINE_BASE}/locations`;
export const DIGITRAFFIC_VESSELS_URL = `${DIGITRAFFIC_MARINE_BASE}/vessels`;

/**
 * What the `Digitraffic-User` header says: the application, never a person. The same value
 * the public-cameras Fintraffic pack sends (providers/cctv-public/src/packs/fintraffic.ts),
 * so Fintraffic sees one client.
 */
export const DIGITRAFFIC_USER = 'worldview';

/** Positions of the last quarter of an hour, every poll. */
export const LOCATION_WINDOW_MS = 15 * 60_000;
/** Static data: asked for this often, and again this soon after a failure. */
export const METADATA_REFRESH_MS = 15 * 60_000;
export const METADATA_RETRY_MS = 2 * 60_000;
/** A later static-data request overlaps the previous one by this much (clock skew, late rows). */
export const METADATA_OVERLAP_MS = 5 * 60_000;

/** The positions request for a poll at `nowMs`: `from` on the whole minute, so retries share it. */
export function locationsUrl(nowMs: number): string {
  const from = Math.floor((nowMs - LOCATION_WINDOW_MS) / 60_000) * 60_000;
  return `${DIGITRAFFIC_LOCATIONS_URL}?from=${from}`;
}

/** The static-data request: everything of the last day the first time, then what changed since. */
export function vesselsUrl(fromMs: number | undefined): string {
  return fromMs === undefined ? DIGITRAFFIC_VESSELS_URL : `${DIGITRAFFIC_VESSELS_URL}?from=${Math.floor(fromMs)}`;
}
