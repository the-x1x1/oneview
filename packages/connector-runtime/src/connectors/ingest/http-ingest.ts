import type { IsoTimestamp, JsonValue, Observation } from '@worldview/world-model';
import {
  ProviderError,
  checkListenerOptions,
  LISTENER_DEFAULT_MAX_BODY_BYTES,
  LISTENER_DEFAULT_MAX_REQUESTS_PER_MINUTE,
  LISTENER_MAX_BODY_BYTES,
  LISTENER_MAX_REQUESTS_PER_MINUTE,
  type CredentialState,
  type LocalListenerHandle,
  type LocalRequest,
  type LocalResponse,
  type ObservationEmitter,
  type ProviderContext,
  type ProviderHealth,
  type ProviderManifest,
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
import type { Timers } from '../websocket-json.js';
import { MAX_RECORDS_PER_PUSH, parseEnvelope } from './envelope.js';

/**
 * `http-ingest` (phase `ingest`): a source that is pushed to instead of polled. While the
 * source runs, the host opens one HTTP listener for it on 127.0.0.1 (ADR-003 amendment
 * 2026-09-23, `ProviderLocalAccess.listen`) at `/ingest/<definition id>`, on the port in the
 * source's `port` setting (default 47311). A Node-RED flow, a script or a gateway POSTs the
 * `oneview.ingest.v1` envelope (or a bare array of records) with the source's bearer token;
 * each record goes through the definition's mapping and the observations are emitted as a
 * delta (`snapshot: false`). The host has refused everything else before this code runs —
 * another address, Host, path or method, a missing or wrong token, a body over the cap, a
 * pusher over the rate — and the token never reaches the provider. This code answers what
 * it can judge: `202` with counts, or `400` with the reason.
 */
export const HTTP_INGEST_CONNECTOR_ID = 'http-ingest';
export const INGEST_DEFAULT_PORT = 47311;
/** The settings a definition may declare to let the operator move the listener or its caps. */
export const INGEST_PORT_SETTING = 'port';
export const INGEST_MAX_BODY_SETTING = 'maxBodyBytes';
export const INGEST_RATE_SETTING = 'maxRequestsPerMinute';
const REASONS_IN_ANSWER = 5;
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 60_000;
const MAX_USER_AGENT = 120;

/** The one path a source's listener serves. */
export function ingestPath(id: string): string {
  return `/ingest/${id}`;
}

export interface IngestListenerConfig {
  port: number;
  path: string;
  maxBodyBytes: number;
  maxRequestsPerMinute: number;
}

const SETTING_BOUNDS: Record<string, { min: number; max: number; fallback: number }> = {
  [INGEST_PORT_SETTING]: { min: 1024, max: 65535, fallback: INGEST_DEFAULT_PORT },
  [INGEST_MAX_BODY_SETTING]: { min: 1, max: LISTENER_MAX_BODY_BYTES, fallback: LISTENER_DEFAULT_MAX_BODY_BYTES },
  [INGEST_RATE_SETTING]: {
    min: 1,
    max: LISTENER_MAX_REQUESTS_PER_MINUTE,
    fallback: LISTENER_DEFAULT_MAX_REQUESTS_PER_MINUTE,
  },
};

function settingNumber(settings: Record<string, JsonValue>, key: string): number {
  const bounds = SETTING_BOUNDS[key]!;
  const raw = settings[key];
  if (raw === undefined || raw === null || raw === '') return bounds.fallback;
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < bounds.min || n > bounds.max)
    throw new ProviderError(
      'UNSUPPORTED',
      `setting "${key}" is ${JSON.stringify(raw)}; it must be a whole number from ${bounds.min} to ${bounds.max}`,
      { retryable: false },
    );
  return n;
}

/** Where and how the listener opens, from the operator's settings (defaults where unset). */
export function listenerConfigOf(
  definition: ConnectorProviderDefinition,
  settings: Record<string, JsonValue>,
): IngestListenerConfig {
  const config: IngestListenerConfig = {
    port: settingNumber(settings, INGEST_PORT_SETTING),
    path: ingestPath(definition.id),
    maxBodyBytes: settingNumber(settings, INGEST_MAX_BODY_SETTING),
    maxRequestsPerMinute: settingNumber(settings, INGEST_RATE_SETTING),
  };
  const checked = checkListenerOptions({ ...config, credential: { key: 'x' } });
  if (!checked.ok) throw new ProviderError('UNSUPPORTED', checked.reason, { retryable: false });
  return config;
}

/** The manifest a definition amounts to: a `local-process` source with no host to reach. */
export function ingestManifest(definition: ConnectorProviderDefinition): ProviderManifest {
  const base = definitionToManifest(definition, 'HTTP ingest');
  return {
    ...base,
    transport: 'local-process',
    capabilities: { live: true, historical: false, offline: false, boundsQuery: false },
    // Without its token the listener refuses every push.
    credentials: base.credentials.map((c) => ({ ...c, required: true })),
    allowedHosts: [],
  };
}

interface OpenListener {
  handle: LocalListenerHandle;
  /** Aborting it closes the listener and frees the host's one-per-source slot. */
  abort: AbortController;
  config: IngestListenerConfig;
}

interface Session {
  emit: ObservationEmitter;
  listener: OpenListener | undefined;
  closed: boolean;
  /** Bumped per (re)open, so a slow open overtaken by a close or a newer open is undone. */
  generation: number;
  /** Serialises the first open, reopens after a settings change, and retries. */
  queue: Promise<void>;
  unsubscribeSettings: Unsubscribe | undefined;
  /** A reopen that failed (the port in use) is tried again on this timer. */
  retryTimer: unknown;
  retryMs: number;
}

export interface IngestPushSummary {
  at: IsoTimestamp;
  userAgent: string | undefined;
  accepted: number;
  rejected: number;
  filtered: number;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    if (typeof h === 'object' && h !== null && 'unref' in h) (h as { unref(): void }).unref();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface HttpIngestOptions {
  timers?: Timers;
  /** Backoff for reopening after a settings change failed to open (default 2 s to a minute). */
  retryMinMs?: number;
  retryMaxMs?: number;
}

export class HttpIngestProvider implements WorldProvider {
  readonly manifest: ProviderManifest;
  private context!: ProviderContext;
  private readonly mapping: CompiledMapping;
  private readonly credentialKey: string;
  private readonly timers: Timers;
  private readonly retryMinMs: number;
  private readonly retryMaxMs: number;
  private session: Session | undefined;
  private running = false;
  private lastAttempt: IsoTimestamp | undefined;
  private lastObservation: IsoTimestamp | undefined;
  private lastError: ProviderError | undefined;
  private lastErrorAt: IsoTimestamp | undefined;
  /** The last push this source took (202), and the last body it refused (400), in this run. */
  lastPush: IngestPushSummary | undefined;
  lastRefusal: { at: IsoTimestamp; reason: string } | undefined;
  /** Objects pushed in this run (for health's objectCount). */
  private readonly ids = new Set<string>();
  readonly stats = { pushes: 0, refusedBodies: 0, records: 0, observations: 0, rejected: 0, filtered: 0, reopens: 0 };

  constructor(
    readonly definition: ConnectorProviderDefinition,
    options: HttpIngestOptions = {},
  ) {
    const names = Object.keys(definition.credentials ?? {});
    if (names.length !== 1)
      throw new Error(`${definition.id}: an http-ingest source declares exactly one credential (the bearer token)`);
    this.credentialKey = definition.credentials![names[0]!]!.secretRef;
    this.manifest = ingestManifest(definition);
    this.mapping = compileMapping(definition.mapping);
    this.timers = options.timers ?? realTimers;
    this.retryMinMs = options.retryMinMs ?? RETRY_MIN_MS;
    this.retryMaxMs = options.retryMaxMs ?? RETRY_MAX_MS;
  }

  async initialize(context: ProviderContext): Promise<void> {
    this.context = context;
  }
  async start(): Promise<void> {
    this.running = true;
    // Health describes this run: nothing from before a stop is reported as current.
    this.lastPush = undefined;
    this.lastRefusal = undefined;
    this.lastObservation = undefined;
    this.lastError = undefined;
    this.lastErrorAt = undefined;
    this.ids.clear();
  }
  async stop(): Promise<void> {
    this.running = false;
    if (this.session) await this.closeSession(this.session);
  }

  /**
   * The listener lives as long as the subscription: the host subscribes once the source
   * runs, and a failed first open (the port in use) is retried by the host with its backoff;
   * a failed reopen after a settings change is retried here.
   */
  async subscribe(request: ProviderSubscription, emit: ObservationEmitter): Promise<Unsubscribe> {
    if (this.session) await this.closeSession(this.session);
    const cancelled = () =>
      new ProviderError('CANCELLED', 'the subscription was cancelled before the listener opened', {
        retryable: false,
      });
    if (request.signal.aborted) throw cancelled();
    const session: Session = {
      emit,
      listener: undefined,
      closed: false,
      generation: 0,
      queue: Promise.resolve(),
      unsubscribeSettings: undefined,
      retryTimer: undefined,
      retryMs: this.retryMinMs,
    };
    this.session = session;
    request.signal.addEventListener('abort', () => void this.closeSession(session), { once: true });
    // Watched before the first open, so a change made while the port opens is not lost: it
    // is queued behind the open and applied once it finishes.
    session.unsubscribeSettings = this.context.settings.onChange((settings) => this.enqueue(session, settings));
    const first = this.context.settings.get().then((settings) => this.open(session, settings));
    session.queue = first.catch(() => undefined);
    try {
      await first;
    } catch (err) {
      await this.closeSession(session);
      throw err;
    }
    if (session.closed) throw cancelled();
    return () => void this.closeSession(session);
  }

  private enqueue(session: Session, settings: Record<string, JsonValue>): void {
    if (session.closed) return;
    session.queue = session.queue.then(() => this.reopen(session, settings));
  }

  /** The port or a cap changed: close the listener and open it again as the settings now say. */
  private async reopen(session: Session, settings: Record<string, JsonValue>): Promise<void> {
    if (session.closed) return;
    if (session.retryTimer !== undefined) {
      this.timers.clearTimeout(session.retryTimer);
      session.retryTimer = undefined;
    }
    let next: IngestListenerConfig;
    try {
      next = listenerConfigOf(this.definition, settings);
    } catch (err) {
      // A refused value leaves the working listener where it is; health says why.
      this.fail(asProviderError(err));
      this.announce(session);
      return;
    }
    const current = session.listener?.config;
    if (
      current &&
      current.port === next.port &&
      current.maxBodyBytes === next.maxBodyBytes &&
      current.maxRequestsPerMinute === next.maxRequestsPerMinute
    ) {
      if (this.lastError) {
        this.lastError = undefined;
        this.lastErrorAt = undefined;
        this.announce(session);
      }
      return;
    }
    if (session.listener) await this.closeListener(session.listener);
    session.listener = undefined;
    this.stats.reopens++;
    try {
      await this.open(session, settings);
      session.retryMs = this.retryMinMs;
    } catch {
      // Recorded by open(). Tried again with a backoff until it opens, the settings change or
      // the source stops — the host does not know the subscription lost its listener.
      if (!session.closed) {
        const delay = session.retryMs;
        session.retryMs = Math.min(this.retryMaxMs, session.retryMs * 2);
        session.retryTimer = this.timers.setTimeout(() => {
          session.retryTimer = undefined;
          if (session.closed) return;
          session.queue = session.queue.then(async () => {
            if (session.closed || session.listener) return;
            await this.reopen(session, await this.context.settings.get());
          });
        }, delay);
      }
    }
    this.announce(session);
  }

  private async open(session: Session, settings: Record<string, JsonValue>): Promise<void> {
    const generation = ++session.generation;
    this.lastAttempt = this.nowIso();
    let config: IngestListenerConfig;
    try {
      config = listenerConfigOf(this.definition, settings);
    } catch (err) {
      throw this.fail(asProviderError(err));
    }
    const listen = this.context.local.listen;
    if (!listen)
      throw this.fail(
        new ProviderError('UNSUPPORTED', 'this host offers no loopback listener (local-process sources only)', {
          retryable: false,
        }),
      );
    const abort = new AbortController();
    let handle: LocalListenerHandle;
    try {
      handle = await listen.call(
        this.context.local,
        {
          port: config.port,
          path: config.path,
          credential: { key: this.credentialKey },
          maxBodyBytes: config.maxBodyBytes,
          maxRequestsPerMinute: config.maxRequestsPerMinute,
          signal: abort.signal,
        },
        (req) => this.onRequest(session, config, req),
      );
    } catch (err) {
      throw this.fail(asProviderError(err));
    }
    const opened: OpenListener = { handle, abort, config };
    if (session.closed || session.generation !== generation) {
      await this.closeListener(opened);
      return;
    }
    session.listener = opened;
    this.lastError = undefined;
    this.lastErrorAt = undefined;
  }

  /**
   * An empty delta: nothing changes in the world, but the host publishes the source's health
   * on every emit — the only way a subscription source tells Source Health that something
   * happened (a refused body, a reopened listener) when no observation came of it.
   */
  private announce(session: Session): void {
    if (!session.closed) session.emit([], { snapshot: false });
  }

  private onRequest(session: Session, config: IngestListenerConfig, req: LocalRequest): LocalResponse {
    if (session.closed || session.listener?.config !== config)
      return answer(503, { error: 'the source is stopping or moving to another port; send again' });
    const at = this.nowIso();
    this.lastAttempt = at;
    try {
      return this.take(session, config, req, at);
    } finally {
      this.announce(session);
    }
  }

  /** A 400 for the pusher; `forHealth` is what Source Health shows as the last bad body. */
  private refuse(
    at: IsoTimestamp,
    reason: string,
    extra: Record<string, JsonValue> = {},
    forHealth = reason,
  ): LocalResponse {
    this.stats.refusedBodies++;
    this.lastRefusal = { at, reason: forHealth };
    return answer(400, { error: reason, ...extra });
  }

  private take(session: Session, config: IngestListenerConfig, req: LocalRequest, at: IsoTimestamp): LocalResponse {
    const parsed = parseEnvelope(req.body, this.definition.id);
    if (!parsed.ok) return this.refuse(at, parsed.reason);
    const mapped = mapRecords(parsed.records, {
      manifest: this.manifest,
      definition: this.definition,
      mapping: this.mapping,
      receivedAt: at,
      origin: 'live',
      sourceRef: `http://127.0.0.1:${config.port}${config.path}`,
      hash: (s) => this.context.hash.sha256Hex(s),
      maxRecords: MAX_RECORDS_PER_PUSH,
    });
    const reasons = mapped.rejected.slice(0, REASONS_IN_ANSWER);
    if (mapped.total > 0 && mapped.observations.length === 0 && mapped.filtered === 0) {
      this.stats.rejected += mapped.rejected.length;
      const first = reasons[0]?.reason ?? 'rejected';
      return this.refuse(
        at,
        'no record could be mapped',
        { accepted: 0, rejected: mapped.rejected.length, reasons },
        `no record could be mapped (${first})`,
      );
    }
    this.stats.pushes++;
    this.stats.records += mapped.total;
    this.stats.observations += mapped.observations.length;
    this.stats.rejected += mapped.rejected.length;
    this.stats.filtered += mapped.filtered;
    for (const o of mapped.observations) {
      this.ids.add(o.externalId ?? o.id);
      if (this.ids.size > 100_000) this.ids.delete(this.ids.values().next().value!);
    }
    this.lastPush = {
      at,
      userAgent: userAgentOf(req.headers),
      accepted: mapped.observations.length,
      rejected: mapped.rejected.length,
      filtered: mapped.filtered,
    };
    if (mapped.observations.length) {
      this.lastObservation = at;
      session.emit(mapped.observations, { snapshot: false });
    }
    return answer(202, {
      accepted: mapped.observations.length,
      rejected: mapped.rejected.length,
      filtered: mapped.filtered,
      timedAtReceipt: mapped.observations.filter(receiptTimed).length,
      ...(reasons.length ? { reasons } : {}),
    });
  }

  private async closeSession(session: Session): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    session.generation++;
    session.unsubscribeSettings?.();
    session.unsubscribeSettings = undefined;
    if (session.retryTimer !== undefined) this.timers.clearTimeout(session.retryTimer);
    session.retryTimer = undefined;
    const listener = session.listener;
    session.listener = undefined;
    if (this.session === session) this.session = undefined;
    if (listener) await this.closeListener(listener);
  }

  private async closeListener(listener: OpenListener): Promise<void> {
    listener.abort.abort();
    await listener.handle.close().catch(() => undefined);
  }

  private fail(err: ProviderError): ProviderError {
    this.lastError = err;
    this.lastErrorAt = this.nowIso();
    return err;
  }
  private nowIso(): IsoTimestamp {
    return new Date(this.context.clock.now()).toISOString();
  }

  /** The listener's address while it is open (for health and the tests). */
  get listening(): { port: number; path: string } | undefined {
    const l = this.session?.listener;
    return l ? { port: l.handle.port, path: l.config.path } : undefined;
  }

  async health(): Promise<ProviderHealth> {
    const listener = this.session?.listener;
    const credentialState: CredentialState =
      this.context && (await this.context.credentials.has(this.credentialKey)) ? 'present' : 'missing';
    let status: ProviderStatus;
    let message: string | undefined;
    const where = listener ? `127.0.0.1:${listener.handle.port}${listener.config.path}` : undefined;
    if (!this.running) status = 'DISABLED';
    else if (credentialState === 'missing') {
      status = 'AUTH_REQUIRED';
      message = `no bearer token is stored under ${this.credentialKey}; every push is refused (401) until one is`;
    } else if (!listener && this.lastError) {
      status = this.lastError.code === 'OFFLINE' ? 'OFFLINE' : 'ERROR';
      message = this.lastError.message;
      if (this.session?.retryTimer !== undefined) message += '; trying again';
    } else if (!listener) status = 'STARTING';
    else if (this.lastPush) {
      status = 'LIVE';
      const p = this.lastPush;
      message = `listening on ${where}; last push ${p.at}${p.userAgent ? ` from ${p.userAgent}` : ''}: ${p.accepted} accepted, ${p.rejected} rejected`;
    } else {
      status = 'STARTING';
      message = `listening on ${where}; no push yet`;
    }
    const refused = listener ? refusedSummary(listener.handle.refused) : '';
    if (message && refused) message += `; refused before the source: ${refused}`;
    if (message && this.lastRefusal && (!this.lastPush || this.lastRefusal.at >= this.lastPush.at))
      message += `; last bad body ${this.lastRefusal.at}: ${this.lastRefusal.reason}`;
    if (listener && this.lastError && (status === 'LIVE' || status === 'STARTING')) {
      // Still listening, but the operator's latest setting was refused: the listener did not move.
      status = 'DEGRADED';
      message = `${message}; ${this.lastError.message} (still listening on ${where})`;
    }
    const h: ProviderHealth = {
      providerId: this.manifest.id,
      status,
      errorRate: 0,
      rateLimitState: { limited: false },
      credentialState,
      objectCount: this.ids.size,
    };
    if (message) h.message = message;
    if (this.lastAttempt) h.lastAttempt = this.lastAttempt;
    if (this.lastPush) h.lastSuccess = this.lastPush.at;
    if (this.lastObservation) h.lastObservation = this.lastObservation;
    if (this.lastError && this.lastErrorAt) h.lastError = this.lastError.toInfo(this.lastErrorAt);
    return h;
  }
}

function answer(status: number, body: Record<string, JsonValue>): LocalResponse {
  return { status, body: JSON.stringify(body) };
}

function asProviderError(err: unknown): ProviderError {
  return err instanceof ProviderError
    ? err
    : new ProviderError('INTERNAL', err instanceof Error ? err.message : String(err), { cause: err });
}

function receiptTimed(o: Observation): boolean {
  return o.quality.flags?.includes('fetch-time') ?? false;
}

/** The pusher's User-Agent for health: printable, short, or nothing. */
function userAgentOf(headers: Record<string, string>): string | undefined {
  const ua = headers['user-agent'];
  if (!ua) return undefined;
  const clean = ua.replace(/[^\x20-\x7e]/g, '').trim();
  if (!clean) return undefined;
  return clean.length > MAX_USER_AGENT ? `${clean.slice(0, MAX_USER_AGENT - 3)}...` : clean;
}

function refusedSummary(refused: Record<number, number>): string {
  return Object.entries(refused)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([status, n]) => `${status}×${n}`)
    .join(', ');
}

export function validateHttpIngest(d: ConnectorProviderDefinition): ConnectorValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (d.endpoint) errors.push('an http-ingest source is pushed to: it has no endpoint');
  if (d.websocket) errors.push('an http-ingest source is pushed to: it has no websocket');
  if (d.file) errors.push('an http-ingest source is pushed to: it has no file');
  if (d.boundsQuery) errors.push('boundsQuery does not apply to a source that is pushed to');
  if (d.pagination) warnings.push('pagination is ignored by this connector');
  if (d.response) warnings.push('response is ignored: records are the envelope\'s "records" or the pushed array');
  const credentials = Object.entries(d.credentials ?? {});
  if (credentials.length !== 1)
    errors.push('declare exactly one credential: the bearer token pushers send (kind "token")');
  else if (credentials[0]![1].kind !== 'token')
    warnings.push(`credential "${credentials[0]![0]}" is the bearer token; give it kind "token"`);
  const path = ingestPath(d.id);
  const checked = checkListenerOptions({ port: INGEST_DEFAULT_PORT, path, credential: { key: 'x' } });
  if (!checked.ok) errors.push(`the listener path ${path}: ${checked.reason}`);
  for (const [key, bounds] of Object.entries(SETTING_BOUNDS)) {
    const s = d.settings?.find((x) => x.key === key);
    if (!s) continue;
    if (s.kind !== 'number') errors.push(`setting "${key}" must be a number setting`);
    if (s.min !== undefined && s.min < bounds.min) errors.push(`setting "${key}" min is below ${bounds.min}`);
    if (s.max !== undefined && s.max > bounds.max) errors.push(`setting "${key}" max is above ${bounds.max}`);
  }
  if (!d.settings?.some((s) => s.key === INGEST_PORT_SETTING))
    warnings.push(
      `no "${INGEST_PORT_SETTING}" setting: the listener is fixed at port ${INGEST_DEFAULT_PORT}, and two sources cannot share a port`,
    );
  if (!d.mapping.observedAt)
    warnings.push('mapping.observedAt is unset: every observation carries the receipt time (flagged fetch-time)');
  return { ok: errors.length === 0, errors, warnings };
}

export const httpIngestConnector: Connector = {
  metadata: {
    id: HTTP_INGEST_CONNECTOR_ID,
    name: 'HTTP ingest',
    description:
      'Records pushed by Node-RED, a script or a gateway to a token-protected listener on 127.0.0.1; mapped as they arrive.',
    uses: ['mapping'],
    dataset: 'EVENT_STREAM',
  },
  validate: validateHttpIngest,
  createProvider: (d) => new HttpIngestProvider(d),
};
