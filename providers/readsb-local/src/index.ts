import type { Observation } from '@worldview/world-model';
import {
  LocalDeviceDetector,
  PollingProvider,
  ProviderError,
  assertAtomicAdmission,
  type Detection,
  type ProviderContext,
  type ProviderHealth,
  type ProviderManifest,
  type ProviderQuery,
} from '@worldview/provider-sdk';
import { READSB_LOCAL_MANIFEST, PROBE_BACKOFF_MS } from './manifest.js';
import { normalizeAircraftRows, parseReadsbAircraftJson } from './normalize.js';
import { parseReadsbSettings, resolveEndpoint, type EndpointResolution } from './endpoint.js';

export { READSB_LOCAL_MANIFEST, DEFAULT_READSB_ENDPOINT, PROBE_BACKOFF_MS } from './manifest.js';
export {
  normalizeAircraftRows,
  aircraftRowToDraft,
  parseReadsbAircraftJson,
  STALE_POSITION_SECONDS,
} from './normalize.js';
export type { AircraftNormalizeOptions, AircraftNormalizeResult } from './normalize.js';
export { resolveEndpoint, parseReadsbSettings, isLoopbackHost } from './endpoint.js';
export type { EndpointResolution, ReadsbSettings } from './endpoint.js';

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** Own receiver: positions are direct ADS-B decodes. */
const POSITION_ACCURACY_M = 30;

/**
 * Polls a readsb/dump1090 `aircraft.json` on loopback (or a trusted host) once a second.
 * Detection is conservative: the configured endpoint is probed before polling; when it is not
 * reachable the provider reports OFFLINE ("readsb not detected at …") and asks the runtime to
 * retry in 30 s. No other host or port is ever contacted.
 */
export class ReadsbLocalProvider extends PollingProvider {
  readonly manifest: ProviderManifest = READSB_LOCAL_MANIFEST;
  private endpoint: EndpointResolution = resolveEndpoint({});
  private readonly detector = new LocalDeviceDetector({ what: 'readsb', backoffMs: PROBE_BACKOFF_MS });
  private lastMessages: number | undefined;

  protected override async onInitialize(context: ProviderContext): Promise<void> {
    this.applySettings(await context.settings.get());
    context.settings.onChange((s) => this.applySettings(s));
  }

  private applySettings(raw: Record<string, unknown>): void {
    this.endpoint = resolveEndpoint(parseReadsbSettings(raw));
    this.detector.reset();
  }

  /** Current endpoint decision (diagnostics / tests). */
  get endpointResolution(): EndpointResolution {
    return this.endpoint;
  }
  get detectionState(): Detection {
    return this.detector.state;
  }

  protected async fetchOnce(request: ProviderQuery): Promise<{ observations: Observation[]; cacheAgeMs?: number }> {
    if (request.signal.aborted) throw new ProviderError('CANCELLED', 'cancelled before request');
    if (!this.endpoint.ok) throw new ProviderError('HOST_NOT_ALLOWED', this.endpoint.reason, { retryable: false });
    const { url } = this.endpoint;
    const probe = await this.detector.ensure(
      this.context.local,
      url,
      this.context.clock.now(),
      this.manifest.refreshPolicy.timeoutMs,
    );
    if (probe.newlyDetected)
      this.context.logger.info('readsb detected', {
        endpoint: url,
        ...(probe.status !== undefined ? { status: probe.status } : {}),
      });
    let res;
    try {
      res = await this.context.http.request({
        url,
        signal: request.signal,
        maxBytes: MAX_RESPONSE_BYTES,
        allowStale: false,
        headers: { Accept: 'application/json' },
      });
    } catch (err) {
      this.detector.noteFailure(err);
      throw err;
    }
    let payload: unknown;
    try {
      payload = res.json();
    } catch {
      res.invalidate();
      throw new ProviderError('MALFORMED', 'aircraft.json is not valid JSON', { retryable: false });
    }
    const parsed = parseReadsbAircraftJson(payload);
    if (typeof parsed === 'string') {
      res.invalidate();
      throw new ProviderError('MALFORMED', parsed, { retryable: false });
    }
    if (parsed.messages !== undefined) this.lastMessages = parsed.messages;
    const receivedAt = new Date(this.context.clock.now()).toISOString();
    const result = normalizeAircraftRows(parsed.rows, this.manifest, {
      nowMs: parsed.nowMs,
      receivedAt,
      sourceQuality: 'authoritative',
      positionAccuracyM: POSITION_ACCURACY_M,
      origin: 'local',
      sourceRef: url,
      hash: (s) => this.context.hash.sha256Hex(s),
    });
    // Rows without a position (Mode S only, or not yet decoded) are normal for a receiver;
    // only rows broken for other reasons count towards atomic admission.
    const hard = result.rejected.filter((r) => r.reason !== 'missing position').length;
    if (result.total > 0 && result.observations.length === 0 && hard === result.total) {
      res.invalidate();
      assertAtomicAdmission(result.total, 0, 'readsb aircraft.json');
    }
    if (hard)
      this.context.logger.warn('rejected readsb rows', {
        count: hard,
        sample: result.rejected
          .filter((r) => r.reason !== 'missing position')
          .slice(0, 3)
          .map((r) => r.reason),
      });
    return { observations: result.observations, cacheAgeMs: res.ageMs };
  }

  override async health(): Promise<ProviderHealth> {
    const h = await super.health();
    if (h.status === 'DISABLED' || h.status === 'STARTING') return h;
    if (!this.endpoint.ok) {
      h.status = 'ERROR';
      h.message = this.endpoint.reason;
      return h;
    }
    if (this.detector.state === 'not-detected') {
      h.status = 'OFFLINE';
      h.message = `readsb not detected at ${this.endpoint.url}`;
    }
    return h;
  }

  /** Total Mode S messages the receiver reported (diagnostics). */
  get receiverMessageCount(): number | undefined {
    return this.lastMessages;
  }
}

export function createProvider(): ReadsbLocalProvider {
  return new ReadsbLocalProvider();
}
