import { ObjectTypes, s, type JsonValue, type Schema } from '@worldview/world-model';
import {
  OGR_LAYER_NAME,
  checkRelativePath,
  type ProviderDataPolicy,
  type ProviderManifest,
  type ProviderSettingDefinition,
} from '@worldview/provider-sdk';
import { compileMapping, MappingError, type MappingSpec } from './mapping.js';

/**
 * A connector provider definition — a configured source, as data (directive §6). One
 * document names a connector (`rest-json`, `geojson`, …), where to fetch, how to read the
 * response, how to map a record into an observation, and the policy and attribution the
 * data carries. No code, no expressions: everything a definition can say is listed here and
 * checked by `definitionSchema`.
 *
 * Definitions are JSON (`connectors/examples/*.json`, the operator's `connectors/` folder).
 */
export const DEFINITION_SCHEMA_ID = 'oneview.connector.v1';

export interface CredentialRef {
  /** The key under which the operator stores the secret (Sources → Credentials). */
  secretRef: string;
  label?: string;
  helpUrl?: string;
  kind?: 'api-key' | 'token' | 'basic' | 'url';
}

export interface EndpointSpec {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  /** Query parameters added to the URL. */
  query?: Record<string, string | number | boolean>;
  /** A JSON body for POST. */
  body?: JsonValue;
  /** The credential (a key of `credentials`) to attach, and how the API takes it. */
  credential?: { name: string; as: 'query' | 'header' | 'bearer' | 'path'; param?: string };
  intervalSeconds?: number;
  timeoutSeconds?: number;
  maxBytes?: number;
}

/**
 * A file source (ADR-013 amendment 2026-09-23, phase `files`): the definition names a file
 * inside the folder the user granted to the source, relative and `/`-separated
 * (`checkRelativePath`); a file connector reads it when its modification time changes.
 */
export const FILE_FORMATS = ['geojson', 'csv', 'gpx', 'kml', 'topojson'] as const;
export type FileFormat = (typeof FILE_FORMATS)[number];

export interface FileSpec {
  /** The file inside the folder the user granted, `/`-separated and relative. */
  path: string;
  /** What the file holds. Default: from the extension (`.json` is sniffed: a Topology or GeoJSON). */
  format?: FileFormat;
  /** How often the file's modification time is looked at. Default 30 s, never below 5 s. */
  intervalSeconds?: number;
  /** The largest file read; the host's own cap (32 MiB) still applies. Default 16 MiB. */
  maxBytes?: number;
  /** TopoJSON: the objects to read (default every object). gdal-import: the layers (default all). */
  layers?: string[];
}

export const MIN_FILE_INTERVAL_SECONDS = 5;
export const DEFAULT_FILE_INTERVAL_SECONDS = 30;
export const DEFAULT_FILE_MAX_BYTES = 16 * 1024 * 1024;
export const MAX_FILE_MAX_BYTES = 64 * 1024 * 1024;
/** A layer or TopoJSON object name: no leading `-` (it would read as an ogr2ogr option), no quotes. */
export const LAYER_NAME = OGR_LAYER_NAME;

export const fileSpecSchema: Schema<FileSpec> = s.object({
  path: s.string({ min: 1, max: 1024 }),
  format: s.optional(s.enum(FILE_FORMATS)),
  intervalSeconds: s.optional(s.number({ min: MIN_FILE_INTERVAL_SECONDS, max: 86_400 })),
  maxBytes: s.optional(s.number({ min: 1024, max: MAX_FILE_MAX_BYTES, integer: true })),
  layers: s.optional(s.array(s.string({ min: 1, max: 128, pattern: LAYER_NAME }), { min: 1, max: 16 })),
}) as Schema<FileSpec>;

export type PaginationSpec =
  | { strategy: 'none' }
  | {
      strategy: 'page-number';
      pageParam: string;
      sizeParam?: string;
      size?: number;
      firstPage?: number;
      maxPages?: number;
    }
  | { strategy: 'offset-limit'; offsetParam: string; limitParam: string; limit: number; maxPages?: number }
  | { strategy: 'cursor'; cursorParam: string; cursorPath: string; maxPages?: number }
  | { strategy: 'next-link'; nextLinkPath: string; maxPages?: number };

export interface ResponseSpec {
  /** Where the records are: a path to an array (or to one object). Default: the body itself. */
  itemsPath?: string;
  /** `entries`: the value at itemsPath is an object whose keys are ids; each value is a record with `_key`. */
  itemsAs?: 'array' | 'entries';
  format?: 'json' | 'csv' | 'text';
  /** CSV: the delimiter (default `,`) and whether the first row names the columns (default true). */
  csv?: { delimiter?: string; header?: boolean; columns?: string[] };
}

export interface FreshnessSpec {
  liveSeconds: number;
  recentSeconds: number;
  expireSeconds?: number;
}

export interface WebSocketSpec {
  url: string;
  /** Sent as JSON once the socket opens; `{secret}` in a string value is replaced by the credential. */
  subscribe?: JsonValue;
  /** Sent every `heartbeatSeconds`. */
  heartbeat?: JsonValue;
  heartbeatSeconds?: number;
  /**
   * The credential (a key of `credentials`): `as: 'open'` (default) replaces `{secret}` in
   * the subscribe frame; `as: 'query'` has the host put it in the URL as `param=<secret>`
   * (`param` default `token`) — Traccar's `?token=` — and the frame gets no secret.
   */
  credential?: { name: string; as?: 'open' | 'query'; param?: string };
  /** Path in each message to the record(s); default: the message itself. */
  itemsPath?: string;
  /** Coalesce records for this long before emitting a batch (default 500 ms; 0 emits per message). */
  flushMs?: number;
  /** Messages are kept only when every condition holds (same conditions as mapping.filter). */
  filter?: MappingSpec['filter'];
  maxMessageBytes?: number;
}

/**
 * A definition's policy: the manifest's fields, all optional, and `maxRetentionSeconds: null`
 * for "no cap" — what a manifest says by leaving the field out. Retention uncapped is an
 * opened field, so only a reviewed definition may say it (A8, phase provider-migration).
 */
export type DefinitionDataPolicy = Omit<Partial<ProviderDataPolicy>, 'maxRetentionSeconds'> & {
  maxRetentionSeconds?: number | null;
};

export interface ConnectorProviderDefinition {
  schema: typeof DEFINITION_SCHEMA_ID;
  /** Provider id: kebab-case, unique among all providers. */
  id: string;
  name: string;
  description?: string;
  connector: string;
  /** One of the world model's object types (`ObjectTypes`). */
  objectType: string;
  /** Lens categories (`aviation`, `maritime`, `weather`, `infrastructure`, `environment`, …). */
  categories?: string[];
  endpoint?: EndpointSpec;
  websocket?: WebSocketSpec;
  /** A file source: the file inside the granted folder (file connectors; no endpoint or websocket). */
  file?: FileSpec;
  pagination?: PaginationSpec;
  response?: ResponseSpec;
  mapping: MappingSpec;
  freshness?: FreshnessSpec;
  credentials?: Record<string, CredentialRef>;
  attribution: { text: string; url?: string; licenseId?: string };
  termsUrl?: string;
  /**
   * What the app may do with the data. Absent fields fail closed (`defaultDataPolicy`):
   * commercial use unknown, no redistribution, no offline packs, no export. Only a bundled,
   * reviewed definition (a registry record in config/licenses/providers.json) opens them.
   */
  dataPolicy?: DefinitionDataPolicy;
  /** Where the definition came from; decides which policy fields may be opened. */
  review?: 'user-configured' | 'bundled' | 'commercially-reviewed';
  /** Whether the source starts enabled (the operator's switch still wins). Default false. */
  enabled?: boolean;
  /** Quality of the source: what `sourceQuality` the observations carry. Default `unknown`. */
  sourceQuality?: 'authoritative' | 'crowdsourced' | 'derived' | 'unknown';
  /** Bounds-driven sources: the runtime passes the viewport, the connector substitutes `{south}` etc. */
  boundsQuery?: boolean;
  settings?: ProviderSettingDefinition[];
}

const kebab = /^[a-z0-9][a-z0-9-]*$/;
const fieldSchema = s.union([
  s.string({ min: 1, max: 256 }),
  s.object({
    path: s.optional(s.string({ min: 1, max: 256 })),
    fallback: s.optional(
      s.union([s.string({ min: 1, max: 256 }), s.array(s.string({ min: 1, max: 256 }), { max: 8 })]),
    ),
    literal: s.optional(s.json({ maxDepth: 4 })),
    transform: s.optional(s.union([s.string({ min: 1, max: 80 }), s.array(s.string({ min: 1, max: 80 }), { max: 8 })])),
    default: s.optional(s.json({ maxDepth: 4 })),
    required: s.optional(s.boolean()),
  }),
]);
const fieldMap = s.record(fieldSchema, { keyPattern: /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/, max: 128 });
const conditionSchema = s.object({
  path: s.string({ min: 1, max: 256 }),
  equals: s.optional(s.json({ maxDepth: 2 })),
  notEquals: s.optional(s.json({ maxDepth: 2 })),
  in: s.optional(s.array(s.json({ maxDepth: 2 }), { max: 64 })),
  exists: s.optional(s.boolean()),
  min: s.optional(s.number()),
  max: s.optional(s.number()),
});
const mappingSchema = s.object({
  externalId: fieldSchema,
  observedAt: s.optional(fieldSchema),
  position: s.optional(
    s.union([
      s.object({ lat: fieldSchema, lon: fieldSchema, alt: s.optional(fieldSchema) }),
      s.object({ geometry: fieldSchema, altitude: s.optional(s.boolean()) }),
      s.object({ lonLat: fieldSchema, altitude: s.optional(s.boolean()) }),
      s.object({ latLon: fieldSchema, altitude: s.optional(s.boolean()) }),
    ]),
  ),
  geometry: s.optional(fieldSchema),
  labels: s.optional(fieldMap),
  properties: s.optional(fieldMap),
  motion: s.optional(
    s.object({
      speedMps: s.optional(fieldSchema),
      headingDegrees: s.optional(fieldSchema),
      verticalSpeedMps: s.optional(fieldSchema),
    }),
  ),
  filter: s.optional(s.array(conditionSchema, { max: 16 })),
});
const headerValue = s.string({ max: 1024, pattern: /^[\x20-\x7e]*$/ });
const endpointSchema = s.object({
  url: s.string({ min: 8, max: 2048 }),
  method: s.optional(s.enum(['GET', 'POST'] as const)),
  headers: s.optional(s.record(headerValue, { keyPattern: /^[A-Za-z][A-Za-z0-9-]{0,63}$/, max: 16 })),
  query: s.optional(
    s.record(s.union([s.string({ max: 1024 }), s.number(), s.boolean()]), {
      keyPattern: /^[\w.\-[\]$]{1,64}$/,
      max: 32,
    }),
  ),
  body: s.optional(s.json({ maxDepth: 8 })),
  credential: s.optional(
    s.object({
      name: s.string({ min: 1, max: 64 }),
      as: s.enum(['query', 'header', 'bearer', 'path'] as const),
      param: s.optional(s.string({ min: 1, max: 64 })),
    }),
  ),
  intervalSeconds: s.optional(s.number({ min: 5, max: 86_400 })),
  timeoutSeconds: s.optional(s.number({ min: 1, max: 120 })),
  maxBytes: s.optional(s.number({ min: 1024, max: 64 * 1024 * 1024, integer: true })),
});
const websocketSchema = s.object({
  url: s.string({ min: 6, max: 2048 }),
  subscribe: s.optional(s.json({ maxDepth: 8 })),
  heartbeat: s.optional(s.json({ maxDepth: 4 })),
  heartbeatSeconds: s.optional(s.number({ min: 5, max: 3600 })),
  credential: s.optional(
    s.object({
      name: s.string({ min: 1, max: 64 }),
      as: s.optional(s.enum(['open', 'query'] as const)),
      param: s.optional(s.string({ min: 1, max: 64, pattern: /^[A-Za-z_][A-Za-z0-9_-]*$/ })),
    }),
  ),
  itemsPath: s.optional(s.string({ min: 1, max: 256 })),
  flushMs: s.optional(s.number({ min: 0, max: 5000 })),
  filter: s.optional(s.array(conditionSchema, { max: 16 })),
  maxMessageBytes: s.optional(s.number({ min: 1024, max: 16 * 1024 * 1024, integer: true })),
});
const paginationSchema = s.union([
  s.object({ strategy: s.enum(['none'] as const) }),
  s.object({
    strategy: s.enum(['page-number'] as const),
    pageParam: s.string({ min: 1, max: 64 }),
    sizeParam: s.optional(s.string({ min: 1, max: 64 })),
    size: s.optional(s.number({ min: 1, max: 10_000, integer: true })),
    firstPage: s.optional(s.number({ min: 0, max: 1, integer: true })),
    maxPages: s.optional(s.number({ min: 1, max: 200, integer: true })),
  }),
  s.object({
    strategy: s.enum(['offset-limit'] as const),
    offsetParam: s.string({ min: 1, max: 64 }),
    limitParam: s.string({ min: 1, max: 64 }),
    limit: s.number({ min: 1, max: 10_000, integer: true }),
    maxPages: s.optional(s.number({ min: 1, max: 200, integer: true })),
  }),
  s.object({
    strategy: s.enum(['cursor'] as const),
    cursorParam: s.string({ min: 1, max: 64 }),
    cursorPath: s.string({ min: 1, max: 256 }),
    maxPages: s.optional(s.number({ min: 1, max: 200, integer: true })),
  }),
  s.object({
    strategy: s.enum(['next-link'] as const),
    nextLinkPath: s.string({ min: 1, max: 256 }),
    maxPages: s.optional(s.number({ min: 1, max: 200, integer: true })),
  }),
]);
const dataPolicyPartial = s.object({
  cacheAllowed: s.optional(s.boolean()),
  rawPayloadRetentionAllowed: s.optional(s.boolean()),
  normalizedRetentionAllowed: s.optional(s.boolean()),
  maxRetentionSeconds: s.optional(s.nullable(s.number({ min: 60 }))),
  redistributionAllowed: s.optional(s.boolean()),
  offlinePackAllowed: s.optional(s.boolean()),
  exportAllowed: s.optional(s.boolean()),
  commercialUseAllowed: s.optional(s.union([s.boolean(), s.enum(['conditional', 'unknown'] as const)])),
  attributionRequired: s.optional(s.boolean()),
  attributionText: s.optional(s.string({ max: 500 })),
  termsUrl: s.optional(s.string({ max: 2048 })),
});
const settingSchema = s.object({
  key: s.string({ min: 1, max: 64, pattern: /^[a-zA-Z][a-zA-Z0-9_.-]*$/ }),
  label: s.string({ min: 1, max: 120 }),
  description: s.optional(s.string({ max: 500 })),
  kind: s.enum(['string', 'number', 'boolean', 'enum', 'multi-enum'] as const),
  defaultLabel: s.optional(s.string({ max: 120 })),
  min: s.optional(s.number()),
  max: s.optional(s.number()),
  step: s.optional(s.number()),
  options: s.optional(s.array(s.object({ value: s.string({ max: 120 }), label: s.string({ max: 120 }) }), { max: 64 })),
  placeholder: s.optional(s.string({ max: 120 })),
  helpUrl: s.optional(s.string({ max: 2048 })),
});

export const OBJECT_TYPE_VALUES: readonly string[] = Object.freeze(Object.values(ObjectTypes));

export const definitionSchema: Schema<ConnectorProviderDefinition> = s.refine(
  s.object({
    schema: s.enum([DEFINITION_SCHEMA_ID] as const),
    id: s.string({ min: 2, max: 64, pattern: kebab }),
    name: s.string({ min: 1, max: 120 }),
    description: s.optional(s.string({ max: 500 })),
    connector: s.string({ min: 2, max: 64, pattern: kebab }),
    objectType: s.string({ min: 1, max: 64, pattern: kebab }),
    categories: s.optional(s.array(s.string({ min: 1, max: 64, pattern: kebab }), { max: 8 })),
    endpoint: s.optional(endpointSchema),
    websocket: s.optional(websocketSchema),
    file: s.optional(fileSpecSchema),
    pagination: s.optional(paginationSchema),
    response: s.optional(
      s.object({
        itemsPath: s.optional(s.string({ min: 1, max: 256 })),
        itemsAs: s.optional(s.enum(['array', 'entries'] as const)),
        format: s.optional(s.enum(['json', 'csv', 'text'] as const)),
        csv: s.optional(
          s.object({
            delimiter: s.optional(s.string({ min: 1, max: 1 })),
            header: s.optional(s.boolean()),
            columns: s.optional(s.array(s.string({ min: 1, max: 64 }), { max: 256 })),
          }),
        ),
      }),
    ),
    mapping: mappingSchema,
    freshness: s.optional(
      s.object({
        liveSeconds: s.number({ min: 1, max: 31_536_000 }),
        recentSeconds: s.number({ min: 1, max: 31_536_000 }),
        expireSeconds: s.optional(s.number({ min: 1, max: 31_536_000 })),
      }),
    ),
    credentials: s.optional(
      s.record(
        s.object({
          secretRef: s.string({ min: 1, max: 128, pattern: /^[a-zA-Z0-9_.-]+$/ }),
          label: s.optional(s.string({ max: 120 })),
          helpUrl: s.optional(s.string({ max: 2048 })),
          kind: s.optional(s.enum(['api-key', 'token', 'basic', 'url'] as const)),
        }),
        { keyPattern: /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/, max: 4 },
      ),
    ),
    attribution: s.object({
      text: s.string({ min: 1, max: 500 }),
      url: s.optional(s.string({ max: 2048 })),
      licenseId: s.optional(s.string({ max: 100 })),
    }),
    termsUrl: s.optional(s.string({ max: 2048 })),
    dataPolicy: s.optional(dataPolicyPartial),
    review: s.optional(s.enum(['user-configured', 'bundled', 'commercially-reviewed'] as const)),
    enabled: s.optional(s.boolean()),
    sourceQuality: s.optional(s.enum(['authoritative', 'crowdsourced', 'derived', 'unknown'] as const)),
    boundsQuery: s.optional(s.boolean()),
    settings: s.optional(s.array(settingSchema, { max: 24 })),
  }),
  (d) => {
    if (!OBJECT_TYPE_VALUES.includes(d.objectType))
      return `objectType "${d.objectType}" is not a world-model object type (${OBJECT_TYPE_VALUES.join(', ')})`;
    if (d.freshness && d.freshness.recentSeconds < d.freshness.liveSeconds)
      return 'freshness.recentSeconds is below liveSeconds';
    if (d.freshness?.expireSeconds !== undefined && d.freshness.expireSeconds < d.freshness.recentSeconds)
      return 'freshness.expireSeconds is below recentSeconds';
    const credentialNames = Object.keys(d.credentials ?? {});
    if (d.endpoint?.credential && !credentialNames.includes(d.endpoint.credential.name))
      return `endpoint.credential names "${d.endpoint.credential.name}", which credentials does not declare`;
    if (d.websocket?.credential && !credentialNames.includes(d.websocket.credential.name))
      return `websocket.credential names "${d.websocket.credential.name}", which credentials does not declare`;
    if (d.endpoint) {
      const bad = checkUrl(d.endpoint.url, ['https:']);
      if (bad) return `endpoint.url ${bad}`;
      if (d.endpoint.credential?.as === 'path' && !d.endpoint.url.includes('{TOKEN}'))
        return 'endpoint.credential "path" needs a {TOKEN} placeholder in the URL';
    }
    if (d.websocket) {
      const bad = checkUrl(d.websocket.url, ['wss:']);
      if (bad) return `websocket.url ${bad}`;
    }
    if (d.file) {
      const verdict = checkRelativePath(d.file.path);
      if (!verdict.ok) return `file.path: ${verdict.reason}`;
    }
    try {
      compileMapping(d.mapping);
    } catch (err) {
      return err instanceof MappingError ? err.message : String(err);
    }
    if (d.dataPolicy) {
      const opened = openedPolicyFields(d.dataPolicy);
      if (opened.length && (d.review ?? 'user-configured') === 'user-configured')
        return `dataPolicy opens ${opened.join(', ')}, which a user-configured definition may not (review is needed)`;
    }
    return undefined;
  },
) as Schema<ConnectorProviderDefinition>;

/**
 * A URL a definition may name: https (or wss), a real host, no credentials in it, and —
 * for a remote connector — not loopback, a private range or a link-local metadata address
 * (SSRF, directive §76). Local connectors have their own contract.
 */
export function checkUrl(url: string, protocols: string[]): string | undefined {
  let u: URL;
  try {
    u = new URL(url.replace('{TOKEN}', 'TOKEN'));
  } catch {
    return 'is not a URL';
  }
  if (!protocols.includes(u.protocol)) return `must be ${protocols.join(' or ')}`;
  if (u.username || u.password) return 'must not carry credentials';
  const host = u.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local'))
    return 'must name a public host';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const [a, b] = host.split('.').map(Number) as [number, number];
    if (
      a === 127 ||
      a === 10 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    )
      return 'must not be a private, loopback or link-local address';
  }
  if (host.startsWith('[') || host.includes(':')) return 'must be a DNS name or an IPv4 address';
  return undefined;
}

/** The data-policy defaults a definition gets: fail closed (directive §54). */
export const defaultDataPolicy: Readonly<ProviderDataPolicy> = Object.freeze({
  cacheAllowed: true,
  rawPayloadRetentionAllowed: false,
  normalizedRetentionAllowed: true,
  maxRetentionSeconds: 7 * 86_400,
  redistributionAllowed: false,
  offlinePackAllowed: false,
  exportAllowed: false,
  commercialUseAllowed: 'unknown',
  attributionRequired: true,
});

/** Policy fields a definition sets more permissively than the fail-closed default. */
export function openedPolicyFields(policy: DefinitionDataPolicy): string[] {
  const out: string[] = [];
  for (const key of [
    'rawPayloadRetentionAllowed',
    'redistributionAllowed',
    'offlinePackAllowed',
    'exportAllowed',
  ] as const)
    if (policy[key] === true) out.push(key);
  if (policy.commercialUseAllowed === true || policy.commercialUseAllowed === 'conditional')
    out.push('commercialUseAllowed');
  if (policy.attributionRequired === false) out.push('attributionRequired');
  if (
    policy.maxRetentionSeconds === null ||
    (policy.maxRetentionSeconds !== undefined && policy.maxRetentionSeconds > defaultDataPolicy.maxRetentionSeconds!)
  )
    out.push('maxRetentionSeconds');
  return out;
}

export function resolveDataPolicy(d: ConnectorProviderDefinition): ProviderDataPolicy {
  const { maxRetentionSeconds, ...rest } = d.dataPolicy ?? {};
  const policy: ProviderDataPolicy = { ...defaultDataPolicy, ...rest };
  if (maxRetentionSeconds === null)
    delete policy.maxRetentionSeconds; // no cap, as a manifest without the field
  else if (maxRetentionSeconds !== undefined) policy.maxRetentionSeconds = maxRetentionSeconds;
  if (!policy.attributionText) policy.attributionText = d.attribution.text;
  if (!policy.termsUrl && d.termsUrl) policy.termsUrl = d.termsUrl;
  return policy;
}

/** Hosts a definition contacts, for the manifest allowlist. */
export function definitionHosts(d: ConnectorProviderDefinition): string[] {
  const hosts = new Set<string>();
  for (const url of [d.endpoint?.url, d.websocket?.url]) {
    if (!url) continue;
    try {
      hosts.add(new URL(url.replace('{TOKEN}', 'TOKEN')).hostname.toLowerCase());
    } catch {
      /* the schema refused it already */
    }
  }
  return [...hosts].sort();
}

export const DEFAULT_INTERVAL_SECONDS = 60;
export const MIN_INTERVAL_SECONDS = 5;

/** The provider manifest a definition amounts to. */
/** The requests one poll of a definition may send: its pages, plus the first request. */
export function requestsPerPoll(d: ConnectorProviderDefinition): number {
  return 1 + (d.pagination && d.pagination.strategy !== 'none' ? (d.pagination.maxPages ?? 10) : 0);
}

export function definitionToManifest(d: ConnectorProviderDefinition, connectorName: string): ProviderManifest {
  const intervalSeconds = Math.max(MIN_INTERVAL_SECONDS, d.endpoint?.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS);
  const timeoutMs = (d.endpoint?.timeoutSeconds ?? 20) * 1000;
  const pages = requestsPerPoll(d);
  const review = d.review ?? 'user-configured';
  const commercialReview: ProviderManifest['commercialReview'] =
    review === 'commercially-reviewed' ? 'approved' : review === 'bundled' ? 'conditional' : 'manual-review-required';
  const freshness = d.freshness
    ? {
        [d.objectType]: {
          liveSeconds: d.freshness.liveSeconds,
          recentSeconds: d.freshness.recentSeconds,
          ...(d.freshness.expireSeconds !== undefined ? { expireSeconds: d.freshness.expireSeconds } : {}),
        },
      }
    : undefined;
  const credentials = Object.entries(d.credentials ?? {}).map(([name, c]) => ({
    key: c.secretRef,
    label: c.label ?? `${d.name} — ${name}`,
    required: false,
    kind: c.kind ?? 'api-key',
    ...(c.helpUrl ? { helpUrl: c.helpUrl } : {}),
  }));
  return {
    id: d.id,
    name: d.name,
    version: '0.1.0',
    description: `${d.description ? `${d.description} ` : ''}Connector: ${connectorName}.`.trim(),
    objectTypes: [d.objectType],
    categories: d.categories?.length ? d.categories : ['infrastructure'],
    transport: d.websocket ? 'websocket' : d.file && !d.endpoint ? 'filesystem' : 'http',
    capabilities: {
      live: !(d.file && !d.endpoint),
      historical: false,
      offline: Boolean(d.file && !d.endpoint),
      boundsQuery: d.boundsQuery === true,
    },
    credentials,
    refreshPolicy: {
      intervalMs: intervalSeconds * 1000,
      minIntervalMs: MIN_INTERVAL_SECONDS * 1000,
      timeoutMs,
      maxRetries: 1,
      // Twice the cadence, plus the retry — and never fewer than one poll's burst with its
      // retry, since a poll sends all its pages within seconds and the client's limiter is a
      // 60-second window (ADR-013 amendment 2026-09-23: a paged definition at a cadence over
      // two minutes could not finish a poll).
      maxRequestsPerMinute: Math.max(4, Math.ceil((120 / intervalSeconds) * (pages + 1)), 2 * pages + 1),
      // The whole poll, not one request: every page may take the request timeout.
      ...(pages > 1 ? { pollBudgetMs: Math.min(600_000, timeoutMs * pages + 5000) } : {}),
      staleWhileErrorMs: 10 * 60_000,
      ...(freshness ? { freshness } : {}),
    },
    dataPolicy: resolveDataPolicy(d),
    attribution: {
      text: d.attribution.text,
      ...(d.attribution.url ? { url: d.attribution.url } : {}),
      ...(d.attribution.licenseId ? { licenseId: d.attribution.licenseId } : {}),
    },
    commercialReview,
    // The operator's own switch decides for a user-configured source (`enabled` in the file);
    // the manifest schema forbids default-on for anything not reviewed.
    enabledByDefault:
      commercialReview === 'approved' || commercialReview === 'conditional' ? d.enabled === true : false,
    allowedHosts: definitionHosts(d),
    ...(d.settings?.length ? { settings: d.settings } : {}),
  };
}

/** Parse and validate a definition document; issues are human-readable. */
export function parseDefinition(
  doc: unknown,
): { ok: true; definition: ConnectorProviderDefinition } | { ok: false; issues: string[] } {
  const r = definitionSchema.parse(doc);
  if (r.ok) return { ok: true, definition: r.value };
  return { ok: false, issues: r.issues.map((i) => `${i.path || '$'}: ${i.message}`) };
}
