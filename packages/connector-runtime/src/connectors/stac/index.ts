import type { JsonValue, Observation } from '@worldview/world-model';
import {
  PollingProvider,
  ProviderError,
  assertAtomicAdmission,
  type ProviderContext,
  type ProviderHealth,
  type ProviderHttpRequest,
  type ProviderHttpResponse,
  type ProviderManifest,
  type ProviderQuery,
  type ProviderSettingDefinition,
} from '@worldview/provider-sdk';
import {
  OBJECT_TYPE_VALUES,
  compileMapping,
  definitionToManifest,
  mapRecords,
  type CompiledMapping,
  type Connector,
  type ConnectorProviderDefinition,
  type ConnectorValidationResult,
  type MappingSpec,
} from '@worldview/connector-sdk';
import { isRecord, itemRecord } from './items.js';
import {
  DAY_MS,
  MAX_WINDOW_MS,
  MIN_WINDOW_MS,
  SEARCH_PARAMETERS,
  datetimeSpec,
  firstRequest,
  nextRequest,
  requestKey,
  searchBody,
  searchParameters,
  stacMode,
  viewBoxes,
  windowInterval,
  type DatetimeSpec,
  type SearchRequest,
  type StacMode,
} from './search.js';
import {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_DOCUMENTS,
  MAX_DEPTH_LIMIT,
  walkStaticCatalog,
  type WalkItem,
} from './static.js';

export * from './items.js';
export * from './search.js';
export * from './static.js';

/**
 * STAC (SpatioTemporal Asset Catalog): satellite and aerial imagery footprints — what was
 * captured where and when — from a STAC API's item search or a static catalogue, as objects
 * in the world. Not the imagery: an item becomes an observation at the centre of its bbox,
 * with its footprint as geometry and its time, collection, platform, cloud cover, ground
 * sample distance, thumbnail and asset keys as payload.
 *
 * Mode by endpoint: a path ending in `/search` is an item search (POST, falling back to GET
 * when the server answers 405; `bbox` from the view with `boundsQuery`; `datetime` a rolling
 * window; `links[rel=next]` paging, GET or POST with body/merge, on the endpoint's origin,
 * up to `pagination.maxPages`). Anything else is a static catalogue walked through its
 * `child`/`item` links to a depth cap and a document budget (`pagination.maxPages`).
 *
 * Object type: there is no `imagery-scene` in the world model yet (an ADR-002 amendment is
 * requested, docs/roadmap/phases/stac.md). Until it lands, items are `place` objects with
 * `payload.kind = "imagery-scene"`; the connector fills that literal in when a definition
 * leaves `kind` out. Everything reaches the network through `ProviderContext.http`.
 */
export const STAC_CONNECTOR_ID = 'stac';
export const IMAGERY_SCENE_KIND = 'imagery-scene';
export const DEFAULT_STAC_INTERVAL_SECONDS = 900;
export const DEFAULT_SEARCH_PAGES = 5;
export const WINDOW_SETTING = 'windowDays';
export const DEPTH_SETTING = 'maxDepth';
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
/** What the definition may name as its object type: a scene, as a place until the world model has its own type. */
const SCENE_TYPES: readonly string[] = [IMAGERY_SCENE_KIND, 'place'];

/** The definition with the connector's defaults filled in where it left them out. */
export function withStacDefaults(d: ConnectorProviderDefinition): ConnectorProviderDefinition {
  const mode = d.endpoint ? stacMode(d.endpoint.url) : 'search';
  const mapping: MappingSpec = { ...d.mapping };
  if (!mapping.observedAt) mapping.observedAt = { path: 'properties.datetime', fallback: 'properties.start_datetime' };
  if (!mapping.position) mapping.position = { lonLat: '_stac.centroid', altitude: false };
  if (!mapping.geometry) mapping.geometry = 'geometry';
  if (d.objectType !== IMAGERY_SCENE_KIND && !mapping.properties?.['kind'])
    mapping.properties = { kind: { literal: IMAGERY_SCENE_KIND }, ...(mapping.properties ?? {}) };
  const out: ConnectorProviderDefinition = {
    ...d,
    mapping,
    pagination: d.pagination ?? {
      strategy: 'next-link',
      nextLinkPath: 'links',
      maxPages: mode === 'search' ? DEFAULT_SEARCH_PAGES : DEFAULT_MAX_DOCUMENTS,
    },
  };
  if (d.endpoint)
    out.endpoint = { ...d.endpoint, intervalSeconds: d.endpoint.intervalSeconds ?? DEFAULT_STAC_INTERVAL_SECONDS };
  return out;
}

function pagesOf(d: ConnectorProviderDefinition): number {
  const p = d.pagination;
  if (!p || p.strategy !== 'next-link') return 1;
  return p.maxPages ?? 10;
}

function windowDaysLabel(ms: number): string {
  if (ms % DAY_MS === 0) return `${ms / DAY_MS} day${ms === DAY_MS ? '' : 's'}`;
  return `${Math.round(ms / 3_600_000)} hours`;
}

/** The manifest: the SDK's, with a request budget that covers a whole poll and the connector's settings. */
export function stacManifest(d: ConnectorProviderDefinition): ProviderManifest {
  const mode = stacMode(d.endpoint!.url);
  const manifest = definitionToManifest(d, mode === 'search' ? 'STAC item search' : 'STAC static catalogue');
  // A poll is a burst: every page (both halves of a view across the antimeridian, plus the
  // GET retry after a 405) or every document of a walk goes out within the same minute. The
  // SDK's rate is the average over the interval, which for a 15-minute cadence is 4 a minute
  // — fewer than one poll sends. Cover two polls' burst, so a retry does not trip it.
  const perPoll = mode === 'search' ? 2 * pagesOf(d) + 1 : pagesOf(d) + 1;
  manifest.refreshPolicy.maxRequestsPerMinute = Math.max(manifest.refreshPolicy.maxRequestsPerMinute, 2 * perPoll + 1);
  const settings: ProviderSettingDefinition[] = [...(d.settings ?? [])];
  const has = (key: string) => settings.some((s) => s.key === key);
  const dt = mode === 'search' ? datetimeSpec(d) : undefined;
  if (dt && 'rolling' in dt && !has(WINDOW_SETTING))
    settings.push({
      key: WINDOW_SETTING,
      label: 'Time window (days)',
      description: 'Scenes captured this many days back from now are searched for.',
      kind: 'number',
      min: 1,
      max: 366,
      step: 1,
      defaultLabel: windowDaysLabel(dt.rolling),
    });
  if (mode === 'static' && !has(DEPTH_SETTING))
    settings.push({
      key: DEPTH_SETTING,
      label: 'Catalogue depth',
      description: 'How many links deep the catalogue is followed from its root.',
      kind: 'number',
      min: 1,
      max: MAX_DEPTH_LIMIT,
      step: 1,
      defaultLabel: `${DEFAULT_MAX_DEPTH} levels`,
    });
  if (settings.length) manifest.settings = settings.slice(0, 24);
  return manifest;
}

interface FetchStats {
  rejected: number;
  filtered: number;
  simplified: number;
  dropped: number;
  /** Paging stopped at maxPages while the source still had a next page. */
  truncated: boolean;
  /** Links not followed, and why. */
  refused: string[];
  walk?: { documents: number; skipped: number; depth: number; budget: number; offOrigin: number };
}

export class StacProvider extends PollingProvider {
  readonly manifest: ProviderManifest;
  readonly definition: ConnectorProviderDefinition;
  readonly mode: StacMode;
  private readonly mapping: CompiledMapping;
  private readonly datetime: DatetimeSpec;
  private readonly origin: string;
  /** The server answered 405 to POST /search: GET from then on. */
  private useGet = false;
  private skippedReason: string | undefined;
  private last: FetchStats | undefined;

  constructor(definition: ConnectorProviderDefinition) {
    super();
    if (!definition.endpoint) throw new Error(`${definition.id}: the STAC connector needs an endpoint`);
    this.definition = withStacDefaults(definition);
    this.mode = stacMode(this.definition.endpoint!.url);
    this.manifest = stacManifest(this.definition);
    this.mapping = compileMapping(this.definition.mapping);
    const dt = datetimeSpec(this.definition);
    this.datetime = 'error' in dt ? { rolling: 7 * DAY_MS } : dt;
    this.origin = new URL(this.definition.endpoint!.url).origin;
    if (this.definition.endpoint!.method === 'GET') this.useGet = true;
  }

  protected override async onInitialize(_context: ProviderContext): Promise<void> {
    /* settings are read on each poll: the operator may change them between polls */
  }

  private async setting(key: string): Promise<number | undefined> {
    const v = (await this.context.settings.get())[key];
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
    return Number.isFinite(n) ? n : undefined;
  }

  /** The window this poll searches: the operator's setting, else the definition's, else seven days. */
  async windowMs(): Promise<number> {
    if (!('rolling' in this.datetime)) return 0;
    const days = await this.setting(WINDOW_SETTING);
    if (days === undefined) return this.datetime.rolling;
    return Math.min(MAX_WINDOW_MS, Math.max(MIN_WINDOW_MS, days * DAY_MS));
  }

  async maxDepth(): Promise<number> {
    const n = await this.setting(DEPTH_SETTING);
    return n === undefined ? DEFAULT_MAX_DEPTH : Math.min(MAX_DEPTH_LIMIT, Math.max(1, Math.floor(n)));
  }

  private httpRequest(r: SearchRequest | { method: 'GET'; url: string }, signal: AbortSignal, cacheKey?: string) {
    const e = this.definition.endpoint!;
    const req: ProviderHttpRequest = {
      url: r.url,
      method: r.method,
      headers: {
        Accept: 'application/geo+json, application/json;q=0.9, */*;q=0.1',
        ...(e.headers ?? {}),
        ...('headers' in r && r.headers ? r.headers : {}),
      },
      maxBytes: e.maxBytes ?? DEFAULT_MAX_BYTES,
      timeoutMs: this.manifest.refreshPolicy.timeoutMs,
      signal,
    };
    if (cacheKey) req.cacheKey = cacheKey;
    if (r.method === 'POST') {
      req.body = JSON.stringify('body' in r && r.body ? r.body : {});
      req.headers!['Content-Type'] = 'application/json';
    }
    if (e.credential) {
      const ref = this.definition.credentials?.[e.credential.name];
      if (ref)
        req.credential = {
          key: ref.secretRef,
          as: e.credential.as,
          ...(e.credential.param ? { name: e.credential.param } : {}),
        };
    }
    return req;
  }

  private json(res: ProviderHttpResponse): unknown {
    try {
      return res.json();
    } catch {
      res.invalidate();
      throw new ProviderError('MALFORMED', `${this.definition.id}: response is not valid JSON`, { retryable: false });
    }
  }

  /** Map one batch of items, adding to `into` (first id wins); how many there were, and how many mapped or were filtered. */
  private mapItems(
    items: WalkItem[],
    into: { observations: Observation[]; seen: Set<string> },
    stats: FetchStats,
    origin: 'live' | 'cached',
  ): { total: number; usable: number } {
    if (!items.length) return { total: 0, usable: 0 };
    const records: unknown[] = [];
    for (const { item, base } of items) {
      const r = itemRecord(item, base);
      if (r.footprint === 'simplified') stats.simplified++;
      if (r.footprint === 'dropped') stats.dropped++;
      records.push(r.record);
    }
    const mapped = mapRecords(records, {
      manifest: this.manifest,
      definition: this.definition,
      mapping: this.mapping,
      receivedAt: new Date(this.context.clock.now()).toISOString(),
      origin,
      sourceRef: this.definition.endpoint!.url,
      hash: (s) => this.context.hash.sha256Hex(s),
    });
    stats.filtered += mapped.filtered;
    stats.rejected += mapped.rejected.length;
    if (mapped.rejected.length)
      this.context.logger.warn('rejected records', {
        count: mapped.rejected.length,
        sample: mapped.rejected.slice(0, 3).map((r) => r.reason),
      });
    for (const o of mapped.observations) {
      const key = o.externalId ?? o.id;
      if (into.seen.has(key)) continue;
      into.seen.add(key);
      into.observations.push(o);
    }
    return { total: mapped.total, usable: mapped.observations.length + mapped.filtered };
  }

  protected async fetchOnce(request: ProviderQuery): Promise<{ observations: Observation[]; cacheAgeMs?: number }> {
    if (request.signal.aborted) throw new ProviderError('CANCELLED', 'cancelled before request');
    if (this.mode === 'search' && this.definition.boundsQuery && !request.bounds) {
      this.skippedReason = 'waiting for a viewport before the first search';
      return { observations: [] };
    }
    this.skippedReason = undefined;
    const stats: FetchStats = { rejected: 0, filtered: 0, simplified: 0, dropped: 0, truncated: false, refused: [] };
    const result = this.mode === 'search' ? await this.search(request, stats) : await this.walk(request.signal, stats);
    this.last = stats;
    this.context.logger.debug('connector fetch', {
      mode: this.mode,
      observations: result.observations.length,
      rejected: stats.rejected,
      filtered: stats.filtered,
      footprintsSimplified: stats.simplified,
      footprintsDropped: stats.dropped,
      ...(stats.walk ? { documents: stats.walk.documents } : {}),
    });
    return result;
  }

  private async search(
    request: ProviderQuery,
    stats: FetchStats,
  ): Promise<{ observations: Observation[]; cacheAgeMs: number }> {
    const e = this.definition.endpoint!;
    const base = searchBody(this.definition);
    const window = await this.windowMs();
    const datetime = 'fixed' in this.datetime ? this.datetime.fixed : windowInterval(this.context.clock.now(), window);
    const boxes = this.definition.boundsQuery && request.bounds ? viewBoxes(request.bounds) : [undefined];
    const into = { observations: [] as Observation[], seen: new Set<string>() };
    const maxPages = pagesOf(this.definition);
    let cacheAgeMs = 0;
    for (const [b, box] of boxes.entries()) {
      const params = searchParameters(base, { ...(box ? { box } : {}), datetime });
      let req: SearchRequest | undefined = firstRequest(e.url, e.query, params, this.useGet ? 'GET' : 'POST');
      const sent = new Set<string>();
      for (let page = 0; req; page++) {
        if (page >= maxPages) {
          stats.truncated = true;
          break;
        }
        const key = requestKey(req);
        if (sent.has(key)) break;
        sent.add(key);
        let res: ProviderHttpResponse;
        try {
          res = await this.context.http.request(
            this.httpRequest(req, request.signal, `stac ${req.method} ${e.url} box${b} page${page}`),
          );
        } catch (err) {
          // POST /search is optional in STAC API; a server without it says 405 (or 501).
          const status = err instanceof ProviderError ? err.httpStatus : undefined;
          if (page === 0 && req.method === 'POST' && (status === 405 || status === 501)) {
            this.useGet = true;
            this.context.logger.info('item search does not take POST; searching with GET', { httpStatus: status });
            req = firstRequest(e.url, e.query, params, 'GET');
            sent.clear();
            page = -1;
            continue;
          }
          throw err;
        }
        cacheAgeMs = Math.max(cacheAgeMs, res.ageMs);
        const body = this.json(res);
        if (
          !isRecord(body) ||
          !Array.isArray(body['features']) ||
          (body['type'] ?? 'FeatureCollection') !== 'FeatureCollection'
        ) {
          res.invalidate();
          throw new ProviderError(
            'MALFORMED',
            `${this.definition.id}: not a STAC ItemCollection (a FeatureCollection with features)`,
            { retryable: false },
          );
        }
        const url = req.url;
        const batch = this.mapItems(
          (body['features'] as unknown[]).map((item) => ({ item, base: url })),
          into,
          stats,
          res.stale || res.fromCache ? 'cached' : 'live',
        );
        if (batch.total > 0 && batch.usable === 0) {
          // Every item unusable: the mapping does not fit this catalogue. Say so rather than serve nothing quietly.
          res.invalidate();
          assertAtomicAdmission(batch.total, 0, `${this.definition.id} items`);
        }
        const next = nextRequest(body, req, this.origin);
        if (next.refused) stats.refused.push(next.refused);
        req = next.request;
      }
    }
    return { observations: into.observations, cacheAgeMs };
  }

  private async walk(
    signal: AbortSignal,
    stats: FetchStats,
  ): Promise<{ observations: Observation[]; cacheAgeMs: number }> {
    let cacheAgeMs = 0;
    /** Documents served from the cache (revalidated or stale): their items are `cached`, as for rest-json. */
    const fromCache = new Set<string>();
    const walked = await walkStaticCatalog({
      root: this.definition.endpoint!.url,
      maxDepth: await this.maxDepth(),
      maxDocuments: pagesOf(this.definition),
      signal,
      fetchJson: async (url) => {
        const res = await this.context.http.request(this.httpRequest({ method: 'GET', url }, signal));
        cacheAgeMs = Math.max(cacheAgeMs, res.ageMs);
        if (res.stale || res.fromCache) fromCache.add(url);
        return this.json(res);
      },
    });
    stats.walk = {
      documents: walked.documents,
      skipped: walked.skipped.length,
      ...walked.notFollowed,
    };
    if (walked.skipped.length)
      this.context.logger.warn('catalogue documents skipped', {
        count: walked.skipped.length,
        sample: walked.skipped.slice(0, 3).map((s) => `${s.url}: ${s.reason}` as JsonValue),
      });
    const into = { observations: [] as Observation[], seen: new Set<string>() };
    const live = this.mapItems(
      walked.items.filter((i) => !fromCache.has(i.base)),
      into,
      stats,
      'live',
    );
    const cached = this.mapItems(
      walked.items.filter((i) => fromCache.has(i.base)),
      into,
      stats,
      'cached',
    );
    const total = live.total + cached.total;
    if (total > 0 && live.usable + cached.usable === 0)
      assertAtomicAdmission(total, 0, `${this.definition.id} catalogue items`);
    return { observations: into.observations, cacheAgeMs };
  }

  override async health(): Promise<ProviderHealth> {
    const h = await super.health();
    if (h.message) return h;
    if (this.skippedReason) {
      h.message = this.skippedReason;
      return h;
    }
    const s = this.last;
    if (!s) return h;
    const parts: string[] = [];
    if (s.rejected) parts.push(`${s.rejected} item(s) rejected by the mapping`);
    if (s.filtered) parts.push(`${s.filtered} filtered out`);
    if (s.truncated) parts.push(`stopped at ${pagesOf(this.definition)} page(s); more scenes match`);
    if (s.simplified) parts.push(`${s.simplified} footprint(s) thinned to 5,000 vertices`);
    if (s.dropped) parts.push(`${s.dropped} footprint(s) left out`);
    if (s.refused.length) parts.push(`${s.refused[0]} was not followed`);
    if (s.walk) {
      if (s.walk.budget) parts.push(`walk stopped at ${s.walk.documents} documents`);
      if (s.walk.depth) parts.push(`${s.walk.depth} link(s) past the depth cap`);
      if (s.walk.offOrigin) parts.push(`${s.walk.offOrigin} link(s) to other hosts not followed`);
      if (s.walk.skipped) parts.push(`${s.walk.skipped} document(s) unreadable`);
    }
    if (parts.length) h.message = `Last fetch: ${parts.join('; ')}`;
    return h;
  }
}

export function validateStac(input: ConnectorProviderDefinition): ConnectorValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const e = input.endpoint;
  if (!e) return { ok: false, errors: ['endpoint is required'], warnings };
  const d = withStacDefaults(input);
  const mode = stacMode(e.url);
  if (input.websocket) warnings.push('websocket is ignored by this connector');
  if (!SCENE_TYPES.includes(input.objectType) || !OBJECT_TYPE_VALUES.includes(input.objectType))
    errors.push(
      `objectType must be "place" (with properties.kind "imagery-scene") until the world model has "imagery-scene"; got "${input.objectType}"`,
    );
  const kind = input.mapping.properties?.['kind'];
  if (kind !== undefined && !(typeof kind === 'object' && kind.literal === IMAGERY_SCENE_KIND))
    warnings.push(
      'mapping.properties.kind is not the literal "imagery-scene": the scenes will not be recognisable as such',
    );
  if (input.response?.format && input.response.format !== 'json') errors.push('a STAC source is JSON');
  if (input.response?.itemsPath || input.response?.itemsAs)
    warnings.push('response.itemsPath/itemsAs are ignored: STAC says where the items are');
  const p = input.pagination;
  if (p && p.strategy !== 'none' && p.strategy !== 'next-link')
    errors.push(`pagination "${p.strategy}" does not apply: STAC pages by links[rel=next] (use next-link or none)`);
  if (p?.strategy === 'next-link' && p.nextLinkPath !== 'links')
    errors.push('pagination.nextLinkPath must be "links": the connector follows the link whose rel is "next"');
  if (e.credential?.as === 'path')
    errors.push('endpoint.credential "path" is not supported for STAC: use bearer, header or query');
  for (const k of Object.keys(e.query ?? {}))
    if (SEARCH_PARAMETERS.includes(k))
      errors.push(
        `endpoint.query.${k}: describe the search in endpoint.body (JSON form); the connector sends it as POST or GET`,
      );
  if (mode === 'search') {
    if (e.body !== undefined && !isRecord(e.body)) errors.push('endpoint.body must be a JSON object (the search)');
    const body = searchBody(input);
    const dt = datetimeSpec(input);
    if ('error' in dt) errors.push(dt.error);
    else if ('fixed' in dt)
      warnings.push(
        `datetime is fixed at ${dt.fixed}: every poll asks for the same interval and no window setting is offered`,
      );
    if (input.boundsQuery && (body['bbox'] !== undefined || body['intersects'] !== undefined))
      errors.push('boundsQuery sets bbox from the view: remove bbox/intersects from endpoint.body');
    if (body['bbox'] !== undefined && body['intersects'] !== undefined)
      errors.push('endpoint.body has both bbox and intersects, which STAC API forbids');
    const limit = body['limit'];
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 10_000))
      errors.push('endpoint.body.limit must be an integer from 1 to 10000');
    else if (typeof limit === 'number' && limit > 1000)
      warnings.push(`endpoint.body.limit ${limit}: many servers cap a page well below that`);
    const collections = body['collections'];
    if (collections === undefined)
      warnings.push('endpoint.body.collections is unset: the search covers every collection the API holds');
    else if (!Array.isArray(collections) || !collections.every((c) => typeof c === 'string' && c.length > 0))
      errors.push('endpoint.body.collections must be a list of collection ids');
    for (const k of ['token', 'next'])
      if (body[k] !== undefined)
        errors.push(`endpoint.body.${k} is a paging token; the connector follows next links itself`);
    if (!input.boundsQuery && body['bbox'] === undefined && body['intersects'] === undefined)
      warnings.push('no boundsQuery and no bbox: the search is worldwide, capped at limit × maxPages scenes');
    if (d.freshness?.expireSeconds !== undefined && 'rolling' in dt && d.freshness.expireSeconds * 1000 < dt.rolling)
      warnings.push('freshness.expireSeconds is shorter than the time window: older scenes will be refused as expired');
  } else {
    warnings.push(
      'the endpoint is not an item search (…/search): it is read as a static catalogue and walked link by link',
    );
    if (e.method === 'POST' || e.body !== undefined)
      errors.push('a static catalogue is read with GET: remove endpoint.method POST and endpoint.body');
    if (input.boundsQuery)
      errors.push('boundsQuery needs an item search endpoint (…/search); a static catalogue is read whole');
    if ((d.endpoint?.intervalSeconds ?? DEFAULT_STAC_INTERVAL_SECONDS) < 600)
      warnings.push('a static catalogue changes rarely: an interval under 10 minutes re-walks it for nothing');
  }
  return { ok: errors.length === 0, errors, warnings };
}

export const stacConnector: Connector = {
  metadata: {
    id: STAC_CONNECTOR_ID,
    name: 'STAC',
    description:
      'Imagery footprints from a STAC API item search or a static STAC catalogue: one object per scene, at its centre, with its footprint.',
    uses: ['endpoint', 'pagination', 'mapping'],
    dataset: 'STATIC_FEATURES',
  },
  validate: validateStac,
  createProvider: (d) => new StacProvider(d),
};
