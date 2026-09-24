import { isValidBounds, type GeoBounds } from '@worldview/world-model';
import { isLoopbackHost, isNameableHost } from '@worldview/provider-sdk';

/**
 * A Martin tile server (maplibre.org/martin) as a basemap source: the operator names the
 * URL of one of its sources, WORLDVIEW reads that source's TileJSON for the tile template,
 * zoom range, bounds and attribution, and draws the vector tiles with its own styles.
 *
 * Which URLs may be named follows the local-endpoint policy (ADR-003): a loopback address,
 * or exactly the one host the operator trusted, over http or https; anything else only
 * over https to a public name. The TileJSON is not allowed to send the renderer elsewhere:
 * every tile template must be on the same origin as the TileJSON itself, and the TileJSON
 * request does not follow redirects.
 *
 * The app's 2D styles read the Protomaps basemap schema, so a source without its layers
 * (a PostGIS table, an OpenMapTiles build) is refused with the layers it does have, rather
 * than drawn as an empty map. Attribution comes from the TileJSON or from the operator;
 * a source with neither is refused rather than shown uncredited.
 */

/** Layers the 2D styles draw from (packages/render-maplibre/src/styles). */
export const MARTIN_REQUIRED_LAYERS: readonly string[] = Object.freeze([
  'earth',
  'water',
  'roads',
  'places',
  'boundaries',
]);

export const MARTIN_TILEJSON_MAX_BYTES = 1024 * 1024;
export const MARTIN_DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ATTRIBUTION = 500;
/** TileJSON 3.0.0's default when `bounds` is absent. */
const TILEJSON_DEFAULT_BOUNDS: GeoBounds = Object.freeze({ west: -180, south: -85.0511, east: 180, north: 85.0511 });

export type MartinAccess = 'loopback' | 'trusted' | 'public';

export interface MartinSourceConfig {
  /** A Martin source's TileJSON URL, e.g. `http://127.0.0.1:3000/basemap`. */
  url: string;
  /** The one non-loopback host the operator allows over plain http (lower case). */
  trustedHost?: string;
  /** Attribution the operator states, used when the TileJSON has none. */
  attribution?: string;
}

export interface MartinBasemap {
  /** `martin-<source id>`, from the last path segment of the URL. */
  id: string;
  name: string;
  tileJsonUrl: string;
  access: MartinAccess;
  /** Tile templates with `{z}`, `{x}`, `{y}`, all on the TileJSON's origin. */
  tiles: string[];
  minZoom: number;
  maxZoom: number;
  bounds: GeoBounds;
  /** Plain text (the TileJSON's HTML reduced to its text), at most 500 characters. */
  attribution: string;
  attributionFrom: 'tilejson' | 'operator';
  vectorLayers: string[];
}

export type MartinResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/** The URL rules above, without any network. */
export function checkMartinUrl(raw: string, trustedHost?: string): MartinResult<{ url: URL; access: MartinAccess }> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: `Martin URL "${raw}" is not a URL` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return { ok: false, reason: `Martin URL must be http or https (got ${url.protocol.replace(':', '')})` };
  if (url.username || url.password) return { ok: false, reason: 'Martin URL must not carry credentials' };
  if (url.search || url.hash) return { ok: false, reason: 'Martin URL must not carry a query or a fragment' };
  const host = url.hostname.toLowerCase().replace(/\.+$/, '');
  if (isLoopbackHost(host)) return { ok: true, value: { url, access: 'loopback' } };
  const trusted = trustedHost?.trim().toLowerCase();
  if (trusted && isNameableHost(trusted) && trusted === host) return { ok: true, value: { url, access: 'trusted' } };
  if (url.protocol !== 'https:')
    return {
      ok: false,
      reason: `Martin host "${host}" is neither loopback nor the trusted host, so it must be https`,
    };
  const pub = publicHostProblem(host);
  if (pub)
    return {
      ok: false,
      reason: `Martin host "${host}" ${pub}; name it as the trusted host to use it on your network`,
    };
  return { ok: true, value: { url, access: 'public' } };
}

/**
 * Why a host is not a public name (SSRF, directive §76): private, loopback, link-local,
 * CGNAT and unspecified IPv4, IPv6 literals, private-use suffixes and single labels.
 */
export function publicHostProblem(host: string): string | undefined {
  const h = host.toLowerCase().replace(/\.+$/, '');
  if (!h) return 'is empty';
  if (h.startsWith('[') || h.includes(':')) return 'is an IPv6 literal, not a public name';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const [a, b] = h.split('.').map(Number) as [number, number];
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    )
      return 'is a private, loopback or link-local address';
    return undefined;
  }
  if (h === 'localhost' || /\.(localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa)$/.test(h))
    return 'is a private-use name';
  if (!h.includes('.')) return 'is a single label, resolved only on the local network';
  return undefined;
}

/** HTML attribution (`<a href=…>© OpenStreetMap</a>`) → its text, entities decoded, whitespace collapsed. */
export function attributionText(html: string): string {
  const entities: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    copy: '©',
    reg: '®',
    middot: '·',
  };
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
      }
      return entities[e.toLowerCase()] ?? m;
    })
    .split('')
    .map((c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f ? ' ' : c))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

function isZoom(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 30;
}

/** A TileJSON document (2.x or 3.0.0, as Martin serves it) → a basemap, or why not. */
export function parseMartinTileJson(
  json: unknown,
  source: { url: URL; access: MartinAccess; attribution?: string },
): MartinResult<MartinBasemap> {
  if (!json || typeof json !== 'object' || Array.isArray(json))
    return { ok: false, reason: 'the TileJSON is not a JSON object' };
  const t = json as Record<string, unknown>;
  if (!Array.isArray(t.tiles) || t.tiles.length === 0 || t.tiles.length > 16)
    return { ok: false, reason: 'the TileJSON has no "tiles" templates' };
  const tiles: string[] = [];
  for (const raw of t.tiles) {
    if (typeof raw !== 'string') return { ok: false, reason: 'a "tiles" entry is not a string' };
    if (!raw.includes('{z}') || !raw.includes('{x}') || !raw.includes('{y}'))
      return { ok: false, reason: `tile template "${raw}" lacks {z}, {x} or {y}` };
    let tile: URL;
    try {
      tile = new URL(raw.replace(/\{([zxy])\}/g, '0'), source.url);
    } catch {
      return { ok: false, reason: `tile template "${raw}" is not a URL` };
    }
    if (tile.origin !== source.url.origin)
      return {
        ok: false,
        reason: `tile template "${raw}" is on ${tile.origin}, not on the Martin server ${source.url.origin}; set Martin's base URL to the address WORLDVIEW uses`,
      };
    if (tile.username || tile.password) return { ok: false, reason: `tile template "${raw}" carries credentials` };
    tiles.push(new URL(raw, source.url).toString().replace(/%7B([zxy])%7D/gi, '{$1}'));
  }
  const minZoom = t.minzoom === undefined ? 0 : t.minzoom;
  const maxZoom = t.maxzoom === undefined ? 30 : t.maxzoom;
  if (!isZoom(minZoom) || !isZoom(maxZoom) || minZoom > maxZoom)
    return { ok: false, reason: 'minzoom/maxzoom are not integers 0–30 with minzoom ≤ maxzoom' };
  let bounds = TILEJSON_DEFAULT_BOUNDS;
  if (t.bounds !== undefined) {
    const b = t.bounds;
    if (!Array.isArray(b) || b.length !== 4 || b.some((n) => typeof n !== 'number' || !Number.isFinite(n)))
      return { ok: false, reason: '"bounds" is not [west, south, east, north]' };
    const [west, south, east, north] = b as [number, number, number, number];
    bounds = { west, south, east, north };
    if (!isValidBounds(bounds)) return { ok: false, reason: `"bounds" ${JSON.stringify(b)} is not a valid area` };
  }
  const layers = Array.isArray(t.vector_layers)
    ? t.vector_layers
        .map((l) => (l && typeof l === 'object' ? (l as { id?: unknown }).id : undefined))
        .filter((id): id is string => typeof id === 'string')
    : [];
  if (layers.length === 0)
    return { ok: false, reason: 'the TileJSON lists no vector_layers; only vector tiles can be a basemap here' };
  const missing = MARTIN_REQUIRED_LAYERS.filter((l) => !layers.includes(l));
  if (missing.length)
    return {
      ok: false,
      reason: `the source lacks the Protomaps basemap layers ${missing.join(', ')} (it has ${layers.slice(0, 12).join(', ')}); the app's styles draw only that schema`,
    };
  const fromTileJson = typeof t.attribution === 'string' ? attributionText(t.attribution) : '';
  const fromOperator = source.attribution ? attributionText(source.attribution) : '';
  const attribution = fromTileJson || fromOperator;
  if (!attribution)
    return {
      ok: false,
      reason: 'the TileJSON has no attribution and none was given; the map cannot be shown uncredited',
    };
  const segments = source.url.pathname.split('/').filter(Boolean);
  const sourceId = (segments[segments.length - 1] ?? 'source').toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  const name = typeof t.name === 'string' && t.name.trim() ? t.name.trim().slice(0, 120) : `Martin ${sourceId}`;
  return {
    ok: true,
    value: {
      id: `martin-${sourceId.replace(/^-+|-+$/g, '') || 'source'}`.slice(0, 64),
      name,
      tileJsonUrl: source.url.toString(),
      access: source.access,
      tiles,
      minZoom,
      maxZoom,
      bounds,
      attribution: attribution.slice(0, MAX_ATTRIBUTION),
      attributionFrom: fromTileJson ? 'tilejson' : 'operator',
      vectorLayers: layers,
    },
  };
}

export type FetchLike = (
  url: string,
  init: { redirect: 'error'; signal: AbortSignal; headers: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}>;

export interface ReadMartinOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

/** Read a response body, refusing once it passes `max` bytes. */
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<MartinResult<string>> {
  if (!body) return { ok: true, value: '' };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, reason: `the TileJSON is larger than ${max} bytes` };
    }
    chunks.push(value);
  }
  return { ok: true, value: Buffer.concat(chunks).toString('utf8') };
}

async function getJson(url: URL, opts: ReadMartinOptions): Promise<MartinResult<unknown>> {
  const fetchFn = opts.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!fetchFn) return { ok: false, reason: 'no fetch available' };
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? MARTIN_DEFAULT_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchFn(url.toString(), { redirect: 'error', signal, headers: { accept: 'application/json' } });
  } catch (err) {
    if (timeout.aborted)
      return { ok: false, reason: `${url} did not answer within ${opts.timeoutMs ?? MARTIN_DEFAULT_TIMEOUT_MS} ms` };
    return {
      ok: false,
      reason: `${url} could not be read (${err instanceof Error ? err.message : String(err)}; redirects are not followed)`,
    };
  }
  if (!res.ok) return { ok: false, reason: `${url} answered HTTP ${res.status}` };
  const body = await readCapped(res.body, opts.maxBytes ?? MARTIN_TILEJSON_MAX_BYTES);
  if (!body.ok) return body;
  try {
    return { ok: true, value: JSON.parse(body.value) as unknown };
  } catch {
    return { ok: false, reason: `${url} did not answer with JSON` };
  }
}

/** Check the URL, read the source's TileJSON, and turn it into a basemap. */
export async function readMartinBasemap(
  config: MartinSourceConfig,
  opts: ReadMartinOptions = {},
): Promise<MartinResult<MartinBasemap>> {
  const checked = checkMartinUrl(config.url, config.trustedHost);
  if (!checked.ok) return checked;
  const json = await getJson(checked.value.url, opts);
  if (!json.ok) return json;
  return parseMartinTileJson(json.value, {
    url: checked.value.url,
    access: checked.value.access,
    ...(config.attribution ? { attribution: config.attribution } : {}),
  });
}

export interface MartinCatalogEntry {
  id: string;
  name?: string;
  contentType: string;
}

/**
 * Martin's `/catalog` → its tile sources (vector ones first). Martin lists tile sources
 * under `tiles` as `{ "<id>": { "content_type": "application/x-protobuf", … } }`.
 */
export function parseMartinCatalog(json: unknown): MartinResult<MartinCatalogEntry[]> {
  const tiles = json && typeof json === 'object' ? (json as { tiles?: unknown }).tiles : undefined;
  if (!tiles || typeof tiles !== 'object' || Array.isArray(tiles))
    return { ok: false, reason: 'the catalog has no "tiles" object' };
  const out: MartinCatalogEntry[] = [];
  for (const [id, entry] of Object.entries(tiles as Record<string, unknown>).slice(0, 1000)) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(id) || !entry || typeof entry !== 'object') continue;
    const e = entry as { content_type?: unknown; name?: unknown };
    out.push({
      id,
      contentType: typeof e.content_type === 'string' ? e.content_type : 'unknown',
      ...(typeof e.name === 'string' ? { name: e.name.slice(0, 120) } : {}),
    });
  }
  const vector = (c: MartinCatalogEntry): number => (c.contentType === 'application/x-protobuf' ? 0 : 1);
  return { ok: true, value: out.sort((a, b) => vector(a) - vector(b) || a.id.localeCompare(b.id)) };
}

/** List a Martin server's tile sources; `baseUrl` is the server root (`http://127.0.0.1:3000`). */
export async function listMartinSources(
  baseUrl: string,
  trustedHost?: string,
  opts: ReadMartinOptions = {},
): Promise<MartinResult<MartinCatalogEntry[]>> {
  const checked = checkMartinUrl(baseUrl, trustedHost);
  if (!checked.ok) return checked;
  const catalog = new URL('catalog', checked.value.url.toString().replace(/\/?$/, '/'));
  const json = await getJson(catalog, opts);
  if (!json.ok) return json;
  return parseMartinCatalog(json.value);
}
