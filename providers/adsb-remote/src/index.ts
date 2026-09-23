import { haversineMeters, type Observation } from '@worldview/world-model';
import {
  PollingProvider,
  ProviderError,
  assertAtomicAdmission,
  type ProviderContext,
  type ProviderHealth,
  type ProviderManifest,
  type ProviderQuery,
} from '@worldview/provider-sdk';
import { ADSB_LOL_API_BASE, ADSB_LOL_MANIFEST, pointQueryUrl } from './manifest.js';
import { CoveragePlanner, TYPE_KEEP_MS, typeQueryUrl } from './coverage.js';
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
export {
  CoveragePlanner,
  WIDE_COVERAGE_TYPES,
  POINT_EVERY,
  TYPE_KEEP_MS,
  TYPE_MIN_REFRESH_MS,
  typeQueryUrl,
} from './coverage.js';
export type { CoverageRequest } from './coverage.js';
export type { PointQuery, HomePosition } from './bounds.js';

/** Crowd-sourced ADS-B positions: nominal horizontal accuracy assumed for admission. */
const POSITION_ACCURACY_M = 100;
/** A type query answers a type's aircraft worldwide: two thousand A320s is ~2 MB. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** The last point query's answer stays in the snapshot this long while the view is wide. */
const POINT_KEEP_MS = 120_000;

export interface AdsbLolSettings {
  /** Query centre used when the runtime supplies no viewport bounds. */
  homePosition?: HomePosition;
}

interface CachedAnswer {
  url: string;
  observations: Observation[];
  fetchedAtMs: number;
}

/**
 * adsb.lol provider. Bounds-driven: the runtime passes the viewport, the provider derives a
 * centre + radius (≤ 250 nm) and asks for every aircraft there. A view wider than that also
 * gets the commonest types worldwide, one type a poll in turn (coverage.ts), so a zoomed-out
 * map shows the world's airliners rather than one disc of them. Without bounds it falls back
 * to `settings.homePosition`; without either it returns nothing and says so in health.
 *
 * Every poll returns everything still current — the last point answer, and each type's last
 * answer until it is ten minutes old — as one snapshot, so an aircraft that has gone from all
 * of them is gone from the map. Where the point answer is newer than a type's, an aircraft of
 * that type inside the point query's disc but not in its answer is dropped: the disc is
 * complete, and what it no longer has has landed or left.
 */
export class AdsbLolProvider extends PollingProvider {
  readonly manifest: ProviderManifest = ADSB_LOL_MANIFEST;
  private settings: AdsbLolSettings = {};
  private skippedReason: string | undefined;
  private lastQuery: PointQuery | undefined;
  private readonly planner: CoveragePlanner;
  private point: (CachedAnswer & { query: PointQuery }) | undefined;
  private readonly byType = new Map<string, CachedAnswer>();

  constructor(options: { types?: readonly string[] } = {}) {
    super();
    this.planner = new CoveragePlanner(options.types);
  }

  protected override async onInitialize(context: ProviderContext): Promise<void> {
    this.settings = parseSettings(await context.settings.get());
    context.settings.onChange((s) => {
      this.settings = parseSettings(s);
    });
  }

  /** The point query for a request, or undefined when no centre is known. */
  resolvePointQuery(request: Pick<ProviderQuery, 'bounds' | 'center'>): PointQuery | undefined {
    if (request.bounds) return pointQueryForBounds(request.bounds, undefined, request.center);
    const home = this.settings.homePosition;
    if (home) return { latitude: home.latitude, longitude: home.longitude, radiusNm: home.radiusNm, clipped: false };
    return undefined;
  }

  protected async fetchOnce(request: ProviderQuery): Promise<{ observations: Observation[]; cacheAgeMs?: number }> {
    if (request.signal.aborted) throw new ProviderError('CANCELLED', 'cancelled before request');
    const query = this.resolvePointQuery(request);
    const now = this.context.clock.now();
    const plan = this.planner.next(query, now);
    if (!query || !plan) {
      this.skippedReason = 'no viewport bounds and no homePosition setting; adsb.lol point query skipped';
      return { observations: [] };
    }
    this.skippedReason = undefined;
    this.lastQuery = query;
    let cacheAgeMs: number | undefined;
    if (plan.kind === 'point') {
      const url = pointQueryUrl(query.latitude, query.longitude, query.radiusNm);
      const answer = await this.fetchAircraft(url, request.signal, this.point);
      this.point = { ...answer.cached, query };
      cacheAgeMs = answer.ageMs;
      if (query.clipped)
        this.context.logger.debug('viewport exceeds adsb.lol radius cap; query clipped', { radiusNm: query.radiusNm });
    } else {
      const url = typeQueryUrl(ADSB_LOL_API_BASE, plan.type);
      let answer: Awaited<ReturnType<AdsbLolProvider['fetchAircraft']>>;
      try {
        answer = await this.fetchAircraft(url, request.signal, this.byType.get(plan.type));
      } catch (err) {
        this.planner.deferred(plan.type, now);
        throw err;
      }
      this.byType.set(plan.type, answer.cached);
      this.planner.record(plan.type, answer.cached.observations.length, now);
    }
    return { observations: this.snapshot(now), ...(cacheAgeMs !== undefined ? { cacheAgeMs } : {}) };
  }

  /**
   * One request, normalised. An answer served again unchanged (from the HTTP cache, or stale
   * while adsb.lol asks us to wait) returns the very observations it gave last time, so the
   * state engine sees nothing new instead of every aircraft in it re-admitted.
   */
  private async fetchAircraft(
    url: string,
    signal: AbortSignal,
    previous: CachedAnswer | undefined,
  ): Promise<{ cached: CachedAnswer; ageMs: number | undefined }> {
    const res = await this.context.http.request({
      url,
      signal,
      maxBytes: MAX_RESPONSE_BYTES,
      headers: { Accept: 'application/json' },
    });
    if ((res.fromCache || res.stale) && previous && previous.url === url) return { cached: previous, ageMs: res.ageMs };
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
    return {
      cached: { url, observations: result.observations, fetchedAtMs: this.context.clock.now() },
      ageMs: res.ageMs,
    };
  }

  /** Everything still current, one observation per aircraft (the newest report wins). */
  private snapshot(nowMs: number): Observation[] {
    const out = new Map<string, Observation>();
    const put = (o: Observation) => {
      const key = o.externalId ?? o.id;
      const had = out.get(key);
      if (!had || Date.parse(o.observedAt) > Date.parse(had.observedAt)) out.set(key, o);
    };
    const point = this.point && nowMs - this.point.fetchedAtMs <= POINT_KEEP_MS ? this.point : undefined;
    const discM = point ? point.query.radiusNm * 1852 : 0;
    for (const [type, answer] of this.byType) {
      if (nowMs - answer.fetchedAtMs > TYPE_KEEP_MS) {
        this.byType.delete(type);
        continue;
      }
      const inDisc = point && point.fetchedAtMs > answer.fetchedAtMs;
      for (const o of answer.observations) {
        if (inDisc && o.position && haversineMeters(o.position, point.query) < discM) continue;
        put(o);
      }
    }
    if (point) for (const o of point.observations) put(o);
    return [...out.values()];
  }

  override async health(): Promise<ProviderHealth> {
    const h = await super.health();
    if (this.skippedReason && !h.message) h.message = this.skippedReason;
    // Zoomed out past what one point query covers, say what the map does show.
    if (!h.message && !this.skippedReason && this.lastQuery?.clipped) {
      const now = this.context.clock.now();
      h.message = coverageNote(this.lastQuery.radiusNm, this.planner.summary(now));
    }
    return h;
  }

  /** Last point query issued (diagnostics). */
  get lastPointQuery(): PointQuery | undefined {
    return this.lastQuery;
  }
}

/** What the operator is told when the view is wider than one point query covers. */
export function coverageNote(
  radiusNm: number,
  wide: { types: number; oldestAgeMs: number | undefined } = { types: 0, oldestAgeMs: undefined },
): string {
  if (wide.types === 0)
    return `Aircraft within ${radiusNm} nm of the view centre; the commonest types worldwide are being fetched in turn.`;
  const oldest = wide.oldestAgeMs !== undefined ? Math.max(1, Math.round(wide.oldestAgeMs / 60_000)) : undefined;
  return (
    `Every aircraft within ${radiusNm} nm of the view centre, and ${wide.types} common airliner and business-jet types worldwide` +
    `${oldest !== undefined ? ` (each refreshed in turn; the oldest ${oldest} min ago)` : ''}. Zoom in for every aircraft elsewhere.`
  );
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
