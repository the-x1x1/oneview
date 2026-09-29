import type { Observation } from '@worldview/world-model';
import {
  PollingProvider,
  ProviderError,
  assertAtomicAdmission,
  buildObservation,
  type ProviderManifest,
  type ProviderQuery,
} from '@worldview/provider-sdk';
import {
  DIGITRAFFIC_AIS_MANIFEST,
  DIGITRAFFIC_USER,
  METADATA_OVERLAP_MS,
  METADATA_REFRESH_MS,
  METADATA_RETRY_MS,
  locationsUrl,
  vesselsUrl,
} from './manifest.js';
import { locationToDraft, parseLocations, parseVessels, vesselStatic, type VesselStatic } from './normalize.js';

export {
  DIGITRAFFIC_AIS_MANIFEST,
  DIGITRAFFIC_LOCATIONS_URL,
  DIGITRAFFIC_VESSELS_URL,
  DIGITRAFFIC_USER,
  LOCATION_WINDOW_MS,
  METADATA_REFRESH_MS,
  locationsUrl,
  vesselsUrl,
} from './manifest.js';
export { decodeEta, locationToDraft, parseLocations, parseVessels, vesselStatic } from './normalize.js';
export type { VesselStatic, LocationResult } from './normalize.js';

/** A quarter of an hour of the Baltic is ~5–8k ships at ~300 bytes each; room to spare. */
const LOCATIONS_MAX_BYTES = 16 * 1024 * 1024;
/** The first static-data answer is a day's worth of ships (~15k rows, ~3 MB). */
const VESSELS_MAX_BYTES = 16 * 1024 * 1024;
/** Static data remembered for at most this many ships; the least recently updated go first. */
const MAX_STATICS = 50_000;
/**
 * One cache slot per endpoint whatever `from` says, so the HTTP client keeps one answer to
 * serve stale while Digitraffic is unreachable, not one per minute (ProviderHttpRequest.cacheKey).
 */
const LOCATIONS_CACHE_KEY = 'digitraffic-ais:locations';
const VESSELS_CACHE_KEY = 'digitraffic-ais:vessels';

/**
 * Digitraffic Marine AIS provider (manifest.ts says what and why). Each poll:
 *
 * 1. positions of the last quarter of an hour (one request) — a failure here fails the poll;
 * 2. when due, static data changed since the last answer (a second request) — a failure here
 *    is logged and retried in two minutes, and the poll still returns the positions;
 * 3. every position, with its ship's static data folded in, as the snapshot.
 */
export class DigitrafficAisProvider extends PollingProvider {
  readonly manifest: ProviderManifest = DIGITRAFFIC_AIS_MANIFEST;
  private readonly statics = new Map<string, VesselStatic>();
  /** Newest static-data timestamp seen (ms), the next request's `from` less the overlap. */
  private staticsHighWater: number | undefined;
  private staticsDueAt = 0;

  protected async fetchOnce(request: ProviderQuery): Promise<{ observations: Observation[]; cacheAgeMs?: number }> {
    if (request.signal.aborted) throw new ProviderError('CANCELLED', 'cancelled before request');
    const now = this.context.clock.now();
    const url = locationsUrl(now);
    const res = await this.context.http.request({
      url,
      signal: request.signal,
      maxBytes: LOCATIONS_MAX_BYTES,
      cacheKey: LOCATIONS_CACHE_KEY,
      headers: { Accept: 'application/json', 'Digitraffic-User': DIGITRAFFIC_USER },
    });
    let payload: unknown;
    try {
      payload = res.json();
    } catch {
      res.invalidate();
      throw new ProviderError('MALFORMED', 'Digitraffic locations answer is not valid JSON', { retryable: false });
    }
    const features = parseLocations(payload);
    if (typeof features === 'string') {
      res.invalidate();
      throw new ProviderError('MALFORMED', `Digitraffic ${features}`, { retryable: false });
    }

    if (now >= this.staticsDueAt) await this.refreshStatics(request.signal, now);

    const receivedAt = new Date(now).toISOString();
    const origin = res.stale || res.fromCache ? 'cached' : 'live';
    const byMmsi = new Map<string, Observation>();
    const reasons: string[] = [];
    for (const feature of features) {
      const r = locationToDraft(feature, this.statics, { receivedAt, nowMs: now });
      if (r.kind === 'rejected') {
        reasons.push(r.reason);
        continue;
      }
      r.draft.origin = origin;
      r.draft.sourceRef = url;
      const obs = buildObservation(this.manifest, receivedAt, {
        ...r.draft,
        rawPayloadHash: this.context.hash.sha256Hex(JSON.stringify(feature)),
      });
      const had = byMmsi.get(obs.externalId!);
      if (!had || Date.parse(obs.observedAt) > Date.parse(had.observedAt)) byMmsi.set(obs.externalId!, obs);
    }
    if (features.length > 0 && byMmsi.size === 0) {
      res.invalidate();
      assertAtomicAdmission(features.length, 0, 'Digitraffic locations');
    }
    if (reasons.length)
      this.context.logger.debug('Digitraffic locations rejected', {
        count: reasons.length,
        sample: reasons.slice(0, 3),
      });
    return { observations: [...byMmsi.values()], ...(res.ageMs ? { cacheAgeMs: res.ageMs } : {}) };
  }

  /**
   * Static data changed since the last answer, folded into `statics`. Never throws but for
   * cancellation: a ship without its name is still a ship, and the next attempt is soon.
   */
  private async refreshStatics(signal: AbortSignal, now: number): Promise<void> {
    const from = this.staticsHighWater !== undefined ? this.staticsHighWater - METADATA_OVERLAP_MS : undefined;
    try {
      const res = await this.context.http.request({
        url: vesselsUrl(from),
        signal,
        maxBytes: VESSELS_MAX_BYTES,
        cacheKey: VESSELS_CACHE_KEY,
        allowStale: false,
        headers: { Accept: 'application/json', 'Digitraffic-User': DIGITRAFFIC_USER },
      });
      let rows: unknown[] | string;
      try {
        rows = parseVessels(res.json());
      } catch {
        rows = 'vessels answer is not valid JSON';
      }
      if (typeof rows === 'string') {
        res.invalidate();
        throw new ProviderError('MALFORMED', `Digitraffic ${rows}`, { retryable: false });
      }
      let high = this.staticsHighWater;
      for (const row of rows) {
        const s = vesselStatic(row);
        if (!s) continue;
        this.statics.delete(s.mmsi);
        this.statics.set(s.mmsi, s.fields);
        if (s.timestampMs !== undefined && s.timestampMs <= now && (high === undefined || s.timestampMs > high))
          high = s.timestampMs;
      }
      while (this.statics.size > MAX_STATICS) this.statics.delete(this.statics.keys().next().value!);
      this.staticsHighWater = high ?? now;
      this.staticsDueAt = now + METADATA_REFRESH_MS;
    } catch (err) {
      if (err instanceof ProviderError && err.code === 'CANCELLED') throw err;
      if (signal.aborted) throw new ProviderError('CANCELLED', 'cancelled');
      this.staticsDueAt = now + METADATA_RETRY_MS;
      this.context.logger.warn('Digitraffic static data unavailable; ships shown without names for now', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Ships whose static data is known (diagnostics, tests). */
  get knownStatics(): number {
    return this.statics.size;
  }
}

export function createProvider(): DigitrafficAisProvider {
  return new DigitrafficAisProvider();
}
