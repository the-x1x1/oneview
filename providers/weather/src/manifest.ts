import type { ProviderManifest } from '@worldview/provider-sdk';

/**
 * NOAA / National Weather Service — active alerts from api.weather.gov (GeoJSON).
 *
 * The API requires an identifying User-Agent with contact information and
 * throttles unidentified clients; the provider sends one built from its
 * `contact` setting. Responses carry ETags, which the runtime's HTTP layer turns
 * into conditional requests (304 → cached body, no re-parse cost upstream).
 *
 * Legal: US Government work, public domain; text attribution only (NWS insignia
 * are restricted). Registry plannedStatus "optional" → not enabled by default.
 */
export const NWS_MANIFEST: ProviderManifest = {
  id: 'nws-alerts',
  name: 'NWS weather alerts',
  version: '0.1.0',
  description: 'Active watches, warnings and advisories for the United States from the National Weather Service API (api.weather.gov). Polygon-based alerts only; zone-only alerts are skipped until zone geometry is resolved.',
  objectTypes: ['weather-alert'],
  categories: ['weather', 'disasters'],
  transport: 'http',
  capabilities: { live: true, historical: false, offline: false, boundsQuery: false },
  credentials: [],
  refreshPolicy: {
    intervalMs: 5 * 60_000,
    minIntervalMs: 60_000,
    timeoutMs: 20_000,
    maxRetries: 2,
    maxRequestsPerMinute: 4,
    staleWhileErrorMs: 3600_000,
    freshness: { 'weather-alert': { liveSeconds: 1800, recentSeconds: 6 * 3600, expireSeconds: 48 * 3600 } },
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
    attributionText: 'Alerts: NOAA National Weather Service',
    termsUrl: 'https://www.weather.gov/disclaimer',
  },
  attribution: { text: 'Alerts: NOAA National Weather Service', url: 'https://www.weather.gov/', licenseId: 'US-PD' },
  commercialReview: 'approved',
  enabledByDefault: false,
  allowedHosts: ['api.weather.gov'],
};

export const NWS_ALERTS_URL = 'https://api.weather.gov/alerts/active?status=actual&message_type=alert,update';

/** Product identity sent to api.weather.gov; the contact is operator-configured (settings.contact). */
export const NWS_USER_AGENT_PRODUCT = 'WorldView/0.1';

export function nwsUserAgent(contact: string | undefined): string {
  return contact ? `${NWS_USER_AGENT_PRODUCT} (contact: ${contact})` : `${NWS_USER_AGENT_PRODUCT} (contact: not configured)`;
}
