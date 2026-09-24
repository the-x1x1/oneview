import type { GeoBounds, JsonValue } from '@worldview/world-model';
import type { ConnectorProviderDefinition } from '@worldview/connector-sdk';
import { isRecord, linkOf, type Bbox2D } from './items.js';

/**
 * STAC API item search (STAC API 1.0, item-search): what one search asks for, how it is
 * sent (a JSON body to `POST /search`, or the same parameters as a `GET /search` query),
 * and how the next page is found (`links[rel=next]`, GET or POST, with `body` and `merge`).
 *
 * The search is described once, in `endpoint.body`, in its JSON form — `collections`,
 * `limit`, `query`, `filter`, `sortby` … — and the connector adds what it owns: `bbox` from
 * the view when `boundsQuery` is set, `datetime` as a rolling window ending now, and a
 * default `limit`. An endpoint whose path ends in `/search` is an item search; anything
 * else is read as a static catalogue (static.ts).
 */
export type StacMode = 'search' | 'static';

export const DEFAULT_LIMIT = 100;
export const DAY_MS = 86_400_000;
export const DEFAULT_WINDOW_MS = 7 * DAY_MS;
export const MIN_WINDOW_MS = 3_600_000;
export const MAX_WINDOW_MS = 366 * DAY_MS;
/** A next link's body larger than this is not followed: nothing a search needs is that big. */
export const MAX_NEXT_BODY_CHARS = 64 * 1024;

/** Parameters the connector reads from `endpoint.body`, and which therefore do not belong in `endpoint.query`. */
export const SEARCH_PARAMETERS: readonly string[] = Object.freeze([
  'collections',
  'ids',
  'bbox',
  'intersects',
  'datetime',
  'limit',
  'query',
  'filter',
  'filter-lang',
  'filter-crs',
  'sortby',
  'fields',
  'token',
  'next',
]);

export function stacMode(url: string): StacMode {
  try {
    const path = new URL(url.replace('{TOKEN}', 'TOKEN')).pathname.replace(/\/+$/, '');
    return path.endsWith('/search') ? 'search' : 'static';
  } catch {
    return 'static';
  }
}

/** The definition's search, in JSON form (`endpoint.body`); an empty search when it has none. */
export function searchBody(d: ConnectorProviderDefinition): Record<string, JsonValue> {
  const b = d.endpoint?.body;
  return isRecord(b) ? { ...(b as Record<string, JsonValue>) } : {};
}

// ── time ─────────────────────────────────────────────────────────────────────

/** How a search is bounded in time: a rolling window of this many ms ending now, or a fixed STAC datetime. */
export type DatetimeSpec = { rolling: number } | { fixed: string };

const DURATION = /^P(?:(\d{1,3})D)?(?:T(\d{1,4})H)?$/;

/** `P7D`, `PT12H`, `P1DT6H` → ms; anything else → undefined. */
export function parseWindow(v: string): number | undefined {
  const m = DURATION.exec(v);
  if (!m || (m[1] === undefined && m[2] === undefined)) return undefined;
  return (Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 3_600_000;
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/i;

function isInstant(v: string): boolean {
  return INSTANT.test(v) && Number.isFinite(Date.parse(v));
}

/** A STAC datetime: one RFC 3339 instant, or `start/end` where one end may be open (`..` or empty). */
export function isStacDatetime(v: string): boolean {
  const parts = v.split('/');
  if (parts.length === 1) return isInstant(v);
  if (parts.length !== 2) return false;
  const [a = '', b = ''] = parts;
  const open = (x: string) => x === '' || x === '..';
  if (open(a) && open(b)) return false;
  return (open(a) || isInstant(a)) && (open(b) || isInstant(b));
}

/**
 * The definition's `datetime`: absent → the default rolling window (seven days); an ISO 8601
 * duration (`P30D`, `PT12H`) → a rolling window of that length; a STAC datetime or interval
 * → sent unchanged every time.
 */
export function datetimeSpec(d: ConnectorProviderDefinition): DatetimeSpec | { error: string } {
  const raw = searchBody(d)['datetime'];
  if (raw === undefined || raw === null) return { rolling: DEFAULT_WINDOW_MS };
  if (typeof raw !== 'string') return { error: 'endpoint.body.datetime must be a string' };
  const ms = parseWindow(raw);
  if (ms !== undefined) {
    if (ms < MIN_WINDOW_MS || ms > MAX_WINDOW_MS)
      return { error: `endpoint.body.datetime window ${raw} is outside one hour to 366 days` };
    return { rolling: ms };
  }
  if (isStacDatetime(raw)) return { fixed: raw };
  return {
    error: `endpoint.body.datetime "${raw.slice(0, 60)}" is neither a STAC datetime or interval nor a window such as P7D`,
  };
}

function isoSeconds(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

/** The rolling window as a closed STAC interval ending at `nowMs` (whole seconds, UTC). */
export function windowInterval(nowMs: number, windowMs: number): string {
  return `${isoSeconds(nowMs - windowMs)}/${isoSeconds(nowMs)}`;
}

// ── the view ─────────────────────────────────────────────────────────────────

const r5 = (v: number) => {
  const r = Number(v.toFixed(5));
  return r === 0 ? 0 : r;
};

/**
 * The view as search boxes. A view across the antimeridian (west > east) is searched as its
 * two halves — `[west, s, 180, n]` and `[-180, s, east, n]` — rather than as one box with
 * west > east, which the spec allows but not every server accepts.
 */
export function viewBoxes(b: GeoBounds): Bbox2D[] {
  const clampLat = (v: number) => r5(Math.max(-90, Math.min(90, v)));
  const clampLon = (v: number) => r5(Math.max(-180, Math.min(180, v)));
  const south = clampLat(Math.min(b.south, b.north));
  const north = clampLat(Math.max(b.south, b.north));
  const west = clampLon(b.west);
  const east = clampLon(b.east);
  if (west <= east) return [[west, south, east, north]];
  return [
    [west, south, 180, north],
    [-180, south, east, north],
  ];
}

// ── requests ─────────────────────────────────────────────────────────────────

export interface SearchRequest {
  method: 'GET' | 'POST';
  url: string;
  /** The JSON body (POST). */
  body?: Record<string, JsonValue>;
  /** Headers a next link asked for (already filtered to safe ones). */
  headers?: Record<string, string>;
}

/** One search's parameters in JSON form: the definition's, plus this box, this window and a default limit. */
export function searchParameters(
  base: Record<string, JsonValue>,
  opts: { box?: Bbox2D; datetime?: string },
): Record<string, JsonValue> {
  const p: Record<string, JsonValue> = { ...base };
  if (opts.box) p['bbox'] = [...opts.box];
  if (opts.datetime !== undefined) p['datetime'] = opts.datetime;
  else delete p['datetime'];
  if (p['limit'] === undefined || p['limit'] === null) p['limit'] = DEFAULT_LIMIT;
  return p;
}

/**
 * The JSON parameters as a GET query (STAC API item-search, GET form): arrays of scalars
 * comma-joined, `sortby` as `+field`/`-field`, `fields` as `include,-exclude`, other objects
 * (`intersects`, `query`, `filter`) as JSON text.
 */
export function toQuery(params: Record<string, JsonValue>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) continue;
    if (k === 'sortby' && Array.isArray(v)) {
      const terms = v.map((s) =>
        isRecord(s) && typeof s['field'] === 'string'
          ? `${String(s['direction']).toLowerCase() === 'desc' ? '-' : '+'}${s['field']}`
          : String(s),
      );
      out.push([k, terms.join(',')]);
    } else if (k === 'fields' && isRecord(v)) {
      const inc = Array.isArray(v['include']) ? v['include'].map(String) : [];
      const exc = Array.isArray(v['exclude']) ? v['exclude'].map((x) => `-${String(x)}`) : [];
      out.push([k, [...inc, ...exc].join(',')]);
    } else if (Array.isArray(v) && v.every((x) => x === null || typeof x !== 'object')) out.push([k, v.join(',')]);
    else if (typeof v === 'object') out.push([k, JSON.stringify(v)]);
    else out.push([k, String(v)]);
  }
  return out;
}

/** The first request of a search: a POST with the JSON body, or a GET with the same parameters. */
export function firstRequest(
  endpointUrl: string,
  extraQuery: Record<string, string | number | boolean> | undefined,
  params: Record<string, JsonValue>,
  method: 'GET' | 'POST',
): SearchRequest {
  const url = new URL(endpointUrl);
  for (const [k, v] of Object.entries(extraQuery ?? {})) url.searchParams.set(k, String(v));
  if (method === 'POST') return { method, url: url.toString(), body: params };
  for (const [k, v] of toQuery(params)) url.searchParams.set(k, v);
  return { method, url: url.toString() };
}

const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const HEADER_VALUE = /^[\x20-\x7e]{0,1024}$/;
/** Headers a server may not set on our next request, whatever its link says. */
const FORBIDDEN_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'origin',
  'referer',
]);

function linkHeaders(v: unknown): Record<string, string> | undefined {
  if (!isRecord(v)) return undefined;
  const out: Record<string, string> = {};
  let n = 0;
  for (const [k, value] of Object.entries(v)) {
    if (n >= 8) break;
    if (!HEADER_NAME.test(k) || FORBIDDEN_HEADERS.has(k.toLowerCase())) continue;
    if (typeof value !== 'string' || !HEADER_VALUE.test(value)) continue;
    out[k] = value;
    n++;
  }
  return n ? out : undefined;
}

export interface NextLink {
  request?: SearchRequest;
  /** A next link was there but pointed off the endpoint's origin (or was unusable), and was not followed. */
  refused?: string;
}

/**
 * The request for the page after `body`, from its `links[rel=next]`: GET the href, or POST
 * to it with the link's `body` — merged into the current body when `merge` is true — and the
 * link's `headers` (minus any that carry credentials or framing). Only the endpoint's own
 * origin is followed.
 */
export function nextRequest(body: unknown, current: SearchRequest, origin: string): NextLink {
  if (!isRecord(body)) return {};
  const link = linkOf(body, 'next');
  if (!link) return {};
  let u: URL;
  try {
    u = new URL(String(link['href']), current.url);
  } catch {
    return { refused: 'a next link that is not a URL' };
  }
  if (u.origin !== origin || u.username || u.password) return { refused: 'a next link to another origin' };
  u.hash = '';
  const method = String(link['method'] ?? 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
  const merge = link['merge'] === true;
  const request: SearchRequest = { method, url: u.toString() };
  if (method === 'POST') {
    const given = isRecord(link['body']) ? (link['body'] as Record<string, JsonValue>) : undefined;
    const next = merge ? { ...(current.body ?? {}), ...(given ?? {}) } : (given ?? current.body ?? {});
    if (JSON.stringify(next).length > MAX_NEXT_BODY_CHARS) return { refused: 'a next link with an oversized body' };
    request.body = next;
  }
  const given = linkHeaders(link['headers']);
  const headers = merge ? { ...(current.headers ?? {}), ...(given ?? {}) } : given;
  if (headers && Object.keys(headers).length) request.headers = headers;
  return { request };
}

/** Identity of a request, to stop a server that answers every page with the same next link. */
export function requestKey(r: SearchRequest): string {
  return `${r.method} ${r.url} ${r.body ? JSON.stringify(r.body) : ''}`;
}
