import type { GeoBounds, Observation } from '@worldview/world-model';
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
} from '@worldview/provider-sdk';
import {
  compileMapping,
  definitionToManifest,
  mapRecords,
  type CompiledMapping,
  type Connector,
  type ConnectorProviderDefinition,
  type ConnectorValidationResult,
} from '@worldview/connector-sdk';
import {
  arcgisError,
  describeArcGisError,
  readFeatureSet,
  type ArcGisErrorBody,
  type FeatureSet,
} from './esri-json.js';
import {
  checkLayerInfo,
  layerDateFields,
  layerEndpoint,
  parseLayerInfo,
  preferredFormat,
  propertyName,
  type ArcGisLayerInfo,
  type LayerEndpoint,
} from './layer-info.js';

/**
 * ArcGIS REST feature queries — one layer of a FeatureServer or a MapServer, the way most US
 * and Canadian cities, counties, states, utilities and agencies publish live data. The
 * definition names the layer (`…/FeatureServer/<n>` or `…/MapServer/<n>`) and, in
 * `endpoint.query`, the ArcGIS query parameters it wants (`where`, `outFields`,
 * `orderByFields`, `returnGeometry`, `time`, …); the connector fills and owns the rest:
 *
 * - `where=1=1` and `outFields=*` unless the definition says otherwise; `outSR=4326` always.
 * - The layer's description (`…/<n>?f=json`) is read first and then every six hours: its
 *   `maxRecordCount`, whether it pages, its formats and field types.
 * - `f=geojson`, or `f=json` (esriJSON, converted to GeoJSON here) when the layer's
 *   `supportedQueryFormats` lacks geoJSON or it is older than 10.4. The mapping sees GeoJSON
 *   features either way, with date fields as ISO 8601.
 * - Paging with `resultOffset`/`resultRecordCount`: another page while the server says
 *   `exceededTransferLimit: true`; when it does not say, another page only after a full one.
 *   A page that brings nothing new ends it (a server that ignores `resultOffset`), and a
 *   layer with more features than `maxPages` pages is served truncated and says so.
 * - `boundsQuery: true`: the viewport as an `esriGeometryEnvelope` in 4326, intersecting;
 *   split into two envelopes when the viewport crosses the antimeridian.
 * - A token is a credential (`credentials` + `endpoint.credential { as: "query", param:
 *   "token" }`), attached by the host to both requests; the definition never holds it.
 * - HTTP 200 with `{ "error": … }` is a failure: AUTH for 498/499 (and 401/403), a server
 *   error for 5xx, MALFORMED with the server's message otherwise; the cached body is dropped.
 */
export const ARCGIS_FEATURE_CONNECTOR_ID = 'arcgis-feature';
const CONNECTOR_NAME = 'ArcGIS FeatureServer/MapServer';
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
/** Pages per poll when the definition does not say (as for every other paginating connector). */
export const ARCGIS_DEFAULT_MAX_PAGES = 10;
/** How long a layer description is used before it is read again. */
export const LAYER_INFO_TTL_MS = 6 * 3600_000;

/** Query parameters the connector sets itself; a definition naming them is refused. */
const PAGING_PARAMS = new Set(['resultoffset', 'resultrecordcount']);
const BOUNDS_PARAMS = new Set(['geometry', 'geometrytype', 'insr', 'spatialrel']);
/** Parameters that turn a feature query into something else (counts, ids, statistics). */
const NOT_FEATURES = new Set([
  'returnidsonly',
  'returncountonly',
  'returnextentonly',
  'outstatistics',
  'groupbyfieldsforstatistics',
  'returndistinctvalues',
  'returnm',
  'returntruecurves',
]);

type Envelope = [west: number, south: number, east: number, north: number];

/** The viewport as one envelope, or two when it crosses the antimeridian (west > east). */
export function envelopesFor(b: GeoBounds): Envelope[] {
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const south = clamp(Math.min(b.south, b.north), -90, 90);
  const north = clamp(Math.max(b.south, b.north), -90, 90);
  const west = clamp(b.west, -180, 180);
  const east = clamp(b.east, -180, 180);
  if (west <= east) return [[west, south, east, north]];
  return [
    [west, south, 180, north],
    [-180, south, east, north],
  ];
}

/**
 * Whether to ask for another page. `exceededTransferLimit` decides when the server gives it;
 * without it, only a full page (`pageSize` records) can have a successor. Never the page
 * size alone: a server caps pages at its own `maxRecordCount`, whatever was asked.
 */
export function wantsNextPage(count: number, exceeded: boolean | undefined, pageSize: number | undefined): boolean {
  if (count === 0) return false;
  if (exceeded !== undefined) return exceeded;
  return pageSize !== undefined && count >= pageSize;
}

/** The definition with the connector's defaults: a feature's geometry is its position unless the mapping says otherwise. */
export function withArcGisDefaults(d: ConnectorProviderDefinition): ConnectorProviderDefinition {
  if (d.mapping.position || d.mapping.geometry) return d;
  return { ...d, mapping: { ...d.mapping, position: { geometry: 'geometry' } } };
}

interface PagePlan {
  paged: boolean;
  pageSize: number | undefined;
  maxPages: number;
}

export class ArcGisFeatureProvider extends PollingProvider {
  readonly manifest: ProviderManifest;
  readonly layer: LayerEndpoint;
  private readonly mapping: CompiledMapping;
  private layerInfo: { info: ArcGisLayerInfo | undefined; fetchedAt: number } | undefined;
  private lastRejected = 0;
  private lastFiltered = 0;
  private lastPages = 0;
  private skippedReason: string | undefined;
  private truncatedReason: string | undefined;

  constructor(readonly definition: ConnectorProviderDefinition) {
    super();
    if (!definition.endpoint) throw new Error(`${definition.id}: the ${CONNECTOR_NAME} connector needs an endpoint`);
    const layer = layerEndpoint(definition.endpoint.url);
    if ('error' in layer) throw new Error(`${definition.id}: ${layer.error}`);
    this.layer = layer;
    this.mapping = compileMapping(definition.mapping);
    this.manifest = arcgisManifest(definition);
  }

  protected override async onInitialize(_context: ProviderContext): Promise<void> {
    /* settings are the operator's; nothing to read yet */
  }

  /** The layer description last read (undefined before the first poll, or when the server's answer was not one). */
  get layerDescription(): ArcGisLayerInfo | undefined {
    return this.layerInfo?.info;
  }

  /**
   * The query parameters for one request, in a stable order (they are the cache key): the
   * defaults, the definition's own (names compared case-insensitively, as ArcGIS does), then
   * what the connector owns — output format and system, envelope, order and page.
   */
  queryParams(opts: {
    format: 'geojson' | 'json';
    envelope?: Envelope;
    offset?: number;
    pageSize?: number;
    orderBy?: string;
  }): URLSearchParams {
    const entries = new Map<string, [string, string]>();
    const put = (key: string, value: string) => entries.set(key.toLowerCase(), [key, value]);
    put('where', '1=1');
    put('outFields', '*');
    put('returnGeometry', 'true');
    for (const [k, v] of Object.entries(this.definition.endpoint?.query ?? {})) put(k, String(v));
    const theirOrder = entries.has('orderbyfields');
    put('outSR', '4326');
    put('f', opts.format);
    if (opts.envelope) {
      put('geometry', opts.envelope.map((n) => n.toFixed(5)).join(','));
      put('geometryType', 'esriGeometryEnvelope');
      put('inSR', '4326');
      put('spatialRel', 'esriSpatialRelIntersects');
    }
    if (opts.orderBy && !theirOrder) put('orderByFields', opts.orderBy);
    if (opts.offset !== undefined) put('resultOffset', String(opts.offset));
    if (opts.pageSize !== undefined) put('resultRecordCount', String(opts.pageSize));
    return new URLSearchParams([...entries.values()]);
  }

  /** The HTTP request for a set of query parameters: GET with them in the URL, or POST as a form. */
  buildRequest(params: URLSearchParams): ProviderHttpRequest {
    const e = this.definition.endpoint!;
    const post = e.method === 'POST';
    const url = post ? this.layer.queryUrl : `${this.layer.queryUrl}?${params.toString()}`;
    const req: ProviderHttpRequest = {
      url,
      method: post ? 'POST' : 'GET',
      headers: { Accept: 'application/geo+json, application/json;q=0.9, */*;q=0.1', ...(e.headers ?? {}) },
      maxBytes: e.maxBytes ?? DEFAULT_MAX_BYTES,
      timeoutMs: this.manifest.refreshPolicy.timeoutMs,
    };
    if (post) {
      req.body = params.toString();
      req.headers!['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    this.attachCredential(req);
    return req;
  }

  private attachCredential(req: ProviderHttpRequest): void {
    const c = this.definition.endpoint?.credential;
    const ref = c ? this.definition.credentials?.[c.name] : undefined;
    if (c && ref) req.credential = { key: ref.secretRef, as: c.as, ...(c.param ? { name: c.param } : {}) };
  }

  protected async fetchOnce(request: ProviderQuery): Promise<{ observations: Observation[]; cacheAgeMs?: number }> {
    if (request.signal.aborted) throw new ProviderError('CANCELLED', 'cancelled before request');
    if (this.definition.boundsQuery && !request.bounds) {
      this.skippedReason = 'waiting for a viewport before the first request';
      return { observations: [] };
    }
    this.skippedReason = undefined;
    const info = await this.readLayerInfo(request.signal);
    const forced = forcedFormat(this.definition);
    const format = forced ?? preferredFormat(info);
    const dates = layerDateFields(info);
    const plan = pagePlan(this.definition, info);
    const orderBy =
      plan.paged && plan.maxPages > 1 && info?.supportsOrderBy === true && info.objectIdField
        ? info.objectIdField
        : undefined;
    const envelopes: Array<Envelope | undefined> =
      this.definition.boundsQuery && request.bounds ? envelopesFor(request.bounds) : [undefined];

    const observations: Observation[] = [];
    const seen = new Set<string>();
    let rejected = 0;
    let filtered = 0;
    let total = 0;
    let pages = 0;
    let cacheAgeMs = 0;
    const truncated: string[] = [];
    const problems: string[] = [];
    const responses: ProviderHttpResponse[] = [];
    for (const envelope of envelopes) {
      const featureIds = new Set<string>();
      let offset = 0;
      for (let page = 0; page < plan.maxPages; page++) {
        const params = this.queryParams({
          format,
          ...(envelope ? { envelope } : {}),
          ...(plan.paged ? { offset } : {}),
          ...(plan.paged && plan.pageSize !== undefined ? { pageSize: plan.pageSize } : {}),
          ...(orderBy ? { orderBy } : {}),
        });
        const req = this.buildRequest(params);
        const cacheKey = req.body ? `${req.url}#${String(req.body)}` : req.url;
        const res = await this.context.http.request({ ...req, signal: request.signal, cacheKey });
        cacheAgeMs = Math.max(cacheAgeMs, res.ageMs);
        responses.push(res);
        pages++;
        const set = this.readQueryResponse(res, info, dates);
        problems.push(...set.problems.slice(0, Math.max(0, 5 - problems.length)));
        let fresh = 0;
        for (const f of set.features) {
          const id = f.id === undefined ? undefined : String(f.id);
          if (id === undefined || !featureIds.has(id)) fresh++;
          if (id !== undefined) featureIds.add(id);
        }
        const receivedAt = new Date(this.context.clock.now()).toISOString();
        const mapped = mapRecords(set.features, {
          manifest: this.manifest,
          definition: this.definition,
          mapping: this.mapping,
          receivedAt,
          origin: res.stale || res.fromCache ? 'cached' : 'live',
          sourceRef: this.layer.layerUrl,
          hash: (s) => this.context.hash.sha256Hex(s),
        });
        total += mapped.total;
        filtered += mapped.filtered;
        rejected += mapped.rejected.length;
        for (const o of mapped.observations) {
          const key = o.externalId ?? o.id;
          if (seen.has(key)) continue;
          seen.add(key);
          observations.push(o);
        }
        if (mapped.rejected.length)
          this.context.logger.warn('rejected records', {
            count: mapped.rejected.length,
            sample: mapped.rejected.slice(0, 3).map((r) => r.reason),
          });
        const more = wantsNextPage(set.features.length, set.exceededTransferLimit, plan.pageSize);
        if (!more) break;
        if (!plan.paged) {
          truncated.push(
            `the layer holds more than one request returns and ${info?.supportsPagination === false ? 'cannot page' : 'pagination is off'}: only the first ${set.features.length} features are read`,
          );
          break;
        }
        if (page > 0 && fresh === 0) {
          truncated.push('the server repeated a page (resultOffset ignored?); stopped paging');
          break;
        }
        if (page === plan.maxPages - 1) {
          truncated.push(
            `stopped after ${plan.maxPages} page(s) (${offset + set.features.length} features) with more on the server: raise pagination.maxPages or narrow the where clause`,
          );
          break;
        }
        offset += set.features.length;
      }
    }
    if (total > 0 && observations.length === 0 && filtered === 0) {
      // Every record of the poll unusable: the mapping does not fit this layer. Say so rather than
      // serve nothing quietly. (Per poll, not per page: a page of features without geometry must
      // not throw away the pages before it.)
      for (const r of responses) r.invalidate();
      assertAtomicAdmission(total, 0, `${this.definition.id} layer`);
    }
    this.lastPages = pages;
    this.lastRejected = rejected;
    this.lastFiltered = filtered;
    this.truncatedReason = truncated[0];
    if (truncated.length) this.context.logger.warn('arcgis layer truncated', { reason: truncated[0]! });
    if (problems.length) this.context.logger.warn('arcgis geometries unreadable', { sample: problems });
    if (total > 0)
      this.context.logger.debug('connector fetch', {
        records: total,
        observations: observations.length,
        filtered,
        rejected,
        pages,
        format,
      });
    return { observations, cacheAgeMs };
  }

  /** A query response as features, or the failure it is. */
  private readQueryResponse(
    res: ProviderHttpResponse,
    info: ArcGisLayerInfo | undefined,
    dates: Set<string>,
  ): FeatureSet {
    let body: unknown;
    try {
      body = res.json();
    } catch {
      res.invalidate();
      throw new ProviderError('MALFORMED', `${this.definition.id}: query response is not valid JSON`, {
        retryable: false,
      });
    }
    const err = arcgisError(body);
    if (err) {
      res.invalidate();
      // A query the server refuses may mean the layer changed: read its description again next time.
      this.layerInfo = undefined;
      throw envelopeError(err, `${this.definition.id}: query`);
    }
    const set = readFeatureSet(body, {
      dates,
      ...(info?.objectIdField ? { objectIdField: info.objectIdField } : {}),
    });
    if ('malformed' in set) {
      res.invalidate();
      throw new ProviderError('MALFORMED', `${this.definition.id}: ${set.malformed}`, { retryable: false });
    }
    return set;
  }

  /**
   * The layer's description, read when there is none or it is older than LAYER_INFO_TTL_MS.
   * A transport failure fails the poll like any request; a body that is JSON but not a
   * layer description is logged and the poll goes on with the defaults.
   */
  private async readLayerInfo(signal: AbortSignal): Promise<ArcGisLayerInfo | undefined> {
    const now = this.context.clock.now();
    if (this.layerInfo && now - this.layerInfo.fetchedAt < LAYER_INFO_TTL_MS) return this.layerInfo.info;
    const url = `${this.layer.layerUrl}?f=json`;
    const req: ProviderHttpRequest = {
      url,
      method: 'GET',
      headers: { Accept: 'application/json, */*;q=0.1', ...(this.definition.endpoint?.headers ?? {}) },
      maxBytes: this.definition.endpoint?.maxBytes ?? DEFAULT_MAX_BYTES,
      timeoutMs: this.manifest.refreshPolicy.timeoutMs,
    };
    this.attachCredential(req);
    const res = await this.context.http.request({ ...req, signal, cacheKey: url });
    let body: unknown;
    try {
      body = res.json();
    } catch {
      res.invalidate();
      throw new ProviderError('MALFORMED', `${this.definition.id}: the layer description is not valid JSON`, {
        retryable: false,
      });
    }
    const err = arcgisError(body);
    if (err) {
      res.invalidate();
      throw envelopeError(err, `${this.definition.id}: layer description`);
    }
    const parsed = parseLayerInfo(body);
    if ('notLayer' in parsed) {
      this.context.logger.warn('arcgis layer description not recognised; using defaults', {
        layer: this.layer.layerUrl,
        reason: parsed.notLayer,
      });
      this.layerInfo = { info: undefined, fetchedAt: now };
      return undefined;
    }
    const info = parsed.info;
    this.layerInfo = { info, fetchedAt: now };
    const plan = pagePlan(this.definition, info);
    this.context.logger.info('arcgis layer', {
      layer: this.layer.layerUrl,
      ...(info.name ? { name: info.name } : {}),
      ...(info.type ? { type: info.type } : {}),
      ...(info.currentVersion !== undefined ? { version: info.currentVersion } : {}),
      format: forcedFormat(this.definition) ?? preferredFormat(info),
      paged: plan.paged,
      ...(plan.pageSize !== undefined ? { pageSize: plan.pageSize } : {}),
    });
    const warnings = checkLayerInfo(this.definition, info);
    if (warnings.length) this.context.logger.warn('arcgis layer check', { layer: this.layer.layerUrl, warnings });
    return info;
  }

  override async health(): Promise<ProviderHealth> {
    const h = await super.health();
    if (h.message) return h;
    if (this.skippedReason) h.message = this.skippedReason;
    else if (this.truncatedReason) h.message = this.truncatedReason;
    else if (this.lastRejected > 0)
      h.message = `${this.lastRejected} record(s) rejected by the mapping on the last fetch${this.lastFiltered ? `; ${this.lastFiltered} filtered out` : ''}`;
    return h;
  }

  /** Requests made by the last poll (the layer description not counted). */
  get pagesLastPoll(): number {
    return this.lastPages;
  }
}

function envelopeError(e: ArcGisErrorBody, what: string): ProviderError {
  const message = `${what}: ${describeArcGisError(e)}`;
  const code = e.code;
  // 498 invalid token, 499 token required; 401/403 are how some servers say the same.
  if (code === 498 || code === 499 || code === 401 || code === 403)
    return new ProviderError('AUTH', message, { httpStatus: code, retryable: false });
  if (code === 429) return new ProviderError('RATE_LIMITED', message, { httpStatus: 429 });
  if (code !== undefined && code >= 500 && code < 600)
    return new ProviderError('HTTP_5XX', message, { httpStatus: code });
  return new ProviderError('MALFORMED', message, { retryable: false });
}

/** `f` when the definition fixes it (`json` or `geojson`); otherwise the layer decides. */
function forcedFormat(d: ConnectorProviderDefinition): 'geojson' | 'json' | undefined {
  for (const [k, v] of Object.entries(d.endpoint?.query ?? {}))
    if (k.toLowerCase() === 'f') {
      const f = String(v).toLowerCase();
      if (f === 'json' || f === 'geojson') return f;
    }
  return undefined;
}

function pagePlan(d: ConnectorProviderDefinition, info: ArcGisLayerInfo | undefined): PagePlan {
  const p = d.pagination;
  if (p?.strategy === 'none') return { paged: false, pageSize: undefined, maxPages: 1 };
  const maxPages = p?.maxPages ?? ARCGIS_DEFAULT_MAX_PAGES;
  const asked = p?.strategy === 'offset-limit' ? p.limit : undefined;
  const serverMax = info?.maxRecordCount;
  const pageSize = asked !== undefined && serverMax !== undefined ? Math.min(asked, serverMax) : (asked ?? serverMax);
  // A layer that cannot page answers its first maxRecordCount features, once.
  if (info?.supportsPagination === false) return { paged: false, pageSize, maxPages: 1 };
  return { paged: true, pageSize, maxPages };
}

/**
 * The manifest a definition amounts to, with a rate limit that covers what this connector
 * sends per poll: the layer description, then every page of every envelope (two when a
 * bounds query crosses the antimeridian), plus a retry. Twice the cadence, as for every
 * definition — and never less than one whole poll plus a retry, because the host counts
 * requests in a sliding minute and refuses (rather than delays) a burst that does not fit:
 * at a fifteen-minute cadence, "twice the cadence" alone would allow three requests a minute
 * and refuse the rest of a ten-page poll.
 */
export function arcgisManifest(d: ConnectorProviderDefinition): ProviderManifest {
  const base = definitionToManifest(d, CONNECTOR_NAME);
  const intervalSeconds = base.refreshPolicy.intervalMs / 1000;
  const perPoll = requestsPerPoll(d);
  const needed = Math.max(Math.ceil((120 / intervalSeconds) * (1 + perPoll)), perPoll + 1);
  return {
    ...base,
    refreshPolicy: {
      ...base.refreshPolicy,
      maxRequestsPerMinute: Math.max(base.refreshPolicy.maxRequestsPerMinute, needed),
    },
  };
}

/** The most requests one poll can make: the layer description and every page of every envelope. */
export function requestsPerPoll(d: ConnectorProviderDefinition): number {
  const pages = d.pagination?.strategy === 'none' ? 1 : (d.pagination?.maxPages ?? ARCGIS_DEFAULT_MAX_PAGES);
  return 1 + pages * (d.boundsQuery ? 2 : 1);
}

const PLACEHOLDER = /\{(south|west|north|east)\}/;

export function validateArcGisFeature(input: ConnectorProviderDefinition): ConnectorValidationResult {
  const d = withArcGisDefaults(input);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!d.endpoint) return { ok: false, errors: ['endpoint is required: the layer URL'], warnings };
  if (d.websocket) warnings.push('websocket is ignored by this connector');
  const layer = layerEndpoint(d.endpoint.url);
  if ('error' in layer) errors.push(layer.error);
  else if (!/\/rest\/services\//i.test(new URL(layer.layerUrl).pathname))
    warnings.push('endpoint.url has no /rest/services/ in its path; is it an ArcGIS REST layer?');
  const usesGeometry = !d.mapping.position || 'geometry' in d.mapping.position;
  for (const [key, value] of Object.entries(d.endpoint.query ?? {})) {
    const k = key.toLowerCase();
    const v = String(value).trim();
    if (PAGING_PARAMS.has(k))
      errors.push(
        `endpoint.query.${key} is set by the connector: give the page size as pagination { "strategy": "offset-limit", "offsetParam": "resultOffset", "limitParam": "resultRecordCount", "limit": … }`,
      );
    else if (k === 'token')
      errors.push(
        'endpoint.query.token: a token is a secret; declare it in credentials and attach it with endpoint.credential { "as": "query", "param": "token" }',
      );
    else if (NOT_FEATURES.has(k)) errors.push(`endpoint.query.${key} is not supported: this connector reads features`);
    else if (k === 'f' && !['json', 'geojson'].includes(v.toLowerCase()))
      errors.push(`endpoint.query.f must be json or geojson (or left out), not ${v}`);
    else if (k === 'outsr' && !['4326', '{"wkid":4326}'].includes(v.replace(/\s/g, '')))
      errors.push(`endpoint.query.outSR must be 4326 or left out: the connector reads longitude/latitude only`);
    else if (k === 'returngeometry' && v.toLowerCase() === 'false' && usesGeometry)
      errors.push('endpoint.query.returnGeometry is false but the position is read from the geometry');
    else if (d.boundsQuery && BOUNDS_PARAMS.has(k))
      errors.push(`endpoint.query.${key} is set from the viewport when boundsQuery is on`);
    if (PLACEHOLDER.test(v))
      warnings.push(
        `endpoint.query.${key} has a viewport placeholder, which this connector does not fill: boundsQuery adds the viewport as an envelope`,
      );
  }
  if (PLACEHOLDER.test(d.endpoint.url)) errors.push('endpoint.url may not carry viewport placeholders');
  const p = d.pagination;
  if (p && p.strategy !== 'none' && p.strategy !== 'offset-limit')
    errors.push(
      `pagination.strategy ${p.strategy} does not apply: ArcGIS pages with offset-limit (resultOffset/resultRecordCount) or none`,
    );
  if (p?.strategy === 'offset-limit' && (p.offsetParam !== 'resultOffset' || p.limitParam !== 'resultRecordCount'))
    errors.push('pagination offset-limit must use offsetParam "resultOffset" and limitParam "resultRecordCount"');
  if (d.response?.format && d.response.format !== 'json')
    errors.push('response.format: ArcGIS answers JSON (GeoJSON or esriJSON)');
  if (d.response?.itemsPath || d.response?.itemsAs)
    warnings.push('response.itemsPath/itemsAs are ignored: the records are the features of the query');
  const c = d.endpoint.credential;
  if (c && !(c.as === 'query' && c.param === 'token'))
    warnings.push(
      'ArcGIS takes a token as the token query parameter (endpoint.credential { "as": "query", "param": "token" })',
    );
  const idName = propertyName(d.mapping.externalId);
  const idPath = typeof d.mapping.externalId === 'string' ? d.mapping.externalId : d.mapping.externalId.path;
  if (idPath === 'id' || (idName && /^(objectid|fid|oid)$/i.test(idName)))
    warnings.push(
      'mapping.externalId reads the object id, which can change when a layer is republished; prefer GlobalID or a source identifier field when the layer has one',
    );
  if (!d.mapping.observedAt)
    warnings.push('mapping.observedAt is unset: every observation carries the fetch time (flag fetch-time)');
  if (!d.freshness) warnings.push("freshness is unset: the object type's default applies");
  return { ok: errors.length === 0, errors, warnings };
}

export const arcgisFeatureConnector: Connector = {
  metadata: {
    id: ARCGIS_FEATURE_CONNECTOR_ID,
    name: 'ArcGIS FeatureServer / MapServer layer',
    description:
      'Query one ArcGIS REST layer (FeatureServer or MapServer): GeoJSON or esriJSON, paged by exceededTransferLimit, optionally by viewport.',
    uses: ['endpoint', 'pagination', 'mapping'],
    dataset: 'LIVE_OBJECTS',
  },
  validate: validateArcGisFeature,
  createProvider: (d) => new ArcGisFeatureProvider(withArcGisDefaults(d)),
};
