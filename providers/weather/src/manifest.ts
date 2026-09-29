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
 * are restricted). On by default since 0.1.10: warnings — a tornado warning above all — are
 * the most important thing the weather view shows. Without an operator contact the
 * User-Agent names the application and its project page, which is the identification
 * api.weather.gov asks for ("a website or email address").
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
    // One alerts fetch and a budget of 40 zone outlines at one request a second.
    timeoutMs: 30_000,
    maxRetries: 2,
    // 4/min was the number that made zone-based alerts look unfixable. The poll budget
    // allows 40 zone outlines per cycle, but the limiter is a sliding window over *all* of
    // this provider's requests: one alerts fetch plus three zones, and then nothing for the
    // rest of the minute — while the poll itself times out at 20 s. The application log
    // said so plainly and repeatedly ("NWS zone geometry ... fetched: 3, pending: 326"),
    // which at five minutes a cycle is nine hours to resolve one cold start, and meanwhile
    // roughly four alerts in five were on the wire and not on the map.
    //
    // api.weather.gov is a public-domain US government service with no API key and no
    // published rate limit; its guidance is a real User-Agent and reasonable use. One
    // request per second is well inside that, and it is what the zone budget was written
    // against. `manifest.test.ts` now asserts the two numbers stay consistent, because the
    // failure mode when they drift is silent and looks like missing data, not like a
    // throttle.
    maxRequestsPerMinute: 60,
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
  enabledByDefault: true,
  allowedHosts: ['api.weather.gov'],
  settings: [
    {
      key: 'contact',
      label: 'Contact for the User-Agent',
      kind: 'string',
      placeholder: 'you@example.org or a URL',
      defaultLabel: 'The WorldView project page',
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

/** The identification sent when the operator has not given a contact of their own. */
export const NWS_DEFAULT_CONTACT = 'https://github.com/the-x1x1/oneview';

export function nwsUserAgent(contact: string | undefined): string {
  return `${NWS_USER_AGENT_PRODUCT} (contact: ${contact || NWS_DEFAULT_CONTACT})`;
}
