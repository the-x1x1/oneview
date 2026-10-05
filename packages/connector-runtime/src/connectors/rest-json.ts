import { haversineMeters, type Observation } from '@worldview/world-model';
import {
  PollingProvider,
  ProviderError,
  assertAtomicAdmission,
  type ProviderContext,
  type ProviderHealth,
  type ProviderHttpRequest,
  type ProviderManifest,
  type ProviderQuery,
} from '@worldview/provider-sdk';
import {
  compileMapping,
  definitionToManifest,
  extractRecords,
  mapRecords,
  type CompiledMapping,
  type Connector,
  type ConnectorProviderDefinition,
  type ConnectorValidationResult,
  type EndpointSpec,
} from '@worldview/connector-sdk';
import { createPaginator, type PageRequest, type Paginator } from '../pagination.js';
import { parseCsv } from '../csv.js';
import { DEFAULT_MAX_BYTES } from '../shared/limits.js';
import { addUnseen, rejectedMessage, responseOrigin, warnRejected } from '../shared/mapping.js';

/**
 * REST JSON (and, with `response.format`, CSV or text) over the provider host's HTTP client:
 * GET or POST, headers, query parameters, a credential attached by the host (query, header,
 * bearer or path — the provider never sees it), conditional requests and the cache, rate
 * limiting, timeouts and retries all come with `ProviderContext.http`, exactly as for a
 * hand-written provider. This connector adds pagination and the mapping.
 *
 * Bounds queries: with `boundsQuery: true`, `{south}`, `{west}`, `{north}` and `{east}` in
 * the URL or query values are replaced by the viewport the runtime passes (five-decimal
 * degrees), and the poll is skipped until there is one. A point-and-radius source takes
 * `{lat}` and `{lon}` — where the view is centred — and `{radiusKm}`, `{radiusNm}` or
 * `{radiusM}`: the distance from there to the farthest corner or edge of the view, rounded
 * up, and no more than `boundsMaxRadiusKm` when the source has a limit (the view beyond it
 * is not covered: the part around the centre comes first, ADR-003 amendment 2026-09-23).
 */
export const REST_JSON_CONNECTOR_ID = 'rest-json';

/**
 * `new URL()` percent-encodes the braces of the `{TOKEN}` path placeholder, and the HTTP
 * client substitutes a `credential.as: "path"` secret into the literal one — so a path
 * credential threw on every request (A1, phase provider-migration). Restore it, in the path
 * only; the query is left as the URL class wrote it.
 */
function restorePathPlaceholder(url: URL, credential: EndpointSpec['credential']): string {
  if (credential?.as !== 'path') return url.toString();
  return url.origin + url.pathname.split('%7BTOKEN%7D').join('{TOKEN}') + url.search + url.hash;
}

export class RestJsonProvider extends PollingProvider {
  readonly manifest: ProviderManifest;
  private readonly mapping: CompiledMapping;
  private readonly paginator: Paginator;
  private lastRejected = 0;
  private lastFiltered = 0;
  private lastPages = 0;
  private skippedReason: string | undefined;

  constructor(
    readonly definition: ConnectorProviderDefinition,
    connectorName = 'REST JSON',
  ) {
    super();
    if (!definition.endpoint) throw new Error(`${definition.id}: the ${connectorName} connector needs an endpoint`);
    this.manifest = definitionToManifest(definition, connectorName);
    this.mapping = compileMapping(definition.mapping);
    this.paginator = createPaginator(definition.pagination, definition.endpoint.url);
  }

  protected override async onInitialize(_context: ProviderContext): Promise<void> {
    /* settings are the operator's; nothing to read yet */
  }

  /** The request for one page: the definition's endpoint plus the page's parameters. */
  buildRequest(
    page: PageRequest,
    bounds?: ProviderQuery['bounds'],
    center?: ProviderQuery['center'],
  ): ProviderHttpRequest {
    const e = this.definition.endpoint!;
    const view = viewValues(bounds, center, this.definition.boundsMaxRadiusKm);
    const url = new URL(page.url ?? substitute(e.url, view));
    for (const [k, v] of Object.entries(e.query ?? {})) url.searchParams.set(k, substitute(String(v), view));
    for (const [k, v] of Object.entries(page.query)) url.searchParams.set(k, v);
    const req: ProviderHttpRequest = {
      url: restorePathPlaceholder(url, e.credential),
      method: e.method ?? 'GET',
      headers: { Accept: acceptFor(this.definition), ...(e.headers ?? {}) },
      maxBytes: e.maxBytes ?? DEFAULT_MAX_BYTES,
      timeoutMs: this.manifest.refreshPolicy.timeoutMs,
    };
    if (e.method === 'POST' && e.body !== undefined) {
      req.body = typeof e.body === 'string' ? e.body : JSON.stringify(e.body);
      req.headers!['Content-Type'] = typeof e.body === 'string' ? 'text/plain' : 'application/json';
    }
    if (e.credential) {
      const ref = this.definition.credentials?.[e.credential.name];
      if (ref)
        req.credential = {
          key: ref.secretRef,
          as: e.credential.as,
          // `param` names the query parameter or header; a path credential always goes where `{TOKEN}` is.
          ...(e.credential.param && e.credential.as !== 'path' ? { name: e.credential.param } : {}),
        };
    }
    return req;
  }

  protected async fetchOnce(request: ProviderQuery): Promise<{ observations: Observation[]; cacheAgeMs?: number }> {
    if (request.signal.aborted) throw new ProviderError('CANCELLED', 'cancelled before request');
    if (this.definition.boundsQuery && !request.bounds) {
      this.skippedReason = 'waiting for a viewport before the first request';
      return { observations: [] };
    }
    this.skippedReason = undefined;
    const observations: Observation[] = [];
    const seen = new Set<string>();
    let rejected = 0;
    let filtered = 0;
    let total = 0;
    let cacheAgeMs = 0;
    let page: PageRequest | undefined = this.paginator.first();
    for (let i = 0; i < this.paginator.maxPages && page; i++) {
      const req = this.buildRequest(page, request.bounds, request.center);
      let res;
      try {
        res = await this.context.http.request({
          ...req,
          signal: request.signal,
          cacheKey: req.url,
          ...(this.definition.endpoint?.emptyStatus ? { emptyStatus: this.definition.endpoint.emptyStatus } : {}),
        });
      } catch (err) {
        // A status the definition says means "none right now" (GDACS: 404 when no event of
        // the type is current) is an empty answer, not a failing source.
        const status = err instanceof ProviderError ? err.httpStatus : undefined;
        if (status !== undefined && this.definition.endpoint?.emptyStatus?.includes(status)) {
          this.lastPages = i + 1;
          break;
        }
        throw err;
      }
      cacheAgeMs = Math.max(cacheAgeMs, res.ageMs);
      const body = this.parseBody(res, req.url);
      if ('malformed' in body) {
        res.invalidate();
        throw new ProviderError('MALFORMED', `${this.definition.id}: ${body.malformed}`, { retryable: false });
      }
      const receivedAt = new Date(this.context.clock.now()).toISOString();
      const mapped = mapRecords(body.records, {
        manifest: this.manifest,
        definition: this.definition,
        mapping: this.mapping,
        receivedAt,
        origin: responseOrigin(res),
        sourceRef: this.definition.endpoint!.url,
        hash: (s) => this.context.hash.sha256Hex(s),
      });
      total += mapped.total;
      filtered += mapped.filtered;
      rejected += mapped.rejected.length;
      addUnseen(mapped.observations, seen, observations);
      warnRejected(this.context.logger, mapped.rejected);
      if (mapped.total > 0 && mapped.observations.length === 0 && mapped.filtered === 0) {
        // Everything unusable: the mapping does not fit this feed. Say so rather than serve nothing quietly.
        res.invalidate();
        assertAtomicAdmission(mapped.total, 0, `${this.definition.id} feed`);
      }
      this.lastPages = i + 1;
      page = this.paginator.next(body.body, mapped.total, i, res.headers);
    }
    this.lastRejected = rejected;
    this.lastFiltered = filtered;
    if (total > 0)
      this.context.logger.debug('connector fetch', {
        records: total,
        observations: observations.length,
        filtered,
        rejected,
        pages: this.lastPages,
      });
    return { observations, cacheAgeMs };
  }

  private parseBody(
    res: { text(): string; json(): unknown },
    url: string,
  ): { records: unknown[]; body: unknown } | { malformed: string } {
    const format = this.definition.response?.format ?? 'json';
    if (format === 'csv') {
      const csv = parseCsv(res.text(), { ...(this.definition.response?.csv ?? {}) });
      if (csv.malformed) return { malformed: `not CSV (${csv.malformed})` };
      if (csv.dropped) this.context.logger.warn('csv rows dropped', { dropped: csv.dropped });
      return { records: csv.records, body: csv.records };
    }
    if (format === 'text') return { records: [{ text: res.text(), url }], body: null };
    let body: unknown;
    try {
      body = res.json();
    } catch {
      return { malformed: 'response is not valid JSON' };
    }
    const found = extractRecords(body, this.definition.response);
    if ('malformed' in found) return { malformed: found.malformed };
    return { records: found.records, body };
  }

  override async health(): Promise<ProviderHealth> {
    const h = await super.health();
    if (this.skippedReason && !h.message) h.message = this.skippedReason;
    else if (!h.message && this.lastRejected > 0) h.message = rejectedMessage(this.lastRejected, this.lastFiltered);
    return h;
  }
}

function acceptFor(d: ConnectorProviderDefinition): string {
  switch (d.response?.format) {
    case 'csv':
      return 'text/csv, text/plain;q=0.9, */*;q=0.1';
    case 'text':
      return 'text/plain, */*;q=0.1';
    default:
      return 'application/json, application/geo+json;q=0.9, */*;q=0.1';
  }
}

const BOUNDS_KEYS = ['south', 'west', 'north', 'east'] as const;
const POINT_KEYS = ['lat', 'lon'] as const;
const RADIUS_KEYS = ['radiusKm', 'radiusNm', 'radiusM'] as const;
const VIEW_KEYS = [...BOUNDS_KEYS, ...POINT_KEYS, ...RADIUS_KEYS] as const;
type ViewKey = (typeof VIEW_KEYS)[number];

/** The middle of the bounds, across 180° when west is east of east. */
function boundsMiddle(b: NonNullable<ProviderQuery['bounds']>): { latitude: number; longitude: number } {
  const east = b.east < b.west ? b.east + 360 : b.east;
  let lon = (b.west + east) / 2;
  if (lon > 180) lon -= 360;
  return { latitude: (b.south + b.north) / 2, longitude: lon };
}

/**
 * The text each view placeholder becomes: the bounds as given, the centre (the runtime's, or
 * the middle of the bounds), and the radius that reaches the farthest corner or edge midpoint
 * of the bounds from the centre, capped at `maxRadiusKm`.
 */
export function viewValues(
  bounds: ProviderQuery['bounds'],
  center?: ProviderQuery['center'],
  maxRadiusKm?: number,
): Readonly<Record<ViewKey, string>> | undefined {
  if (!bounds) return undefined;
  const c = center ?? boundsMiddle(bounds);
  const midLat = (bounds.south + bounds.north) / 2;
  const midLon = boundsMiddle(bounds).longitude;
  const reach = [
    [bounds.south, bounds.west],
    [bounds.south, bounds.east],
    [bounds.north, bounds.west],
    [bounds.north, bounds.east],
    [midLat, bounds.west],
    [midLat, bounds.east],
    [bounds.south, midLon],
    [bounds.north, midLon],
  ].reduce((m, [lat, lon]) => Math.max(m, haversineMeters(c, { latitude: lat!, longitude: lon! })), 0);
  const km = Math.max(1, Math.min(reach / 1000, maxRadiusKm ?? Number.POSITIVE_INFINITY));
  return {
    south: bounds.south.toFixed(5),
    west: bounds.west.toFixed(5),
    north: bounds.north.toFixed(5),
    east: bounds.east.toFixed(5),
    lat: c.latitude.toFixed(5),
    lon: c.longitude.toFixed(5),
    radiusKm: String(Math.ceil(km)),
    radiusNm: String(Math.ceil(km / 1.852)),
    radiusM: String(Math.ceil(km * 1000)),
  };
}

export function substitute(text: string, view: Readonly<Record<ViewKey, string>> | undefined): string {
  if (!view || !text.includes('{')) return text;
  let out = text;
  for (const k of VIEW_KEYS) out = out.split(`{${k}}`).join(view[k]);
  return out;
}

export function validateRestJson(d: ConnectorProviderDefinition): ConnectorValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!d.endpoint) errors.push('endpoint is required');
  if (d.websocket) warnings.push('websocket is ignored by this connector');
  const text = `${d.endpoint?.url ?? ''} ${Object.values(d.endpoint?.query ?? {}).join(' ')}`;
  const has = (keys: readonly string[]) => keys.some((k) => text.includes(`{${k}}`));
  if (d.boundsQuery) {
    if (!has(VIEW_KEYS))
      errors.push(
        'boundsQuery is set but neither the URL nor a query value has a view placeholder ({south}/{west}/{north}/{east}, or {lat}/{lon} with {radiusKm}/{radiusNm}/{radiusM})',
      );
    if (has(RADIUS_KEYS) && !has(POINT_KEYS)) warnings.push('a radius placeholder without {lat}/{lon}: around what?');
  } else if (has(VIEW_KEYS)) {
    warnings.push('the endpoint has view placeholders but boundsQuery is not set: they are sent as written');
  }
  if (d.boundsMaxRadiusKm !== undefined && !has(RADIUS_KEYS))
    warnings.push('boundsMaxRadiusKm is set but no {radiusKm}/{radiusNm}/{radiusM} placeholder uses it');
  if (d.pagination?.strategy === 'next-link' && !d.endpoint) errors.push('next-link pagination needs an endpoint');
  if ((d.response?.format ?? 'json') === 'csv' && d.response?.itemsPath)
    warnings.push('response.itemsPath is ignored for CSV');
  if (!d.mapping.observedAt)
    warnings.push('mapping.observedAt is unset: every observation carries the fetch time (flag fetch-time)');
  if (!d.freshness) warnings.push("freshness is unset: the object type's default applies");
  return { ok: errors.length === 0, errors, warnings };
}

export const restJsonConnector: Connector = {
  metadata: {
    id: REST_JSON_CONNECTOR_ID,
    name: 'REST JSON',
    description: 'Poll an HTTPS endpoint that answers JSON (or CSV / text), page through it, map its records.',
    uses: ['endpoint', 'pagination', 'response', 'mapping'],
    dataset: 'LIVE_OBJECTS',
  },
  validate: validateRestJson,
  createProvider: (d) => new RestJsonProvider(d),
};
