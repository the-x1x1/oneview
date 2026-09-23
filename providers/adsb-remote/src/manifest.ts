import type { ProviderManifest } from '@worldview/provider-sdk';

/**
 * adsb.lol — community ADS-B aggregator, v2 API point queries.
 * Data: ODbL 1.0 (adsb.lol globe_history). Attribution required; share-alike applies to
 * publicly redistributed derived databases (see config/licenses/providers.json).
 * API etiquette: no formal ToS; rate limits are dynamic. This provider issues at most one
 * request per 10 s — a point query, or while the view is wider than one point query covers,
 * a point query one poll in three and a worldwide type query (`/v2/type/{type}`, coverage.ts)
 * the others — and quantises the query centre so viewport jitter does not create new endpoints.
 */
export const ADSB_LOL_MANIFEST: ProviderManifest = {
  id: 'adsb-lol',
  name: 'adsb.lol',
  version: '0.1.0',
  description:
    'Aircraft positions from the adsb.lol community ADS-B aggregator: every aircraft within 250 nm of the view centre, and — zoomed out — the commonest airliner and business-jet types worldwide, one type a poll in turn.',
  objectTypes: ['aircraft'],
  categories: ['aviation'],
  transport: 'http',
  capabilities: { live: true, historical: false, offline: false, boundsQuery: true },
  credentials: [],
  refreshPolicy: {
    intervalMs: 10_000,
    minIntervalMs: 10_000,
    timeoutMs: 10_000,
    maxRetries: 1,
    // Six, with a ten-second poll interval, is exactly six polls a minute — the limiter and
    // the cadence set to the same number, leaving nothing for the retry this policy also
    // allows or for a refresh the viewport triggers. The client limiter is a sliding window,
    // so the seventh request in any sixty seconds is refused and the poll serves stale
    // aircraft instead.
    //
    // What this change is *not* is a demonstrated cure. The application log holds 801
    // adsb-lol stale serves — 756 of them from one nine-and-a-half-hour run, about one a
    // minute, or roughly one poll in six — and the first run with this limit still served
    // stale at about 0.7 a minute. Those old lines did not record whether the refusal was
    // this limiter or adsb.lol answering 429; `http.ts` now logs `httpStatus` on every stale
    // serve (null for our own limiter, 429 for theirs), and that field is what to read
    // before changing anything else here.
    //
    // It is still right on its own terms. This does not make WORLDVIEW ask adsb.lol for
    // anything more often — `intervalMs` sets the cadence and is unchanged at ten seconds —
    // it only stops our own safety net being set exactly at the rate we poll. Twenty a
    // minute is one request every three seconds at worst, well inside adsb.lol's guidance,
    // and `registry.test.ts` now fails if any provider's limit stops covering its own
    // cadence.
    maxRequestsPerMinute: 20,
    staleWhileErrorMs: 120_000,
    freshness: { aircraft: { liveSeconds: 30, recentSeconds: 90, expireSeconds: 600 } },
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
    attributionText: 'Aircraft positions: adsb.lol contributors (ODbL 1.0)',
    termsUrl: 'https://github.com/adsblol/globe_history',
  },
  attribution: {
    text: 'Aircraft positions: adsb.lol contributors (ODbL 1.0)',
    url: 'https://adsb.lol/',
    licenseId: 'ODbL-1.0',
  },
  commercialReview: 'conditional',
  enabledByDefault: true,
  allowedHosts: ['api.adsb.lol'],
};

export const ADSB_LOL_API_BASE = 'https://api.adsb.lol/v2';

/** Hard cap of the adsb.lol point query. */
export const ADSB_LOL_MAX_RADIUS_NM = 250;

export function pointQueryUrl(latitude: number, longitude: number, radiusNm: number): string {
  const nm = Math.max(1, Math.min(ADSB_LOL_MAX_RADIUS_NM, Math.round(radiusNm)));
  return `${ADSB_LOL_API_BASE}/lat/${latitude.toFixed(2)}/lon/${longitude.toFixed(2)}/dist/${nm}`;
}
