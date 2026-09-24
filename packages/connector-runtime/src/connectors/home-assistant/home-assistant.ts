import type { IsoTimestamp, Observation } from '@worldview/world-model';
import {
  ProviderError,
  assertAtomicAdmission,
  isNameableHost,
  numberSetting,
  resolveLocalEndpoint,
  stringSetting,
  type CredentialState,
  type ObservationEmitter,
  type ProviderContext,
  type ProviderHealth,
  type ProviderManifest,
  type ProviderQuery,
  type ProviderSettingDefinition,
  type ProviderSocketHandle,
  type ProviderStatus,
  type ProviderSubscription,
  type Unsubscribe,
  type WorldProvider,
} from '@worldview/provider-sdk';
import {
  compileMapping,
  definitionToManifest,
  mapRecords,
  type CompiledMapping,
  type Connector,
  type ConnectorProviderDefinition,
  type ConnectorValidationResult,
} from '@worldview/connector-sdk';
import {
  REFUSED_DOMAINS,
  enrich,
  isRefused,
  matchesAny,
  parsePositions,
  parseSelectors,
  readState,
  sameState,
  type EntitySelector,
  type HaState,
  type ParsedList,
  type PositionEntry,
} from './entities.js';

/**
 * Home Assistant (phase `home-assistant`): the operator's own Home Assistant, read-only,
 * through its documented APIs and a long-lived access token.
 *
 *   - REST: `GET /api/states` — every entity's current state — with the token as a bearer
 *     header attached by the host's HTTP client. The first poll, and every poll while the
 *     socket is not live, reads it; while the socket is live a poll answers from the states
 *     the socket keeps current and reads `/api/states` again every ten minutes and after
 *     every (re)subscription, so nothing missed while the socket was down stays wrong.
 *   - WebSocket: `/api/websocket` — the `auth` frame with the token (which the host hands to
 *     `onOpen` and the provider never keeps), then `subscribe_events` for `state_changed`,
 *     and `ping` every 30 s. Those three are the only frames ever sent (`HA_ALLOWED_FRAMES`);
 *     no service is ever called, over either API.
 *
 * The instance is the one host the operator names in the `host` setting — the provider's
 * trusted host (ADR-003 `trustedHostSetting`) — or this computer when the setting is empty,
 * on `port` (8123), plain or TLS by the `tls` setting. A definition never holds an address or
 * a token: `credentials` declares the token by reference and nothing else.
 *
 * `person` and `device_tracker` entities are never read (`REFUSED_DOMAINS`, PRODUCT-BOUNDARIES).
 */
export const HOME_ASSISTANT_CONNECTOR_ID = 'home-assistant';
const CONNECTOR_NAME = 'Home Assistant';

export const HA_DEFAULT_PORT = 8123;
export const HA_LOOPBACK_HOST = '127.0.0.1';
/** The only frames this connector sends over the WebSocket API. */
export const HA_ALLOWED_FRAMES = ['auth', 'subscribe_events', 'ping'] as const;
/** While the socket is live, `/api/states` is read again this often. */
export const HA_RESYNC_MS = 10 * 60_000;
export const HA_PING_MS = 30_000;
/** No message at all for this long on a live socket (pongs included) and it is treated as dead. */
export const HA_SILENCE_MS = 75_000;
/** From open to `auth_ok`. */
export const HA_AUTH_TIMEOUT_MS = 15_000;
/** How long before a socket the host refused (HOST_NOT_ALLOWED) is asked for again. */
export const HA_REFUSED_RETRY_MS = 15 * 60_000;
export const HA_MAX_STATES_BYTES = 16 * 1024 * 1024;
export const HA_MAX_MESSAGE_BYTES = 1024 * 1024;
export const HA_MAX_ENTITIES = 50_000;
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const DEFAULT_INTERVAL_SECONDS = 60;

export interface HaAuthFrame {
  type: 'auth';
  access_token: string;
}
export interface HaSubscribeFrame {
  id: number;
  type: 'subscribe_events';
  event_type: 'state_changed';
}
export interface HaPingFrame {
  id: number;
  type: 'ping';
}
export type HaOutgoingFrame = HaAuthFrame | HaSubscribeFrame | HaPingFrame;

/** The settings every Home Assistant source has; a definition's own settings are added after them. */
export const HA_SETTINGS: readonly ProviderSettingDefinition[] = Object.freeze([
  {
    key: 'host',
    label: 'Home Assistant host',
    kind: 'string',
    placeholder: '192.168.1.20 or homeassistant.local',
    defaultLabel: 'This computer (127.0.0.1)',
    description:
      'The IP address or host name of your Home Assistant on your network. Only this host is contacted; empty means this computer.',
  },
  {
    key: 'port',
    label: 'Port',
    kind: 'number',
    min: 1,
    max: 65535,
    step: 1,
    defaultLabel: '8123',
    description: "Home Assistant's HTTP port.",
  },
  {
    key: 'tls',
    label: 'Use TLS (https / wss)',
    kind: 'boolean',
    defaultLabel: 'Off (plain http on your network)',
    description:
      'Turn on when Home Assistant answers on https at this host and port. Without it the token crosses your network unencrypted.',
  },
  {
    key: 'entities',
    label: 'Entities',
    kind: 'string',
    placeholder: 'sensor.outdoor_*, weather.home',
    defaultLabel: 'Everything the definition selects',
    description:
      'Entity ids or patterns (* as wildcard), separated by commas. Narrows what the definition selects. person and device_tracker entities are never read.',
  },
  {
    key: 'positions',
    label: 'Positions',
    kind: 'string',
    placeholder: 'sensor.garden_*=21.3069,-157.8583; weather.*=zone.home',
    defaultLabel: 'None',
    description:
      'Where entities without coordinates stand: "<pattern>=<lat>,<lon>" or "<pattern>=zone.<name>", separated by semicolons. The first match wins.',
  },
]);
const HA_SETTING_KEYS: ReadonlySet<string> = new Set(HA_SETTINGS.map((s) => s.key));

export interface HaSettings {
  /** The host the operator named (lower-cased), if any. */
  host?: string;
  port: number;
  tls: boolean;
  entities: ParsedList<EntitySelector>;
  /** The Entities setting says something, valid or not: nothing it does not match is shown. */
  entitiesGiven: boolean;
  positions: ParsedList<PositionEntry>;
}

export function parseHaSettings(raw: Record<string, unknown>): HaSettings {
  const host = stringSetting(raw, 'host', { host: true });
  const tls = raw['tls'] === true || raw['tls'] === 'true';
  const out: HaSettings = {
    port: numberSetting(raw, 'port', 1, 65535) ?? HA_DEFAULT_PORT,
    tls,
    entities: parseSelectors(stringSetting(raw, 'entities')),
    entitiesGiven: stringSetting(raw, 'entities') !== undefined,
    positions: parsePositions(stringSetting(raw, 'positions')),
  };
  if (host) out.host = host;
  return out;
}

export interface HaEndpointOk {
  ok: true;
  base: string;
  statesUrl: string;
  socketUrl: string;
  trusted: boolean;
}
export type HaEndpoint = HaEndpointOk | { ok: false; reason: string };

/** The instance's URLs, under the local-endpoint policy (loopback, or exactly the host the operator named). */
export function haEndpoint(settings: Pick<HaSettings, 'host' | 'port' | 'tls'>): HaEndpoint {
  const host = settings.host ?? HA_LOOPBACK_HOST;
  if (settings.host && !isNameableHost(settings.host))
    return {
      ok: false,
      reason: `Home Assistant host "${settings.host.slice(0, 64)}" is not a host name or IPv4 address`,
    };
  if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535)
    return { ok: false, reason: `port ${settings.port} is not a TCP port` };
  const scheme = settings.tls ? 'https' : 'http';
  const verdict = resolveLocalEndpoint(`${scheme}://${host}:${settings.port}/`, {
    label: 'Home Assistant address',
    trustedHostSetting: 'host',
    ...(settings.host ? { trustedHost: settings.host } : {}),
  });
  if (!verdict.ok) return verdict;
  const base = verdict.url.replace(/\/$/, '');
  return {
    ok: true,
    base,
    statesUrl: `${base}/api/states`,
    socketUrl: `${settings.tls ? 'wss' : 'ws'}${base.slice(scheme.length)}/api/websocket`,
    trusted: verdict.trusted,
  };
}

/** The token's credential key: the definition's one declared credential. */
export function haTokenKey(d: ConnectorProviderDefinition): string | undefined {
  const refs = Object.values(d.credentials ?? {});
  return refs.length === 1 ? refs[0]!.secretRef : undefined;
}

/**
 * The manifest a Home Assistant definition amounts to: a local source (ADR-003) — loopback,
 * plus the one host in the `host` setting — polling `/api/states` once a minute, with the
 * token required.
 */
export function homeAssistantManifest(d: ConnectorProviderDefinition): ProviderManifest {
  const base = definitionToManifest(d, CONNECTOR_NAME);
  const intervalSeconds = DEFAULT_INTERVAL_SECONDS;
  return {
    ...base,
    transport: 'local-process',
    capabilities: { live: true, historical: false, offline: true, boundsQuery: false },
    credentials: base.credentials.map((c) => ({ ...c, required: true })),
    refreshPolicy: {
      ...base.refreshPolicy,
      intervalMs: intervalSeconds * 1000,
      timeoutMs: 20_000,
      maxRequestsPerMinute: Math.max(4, Math.ceil((120 / intervalSeconds) * 2)),
    },
    allowedHosts: [HA_LOOPBACK_HOST, 'localhost'],
    trustedHostSetting: 'host',
    settings: [...HA_SETTINGS, ...(d.settings ?? []).filter((s) => !HA_SETTING_KEYS.has(s.key))].slice(0, 24),
  };
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const realTimers: Timers = {
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    if (typeof h === 'object' && h !== null && 'unref' in h) (h as { unref(): void }).unref();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface HomeAssistantOptions {
  /** How long socket updates are coalesced before a batch is emitted (default 500 ms; 0 emits at once). */
  flushIntervalMs?: number;
  timers?: Timers;
}

export const HA_SOCKET_STATES = [
  'idle',
  'connecting',
  'authenticating',
  'subscribing',
  'live',
  'waiting',
  'refused',
  'auth-failed',
] as const;
export type HaSocketState = (typeof HA_SOCKET_STATES)[number];

interface Session {
  emit: ObservationEmitter;
  handle: ProviderSocketHandle | undefined;
  pending: Map<string, Observation>;
  flushTimer: unknown;
  retryTimer: unknown;
  authTimer: unknown;
  pingTimer: unknown;
  retryMs: number;
  closed: boolean;
  generation: number;
  nextId: number;
  subscribeId: number | undefined;
  lastMessageAt: number;
}

const OFFLINE_CODES = new Set(['OFFLINE', 'TIMEOUT', 'NETWORK', 'DNS']);

export class HomeAssistantProvider implements WorldProvider {
  readonly manifest: ProviderManifest;
  private readonly mapping: CompiledMapping;
  private readonly tokenKey: string | undefined;
  private readonly flushIntervalMs: number;
  private readonly timers: Timers;
  private context!: ProviderContext;
  private settings: HaSettings = parseHaSettings({});
  private endpoint: HaEndpoint = haEndpoint(this.settings);
  private running = false;
  /** Every state read (refused domains never enter), by entity id. */
  private states = new Map<string, HaState>();
  /** Changes of address so far: a read that started under another address is not kept. */
  private epoch = 0;
  /** While `/api/states` is being read: what the socket changed meanwhile (null = removed), applied over the answer. */
  private touched: Map<string, HaState | null> | undefined;
  /** States beyond `HA_MAX_ENTITIES` not kept on the last read. */
  private overCap = 0;
  /** A socket auth failure was retried once after `/api/states` accepted the token; not again until it goes live. */
  private authRetried = false;
  private lastRestAt = 0;
  private needsResync = true;
  private session: Session | undefined;
  private socketState: HaSocketState = 'idle';
  private socketNote: string | undefined;
  private socketError: ProviderError | undefined;
  private socketErrorAt = 0;
  private lastAttempt: IsoTimestamp | undefined;
  private lastSuccess: IsoTimestamp | undefined;
  private lastSuccessMs = 0;
  private lastObservation: IsoTimestamp | undefined;
  private lastError: ProviderError | undefined;
  private lastErrorAt: IsoTimestamp | undefined;
  private objectCount = 0;
  private lastRejected = 0;
  readonly stats = {
    restReads: 0,
    memoryAnswers: 0,
    messages: 0,
    events: 0,
    malformed: 0,
    refused: 0,
    rejected: 0,
    reconnects: 0,
  };

  constructor(
    readonly definition: ConnectorProviderDefinition,
    options: HomeAssistantOptions = {},
  ) {
    this.manifest = homeAssistantManifest(definition);
    this.mapping = compileMapping(definition.mapping);
    this.tokenKey = haTokenKey(definition);
    this.flushIntervalMs = options.flushIntervalMs ?? 500;
    this.timers = options.timers ?? realTimers;
  }

  async initialize(context: ProviderContext): Promise<void> {
    this.context = context;
    this.applySettings(await context.settings.get());
    context.settings.onChange((s) => this.applySettings(s));
  }

  private applySettings(raw: Record<string, unknown>): void {
    const next = parseHaSettings(raw);
    const endpoint = haEndpoint(next);
    const moved =
      endpoint.ok !== this.endpoint.ok ||
      (endpoint.ok && this.endpoint.ok && endpoint.base !== this.endpoint.base) ||
      next.host !== this.settings.host;
    this.settings = next;
    this.endpoint = endpoint;
    if (!moved) return;
    // Another instance: nothing read from the old one stands, and a refusal or an auth
    // failure there says nothing about this one.
    this.epoch++;
    this.states = new Map();
    this.touched = undefined;
    this.needsResync = true;
    this.lastRestAt = 0;
    this.socketNote = undefined;
    this.socketError = undefined;
    if (this.socketState === 'auth-failed') this.socketState = 'waiting';
    this.authRetried = false;
    const session = this.session;
    if (session && !session.closed) {
      session.pending.clear();
      this.dropHandle(session);
      session.retryMs = RECONNECT_MIN_MS;
      this.scheduleReconnect(session, 0);
    }
  }

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.session) this.closeSession(this.session);
  }

  /** What the socket is doing, for tests and diagnostics. */
  get socketStatus(): HaSocketState {
    return this.socketState;
  }

  // -------------------------------------------------------------------------------------
  // REST

  async query(request: ProviderQuery): Promise<Observation[]> {
    const now = this.context.clock.now();
    this.lastAttempt = new Date(now).toISOString();
    try {
      if (request.signal.aborted) throw new ProviderError('CANCELLED', 'cancelled before request');
      // A token that is not stored is refused by the host's HTTP client before anything is sent (AUTH).
      if (!this.tokenKey)
        throw new ProviderError('AUTH', 'the definition declares no token credential', { retryable: false });
      // Not HOST_NOT_ALLOWED: the host stops polling for good on that, and a corrected setting must be read.
      if (!this.endpoint.ok) throw new ProviderError('UNSUPPORTED', this.endpoint.reason);
      const fromMemory = this.socketState === 'live' && !this.needsResync && now - this.lastRestAt < HA_RESYNC_MS;
      if (fromMemory) this.stats.memoryAnswers++;
      else await this.readStates(request.signal);
      const observations = this.snapshot();
      const done = this.context.clock.now();
      this.lastSuccess = new Date(done).toISOString();
      this.lastSuccessMs = done;
      this.lastError = undefined;
      this.objectCount = observations.length;
      if (!fromMemory) this.retrySocketAfterAuth();
      return observations;
    } catch (err) {
      const pe =
        err instanceof ProviderError
          ? err
          : new ProviderError('INTERNAL', err instanceof Error ? err.message : String(err), { cause: err });
      if (pe.code !== 'CANCELLED') {
        this.lastError = pe;
        this.lastErrorAt = new Date(this.context.clock.now()).toISOString();
      }
      throw pe;
    }
  }

  private async readStates(signal: AbortSignal, again = true): Promise<void> {
    if (!this.endpoint.ok) return;
    const url = this.endpoint.statesUrl;
    const epoch = this.epoch;
    const touched = new Map<string, HaState | null>();
    this.touched = touched;
    try {
      await this.readInto(signal, url, epoch, touched, again);
    } finally {
      if (this.touched === touched) this.touched = undefined;
    }
  }

  private async readInto(
    signal: AbortSignal,
    url: string,
    epoch: number,
    touched: Map<string, HaState | null>,
    again: boolean,
  ): Promise<void> {
    let res: Awaited<ReturnType<ProviderContext['http']['request']>>;
    try {
      res = await this.context.http.request({
        url,
        method: 'GET',
        headers: { Accept: 'application/json' },
        credential: { key: this.tokenKey!, as: 'bearer' },
        maxBytes: HA_MAX_STATES_BYTES,
        timeoutMs: this.manifest.refreshPolicy.timeoutMs,
        allowStale: false,
        signal,
      });
    } catch (err) {
      // A failure of the old address after a move says nothing about the new one (an AUTH
      // charged to it would stop polling for good): read the new address instead.
      if (epoch === this.epoch) throw err;
      if (again) return this.readStates(signal, false);
      throw new ProviderError('NETWORK', 'the Home Assistant address changed during the read');
    }
    this.stats.restReads++;
    let body: unknown;
    try {
      body = res.json();
    } catch {
      res.invalidate();
      throw new ProviderError('MALFORMED', `${this.definition.id}: /api/states is not valid JSON`, {
        retryable: false,
      });
    }
    if (!Array.isArray(body)) {
      res.invalidate();
      throw new ProviderError('MALFORMED', `${this.definition.id}: /api/states is not an array of states`, {
        retryable: false,
      });
    }
    if (epoch !== this.epoch) {
      // The address changed while this was in flight: the answer is the old instance's.
      if (again) return this.readStates(signal, false);
      throw new ProviderError('NETWORK', 'the Home Assistant address changed during the read');
    }
    const next = new Map<string, HaState>();
    let invalid = 0;
    let firstProblem: string | undefined;
    let overCap = 0;
    let refused = 0;
    for (const raw of body) {
      const rawId = (raw as { entity_id?: unknown } | null)?.entity_id;
      if (typeof rawId === 'string' && isRefused(rawId)) {
        refused++;
        continue;
      }
      if (next.size >= HA_MAX_ENTITIES) {
        overCap++;
        continue;
      }
      const s = readState(raw);
      if (typeof s === 'string') {
        invalid++;
        firstProblem ??= s;
        continue;
      }
      if (isRefused(s.entity_id)) {
        this.stats.refused++;
        continue;
      }
      next.set(s.entity_id, s);
    }
    this.stats.refused += refused;
    if (invalid && invalid === body.length - refused) {
      res.invalidate();
      const why = `${invalid} entries, none a state (${firstProblem})`;
      throw new ProviderError('MALFORMED', `${this.definition.id}: /api/states: ${why}`, { retryable: false });
    }
    if (invalid) this.context.logger.warn('entries in /api/states that are not states', { count: invalid });
    // What the socket said while this was in flight is newer than the answer.
    for (const [id, s] of touched) {
      if (s === null) next.delete(id);
      else if (next.has(id) || next.size < HA_MAX_ENTITIES) next.set(id, s);
    }
    if (overCap) this.context.logger.warn('states beyond the entity cap not kept', { count: overCap });
    this.overCap = overCap;
    this.states = next;
    this.lastRestAt = this.context.clock.now();
    this.needsResync = false;
  }

  /** `/api/states` accepted the token: a socket stopped by an auth failure may try again, once. */
  private retrySocketAfterAuth(): void {
    const session = this.session;
    if (this.socketState !== 'auth-failed' || this.authRetried || !session || session.closed) return;
    this.authRetried = true;
    this.socketState = 'waiting';
    this.socketError = undefined;
    session.retryMs = RECONNECT_MIN_MS;
    this.scheduleReconnect(session, 0);
  }

  private selected(entityId: string): boolean {
    const selectors = this.settings.entities.items;
    if (selectors.length === 0) return !this.settings.entitiesGiven;
    return matchesAny(entityId, selectors);
  }

  private stateOf = (entityId: string): HaState | undefined => this.states.get(entityId);

  private mapStates(states: HaState[]): {
    observations: Observation[];
    total: number;
    filtered: number;
    rejected: number;
  } {
    const records = states.map((s) => enrich(s, { positions: this.settings.positions.items, stateOf: this.stateOf }));
    const mapped = mapRecords(records, {
      manifest: this.manifest,
      definition: this.definition,
      mapping: this.mapping,
      receivedAt: new Date(this.context.clock.now()).toISOString(),
      origin: 'live',
      sourceRef: this.endpoint.ok ? this.endpoint.base : this.definition.id,
      hash: (x) => this.context.hash.sha256Hex(x),
    });
    if (mapped.rejected.length)
      this.context.logger.warn('rejected entities', {
        count: mapped.rejected.length,
        sample: mapped.rejected.slice(0, 3).map((r) => r.reason),
      });
    return {
      observations: mapped.observations,
      total: mapped.total,
      filtered: mapped.filtered,
      rejected: mapped.rejected.length,
    };
  }

  /** Every selected entity, mapped: a complete snapshot of what this source shows. */
  private snapshot(): Observation[] {
    const selected = [...this.states.values()].filter((s) => this.selected(s.entity_id));
    const mapped = this.mapStates(selected);
    this.lastRejected = mapped.rejected;
    this.stats.rejected += mapped.rejected;
    if (mapped.total > 0 && mapped.observations.length === 0 && mapped.filtered === 0)
      // Every selected entity unusable: the mapping does not fit. Say so rather than show nothing quietly.
      assertAtomicAdmission(mapped.total, 0, `${this.definition.id} entities`);
    this.noteLatest(mapped.observations);
    return mapped.observations;
  }

  private noteLatest(observations: Observation[]): void {
    let latest = this.lastObservation ? Date.parse(this.lastObservation) : Number.NEGATIVE_INFINITY;
    for (const o of observations) {
      const t = Date.parse(o.observedAt);
      if (t > latest) latest = t;
    }
    if (Number.isFinite(latest)) this.lastObservation = new Date(latest).toISOString();
  }

  // -------------------------------------------------------------------------------------
  // WebSocket

  async subscribe(request: ProviderSubscription, emit: ObservationEmitter): Promise<Unsubscribe> {
    if (this.session) this.closeSession(this.session);
    const session: Session = {
      emit,
      handle: undefined,
      pending: new Map(),
      flushTimer: undefined,
      retryTimer: undefined,
      authTimer: undefined,
      pingTimer: undefined,
      retryMs: RECONNECT_MIN_MS,
      closed: false,
      generation: 0,
      nextId: 1,
      subscribeId: undefined,
      lastMessageAt: 0,
    };
    this.session = session;
    request.signal.addEventListener('abort', () => this.closeSession(session), { once: true });
    // A socket that cannot be had is not a failed source: /api/states is read either way,
    // and health says why the socket is not live.
    await this.connect(session);
    return () => this.closeSession(session);
  }

  private current(session: Session, generation: number): boolean {
    return !session.closed && session.generation === generation && this.session === session;
  }

  private async connect(session: Session): Promise<void> {
    if (session.closed) return;
    const generation = ++session.generation;
    session.nextId = 1;
    session.subscribeId = undefined;
    if (!this.endpoint.ok) {
      this.socketState = 'refused';
      this.socketNote = this.endpoint.reason;
      return;
    }
    if (!this.tokenKey) {
      this.authFailed(new ProviderError('AUTH', 'the definition declares no token credential', { retryable: false }));
      return;
    }
    this.socketState = 'connecting';
    const url = this.endpoint.socketUrl;
    let handle: ProviderSocketHandle;
    try {
      handle = await this.context.sockets.open(
        url,
        {
          onOpen: (ctx) => {
            if (!this.current(session, generation)) return;
            // The token exists only inside this callback: it goes into the auth frame and nowhere else.
            const token = ctx?.secret;
            if (!session.handle || token === undefined) {
              this.onDrop(session, new ProviderError('AUTH', 'no token to authenticate the socket with'));
              return;
            }
            session.lastMessageAt = this.context.clock.now();
            this.socketState = 'authenticating';
            this.send(session, { type: 'auth', access_token: token });
            session.authTimer = this.timers.setTimeout(() => {
              session.authTimer = undefined;
              if (this.current(session, generation) && this.socketState === 'authenticating')
                this.onDrop(session, new ProviderError('TIMEOUT', 'Home Assistant did not answer the auth frame'));
            }, HA_AUTH_TIMEOUT_MS);
          },
          onMessage: (data) => {
            if (this.current(session, generation)) this.onMessage(session, data);
          },
          onClose: (code, reason) => {
            if (this.current(session, generation))
              this.onDrop(
                session,
                new ProviderError('OFFLINE', `the socket closed (${code}${reason ? ` ${reason}` : ''})`),
              );
          },
          onError: (error) => {
            if (this.current(session, generation)) this.onDrop(session, new ProviderError('NETWORK', error.message));
          },
        },
        { maxMessageBytes: HA_MAX_MESSAGE_BYTES, credential: { key: this.tokenKey } },
      );
    } catch (err) {
      if (!this.current(session, generation)) return;
      const pe =
        err instanceof ProviderError
          ? err
          : new ProviderError('NETWORK', err instanceof Error ? err.message : String(err));
      if (pe.code === 'AUTH') this.authFailed(pe);
      else if (pe.code === 'HOST_NOT_ALLOWED') {
        // The host does not open this socket (on this build: ws:// to a local host). The REST
        // path carries the source; the socket is asked for again much later.
        this.socketState = 'refused';
        this.socketNote = `the WebSocket API is not available here (${pe.message}); reading /api/states once a minute instead`;
        this.scheduleReconnect(session, HA_REFUSED_RETRY_MS);
      } else this.onDrop(session, pe);
      return;
    }
    if (!this.current(session, generation)) {
      handle.close();
      return;
    }
    session.handle = handle;
  }

  /** Every frame goes through here, and only the three this connector needs get past it. */
  private send(session: Session, frame: HaOutgoingFrame): void {
    if (!(HA_ALLOWED_FRAMES as readonly string[]).includes(frame.type))
      throw new ProviderError('INTERNAL', `refusing to send a "${String(frame.type)}" frame`, { retryable: false });
    session.handle?.send(JSON.stringify(frame));
  }

  private onMessage(session: Session, data: string | Uint8Array): void {
    this.stats.messages++;
    session.lastMessageAt = this.context.clock.now();
    let body: unknown;
    try {
      body = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data));
    } catch {
      this.stats.malformed++;
      return;
    }
    // Home Assistant coalesces messages into an array only when asked to; accept it anyway.
    for (const m of Array.isArray(body) ? body : [body]) {
      if (session.closed) return;
      this.onFrame(session, m);
    }
  }

  private onFrame(session: Session, m: unknown): void {
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      this.stats.malformed++;
      return;
    }
    const msg = m as Record<string, unknown>;
    switch (msg['type']) {
      case 'auth_required':
        return; // the auth frame went out on open
      case 'auth_ok': {
        if (this.socketState !== 'authenticating') return;
        if (session.authTimer !== undefined) this.timers.clearTimeout(session.authTimer);
        session.authTimer = undefined;
        this.socketState = 'subscribing';
        const id = session.nextId++;
        session.subscribeId = id;
        this.send(session, { id, type: 'subscribe_events', event_type: 'state_changed' });
        return;
      }
      case 'auth_invalid': {
        const why = typeof msg['message'] === 'string' ? `: ${msg['message'].slice(0, 200)}` : '';
        this.authFailed(new ProviderError('AUTH', `Home Assistant refused the token${why}`, { retryable: false }));
        return;
      }
      case 'result': {
        if (msg['id'] !== session.subscribeId || this.socketState !== 'subscribing') return;
        if (msg['success'] === true) {
          this.socketState = 'live';
          this.authRetried = false;
          this.socketNote = undefined;
          this.socketError = undefined;
          session.retryMs = RECONNECT_MIN_MS;
          // Events may have been missed before this subscription: the next poll reads /api/states.
          this.needsResync = true;
          this.startPing(session);
          session.emit([], { snapshot: false });
        } else {
          const error = msg['error'] as { message?: unknown } | undefined;
          this.onDrop(
            session,
            new ProviderError(
              'UNSUPPORTED',
              `subscribe_events was refused${typeof error?.message === 'string' ? `: ${error.message.slice(0, 200)}` : ''}`,
            ),
          );
        }
        return;
      }
      case 'event': {
        if (msg['id'] !== session.subscribeId || this.socketState !== 'live') return;
        const event = msg['event'] as { event_type?: unknown; data?: unknown } | undefined;
        if (event?.event_type !== 'state_changed') return;
        this.onStateChanged(session, event.data);
        return;
      }
      default:
        return; // pong, and anything this connector does not use
    }
  }

  private onStateChanged(session: Session, data: unknown): void {
    this.stats.events++;
    if (!data || typeof data !== 'object') {
      this.stats.malformed++;
      return;
    }
    const d = data as { entity_id?: unknown; new_state?: unknown };
    if (typeof d.entity_id === 'string' && isRefused(d.entity_id)) {
      this.stats.refused++;
      return;
    }
    if (d.new_state === null && typeof d.entity_id === 'string') {
      // Removed: gone from the next snapshot.
      this.states.delete(d.entity_id);
      this.touched?.set(d.entity_id, null);
      session.pending.delete(d.entity_id);
      return;
    }
    // Only the new state: old_state never reaches a record.
    const s = readState(d.new_state);
    if (typeof s === 'string') {
      this.stats.malformed++;
      return;
    }
    if (isRefused(s.entity_id)) {
      this.stats.refused++;
      return;
    }
    const before = this.states.get(s.entity_id);
    // A zone whose only change was who is in it (dropped by readState) has nothing to say.
    if (before && s.entity_id.startsWith('zone.') && sameState(before, s)) return;
    if (!before && this.states.size >= HA_MAX_ENTITIES) return;
    this.states.set(s.entity_id, s);
    this.touched?.set(s.entity_id, s);
    if (!this.selected(s.entity_id)) return;
    const mapped = this.mapStates([s]);
    this.stats.rejected += mapped.rejected;
    for (const o of mapped.observations) session.pending.set(o.externalId ?? o.id, o);
    if (session.pending.size === 0) return;
    if (this.flushIntervalMs <= 0) this.flush(session);
    else if (session.flushTimer === undefined)
      session.flushTimer = this.timers.setTimeout(() => {
        session.flushTimer = undefined;
        this.flush(session);
      }, this.flushIntervalMs);
  }

  private flush(session: Session): void {
    if (session.closed || session.pending.size === 0) return;
    const batch = [...session.pending.values()];
    session.pending.clear();
    this.noteLatest(batch);
    session.emit(batch, { snapshot: false });
  }

  private startPing(session: Session): void {
    const generation = session.generation;
    const tick = () => {
      session.pingTimer = undefined;
      if (!this.current(session, generation) || this.socketState !== 'live') return;
      const silent = this.context.clock.now() - session.lastMessageAt;
      if (silent > HA_SILENCE_MS) {
        this.onDrop(
          session,
          new ProviderError('TIMEOUT', `no answer from Home Assistant for ${Math.round(silent / 1000)} s`),
        );
        return;
      }
      this.send(session, { id: session.nextId++, type: 'ping' });
      session.pingTimer = this.timers.setTimeout(tick, HA_PING_MS);
    };
    session.pingTimer = this.timers.setTimeout(tick, HA_PING_MS);
  }

  private clearConnectionTimers(session: Session): void {
    for (const t of [session.authTimer, session.pingTimer]) if (t !== undefined) this.timers.clearTimeout(t);
    session.authTimer = undefined;
    session.pingTimer = undefined;
  }

  /** Close the connection this session holds (not the session): a reconnect may follow. */
  private dropHandle(session: Session): void {
    this.clearConnectionTimers(session);
    session.generation++; // callbacks of the old connection are ignored from here
    const handle = session.handle;
    session.handle = undefined;
    session.subscribeId = undefined;
    handle?.close();
  }

  private onDrop(session: Session, error: ProviderError): void {
    if (session.closed) return;
    this.dropHandle(session);
    this.socketState = 'waiting';
    this.socketError = error;
    this.socketErrorAt = this.context.clock.now();
    this.context.logger.warn('Home Assistant socket lost', { code: error.code, message: error.message });
    session.emit([], { snapshot: false });
    this.scheduleReconnect(session, session.retryMs);
    session.retryMs = Math.min(RECONNECT_MAX_MS, session.retryMs * 2);
  }

  /** The token was refused: nothing is retried until the settings change or the source restarts. */
  private authFailed(error: ProviderError): void {
    const session = this.session;
    if (session) {
      this.dropHandle(session);
      if (session.retryTimer !== undefined) this.timers.clearTimeout(session.retryTimer);
      session.retryTimer = undefined;
    }
    this.socketState = 'auth-failed';
    this.socketNote = `the WebSocket API refused the token (${error.message}); reading /api/states once a minute instead`;
    this.socketError = error;
    this.socketErrorAt = this.context.clock.now();
    this.context.logger.warn('Home Assistant refused the token', { message: error.message });
    session?.emit([], { snapshot: false });
  }

  private scheduleReconnect(session: Session, ms: number): void {
    if (session.retryTimer !== undefined) this.timers.clearTimeout(session.retryTimer);
    session.retryTimer = this.timers.setTimeout(() => {
      session.retryTimer = undefined;
      if (session.closed || !this.running) return;
      this.stats.reconnects++;
      void this.connect(session);
    }, ms);
  }

  private closeSession(session: Session): void {
    if (session.closed) return;
    session.closed = true;
    this.dropHandle(session);
    for (const t of [session.flushTimer, session.retryTimer]) if (t !== undefined) this.timers.clearTimeout(t);
    session.flushTimer = undefined;
    session.retryTimer = undefined;
    if (this.session === session) {
      this.session = undefined;
      if (this.socketState !== 'auth-failed') this.socketState = 'idle';
    }
  }

  // -------------------------------------------------------------------------------------

  async health(): Promise<ProviderHealth> {
    const credentialState: CredentialState = !this.tokenKey
      ? 'missing'
      : this.context && (await this.context.credentials.has(this.tokenKey))
        ? 'present'
        : 'missing';
    let status: ProviderStatus;
    let message: string | undefined;
    const lastErrorMs = this.lastErrorAt ? Date.parse(this.lastErrorAt) : 0;
    if (!this.running) status = 'DISABLED';
    else if (credentialState === 'missing') {
      status = 'AUTH_REQUIRED';
      message = `credential ${this.tokenKey ?? '(none declared)'} not configured`;
    } else if (!this.endpoint.ok) {
      status = 'ERROR';
      message = this.endpoint.reason;
    } else if (
      this.lastError?.code === 'AUTH' ||
      (this.socketState === 'auth-failed' && this.socketErrorAt > this.lastSuccessMs)
    ) {
      status = 'AUTH_REQUIRED';
      message = (this.lastError?.code === 'AUTH' ? this.lastError : this.socketError)?.message;
    } else if (this.lastError && lastErrorMs >= this.lastSuccessMs) {
      status = OFFLINE_CODES.has(this.lastError.code) ? 'OFFLINE' : 'ERROR';
      message = this.lastError.message;
    } else if (this.socketState === 'live') {
      status = 'LIVE';
      message = 'live over the WebSocket API';
    } else if (this.socketError && this.socketErrorAt > this.lastSuccessMs) {
      status = 'OFFLINE';
      message = this.socketError.message;
    } else if (this.lastSuccess) {
      status = 'LIVE';
      message = `reading /api/states once a minute${this.socketNote ? `; ${this.socketNote}` : ''}`;
    } else status = 'STARTING';
    const problems = [...this.settings.entities.problems, ...this.settings.positions.problems];
    if (this.settings.entitiesGiven && this.settings.entities.items.length === 0)
      problems.unshift('no valid pattern in Entities, so nothing is shown');

    if (problems.length) message = `${message ? `${message}; ` : ''}settings: ${problems.slice(0, 3).join('; ')}`;
    if (this.overCap)
      message = `${message ? `${message}; ` : ''}${this.overCap} states beyond the ${HA_MAX_ENTITIES}-entity cap not kept`;
    if (this.lastRejected && status === 'LIVE')
      message = `${message ? `${message}; ` : ''}${this.lastRejected} selected entit${this.lastRejected === 1 ? 'y' : 'ies'} rejected by the mapping on the last snapshot`;
    const h: ProviderHealth = {
      providerId: this.manifest.id,
      status,
      errorRate: 0,
      rateLimitState: { limited: false },
      credentialState,
      objectCount: this.objectCount,
    };
    if (message) h.message = message;
    if (this.lastAttempt) h.lastAttempt = this.lastAttempt;
    if (this.lastSuccess) h.lastSuccess = this.lastSuccess;
    if (this.lastObservation) h.lastObservation = this.lastObservation;
    if (this.lastError && this.lastErrorAt) h.lastError = this.lastError.toInfo(this.lastErrorAt);
    return h;
  }
}

/** Domain names a definition's filter selects with `in`/`equals` on `_domain`. */
function filteredDomains(d: ConnectorProviderDefinition): string[] {
  const out: string[] = [];
  for (const c of d.mapping.filter ?? []) {
    if (c.path !== '_domain') continue;
    if (typeof c.equals === 'string') out.push(c.equals);
    for (const v of c.in ?? []) if (typeof v === 'string') out.push(v);
  }
  return out;
}

export function validateHomeAssistant(d: ConnectorProviderDefinition): ConnectorValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (d.endpoint || d.websocket)
    errors.push(
      'endpoint and websocket are not used: the instance is the source’s host, port and tls settings (a definition never holds an address)',
    );
  if (d.file) errors.push('file is not used by this connector');
  if (d.boundsQuery) errors.push('boundsQuery is not supported: Home Assistant answers with every state at once');
  const credentials = Object.keys(d.credentials ?? {});
  if (credentials.length !== 1)
    errors.push('declare exactly one credential — the long-lived access token — by reference in credentials');
  if (d.pagination) warnings.push('pagination is ignored by this connector');
  if (d.response) warnings.push('response is ignored by this connector');
  const idPath = typeof d.mapping.externalId === 'string' ? d.mapping.externalId : d.mapping.externalId.path;
  if (idPath !== 'entity_id') warnings.push('mapping.externalId is not entity_id: objects may not keep their identity');
  const zonesOnly = filteredDomains(d).length > 0 && filteredDomains(d).every((x) => x === 'zone');
  if (!d.mapping.observedAt && !zonesOnly)
    warnings.push('mapping.observedAt is unset: every observation carries the fetch time');
  const refused = filteredDomains(d).filter((x) => REFUSED_DOMAINS.has(x));
  if (refused.length)
    warnings.push(
      `${refused.join(', ')} entities are never read (docs/PRODUCT-BOUNDARIES.md); the filter selects nothing there`,
    );
  for (const s of d.settings ?? [])
    if (HA_SETTING_KEYS.has(s.key))
      warnings.push(`setting "${s.key}" is the connector's own; the definition's is ignored`);
  if (!d.freshness) warnings.push("freshness is unset: the object type's default applies");
  return { ok: errors.length === 0, errors, warnings };
}

export const homeAssistantConnector: Connector = {
  metadata: {
    id: HOME_ASSISTANT_CONNECTOR_ID,
    name: CONNECTOR_NAME,
    description:
      'Your own Home Assistant, read-only: /api/states, then state_changed events over the WebSocket API, with a long-lived token by reference.',
    uses: ['mapping'],
    dataset: 'LIVE_OBJECTS',
  },
  validate: validateHomeAssistant,
  createProvider: (d) => new HomeAssistantProvider(d),
};
