import type { JsonValue, Observation } from '@worldview/world-model';
import {
  PollingProvider,
  ProviderError,
  assertAtomicAdmission,
  type ObjectDetailsAnswer,
  type ObjectDetailsRequest,
  type ObjectDetailsSource,
  type ObjectTrackAnswer,
  type ObjectTrackRequest,
  type ObjectTrackSource,
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
  type CelestrakQueryGroup,
} from './manifest.js';
import { parseCatalog, validateElements, type GpElements } from './elements.js';
import { normalizeElements, elementsToJson } from './normalize.js';
import type { Propagator } from './propagator.js';
import { SatelliteJsPropagator } from './satellite-js-propagator.js';
import { CATEGORY_GROUPS, satelliteCategory, type CategoryGroup } from './categories.js';
import { orbitPath } from './orbit-path.js';
import { elementsFromProperties } from './reproject.js';
import { ORBIT_CLASS_TEXT, isGeostationary, orbitClass } from './orbit-class.js';
import { nextPasses, type SatellitePass } from './passes.js';
import {
  parseSatcatRecords,
  restoreSatcatEntry,
  satcatEntryToJson,
  satcatProperties,
  satcatUrl,
  type SatcatCacheEntry,
} from './satcat.js';

export { CATEGORY_GROUPS, SATELLITE_CATEGORIES, categoryFromName, satelliteCategory } from './categories.js';
export type { SatelliteCategory, CategoryGroup } from './categories.js';
export { orbitPath, ORBIT_PATH_STEPS, MAX_PATH_MS } from './orbit-path.js';
export { orbitClass, isGeostationary, ORBIT_CLASS_TEXT } from './orbit-class.js';
export type { OrbitClass } from './orbit-class.js';
export { nextPasses, lookAngles, lookAnglesAt, geodeticToEcef } from './passes.js';
export type { SatellitePass, PassSearch, PassOptions, LookAngles, Observer } from './passes.js';
export {
  parseSatcatRecords,
  satcatProperties,
  satcatUrl,
  SATCAT_RECORDS_URL,
  OWNER_TEXT,
  LAUNCH_SITE_TEXT,
  OBJECT_TYPE_TEXT,
  OPS_STATUS_TEXT,
} from './satcat.js';
export type { SatcatRecord } from './satcat.js';
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
  /**
   * The CelesTrak groups whose membership decides a category (categories.ts; default
   * CATEGORY_GROUPS, `military` and `gnss`). Fetched on the catalogue cadence, best effort.
   */
  categoryGroups?: readonly CategoryGroup[];
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
/** A SATCAT record is kept this long (the catalogue changes by launches and decays, not by the hour). */
export const SATCAT_MAX_AGE_MS = 24 * 3600_000;
/** After a failed SATCAT lookup, none is tried again for this long (a 403 waits CELESTRAK_BLOCK_RETRY_MS). */
const SATCAT_RETRY_MS = 10 * 60_000;
const SATCAT_MAX_BYTES = 64 * 1024;
const SATCAT_MEMORY = 500;
/** Passes are counted above this elevation: lower, trees and buildings hide the satellite. */
export const PASS_MIN_ELEVATION_DEG = 10;
export const SATCAT_ATTRIBUTION = 'Satellite catalogue: CelesTrak SATCAT (celestrak.org), Dr. T.S. Kelso';

/**
 * CelesTrak provider: polls every 15 s, but each group's catalog is fetched at most
 * once per `catalogMaxAgeMs`; in between, positions are propagated from the cached
 * element sets. Failures propagate as ProviderErrors (the runtime backs off and its
 * HTTP layer serves stale bodies within `staleWhileErrorMs`); the provider never
 * re-serves last-good data itself (ADR-003).
 */
export class CelestrakProvider extends PollingProvider implements ObjectTrackSource, ObjectDetailsSource {
  readonly manifest: ProviderManifest = CELESTRAK_MANIFEST;
  private settings: CelestrakSettings = {};
  /** Skipped-object count per group, last said (so the log line is written when it changes). */
  private readonly lastSkipped = new Map<string, string>();
  private readonly propagator: Propagator;
  private readonly catalogMaxAgeMs: number;
  private readonly retryAfterStaleMs: number;
  private readonly catalogMaxStaleMs: number;
  private readonly catalogs = new Map<string, CatalogState>();
  private prepared: Promise<void> | undefined;
  private readonly categoryGroups: readonly CategoryGroup[];
  /** NORAD ids CelesTrak lists in each of `categoryGroups`, from the last catalogue of each. */
  private readonly members = new Map<CategoryGroup, { fetchedAt: string; ids: Set<number> }>();
  /** When a category group's fetch last failed: not asked again for `retryAfterStaleMs`. */
  private readonly memberFailedAt = new Map<CategoryGroup, number>();
  /** SATCAT records read this session (newest last), in front of the ProviderCache copy. */
  private readonly satcat = new Map<number, { entry: SatcatCacheEntry; at: number }>();
  /** No SATCAT lookup before this time (after a failure, or CelesTrak's 403). */
  private satcatQuietUntil = 0;
  /** One function for the provider's life, so normalize.ts can reuse an element set's hash. */
  private readonly hash = (s: string): string => this.context.hash.sha256Hex(s);

  constructor(options: CelestrakProviderOptions = {}) {
    super();
    this.propagator = options.propagator ?? new SatelliteJsPropagator();
    this.catalogMaxAgeMs = options.catalogMaxAgeMs ?? CATALOG_MAX_AGE_MS;
    this.retryAfterStaleMs = options.retryAfterStaleMs ?? 10 * 60_000;
    this.catalogMaxStaleMs = options.catalogMaxStaleMs ?? 24 * 3600_000;
    this.categoryGroups = options.categoryGroups ?? CATEGORY_GROUPS;
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
    await this.loadMemberships(groups, format, request);
    const memberOf = (g: CategoryGroup, id: number) => this.members.get(g)?.ids.has(id) ?? false;

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
        leadMs: this.manifest.refreshPolicy.intervalMs,
        category: (e) => satelliteCategory(e, group, memberOf),
      });
      for (const e of fresh) seen.add(e.noradId);
      // A handful of objects in any catalogue are re-entering or have stale elements, and
      // propagate out of range: expected, and said when the count changes rather than every poll.
      const skippedKey = String(result.rejected.length);
      if (result.rejected.length && this.lastSkipped.get(group) !== skippedKey)
        this.context.logger.info('skipped CelesTrak objects', {
          group,
          count: result.rejected.length,
          sample: result.rejected.slice(0, 3).map((r) => r.reason),
        });
      this.lastSkipped.set(group, skippedKey);
      observations.push(...result.observations);
    }
    return { observations, cacheAgeMs: anyStale ? oldestServedMs : 0 };
  }

  /**
   * The category groups' memberships (categories.ts): each is an ordinary catalogue fetch
   * through `catalog()` — the same two-hour reuse, the same ProviderCache — of a group of a
   * few hundred objects (their catalogues stay in memory like any other, so each poll is
   * answered from memory until the two hours are up), and the NORAD ids are what is used. Best effort: a failure is logged,
   * the list last loaded stands (until one has loaded, satellites fall back to their group
   * and name), and the group is not asked for again for `retryAfterStaleMs`. A group the
   * operator already fetches is not fetched twice.
   */
  private async loadMemberships(groups: readonly string[], format: CelestrakFormat, request: ProviderQuery) {
    const now = this.context.clock.now();
    for (const g of this.categoryGroups) {
      if (groups.includes(g)) {
        this.members.delete(g);
        continue;
      }
      const failed = this.memberFailedAt.get(g);
      if (failed !== undefined && now - failed < this.retryAfterStaleMs) continue;
      try {
        const { entry } = await this.catalog(g, format, Number.MAX_SAFE_INTEGER, request);
        const had = this.members.get(g);
        if (!had || had.fetchedAt !== entry.fetchedAt)
          this.members.set(g, { fetchedAt: entry.fetchedAt, ids: new Set(entry.elements.map((e) => e.noradId)) });
        this.memberFailedAt.delete(g);
      } catch (err) {
        if (request.signal.aborted) throw err;
        this.memberFailedAt.set(g, now);
        this.context.logger.warn('CelesTrak category group unavailable; categories from names only', {
          group: g,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * The selected satellite's next orbit (orbit-path.ts), for the host's `objectTrack`
   * (provider-sdk object-track.ts): one period from now, from the element set the object
   * carries, with the propagator that places it.
   */
  async objectTrack(request: ObjectTrackRequest): Promise<ObjectTrackAnswer | undefined> {
    if (request.objectType !== 'satellite') return undefined;
    const elements = elementsFromProperties({ ...request.properties });
    if (!elements) return undefined;
    await this.ensurePropagator();
    const points = orbitPath(this.propagator, elements, this.context.clock.now());
    if (points.length < 2) return undefined;
    return { kind: 'prediction', label: 'Predicted orbit (SGP4, one period)', points };
  }

  /**
   * What is known about the selected satellite beyond its element set (provider-sdk
   * object-details.ts):
   *
   *  - its orbit class (orbit-class.ts), from the element set;
   *  - its next PASS_MIN_ELEVATION_DEG passes over the observer the host sends (passes.ts),
   *    SGP4 from the same element set — computed here, no request;
   *  - its SATCAT record (satcat.ts): owner, launch date and site, object type, status,
   *    decay. One small request per satellite the operator selects, kept a day in memory and
   *    in the ProviderCache; a failure (or CelesTrak's 403) quiets lookups for a while, and
   *    the answer then says the record is unavailable rather than leaving it out silently.
   */
  async objectDetails(request: ObjectDetailsRequest): Promise<ObjectDetailsAnswer | undefined> {
    if (request.objectType !== 'satellite') return undefined;
    const elements = elementsFromProperties({ ...request.properties });
    const idFromExternal =
      request.externalId && /^\d{1,9}$/.test(request.externalId) ? Number(request.externalId) : undefined;
    const noradId = elements?.noradId ?? idFromExternal;
    if (noradId === undefined) return undefined;
    const properties: Record<string, JsonValue> = {};

    if (elements) {
      const cls = orbitClass(elements);
      if (cls) {
        properties['orbitClass'] = cls;
        properties['orbitClassText'] = ORBIT_CLASS_TEXT[cls];
        if (isGeostationary(elements)) properties['geostationary'] = true;
      }
    }

    if (elements && request.observer) {
      try {
        await this.ensurePropagator();
        const search = nextPasses(this.propagator, elements, request.observer, request.nowMs, {
          minElevationDeg: PASS_MIN_ELEVATION_DEG,
          count: 3,
        });
        properties['passObserver'] = {
          latitude: Math.round(request.observer.latitude * 1000) / 1000,
          longitude: Math.round(request.observer.longitude * 1000) / 1000,
        };
        properties['passMinElevationDeg'] = PASS_MIN_ELEVATION_DEG;
        properties['passesFrom'] = new Date(request.nowMs).toISOString();
        properties['passesSearchedUntil'] = new Date(search.searchedUntil).toISOString();
        properties['passElementsEpoch'] = elements.epoch;
        properties['passes'] = search.passes.map(passToJson);
        if (search.alwaysAbove) properties['passesAlwaysAbove'] = true;
      } catch (err) {
        this.context.logger.debug('passes not computed', {
          noradId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const entry = await this.satcatEntry(noradId, request.signal, request.nowMs);
    if (entry && 'record' in entry) Object.assign(properties, satcatProperties(entry.record));
    properties['satcatStatus'] = entry ? ('record' in entry ? 'found' : 'not-listed') : 'unavailable';

    return { label: 'CelesTrak SATCAT and SGP4 passes', attribution: SATCAT_ATTRIBUTION, properties };
  }

  /** The SATCAT entry for one object: memory, then ProviderCache, then one request. */
  private async satcatEntry(
    noradId: number,
    signal: AbortSignal,
    nowMs: number,
  ): Promise<SatcatCacheEntry | undefined> {
    const held = this.satcat.get(noradId);
    if (held && nowMs - held.at < SATCAT_MAX_AGE_MS) return held.entry;
    const key = `satcat:${noradId}`;
    try {
      const cached = await this.context.cache.get<JsonValue>(key);
      const entry = cached ? restoreSatcatEntry(cached.value, noradId) : undefined;
      if (entry) {
        this.remember(noradId, entry, nowMs);
        return entry;
      }
    } catch {
      /* a cache that cannot be read is a cache miss */
    }
    if (nowMs < this.satcatQuietUntil || signal.aborted) return held?.entry;
    let entry: SatcatCacheEntry;
    try {
      const res = await this.context.http.request({
        url: satcatUrl(noradId),
        signal,
        maxBytes: SATCAT_MAX_BYTES,
        headers: { Accept: 'application/json' },
      });
      let body: unknown;
      try {
        body = JSON.parse(res.text());
      } catch {
        // CelesTrak answers a number it has no record of with a line of text, not JSON.
        body = undefined;
      }
      const record = parseSatcatRecords(body, noradId);
      entry = record ? { record } : { none: true };
    } catch (err) {
      const mapped = mapUpstreamError(err);
      this.satcatQuietUntil = nowMs + (mapped.code === 'RATE_LIMITED' ? CELESTRAK_BLOCK_RETRY_MS : SATCAT_RETRY_MS);
      this.context.logger.warn('CelesTrak SATCAT lookup failed', { noradId, error: mapped.message });
      return held?.entry;
    }
    this.remember(noradId, entry, nowMs);
    try {
      await this.context.cache.set(key, satcatEntryToJson(entry), SATCAT_MAX_AGE_MS);
    } catch {
      /* kept in memory for this session */
    }
    return entry;
  }

  private remember(noradId: number, entry: SatcatCacheEntry, at: number): void {
    this.satcat.delete(noradId);
    this.satcat.set(noradId, { entry, at });
    if (this.satcat.size > SATCAT_MEMORY) this.satcat.delete(this.satcat.keys().next().value!);
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
    group: CelestrakQueryGroup,
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

function passToJson(p: SatellitePass): JsonValue {
  const out: Record<string, JsonValue> = {
    culminationAt: new Date(p.culminationAt).toISOString(),
    culminationAzimuthDeg: p.culminationAzimuthDeg,
    maxElevationDeg: p.maxElevationDeg,
  };
  if (p.riseAt !== undefined) out['riseAt'] = new Date(p.riseAt).toISOString();
  if (p.riseAzimuthDeg !== undefined) out['riseAzimuthDeg'] = p.riseAzimuthDeg;
  if (p.setAt !== undefined) out['setAt'] = new Date(p.setAt).toISOString();
  if (p.setAzimuthDeg !== undefined) out['setAzimuthDeg'] = p.setAzimuthDeg;
  return out;
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
