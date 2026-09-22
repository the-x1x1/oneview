import {
  observationId,
  observationSchema,
  formatIssues,
  type GeoPosition,
  type JsonValue,
  type Observation,
  type ObservationQuality,
  type WorldGeometry,
  type IsoTimestamp,
  type ProvenanceOrigin,
} from '@worldview/world-model';
import type { ProviderManifest } from './manifest.js';
import type { ProviderContext, ProviderQuery, WorldProvider } from './provider.js';
import { ProviderError, type ProviderHealth, type ProviderStatus, type CredentialState } from './health.js';

export interface ObservationDraft {
  externalId: string;
  objectType: string;
  observedAt: IsoTimestamp;
  position?: GeoPosition;
  geometry?: WorldGeometry;
  payload: Record<string, JsonValue>;
  quality?: Partial<ObservationQuality>;
  effectiveFrom?: IsoTimestamp;
  effectiveUntil?: IsoTimestamp;
  rawPayloadHash?: string;
  origin?: ProvenanceOrigin;
  sourceRef?: string;
}

/**
 * Build a canonical Observation from a provider draft. Fills id, receivedAt and
 * provenance from the manifest so providers cannot mislabel their data.
 */
export function buildObservation(
  manifest: ProviderManifest,
  receivedAt: IsoTimestamp,
  draft: ObservationDraft,
): Observation {
  const quality: ObservationQuality = {
    complete: draft.quality?.complete ?? true,
    sourceQuality: draft.quality?.sourceQuality ?? 'unknown',
  };
  if (draft.quality?.positionAccuracyM !== undefined) quality.positionAccuracyM = draft.quality.positionAccuracyM;
  if (draft.quality?.flags !== undefined) quality.flags = draft.quality.flags;

  const obs: Observation = {
    id: observationId(manifest.id, draft.externalId, draft.observedAt),
    providerId: manifest.id,
    externalId: draft.externalId,
    objectType: draft.objectType,
    observedAt: draft.observedAt,
    receivedAt,
    payload: draft.payload,
    quality,
    provenance: {
      providerId: manifest.id,
      sourceName: manifest.name,
      origin: draft.origin ?? 'live',
      attribution: manifest.attribution.text,
      receivedAt,
      ...(manifest.attribution.licenseId ? { licenseId: manifest.attribution.licenseId } : {}),
      ...(manifest.dataPolicy.termsUrl ? { termsUrl: manifest.dataPolicy.termsUrl } : {}),
      ...(draft.sourceRef ? { sourceRef: draft.sourceRef } : {}),
    },
  };
  if (draft.position) obs.position = draft.position;
  if (draft.geometry) obs.geometry = draft.geometry;
  if (draft.effectiveFrom) obs.effectiveFrom = draft.effectiveFrom;
  if (draft.effectiveUntil) obs.effectiveUntil = draft.effectiveUntil;
  if (draft.rawPayloadHash && manifest.dataPolicy.rawPayloadRetentionAllowed) obs.rawPayloadHash = draft.rawPayloadHash;
  return obs;
}

/** Validate a batch; returns accepted observations and structured rejections. Never throws. */
export function admitObservations(observations: unknown[]): {
  accepted: Observation[];
  rejected: Array<{ index: number; reason: string }>;
} {
  const accepted: Observation[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  observations.forEach((o, index) => {
    const r = observationSchema.parse(o);
    if (r.ok) accepted.push(r.value);
    else rejected.push({ index, reason: formatIssues(r.issues, 3) });
  });
  return { accepted, rejected };
}

/**
 * Atomic admission (from GEV's live contract): a non-empty feed that yields zero
 * valid rows is malformed and must not replace the last good snapshot.
 */
export function assertAtomicAdmission(rowCount: number, acceptedCount: number, label: string): void {
  if (rowCount > 0 && acceptedCount === 0)
    throw new ProviderError('MALFORMED', `${label}: ${rowCount} rows, none valid`);
}

/**
 * PollingProvider — base class for HTTP polling providers. Subclasses implement
 * `fetchOnce`. Health bookkeeping, credential checks and error mapping are shared.
 */
export abstract class PollingProvider implements WorldProvider {
  abstract readonly manifest: ProviderManifest;
  protected context!: ProviderContext;
  private running = false;
  private lastAttempt: IsoTimestamp | undefined;
  private lastSuccess: IsoTimestamp | undefined;
  private lastObservation: IsoTimestamp | undefined;
  private latencyMs: number | undefined;
  private lastError: ProviderError | undefined;
  private lastErrorAt: IsoTimestamp | undefined;
  private cacheAgeMs: number | undefined;
  private attempts = 0;
  private failures = 0;
  private objectCount = 0;
  private readonly window: boolean[] = [];

  async initialize(context: ProviderContext): Promise<void> {
    this.context = context;
    await this.onInitialize?.(context);
  }

  protected onInitialize?(context: ProviderContext): Promise<void>;

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  /** Implemented by subclasses: perform one fetch/normalize cycle. */
  protected abstract fetchOnce(request: ProviderQuery): Promise<{ observations: Observation[]; cacheAgeMs?: number }>;

  async query(request: ProviderQuery): Promise<Observation[]> {
    const now = this.context.clock.now();
    this.lastAttempt = new Date(now).toISOString();
    this.attempts++;
    try {
      const credentialState = await this.credentialState();
      if (credentialState === 'missing') throw new ProviderError('AUTH', 'credential required', { retryable: false });
      const result = await this.fetchOnce(request);
      const doneAt = this.context.clock.now();
      this.latencyMs = doneAt - now;
      this.lastSuccess = new Date(doneAt).toISOString();
      this.cacheAgeMs = result.cacheAgeMs ?? 0;
      this.lastError = undefined;
      this.objectCount = result.observations.length;
      let latest = this.lastObservation ? Date.parse(this.lastObservation) : Number.NEGATIVE_INFINITY;
      for (const o of result.observations) {
        const t = Date.parse(o.observedAt);
        if (t > latest) latest = t;
      }
      if (Number.isFinite(latest)) this.lastObservation = new Date(latest).toISOString();
      this.record(true);
      return result.observations;
    } catch (err) {
      const pe =
        err instanceof ProviderError
          ? err
          : new ProviderError('INTERNAL', err instanceof Error ? err.message : String(err), { cause: err });
      if (pe.code !== 'CANCELLED') {
        this.lastError = pe;
        this.lastErrorAt = new Date(this.context.clock.now()).toISOString();
        this.failures++;
        this.record(false);
      }
      throw pe;
    }
  }

  private record(success: boolean): void {
    this.window.push(success);
    if (this.window.length > 20) this.window.shift();
  }

  protected async credentialState(): Promise<CredentialState> {
    const required = this.manifest.credentials.filter((c) => c.required);
    if (required.length === 0) return 'not-required';
    for (const c of required) if (!(await this.context.credentials.has(c.key))) return 'missing';
    return 'present';
  }

  async health(): Promise<ProviderHealth> {
    const credentialState = this.context ? await this.credentialState() : 'not-required';
    const errorRate = this.window.length ? this.window.filter((x) => !x).length / this.window.length : 0;
    const status = this.deriveStatus(credentialState, errorRate);
    const health: ProviderHealth = {
      providerId: this.manifest.id,
      status,
      errorRate,
      rateLimitState: {
        limited: status === 'RATE_LIMITED',
        ...(this.lastError?.code === 'RATE_LIMITED' && this.lastError.retryAfterMs !== undefined && this.lastErrorAt
          ? { resetAt: new Date(Date.parse(this.lastErrorAt) + this.lastError.retryAfterMs).toISOString() }
          : {}),
      },
      credentialState,
      objectCount: this.objectCount,
    };
    if (this.lastAttempt) health.lastAttempt = this.lastAttempt;
    if (this.lastSuccess) health.lastSuccess = this.lastSuccess;
    if (this.lastObservation) health.lastObservation = this.lastObservation;
    if (this.latencyMs !== undefined) health.latencyMs = this.latencyMs;
    if (this.cacheAgeMs !== undefined) health.cacheAgeMs = this.cacheAgeMs;
    if (this.lastError && this.lastErrorAt) {
      health.lastError = this.lastError.toInfo(this.lastErrorAt);
      health.message = health.lastError.message;
    }
    return health;
  }

  private deriveStatus(credentialState: CredentialState, errorRate: number): ProviderStatus {
    if (!this.running) return 'DISABLED';
    if (credentialState === 'missing' || credentialState === 'invalid' || this.lastError?.code === 'AUTH')
      return 'AUTH_REQUIRED';
    if (this.attempts === 0) return 'STARTING';
    if (this.lastError) {
      switch (this.lastError.code) {
        case 'RATE_LIMITED':
          return 'RATE_LIMITED';
        case 'OFFLINE':
        case 'DNS':
        case 'NETWORK':
          return this.lastSuccess ? 'DEGRADED' : 'OFFLINE';
        default:
          return this.lastSuccess && errorRate < 1 ? 'DEGRADED' : 'ERROR';
      }
    }
    if (this.cacheAgeMs !== undefined && this.cacheAgeMs > this.manifest.refreshPolicy.intervalMs * 3) return 'STALE';
    return 'LIVE';
  }
}
