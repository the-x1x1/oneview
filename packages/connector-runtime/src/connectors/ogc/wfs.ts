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
import {
  findFeatureType,
  isParsed,
  parseProblem,
  parseWfsCapabilities,
  type WfsCapabilities,
  type WfsFeatureType,
} from './capabilities.js';
import { CRS84_URN, EPSG4326_URN, classifyCrs, isCrs84, isWgs84 } from './crs.js';
import {
  GEOJSON_ACCEPT,
  KvpParams,
  XML_ACCEPT,
  getRequest,
  joinUrl,
  manifestWithBudget,
  readFeatureCollection,
  splitEndpoint,
  stringSetting,
} from './common.js';
import {
  assertWgs84,
  decideAxisOrder,
  mapFeaturePage,
  newPageState,
  repeatedPage,
  sampleCoordinates,
  type AxisDecision,
  type AxisSetting,
} from './features.js';

/**
 * WFS 2.0.0 and 1.1.0 GetFeature as GeoJSON (`outputFormat=application/json`).
 *
 * The definition's `endpoint.url` is the service (`…/wfs`); `endpoint.query` names the
 * feature type (`typeNames`, or `typeName` for 1.1.0) and may pin `version` (default
 * 2.0.0), `srsName`, `outputFormat`, a `count` page size, `sortBy`, a `cql_filter` or
 * `filter` passed through as literal strings, and vendor parameters. The connector sets
 * SERVICE, REQUEST, the paging parameters and, with `boundsQuery`, the BBOX.
 *
 * Before the first GetFeature (and every six hours) it reads the capabilities: to ask for
 * CRS84 when the feature type lists it and `urn:ogc:def:crs:EPSG::4326` otherwise (every
 * server recorded reprojects on request, including ones that list only a national grid),
 * to pick a GeoJSON output format the service names, and to know the feature type's WGS 84
 * bounds for the axis check (features.ts). A capabilities document that is too large,
 * missing or not WFS does not stop the features: the connector goes on with those
 * defaults and says so in Source Health. A network, auth or rate-limit failure does stop
 * the poll, since GetFeature would meet the same.
 *
 * Paging: `startIndex`, with the page size from `pagination` (offset-limit), a `count`
 * (`maxFeatures` for 1.1.0) in the query, or the server's default; it stops when a page is
 * empty, `numberMatched` (or GeoServer's `totalFeatures`) is reached, a page is shorter than
 * the page size asked for, or `maxPages` (default 10). A service that reports no count and
 * was asked for no page size is read in one request.
 */
export const WFS_CONNECTOR_ID = 'wfs';

export const WFS_VERSIONS = ['2.0.0', '1.1.0'] as const;
export type WfsVersion = (typeof WFS_VERSIONS)[number];

const CAPABILITIES_TTL_MS = 6 * 3600_000;
const CAPABILITIES_RETRY_MS = 30 * 60_000;
const JSON_FORMATS = [
  'application/json',
  'application/geo+json',
  'application/vnd.geo+json',
  'json',
  'geojson',
  'application/json; subtype=geojson',
];
/** Keys the connector sets itself; a definition naming one is refused. */
const OWNED = ['service', 'request', 'bbox', 'startindex'];

export interface WfsConfig {
  version: WfsVersion;
  typeName: string;
  srsName?: string;
  outputFormat?: string;
  /** The page size the definition asks for (`count`, or `maxFeatures` for 1.1.0). */
  pageSize?: number;
  maxPages: number;
  cqlFilter?: string;
}

/** The definition's WFS settings, or the reasons it has none. */
export function readWfsConfig(d: ConnectorProviderDefinition): { config: WfsConfig } | { errors: string[] } {
  const errors: string[] = [];
  const q = KvpParams.from(d.endpoint?.query);
  const version = (q.get('version') ?? '2.0.0') as WfsVersion;
  if (!WFS_VERSIONS.includes(version))
    errors.push(`version "${version}" is not supported (${WFS_VERSIONS.join(', ')})`);
  const typeName = q.get('typeNames') ?? q.get('typeName');
  if (!typeName) errors.push('endpoint.query must name the feature type (typeNames, or typeName for WFS 1.1.0)');
  else if (typeName.includes(',')) errors.push('one feature type per definition (typeNames lists several)');
  for (const k of q.keys())
    if (OWNED.includes(k.toLowerCase())) errors.push(`endpoint.query sets "${k}", which the WFS connector sets itself`);
  const srsName = q.get('srsName');
  if (srsName && !isWgs84(srsName))
    errors.push(`srsName "${srsName}" is not WGS 84 (the connector reads longitude/latitude only)`);
  const p = d.pagination;
  let pageSize: number | undefined;
  let maxPages = DEFAULT_MAX_PAGES;
  const querySize = q.get('count') ?? q.get('maxFeatures');
  if (p && p.strategy !== 'none' && p.strategy !== 'offset-limit')
    errors.push(`pagination "${p.strategy}" does not apply to WFS (use offset-limit with startIndex, or none)`);
  if (p?.strategy === 'offset-limit') {
    if (p.offsetParam.toLowerCase() !== 'startindex') errors.push('WFS pages with offsetParam "startIndex"');
    if (!['count', 'maxfeatures'].includes(p.limitParam.toLowerCase()))
      errors.push('WFS pages with limitParam "count" (2.0.0) or "maxFeatures" (1.1.0)');
    if (querySize !== undefined) errors.push('the page size is set twice (pagination.limit and a count in the query)');
    pageSize = p.limit;
    maxPages = p.maxPages ?? DEFAULT_MAX_PAGES;
  } else if (p?.strategy === 'none') maxPages = 1;
  if (querySize !== undefined) {
    const n = Number(querySize);
    if (!Number.isInteger(n) || n < 1) errors.push(`the page size "${querySize}" is not a positive integer`);
    else pageSize = n;
  }
  const cqlFilter = q.get('cql_filter');
  if (d.boundsQuery && q.has('filter'))
    errors.push('boundsQuery cannot be combined with a FILTER (WFS allows BBOX or FILTER, not both)');
  if (d.boundsQuery && cqlFilter !== undefined && !/\{(south|west|north|east)\}/.test(cqlFilter))
    errors.push(
      'boundsQuery with a cql_filter needs the viewport inside the filter (GeoServer refuses BBOX and CQL_FILTER together): e.g. "BBOX(geom,{west},{south},{east},{north},\'CRS:84\') AND …"',
    );
  if (errors.length) return { errors };
  const config: WfsConfig = { version, typeName: typeName!, maxPages };
  if (srsName) config.srsName = srsName;
  const outputFormat = q.get('outputFormat');
  if (outputFormat) config.outputFormat = outputFormat;
  if (pageSize !== undefined) config.pageSize = pageSize;
  if (cqlFilter !== undefined) config.cqlFilter = cqlFilter;
  return { config };
}

export function validateWfs(d: ConnectorProviderDefinition): ConnectorValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!d.endpoint) errors.push('endpoint is required');
  if (d.websocket) warnings.push('websocket is ignored by this connector');
  const r = readWfsConfig(d);
  if ('errors' in r) errors.push(...r.errors);
  if (d.response?.format && d.response.format !== 'json')
    errors.push('a WFS source is read as GeoJSON (response.format json)');
  if (d.response?.itemsPath && d.response.itemsPath !== 'features')
    warnings.push("response.itemsPath is ignored: the records are the FeatureCollection's features");
  const urlText = `${d.endpoint?.url ?? ''} ${Object.entries(d.endpoint?.query ?? {})
    .filter(([k]) => k.toLowerCase() !== 'cql_filter')
    .map(([, v]) => String(v))
    .join(' ')}`;
  if (/\{(south|west|north|east)\}/.test(urlText))
    errors.push('bounds placeholders belong in cql_filter only; with boundsQuery the connector writes BBOX itself');
  if (!d.mapping.observedAt)
    warnings.push('mapping.observedAt is unset: every observation carries the fetch time (flag fetch-time)');
  if (!d.freshness) warnings.push("freshness is unset: the object type's default applies");
  return { ok: errors.length === 0, errors, warnings };
}

interface CapabilitiesState {
  at: number;
  value?: WfsCapabilities;
  problem?: string;
}

export class WfsProvider extends PollingProvider {
  readonly manifest: ProviderManifest;
  readonly definition: ConnectorProviderDefinition;
  readonly config: WfsConfig;
  private readonly mapping: CompiledMapping;
  private caps: CapabilitiesState | undefined;
  private skippedReason: string | undefined;
  private lastAxis: AxisDecision | undefined;
  private lastRejected = 0;
  private lastStop: string | undefined;

  constructor(definition: ConnectorProviderDefinition) {
    super();
    if (!definition.endpoint) throw new Error(`${definition.id}: the WFS connector needs an endpoint`);
    const r = readWfsConfig(definition);
    if ('errors' in r) throw new Error(`${definition.id}: ${r.errors.join('; ')}`);
    this.config = r.config;
    this.definition = withGeoJsonDefaults(definition);
    this.manifest = manifestWithBudget(this.definition, 'WFS', 1 + this.config.maxPages);
    this.mapping = compileMapping(this.definition.mapping);
  }

  protected override async onInitialize(_context: ProviderContext): Promise<void> {
    /* capabilities are read with the first poll, through the host, like everything else */
  }

  /** The feature type's capabilities entry from the last read, if there is one. */
  featureType(): WfsFeatureType | undefined {
    return this.caps?.value ? findFeatureType(this.caps.value, this.config.typeName) : undefined;
  }

  capabilitiesUrl(): string {
    const { base, params } = splitEndpoint(this.definition.endpoint!.url);
    for (const [k, v] of Object.entries(this.definition.endpoint!.query ?? {})) {
      const key = k.toLowerCase();
      // Vendor parameters travel with every request; the GetFeature ones do not belong here.
      if (
        [
          'typenames',
          'typename',
          'srsname',
          'outputformat',
          'count',
          'maxfeatures',
          'sortby',
          'cql_filter',
          'filter',
          'propertyname',
          'version',
        ].includes(key)
      )
        continue;
      params.set(k, String(v));
    }
    params.set('SERVICE', 'WFS').set('REQUEST', 'GetCapabilities').set('VERSION', this.config.version);
    return joinUrl(base, params);
  }

  private async capabilities(signal: AbortSignal): Promise<WfsCapabilities | undefined> {
    const now = this.context.clock.now();
    if (this.caps && now - this.caps.at < (this.caps.value ? CAPABILITIES_TTL_MS : CAPABILITIES_RETRY_MS))
      return this.caps.value;
    const url = this.capabilitiesUrl();
    let text: string;
    let invalidate = () => {};
    try {
      const res = await this.context.http.request({
        ...getRequest(this.definition, this.manifest, url, XML_ACCEPT),
        signal,
        cacheKey: url,
      });
      text = res.text();
      invalidate = () => res.invalidate();
    } catch (err) {
      // What GetFeature would meet as well stops the poll; a capabilities-only problem does not.
      if (!(err instanceof ProviderError) || !['TOO_LARGE', 'HTTP_4XX', 'HTTP_5XX'].includes(err.code)) throw err;
      return this.noteCapabilities(now, `capabilities could not be read (${err.code}: ${err.message})`);
    }
    const parsed = parseWfsCapabilities(text);
    if (!isParsed(parsed)) {
      invalidate();
      return this.noteCapabilities(now, `capabilities unusable: ${parseProblem(parsed)}`);
    }
    this.caps = { at: now, value: parsed };
    return parsed;
  }

  private noteCapabilities(now: number, problem: string): undefined {
    if (this.caps?.problem !== problem) this.context.logger.warn('wfs capabilities', { problem });
    this.caps = { at: now, problem };
    return undefined;
  }

  /** CRS84 when the feature type lists it; EPSG:4326 (URN) otherwise; the definition's pin above both. */
  chooseSrsName(ft: WfsFeatureType | undefined): string {
    if (this.config.srsName) return this.config.srsName;
    const offered = ft ? [ft.defaultCrs ?? '', ...ft.otherCrs] : [];
    return offered.some((c) => c && isCrs84(c)) ? CRS84_URN : EPSG4326_URN;
  }

  chooseOutputFormat(caps: WfsCapabilities | undefined, ft: WfsFeatureType | undefined): string {
    if (this.config.outputFormat) return this.config.outputFormat;
    const offered = [...(ft?.outputFormats ?? []), ...(caps?.outputFormats ?? [])];
    for (const f of JSON_FORMATS) {
      const hit = offered.find((o) => o.toLowerCase().replace(/\s+/g, ' ') === f);
      if (hit) return hit;
    }
    // Not listed (QGIS Server answers it without naming it): ask for the standard type.
    return 'application/json';
  }

  /** The GetFeature URL for one page. */
  buildGetFeatureUrl(opts: {
    srsName: string;
    outputFormat: string;
    startIndex: number;
    bounds?: ProviderQuery['bounds'];
  }): string {
    const { base, params } = splitEndpoint(this.definition.endpoint!.url);
    for (const [k, v] of Object.entries(this.definition.endpoint!.query ?? {})) params.set(k, String(v));
    const typeKey = this.config.version === '2.0.0' ? 'typeNames' : 'typeName';
    params.delete('typeNames').delete('typeName').set(typeKey, this.config.typeName);
    params.set('SERVICE', 'WFS').set('REQUEST', 'GetFeature').set('VERSION', this.config.version);
    params.set('outputFormat', opts.outputFormat).set('srsName', opts.srsName);
    if (this.config.pageSize !== undefined) {
      params.delete('count').delete('maxFeatures');
      params.set(this.config.version === '2.0.0' ? 'count' : 'maxFeatures', String(this.config.pageSize));
    }
    if (opts.startIndex > 0) params.set('startIndex', String(opts.startIndex));
    if (opts.bounds) {
      if (this.config.cqlFilter !== undefined)
        params.set('cql_filter', substituteBounds(this.config.cqlFilter, opts.bounds));
      else params.set('bbox', wfsBbox(opts.bounds, opts.srsName));
    }
    return joinUrl(base, params);
  }

  protected async fetchOnce(request: ProviderQuery): Promise<{ observations: Observation[]; cacheAgeMs?: number }> {
    if (request.signal.aborted) throw new ProviderError('CANCELLED', 'cancelled before request');
    if (this.definition.boundsQuery && !request.bounds) {
      this.skippedReason = 'waiting for a viewport before the first request';
      return { observations: [] };
    }
    this.skippedReason = undefined;
    const caps = await this.capabilities(request.signal);
    const ft = caps ? findFeatureType(caps, this.config.typeName) : undefined;
    if (caps && !ft)
      throw new ProviderError(
        'MALFORMED',
        `${this.definition.id}: the service does not offer ${this.config.typeName} (it lists ${caps.featureTypes
          .slice(0, 8)
          .map((f) => f.name)
          .join(', ')}${caps.featureTypes.length > 8 ? ', …' : ''})`,
        { retryable: false },
      );
    const srsName = this.chooseSrsName(ft);
    const outputFormat = this.chooseOutputFormat(caps, ft);
    const settings = await this.context.settings.get();
    const axisSetting = stringSetting(settings, 'axisOrder') as AxisSetting | undefined;
    const state = newPageState();
    let axis: AxisDecision | undefined;
    let startIndex = 0;
    let cacheAgeMs = 0;
    this.lastStop = undefined;
    for (let page = 0; page < this.config.maxPages; page++) {
      const url = this.buildGetFeatureUrl({
        srsName,
        outputFormat,
        startIndex,
        ...(this.definition.boundsQuery && request.bounds ? { bounds: request.bounds } : {}),
      });
      const res = await this.context.http.request({
        ...getRequest(this.definition, this.manifest, url, GEOJSON_ACCEPT),
        signal: request.signal,
        cacheKey: url,
      });
      cacheAgeMs = Math.max(cacheAgeMs, res.ageMs);
      const fc = readFeatureCollection(res);
      if ('malformed' in fc) {
        res.invalidate();
        throw new ProviderError('MALFORMED', `${this.definition.id}: ${fc.malformed}`, { retryable: false });
      }
      const samples = sampleCoordinates(fc.features);
      try {
        assertWgs84(fc, samples, this.definition.id);
      } catch (err) {
        res.invalidate();
        throw err;
      }
      if (!axis && samples.length) {
        axis = decideAxisOrder(samples, {
          ...(axisSetting ? { setting: axisSetting } : {}),
          requestedCrs: srsName,
          ...(ft?.bounds ? { bounds: ft.bounds } : {}),
        });
        if (axis.swap) this.context.logger.info('wfs axis order swapped', { reason: axis.reason });
      }
      const r = mapFeaturePage(fc.features, state, {
        context: this.context,
        manifest: this.manifest,
        definition: this.definition,
        mapping: this.mapping,
        origin: res.stale || res.fromCache ? 'cached' : 'live',
        sourceRef: this.definition.endpoint!.url,
        ...(axis ? { swap: axis } : {}),
        invalidate: () => res.invalidate(),
      });
      if (repeatedPage(page, r)) {
        this.lastStop = `the service answered startIndex=${startIndex} with features already read (does it page?); stopped`;
        break;
      }
      const returned = fc.features.length;
      const total = fc.numberMatched ?? fc.totalFeatures;
      startIndex += returned;
      if (returned === 0) break;
      if (total !== undefined && startIndex >= total) break;
      if (this.config.pageSize !== undefined && returned < this.config.pageSize) break;
      if (this.config.pageSize === undefined && total === undefined) break;
    }
    this.lastAxis = axis;
    this.lastRejected = state.rejected;
    return { observations: state.observations, cacheAgeMs };
  }

  /** The axis decision of the last poll (for tests and diagnostics). */
  axisDecision(): AxisDecision | undefined {
    return this.lastAxis;
  }

  override async health(): Promise<ProviderHealth> {
    const h = await super.health();
    if (h.message) return h;
    if (this.skippedReason) h.message = this.skippedReason;
    else if (this.caps?.problem) h.message = `${this.caps.problem}; asking for WGS 84 without them`;
    else if (this.lastStop) h.message = this.lastStop;
    else if (this.lastRejected > 0)
      h.message = `${this.lastRejected} record(s) rejected by the mapping on the last fetch`;
    return h;
  }
}

/** WFS BBOX with its CRS, in that CRS's axis order: CRS84 longitude first, the EPSG:4326 URN latitude first. */
export function wfsBbox(b: NonNullable<ProviderQuery['bounds']>, srsName: string): string {
  const f = (n: number) => n.toFixed(5);
  const info = classifyCrs(srsName);
  if (info.kind === 'epsg4326' && info.latFirst)
    return [f(b.south), f(b.west), f(b.north), f(b.east), EPSG4326_URN].join(',');
  if (info.kind === 'epsg4326') return [f(b.west), f(b.south), f(b.east), f(b.north), srsName].join(',');
  return [f(b.west), f(b.south), f(b.east), f(b.north), CRS84_URN].join(',');
}

function substituteBounds(text: string, b: NonNullable<ProviderQuery['bounds']>): string {
  return text
    .split('{west}')
    .join(b.west.toFixed(5))
    .split('{south}')
    .join(b.south.toFixed(5))
    .split('{east}')
    .join(b.east.toFixed(5))
    .split('{north}')
    .join(b.north.toFixed(5));
}

export const wfsConnector: Connector = {
  metadata: {
    id: WFS_CONNECTOR_ID,
    name: 'OGC WFS',
    description:
      'WFS 2.0.0 / 1.1.0 GetFeature as GeoJSON: WGS 84 chosen from the capabilities, axis order checked, startIndex paging, viewport BBOX.',
    uses: ['endpoint', 'pagination', 'mapping'],
    dataset: 'STATIC_FEATURES',
  },
  validate: validateWfs,
  createProvider: (d) => new WfsProvider(d),
};
