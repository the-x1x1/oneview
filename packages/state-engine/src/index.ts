import {
  classifyFreshness,
  computeConfidence,
  freshnessPolicyFor,
  isExpired,
  geometryCentroid,
  type Clock,
  type FreshnessClass,
  type FreshnessPolicy,
  type GeoBounds,
  type GeoRegion,
  type JsonValue,
  type Observation,
  type ObservationReference,
  type WorldObject,
  type WorldMedia,
  systemClock,
} from '@worldview/world-model';
import { IdentityResolver, defaultIdentityResolver } from '@worldview/identity';
import { createSpatialIndex, type SpatialIndex } from '@worldview/hot-spatial-index';

/**
 * @worldview/state-engine — the live world state.
 *
 * Maintains objectsById / objectsByType / objectsByProvider, a hot spatial index,
 * an expiration queue, per-object short tracks and a recent-observation ring buffer.
 * Updates are batched: listeners receive one StateChange per flush, never one event
 * per incoming object.
 */
export interface IngestMeta {
  /** Full snapshot from this provider: objects it previously sourced and did not include are removed. */
  snapshot: boolean;
  providerId: string;
  /** Provider-declared freshness overrides (from manifest.refreshPolicy.freshness). */
  freshness?: Record<string, FreshnessPolicy>;
}

export interface IngestResult {
  accepted: number;
  added: number;
  updated: number;
  removed: number;
  rejected: Array<{ observationId: string; reason: string }>;
}

export interface StateChange {
  added: string[];
  updated: string[];
  removed: string[];
  /** Objects whose freshness class changed during a sweep. */
  refreshed: string[];
  at: string;
  objectCount: number;
}

export interface TrackPoint {
  observedAt: string;
  latitude: number;
  longitude: number;
  altitudeM?: number;
}

export interface WorldStateOptions {
  clock?: Clock;
  identity?: IdentityResolver;
  spatialIndex?: SpatialIndex;
  /** Max sourceRefs retained per object. */
  maxSourceRefs?: number;
  /** Max track points per object. */
  maxTrackPoints?: number;
  /** Recent observation ring buffer size. */
  recentObservations?: number;
  /** Flush coalescing delay in ms (0 = manual flush only). */
  flushDelayMs?: number;
  /** Type → freshness policy overrides applied globally. */
  freshness?: Record<string, FreshnessPolicy>;
}

type Listener = (change: StateChange) => void;

const LABEL_KEYS = ['name', 'callsign', 'registration', 'title', 'place', 'label', 'flight', 'shortName'] as const;

export class WorldState {
  private readonly clock: Clock;
  private readonly identity: IdentityResolver;
  readonly spatial: SpatialIndex;
  private readonly objects = new Map<string, WorldObject>();
  private readonly byType = new Map<string, Set<string>>();
  private readonly byProvider = new Map<string, Set<string>>();
  private readonly tracks = new Map<string, TrackPoint[]>();
  private readonly recent: Observation[] = [];
  private readonly policyOverrides = new Map<string, FreshnessPolicy>();
  private readonly listeners = new Set<Listener>();
  private pending: { added: Set<string>; updated: Set<string>; removed: Set<string>; refreshed: Set<string> } = {
    added: new Set(),
    updated: new Set(),
    removed: new Set(),
    refreshed: new Set(),
  };
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly opts: Required<
    Pick<WorldStateOptions, 'maxSourceRefs' | 'maxTrackPoints' | 'recentObservations' | 'flushDelayMs'>
  >;

  constructor(options: WorldStateOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.identity = options.identity ?? defaultIdentityResolver;
    this.spatial = options.spatialIndex ?? createSpatialIndex();
    this.opts = {
      maxSourceRefs: options.maxSourceRefs ?? 8,
      maxTrackPoints: options.maxTrackPoints ?? 240,
      recentObservations: options.recentObservations ?? 5000,
      flushDelayMs: options.flushDelayMs ?? 100,
    };
    for (const [t, p] of Object.entries(options.freshness ?? {})) this.policyOverrides.set(t, p);
  }

  // ---- reads --------------------------------------------------------------

  get size(): number {
    return this.objects.size;
  }
  get(id: string): WorldObject | undefined {
    return this.objects.get(id);
  }
  has(id: string): boolean {
    return this.objects.has(id);
  }
  all(): IterableIterator<WorldObject> {
    return this.objects.values();
  }
  ids(): IterableIterator<string> {
    return this.objects.keys();
  }

  ofType(type: string): WorldObject[] {
    return [...(this.byType.get(type) ?? [])].map((id) => this.objects.get(id)!).filter(Boolean);
  }

  ofProvider(providerId: string): WorldObject[] {
    return [...(this.byProvider.get(providerId) ?? [])].map((id) => this.objects.get(id)!).filter(Boolean);
  }

  countsByType(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [t, set] of this.byType) if (set.size) out[t] = set.size;
    return out;
  }

  countsByProvider(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [p, set] of this.byProvider) if (set.size) out[p] = set.size;
    return out;
  }

  withinBounds(bounds: GeoBounds, types?: string[], limit?: number): WorldObject[] {
    return this.spatial
      .withinBounds(bounds, { ...(types ? { types } : {}), ...(limit !== undefined ? { limit } : {}) })
      .map((i) => this.objects.get(i.id)!)
      .filter(Boolean);
  }

  withinRegion(region: GeoRegion, types?: string[], limit?: number): WorldObject[] {
    return this.spatial
      .withinRegion(region, { ...(types ? { types } : {}), ...(limit !== undefined ? { limit } : {}) })
      .map((i) => this.objects.get(i.id)!)
      .filter(Boolean);
  }

  nearest(
    center: { latitude: number; longitude: number },
    n: number,
    types?: string[],
    maxRadiusM?: number,
  ): Array<{ object: WorldObject; distanceM: number }> {
    return this.spatial
      .nearest(center, n, { ...(types ? { types } : {}), ...(maxRadiusM !== undefined ? { maxRadiusM } : {}) })
      .map((i) => ({ object: this.objects.get(i.id)!, distanceM: i.distanceM }))
      .filter((x) => x.object);
  }

  track(id: string): readonly TrackPoint[] {
    return this.tracks.get(id) ?? [];
  }

  recentObservations(limit = 100): Observation[] {
    return this.recent.slice(-limit);
  }

  // ---- writes -------------------------------------------------------------

  ingest(observations: Observation[], meta: IngestMeta): IngestResult {
    const now = this.clock.now();
    const nowIso = new Date(now).toISOString();
    const result: IngestResult = { accepted: 0, added: 0, updated: 0, removed: 0, rejected: [] };
    const seenIds = new Set<string>();

    for (const obs of observations) {
      if (obs.providerId !== meta.providerId) {
        result.rejected.push({ observationId: obs.id, reason: 'providerId mismatch' });
        continue;
      }
      const resolution = this.identity.resolve(obs);
      const objectId = resolution.objectId;
      seenIds.add(objectId);
      const policy = this.policyFor(obs.objectType, meta.freshness);
      const observedMs = Date.parse(obs.observedAt);
      if (!Number.isFinite(observedMs)) {
        result.rejected.push({ observationId: obs.id, reason: 'invalid observedAt' });
        continue;
      }
      if (isExpired(observedMs, now, policy) && !obs.effectiveUntil) {
        result.rejected.push({ observationId: obs.id, reason: 'already expired for type policy' });
        continue;
      }
      result.accepted++;
      this.pushRecent(obs);

      const existing = this.objects.get(objectId);
      const ref: ObservationReference = {
        observationId: obs.id,
        providerId: obs.providerId,
        observedAt: obs.observedAt,
      };
      const position = obs.position ?? (obs.geometry ? geometryCentroid(obs.geometry) : undefined);

      if (!existing) {
        const freshness = classifyFreshness(observedMs, now, policy);
        const obj: WorldObject = {
          id: objectId,
          type: obs.objectType,
          sourceRefs: [ref],
          observedAt: obs.observedAt,
          updatedAt: nowIso,
          freshness,
          confidence: computeConfidence({
            sourceQuality: obs.quality.sourceQuality,
            freshness,
            positionAccuracyM: obs.quality.positionAccuracyM,
            providerCount: 1,
            identityAuthoritative: resolution.authoritative,
          }),
          labels: extractLabels(obs.payload),
          properties: { ...obs.payload },
          provenance: obs.provenance,
        };
        if (position) obj.position = position;
        if (obs.geometry) obj.geometry = obs.geometry;
        const motion = extractMotion(obs.payload);
        if (motion) obj.motion = motion;
        const media = extractMedia(obs.payload);
        if (media) obj.media = media;
        const validUntil = computeValidUntil(obs, observedMs, policy);
        if (validUntil) obj.validUntil = validUntil;
        this.insert(obj);
        this.pushTrack(objectId, obs);
        this.pending.added.add(objectId);
        result.added++;
        continue;
      }

      // Merge: newer observation wins for properties/position; older observations only add refs.
      const existingMs = Date.parse(existing.observedAt);
      const newer = observedMs >= existingMs;
      const refs = [ref, ...existing.sourceRefs.filter((r) => r.observationId !== obs.id)].slice(
        0,
        this.opts.maxSourceRefs,
      );
      const providerCount = new Set(refs.map((r) => r.providerId)).size;
      const latestMs = Math.max(observedMs, existingMs);
      const freshness = classifyFreshness(latestMs, now, policy);
      const updated: WorldObject = {
        ...existing,
        sourceRefs: refs,
        observedAt: newer ? obs.observedAt : existing.observedAt,
        updatedAt: nowIso,
        freshness,
        confidence: computeConfidence({
          sourceQuality: newer ? obs.quality.sourceQuality : 'unknown',
          freshness,
          positionAccuracyM: newer ? obs.quality.positionAccuracyM : undefined,
          providerCount,
          identityAuthoritative: resolution.authoritative,
        }),
        labels: newer ? { ...existing.labels, ...extractLabels(obs.payload) } : existing.labels,
        properties: newer ? { ...existing.properties, ...obs.payload } : { ...obs.payload, ...existing.properties },
        provenance: newer ? obs.provenance : existing.provenance,
      };
      if (newer && position) updated.position = position;
      if (newer && obs.geometry) updated.geometry = obs.geometry;
      if (newer) {
        const m = extractMotion(obs.payload);
        if (m) updated.motion = m;
      }
      if (newer) {
        const media = extractMedia(obs.payload);
        if (media) updated.media = media;
        else delete updated.media;
      }
      const validUntil = computeValidUntil(obs, latestMs, policy);
      if (validUntil) updated.validUntil = validUntil;
      else delete updated.validUntil;
      this.replace(existing, updated);
      if (newer) this.pushTrack(objectId, obs);
      if (!this.pending.added.has(objectId)) this.pending.updated.add(objectId);
      result.updated++;
    }

    if (meta.snapshot) {
      for (const id of [...(this.byProvider.get(meta.providerId) ?? [])]) {
        if (seenIds.has(id)) continue;
        const obj = this.objects.get(id);
        if (!obj) continue;
        const otherRefs = obj.sourceRefs.filter((r) => r.providerId !== meta.providerId);
        if (otherRefs.length === 0) {
          this.delete(id);
          result.removed++;
        } else this.replace(obj, { ...obj, sourceRefs: otherRefs, updatedAt: nowIso });
      }
    }

    this.scheduleFlush();
    return result;
  }

  /** Periodic sweep: re-classify freshness and expire objects. Returns removed ids. */
  sweep(): { expired: string[]; refreshed: string[] } {
    const now = this.clock.now();
    const expired: string[] = [];
    const refreshed: string[] = [];
    for (const obj of this.objects.values()) {
      const policy = this.policyFor(obj.type);
      const observedMs = Date.parse(obj.observedAt);
      const validUntilMs = obj.validUntil ? Date.parse(obj.validUntil) : undefined;
      const gone = validUntilMs !== undefined ? now > validUntilMs : isExpired(observedMs, now, policy);
      if (gone) {
        expired.push(obj.id);
        continue;
      }
      const f = classifyFreshness(observedMs, now, policy);
      if (f !== obj.freshness) {
        const next: WorldObject = {
          ...obj,
          freshness: f,
          confidence: computeConfidence({
            sourceQuality: obj.provenance.origin === 'derived' ? 'derived' : 'authoritative',
            freshness: f,
            positionAccuracyM: undefined,
            providerCount: new Set(obj.sourceRefs.map((r) => r.providerId)).size,
            identityAuthoritative: true,
          }),
        };
        this.objects.set(obj.id, next);
        refreshed.push(obj.id);
      }
    }
    for (const id of expired) {
      this.delete(id);
    }
    for (const id of refreshed) this.pending.refreshed.add(id);
    if (expired.length || refreshed.length) this.scheduleFlush();
    return { expired, refreshed };
  }

  /** Remove everything sourced by a provider (provider disabled). */
  removeProvider(providerId: string): number {
    let n = 0;
    for (const id of [...(this.byProvider.get(providerId) ?? [])]) {
      const obj = this.objects.get(id);
      if (!obj) continue;
      const others = obj.sourceRefs.filter((r) => r.providerId !== providerId);
      if (others.length === 0) {
        this.delete(id);
        n++;
      } else this.replace(obj, { ...obj, sourceRefs: others });
    }
    this.scheduleFlush();
    return n;
  }

  clear(): void {
    for (const id of [...this.objects.keys()]) this.delete(id);
    this.recent.length = 0;
    this.scheduleFlush();
  }

  // ---- change notification -----------------------------------------------

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  hasPendingChanges(): boolean {
    return (
      this.pending.added.size + this.pending.updated.size + this.pending.removed.size + this.pending.refreshed.size > 0
    );
  }

  flush(): StateChange | undefined {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (!this.hasPendingChanges()) return undefined;
    const p = this.pending;
    this.pending = { added: new Set(), updated: new Set(), removed: new Set(), refreshed: new Set() };
    for (const id of p.removed) {
      p.added.delete(id);
      p.updated.delete(id);
      p.refreshed.delete(id);
    }
    for (const id of p.added) {
      p.updated.delete(id);
      p.refreshed.delete(id);
    }
    for (const id of p.updated) p.refreshed.delete(id);
    const change: StateChange = {
      added: [...p.added],
      updated: [...p.updated],
      removed: [...p.removed],
      refreshed: [...p.refreshed],
      at: new Date(this.clock.now()).toISOString(),
      objectCount: this.objects.size,
    };
    for (const l of [...this.listeners]) {
      try {
        l(change);
      } catch (err) {
        queueMicrotask(() => {
          throw err;
        });
      }
    }
    return change;
  }

  private scheduleFlush(): void {
    if (this.opts.flushDelayMs <= 0 || this.flushTimer || this.listeners.size === 0) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, this.opts.flushDelayMs);
    if (typeof this.flushTimer === 'object' && 'unref' in this.flushTimer)
      (this.flushTimer as { unref(): void }).unref();
  }

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.listeners.clear();
  }

  // ---- internals ------------------------------------------------------------

  private policyFor(type: string, overrides?: Record<string, FreshnessPolicy>): FreshnessPolicy {
    return overrides?.[type] ?? this.policyOverrides.get(type) ?? freshnessPolicyFor(type);
  }

  private insert(obj: WorldObject): void {
    this.objects.set(obj.id, obj);
    index(this.byType, obj.type, obj.id);
    for (const r of obj.sourceRefs) index(this.byProvider, r.providerId, obj.id);
    if (obj.position)
      this.spatial.upsert({
        id: obj.id,
        latitude: obj.position.latitude,
        longitude: obj.position.longitude,
        type: obj.type,
      });
  }

  private replace(prev: WorldObject, next: WorldObject): void {
    this.objects.set(next.id, next);
    const prevProviders = new Set(prev.sourceRefs.map((r) => r.providerId));
    const nextProviders = new Set(next.sourceRefs.map((r) => r.providerId));
    for (const p of prevProviders) if (!nextProviders.has(p)) this.byProvider.get(p)?.delete(next.id);
    for (const p of nextProviders) index(this.byProvider, p, next.id);
    if (next.position)
      this.spatial.upsert({
        id: next.id,
        latitude: next.position.latitude,
        longitude: next.position.longitude,
        type: next.type,
      });
    else this.spatial.remove(next.id);
  }

  private delete(id: string): void {
    const obj = this.objects.get(id);
    if (!obj) return;
    this.objects.delete(id);
    this.byType.get(obj.type)?.delete(id);
    for (const r of obj.sourceRefs) this.byProvider.get(r.providerId)?.delete(id);
    this.spatial.remove(id);
    this.tracks.delete(id);
    // Added and removed within one batch: listeners never saw it, so announce neither.
    if (!this.pending.added.delete(id)) this.pending.removed.add(id);
    this.pending.updated.delete(id);
    this.pending.refreshed.delete(id);
  }

  private pushTrack(id: string, obs: Observation): void {
    if (!obs.position) return;
    let t = this.tracks.get(id);
    if (!t) {
      t = [];
      this.tracks.set(id, t);
    }
    const last = t[t.length - 1];
    if (last && last.observedAt === obs.observedAt) return;
    const point: TrackPoint = {
      observedAt: obs.observedAt,
      latitude: obs.position.latitude,
      longitude: obs.position.longitude,
    };
    if (obs.position.altitudeM !== undefined) point.altitudeM = obs.position.altitudeM;
    t.push(point);
    if (t.length > this.opts.maxTrackPoints) t.splice(0, t.length - this.opts.maxTrackPoints);
  }

  private pushRecent(obs: Observation): void {
    this.recent.push(obs);
    if (this.recent.length > this.opts.recentObservations)
      this.recent.splice(0, this.recent.length - this.opts.recentObservations);
  }
}

function index(map: Map<string, Set<string>>, key: string, id: string): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(id);
}

export function extractLabels(payload: Record<string, JsonValue>): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const k of LABEL_KEYS) {
    const v = payload[k];
    if (typeof v === 'string' && v.trim()) labels[k] = v.trim().slice(0, 200);
  }
  return labels;
}

export function extractMotion(payload: Record<string, JsonValue>): WorldObject['motion'] | undefined {
  const m: NonNullable<WorldObject['motion']> = {};
  const speed = payload['speedMps'];
  const heading = payload['headingDegrees'] ?? payload['courseDegrees'];
  const vs = payload['verticalSpeedMps'];
  if (typeof speed === 'number' && Number.isFinite(speed)) m.speedMps = speed;
  if (typeof heading === 'number' && Number.isFinite(heading)) m.headingDegrees = ((heading % 360) + 360) % 360;
  if (typeof vs === 'number' && Number.isFinite(vs)) m.verticalSpeedMps = vs;
  return Object.keys(m).length ? m : undefined;
}

const MEDIA_KINDS: ReadonlySet<string> = new Set(['image', 'stream', 'snapshot', 'audio']);
const MAX_MEDIA = 8;

/**
 * Lift `payload.media` into `WorldObject.media` (ADR-002). Entries must be
 * `{ kind, ref }` with an optional `label`/`mimeType`; anything else is dropped so an
 * object never carries a media reference the camera gateway cannot resolve. The
 * Observation keeps its `payload.media` unchanged.
 */
export function extractMedia(payload: Record<string, JsonValue>): WorldMedia[] | undefined {
  const raw = payload['media'];
  if (!Array.isArray(raw)) return undefined;
  const out: WorldMedia[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const rec = item as Record<string, JsonValue>;
    const kind = rec['kind'];
    const ref = rec['ref'];
    if (typeof kind !== 'string' || !MEDIA_KINDS.has(kind) || typeof ref !== 'string' || !ref.trim()) continue;
    const entry: WorldMedia = { kind: kind as WorldMedia['kind'], ref: ref.trim().slice(0, 512) };
    const label = rec['label'];
    if (typeof label === 'string' && label.trim()) entry.label = label.trim().slice(0, 200);
    const mimeType = rec['mimeType'];
    if (typeof mimeType === 'string' && mimeType.trim()) entry.mimeType = mimeType.trim().slice(0, 100);
    out.push(entry);
    if (out.length >= MAX_MEDIA) break;
  }
  return out.length ? out : undefined;
}

function computeValidUntil(obs: Observation, observedMs: number, policy: FreshnessPolicy): string | undefined {
  if (obs.effectiveUntil) return obs.effectiveUntil;
  if (policy.expireSeconds === undefined) return undefined;
  return new Date(observedMs + policy.expireSeconds * 1000).toISOString();
}

export type { FreshnessClass };
