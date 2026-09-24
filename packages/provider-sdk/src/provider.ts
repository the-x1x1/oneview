import type {
  GeoBounds,
  GeoRegion,
  JsonValue,
  Observation,
  RasterOverlay,
  TimeRange,
  Clock,
} from '@worldview/world-model';
import type { ProviderManifest } from './manifest.js';
import type { ProviderError, ProviderHealth } from './health.js';

/**
 * WorldProvider — the frozen provider contract (architecture-contract-v1).
 *
 * Providers turn remote/local sources into normalized Observations. They never
 * render, never touch UI, never persist, and only reach the network through the
 * ProviderContext (which enforces allowlists, timeouts, size caps and rate limits).
 */
export interface WorldProvider {
  readonly manifest: ProviderManifest;

  initialize(context: ProviderContext): Promise<void>;

  start(): Promise<void>;

  stop(): Promise<void>;

  health(): Promise<ProviderHealth>;

  /** One-shot fetch of current observations (polling transports). */
  query?(request: ProviderQuery): Promise<Observation[]>;

  /** Push transports (websocket, local process). Returns an unsubscribe function. */
  subscribe?(request: ProviderSubscription, emit: ObservationEmitter): Promise<Unsubscribe>;

  /** Historical backfill when the source offers it (e.g. USGS query API, FIRMS archive). */
  historical?(request: HistoricalProviderQuery): Promise<Observation[]>;

  /**
   * Raster overlays this provider publishes (ADR-003 amendment 2026-09-23; the type is
   * ADR-008's): tiled pictures — WMS, WMTS, XYZ — the renderers draw between the basemap
   * and the objects. Asked once after `start()` and again on `ProviderHost.refreshOverlays`;
   * every descriptor is validated, and one whose host is not in `manifest.allowedHosts` is
   * refused. Optional: a provider without overlays does not implement it.
   */
  overlays?(): Promise<RasterOverlay[]>;
}

export interface ProviderQuery {
  /** Restrict to a viewport/region when the provider supports boundsQuery. */
  bounds?: GeoBounds;
  /**
   * Where the view is centred, with `bounds` (ADR-003 amendment 2026-09-23). The middle of the
   * bounds is not it: a globe-wide view's bounds are the whole world, whose middle is 0°, 0°
   * in the Gulf of Guinea. A bounds-query provider that can cover only part of the bounds
   * covers the part around this first.
   */
  center?: { latitude: number; longitude: number };
  region?: GeoRegion;
  objectTypes?: string[];
  /** Cooperative cancellation. Providers must observe it. */
  signal: AbortSignal;
  /** True when the runtime is polling in the background vs an explicit user request. */
  background: boolean;
}

export interface ProviderSubscription {
  bounds?: GeoBounds;
  objectTypes?: string[];
  signal: AbortSignal;
}

export interface HistoricalProviderQuery {
  time: TimeRange;
  bounds?: GeoBounds;
  objectTypes?: string[];
  limit?: number;
  signal: AbortSignal;
}

export type ObservationEmitter = (observations: Observation[], meta?: EmitMeta) => void;

export interface EmitMeta {
  /** Whether this batch is a complete snapshot (replace) or incremental (merge). */
  snapshot: boolean;
  /** Sub-source label for diagnostics (e.g. "opensky", "adsb.lol"). */
  subSource?: string;
}

export type Unsubscribe = () => void;

/**
 * ProviderContext — everything a provider is allowed to use. Injected by the runtime.
 * No direct `fetch`, `fs`, `child_process` or `WebSocket` in providers.
 */
export interface ProviderContext {
  readonly providerId: string;
  readonly clock: Clock;
  readonly logger: ProviderLogger;
  readonly http: ProviderHttp;
  readonly sockets: ProviderSockets;
  /** MQTT subscriptions to a local broker (ADR-003 amendment 2026-09-23); absent on hosts without it. */
  readonly mqtt?: ProviderMqtt;
  readonly credentials: ProviderCredentials;
  readonly cache: ProviderCache;
  readonly settings: ProviderSettings;
  readonly local: ProviderLocalAccess;
  readonly hash: { sha256Hex(input: string | Uint8Array): string };
  /** Reports whether the application currently believes it has connectivity. */
  readonly connectivity: { online(): boolean };
}

export interface ProviderLogger {
  debug(message: string, fields?: Record<string, JsonValue>): void;
  info(message: string, fields?: Record<string, JsonValue>): void;
  warn(message: string, fields?: Record<string, JsonValue>): void;
  error(message: string, fields?: Record<string, JsonValue>): void;
}

export interface ProviderHttpRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** Override manifest timeout (bounded by the runtime). */
  timeoutMs?: number;
  /** Max response bytes (bounded by the runtime; default 8 MiB). */
  maxBytes?: number;
  signal?: AbortSignal;
  /** Cache key for conditional requests (ETag / If-Modified-Since) and coalescing. Defaults to URL. */
  cacheKey?: string;
  /** Accept a stale cached body if the upstream fails (bounded by dataPolicy/refreshPolicy). */
  allowStale?: boolean;
  /**
   * Which credential (manifest.credentials[].key) to attach, and how.
   *
   * `query`  → `?<name|key>=<secret>`
   * `header` → `<name|X-API-Key>: <secret>`
   * `bearer` → `Authorization: Bearer <secret>`
   * `path`   → the URL must contain the placeholder `{<name|TOKEN>}`; the network layer
   *            substitutes the percent-encoded secret into that path segment. The
   *            provider only ever builds the placeholder URL, so the secret never
   *            reaches provider code, logs or cache keys (ADR-003).
   * `xml-body` → the (string) body must contain the placeholder `{<name|TOKEN>}` inside an
   *            XML attribute or element; the network layer substitutes the XML-escaped
   *            secret. For APIs that take the key in a POST body (Trafikverket's
   *            `<LOGIN authenticationkey="…"/>`). Same guarantee as `path` (ADR-003).
   */
  credential?: { key: string; as: 'query' | 'header' | 'bearer' | 'path' | 'xml-body'; name?: string };
}

export interface ProviderHttpResponse {
  status: number;
  headers: Record<string, string>;
  /** Response body (text). Use `bytes()` for binary. */
  text(): string;
  json(): unknown;
  bytes(): Uint8Array;
  /** Whether the body came from the conditional-request cache (304) or stale fallback. */
  fromCache: boolean;
  stale: boolean;
  /** Age of the served body in ms (0 for fresh). */
  ageMs: number;
  latencyMs: number;
  /**
   * Tell the network layer this body was unusable (malformed/rejected) so it is never
   * served as a stale fallback; the previously accepted body is restored if any.
   */
  invalidate(): void;
}

export interface ProviderHttp {
  request(req: ProviderHttpRequest): Promise<ProviderHttpResponse>;
}

export interface ProviderSocketHandle {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface ProviderSocketEvents {
  /**
   * The socket handshake completed. When `opts.credential` was requested, `ctx.secret`
   * carries the resolved secret for exactly this callback so the provider can build its
   * first frame (e.g. an AISStream subscription message) without ever holding the key.
   * The runtime never stores the secret on the handle.
   */
  onOpen?(ctx: { secret?: string }): void;
  onMessage(data: string | Uint8Array): void;
  onClose(code: number, reason: string): void;
  onError(error: Error): void;
}

export interface ProviderSocketOptions {
  headers?: Record<string, string>;
  maxMessageBytes?: number;
  signal?: AbortSignal;
  /** Resolve this credential and hand it to `onOpen(ctx.secret)`. The provider never sees the key's value otherwise. */
  credential?: { key: string };
}

export interface ProviderSockets {
  /** Open a WebSocket to an allowlisted host. The runtime enforces the allowlist and message size caps. */
  open(url: string, events: ProviderSocketEvents, opts?: ProviderSocketOptions): Promise<ProviderSocketHandle>;
}

/**
 * MQTT (ADR-003 amendment 2026-09-23, for phase `mqtt`): a subscription to topics on a
 * broker on this computer or on the one host the user named (`trustedHostSetting`) — local
 * transports only, outbound only, nothing published. The runtime speaks MQTT 3.1.1 itself
 * (no client library): CONNECT with an optional username and a password by credential
 * reference, SUBSCRIBE at QoS 0 or 1, PUBLISH delivered as bytes, keep-alive pings; a
 * payload over `maxPayloadBytes` (default 256 KiB) and every message past
 * `maxMessagesPerSecond` (default 500) is dropped and counted. Optional on the context: a
 * host without it refuses with UNSUPPORTED.
 */
export interface ProviderMqttOptions {
  host: string;
  /** Default 1883, or 8883 with `tls`. */
  port?: number;
  tls?: boolean;
  /** Sent as the MQTT username (not a secret). */
  username?: string;
  /** The stored secret becomes the MQTT password; the provider never sees it. */
  credential?: { key: string };
  clientId?: string;
  subscriptions: Array<{ topic: string; qos?: 0 | 1 }>;
  maxPayloadBytes?: number;
  maxMessagesPerSecond?: number;
  keepAliveSeconds?: number;
  connectTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface ProviderMqttEvents {
  onMessage(topic: string, payload: Uint8Array, meta: { retained: boolean; qos: number }): void;
  /** CONNACK accepted and every subscription acknowledged. */
  onOpen?(): void;
  /** The connection ended (the broker closed it, an error, or `close()`). */
  onClose?(reason?: string): void;
  onError?(error: ProviderError): void;
}

export interface ProviderMqttHandle {
  close(): void;
  /** Messages dropped for size or rate since the connection opened. */
  readonly dropped: number;
}

export interface ProviderMqtt {
  connect(opts: ProviderMqttOptions, events: ProviderMqttEvents): Promise<ProviderMqttHandle>;
}

export interface ProviderCredentials {
  /** Whether the credential is present. Providers never receive the raw value; the http layer attaches it. */
  has(key: string): Promise<boolean>;
}

export interface ProviderCache {
  /** Small JSON cache scoped to the provider (respects dataPolicy.cacheAllowed; no-op otherwise). */
  get<T extends JsonValue>(key: string): Promise<{ value: T; storedAt: string } | undefined>;
  set(key: string, value: JsonValue, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface ProviderSettings {
  /** Provider-scoped user settings (e.g. readsb endpoint, camera list). Validated by the provider. */
  get(): Promise<Record<string, JsonValue>>;
  onChange(listener: (settings: Record<string, JsonValue>) => void): Unsubscribe;
}

export interface ProviderLocalAccess {
  /** Read a file from a directory the user explicitly granted to this provider (filesystem transports). */
  readGrantedFile(path: string, opts?: { maxBytes?: number }): Promise<Uint8Array>;
  /**
   * Size and modification time of a granted file without reading it, so a provider can poll
   * for change cheaply (ADR-003 amendment 2026-09-23). Same path rules and refusals as
   * `readGrantedFile`. Optional: a host without it refuses with UNSUPPORTED.
   */
  statGrantedFile?(path: string): Promise<{ size: number; mtimeMs: number }>;
  /** Probe a loopback/trusted local endpoint (readsb, go2rtc). Only hosts in manifest.allowedHosts. */
  probeLocal(url: string, opts?: { timeoutMs?: number }): Promise<{ reachable: boolean; status?: number }>;
  /**
   * Local transports: a TCP connection to a device that speaks in lines — NMEA 0183 from a GPS
   * or an AIS receiver — to loopback in `manifest.allowedHosts` or exactly the provider's trusted
   * host (ADR-003). The provider only ever connects out; nothing listens. Lines arrive without
   * their line ending; a line longer than `maxLineBytes` (default 1,024) is dropped, and so are
   * lines past the runtime's rate cap. Optional: a host without it refuses with UNSUPPORTED.
   */
  openLineStream?(
    target: { host: string; port: number },
    events: LineStreamEvents,
    opts?: { maxLineBytes?: number; connectTimeoutMs?: number },
  ): Promise<LineStreamHandle>;
}

export interface LineStreamEvents {
  onLine(line: string): void;
  /** The connection ended (the device closed it, or `close()` was called). */
  onClose?(reason?: string): void;
  /** The connection failed after it was open. */
  onError?(error: ProviderError): void;
}

export interface LineStreamHandle {
  close(): void;
  /** Lines dropped for length or rate since the stream opened. */
  readonly dropped: number;
}
