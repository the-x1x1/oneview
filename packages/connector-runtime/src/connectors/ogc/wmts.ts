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
import {
  isParsed,
  parseProblem,
  parseWmtsCapabilities,
  type WmtsCapabilities,
  type WmtsLayer,
  type WmtsTileMatrixSet,
} from './capabilities.js';
import { isWebMercator } from './crs.js';
import {
  KvpParams,
  XML_ACCEPT,
  getRequest,
  hostOf,
  isTimeValue,
  joinUrl,
  manifestWithBudget,
  numberSetting,
  splitEndpoint,
  stringSetting,
} from './common.js';
import type { OverlayProvider, RasterOverlay } from './overlay.js';
import { overlayWarnings, ZOOM0_SCALE } from './wms.js';

/**
 * WMTS 1.0.0 as a raster overlay.
 *
 * `endpoint.url` is the capabilities document of a RESTful service
 * (`…/WMTSCapabilities.xml`) or the KVP endpoint (`…/wmts`, which gets
 * `SERVICE=WMTS&REQUEST=GetCapabilities`). `endpoint.query` names the `layer` and may pin
 * `style` (default: the layer's default style), `tileMatrixSet` (default: the first linked
 * set that is Web Mercator-compatible) and `format` (default image/png when offered); for
 * a KVP endpoint the other query entries are vendor parameters sent with every request.
 *
 * Both renderers draw Web Mercator tiles, so the tile matrix set must be one: EPSG:3857 (or
 * an alias), 256-pixel tiles, the world's top-left corner, and scale denominators that are
 * zoom levels of the standard scale set. Each matrix is matched to its zoom level; when
 * the identifiers are the zoom numbers the template carries `{z}`, otherwise
 * `{tileMatrix}` and a `zToTileMatrix` table (BKG's TopPlusOpen names its levels `00`…`18`).
 * The template is the layer's `ResourceURL` for tiles in the chosen format, or a KVP GetTile
 * when the service offers no template — on the definition's own host either way, over https.
 */
export const WMTS_CONNECTOR_ID = 'wmts';

const OWNED = ['service', 'request', 'tilematrix', 'tilerow', 'tilecol'];
const CONFIG_KEYS = ['layer', 'style', 'tilematrixset', 'format', 'time'];
const WORLD_CORNER = 20_037_508.342789244;

export interface WmtsConfig {
  layer: string;
  style?: string;
  tileMatrixSet?: string;
  format?: string;
  /** The endpoint is a RESTful capabilities document rather than a KVP service. */
  restCapabilities: boolean;
}

export function readWmtsConfig(d: ConnectorProviderDefinition): { config: WmtsConfig } | { errors: string[] } {
  const errors: string[] = [];
  const q = KvpParams.from(d.endpoint?.query);
  const layer = q.get('layer');
  if (!layer) errors.push('endpoint.query must name the "layer"');
  for (const k of q.keys())
    if (OWNED.includes(k.toLowerCase())) errors.push(`endpoint.query sets "${k}", which the renderer fills per tile`);
  const format = q.get('format');
  if (format && !format.toLowerCase().startsWith('image/')) errors.push(`format "${format}" is not an image type`);
  const time = q.get('time');
  if (time !== undefined && !isTimeValue(time)) errors.push(`time "${time}" is not ISO 8601 or "current"`);
  if (errors.length) return { errors };
  const restCapabilities = /\.xml$/i.test(splitEndpoint(d.endpoint?.url ?? '').base);
  const config: WmtsConfig = { layer: layer!, restCapabilities };
  const style = q.get('style');
  const set = q.get('tileMatrixSet');
  if (style) config.style = style;
  if (set) config.tileMatrixSet = set;
  if (format) config.format = format;
  return { config };
}

export function validateWmts(d: ConnectorProviderDefinition): ConnectorValidationResult {
  const errors: string[] = [];
  if (!d.endpoint) errors.push('endpoint is required');
  const r = readWmtsConfig(d);
  if ('errors' in r) errors.push(...r.errors);
  const warnings = overlayWarnings(d);
  if ('config' in r && r.config.restCapabilities) {
    const extra = Object.keys(d.endpoint?.query ?? {}).filter((k) => !CONFIG_KEYS.includes(k.toLowerCase()));
    if (extra.length) warnings.push(`query entries ${extra.join(', ')} are not sent to a RESTful service`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

/**
 * The zoom level of each matrix of a Web Mercator-compatible set, or why the set is not
 * one. Matrices at levels the set skips are simply absent.
 */
export function webMercatorLevels(set: WmtsTileMatrixSet): { levels: Map<number, string> } | { problem: string } {
  if (!isWebMercator(set.supportedCrs))
    return { problem: `${set.identifier} is in ${set.supportedCrs}, not Web Mercator` };
  const levels = new Map<number, string>();
  for (const m of set.matrices) {
    if (m.tileWidth !== 256 || m.tileHeight !== 256)
      return { problem: `${set.identifier} has ${m.tileWidth}×${m.tileHeight} tiles (256×256 is drawn)` };
    const [x, y] = m.topLeft;
    if (Math.abs(x + WORLD_CORNER) > 1 || Math.abs(y - WORLD_CORNER) > 1)
      return { problem: `${set.identifier} matrix ${m.identifier} does not start at the world's top-left corner` };
    const z = Math.log2(ZOOM0_SCALE / m.scaleDenominator);
    const zi = Math.round(z);
    if (Math.abs(z - zi) > 1e-3 || zi < 0 || zi > 30)
      return { problem: `${set.identifier} matrix ${m.identifier} is not a Web Mercator zoom level` };
    if (levels.has(zi)) return { problem: `${set.identifier} has two matrices at zoom ${zi}` };
    levels.set(zi, m.identifier);
  }
  if (levels.size === 0) return { problem: `${set.identifier} has no tile matrices` };
  return { levels };
}

export class WmtsProvider extends PollingProvider implements OverlayProvider {
  readonly manifest: ProviderManifest;
  readonly config: WmtsConfig;
  private current: RasterOverlay | undefined;
  private notes: string[] = [];

  constructor(readonly definition: ConnectorProviderDefinition) {
    super();
    if (!definition.endpoint) throw new Error(`${definition.id}: the WMTS connector needs an endpoint`);
    const r = readWmtsConfig(definition);
    if ('errors' in r) throw new Error(`${definition.id}: ${r.errors.join('; ')}`);
    this.config = r.config;
    this.manifest = manifestWithBudget(definition, 'OGC WMTS', 1);
  }

  protected override async onInitialize(_context: ProviderContext): Promise<void> {
    /* the capabilities are read with the first poll */
  }

  overlay(): RasterOverlay | undefined {
    return this.current;
  }

  /** Vendor parameters: the query entries that are not this connector's configuration (KVP services only). */
  private vendorParams(): KvpParams {
    const p = new KvpParams();
    if (this.config.restCapabilities) return p;
    for (const [k, v] of Object.entries(this.definition.endpoint!.query ?? {}))
      if (!CONFIG_KEYS.includes(k.toLowerCase())) p.set(k, String(v));
    return p;
  }

  capabilitiesUrl(): string {
    const { base, params } = splitEndpoint(this.definition.endpoint!.url);
    if (this.config.restCapabilities) return joinUrl(base, params);
    for (const k of this.vendorParams().keys()) params.set(k, this.vendorParams().get(k)!);
    params.set('SERVICE', 'WMTS').set('REQUEST', 'GetCapabilities').set('VERSION', '1.0.0');
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
    const caps = parseWmtsCapabilities(res.text());
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

  buildOverlay(caps: WmtsCapabilities, settings: Record<string, unknown>): RasterOverlay {
    const fail = (msg: string) => new ProviderError('MALFORMED', `${this.definition.id}: ${msg}`, { retryable: false });
    const notes: string[] = [];
    const layer = caps.layers.find((l) => l.identifier === this.config.layer);
    if (!layer)
      throw fail(
        `layer "${this.config.layer}" is not in the capabilities (layers: ${caps.layers
          .slice(0, 8)
          .map((l) => l.identifier)
          .join(', ')}${caps.layers.length > 8 ? ', …' : ''})`,
      );

    const { set, levels } = this.chooseSet(caps, layer, fail);
    const style =
      this.config.style ??
      layer.styles.find((s) => s.isDefault)?.identifier ??
      layer.styles[0]?.identifier ??
      'default';
    if (this.config.style && layer.styles.length && !layer.styles.some((s) => s.identifier === this.config.style))
      throw fail(`style "${this.config.style}" is not offered (${layer.styles.map((s) => s.identifier).join(', ')})`);
    const format =
      this.config.format ??
      layer.formats.find((f) => f.toLowerCase() === 'image/png') ??
      layer.formats.find((f) => f.toLowerCase().startsWith('image/')) ??
      layer.resourceUrls.find((u) => u.resourceType === 'tile')?.format;
    if (!format) throw fail(`layer "${layer.identifier}" lists no image format`);
    if (this.config.format && layer.formats.length && !layer.formats.includes(this.config.format))
      throw fail(`format ${this.config.format} is not offered (${layer.formats.join(', ')})`);

    const identity = [...levels].every(([z, id]) => id === String(z));
    const zPlaceholder = identity ? '{z}' : '{tileMatrix}';
    const dims = this.dimensionValues(layer, settings, fail);
    const host = hostOf(this.definition.endpoint!.url)!;

    let urlTemplate: string;
    const resource = layer.resourceUrls.find(
      (u) => u.resourceType === 'tile' && u.format.toLowerCase() === format.toLowerCase(),
    );
    if (resource) {
      urlTemplate = resource.template.replace(/\{([A-Za-z]+)\}/g, (_whole, name: string) => {
        const key = name.toLowerCase();
        if (key === 'tilematrixset') return encodeURIComponent(set.identifier);
        if (key === 'tilematrix') return zPlaceholder;
        if (key === 'tilerow') return '{y}';
        if (key === 'tilecol') return '{x}';
        if (key === 'style') return encodeURIComponent(style);
        const dim = dims.get(key);
        if (dim !== undefined) return encodeURIComponent(dim);
        throw fail(`the tile template has a {${name}} this connector cannot fill`);
      });
      if (!urlTemplate.startsWith('https://')) throw fail('the tile template is not https');
      const vendor = this.vendorParams();
      if (vendor.keys().length) urlTemplate += (urlTemplate.includes('?') ? '&' : '?') + vendor.toQuery();
    } else {
      const kvp = this.config.restCapabilities ? caps.kvpGetTileUrls[0] : this.definition.endpoint!.url;
      if (!kvp) throw fail(`layer "${layer.identifier}" has no tile template and the service lists no KVP GetTile`);
      const { base, params } = splitEndpoint(kvp);
      for (const k of this.vendorParams().keys()) params.set(k, this.vendorParams().get(k)!);
      params
        .set('SERVICE', 'WMTS')
        .set('REQUEST', 'GetTile')
        .set('VERSION', '1.0.0')
        .set('LAYER', layer.identifier)
        .set('STYLE', style)
        .set('FORMAT', format)
        .set('TILEMATRIXSET', set.identifier)
        .set('TILEMATRIX', zPlaceholder)
        .set('TILEROW', '{y}')
        .set('TILECOL', '{x}');
      for (const [k, v] of dims) params.set(k, v);
      urlTemplate = joinUrl(base, params, ['z', 'tileMatrix', 'x', 'y']);
      if (!urlTemplate.startsWith('https://')) throw fail('the KVP GetTile endpoint is not https');
    }
    const tileHost = hostOf(urlTemplate.replace(/\{[A-Za-z]+\}/g, '0'));
    if (tileHost !== host)
      throw fail(
        `tiles are served from ${tileHost ?? 'an unreadable URL'}, which the definition does not name (it names ${host}); the renderer's allow-list comes from the definition`,
      );

    const zs = [...levels.keys()].sort((a, b) => a - b);
    const overlay: RasterOverlay = {
      id: this.definition.id,
      kind: 'wmts',
      urlTemplate,
      attribution: this.definition.attribution.text,
      tileSize: 256,
      minZoom: zs[0]!,
      maxZoom: zs[zs.length - 1]!,
      hosts: [host],
      layer: layer.identifier,
      style,
      format,
    };
    if (!identity) {
      const table: Array<string | null> = [];
      for (let z = 0; z <= zs[zs.length - 1]!; z++) table.push(levels.get(z) ?? null);
      overlay.zToTileMatrix = table;
    }
    if (layer.title) overlay.title = layer.title;
    if (layer.bounds) overlay.bounds = layer.bounds;
    const opacity = numberSetting(settings, 'opacity');
    if (opacity !== undefined && opacity >= 0 && opacity <= 1) overlay.opacity = opacity;
    const legend = layer.styles.find((s) => s.identifier === style)?.legendUrl;
    if (legend) {
      if (legend.startsWith('https://') && hostOf(legend) === host) overlay.legendUrl = legend;
      else notes.push('the legend is on another host or plain http and is not offered to the renderer');
    }
    const timeDim = layer.dimensions.find((d) => d.identifier.toLowerCase() === 'time');
    if (timeDim) {
      const t: NonNullable<RasterOverlay['time']> = {};
      const v = dims.get('time');
      if (v) t.value = v;
      if (timeDim.default) t.default = timeDim.default;
      if (timeDim.values.length) t.extent = timeDim.values.join(',');
      overlay.time = t;
    }
    notes.push(`tile matrix set ${set.identifier}`);
    this.notes = notes;
    return overlay;
  }

  private chooseSet(
    caps: WmtsCapabilities,
    layer: WmtsLayer,
    fail: (msg: string) => ProviderError,
  ): { set: WmtsTileMatrixSet; levels: Map<number, string> } {
    const linked = layer.tileMatrixSets
      .map((id) => caps.tileMatrixSets.find((s) => s.identifier === id))
      .filter((s): s is WmtsTileMatrixSet => s !== undefined);
    if (this.config.tileMatrixSet) {
      const set = linked.find((s) => s.identifier === this.config.tileMatrixSet);
      if (!set)
        throw fail(`layer "${layer.identifier}" is not linked to tile matrix set "${this.config.tileMatrixSet}"`);
      const r = webMercatorLevels(set);
      if ('problem' in r) throw fail(r.problem);
      return { set, levels: r.levels };
    }
    const problems: string[] = [];
    for (const set of linked) {
      const r = webMercatorLevels(set);
      if ('levels' in r) return { set, levels: r.levels };
      problems.push(r.problem);
    }
    throw fail(`no Web Mercator tile matrix set for "${layer.identifier}" (${problems.join('; ') || 'none linked'})`);
  }

  /** Values for the layer's dimensions: the operator's `time` setting or the query for time, else each default. */
  private dimensionValues(
    layer: WmtsLayer,
    settings: Record<string, unknown>,
    fail: (msg: string) => ProviderError,
  ): Map<string, string> {
    const out = new Map<string, string>();
    const q = KvpParams.from(this.definition.endpoint!.query);
    for (const d of layer.dimensions) {
      const key = d.identifier.toLowerCase();
      let v = key === 'time' ? (stringSetting(settings, 'time') ?? q.get('time')) : undefined;
      if (v !== undefined && !isTimeValue(v)) throw fail(`the time setting "${v}" is not ISO 8601 or "current"`);
      v ??= d.default;
      if (v === undefined) throw fail(`dimension ${d.identifier} has no default and nothing sets it`);
      out.set(key, v);
    }
    return out;
  }

  override async health(): Promise<ProviderHealth> {
    const h = await super.health();
    if (!h.message && this.current)
      h.message = [
        `overlay ${this.current.layer} ready (zoom ${this.current.minZoom}–${this.current.maxZoom}); nothing draws it until the raster overlay contract lands`,
        ...this.notes,
      ].join('; ');
    return h;
  }
}

export const wmtsConnector: Connector = {
  metadata: {
    id: WMTS_CONNECTOR_ID,
    name: 'OGC WMTS',
    description:
      'WMTS 1.0.0 (RESTful or KVP): reads the capabilities and publishes a Web Mercator tile template as a raster overlay (no observations).',
    uses: ['endpoint'],
    dataset: 'STATIC_FEATURES',
  },
  validate: validateWmts,
  createProvider: (d) => new WmtsProvider(d),
};
