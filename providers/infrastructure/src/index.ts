import type { Observation } from '@worldview/world-model';
import {
  PollingProvider,
  ProviderError,
  assertAtomicAdmission,
  type ProviderManifest,
  type ProviderQuery,
} from '@worldview/provider-sdk';
import { SEED_AIRPORTS_MANIFEST, SEED_AIRPORTS_FILE } from './manifest.js';
import { normalizeAirportCollection } from './normalize.js';

export { SEED_AIRPORTS_MANIFEST, SEED_AIRPORTS_FILE, SEED_AIRPORTS_DATASET_DATE } from './manifest.js';
export { normalizeAirportCollection, airportFeatureToDraft, normalizeDatasetDate } from './normalize.js';
export type { AirportNormalizeOptions, AirportNormalizeResult } from './normalize.js';

const MAX_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Reads the bundled seed-airports GeoJSON through the granted resources directory. No network,
 * no credentials; the polling interval only re-reads the file once a day.
 */
export class SeedAirportsProvider extends PollingProvider {
  readonly manifest: ProviderManifest = SEED_AIRPORTS_MANIFEST;
  private datasetDate: string | undefined;

  protected async fetchOnce(request: ProviderQuery): Promise<{ observations: Observation[]; cacheAgeMs?: number }> {
    if (request.signal.aborted) throw new ProviderError('CANCELLED', 'cancelled before read');
    const bytes = await this.context.local.readGrantedFile(SEED_AIRPORTS_FILE, { maxBytes: MAX_FILE_BYTES });
    if (request.signal.aborted) throw new ProviderError('CANCELLED', 'cancelled during read');
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw new ProviderError('MALFORMED', `${SEED_AIRPORTS_FILE} is not valid JSON`, { retryable: false });
    }
    const receivedAt = new Date(this.context.clock.now()).toISOString();
    const result = normalizeAirportCollection(payload, this.manifest, {
      receivedAt,
      hash: (s) => this.context.hash.sha256Hex(s),
      sourceRef: `bundled:${SEED_AIRPORTS_FILE}`,
    });
    if (typeof result === 'string')
      throw new ProviderError('MALFORMED', `${SEED_AIRPORTS_FILE}: ${result}`, { retryable: false });
    assertAtomicAdmission(result.total, result.observations.length, SEED_AIRPORTS_FILE);
    if (result.rejected.length)
      this.context.logger.warn('rejected airport features', {
        count: result.rejected.length,
        sample: result.rejected.slice(0, 3).map((r) => r.reason),
      });
    this.datasetDate = result.datasetDate;
    return { observations: result.observations, cacheAgeMs: 0 };
  }

  /** `datasetDate` of the last successfully read file. */
  get loadedDatasetDate(): string | undefined {
    return this.datasetDate;
  }
}

export function createProvider(): SeedAirportsProvider {
  return new SeedAirportsProvider();
}
