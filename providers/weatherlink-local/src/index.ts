import type { Observation } from '@worldview/world-model';
import {
  LocalDeviceDetector,
  PollingProvider,
  ProviderError,
  assertAtomicAdmission,
  numberSetting,
  resolveLocalEndpoint,
  stringSetting,
  type Detection,
  type LocalEndpoint,
  type ProviderContext,
  type ProviderHealth,
  type ProviderManifest,
  type ProviderQuery,
} from '@worldview/provider-sdk';
import { PROBE_BACKOFF_MS, WEATHERLINK_LOCAL_MANIFEST } from './manifest.js';
import { normalizeConditions, parseCurrentConditions } from './normalize.js';

export { WEATHERLINK_LOCAL_MANIFEST, PROBE_BACKOFF_MS } from './manifest.js';
export { normalizeConditions, parseCurrentConditions, MPH_TO_MPS, INHG_TO_HPA, RAIN_COUNT_MM } from './normalize.js';
export type { ParsedConditions, StationNormalizeOptions, StationNormalizeResult } from './normalize.js';

const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_NAME = 'Weather station';

export interface WeatherLinkSettings {
  host?: string;
  latitude?: number;
  longitude?: number;
  name: string;
}

export function parseWeatherLinkSettings(raw: Record<string, unknown>): WeatherLinkSettings {
  const out: WeatherLinkSettings = { name: stringSetting(raw, 'name')?.slice(0, 60) ?? DEFAULT_NAME };
  const host = stringSetting(raw, 'host', { host: true });
  if (host) out.host = host;
  const lat = numberSetting(raw, 'latitude', -90, 90);
  if (lat !== undefined) out.latitude = lat;
  const lon = numberSetting(raw, 'longitude', -180, 180);
  if (lon !== undefined) out.longitude = lon;
  return out;
}

/** The one URL read — `http://<host>/v1/current_conditions` — or what is missing. */
export function stationEndpoint(settings: WeatherLinkSettings): LocalEndpoint {
  if (!settings.host) return { ok: false, reason: 'Set the WeatherLink Live address in this source’s settings' };
  if (settings.latitude === undefined || settings.longitude === undefined)
    return { ok: false, reason: 'Set the station’s latitude and longitude in this source’s settings' };
  return resolveLocalEndpoint(`http://${settings.host}/v1/current_conditions`, {
    label: 'WeatherLink Live address',
    trustedHostSetting: 'host',
    trustedHost: settings.host,
  });
}

/**
 * Polls one WeatherLink Live's current conditions once a minute. The device is probed before
 * it is polled; when it does not answer the source says "WeatherLink Live not detected at …"
 * and tries again after a minute. No other address is contacted and nothing is sent anywhere.
 */
export class WeatherLinkLocalProvider extends PollingProvider {
  readonly manifest: ProviderManifest = WEATHERLINK_LOCAL_MANIFEST;
  private settings: WeatherLinkSettings = { name: DEFAULT_NAME };
  private endpoint: LocalEndpoint = stationEndpoint(this.settings);
  private readonly detector = new LocalDeviceDetector({ what: 'WeatherLink Live', backoffMs: PROBE_BACKOFF_MS });

  protected override async onInitialize(context: ProviderContext): Promise<void> {
    this.applySettings(await context.settings.get());
    context.settings.onChange((s) => this.applySettings(s));
  }

  private applySettings(raw: Record<string, unknown>): void {
    this.settings = parseWeatherLinkSettings(raw);
    this.endpoint = stationEndpoint(this.settings);
    this.detector.reset();
  }

  get detectionState(): Detection {
    return this.detector.state;
  }

  protected async fetchOnce(request: ProviderQuery): Promise<{ observations: Observation[] }> {
    if (request.signal.aborted) throw new ProviderError('CANCELLED', 'cancelled before request');
    if (!this.endpoint.ok)
      throw new ProviderError('HOST_NOT_ALLOWED', this.endpoint.reason, { retryable: false, setup: true });
    const { url } = this.endpoint;
    const probe = await this.detector.ensure(
      this.context.local,
      url,
      this.context.clock.now(),
      this.manifest.refreshPolicy.timeoutMs,
    );
    if (probe.newlyDetected) this.context.logger.info('WeatherLink Live detected', { endpoint: url });
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
      throw new ProviderError('MALFORMED', 'current_conditions is not valid JSON', { retryable: false });
    }
    const parsed = parseCurrentConditions(payload);
    if (typeof parsed === 'string') {
      res.invalidate();
      throw new ProviderError('MALFORMED', parsed, { retryable: false });
    }
    const now = this.context.clock.now();
    const result = normalizeConditions(parsed, this.manifest, {
      receivedAt: new Date(now).toISOString(),
      nowMs: now,
      position: { latitude: this.settings.latitude!, longitude: this.settings.longitude! },
      name: this.settings.name,
      sourceRef: url,
      hash: (s) => this.context.hash.sha256Hex(s),
    });
    if (result.total === 0 && result.rejected.some((r) => r.index === -1)) {
      res.invalidate();
      throw new ProviderError('MALFORMED', result.rejected[0]!.reason, { retryable: false });
    }
    if (result.total > 0 && result.observations.length === 0) {
      res.invalidate();
      assertAtomicAdmission(result.total, 0, 'WeatherLink Live current_conditions');
    }
    if (result.rejected.length)
      this.context.logger.warn('rejected WeatherLink Live records', {
        count: result.rejected.length,
        sample: result.rejected.slice(0, 3).map((r) => r.reason),
      });
    return { observations: result.observations };
  }

  override async health(): Promise<ProviderHealth> {
    const h = await super.health();
    if (h.status === 'DISABLED' || h.status === 'STARTING') return h;
    if (!this.endpoint.ok) {
      // No address yet: the source waits for the operator, it has not failed.
      h.status = 'NEEDS_SETUP';
      h.message = this.endpoint.reason;
      return h;
    }
    if (this.detector.state === 'not-detected') {
      h.status = 'OFFLINE';
      h.message = `WeatherLink Live not detected at ${this.endpoint.url}`;
    }
    return h;
  }
}

export function createProvider(): WeatherLinkLocalProvider {
  return new WeatherLinkLocalProvider();
}
