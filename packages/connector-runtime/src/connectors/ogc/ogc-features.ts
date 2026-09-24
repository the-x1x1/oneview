import type { Observation } from '@worldview/world-model';
import {
  PollingProvider,
  ProviderError,
  type ProviderContext,
  type ProviderHealth,
  type ProviderManifest,
  type ProviderQuery,
} from '@worldview/provider-sdk';
import {
  compileMapping,
  type CompiledMapping,
  type Connector,
  type ConnectorProviderDefinition,
  type ConnectorValidationResult,
} from '@worldview/connector-sdk';
import { withGeoJsonDefaults } from '../geojson.js';
import { DEFAULT_MAX_PAGES } from '../../pagination.js';
import { isCrs84 } from './crs.js';
import {
  GEOJSON_ACCEPT,
  KvpParams,
  getRequest,
  isTimeValue,
  joinUrl,
  manifestWithBudget,
  originOf,
  readFeatureCollection,
  splitEndpoint,
} from './common.js';
import { assertWgs84, mapFeaturePage, newPageState, repeatedPage, sampleCoordinates } from './features.js';

/**
 * OGC API – Features, Part 1 (Core): `GET /collections/{collectionId}/items`.
 *
 * The definition's `endpoint.url` is the items resource itself; `endpoint.query` may carry
 * `limit`, `datetime` (an ISO 8601 instant or interval), `f`, property filters and, for
 * Part 3 servers, `filter`/`filter-lang` — passed through as literal strings. With
 * `boundsQuery` the connector adds `bbox=west,south,east,north` (CRS84, longitude first,
 * the Part 1 default). Coordinates are CRS84 by the standard, so there is no axis question;
 * a `crs` or `bbox-crs` other than CRS84 is refused.
 *
 * Paging follows the response's `rel="next"` link, only on the endpoint's own origin and
 * never with credentials in it, adding back any definition parameter the link dropped
 * (pygeoapi's next links leave out `f=json`, for one), until there is no next link, a page
 * is empty, or `maxPages` (default 10) is reached.
 */
export const OGC_FEATURES_CONNECTOR_ID = 'ogc-features';

const ITEMS_PATH = /\/collections\/[^/?#]+\/items\/?$/;
const OWNED = ['bbox', 'offset'];

export interface OgcFeaturesConfig {
  maxPages: number;
}

export function readOgcFeaturesConfig(
  d: ConnectorProviderDefinition,
): { config: OgcFeaturesConfig } | { errors: string[] } {
  const errors: string[] = [];
  const url = d.endpoint?.url ?? '';
  const path = splitEndpoint(url).base.replace(/^[a-z]+:\/\/[^/]+/i, '');
  if (!ITEMS_PATH.test(path))
    errors.push("endpoint.url must be a collection's items resource: https://…/collections/{collectionId}/items");
  const q = KvpParams.from(d.endpoint?.query);
  for (const k of q.keys())
    if (OWNED.includes(k.toLowerCase())) errors.push(`endpoint.query sets "${k}", which the connector sets itself`);
  for (const k of ['crs', 'bbox-crs']) {
    const v = q.get(k);
    if (v !== undefined && !isCrs84(v))
      errors.push(`${k} "${v}" is not CRS84 (the connector reads longitude/latitude only)`);
  }
  const datetime = q.get('datetime');
  if (datetime !== undefined && (datetime === 'current' || !isTimeValue(datetime)))
    errors.push(`datetime "${datetime}" is not an ISO 8601 instant or interval`);
  const limit = q.get('limit');
  if (limit !== undefined && !(Number.isInteger(Number(limit)) && Number(limit) >= 1))
    errors.push(`limit "${limit}" is not a positive integer`);
  const p = d.pagination;
  let maxPages = DEFAULT_MAX_PAGES;
  if (p?.strategy === 'none') maxPages = 1;
  else if (p?.strategy === 'next-link') {
    if (p.nextLinkPath !== 'links')
      errors.push('OGC API paging follows the rel="next" entry of "links": set nextLinkPath to "links"');
    maxPages = p.maxPages ?? DEFAULT_MAX_PAGES;
  } else if (p) errors.push(`pagination "${p.strategy}" does not apply to OGC API – Features (use next-link or none)`);
  return errors.length ? { errors } : { config: { maxPages } };
}

export function validateOgcFeatures(d: ConnectorProviderDefinition): ConnectorValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!d.endpoint) errors.push('endpoint is required');
  if (d.websocket) warnings.push('websocket is ignored by this connector');
  const r = readOgcFeaturesConfig(d);
  if ('errors' in r) errors.push(...r.errors);
  if (d.response?.format && d.response.format !== 'json')
    errors.push('an OGC API – Features source is read as GeoJSON (response.format json)');
  if (d.response?.itemsPath && d.response.itemsPath !== 'features')
    warnings.push("response.itemsPath is ignored: the records are the FeatureCollection's features");
  const text = `${d.endpoint?.url ?? ''} ${Object.values(d.endpoint?.query ?? {}).join(' ')}`;
  if (/\{(south|west|north|east)\}/.test(text))
    errors.push('bounds placeholders are not used here: with boundsQuery the connector writes bbox itself');
  if (!d.mapping.observedAt)
    warnings.push('mapping.observedAt is unset: every observation carries the fetch time (flag fetch-time)');
  if (!d.freshness) warnings.push("freshness is unset: the object type's default applies");
  return { ok: errors.length === 0, errors, warnings };
}

/** The `rel="next"` link of a page, on `origin` only; undefined when there is none or it leaves. */
export function nextLink(links: unknown, origin: string, base: string): string | undefined {
  if (!Array.isArray(links)) return undefined;
  const candidates = links.filter(
    (l): l is { rel: string; href: string; type?: unknown } =>
      !!l &&
      typeof l === 'object' &&
      (l as { rel?: unknown }).rel === 'next' &&
      typeof (l as { href?: unknown }).href === 'string',
  );
  // Prefer the GeoJSON representation when a server lists several.
  const pick =
    candidates.find((l) => typeof l.type === 'string' && /geo\+json|application\/json/.test(l.type)) ??
    candidates.find((l) => l.type === undefined) ??
    candidates[0];
  if (!pick) return undefined;
  let u: URL;
  try {
    u = new URL(pick.href, base);
  } catch {
    return undefined;
  }
  if (u.origin !== origin || u.username || u.password) return undefined;
  return u.toString();
}

export class OgcFeaturesProvider extends PollingProvider {
  readonly manifest: ProviderManifest;
  readonly definition: ConnectorProviderDefinition;
  readonly config: OgcFeaturesConfig;
  private readonly mapping: CompiledMapping;
  private readonly origin: string;
  private skippedReason: string | undefined;
  private lastRejected = 0;
  private lastStop: string | undefined;

  constructor(definition: ConnectorProviderDefinition) {
    super();
    if (!definition.endpoint) throw new Error(`${definition.id}: the OGC API – Features connector needs an endpoint`);
    const r = readOgcFeaturesConfig(definition);
    if ('errors' in r) throw new Error(`${definition.id}: ${r.errors.join('; ')}`);
    this.config = r.config;
    this.definition = withGeoJsonDefaults(definition);
    this.manifest = manifestWithBudget(this.definition, 'OGC API – Features', this.config.maxPages);
    this.mapping = compileMapping(this.definition.mapping);
    this.origin = originOf(definition.endpoint.url) ?? '';
  }

  protected override async onInitialize(_context: ProviderContext): Promise<void> {
    /* nothing to read ahead: the items resource describes itself page by page */
  }

  firstPageUrl(bounds?: ProviderQuery['bounds']): string {
    const { base, params } = splitEndpoint(this.definition.endpoint!.url);
    for (const [k, v] of Object.entries(this.definition.endpoint!.query ?? {})) params.set(k, String(v));
    if (bounds)
      params.set('bbox', [bounds.west, bounds.south, bounds.east, bounds.north].map((n) => n.toFixed(5)).join(','));
    return joinUrl(base, params);
  }

  /** A next link, with any definition parameter it dropped added back (never replacing one it carries). */
  completeNextLink(link: string): string {
    const { base, params } = splitEndpoint(link);
    for (const [k, v] of Object.entries(this.definition.endpoint!.query ?? {}))
      if (!params.has(k)) params.set(k, String(v));
    return joinUrl(base, params);
  }

  protected async fetchOnce(request: ProviderQuery): Promise<{ observations: Observation[]; cacheAgeMs?: number }> {
    if (request.signal.aborted) throw new ProviderError('CANCELLED', 'cancelled before request');
    if (this.definition.boundsQuery && !request.bounds) {
      this.skippedReason = 'waiting for a viewport before the first request';
      return { observations: [] };
    }
    this.skippedReason = undefined;
    const state = newPageState();
    let url: string | undefined = this.firstPageUrl(this.definition.boundsQuery ? request.bounds : undefined);
    let cacheAgeMs = 0;
    let pages = 0;
    this.lastStop = undefined;
    while (url && pages < this.config.maxPages) {
      const res = await this.context.http.request({
        ...getRequest(this.definition, this.manifest, url, GEOJSON_ACCEPT),
        signal: request.signal,
        cacheKey: url,
      });
      pages++;
      cacheAgeMs = Math.max(cacheAgeMs, res.ageMs);
      const fc = readFeatureCollection(res);
      if ('malformed' in fc) {
        res.invalidate();
        throw new ProviderError('MALFORMED', `${this.definition.id}: ${fc.malformed}`, { retryable: false });
      }
      try {
        assertWgs84(fc, sampleCoordinates(fc.features), this.definition.id);
      } catch (err) {
        res.invalidate();
        throw err;
      }
      const r = mapFeaturePage(fc.features, state, {
        context: this.context,
        manifest: this.manifest,
        definition: this.definition,
        mapping: this.mapping,
        origin: res.stale || res.fromCache ? 'cached' : 'live',
        sourceRef: this.definition.endpoint!.url,
        invalidate: () => res.invalidate(),
      });
      if (repeatedPage(pages - 1, r)) {
        this.lastStop = 'a next link led to features already read; stopped';
        url = undefined;
        break;
      }
      if (fc.features.length === 0 || fc.numberReturned === 0) break;
      const next = nextLink(fc.links, this.origin, url);
      if (!next && Array.isArray(fc.links) && fc.links.some((l) => (l as { rel?: unknown })?.rel === 'next'))
        this.lastStop = "a next link pointed off the endpoint's origin and was not followed";
      url = next ? this.completeNextLink(next) : undefined;
    }
    if (url && pages >= this.config.maxPages)
      this.lastStop = `stopped at maxPages (${this.config.maxPages}) with more pages left`;
    this.lastRejected = state.rejected;
    return { observations: state.observations, cacheAgeMs };
  }

  override async health(): Promise<ProviderHealth> {
    const h = await super.health();
    if (h.message) return h;
    if (this.skippedReason) h.message = this.skippedReason;
    else if (this.lastStop) h.message = this.lastStop;
    else if (this.lastRejected > 0)
      h.message = `${this.lastRejected} record(s) rejected by the mapping on the last fetch`;
    return h;
  }
}

export const ogcFeaturesConnector: Connector = {
  metadata: {
    id: OGC_FEATURES_CONNECTOR_ID,
    name: 'OGC API – Features',
    description:
      'OGC API – Features items (Part 1): bbox from the viewport, datetime and limit passed through, rel="next" paging on the same origin.',
    uses: ['endpoint', 'pagination', 'mapping'],
    dataset: 'STATIC_FEATURES',
  },
  validate: validateOgcFeatures,
  createProvider: (d) => new OgcFeaturesProvider(d),
};
