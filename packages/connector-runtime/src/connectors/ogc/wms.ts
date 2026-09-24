import type { JsonValue, RasterOverlay, WmsOverlay } from '@worldview/world-model';
import { ProviderError, type ProviderManifest } from '@worldview/provider-sdk';
import type { Connector, ConnectorProviderDefinition, ConnectorValidationResult } from '@worldview/connector-sdk';
import { isParsed, parseProblem, parseWmsCapabilities, type WmsCapabilities, type WmsLayer } from './capabilities.js';
import { classifyCrs } from './crs.js';
import {
  KvpParams,
  isTimeValue,
  joinUrl,
  manifestWithBudget,
  numberSetting,
  splitEndpoint,
  stringSetting,
} from './common.js';
import { OgcOverlayProvider, overlayIdFor } from './overlay-provider.js';

/**
 * WMS 1.3.0 and 1.1.1 as a raster overlay (`RasterOverlay`, kind `wms`).
 *
 * The connector reads the capabilities and publishes the definition's layer for the
 * renderers, which build the GetMap requests themselves: the 2D map in EPSG:3857, the globe
 * in EPSG:4326. It fetches no map image. `endpoint.query` names `layers` and may pin
 * `styles`, `format` (image/png, image/jpeg or image/webp — what the renderers take;
 * default the first of those GetMap offers), `transparent` (default true), `version`
 * (default 1.3.0; a service that answers another version is taken at its word) and vendor
 * parameters, which travel with every request. `time` comes from the operator's `time`
 * setting (ISO 8601 or `current`) or the query; otherwise the server's default applies. The
 * time dimension is read and reported, never iterated.
 *
 * GetMap goes to the definition's own endpoint (the overlay's `url`), never to the URL a
 * capabilities document advertises — often plain http, an internal host or `:443`.
 */
export const WMS_CONNECTOR_ID = 'wms';

export const WMS_VERSIONS = ['1.3.0', '1.1.1'] as const;
/** GetMap formats both renderers draw (the overlay contract's list). */
export const WMS_FORMATS = ['image/png', 'image/jpeg', 'image/webp'] as const;
/** Keys the renderers set per tile, or the connector sets itself. */
const OWNED = ['service', 'request', 'bbox', 'width', 'height', 'crs', 'srs'];
/** GetMap keys the overlay carries in its own fields (not in `parameters`). */
const OVERLAY_FIELDS = ['layers', 'styles', 'format', 'transparent', 'version', 'time'];
/** The overlay contract's limits on `parameters`. */
const PARAMETER_KEY = /^[A-Za-z_][A-Za-z0-9_:-]{0,63}$/;
const MAX_PARAMETERS = 16;
/** Scale denominator of zoom 0 for 256-pixel Web Mercator tiles at the standard 0.28 mm pixel. */
export const ZOOM0_SCALE = 559_082_264.0287178;
/** Metres per pixel at zoom 0 for 256-pixel Web Mercator tiles. */
const ZOOM0_RESOLUTION = 156_543.03392804097;

export interface WmsConfig {
  version: (typeof WMS_VERSIONS)[number];
  layers: string[];
  styles?: string[];
  format?: (typeof WMS_FORMATS)[number];
  transparent: boolean;
  time?: string;
  /** Vendor parameters from the endpoint's own query string and `endpoint.query`, for every request. */
  vendor: Record<string, string>;
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
    if (OWNED.includes(k.toLowerCase()))
      errors.push(
        `endpoint.query sets "${k}", which the renderers set per tile (EPSG:3857 on the map, EPSG:4326 on the globe)`,
      );
  const stylesRaw = q.get('styles');
  const styles = stylesRaw === undefined ? undefined : stylesRaw.split(',').map((s) => s.trim());
  if (styles && stylesRaw !== '' && styles.length !== layers.length)
    errors.push(`styles lists ${styles.length} value(s) for ${layers.length} layer(s)`);
  const format = q.get('format');
  if (format && !(WMS_FORMATS as readonly string[]).includes(format.toLowerCase()))
    errors.push(`format "${format}" is not one the renderers draw (${WMS_FORMATS.join(', ')})`);
  const time = q.get('time');
  if (time !== undefined && !isTimeValue(time)) errors.push(`time "${time}" is not ISO 8601 or "current"`);
  const transparent = (q.get('transparent') ?? 'true').toLowerCase() !== 'false';
  const vendor: Record<string, string> = {};
  const fromUrl = splitEndpoint(d.endpoint?.url ?? '').params;
  for (const k of fromUrl.keys()) vendor[k] = fromUrl.get(k)!;
  for (const k of q.keys()) if (![...OWNED, ...OVERLAY_FIELDS].includes(k.toLowerCase())) vendor[k] = q.get(k)!;
  for (const [k, v] of Object.entries(vendor)) {
    if (!PARAMETER_KEY.test(k)) errors.push(`vendor parameter "${k}" is not a name the overlay can carry`);
    if (v.length > 512) errors.push(`vendor parameter "${k}" is longer than 512 characters`);
  }
  if (Object.keys(vendor).length + (time !== undefined ? 1 : 0) > MAX_PARAMETERS)
    errors.push(`more than ${MAX_PARAMETERS} vendor parameters`);
  if (errors.length) return { errors };
  const config: WmsConfig = { version, layers, transparent, vendor };
  if (styles && stylesRaw !== '') config.styles = styles;
  if (format) config.format = format.toLowerCase() as (typeof WMS_FORMATS)[number];
  if (time !== undefined) config.time = time;
  return { config };
}

export function overlayChecks(d: ConnectorProviderDefinition): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (d.websocket) warnings.push('websocket is ignored by this connector');
  if (d.pagination && d.pagination.strategy !== 'none') warnings.push('pagination is ignored by an overlay connector');
  if (d.boundsQuery) warnings.push('boundsQuery is ignored: the renderers ask for the tiles they draw');
  if (d.response) warnings.push('response is ignored by an overlay connector');
  const m = d.mapping;
  if (m.observedAt || m.position || m.geometry || m.labels || m.properties || m.motion || m.filter)
    warnings.push(
      'the mapping is not applied: an overlay produces no observations (only mapping.externalId is required by the schema)',
    );
  if (d.endpoint?.credential)
    errors.push('an overlay cannot use a credential: the renderers fetch its tiles themselves and attach none');
  return { errors, warnings };
}

export function validateWms(d: ConnectorProviderDefinition): ConnectorValidationResult {
  const { errors, warnings } = overlayChecks(d);
  if (!d.endpoint) errors.push('endpoint is required');
  const r = readWmsConfig(d);
  if ('errors' in r) errors.push(...r.errors);
  return { ok: errors.length === 0, errors, warnings };
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
  if (out.minZoom !== undefined && out.maxZoom !== undefined && out.minZoom > out.maxZoom) delete out.maxZoom;
  return out;
}

const offers = (layer: WmsLayer, test: (crs: string) => boolean) => layer.crs.some(test);

export class WmsProvider extends OgcOverlayProvider {
  readonly manifest: ProviderManifest;
  readonly config: WmsConfig;

  constructor(definition: ConnectorProviderDefinition) {
    super(definition);
    if (!definition.endpoint) throw new Error(`${definition.id}: the WMS connector needs an endpoint`);
    const r = readWmsConfig(definition);
    if ('errors' in r) throw new Error(`${definition.id}: ${r.errors.join('; ')}`);
    this.config = r.config;
    this.manifest = manifestWithBudget(definition, 'OGC WMS', 1);
  }

  capabilitiesUrl(): string {
    const { base } = splitEndpoint(this.definition.endpoint!.url);
    const params = new KvpParams();
    for (const [k, v] of Object.entries(this.config.vendor)) params.set(k, v);
    params.set('SERVICE', 'WMS').set('REQUEST', 'GetCapabilities').set('VERSION', this.config.version);
    return joinUrl(base, params);
  }

  buildOverlay(text: string, settings: Record<string, JsonValue>): RasterOverlay {
    const caps = parseWmsCapabilities(text);
    if (!isParsed(caps)) throw this.fail(parseProblem(caps)!);
    return this.overlayFrom(caps, settings);
  }

  /** The overlay for this definition from parsed capabilities (throws MALFORMED when it cannot be drawn). */
  overlayFrom(caps: WmsCapabilities, settings: Record<string, JsonValue>): WmsOverlay {
    const notes: string[] = [];
    const layers: WmsLayer[] = [];
    for (const name of this.config.layers) {
      const layer = caps.layers.find((l) => l.name === name);
      if (!layer) {
        const named = caps.layers.filter((l) => l.name).map((l) => l.name!);
        throw this.fail(
          `layer "${name}" is not in the capabilities (named layers: ${named.slice(0, 8).join(', ')}${named.length > 8 ? ', …' : ''})`,
        );
      }
      layers.push(layer);
    }
    const first = layers[0]!;

    // The 2D map asks for EPSG:3857, the globe for EPSG:4326: say which one cannot draw it.
    const all = (test: (crs: string) => boolean) => layers.every((l) => offers(l, test));
    const map3857 = all((c) => c.toUpperCase() === 'EPSG:3857');
    const mercatorAlias = all((c) => classifyCrs(c).kind === 'webmercator');
    const globe4326 = all((c) => classifyCrs(c).kind === 'epsg4326');
    if (!mercatorAlias && !globe4326)
      throw this.fail(
        `layer "${first.name}" offers neither EPSG:3857 (the map) nor EPSG:4326 (the globe) — it offers ${first.crs.slice(0, 8).join(', ')}`,
      );
    if (!map3857)
      notes.push(
        mercatorAlias
          ? 'the map asks for EPSG:3857, which the layer lists only under another name'
          : 'the map cannot draw it: the layer does not offer EPSG:3857',
      );
    if (!globe4326) notes.push('the globe cannot draw it: the layer does not offer EPSG:4326');

    const offered = caps.getMapFormats.map((f) => f.toLowerCase());
    const pinned = this.config.format;
    if (pinned && offered.length && !offered.includes(pinned))
      throw this.fail(`format ${pinned} is not offered (GetMap offers ${caps.getMapFormats.join(', ')})`);
    const format = pinned ?? (offered.length ? WMS_FORMATS.find((f) => offered.includes(f)) : 'image/png');
    if (!format)
      throw this.fail(
        `GetMap offers no format the renderers draw (${WMS_FORMATS.join(', ')}); it offers ${caps.getMapFormats.join(', ')}`,
      );

    const styles = this.config.styles ?? layers.map(() => '');
    styles.forEach((s, i) => {
      if (s && !layers[i]!.styles.some((x) => x.name === s))
        throw this.fail(
          `style "${s}" is not offered for ${layers[i]!.name} (it offers ${layers[i]!.styles.map((x) => x.name).join(', ') || 'none'})`,
        );
    });

    const timeDim = first.dimensions.find((d) => d.name === 'time');
    const timeSetting = stringSetting(settings, 'time');
    if (timeSetting && !isTimeValue(timeSetting))
      throw this.fail(`the time setting "${timeSetting}" is not ISO 8601 or "current"`);
    const time = timeSetting ?? this.config.time;
    if (time && !timeDim) notes.push('a time is set but the layer has no time dimension; the server may ignore it');
    if (timeDim)
      notes.push(
        `time ${time ?? `default ${timeDim.default ?? '(none)'}`}${timeDim.extent ? ` within ${timeDim.extent}` : ''}`,
      );

    const parameters: Record<string, string> = { ...this.config.vendor };
    if (time) parameters['TIME'] = time;
    const overlay: WmsOverlay = {
      kind: 'wms',
      id: overlayIdFor(this.definition.id, this.config.layers.join('-')),
      providerId: this.definition.id,
      name: (layers.length === 1 ? first.title : caps.title) ?? this.config.layers.join(', '),
      attribution: this.definition.attribution.text,
      url: splitEndpoint(this.definition.endpoint!.url).base,
      layers: this.config.layers.join(','),
      format,
      version: caps.version,
      transparent: this.config.transparent,
      tileSize: 256,
      ...zoomRange(first),
    };
    if (styles.some(Boolean)) overlay.styles = styles.join(',');
    if (Object.keys(parameters).length) overlay.parameters = parameters;
    if (first.bounds) overlay.bounds = first.bounds;
    const opacity = numberSetting(settings, 'opacity');
    if (opacity !== undefined && opacity >= 0 && opacity <= 1) overlay.opacity = opacity;
    if (caps.version !== this.config.version)
      notes.push(
        `the service answered WMS ${caps.version} to a ${this.config.version} request; ${caps.version} is used`,
      );
    this.notes = notes;
    return overlay;
  }

  protected describe(o: RasterOverlay): string {
    return `overlay ${o.kind === 'wms' ? o.layers : o.id} published`;
  }

  private fail(message: string): ProviderError {
    return new ProviderError('MALFORMED', `${this.definition.id}: ${message}`, { retryable: false });
  }
}

export const wmsConnector: Connector = {
  metadata: {
    id: WMS_CONNECTOR_ID,
    name: 'OGC WMS',
    description:
      'WMS 1.3.0 / 1.1.1: reads the capabilities and publishes the layer as a raster overlay both maps draw (no observations).',
    uses: ['endpoint'],
    dataset: 'STATIC_FEATURES',
  },
  validate: validateWms,
  createProvider: (d) => new WmsProvider(d),
};
