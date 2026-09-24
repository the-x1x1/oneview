import { definitionToManifest, type ConnectorProviderDefinition } from '@worldview/connector-sdk';
import type { ProviderHttpRequest, ProviderHttpResponse, ProviderManifest } from '@worldview/provider-sdk';
import { exceptionMessage, scanXml } from './xml.js';

/**
 * What the four OGC connectors share: keyed-value-pair (KVP) requests, the credential a
 * definition names, a request budget that covers one poll, and reading a GeoJSON
 * FeatureCollection with an OGC exception recognised for what it is.
 */

/** OGC KVP parameter names are case-insensitive: one entry per name, the last `set` wins. */
export class KvpParams {
  private readonly entries = new Map<string, { key: string; value: string }>();

  static from(query: Record<string, string | number | boolean> | undefined): KvpParams {
    const p = new KvpParams();
    for (const [k, v] of Object.entries(query ?? {})) p.set(k, String(v));
    return p;
  }
  set(key: string, value: string): this {
    this.entries.set(key.toLowerCase(), { key, value });
    return this;
  }
  get(key: string): string | undefined {
    return this.entries.get(key.toLowerCase())?.value;
  }
  has(key: string): boolean {
    return this.entries.has(key.toLowerCase());
  }
  delete(key: string): this {
    this.entries.delete(key.toLowerCase());
    return this;
  }
  keys(): string[] {
    return [...this.entries.values()].map((e) => e.key);
  }
  clone(): KvpParams {
    const p = new KvpParams();
    for (const e of this.entries.values()) p.set(e.key, e.value);
    return p;
  }
  /**
   * The query string. Values are percent-encoded except for the characters OGC services
   * expect literally in list and CRS values (`,` `:` `/`), and for the `{placeholders}`
   * named — a URL template for the renderer keeps `{bbox}` as it is.
   */
  toQuery(placeholders: readonly string[] = []): string {
    const parts: string[] = [];
    for (const { key, value } of this.entries.values()) {
      let v = encodeURIComponent(value).replace(/%2C/gi, ',').replace(/%3A/gi, ':').replace(/%2F/gi, '/');
      for (const p of placeholders) v = v.split(`%7B${p}%7D`).join(`{${p}}`);
      parts.push(`${encodeURIComponent(key)}=${v}`);
    }
    return parts.join('&');
  }
}

/**
 * The endpoint's base (everything before `?`, kept verbatim so a `{TOKEN}` path credential
 * survives) and the parameters already in its query string.
 */
export function splitEndpoint(url: string): { base: string; params: KvpParams } {
  const q = url.indexOf('?');
  const hash = url.indexOf('#');
  const end = hash >= 0 ? hash : url.length;
  const base = q >= 0 ? url.slice(0, q) : url.slice(0, end);
  const params = new KvpParams();
  if (q >= 0) for (const [k, v] of new URLSearchParams(url.slice(q + 1, end))) params.set(k, v);
  return { base, params };
}

export function joinUrl(base: string, params: KvpParams, placeholders: readonly string[] = []): string {
  const qs = params.toQuery(placeholders);
  return qs ? `${base}?${qs}` : base;
}

/** The host of a URL (a `{TOKEN}` path placeholder is allowed), lower-cased; undefined if unreadable. */
export function hostOf(url: string): string | undefined {
  try {
    return new URL(url.replace('{TOKEN}', 'TOKEN')).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Why a URL a service advertised (a tile template, a KVP endpoint, a legend) may not be used,
 * or undefined when it may: https, no user or password, no `{placeholder}` anywhere in the
 * authority (a template like `https://host:{TileMatrix}/…` or `https://a{z}.host/…` would pass
 * a host check made with the placeholders filled one way and reach another host filled another),
 * and exactly the definition's host.
 */
export function refuseAdvertisedUrl(url: string, host: string): string | undefined {
  if (!url.startsWith('https://')) return 'is not https';
  const end = url.slice(8).search(/[/?#]/);
  const authority = end < 0 ? url.slice(8) : url.slice(8, 8 + end);
  if (/[{}]/.test(authority)) return 'has a placeholder in its host';
  if (authority.includes('%')) return 'has a percent-encoded host';
  if (authority.includes('@')) return 'carries a user or password';
  let u: URL;
  try {
    u = new URL(url.replace(/\{[A-Za-z]+\}/g, '0'));
  } catch {
    return 'is not a URL';
  }
  if (u.username || u.password) return 'carries a user or password';
  if (u.hostname.toLowerCase() !== host)
    return `is on ${u.hostname}, which the definition does not name (it names ${host})`;
  return undefined;
}

export function originOf(url: string): string | undefined {
  try {
    return new URL(url.replace('{TOKEN}', 'TOKEN')).origin;
  } catch {
    return undefined;
  }
}

/** The credential the definition's endpoint names, as the HTTP layer attaches it (never the secret). */
export function endpointCredential(d: ConnectorProviderDefinition): ProviderHttpRequest['credential'] | undefined {
  const c = d.endpoint?.credential;
  if (!c) return undefined;
  const ref = d.credentials?.[c.name];
  if (!ref) return undefined;
  return { key: ref.secretRef, as: c.as, ...(c.param ? { name: c.param } : {}) };
}

export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** A GET the provider host runs: the endpoint's size cap, the manifest's timeout, the credential. */
export function getRequest(
  d: ConnectorProviderDefinition,
  manifest: ProviderManifest,
  url: string,
  accept: string,
): ProviderHttpRequest {
  const req: ProviderHttpRequest = {
    url,
    method: 'GET',
    headers: { Accept: accept, ...(d.endpoint?.headers ?? {}) },
    maxBytes: d.endpoint?.maxBytes ?? DEFAULT_MAX_BYTES,
    timeoutMs: manifest.refreshPolicy.timeoutMs,
  };
  const credential = endpointCredential(d);
  if (credential) req.credential = credential;
  return req;
}

export const XML_ACCEPT = 'application/xml, text/xml;q=0.9, application/vnd.ogc.wms_xml;q=0.9, */*;q=0.1';
export const GEOJSON_ACCEPT = 'application/geo+json, application/json;q=0.9, */*;q=0.1';

/**
 * The manifest a definition amounts to, with a request budget that covers one whole poll.
 * `definitionToManifest` allows twice the cadence times the pages per minute, which at a
 * slow cadence is fewer requests than one poll makes in its first seconds (a capabilities
 * document and ten pages at a 300 s interval is eleven requests against a limit of five);
 * the host's limiter would then refuse the poll half way. The budget here is the burst
 * itself, doubled for the retry, and never below what the formula gives.
 */
export function manifestWithBudget(
  d: ConnectorProviderDefinition,
  connectorName: string,
  requestsPerPoll: number,
): ProviderManifest {
  const m = definitionToManifest(d, connectorName);
  m.refreshPolicy.maxRequestsPerMinute = Math.max(m.refreshPolicy.maxRequestsPerMinute, requestsPerPoll * 2);
  return m;
}

export interface FeatureCollectionPage {
  features: unknown[];
  numberMatched?: number;
  numberReturned?: number;
  /** GeoServer's own count. */
  totalFeatures?: number;
  links?: unknown;
  /** The GeoJSON 2008 `crs` member's name, when the service sends one. */
  crsName?: string;
}

const count = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;

/** A response body as a FeatureCollection, or why it is not one (an OGC exception says so in its own words). */
export function readFeatureCollection(res: ProviderHttpResponse): FeatureCollectionPage | { malformed: string } {
  const text = res.text();
  const first = text.search(/\S/);
  if (first < 0) return { malformed: 'the response is empty' };
  if (text[first] === '<') {
    const scanned = scanXml(text);
    const exception = 'root' in scanned ? exceptionMessage(scanned.root) : undefined;
    return exception
      ? { malformed: `the service answered with an exception: ${exception}` }
      : { malformed: 'the response is XML, not GeoJSON (does the service offer this outputFormat?)' };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { malformed: 'the response is not valid JSON' };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return { malformed: 'the response is not a GeoJSON object' };
  const o = body as Record<string, unknown>;
  if (o['type'] !== 'FeatureCollection' || !Array.isArray(o['features']))
    return { malformed: 'the response is not a GeoJSON FeatureCollection' };
  const page: FeatureCollectionPage = { features: o['features'] };
  const matched = count(o['numberMatched']);
  const returned = count(o['numberReturned']);
  const total = count(o['totalFeatures']);
  if (matched !== undefined) page.numberMatched = matched;
  if (returned !== undefined) page.numberReturned = returned;
  if (total !== undefined) page.totalFeatures = total;
  if (o['links'] !== undefined) page.links = o['links'];
  const crs = o['crs'];
  if (crs && typeof crs === 'object' && !Array.isArray(crs)) {
    const name = (crs as { properties?: { name?: unknown } }).properties?.name;
    if (typeof name === 'string' && name.length <= 256) page.crsName = name;
  }
  return page;
}

/** Settings are the operator's: a string value, or undefined when unset or not a string. */
export function stringSetting(settings: Record<string, unknown>, key: string): string | undefined {
  const v = settings[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

export function numberSetting(settings: Record<string, unknown>, key: string): number | undefined {
  const v = settings[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** ISO 8601 instant or interval (`a/b`, open ends as `..`), or `current`: a shape check, not a calendar. */
export function isTimeValue(v: string): boolean {
  if (v === 'current') return true;
  const instant = /^\d{4}(-\d{2}(-\d{2}(T\d{2}(:\d{2}(:\d{2}(\.\d{1,9})?)?)?(Z|[+-]\d{2}:?\d{2})?)?)?)?$/;
  return v.split('/').every((p) => p === '..' || p === '' || instant.test(p)) && v.length <= 64;
}
