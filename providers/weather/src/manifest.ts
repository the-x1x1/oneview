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
  description:
    'Active watches, warnings and advisories for the United States from the National Weather Service API (api.weather.gov). Polygon-based alerts only; zone-only alerts are skipped until zone geometry is resolved.',
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
  settings: [
    {
      key: 'contact',
      label: 'Contact for the User-Agent',
      kind: 'string',
      placeholder: 'you@example.org or a URL',
      defaultLabel: 'Not configured — the User-Agent says so',
      description:
        'api.weather.gov asks clients to identify themselves and may answer 403 without this. It is sent to weather.gov only.',
      helpUrl: 'https://www.weather.gov/documentation/services-web-api',
    },
    {
      key: 'areas',
      label: 'States and marine areas',
      kind: 'multi-enum',
      defaultLabel: 'The whole country',
      description: 'Narrows the feed to these areas. Leave empty for national coverage.',
      options: [
        { value: 'AL', label: 'Alabama' },
        { value: 'AK', label: 'Alaska' },
        { value: 'AZ', label: 'Arizona' },
        { value: 'AR', label: 'Arkansas' },
        { value: 'CA', label: 'California' },
        { value: 'CO', label: 'Colorado' },
        { value: 'CT', label: 'Connecticut' },
        { value: 'DE', label: 'Delaware' },
        { value: 'FL', label: 'Florida' },
        { value: 'GA', label: 'Georgia' },
        { value: 'HI', label: 'Hawaii' },
        { value: 'ID', label: 'Idaho' },
        { value: 'IL', label: 'Illinois' },
        { value: 'IN', label: 'Indiana' },
        { value: 'IA', label: 'Iowa' },
        { value: 'KS', label: 'Kansas' },
        { value: 'KY', label: 'Kentucky' },
        { value: 'LA', label: 'Louisiana' },
        { value: 'ME', label: 'Maine' },
        { value: 'MD', label: 'Maryland' },
        { value: 'MA', label: 'Massachusetts' },
        { value: 'MI', label: 'Michigan' },
        { value: 'MN', label: 'Minnesota' },
        { value: 'MS', label: 'Mississippi' },
        { value: 'MO', label: 'Missouri' },
        { value: 'MT', label: 'Montana' },
        { value: 'NE', label: 'Nebraska' },
        { value: 'NV', label: 'Nevada' },
        { value: 'NH', label: 'New Hampshire' },
        { value: 'NJ', label: 'New Jersey' },
        { value: 'NM', label: 'New Mexico' },
        { value: 'NY', label: 'New York' },
        { value: 'NC', label: 'North Carolina' },
        { value: 'ND', label: 'North Dakota' },
        { value: 'OH', label: 'Ohio' },
        { value: 'OK', label: 'Oklahoma' },
        { value: 'OR', label: 'Oregon' },
        { value: 'PA', label: 'Pennsylvania' },
        { value: 'RI', label: 'Rhode Island' },
        { value: 'SC', label: 'South Carolina' },
        { value: 'SD', label: 'South Dakota' },
        { value: 'TN', label: 'Tennessee' },
        { value: 'TX', label: 'Texas' },
        { value: 'UT', label: 'Utah' },
        { value: 'VT', label: 'Vermont' },
        { value: 'VA', label: 'Virginia' },
        { value: 'WA', label: 'Washington' },
        { value: 'WV', label: 'West Virginia' },
        { value: 'WI', label: 'Wisconsin' },
        { value: 'WY', label: 'Wyoming' },
        { value: 'DC', label: 'District of Columbia' },
        { value: 'PR', label: 'Puerto Rico' },
      ],
    },
  ],
};

export const NWS_ALERTS_URL = 'https://api.weather.gov/alerts/active?status=actual&message_type=alert,update';

/** Product identity sent to api.weather.gov; the contact is operator-configured (settings.contact). */
export const NWS_USER_AGENT_PRODUCT = 'WorldView/0.1';

export function nwsUserAgent(contact: string | undefined): string {
  return contact
    ? `${NWS_USER_AGENT_PRODUCT} (contact: ${contact})`
    : `${NWS_USER_AGENT_PRODUCT} (contact: not configured)`;
}
