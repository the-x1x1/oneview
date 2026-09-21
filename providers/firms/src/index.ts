import type { Observation } from '@worldview/world-model';
import { PollingProvider, ProviderError, assertAtomicAdmission, type ProviderContext, type ProviderManifest, type ProviderQuery } from '@worldview/provider-sdk';
import { DEFAULT_FIRMS_SOURCES, FIRMS_MANIFEST, isFirmsSource, type FirmsSource } from './manifest.js';
import { boundsToArea, clampDayRange, firmsRequest, type FirmsArea } from './url.js';
import { isKeyRejection, parseFirmsCsv } from './csv.js';
import { normalizeFirmsRows } from './normalize.js';

export { FIRMS_MANIFEST, FIRMS_SOURCES, DEFAULT_FIRMS_SOURCES, isFirmsSource } from './manifest.js';
export type { FirmsSource } from './manifest.js';
export { FIRMS_HOST, FIRMS_AREA_BASE, FIRMS_KEY_PLACEHOLDER, FIRMS_CREDENTIAL, FIRMS_CREDENTIAL_KEY, MIN_AREA_PADDING_DEG, firmsAreaUrl, firmsRequest, boundsToArea, formatArea, clampDayRange, parseFirmsAreaUrl } from './url.js';
export type { FirmsArea } from './url.js';
export { parseFirmsCsv, isLikelyCsv, isKeyRejection, acquisitionMsUtc } from './csv.js';
export type { FirmsRow, ParsedFirmsCsv } from './csv.js';
export { normalizeFirmsRows, rowToDraft, normalizeConfidence, detectionExternalId } from './normalize.js';
export type { FireConfidence, NormalizeOptions, NormalizeResult } from './normalize.js';

export interface FirmsSettings {
  /** Sources fetched sequentially each poll (default: the three VIIRS NRT products). */
  sources?: FirmsSource[];
  /** Days of data per request, 1-10 (default 1 = current UTC day). */
  dayRange?: number;
}

const MAX_BODY_BYTES = 32 * 1024 * 1024; // a world/1-day VIIRS file can exceed 10 MB during fire season

/**
 * FIRMS provider. Without a MAP_KEY the base class reports AUTH_REQUIRED and no
 * request is made. Sources are fetched one after another (quota courtesy); the
 * first failure aborts the poll so the runtime's backoff applies to the whole key.
 */
export class FirmsProvider extends PollingProvider {
  readonly manifest: ProviderManifest = FIRMS_MANIFEST;
  private settings: FirmsSettings = {};

  protected override async onInitialize(context: ProviderContext): Promise<void> {
    this.settings = parseSettings(await context.settings.get());
    context.settings.onChange((s) => { this.settings = parseSettings(s); });
  }

  protected async fetchOnce(request: ProviderQuery): Promise<{ observations: Observation[]; cacheAgeMs?: number }> {
    if (request.signal.aborted) throw new ProviderError('CANCELLED', 'cancelled before request');
    const sources = this.settings.sources ?? DEFAULT_FIRMS_SOURCES;
    const dayRange = this.settings.dayRange ?? 1;
    const area = boundsToArea(request.bounds);
    const observations: Observation[] = [];
    let cacheAgeMs = 0;
    for (const source of sources) {
      const batch = await this.fetchSource(source, area, dayRange, request);
      cacheAgeMs = Math.max(cacheAgeMs, batch.cacheAgeMs);
      observations.push(...batch.observations);
    }
    return { observations, cacheAgeMs };
  }

  private async fetchSource(source: FirmsSource, area: FirmsArea, dayRange: number, request: ProviderQuery): Promise<{ observations: Observation[]; cacheAgeMs: number }> {
    const req = firmsRequest(source, area, clampDayRange(dayRange));
    const res = await this.context.http.request({ ...req, signal: request.signal, maxBytes: MAX_BODY_BYTES, headers: { Accept: 'text/csv, text/plain' } });
    const text = res.text();
    const parsed = parseFirmsCsv(text);
    if (!parsed) {
      res.invalidate();
      if (isKeyRejection(text)) throw new ProviderError('AUTH', `FIRMS rejected the MAP_KEY for ${source}`, { retryable: false });
      throw new ProviderError('MALFORMED', `FIRMS ${source}: response is not FIRMS CSV`, { retryable: false });
    }
    if (parsed.total > 0 && parsed.rows.length === 0) { res.invalidate(); assertAtomicAdmission(parsed.total, 0, `FIRMS ${source}`); }
    const receivedAt = new Date(this.context.clock.now()).toISOString();
    const result = normalizeFirmsRows(parsed.rows, {
      receivedAt,
      source,
      hash: (s) => this.context.hash.sha256Hex(s),
      origin: res.stale ? 'cached' : 'live',
      sourceRef: req.url,
    });
    const rejected = parsed.rejected.length + result.rejected.length;
    if (rejected) this.context.logger.warn('rejected FIRMS rows', { source, count: rejected, sample: [...parsed.rejected, ...result.rejected].slice(0, 3).map((r) => r.reason) });
    return { observations: result.observations, cacheAgeMs: res.stale ? res.ageMs : 0 };
  }
}

export function parseSettings(raw: Record<string, unknown>): FirmsSettings {
  const out: FirmsSettings = {};
  const sources = raw['sources'];
  if (Array.isArray(sources)) {
    const valid = [...new Set(sources.filter(isFirmsSource))];
    if (valid.length) out.sources = valid;
  }
  const days = raw['dayRange'];
  if (typeof days === 'number' && Number.isFinite(days)) out.dayRange = clampDayRange(days);
  return out;
}

export function createProvider(): FirmsProvider {
  return new FirmsProvider();
}
