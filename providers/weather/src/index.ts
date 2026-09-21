import type { Observation } from '@worldview/world-model';
import { PollingProvider, ProviderError, assertAtomicAdmission, type ProviderContext, type ProviderManifest, type ProviderQuery } from '@worldview/provider-sdk';
import { NWS_ALERTS_URL, NWS_MANIFEST, nwsUserAgent } from './manifest.js';
import { normalizeNwsAlerts, REJECT_NO_GEOMETRY, REJECT_ZONE_ONLY } from './normalize.js';
import { ZoneGeometryCache, zoneUrl } from './zones.js';

export { NWS_MANIFEST, NWS_ALERTS_URL, NWS_USER_AGENT_PRODUCT, nwsUserAgent } from './manifest.js';
export { normalizeNwsAlerts, featureToDraft, mapSeverity, toGeometry, alertUrn, isoOrUndefined, REJECT_NO_GEOMETRY, REJECT_ZONE_ONLY } from './normalize.js';
export type { NormalizeOptions, NormalizeResult } from './normalize.js';
export { ZoneGeometryCache, zoneRefsOf, parseZoneRef, zoneGeometry, combineZoneGeometries, zoneUrl, ZONE_TTL_MS, ZONE_FETCH_BUDGET, ZONE_FAILURE_BACKOFF_MS } from './zones.js';

export interface NwsSettings {
  /** Contact (email or URL) placed in the User-Agent, as api.weather.gov asks. */
  contact?: string;
  /** Restrict to these state / marine area codes (e.g. ["TX", "OK"]); default: national. */
  areas?: string[];
}

const MAX_BODY_BYTES = 16 * 1024 * 1024; // the national active feed peaks at a few MB during severe-weather days
const MAX_ZONE_BYTES = 4 * 1024 * 1024; // a single zone outline; the largest marine zones are a few hundred KB
const AREA_RE = /^[A-Z]{2}$/;
const CONTACT_MAX = 120;

/**
 * NWS alerts provider: polls the active-alerts feed every 5 minutes. The runtime's
 * HTTP layer handles ETag / If-None-Match; a 304 is served from cache with age 0.
 */
export class NwsAlertsProvider extends PollingProvider {
  readonly manifest: ProviderManifest = NWS_MANIFEST;
  private settings: NwsSettings = {};
  private zones: ZoneGeometryCache | undefined;

  protected override async onInitialize(context: ProviderContext): Promise<void> {
    this.settings = parseSettings(await context.settings.get());
    context.settings.onChange((s) => { this.settings = parseSettings(s); });
    this.zones = new ZoneGeometryCache({
      fetchZone: (zoneId, signal) => this.fetchZone(zoneId, signal),
      cache: context.cache,
      now: () => context.clock.now(),
      log: (message, fields) => context.logger.debug(message, fields),
    });
  }

  /** One zone outline from api.weather.gov/zones/… — the same allowlisted host as the feed. */
  private async fetchZone(zoneId: string, signal: AbortSignal): Promise<unknown> {
    const res = await this.context.http.request({
      url: zoneUrl(zoneId),
      signal,
      maxBytes: MAX_ZONE_BYTES,
      headers: { Accept: 'application/geo+json', 'User-Agent': nwsUserAgent(this.settings.contact) },
    });
    try { return res.json(); } catch { res.invalidate(); return undefined; }
  }

  /** Effective request URL (exposed for diagnostics and tests). */
  feedUrl(): string {
    const areas = this.settings.areas;
    return areas && areas.length ? `${NWS_ALERTS_URL}&area=${areas.join(',')}` : NWS_ALERTS_URL;
  }

  protected async fetchOnce(request: ProviderQuery): Promise<{ observations: Observation[]; cacheAgeMs?: number }> {
    if (request.signal.aborted) throw new ProviderError('CANCELLED', 'cancelled before request');
    const url = this.feedUrl();
    let res;
    try {
      res = await this.context.http.request({
        url,
        signal: request.signal,
        maxBytes: MAX_BODY_BYTES,
        headers: { Accept: 'application/geo+json', 'User-Agent': nwsUserAgent(this.settings.contact) },
      });
    } catch (err) {
      throw mapUpstreamError(err);
    }
    let payload: unknown;
    try { payload = res.json(); } catch { res.invalidate(); throw new ProviderError('MALFORMED', 'NWS alerts response is not valid JSON', { retryable: false }); }
    const nowMs = this.context.clock.now();
    const zones = this.zones;
    const normalizeOpts = {
      receivedAt: new Date(nowMs).toISOString(),
      nowMs,
      hash: (s: string) => this.context.hash.sha256Hex(s),
      origin: (res.stale ? 'cached' : 'live') as 'cached' | 'live',
      sourceRef: url,
      ...(zones ? { zoneGeometry: (id: string) => zones.lookup(id) } : {}),
    };
    let result = normalizeNwsAlerts(payload, normalizeOpts);
    if (result.rejected.some((r) => r.index === -1)) { res.invalidate(); throw new ProviderError('MALFORMED', 'NWS alerts response is not a FeatureCollection', { retryable: false }); }
    // Second pass: fetch the zone outlines this feed needs (bounded per poll) and
    // normalize again, so zone-based alerts appear instead of being counted as skipped.
    if (zones && result.zonesNeeded.length > 0 && !request.signal.aborted) {
      const { fetched } = await zones.resolve(result.zonesNeeded, request.signal);
      if (fetched > 0) result = normalizeNwsAlerts(payload, normalizeOpts);
    }
    // Zone-only alerts are expected in every real feed; only hard rejections count for atomic admission.
    const zoneOnly = result.rejected.filter((r) => r.reason === REJECT_ZONE_ONLY || r.reason === REJECT_NO_GEOMETRY).length;
    const hard = result.rejected.length - zoneOnly;
    if (result.total > 0 && result.observations.length === 0 && hard === result.total) { res.invalidate(); assertAtomicAdmission(result.total, 0, 'NWS alerts feed'); }
    if (result.rejected.length) {
      this.context.logger.info('NWS alerts skipped', { total: result.total, admitted: result.observations.length, fromZones: result.fromZones, zoneOnly, unresolvedZones: result.zonesNeeded.length, rejected: hard, sample: result.rejected.filter((r) => r.reason !== REJECT_ZONE_ONLY).slice(0, 3).map((r) => r.reason) });
    }
    return { observations: result.observations, cacheAgeMs: res.stale ? res.ageMs : 0 };
  }
}

/** api.weather.gov answers 403 to clients without an identifying User-Agent — a configuration problem, not a credential. */
export function mapUpstreamError(err: unknown): ProviderError {
  if (err instanceof ProviderError && err.code === 'AUTH' && err.httpStatus === 403) {
    return new ProviderError('HTTP_4XX', 'api.weather.gov refused the request (HTTP 403): an identifying User-Agent with contact information is required — set the provider contact setting', { httpStatus: 403, retryable: false, cause: err });
  }
  if (err instanceof ProviderError) return err;
  return new ProviderError('INTERNAL', err instanceof Error ? err.message : String(err), { cause: err });
}

export function parseSettings(raw: Record<string, unknown>): NwsSettings {
  const out: NwsSettings = {};
  const contact = raw['contact'];
  if (typeof contact === 'string') {
    const cleaned = contact.replace(/[\r\n\t]+/g, ' ').trim().slice(0, CONTACT_MAX);
    if (cleaned) out.contact = cleaned;
  }
  const areas = raw['areas'];
  if (Array.isArray(areas)) {
    const valid = [...new Set(areas.filter((a): a is string => typeof a === 'string').map((a) => a.toUpperCase()).filter((a) => AREA_RE.test(a)))];
    if (valid.length) out.areas = valid.slice(0, 60);
  }
  return out;
}

export function createProvider(): NwsAlertsProvider {
  return new NwsAlertsProvider();
}
