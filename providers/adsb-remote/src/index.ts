import type { Observation } from '@worldview/world-model';
import {
  PollingProvider,
  ProviderError,
  assertAtomicAdmission,
  type ProviderContext,
  type ProviderHealth,
  type ProviderManifest,
  type ProviderQuery,
} from '@worldview/provider-sdk';
import { ADSB_LOL_MANIFEST, pointQueryUrl } from './manifest.js';
import { normalizeAircraftRows, parseAdsbLolResponse } from './normalize.js';
import { parseHomePosition, pointQueryForBounds, type HomePosition, type PointQuery } from './bounds.js';

export { ADSB_LOL_MANIFEST, ADSB_LOL_API_BASE, ADSB_LOL_MAX_RADIUS_NM, pointQueryUrl } from './manifest.js';
export {
  normalizeAircraftRows,
  aircraftRowToDraft,
  parseAdsbLolResponse,
  STALE_POSITION_SECONDS,
} from './normalize.js';
export type { AircraftNormalizeOptions, AircraftNormalizeResult } from './normalize.js';
export { pointQueryForBounds, parseHomePosition } from './bounds.js';
export type { PointQuery, HomePosition } from './bounds.js';

/** Crowd-sourced ADS-B positions: nominal horizontal accuracy assumed for admission. */
const POSITION_ACCURACY_M = 100;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface AdsbLolSettings {
  /** Query centre used when the runtime supplies no viewport bounds. */
  homePosition?: HomePosition;
}

/**
 * adsb.lol point-query provider. Bounds-driven: the runtime passes the viewport, the
 * provider derives a centre + radius (≤ 250 nm). Without bounds it falls back to
 * `settings.homePosition`; without either it returns nothing and says so in health.
 */
export class AdsbLolProvider extends PollingProvider {
  readonly manifest: ProviderManifest = ADSB_LOL_MANIFEST;
  private settings: AdsbLolSettings = {};
  private skippedReason: string | undefined;
  private lastQuery: PointQuery | undefined;

  protected override async onInitialize(context: ProviderContext): Promise<void> {
    this.settings = parseSettings(await context.settings.get());
    context.settings.onChange((s) => {
      this.settings = parseSettings(s);
    });
  }

  /** The point query for a request, or undefined when no centre is known. */
  resolvePointQuery(request: Pick<ProviderQuery, 'bounds'>): PointQuery | undefined {
    if (request.bounds) return pointQueryForBounds(request.bounds);
    const home = this.settings.homePosition;
    if (home) return { latitude: home.latitude, longitude: home.longitude, radiusNm: home.radiusNm, clipped: false };
    return undefined;
  }

  protected async fetchOnce(request: ProviderQuery): Promise<{ observations: Observation[]; cacheAgeMs?: number }> {
    if (request.signal.aborted) throw new ProviderError('CANCELLED', 'cancelled before request');
    const query = this.resolvePointQuery(request);
    if (!query) {
      this.skippedReason = 'no viewport bounds and no homePosition setting; adsb.lol point query skipped';
      return { observations: [] };
    }
    this.skippedReason = undefined;
    this.lastQuery = query;
    const url = pointQueryUrl(query.latitude, query.longitude, query.radiusNm);
    const res = await this.context.http.request({
      url,
      signal: request.signal,
      maxBytes: MAX_RESPONSE_BYTES,
      headers: { Accept: 'application/json' },
    });
    let payload: unknown;
    try {
      payload = res.json();
    } catch {
      res.invalidate();
      throw new ProviderError('MALFORMED', 'adsb.lol response is not valid JSON', { retryable: false });
    }
    const parsed = parseAdsbLolResponse(payload);
    if (typeof parsed === 'string') {
      res.invalidate();
      throw new ProviderError('MALFORMED', `adsb.lol ${parsed}`, { retryable: false });
    }
    const receivedAt = new Date(this.context.clock.now()).toISOString();
    const result = normalizeAircraftRows(parsed.rows, this.manifest, {
      nowMs: parsed.nowMs,
      receivedAt,
      sourceQuality: 'crowdsourced',
      positionAccuracyM: POSITION_ACCURACY_M,
      origin: res.stale || res.fromCache ? 'cached' : 'live',
      sourceRef: url,
      hash: (s) => this.context.hash.sha256Hex(s),
    });
    // Rows without a position are expected (Mode S only); the feed is malformed only when
    // every row is unusable for a reason other than a missing position.
    const hard = result.rejected.filter((r) => r.reason !== 'missing position').length;
    if (result.total > 0 && result.observations.length === 0 && hard === result.total) {
      res.invalidate();
      assertAtomicAdmission(result.total, 0, 'adsb.lol feed');
    }
    if (hard)
      this.context.logger.warn('rejected adsb.lol rows', {
        count: hard,
        sample: result.rejected
          .filter((r) => r.reason !== 'missing position')
          .slice(0, 3)
          .map((r) => r.reason),
      });
    if (query.clipped)
      this.context.logger.debug('viewport exceeds adsb.lol radius cap; query clipped', { radiusNm: query.radiusNm });
    return { observations: result.observations, cacheAgeMs: res.ageMs };
  }

  override async health(): Promise<ProviderHealth> {
    const h = await super.health();
    if (this.skippedReason && !h.message) h.message = this.skippedReason;
    return h;
  }

  /** Last point query issued (diagnostics). */
  get lastPointQuery(): PointQuery | undefined {
    return this.lastQuery;
  }
}

function parseSettings(raw: Record<string, unknown>): AdsbLolSettings {
  const out: AdsbLolSettings = {};
  const home = parseHomePosition(raw['homePosition'] as Parameters<typeof parseHomePosition>[0]);
  if (home) out.homePosition = home;
  return out;
}

export function createProvider(): AdsbLolProvider {
  return new AdsbLolProvider();
}
