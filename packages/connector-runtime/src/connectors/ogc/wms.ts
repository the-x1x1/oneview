import type { Observation } from '@worldview/world-model';
import {
  PollingProvider,
  ProviderError,
  type ProviderContext,
  type ProviderHealth,
  type ProviderManifest,
  type ProviderQuery,
} from '@worldview/provider-sdk';
import type { Connector, ConnectorProviderDefinition, ConnectorValidationResult } from '@worldview/connector-sdk';
import { isParsed, parseProblem, parseWmsCapabilities, type WmsCapabilities, type WmsLayer } from './capabilities.js';
import { classifyCrs } from './crs.js';
import {
  KvpParams,
  XML_ACCEPT,
  getRequest,
  hostOf,
  isTimeValue,
  joinUrl,
  manifestWithBudget,
  numberSetting,
  refuseAdvertisedUrl,
  splitEndpoint,
  stringSetting,
} from './common.js';
import type { OverlayProvider, RasterOverlay } from './overlay.js';

/**
 * WMS 1.3.0 and 1.1.1 as a raster overlay.
 *
 * The connector reads the capabilities and turns the definition's layer into a GetMap URL
 * template for the renderer (overlay.ts — a shim until the raster overlay contract
 * lands). It fetches no map image itself. `endpoint.query` names `layers` and may pin
 * `styles`, `format` (default image/png when offered), `transparent` (default TRUE),
 * `version` (default 1.3.0), `crs` and vendor parameters; `time` comes from the operator's
 * `time` setting (ISO 8601 or `current`) or the query, otherwise the server's default
 * applies. The time dimension is exposed, never iterated.
 *
 * The CRS the renderer fills in is Web Mercator when the layer offers it (EPSG:3857, or its
 * aliases 900913 and 102100), else CRS:84, else EPSG:4326 — for which WMS 1.3.0 puts
 * latitude first in BBOX (`bboxAxisOrder: 'yx'`) and 1.1.1 does not. GetMap always goes to
 * the definition's own endpoint: the URL a capabilities document advertises is often
 * plain http, an internal host or carries a `:443` suffix, and is not followed.
 */
export const WMS_CONNECTOR_ID = 'wms';

export const WMS_VERSIONS = ['1.3.0', '1.1.1'] as const;
const OWNED = ['service', 'request', 'bbox', 'width', 'height'];
/** GetMap parameters: they are not sent with GetCapabilities. */
const GETMAP_KEYS = [
  'layers',
  'styles',
  'format',
  'transparent',
  'crs',
  'srs',
  'time',
  'version',
  'bgcolor',
  'exceptions',
];
const WEB_MERCATOR_ORDER = ['EPSG:3857', 'EPSG:900913', 'EPSG:102100', 'EPSG:102113'];
/** Scale denominator of zoom 0 for 256-pixel Web Mercator tiles at the standard 0.28 mm pixel. */
export const ZOOM0_SCALE = 559_082_264.0287178;
/** Metres per pixel at zoom 0 for 256-pixel Web Mercator tiles. */
const ZOOM0_RESOLUTION = 156_543.03392804097;

export interface WmsConfig {
  version: (typeof WMS_VERSIONS)[number];
  layers: string[];
  styles?: string[];
  format?: string;
  transparent: boolean;
  crs?: string;
  time?: string;
}

export function readWmsConfig(d: ConnectorProviderDefinition): { config: WmsConfig } | { errors: string[] } {
  const errors: string[] = [];
  const q = KvpParams.from(d.endpoint?.query);
  const version = (q.get('version') ?? '1.3.0') as WmsConfig['version'];
  if (!WMS_VERSIONS.includes(version))
    errors.push(`version "${version}" is not supported (${WMS_VERSIONS.join(', ')})`);
  const layers = (q.get('layers') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (layers.length === 0) errors.push('endpoint.query must name the layer(s): "layers"');
  for (const k of q.keys())
    if (OWNED.includes(k.toLowerCase())) errors.push(`endpoint.query sets "${k}", which the renderer fills per tile`);
  const stylesRaw = q.get('styles');
  const styles = stylesRaw === undefined ? undefined : stylesRaw.split(',').map((s) => s.trim());
  if (styles && stylesRaw !== '' && styles.length !== layers.length)
    errors.push(`styles lists ${styles.length} value(s) for ${layers.length} layer(s)`);
  const format = q.get('format');
  if (format && !format.toLowerCase().startsWith('image/')) errors.push(`format "${format}" is not an image type`);
  const crs = q.get('crs') ?? q.get('srs');
  if (crs) {
    const k = classifyCrs(crs).kind;
    if (k !== 'webmercator' && k !== 'crs84' && k !== 'epsg4326')
      errors.push(`crs "${crs}" cannot be drawn: use EPSG:3857 (or leave it out), CRS:84 or EPSG:4326`);
  }
  const time = q.get('time');
  if (time !== undefined && !isTimeValue(time)) errors.push(`time "${time}" is not ISO 8601 or "current"`);
  const transparent = (q.get('transparent') ?? 'true').toLowerCase() !== 'false';
  if (errors.length) return { errors };
  const config: WmsConfig = { version, layers, transparent };
  if (styles && stylesRaw !== '') config.styles = styles;
  if (format) config.format = format;
  if (crs) config.crs = crs;
  if (time !== undefined) config.time = time;
  return { config };
}

export function overlayWarnings(d: ConnectorProviderDefinition): string[] {
  const warnings: string[] = [];
  if (d.websocket) warnings.push('websocket is ignored by this connector');
  if (d.pagination && d.pagination.strategy !== 'none') warnings.push('pagination is ignored by an overlay connector');
  if (d.boundsQuery) warnings.push('boundsQuery is ignored: the renderer asks for the tiles it draws');
  if (d.response) warnings.push('response is ignored by an overlay connector');
  const m = d.mapping;
  if (m.observedAt || m.position || m.geometry || m.labels || m.properties || m.motion || m.filter)
    warnings.push(
      'the mapping is not applied: an overlay produces no observations (only mapping.externalId is required by the schema)',
    );
  if (d.endpoint?.credential)
    warnings.push(
      'the credential is attached to the capabilities request only; tile requests need the raster overlay contract to carry it',
    );
  return warnings;
}

export function validateWms(d: ConnectorProviderDefinition): ConnectorValidationResult {
  const errors: string[] = [];
  if (!d.endpoint) errors.push('endpoint is required');
  const r = readWmsConfig(d);
  if ('errors' in r) errors.push(...r.errors);
  return { ok: errors.length === 0, errors, warnings: overlayWarnings(d) };
}

/** Zoom levels from WMS 1.3.0 scale denominators or a 1.1.1 ScaleHint (the ground size of a pixel's diagonal). */
export function zoomRange(layer: WmsLayer): { minZoom?: number; maxZoom?: number } {
  const out: { minZoom?: number; maxZoom?: number } = {};
  const clampZ = (z: number) => Math.min(24, Math.max(0, z));
  if (layer.maxScaleDenominator !== undefined && layer.maxScaleDenominator > 0)
    out.minZoom = clampZ(Math.floor(Math.log2(ZOOM0_SCALE / layer.maxScaleDenominator)));
  if (layer.minScaleDenominator !== undefined && layer.minScaleDenominator > 0)
    out.maxZoom = clampZ(Math.ceil(Math.log2(ZOOM0_SCALE / layer.minScaleDenominator)));
  if (layer.scaleHint) {
    const toZoom = (diag: number) => Math.log2(ZOOM0_RESOLUTION / (diag / Math.SQRT2));
    if (layer.scaleHint.max !== undefined && layer.scaleHint.max > 0 && out.minZoom === undefined)
      out.minZoom = clampZ(Math.floor(toZoom(layer.scaleHint.max)));
    if (layer.scaleHint.min !== undefined && layer.scaleHint.min > 0 && out.maxZoom === undefined)
      out.maxZoom = clampZ(Math.ceil(toZoom(layer.scaleHint.min)));
  }
  return out;
}

export class WmsProvider extends PollingProvider implements OverlayProvider {
  readonly manifest: ProviderManifest;
  readonly config: WmsConfig;
  private current: RasterOverlay | undefined;
  private notes: string[] = [];

  constructor(readonly definition: ConnectorProviderDefinition) {
    super();
    if (!definition.endpoint) throw new Error(`${definition.id}: the WMS connector needs an endpoint`);
    const r = readWmsConfig(definition);
    if ('errors' in r) throw new Error(`${definition.id}: ${r.errors.join('; ')}`);
    this.config = r.config;
    this.manifest = manifestWithBudget(definition, 'OGC WMS', 1);
  }

  protected override async onInitialize(_context: ProviderContext): Promise<void> {
    /* the capabilities are read with the first poll */
  }

  overlay(): RasterOverlay | undefined {
    return this.current;
  }

  capabilitiesUrl(): string {
    const { base, params } = splitEndpoint(this.definition.endpoint!.url);
    for (const [k, v] of Object.entries(this.definition.endpoint!.query ?? {}))
      if (!GETMAP_KEYS.includes(k.toLowerCase())) params.set(k, String(v));
    params.set('SERVICE', 'WMS').set('REQUEST', 'GetCapabilities').set('VERSION', this.config.version);
    return joinUrl(base, params);
  }

  protected async fetchOnce(request: ProviderQuery): Promise<{ observations: Observation[]; cacheAgeMs?: number }> {
    if (request.signal.aborted) throw new ProviderError('CANCELLED', 'cancelled before request');
    const url = this.capabilitiesUrl();
    const res = await this.context.http.request({
      ...getRequest(this.definition, this.manifest, url, XML_ACCEPT),
      signal: request.signal,
      cacheKey: url,
    });
    const caps = parseWmsCapabilities(res.text());
    if (!isParsed(caps)) {
      res.invalidate();
      throw new ProviderError('MALFORMED', `${this.definition.id}: ${parseProblem(caps)}`, { retryable: false });
    }
    const settings = await this.context.settings.get();
    try {
      this.current = this.buildOverlay(caps, settings);
    } catch (err) {
      res.invalidate();
      throw err;
    }
    return { observations: [], cacheAgeMs: res.ageMs };
  }

  /** The overlay descriptor for this definition from a capabilities document (throws MALFORMED when it cannot be drawn). */
  buildOverlay(caps: WmsCapabilities, settings: Record<string, unknown>): RasterOverlay {
    const fail = (msg: string) => new ProviderError('MALFORMED', `${this.definition.id}: ${msg}`, { retryable: false });
    const notes: string[] = [];
    const layers: WmsLayer[] = [];
    for (const name of this.config.layers) {
      const layer = caps.layers.find((l) => l.name === name);
      if (!layer) {
        const named = caps.layers.filter((l) => l.name).map((l) => l.name!);
        throw fail(
          `layer "${name}" is not in the capabilities (named layers: ${named.slice(0, 8).join(', ')}${named.length > 8 ? ', …' : ''})`,
        );
      }
      layers.push(layer);
    }
    const first = layers[0]!;
    // The CRS every requested layer offers, in order of preference.
    const offered = (crs: string) => layers.every((l) => l.crs.some((c) => c.toUpperCase() === crs.toUpperCase()));
    let crs: string | undefined;
    if (this.config.crs) {
      if (!offered(this.config.crs)) throw fail(`the layer does not offer ${this.config.crs}`);
      crs = this.config.crs;
    } else {
      crs =
        WEB_MERCATOR_ORDER.find(offered) ??
        (caps.version === '1.3.0' && offered('CRS:84') ? 'CRS:84' : undefined) ??
        (offered('EPSG:4326') ? 'EPSG:4326' : undefined);
    }
    if (!crs)
      throw fail(
        `layer "${first.name}" offers none of EPSG:3857, CRS:84, EPSG:4326 (it offers ${first.crs.slice(0, 8).join(', ')})`,
      );
    const info = classifyCrs(crs);
    const bboxAxisOrder: 'xy' | 'yx' = caps.version === '1.3.0' && info.kind === 'epsg4326' ? 'yx' : 'xy';

    let format = this.config.format;
    if (
      format &&
      caps.getMapFormats.length &&
      !caps.getMapFormats.some((f) => f.toLowerCase() === format!.toLowerCase())
    )
      throw fail(`format ${format} is not offered (GetMap offers ${caps.getMapFormats.join(', ')})`);
    if (!format)
      format =
        caps.getMapFormats.find((f) => f.toLowerCase() === 'image/png') ??
        caps.getMapFormats.find((f) => f.toLowerCase().startsWith('image/png')) ??
        caps.getMapFormats.find((f) => f.toLowerCase().startsWith('image/')) ??
        'image/png';

    const styles = this.config.styles ?? layers.map(() => '');
    styles.forEach((s, i) => {
      if (s && !layers[i]!.styles.some((x) => x.name === s))
        throw fail(
          `style "${s}" is not offered for ${layers[i]!.name} (it offers ${layers[i]!.styles.map((x) => x.name).join(', ') || 'none'})`,
        );
    });

    const timeDim = first.dimensions.find((d) => d.name === 'time');
    const timeSetting = stringSetting(settings, 'time');
    if (timeSetting && !isTimeValue(timeSetting))
      throw fail(`the time setting "${timeSetting}" is not ISO 8601 or "current"`);
    const time = timeSetting ?? this.config.time;
    if (time && !timeDim) notes.push('a time is set but the layer has no time dimension; the server may ignore it');

    const { base, params } = splitEndpoint(this.definition.endpoint!.url);
    for (const [k, v] of Object.entries(this.definition.endpoint!.query ?? {})) params.set(k, String(v));
    for (const k of ['crs', 'srs', 'time', 'styles', 'format', 'transparent', 'version', 'layers']) params.delete(k);
    params
      .set('SERVICE', 'WMS')
      .set('VERSION', caps.version)
      .set('REQUEST', 'GetMap')
      .set('LAYERS', this.config.layers.join(','))
      .set('STYLES', styles.join(','))
      .set('FORMAT', format)
      .set('TRANSPARENT', this.config.transparent ? 'TRUE' : 'FALSE')
      .set(caps.version === '1.3.0' ? 'CRS' : 'SRS', '{crs}')
      .set('BBOX', '{bbox}')
      .set('WIDTH', '{width}')
      .set('HEIGHT', '{height}');
    if (time) params.set('TIME', time);
    const urlTemplate = joinUrl(base, params, ['crs', 'bbox', 'width', 'height']);

    const host = hostOf(this.definition.endpoint!.url)!;
    const overlay: RasterOverlay = {
      id: this.definition.id,
      kind: 'wms',
      urlTemplate,
      attribution: this.definition.attribution.text,
      tileSize: 256,
      crs,
      bboxAxisOrder,
      hosts: [host],
      layer: this.config.layers.join(','),
      format,
      ...zoomRange(first),
    };
    if (styles.some(Boolean)) overlay.style = styles.join(',');
    const title = layers.length === 1 ? first.title : caps.title;
    if (title) overlay.title = title;
    if (first.bounds) overlay.bounds = first.bounds;
    const opacity = numberSetting(settings, 'opacity');
    if (opacity !== undefined && opacity >= 0 && opacity <= 1) overlay.opacity = opacity;
    const legend = first.styles.find((s) => s.name === (styles[0] || first.styles[0]?.name))?.legendUrl;
    if (legend) {
      const why = refuseAdvertisedUrl(legend, host);
      if (!why) overlay.legendUrl = legend;
      else notes.push(`the legend URL ${why} and is not offered to the renderer`);
    }
    if (timeDim || time) {
      const t: NonNullable<RasterOverlay['time']> = {};
      if (time) t.value = time;
      if (timeDim?.default) t.default = timeDim.default;
      if (timeDim?.extent) t.extent = timeDim.extent;
      overlay.time = t;
    }
    if (first.attribution?.title) overlay.serviceAttribution = first.attribution.title;
    if (caps.version !== this.config.version)
      notes.push(
        `the service answered WMS ${caps.version} to a ${this.config.version} request; the template uses ${caps.version}`,
      );
    this.notes = notes;
    return overlay;
  }

  override async health(): Promise<ProviderHealth> {
    const h = await super.health();
    if (!h.message && this.current)
      h.message = [
        `overlay ${this.current.layer} ready in ${this.current.crs}; nothing draws it until the raster overlay contract lands`,
        ...this.notes,
      ].join('; ');
    return h;
  }
}

export const wmsConnector: Connector = {
  metadata: {
    id: WMS_CONNECTOR_ID,
    name: 'OGC WMS',
    description:
      'WMS 1.3.0 / 1.1.1: reads the capabilities and publishes a GetMap template as a raster overlay (no observations).',
    uses: ['endpoint'],
    dataset: 'STATIC_FEATURES',
  },
  validate: validateWms,
  createProvider: (d) => new WmsProvider(d),
};
