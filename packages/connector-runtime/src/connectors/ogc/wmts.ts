import {
  isWebMercatorMatrixSet,
  matrixTemplate,
  type GeoBounds,
  type JsonValue,
  type RasterOverlay,
  type WmtsOverlay,
} from '@worldview/world-model';
import { ProviderError, type ProviderManifest } from '@worldview/provider-sdk';
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
  clipExtent,
  hostOf,
  isTimeValue,
  joinUrl,
  manifestWithBudget,
  numberSetting,
  parseExtent,
  refuseAdvertisedUrl,
  splitEndpoint,
  stringSetting,
} from './common.js';
import { OgcOverlayProvider, overlayIdFor, overlayName } from './overlay-provider.js';
import { overlayChecks, ZOOM0_SCALE } from './wms.js';

/**
 * WMTS 1.0.0 as a raster overlay (`RasterOverlay`, kind `wmts`).
 *
 * `endpoint.url` is the capabilities document of a RESTful service
 * (`…/WMTSCapabilities.xml`) or the KVP endpoint (`…/wmts`, which gets
 * `SERVICE=WMTS&REQUEST=GetCapabilities`). `endpoint.query` names the `layer` and may pin
 * `style` (default: the layer's default style), `tileMatrixSet` and `format` (default
 * image/png when offered); for a KVP endpoint the other query entries are vendor parameters
 * sent with every request.
 *
 * The overlay is the layer's `ResourceURL` template for tiles in the chosen format, with
 * `{Style}`, `{TileMatrixSet}` and any dimension (`{Time}`) filled in and `{TileMatrix}`,
 * `{TileRow}`, `{TileCol}` left for the renderers; without one, the KVP endpoint (the
 * definition's own for a KVP service, the advertised GetTile URL for a RESTful one). Either
 * is used only when https on exactly the definition's host.
 *
 * The tile matrix set must be Web Mercator (EPSG:3857 or an alias, 256-pixel tiles, the
 * world's top-left corner, scales on the standard zoom levels), since the globe tiles
 * WMTS in Web Mercator and the 2D map can draw nothing else. Among those, a set whose name
 * says Web Mercator comes first: the 2D map decides by the name (`isWebMercatorMatrixSet`).
 * Matrix identifiers that are not the zoom numbers go into `tileMatrixLabels`, index = zoom.
 */
export const WMTS_CONNECTOR_ID = 'wmts';

/** The tile's own keys, which the renderers fill. */
const TILE_KEYS = ['tilematrix', 'tilerow', 'tilecol'];
const OWNED = ['service', 'request', ...TILE_KEYS];
const CONFIG_KEYS = ['layer', 'style', 'tilematrixset', 'format', 'time', 'extent', 'role'];
const WORLD_CORNER = 20_037_508.342789244;
/** Matrix identifiers go into tile URLs as they are: letters, digits and `._:-` only, and not all dots. */
const MATRIX_ID = /^[A-Za-z0-9._:-]{1,64}$/;
/** The placeholders a WMTS overlay's url keeps for the renderers, in the contract's spelling. */
const RENDERER_PLACEHOLDERS: Record<string, string> = {
  tilematrix: '{TileMatrix}',
  tilerow: '{TileRow}',
  tilecol: '{TileCol}',
};

export interface WmtsConfig {
  layer: string;
  style?: string;
  tileMatrixSet?: string;
  format?: string;
  /** Where the overlay is drawn (`extent` in the query, west,south,east,north); clipped to the layer's declared bounds. */
  extent?: GeoBounds;
  /** The endpoint is a RESTful capabilities document rather than a KVP service. */
  restCapabilities: boolean;
}

export function readWmtsConfig(d: ConnectorProviderDefinition): { config: WmtsConfig } | { errors: string[] } {
  const errors: string[] = [];
  const q = KvpParams.from(d.endpoint?.query);
  const layer = q.get('layer');
  if (!layer) errors.push('endpoint.query must name the "layer"');
  for (const k of q.keys())
    if (OWNED.includes(k.toLowerCase())) errors.push(`endpoint.query sets "${k}", which the renderers fill per tile`);
  const format = q.get('format');
  if (format && !format.toLowerCase().startsWith('image/')) errors.push(`format "${format}" is not an image type`);
  const time = q.get('time');
  if (time !== undefined && !isTimeValue(time)) errors.push(`time "${time}" is not ISO 8601 or "current"`);
  const extent = parseExtent(q.get('extent'));
  if (extent && 'error' in extent) errors.push(extent.error);
  const { base, params: fromUrl } = splitEndpoint(d.endpoint?.url ?? '');
  const restCapabilities = /\.xml$/i.test(base);
  if (!restCapabilities)
    for (const k of fromUrl.keys())
      if (TILE_KEYS.includes(k.toLowerCase()))
        errors.push(`endpoint.url's query string sets "${k}", which the renderers fill per tile`);
  if (errors.length) return { errors };
  const config: WmtsConfig = { layer: layer!, restCapabilities };
  const style = q.get('style');
  const set = q.get('tileMatrixSet');
  if (style) config.style = style;
  if (set) config.tileMatrixSet = set;
  if (format) config.format = format;
  if (extent && 'bounds' in extent) config.extent = extent.bounds;
  return { config };
}

export function validateWmts(d: ConnectorProviderDefinition): ConnectorValidationResult {
  const { errors, warnings } = overlayChecks(d);
  if (!d.endpoint) errors.push('endpoint is required');
  const r = readWmtsConfig(d);
  if ('errors' in r) errors.push(...r.errors);
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
    if (!MATRIX_ID.test(m.identifier) || /^\.+$/.test(m.identifier))
      return { problem: `${set.identifier} has a matrix identifier that cannot go into a URL as it is` };
    const z = m.scaleDenominator > 0 ? Math.log2(ZOOM0_SCALE / m.scaleDenominator) : NaN;
    const zi = Math.round(z);
    if (!Number.isFinite(z) || Math.abs(z - zi) > 1e-3 || zi < 0 || zi > 30)
      return { problem: `${set.identifier} matrix ${m.identifier} is not a Web Mercator zoom level` };
    if (levels.has(zi)) return { problem: `${set.identifier} has two matrices at zoom ${zi}` };
    levels.set(zi, m.identifier);
  }
  if (levels.size === 0) return { problem: `${set.identifier} has no tile matrices` };
  return { levels };
}

export class WmtsProvider extends OgcOverlayProvider {
  readonly manifest: ProviderManifest;
  readonly config: WmtsConfig;

  constructor(definition: ConnectorProviderDefinition) {
    super(definition);
    if (!definition.endpoint) throw new Error(`${definition.id}: the WMTS connector needs an endpoint`);
    const r = readWmtsConfig(definition);
    if ('errors' in r) throw new Error(`${definition.id}: ${r.errors.join('; ')}`);
    this.config = r.config;
    this.manifest = manifestWithBudget(definition, 'OGC WMTS', 1);
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
    const vendor = this.vendorParams();
    for (const k of vendor.keys()) params.set(k, vendor.get(k)!);
    params.set('SERVICE', 'WMTS').set('REQUEST', 'GetCapabilities').set('VERSION', '1.0.0');
    return joinUrl(base, params);
  }

  buildOverlay(text: string, settings: Record<string, JsonValue>): RasterOverlay {
    const caps = parseWmtsCapabilities(text);
    if (!isParsed(caps)) throw this.fail(parseProblem(caps)!);
    return this.overlayFrom(caps, settings);
  }

  /** The overlay for this definition from parsed capabilities (throws MALFORMED when it cannot be drawn). */
  overlayFrom(caps: WmtsCapabilities, settings: Record<string, JsonValue>): WmtsOverlay {
    const notes: string[] = [];
    const layer = caps.layers.find((l) => l.identifier === this.config.layer);
    if (!layer)
      throw this.fail(
        `layer "${this.config.layer}" is not in the capabilities (layers: ${caps.layers
          .slice(0, 8)
          .map((l) => l.identifier)
          .join(', ')}${caps.layers.length > 8 ? ', …' : ''})`,
      );

    const { set, levels } = this.chooseSet(caps, layer);
    const style =
      this.config.style ??
      layer.styles.find((s) => s.isDefault)?.identifier ??
      layer.styles[0]?.identifier ??
      'default';
    if (this.config.style && layer.styles.length && !layer.styles.some((s) => s.identifier === this.config.style))
      throw this.fail(
        `style "${this.config.style}" is not offered (${layer.styles.map((s) => s.identifier).join(', ')})`,
      );
    const format =
      this.config.format ??
      layer.formats.find((f) => f.toLowerCase() === 'image/png') ??
      layer.formats.find((f) => f.toLowerCase().startsWith('image/')) ??
      layer.resourceUrls.find((u) => u.resourceType === 'tile')?.format;
    if (!format) throw this.fail(`layer "${layer.identifier}" lists no image format`);
    if (this.config.format && layer.formats.length && !layer.formats.includes(this.config.format))
      throw this.fail(`format ${this.config.format} is not offered (${layer.formats.join(', ')})`);

    const dims = this.dimensionValues(layer, settings);
    const host = hostOf(this.definition.endpoint!.url)!;
    const refuse = (what: string, url: string) => {
      const why = refuseAdvertisedUrl(url, host);
      if (why) throw this.fail(`${what} ${why}; the renderers' allow-list comes from the definition`);
    };

    let url: string;
    const resource = layer.resourceUrls.find(
      (u) => u.resourceType === 'tile' && u.format.toLowerCase() === format.toLowerCase(),
    );
    if (resource) {
      refuse('the tile template', resource.template);
      url = resource.template.replace(/\{([A-Za-z]+)\}/g, (_whole, name: string) => {
        const key = name.toLowerCase();
        const kept = RENDERER_PLACEHOLDERS[key];
        if (kept) return kept;
        if (key === 'tilematrixset') return encodeURIComponent(set.identifier);
        if (key === 'style') return encodeURIComponent(style);
        const dim = dims.get(key);
        if (dim !== undefined) return encodeURIComponent(dim);
        throw this.fail(`the tile template has a {${name}} this connector cannot fill`);
      });
      for (const p of Object.values(RENDERER_PLACEHOLDERS))
        if (!url.includes(p)) throw this.fail(`the tile template has no ${p}`);
      const vendor = this.vendorParams();
      if (vendor.keys().length) url += (url.includes('?') ? '&' : '?') + vendor.toQuery();
    } else {
      const kvp = this.config.restCapabilities ? caps.kvpGetTileUrls[0] : this.definition.endpoint!.url;
      if (!kvp)
        throw this.fail(`layer "${layer.identifier}" has no tile template and the service lists no KVP GetTile`);
      refuse('the KVP GetTile endpoint', kvp);
      const { base, params } = splitEndpoint(kvp);
      const vendor = this.vendorParams();
      for (const k of vendor.keys()) params.set(k, vendor.get(k)!);
      // The renderers add SERVICE, REQUEST, LAYER, STYLE, FORMAT, TILEMATRIXSET and the tile.
      for (const k of ['service', 'request', 'version', 'layer', 'style', 'format', 'tilematrixset']) params.delete(k);
      for (const [k, v] of dims) params.set(k, v);
      url = joinUrl(base, params);
    }
    refuse('the tile URL', url);

    const zs = [...levels.keys()].sort((a, b) => a - b);
    const minZoom = zs[0]!;
    const maxZoom = zs[zs.length - 1]!;
    const overlay: WmtsOverlay = {
      kind: 'wmts',
      id: overlayIdFor(this.definition.id, layer.identifier),
      providerId: this.definition.id,
      name: overlayName(layer.title, layer.identifier),
      attribution: this.definition.attribution.text,
      url,
      layer: layer.identifier,
      style,
      format,
      tileMatrixSet: set.identifier,
      // Verified from the capabilities (CRS, corner, scales; `webMercatorLevels`), whatever
      // the set is named — the map no longer has to tell it by the name.
      webMercator: true,
      tileSize: 256,
      minZoom,
      maxZoom,
    };
    const identity = [...levels].every(([z, id]) => id === String(z));
    if (!identity) {
      // Index = zoom. Levels the set does not have only hold their place: below its first
      // level nothing is requested (minZoom), and a level missing in between is said in Source
      // Health. They are written in the first real name's pattern (`EPSG:3857:1` gives
      // `EPSG:3857:0`), since the 2D map derives one template from the whole list.
      const firstName = /^(.*?)(\d+)$/.exec(levels.get(minZoom)!);
      const prefix = firstName && Number(firstName[2]) === minZoom ? firstName[1]! : '';
      const labels: string[] = [];
      for (let z = 0; z <= maxZoom; z++) labels.push(levels.get(z) ?? `${prefix}${z}`);
      overlay.tileMatrixLabels = labels;
      const template = matrixTemplate(labels);
      const wrong = template
        ? labels.findIndex((label, z) => z >= minZoom && template.replace('{z}', String(z)) !== label)
        : -1;
      if (!template)
        notes.push('its matrix names are not the plain zoom (zero-padded, say); the map asks for them tile by tile');
      else if (wrong >= 0)
        notes.push(
          `the map would ask for matrix "${template.replace('{z}', String(wrong))}" where the service names it "${labels[wrong]}" (the globe uses the names)`,
        );
    }
    if (zs.length !== maxZoom - minZoom + 1) notes.push('the set skips zoom levels; tiles there will be missing');
    const bounds = clipExtent(this.config.extent, layer.bounds);
    if (bounds) overlay.bounds = bounds;
    const opacity = numberSetting(settings, 'opacity');
    if (opacity !== undefined && opacity >= 0 && opacity <= 1) overlay.opacity = opacity;
    const timeDim = layer.dimensions.find((d) => d.identifier.toLowerCase() === 'time');
    if (timeDim)
      notes.push(
        `time ${dims.get('time') ?? '(none)'}${timeDim.values.length ? ` of ${timeDim.values.length} offered` : ''}`,
      );
    notes.push(`tile matrix set ${set.identifier}`);
    this.notes = notes;
    return overlay;
  }

  private chooseSet(caps: WmtsCapabilities, layer: WmtsLayer): { set: WmtsTileMatrixSet; levels: Map<number, string> } {
    const linked = layer.tileMatrixSets
      .map((id) => caps.tileMatrixSets.find((s) => s.identifier === id))
      .filter((s): s is WmtsTileMatrixSet => s !== undefined);
    if (this.config.tileMatrixSet) {
      const set = linked.find((s) => s.identifier === this.config.tileMatrixSet);
      if (!set)
        throw this.fail(`layer "${layer.identifier}" is not linked to tile matrix set "${this.config.tileMatrixSet}"`);
      const r = webMercatorLevels(set);
      if ('problem' in r) throw this.fail(r.problem);
      return { set, levels: r.levels };
    }
    const problems: string[] = [];
    const usable: Array<{ set: WmtsTileMatrixSet; levels: Map<number, string> }> = [];
    for (const set of linked) {
      const r = webMercatorLevels(set);
      if ('levels' in r) usable.push({ set, levels: r.levels });
      else problems.push(r.problem);
    }
    // Every usable set is Web Mercator by its capabilities; one named so is preferred only to
    // keep the choice stable across services that publish both.
    const pick = usable.find((u) => isWebMercatorMatrixSet(u.set.identifier)) ?? usable[0];
    if (!pick)
      throw this.fail(
        `no Web Mercator tile matrix set for "${layer.identifier}" (${problems.join('; ') || 'none linked'})`,
      );
    return pick;
  }

  /** Values for the layer's dimensions: the operator's `time` setting or the query for time, else each default. */
  private dimensionValues(layer: WmtsLayer, settings: Record<string, JsonValue>): Map<string, string> {
    const out = new Map<string, string>();
    const q = KvpParams.from(this.definition.endpoint!.query);
    for (const d of layer.dimensions) {
      const key = d.identifier.toLowerCase();
      let v = key === 'time' ? (stringSetting(settings, 'time') ?? q.get('time')) : undefined;
      if (v !== undefined && !isTimeValue(v)) throw this.fail(`the time setting "${v}" is not ISO 8601 or "current"`);
      v ??= d.default;
      if (v === undefined) throw this.fail(`dimension ${d.identifier} has no default and nothing sets it`);
      out.set(key, v);
    }
    return out;
  }

  protected describe(o: RasterOverlay): string {
    return o.kind === 'wmts'
      ? `overlay ${o.layer} published (zoom ${o.minZoom ?? 0}–${o.maxZoom ?? '?'})`
      : `overlay ${o.id} published`;
  }

  private fail(message: string): ProviderError {
    return new ProviderError('MALFORMED', `${this.definition.id}: ${message}`, { retryable: false });
  }
}

export const wmtsConnector: Connector = {
  metadata: {
    id: WMTS_CONNECTOR_ID,
    name: 'OGC WMTS',
    description:
      'WMTS 1.0.0 (RESTful or KVP): reads the capabilities and publishes the layer as a Web Mercator raster overlay (no observations).',
    uses: ['endpoint'],
    dataset: 'STATIC_FEATURES',
  },
  validate: validateWmts,
  createProvider: (d) => new WmtsProvider(d),
};
