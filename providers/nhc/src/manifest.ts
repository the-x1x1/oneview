import type { ProviderManifest } from '@worldview/provider-sdk';

/**
 * NOAA National Hurricane Center — active tropical cyclones (roadmap 0.4 storm tracks).
 *
 * One small JSON file lists every storm NHC and the Central Pacific Hurricane Center are
 * advising on: position, intensity (knots), pressure (mb), motion (degrees, mph) and the
 * advisory it comes from. Checked against the live file and the public advisory text on
 * 2026-09-23 (Tropical Storm Odalys, advisory 12: "60" = 70 mph sustained; movement 70° at
 * 9 mph; 994 mb). Advisories are issued every 6 h (3 h intermediates when watches are up),
 * so a 15-minute poll is ample; the file is a few kilobytes.
 *
 * Data: U.S. Government work. NHC's pages carry the NWS disclaimer: "The information on
 * National Weather Service (NWS) Web pages are in the public domain, unless specifically
 * noted otherwise, and may be used without charge for any lawful purpose"
 * (https://www.weather.gov/disclaimer). The NWS name and insignia are not used; the credit
 * is text.
 */
export const NHC_CURRENT_STORMS_URL = 'https://www.nhc.noaa.gov/CurrentStorms.json';

export const NHC_MANIFEST: ProviderManifest = {
  id: 'nhc-storms',
  name: 'NHC tropical cyclones',
  version: '0.1.0',
  description:
    'Active tropical cyclones in the Atlantic, Eastern and Central Pacific from the NOAA National Hurricane Center: position, intensity, pressure, motion and advisory.',
  objectTypes: ['storm'],
  categories: ['weather', 'disasters'],
  transport: 'http',
  capabilities: { live: true, historical: false, offline: false, boundsQuery: false },
  credentials: [],
  refreshPolicy: {
    intervalMs: 15 * 60_000,
    minIntervalMs: 5 * 60_000,
    timeoutMs: 20_000,
    maxRetries: 2,
    maxRequestsPerMinute: 4,
    staleWhileErrorMs: 12 * 3600_000,
    // An advisory stands for 6 h (3 h with intermediates): live until the next is late.
    freshness: { storm: { liveSeconds: 7 * 3600, recentSeconds: 24 * 3600 } },
  },
  dataPolicy: {
    cacheAllowed: true,
    rawPayloadRetentionAllowed: true,
    normalizedRetentionAllowed: true,
    redistributionAllowed: true,
    offlinePackAllowed: true,
    exportAllowed: true,
    commercialUseAllowed: true,
    attributionRequired: false,
    attributionText: 'Tropical cyclones: NOAA National Hurricane Center',
    termsUrl: 'https://www.weather.gov/disclaimer',
  },
  attribution: {
    text: 'Tropical cyclones: NOAA National Hurricane Center',
    url: 'https://www.nhc.noaa.gov/',
    licenseId: 'US-PD',
  },
  commercialReview: 'approved',
  enabledByDefault: true,
  allowedHosts: ['www.nhc.noaa.gov'],
};
