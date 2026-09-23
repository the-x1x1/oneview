import type { Observation } from '@worldview/world-model';
import {
  PollingProvider,
  ProviderError,
  assertAtomicAdmission,
  type ProviderManifest,
  type ProviderQuery,
} from '@worldview/provider-sdk';
import { NHC_CURRENT_STORMS_URL, NHC_MANIFEST } from './manifest.js';
import { normalizeCurrentStorms } from './normalize.js';

export { NHC_CURRENT_STORMS_URL, NHC_MANIFEST } from './manifest.js';
export { normalizeCurrentStorms, stormToDraft, parseHemisphere, CLASSIFICATIONS } from './normalize.js';

const MAX_BYTES = 2 * 1024 * 1024;

/** NHC active storms: one small JSON request per poll. An empty list is a quiet season, not an error. */
export class NhcStormsProvider extends PollingProvider {
  readonly manifest: ProviderManifest = NHC_MANIFEST;

  protected async fetchOnce(request: ProviderQuery): Promise<{ observations: Observation[]; cacheAgeMs?: number }> {
    const res = await this.context.http.request({
      url: NHC_CURRENT_STORMS_URL,
      signal: request.signal,
      maxBytes: MAX_BYTES,
      headers: { Accept: 'application/json' },
    });
    let payload: unknown;
    try {
      payload = res.json();
    } catch {
      res.invalidate();
      throw new ProviderError('MALFORMED', 'NHC CurrentStorms is not JSON', { retryable: false });
    }
    const nowMs = this.context.clock.now();
    const result = normalizeCurrentStorms(payload, {
      receivedAt: new Date(nowMs).toISOString(),
      nowMs,
      origin: res.stale || res.fromCache ? 'cached' : 'live',
      sourceRef: NHC_CURRENT_STORMS_URL,
      hash: (s) => this.context.hash.sha256Hex(s),
    });
    if (result.rejected.some((r) => r.index === -1)) {
      res.invalidate();
      throw new ProviderError('MALFORMED', 'NHC CurrentStorms has no activeStorms list', { retryable: false });
    }
    if (result.total > 0 && result.observations.length === 0) {
      res.invalidate();
      assertAtomicAdmission(result.total, 0, 'NHC CurrentStorms');
    }
    if (result.rejected.length)
      this.context.logger.warn('rejected NHC storms', {
        count: result.rejected.length,
        sample: result.rejected.slice(0, 3).map((r) => r.reason),
      });
    return { observations: result.observations, cacheAgeMs: res.ageMs };
  }
}

export function createProvider(): NhcStormsProvider {
  return new NhcStormsProvider();
}
