import type { Observation } from '@worldview/world-model';
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

/**
 * REST JSON (and, with `response.format`, CSV or text) over the provider host's HTTP client:
 * GET or POST, headers, query parameters, a credential attached by the host (query, header,
 * bearer or path — the provider never sees it), conditional requests and the cache, rate
 * limiting, timeouts and retries all come with `ProviderContext.http`, exactly as for a
 * hand-written provider. This connector adds pagination and the mapping.
 *
 * Bounds queries: with `boundsQuery: true`, `{south}`, `{west}`, `{north}` and `{east}` in
 * the URL or query values are replaced by the viewport the runtime passes (five-decimal
 * degrees), and the poll is skipped until there is one.
 */
export const REST_JSON_CONNECTOR_ID = 'rest-json';
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

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
  buildRequest(page: PageRequest, bounds?: ProviderQuery['bounds']): ProviderHttpRequest {
    const e = this.definition.endpoint!;
    const url = new URL(page.url ?? substitute(e.url, bounds));
    for (const [k, v] of Object.entries(e.query ?? {})) url.searchParams.set(k, substitute(String(v), bounds));
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
      const req = this.buildRequest(page, request.bounds);
      const res = await this.context.http.request({ ...req, signal: request.signal, cacheKey: req.url });
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
        origin: res.stale || res.fromCache ? 'cached' : 'live',
        sourceRef: this.definition.endpoint!.url,
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
      if (mapped.total > 0 && mapped.observations.length === 0 && mapped.filtered === 0) {
        // Everything unusable: the mapping does not fit this feed. Say so rather than serve nothing quietly.
        res.invalidate();
        assertAtomicAdmission(mapped.total, 0, `${this.definition.id} feed`);
      }
      this.lastPages = i + 1;
      page = this.paginator.next(body.body, mapped.total, i);
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
    else if (!h.message && this.lastRejected > 0)
      h.message = `${this.lastRejected} record(s) rejected by the mapping on the last fetch${this.lastFiltered ? `; ${this.lastFiltered} filtered out` : ''}`;
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

export function substitute(text: string, bounds: ProviderQuery['bounds']): string {
  if (!bounds || !text.includes('{')) return text;
  let out = text;
  for (const k of BOUNDS_KEYS) out = out.split(`{${k}}`).join(bounds[k].toFixed(5));
  return out;
}

export function validateRestJson(d: ConnectorProviderDefinition): ConnectorValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!d.endpoint) errors.push('endpoint is required');
  if (d.websocket) warnings.push('websocket is ignored by this connector');
  if (d.boundsQuery) {
    const text = `${d.endpoint?.url ?? ''} ${Object.values(d.endpoint?.query ?? {}).join(' ')}`;
    if (!BOUNDS_KEYS.some((k) => text.includes(`{${k}}`)))
      errors.push(
        'boundsQuery is set but neither the URL nor a query value has a {south}/{west}/{north}/{east} placeholder',
      );
  }
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
