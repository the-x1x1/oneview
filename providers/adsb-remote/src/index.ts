import type { GeoBounds, Observation } from '@worldview/world-model';
import {
  PollingProvider,
  ProviderError,
  assertAtomicAdmission,
  type FlightRouteAnswer,
  type FlightRouteRequest,
  type FlightRouteSource,
  type ObjectTrackAnswer,
  type ObjectTrackRequest,
  type ObjectTrackSource,
  type ProviderContext,
  type ProviderHealth,
  type ProviderManifest,
  type ProviderQuery,
} from '@worldview/provider-sdk';
import { ADSB_LOL_API_BASE, ADSB_LOL_MANIFEST, pointQueryUrl } from './manifest.js';
import {
  CIRCLE_KEEP_MS,
  CoveragePlanner,
  MAX_CIRCLES,
  TYPE_KEEP_MS,
  militaryQueryUrl,
  typeQueryUrl,
  type CircleView,
} from './coverage.js';
import { RequestBudget, type BudgetSummary } from './budget.js';
import { tileContains, tilesForBounds, type Tile } from './tiles.js';
import { normalizeAircraftRows, parseAdsbLolResponse } from './normalize.js';
import { parseTrace, traceUrl } from './trace.js';
import { ROUTESET_URL, ROUTES_ATTRIBUTION, flightCallsign, parseRouteset, routesetBody } from './routes.js';
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
  MAX_CIRCLES,
  CIRCLE_KEEP_MS,
  CIRCLE_MIN_REFRESH_MS,
  CENTRE_WEIGHT,
  WIDE_COVERAGE_TYPES,
  POINT_EVERY,
  TYPE_KEEP_MS,
  TYPE_MIN_REFRESH_MS,
  MIL_REFRESH_MS,
  typeQueryUrl,
  militaryQueryUrl,
} from './coverage.js';
export { traceUrl, parseTrace, thin, ADSB_LOL_TRACE_HOST } from './trace.js';
export type { TraceParseOptions } from './trace.js';
export {
  ROUTESET_URL,
  ROUTES_LABEL,
  ROUTES_ATTRIBUTION,
  flightCallsign,
  parseRouteset,
  routesetBody,
} from './routes.js';
export type { CoverageRequest, CircleView } from './coverage.js';
export {
  RequestBudget,
  START_PER_MIN,
  MIN_PER_MIN,
  MAX_PER_MIN,
  INCREASE_PER_SUCCESS,
  CEILING_APPROACH,
  CEILING_INCREASE_FACTOR,
  CEILING_MEMORY_MS,
  TOKEN_CAPACITY,
  MAX_DEBT,
} from './budget.js';
export type { BudgetSummary } from './budget.js';
export {
  tilesForBounds,
  tileContains,
  priorAircraft,
  TRAFFIC_PRIOR,
  PRIOR_BASELINE,
  DESIGN_RADIUS_NM,
} from './tiles.js';
export type { Tile } from './tiles.js';
export type { PointQuery, HomePosition } from './bounds.js';

/** Crowd-sourced ADS-B positions: nominal horizontal accuracy assumed for admission. */
const POSITION_ACCURACY_M = 100;
/** A type query answers a type's aircraft worldwide: two thousand A320s is ~2 MB. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
/** The last point query's answer stays in the snapshot this long after the view has widened. */
const POINT_KEEP_MS = 120_000;
/**
 * A selected aircraft's adsb.lol trace (trace.ts): at most this big (a day of a long-haul
 * flight is ~1–2 MB), this slow, this many points once thinned, and asked for again no
 * sooner than this — switching the track window or reselecting is answered from memory.
 */
const TRACE_MAX_BYTES = 4 * 1024 * 1024;
const TRACE_TIMEOUT_MS = 8_000;
const TRACE_MAX_POINTS = 2_000;
const TRACE_CACHE_MS = 60_000;
const TRACE_CACHE_ENTRIES = 16;
/**
 * A selected flight's planned route (routes.ts): one plane per request, a small answer, and
 * remembered per callsign for half an hour — a route is a schedule and does not change
 * during a flight — or for a minute when the lookup failed, so a reselection does not ask
 * again at once.
 */
const ROUTE_MAX_BYTES = 64 * 1024;
const ROUTE_TIMEOUT_MS = 8_000;
const ROUTE_CACHE_MS = 30 * 60_000;
const ROUTE_FAILURE_CACHE_MS = 60_000;
/** The longest local pacing pause a route lookup waits out before its one retry. */
const ROUTE_RETRY_MAX_WAIT_MS = 6_000;
const ROUTE_CACHE_ENTRIES = 64;

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
 * centre + radius (≤ 250 nm) and asks for every aircraft there. A regional or continental
 * view is covered by 250 nm circles on a fixed grid (tiles.ts), one circle a poll, busiest
 * and nearest the centre first; a view wider still gets the commonest types worldwide and
 * the military list in turn (coverage.ts), so a zoomed-out map shows the world's airliners
 * rather than one disc of them. Without bounds it falls back to `settings.homePosition`;
 * without either it returns nothing and says so in health.
 *
 * Whether a poll asks adsb.lol anything at all is the request budget's call (budget.ts):
 * it adapts to adsb.lol's unpublished, load-dependent limit, and a selected aircraft's route
 * or trace goes ahead of the polls. A poll the budget holds back answers from memory.
 *
 * Every poll returns everything still current — the last point answer, each circle's and
 * each type's last answer until it is ten minutes old — as one snapshot, so an aircraft that
 * has gone from all of them is gone from the map. A point or circle answer is complete for
 * its disc: an aircraft that an older answer (a type's, or an overlapping circle's) puts
 * inside a newer disc, but that the newer disc's answer does not have, has landed or left,
 * and is dropped.
 */
export class AdsbLolProvider extends PollingProvider implements ObjectTrackSource, FlightRouteSource {
  readonly manifest: ProviderManifest = ADSB_LOL_MANIFEST;
  private settings: AdsbLolSettings = {};
  private skippedReason: string | undefined;
  private lastQuery: PointQuery | undefined;
  private readonly planner: CoveragePlanner;
  private readonly budget: RequestBudget;
  private point: (CachedAnswer & { query: PointQuery }) | undefined;
  /** Each grid circle's last answer (tiles.ts), by tile id. */
  private readonly byCircle = new Map<string, CachedAnswer & { tile: Tile }>();
  /** The circles over the last view that was covered circle by circle. */
  private lastCircles: CircleView | undefined;
  private readonly byType = new Map<string, CachedAnswer>();
  /** The worldwide military list's last answer (`/v2/mil`), kept like a type's. */
  private military: CachedAnswer | undefined;
  /** Recently fetched traces by ICAO address; `points` undefined when there was none. */
  private readonly traces = new Map<string, { atMs: number; points: ObjectTrackAnswer['points'] | undefined }>();
  /** Recently looked-up routes by callsign; `answer` undefined when the lookup failed. */
  private readonly routes = new Map<string, { atMs: number; answer: FlightRouteAnswer | undefined }>();

  /**
   * `pacing: false` sends a request on every poll whatever the budget says — for the
   * provider contract checklist, which queries many times in a row on a clock that does not
   * move and expects each query to reach the (fixture) network. The app never sets it.
   */
  constructor(options: { types?: readonly string[]; pacing?: boolean } = {}) {
    super();
    this.planner = new CoveragePlanner(options.types);
    this.budget = new RequestBudget({ enabled: options.pacing !== false });
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
    if (!query) {
      this.skippedReason = 'no viewport bounds and no homePosition setting; adsb.lol point query skipped';
      return { observations: [] };
    }
    this.skippedReason = undefined;
    this.lastQuery = query;
    const circles = query.clipped ? circleView(request.bounds, request.center, query) : undefined;
    this.lastCircles = circles;
    // Nothing is due, or adsb.lol may not be asked yet: what is already held still stands.
    const plan = this.budget.mayPoll(now) ? this.planner.next(query, now, circles) : undefined;
    if (!plan) return this.fromMemory(now);
    let cacheAgeMs: number | undefined;
    if (plan.kind === 'point') {
      const url = pointQueryUrl(query.latitude, query.longitude, query.radiusNm);
      const answer = await this.send(url, request.signal, this.point);
      this.point = { ...answer.cached, query };
      cacheAgeMs = answer.ageMs;
    } else if (plan.kind === 'circle') {
      const { tile } = plan;
      const url = pointQueryUrl(tile.latitude, tile.longitude, tile.radiusNm);
      let answer: Awaited<ReturnType<AdsbLolProvider['send']>>;
      try {
        answer = await this.send(url, request.signal, this.byCircle.get(tile.id));
      } catch (err) {
        this.planner.deferredCircle(tile.id, now);
        throw err;
      }
      this.byCircle.set(tile.id, { ...answer.cached, tile });
      this.planner.recordCircle(tile.id, answer.cached.observations.length, now);
    } else if (plan.kind === 'mil') {
      const url = militaryQueryUrl(ADSB_LOL_API_BASE);
      let answer: Awaited<ReturnType<AdsbLolProvider['send']>>;
      try {
        answer = await this.send(url, request.signal, this.military, true);
      } catch (err) {
        this.planner.deferredMilitary(now);
        throw err;
      }
      this.military = answer.cached;
      this.planner.recordMilitary(answer.cached.observations.length, now);
    } else {
      const url = typeQueryUrl(ADSB_LOL_API_BASE, plan.type);
      let answer: Awaited<ReturnType<AdsbLolProvider['send']>>;
      try {
        answer = await this.send(url, request.signal, this.byType.get(plan.type));
      } catch (err) {
        this.planner.deferred(plan.type, now);
        throw err;
      }
      this.byType.set(plan.type, answer.cached);
      this.planner.record(plan.type, answer.cached.observations.length, now);
    }
    return { observations: this.snapshot(now), ...(cacheAgeMs !== undefined ? { cacheAgeMs } : {}) };
  }

  /** A poll that asks nothing: the current snapshot, aged by its newest answer. */
  private fromMemory(nowMs: number): { observations: Observation[]; cacheAgeMs?: number } {
    const observations = this.snapshot(nowMs);
    let newest: number | undefined;
    const lists: Array<CachedAnswer | undefined> = [this.point, this.military, ...this.byCircle.values()];
    for (const a of [...lists, ...this.byType.values()])
      if (a && (newest === undefined || a.fetchedAtMs > newest)) newest = a.fetchedAtMs;
    return { observations, ...(newest !== undefined ? { cacheAgeMs: Math.max(0, nowMs - newest) } : {}) };
  }

  /**
   * One position request through the budget: it takes a token, an answer lets the budget
   * creep up, and a refusal for rate (adsb.lol's 429, or the host's pacing after one) sets
   * it back and is thrown on, so the poll fails as RATE_LIMITED and Source Health says so.
   * Never answered from the host's stale cache: a stale body would hide the 429 the budget
   * has to see, and the provider keeps every answer it needs itself.
   */
  private async send(
    url: string,
    signal: AbortSignal,
    previous: CachedAnswer | undefined,
    listedMilitary = false,
  ): Promise<{ cached: CachedAnswer; ageMs: number | undefined }> {
    this.budget.sending(this.context.clock.now());
    let answer: { cached: CachedAnswer; ageMs: number | undefined };
    try {
      answer = await this.fetchAircraft(url, signal, previous, listedMilitary);
    } catch (err) {
      this.noteRefusal(err);
      throw err;
    }
    this.budget.answered(this.context.clock.now());
    return answer;
  }

  /** Tells the budget about a refusal for rate; anything else is not its business. */
  private noteRefusal(err: unknown): void {
    if (!(err instanceof ProviderError) || err.code !== 'RATE_LIMITED') return;
    const before = this.budget.perMinute;
    this.budget.refused(this.context.clock.now(), err.httpStatus === 429, err.retryAfterMs);
    if (this.budget.perMinute !== before)
      this.context.logger.info('adsb.lol answered 429; request budget lowered', {
        perMinute: round1(this.budget.perMinute),
        wasPerMinute: round1(before),
        retryAfterMs: err.retryAfterMs ?? null,
      });
  }

  /**
   * A foreground lookup (a selected aircraft's route or trace): it goes now, whatever the
   * budget has left, and the polls wait until it has finished (budget.ts).
   */
  private async foreground<T>(run: () => Promise<T>): Promise<T> {
    this.budget.beginForeground();
    try {
      return await run();
    } finally {
      this.budget.endForeground();
    }
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
    listedMilitary = false,
  ): Promise<{ cached: CachedAnswer; ageMs: number | undefined }> {
    const res = await this.context.http.request({
      url,
      signal,
      maxBytes: MAX_RESPONSE_BYTES,
      allowStale: false,
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
    // The military list's rows are military by adsb.lol's database whatever a row's own
    // `dbFlags` says (a row without the field reads as civil). Tagged here rather than in
    // normalize.ts, whose row rules readsb-local keeps a byte-identical copy of.
    if (listedMilitary)
      result.observations = result.observations.map((o) =>
        o.payload['military'] === true ? o : { ...o, payload: { ...o.payload, military: true } },
      );
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
    if (this.point && nowMs - this.point.fetchedAtMs > POINT_KEEP_MS) this.point = undefined;
    if (this.military && nowMs - this.military.fetchedAtMs > TYPE_KEEP_MS) this.military = undefined;
    for (const [type, answer] of this.byType) if (nowMs - answer.fetchedAtMs > TYPE_KEEP_MS) this.byType.delete(type);
    for (const [id, answer] of this.byCircle) if (nowMs - answer.fetchedAtMs > CIRCLE_KEEP_MS) this.byCircle.delete(id);
    // Every answer that is complete for a disc: the point query's and each circle's.
    const discs: Array<{ answer: CachedAnswer; disc: { latitude: number; longitude: number; radiusNm: number } }> = [];
    if (this.point) discs.push({ answer: this.point, disc: this.point.query });
    for (const c of this.byCircle.values()) discs.push({ answer: c, disc: c.tile });
    const lists: CachedAnswer[] = [...this.byType.values()];
    if (this.military) lists.push(this.military);
    for (const d of discs) lists.push(d.answer);
    for (const answer of lists) {
      const newer = discs.filter((d) => d.answer !== answer && d.answer.fetchedAtMs > answer.fetchedAtMs);
      for (const o of answer.observations) {
        const p = o.position;
        if (p && newer.length && newer.some((d) => tileContains(d.disc, p))) continue;
        put(o);
      }
    }
    return [...out.values()];
  }

  /**
   * adsb.lol's recent history of the selected aircraft (trace.ts), for the host's
   * `objectTrack` (provider-sdk object-track.ts). Only ICAO addresses; one request per
   * aircraft a minute at most — a failure is remembered as briefly as an answer, so a
   * missing trace is not asked for on every window change.
   */
  async objectTrack(request: ObjectTrackRequest): Promise<ObjectTrackAnswer | undefined> {
    if (request.objectType !== 'aircraft') return undefined;
    const icao = request.properties['icao24'];
    const hex = typeof icao === 'string' ? icao : request.externalId;
    const url = hex ? traceUrl(hex) : undefined;
    if (!hex || !url) return undefined;
    const key = hex.toLowerCase();
    const now = this.context.clock.now();
    let entry = this.traces.get(key);
    if (!entry || now - entry.atMs > TRACE_CACHE_MS) {
      entry = { atMs: now, points: await this.foreground(() => this.fetchTrace(url, key, request.signal)) };
      this.traces.delete(key);
      this.traces.set(key, entry);
      while (this.traces.size > TRACE_CACHE_ENTRIES) this.traces.delete(this.traces.keys().next().value!);
    }
    if (!entry.points) return undefined;
    const from = Date.parse(request.time.start);
    const to = Date.parse(request.time.end);
    const points = entry.points.filter((p) => {
      const t = Date.parse(p.observedAt);
      return t >= from && t <= to;
    });
    if (!points.length) return undefined;
    return { kind: 'history', label: 'adsb.lol history', attribution: this.manifest.attribution.text, points };
  }

  private async fetchTrace(
    url: string,
    hex: string,
    signal: AbortSignal,
  ): Promise<ObjectTrackAnswer['points'] | undefined> {
    try {
      this.budget.sending(this.context.clock.now());
      const res = await this.context.http.request({
        url,
        signal,
        maxBytes: TRACE_MAX_BYTES,
        timeoutMs: TRACE_TIMEOUT_MS,
        allowStale: false,
        headers: { Accept: 'application/json' },
      });
      let payload: unknown;
      try {
        payload = res.json();
      } finally {
        // One aircraft's day, asked for once: kept here (`traces`) for a minute, never in
        // the HTTP client's response cache, where a day of traces would sit for good.
        res.invalidate();
      }
      const now = this.context.clock.now();
      const parsed = parseTrace(payload, { fromMs: now - 26 * 3600_000, toMs: now, maxPoints: TRACE_MAX_POINTS, hex });
      if (typeof parsed === 'string') {
        this.context.logger.debug('adsb.lol trace unusable', { hex, reason: parsed });
        return undefined;
      }
      return parsed;
    } catch (err) {
      this.noteRefusal(err);
      this.context.logger.debug('adsb.lol trace unavailable', {
        hex,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  /**
   * The planned route of the selected aircraft's flight, from adsb.lol's routeset API
   * (routes.ts), for the host's `flightRoute` (provider-sdk flight-route.ts). Only callsigns
   * shaped like an airline flight; one request per callsign per half hour at most (a failure
   * is remembered for a minute). An answer with no airports is adsb.lol saying it does not
   * know the callsign.
   */
  async flightRoute(request: FlightRouteRequest): Promise<FlightRouteAnswer | undefined> {
    const callsign = flightCallsign(request.callsign);
    if (!callsign) return undefined;
    const now = this.context.clock.now();
    const had = this.routes.get(callsign);
    if (had && now - had.atMs <= (had.answer ? ROUTE_CACHE_MS : ROUTE_FAILURE_CACHE_MS)) return had.answer;
    const answer = await this.foreground(() => this.fetchRoute(callsign, request));
    this.routes.delete(callsign);
    this.routes.set(callsign, { atMs: now, answer });
    while (this.routes.size > ROUTE_CACHE_ENTRIES) this.routes.delete(this.routes.keys().next().value!);
    return answer;
  }

  /**
   * Waits before the one retry of a route lookup (tests replace it). The lookup shares the
   * provider's adsb.lol budget with the position polls, and the host paces the whole host for
   * a few seconds after a 429 — so on the laptop nearly every first lookup was refused
   * locally and the panel said "Unavailable". The request budget now keeps the polls from
   * drawing those 429s and holds them back while a lookup (and this wait) is in progress.
   */
  routeRetryWait: (ms: number, signal?: AbortSignal) => Promise<void> = (ms, signal) =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(t);
        resolve();
      });
    });

  private async fetchRoute(callsign: string, request: FlightRouteRequest): Promise<FlightRouteAnswer | undefined> {
    for (let attempt = 0; ; attempt++) {
      try {
        this.budget.sending(this.context.clock.now());
        const answer = await this.fetchRouteOnce(callsign, request);
        this.budget.answered(this.context.clock.now());
        return answer;
      } catch (err) {
        this.noteRefusal(err);
        const wait = err instanceof ProviderError && err.code === 'RATE_LIMITED' ? err.retryAfterMs : undefined;
        if (attempt === 0 && wait !== undefined && wait <= ROUTE_RETRY_MAX_WAIT_MS && !request.signal?.aborted) {
          await this.routeRetryWait(Math.max(250, wait), request.signal);
          continue;
        }
        this.context.logger.info('adsb.lol route unavailable', {
          callsign,
          error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      }
    }
  }

  private async fetchRouteOnce(callsign: string, request: FlightRouteRequest): Promise<FlightRouteAnswer | undefined> {
    const res = await this.context.http.request({
      url: ROUTESET_URL,
      method: 'POST',
      body: routesetBody(callsign, request.position),
      signal: request.signal,
      maxBytes: ROUTE_MAX_BYTES,
      timeoutMs: ROUTE_TIMEOUT_MS,
      allowStale: false,
      // Per callsign: the network layer coalesces requests by this key, and two selections
      // in quick succession must not be answered with each other's route.
      cacheKey: `POST ${ROUTESET_URL} ${callsign}`,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    });
    let payload: unknown;
    try {
      payload = res.json();
    } finally {
      res.invalidate();
    }
    const parsed = parseRouteset(payload, callsign, {
      attribution: ROUTES_ATTRIBUTION,
      positionSent: request.position !== undefined,
    });
    if (typeof parsed === 'string') {
      this.context.logger.info('adsb.lol route unusable', { callsign, reason: parsed });
      return undefined;
    }
    return parsed;
  }

  override async health(): Promise<ProviderHealth> {
    const h = await super.health();
    if (this.skippedReason && !h.message) h.message = this.skippedReason;
    const now = this.context.clock.now();
    const budget = this.budget.summary(now);
    // Zoomed out past what one point query covers, say what the map does show.
    if (!h.message && !this.skippedReason && this.lastQuery?.clipped) {
      h.message = this.lastCircles
        ? circleNote(this.planner.circleSummary(this.lastCircles.tiles, now), budget)
        : coverageNote(this.lastQuery.radiusNm, this.planner.summary(now));
    }
    const pause = pauseNote(budget);
    if (pause) h.message = h.message ? `${h.message} ${pause}` : pause;
    return h;
  }

  /** The request budget's state (diagnostics, tests). */
  budgetSummary(): BudgetSummary {
    return this.budget.summary(this.context.clock.now());
  }

  /** Last point query issued (diagnostics). */
  get lastPointQuery(): PointQuery | undefined {
    return this.lastQuery;
  }
}

/** What the operator is told when the view is wider than one point query covers. */
export function coverageNote(
  radiusNm: number,
  wide: { types: number; oldestAgeMs: number | undefined; military?: boolean } = {
    types: 0,
    oldestAgeMs: undefined,
  },
): string {
  const mil = wide.military ? ', military aircraft worldwide' : '';
  if (wide.types === 0)
    return `Aircraft within ${radiusNm} nm of the view centre${mil}; the commonest types worldwide are being fetched in turn.`;
  const oldest = wide.oldestAgeMs !== undefined ? Math.max(1, Math.round(wide.oldestAgeMs / 60_000)) : undefined;
  return (
    `Every aircraft within ${radiusNm} nm of the view centre${mil}, and ${wide.types} common airliner and business-jet types worldwide` +
    `${oldest !== undefined ? ` (each refreshed in turn; the oldest ${oldest} min ago)` : ''}. Zoom in for every aircraft elsewhere.`
  );
}

/**
 * What the operator is told about a view covered circle by circle: how many circles, how
 * many have answered and how recently, and how long a full pass takes at the current budget.
 */
export function circleNote(
  c: { circles: number; answered: number; recent: number; oldestAgeMs: number | undefined },
  budget: Pick<BudgetSummary, 'perMinute'>,
): string {
  const rate = round1(budget.perMinute);
  const pass = Math.max(1, Math.ceil(c.circles / Math.max(0.1, budget.perMinute)));
  const oldest =
    c.oldestAgeMs !== undefined && c.answered > 0
      ? `, the oldest ${Math.max(1, Math.round(c.oldestAgeMs / 60_000))} min ago`
      : '';
  return (
    `Every aircraft over the view, from ${c.circles} circles of 250 nm asked for in turn, busiest first: ` +
    `${c.answered} answered, ${c.recent} in the last 2 min${oldest}. ` +
    `adsb.lol is asked ${rate} times a minute, so one pass over every circle takes about ${pass} min; ` +
    `the busiest circles are refreshed more often than the empty ones.`
  );
}

/** Said while adsb.lol's own Retry-After holds the polls back. */
export function pauseNote(budget: Pick<BudgetSummary, 'waitMs' | 'perMinute'>): string | undefined {
  if (budget.waitMs <= 0) return undefined;
  return `adsb.lol asked for a pause: next request in ${Math.ceil(budget.waitMs / 1000)} s, then ${round1(budget.perMinute)} a minute.`;
}

/** The circles over a view wider than one point query, or undefined when there are too many. */
function circleView(
  bounds: GeoBounds | undefined,
  center: { latitude: number; longitude: number } | undefined,
  query: PointQuery,
): CircleView | undefined {
  if (!bounds) return undefined;
  const tiles = tilesForBounds(bounds, MAX_CIRCLES);
  if (!tiles?.length) return undefined;
  return { tiles, centre: center ?? { latitude: query.latitude, longitude: query.longitude } };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function parseSettings(raw: Record<string, unknown>): AdsbLolSettings {
  const out: AdsbLolSettings = {};
  const home = parseHomePosition(raw['homePosition'] as Parameters<typeof parseHomePosition>[0]);
  if (home) out.homePosition = home;
  return out;
}

export function createProvider(options: { pacing?: boolean } = {}): AdsbLolProvider {
  return new AdsbLolProvider(options);
}
