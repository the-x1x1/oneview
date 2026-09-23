import type { JsonValue, Observation } from '@worldview/world-model';
import {
  PollingProvider,
  ProviderError,
  assertAtomicAdmission,
  type ProviderContext,
  type ProviderManifest,
  type ProviderQuery,
} from '@worldview/provider-sdk';
import {
  CATALOG_MAX_AGE_MS,
  CELESTRAK_MANIFEST,
  gpUrl,
  isCelestrakGroup,
  type CelestrakFormat,
  type CelestrakGroup,
} from './manifest.js';
import { parseCatalog, validateElements, type GpElements } from './elements.js';
import { normalizeElements, elementsToJson } from './normalize.js';
import type { Propagator } from './propagator.js';
import { SatelliteJsPropagator } from './satellite-js-propagator.js';

export {
  CELESTRAK_MANIFEST,
  CELESTRAK_GROUPS,
  CATALOG_MAX_AGE_MS,
  ELEMENT_VALIDITY_MS,
  gpUrl,
  isCelestrakGroup,
} from './manifest.js';
export type { CelestrakGroup, CelestrakFormat } from './manifest.js';
export {
  parseCatalog,
  parseOmmJson,
  parseTleText,
  tleToElements,
  ommRecordToElements,
  validateElements,
  orbitSummary,
  tleChecksum,
  decodeCatalogNumber,
} from './elements.js';
export type { GpElements, ParsedCatalog } from './elements.js';
export { normalizeElements, elementsToDraft } from './normalize.js';
export type { NormalizeOptions, NormalizeResult } from './normalize.js';
export type { Propagator, PropagatedState } from './propagator.js';
export { CircularOrbitPropagator, gmstRadians } from './circular-orbit-propagator.js';
export { SatelliteJsPropagator, toOmm } from './satellite-js-propagator.js';
export { createSatelliteReprojector, elementsFromProperties } from './reproject.js';
export type { SatelliteReprojector } from './reproject.js';
export type { SatelliteJsModule } from './satellite-js-propagator.js';

export interface CelestrakSettings {
  /** Catalog groups to load, in dedupe-priority order (default ['active']). */
  groups?: CelestrakGroup[];
  /** Cap per group (default 20,000) — the `active` group was 16,587 objects in September 2026. */
  maxObjects?: number;
  /** Wire format: OMM JSON (default) or 3-line TLE. */
  format?: CelestrakFormat;
}

export interface CelestrakProviderOptions {
  /** Defaults to SGP4 through satellite.js (loaded lazily). Tests inject CircularOrbitPropagator. */
  propagator?: Propagator;
  /**
   * Reuse window for a fetched catalog (default 2 h, CelesTrak etiquette). The
   * contract checklist sets 0 so every poll exercises the upstream path; user
   * settings cannot lower it.
   */
  catalogMaxAgeMs?: number;
  /** After the network layer served a stale body, wait this long before trying upstream again (default 10 min). */
  retryAfterStaleMs?: number;
  /** Never propagate from a catalog older than this (default 24 h); fetch instead. */
  catalogMaxStaleMs?: number;
}

/** What the provider caches per group — plain JSON so it fits ProviderCache. */
export interface CatalogEntry {
  group: string;
  format: CelestrakFormat;
  /** When upstream produced the body (stale serves keep the original time). */
  fetchedAt: string;
  elements: GpElements[];
}

interface CatalogState {
  entry: CatalogEntry;
  staleServedAt?: number;
}

// Every active satellite, not the first 5,000 of 16,587 in catalog order (which left out most
// of the constellations launched in the last few years). Two costs grew with the count and
// are addressed: history keeps one row per element set rather than one per 15-second
// propagation, and world deltas cross to the page in 2,000-object parts (desktop
// shared/event-wire.ts). The operator can still lower it (Sources → CelesTrak).
const DEFAULT_MAX_OBJECTS = 20_000;
const MAX_MAX_OBJECTS = 20_000;
const MAX_BODY_BYTES = 24 * 1024 * 1024; // `active` as JSON is ~5 MB; TLE ~2 MB; headroom for growth
const CELESTRAK_BLOCK_RETRY_MS = 2 * 3600_000;

/**
 * CelesTrak provider: polls every 15 s, but each group's catalog is fetched at most
 * once per `catalogMaxAgeMs`; in between, positions are propagated from the cached
 * element sets. Failures propagate as ProviderErrors (the runtime backs off and its
 * HTTP layer serves stale bodies within `staleWhileErrorMs`); the provider never
 * re-serves last-good data itself (ADR-003).
 */
export class CelestrakProvider extends PollingProvider {
  readonly manifest: ProviderManifest = CELESTRAK_MANIFEST;
  private settings: CelestrakSettings = {};
  private readonly propagator: Propagator;
  private readonly catalogMaxAgeMs: number;
  private readonly retryAfterStaleMs: number;
  private readonly catalogMaxStaleMs: number;
  private readonly catalogs = new Map<string, CatalogState>();
  private prepared: Promise<void> | undefined;
  /** One function for the provider's life, so normalize.ts can reuse an element set's hash. */
  private readonly hash = (s: string): string => this.context.hash.sha256Hex(s);

  constructor(options: CelestrakProviderOptions = {}) {
    super();
    this.propagator = options.propagator ?? new SatelliteJsPropagator();
    this.catalogMaxAgeMs = options.catalogMaxAgeMs ?? CATALOG_MAX_AGE_MS;
    this.retryAfterStaleMs = options.retryAfterStaleMs ?? 10 * 60_000;
    this.catalogMaxStaleMs = options.catalogMaxStaleMs ?? 24 * 3600_000;
  }

  protected override async onInitialize(context: ProviderContext): Promise<void> {
    this.settings = parseSettings(await context.settings.get());
    context.settings.onChange((s) => {
      this.settings = parseSettings(s);
    });
  }

  protected async fetchOnce(request: ProviderQuery): Promise<{ observations: Observation[]; cacheAgeMs?: number }> {
    if (request.signal.aborted) throw new ProviderError('CANCELLED', 'cancelled before catalog access');
    await this.ensurePropagator();
    const groups = this.settings.groups ?? ['active'];
    const format = this.settings.format ?? 'json';
    const maxObjects = this.settings.maxObjects ?? DEFAULT_MAX_OBJECTS;
    const observations: Observation[] = [];
    const seen = new Set<number>();
    let oldestServedMs = 0;
    let anyStale = false;

    for (const group of groups) {
      const { entry, stale, ageMs } = await this.catalog(group, format, maxObjects, request);
      if (stale) {
        anyStale = true;
        oldestServedMs = Math.max(oldestServedMs, ageMs);
      }
      const nowMs = this.context.clock.now();
      const fresh = entry.elements.slice(0, maxObjects).filter((e) => !seen.has(e.noradId));
      const result = normalizeElements(fresh, {
        receivedAt: new Date(nowMs).toISOString(),
        nowMs,
        propagator: this.propagator,
        group,
        hash: this.hash,
        origin: stale ? 'cached' : 'live',
        sourceRef: gpUrl(group, format),
      });
      for (const e of fresh) seen.add(e.noradId);
      if (result.rejected.length)
        this.context.logger.warn('skipped CelesTrak objects', {
          group,
          count: result.rejected.length,
          sample: result.rejected.slice(0, 3).map((r) => r.reason),
        });
      observations.push(...result.observations);
    }
    return { observations, cacheAgeMs: anyStale ? oldestServedMs : 0 };
  }

  /** Expose the in-memory catalog state (diagnostics and tests). */
  catalogAge(group: string): number | undefined {
    const s = this.catalogs.get(group);
    return s ? this.context.clock.now() - Date.parse(s.entry.fetchedAt) : undefined;
  }

  private async ensurePropagator(): Promise<void> {
    if (!this.propagator.prepare) return;
    this.prepared ??= this.propagator.prepare();
    try {
      await this.prepared;
    } catch (err) {
      this.prepared = undefined;
      throw new ProviderError(
        'UNSUPPORTED',
        `propagator unavailable: ${err instanceof Error ? err.message : String(err)}`,
        { retryable: false, cause: err },
      );
    }
  }

  private async catalog(
    group: CelestrakGroup,
    format: CelestrakFormat,
    maxObjects: number,
    request: ProviderQuery,
  ): Promise<{ entry: CatalogEntry; stale: boolean; ageMs: number }> {
    const now = this.context.clock.now();
    const key = cacheKey(group, format);
    let state = this.catalogs.get(group);
    if (!state || state.entry.format !== format) {
      const cached = await this.context.cache.get<JsonValue>(key);
      const entry = cached ? restoreEntry(cached.value) : undefined;
      state = entry && entry.format === format ? { entry } : undefined;
      if (state) this.catalogs.set(group, state);
    }
    if (state) {
      const ageMs = now - Date.parse(state.entry.fetchedAt);
      if (ageMs >= 0 && ageMs < this.catalogMaxAgeMs) return { entry: state.entry, stale: false, ageMs };
      if (
        state.staleServedAt !== undefined &&
        now - state.staleServedAt < this.retryAfterStaleMs &&
        ageMs <= this.catalogMaxStaleMs
      )
        return { entry: state.entry, stale: true, ageMs };
    }

    const url = gpUrl(group, format);
    let res;
    try {
      res = await this.context.http.request({
        url,
        signal: request.signal,
        maxBytes: MAX_BODY_BYTES,
        headers: { Accept: format === 'json' ? 'application/json' : 'text/plain' },
      });
    } catch (err) {
      throw mapUpstreamError(err);
    }
    const parsed = parseCatalog(res.text(), format);
    if (parsed.rejected.some((r) => r.index === -1)) {
      res.invalidate();
      throw new ProviderError('MALFORMED', `CelesTrak ${group}: ${parsed.rejected[0]!.reason}`, { retryable: false });
    }
    if (parsed.total > 0 && parsed.elements.length === 0) {
      res.invalidate();
      assertAtomicAdmission(parsed.total, 0, `CelesTrak ${group}`);
    }
    if (parsed.rejected.length)
      this.context.logger.warn('rejected CelesTrak records', {
        group,
        count: parsed.rejected.length,
        sample: parsed.rejected.slice(0, 3).map((r) => r.reason),
      });
    if (parsed.elements.length > maxObjects)
      this.context.logger.info('CelesTrak group truncated', { group, total: parsed.elements.length, maxObjects });
    const fetchedAtMs = now - (res.stale ? res.ageMs : 0);
    const entry: CatalogEntry = {
      group,
      format,
      fetchedAt: new Date(fetchedAtMs).toISOString(),
      // Kept whole: the cap is applied per poll (fetchOnce), so raising it takes effect at
      // once instead of after the next catalog fetch, up to two hours later.
      elements: parsed.elements,
    };
    const next: CatalogState = res.stale ? { entry, staleServedAt: now } : { entry };
    this.catalogs.set(group, next);
    if (!res.stale) await this.context.cache.set(key, entryToJson(entry), this.catalogMaxStaleMs);
    return { entry, stale: res.stale, ageMs: res.stale ? res.ageMs : 0 };
  }
}

function cacheKey(group: string, format: CelestrakFormat): string {
  return `catalog:${group}:${format}`;
}

/** CelesTrak answers HTTP 403 when a client fetches too often or sends no descriptive User-Agent. */
export function mapUpstreamError(err: unknown): ProviderError {
  if (err instanceof ProviderError && err.code === 'AUTH' && err.httpStatus === 403) {
    return new ProviderError(
      'RATE_LIMITED',
      'CelesTrak refused the request (HTTP 403): fetch cadence exceeded or client not identified; retry in 2 h',
      { httpStatus: 403, retryAfterMs: CELESTRAK_BLOCK_RETRY_MS, cause: err },
    );
  }
  if (err instanceof ProviderError) return err;
  return new ProviderError('INTERNAL', err instanceof Error ? err.message : String(err), { cause: err });
}

function entryToJson(entry: CatalogEntry): JsonValue {
  return {
    group: entry.group,
    format: entry.format,
    fetchedAt: entry.fetchedAt,
    elements: entry.elements.map(elementsToJson),
  };
}

/** Rebuild a cache entry defensively — the cache is provider-scoped but still external input. */
export function restoreEntry(value: JsonValue): CatalogEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, JsonValue>;
  const format = v['format'];
  const fetchedAt = v['fetchedAt'];
  const group = v['group'];
  if (
    (format !== 'json' && format !== 'tle') ||
    typeof fetchedAt !== 'string' ||
    !Number.isFinite(Date.parse(fetchedAt)) ||
    typeof group !== 'string'
  )
    return undefined;
  if (!Array.isArray(v['elements'])) return undefined;
  const elements: GpElements[] = [];
  for (const raw of v['elements']) {
    const e = restoreElements(raw);
    if (!e) return undefined;
    elements.push(e);
  }
  return { group, format, fetchedAt, elements };
}

const NUMERIC_OPTIONAL = ['bstar', 'meanMotionDot', 'meanMotionDdot', 'elementSetNo', 'revAtEpoch'] as const;
const STRING_OPTIONAL = ['intlDesignator', 'classification', 'line1', 'line2'] as const;

function restoreElements(raw: JsonValue): GpElements | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, JsonValue>;
  const num = (k: string): number | undefined =>
    typeof r[k] === 'number' && Number.isFinite(r[k]) ? (r[k] as number) : undefined;
  const noradId = num('noradId'),
    meanMotion = num('meanMotion'),
    eccentricity = num('eccentricity'),
    inclination = num('inclination');
  const raan = num('raan'),
    argPerigee = num('argPerigee'),
    meanAnomaly = num('meanAnomaly');
  if (
    noradId === undefined ||
    meanMotion === undefined ||
    eccentricity === undefined ||
    inclination === undefined ||
    raan === undefined ||
    argPerigee === undefined ||
    meanAnomaly === undefined
  )
    return undefined;
  if (typeof r['name'] !== 'string' || typeof r['epoch'] !== 'string') return undefined;
  const e: GpElements = {
    noradId,
    name: r['name'],
    epoch: r['epoch'],
    meanMotion,
    eccentricity,
    inclination,
    raan,
    argPerigee,
    meanAnomaly,
  };
  for (const k of NUMERIC_OPTIONAL) {
    const v = num(k);
    if (v !== undefined) e[k] = v;
  }
  for (const k of STRING_OPTIONAL) {
    const v = r[k];
    if (typeof v === 'string') e[k] = v;
  }
  return validateElements(e) ? undefined : e;
}

export function parseSettings(raw: Record<string, unknown>): CelestrakSettings {
  const out: CelestrakSettings = {};
  const groups = raw['groups'];
  if (Array.isArray(groups)) {
    const valid = groups.filter(isCelestrakGroup);
    if (valid.length) out.groups = [...new Set(valid)];
  }
  const max = raw['maxObjects'];
  if (typeof max === 'number' && Number.isInteger(max) && max >= 1) out.maxObjects = Math.min(max, MAX_MAX_OBJECTS);
  const format = raw['format'];
  if (format === 'json' || format === 'tle') out.format = format;
  return out;
}

export function createProvider(options: CelestrakProviderOptions = {}): CelestrakProvider {
  return new CelestrakProvider(options);
}
