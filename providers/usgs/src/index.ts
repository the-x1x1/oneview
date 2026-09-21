import type { Observation } from '@worldview/world-model';
import { PollingProvider, ProviderError, assertAtomicAdmission, type HistoricalProviderQuery, type ProviderContext, type ProviderManifest, type ProviderQuery } from '@worldview/provider-sdk';
import { USGS_MANIFEST, USGS_FDSN_BASE, feedUrl, type UsgsFeedWindow } from './manifest.js';
import { normalizeUsgsFeed } from './normalize.js';

export { USGS_MANIFEST, feedUrl, USGS_FDSN_BASE } from './manifest.js';
export { normalizeUsgsFeed, featureToDraft } from './normalize.js';
export type { UsgsFeedWindow } from './manifest.js';

export interface UsgsSettings {
  /** Which summary feed to poll (default 'day'). */
  feed?: UsgsFeedWindow;
  /** Drop events below this magnitude (default: keep all). */
  minMagnitude?: number;
}

const MAX_FEED_BYTES = 12 * 1024 * 1024; // all_month can reach ~10 MB

export class UsgsEarthquakeProvider extends PollingProvider {
  readonly manifest: ProviderManifest = USGS_MANIFEST;
  private settings: UsgsSettings = {};

  protected override async onInitialize(context: ProviderContext): Promise<void> {
    this.settings = parseSettings(await context.settings.get());
    context.settings.onChange((s) => { this.settings = parseSettings(s); });
  }

  protected async fetchOnce(request: ProviderQuery): Promise<{ observations: Observation[]; cacheAgeMs?: number }> {
    const window = this.settings.feed ?? 'day';
    const url = feedUrl(window);
    const res = await this.context.http.request({ url, signal: request.signal, maxBytes: MAX_FEED_BYTES, headers: { Accept: 'application/geo+json, application/json' } });
    let payload: unknown;
    try { payload = res.json(); } catch { res.invalidate(); throw new ProviderError('MALFORMED', 'USGS feed is not valid JSON', { retryable: false }); }
    const receivedAt = new Date(this.context.clock.now()).toISOString();
    const result = normalizeUsgsFeed(payload, {
      receivedAt,
      hash: (s) => this.context.hash.sha256Hex(s),
      origin: res.stale || res.fromCache ? 'cached' : 'live',
      sourceRef: url,
      ...(this.settings.minMagnitude !== undefined ? { minMagnitude: this.settings.minMagnitude } : {}),
    });
    if (result.rejected.some((r) => r.index === -1)) { res.invalidate(); throw new ProviderError('MALFORMED', 'USGS feed is not a FeatureCollection', { retryable: false }); }
    // Atomic admission: rows filtered by minMagnitude are not rejections, so only count hard rejections.
    if (result.total > 0 && result.observations.length === 0 && result.rejected.length === result.total) { res.invalidate(); assertAtomicAdmission(result.total, 0, 'USGS feed'); }
    if (result.rejected.length) this.context.logger.warn('rejected USGS rows', { count: result.rejected.length, sample: result.rejected.slice(0, 3).map((r) => r.reason) });
    return { observations: result.observations, cacheAgeMs: res.ageMs };
  }

  async historical(request: HistoricalProviderQuery): Promise<Observation[]> {
    const params = new URLSearchParams({ format: 'geojson', starttime: request.time.start, endtime: request.time.end, orderby: 'time', limit: String(Math.min(request.limit ?? 2000, 20_000)) });
    if (request.bounds) {
      params.set('minlatitude', String(request.bounds.south)); params.set('maxlatitude', String(request.bounds.north));
      params.set('minlongitude', String(request.bounds.west)); params.set('maxlongitude', String(request.bounds.east));
    }
    if (this.settings.minMagnitude !== undefined) params.set('minmagnitude', String(this.settings.minMagnitude));
    const url = `${USGS_FDSN_BASE}?${params.toString()}`;
    const res = await this.context.http.request({ url, signal: request.signal, maxBytes: MAX_FEED_BYTES, timeoutMs: 30_000, allowStale: false });
    let payload: unknown;
    try { payload = res.json(); } catch { throw new ProviderError('MALFORMED', 'USGS FDSN response is not valid JSON', { retryable: false }); }
    const result = normalizeUsgsFeed(payload, { receivedAt: new Date(this.context.clock.now()).toISOString(), hash: (s) => this.context.hash.sha256Hex(s), origin: 'historical', sourceRef: url });
    return result.observations;
  }
}

function parseSettings(raw: Record<string, unknown>): UsgsSettings {
  const out: UsgsSettings = {};
  const feed = raw['feed'];
  if (feed === 'hour' || feed === 'day' || feed === 'week' || feed === 'month') out.feed = feed;
  const min = raw['minMagnitude'];
  if (typeof min === 'number' && Number.isFinite(min) && min >= -5 && min <= 10) out.minMagnitude = min;
  return out;
}

export function createProvider(): UsgsEarthquakeProvider {
  return new UsgsEarthquakeProvider();
}
