import type { Observation } from '@worldview/world-model';
import {
  LocalDeviceDetector,
  PollingProvider,
  ProviderError,
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
import { PROBE_BACKOFF_MS, PURPLEAIR_LOCAL_MANIFEST } from './manifest.js';
import { normalizeSensorJson } from './normalize.js';

export { PURPLEAIR_LOCAL_MANIFEST, PROBE_BACKOFF_MS } from './manifest.js';
export { normalizeSensorJson, parseSensorTime, sensorKey, combineChannels } from './normalize.js';
export type { PurpleAirNormalizeOptions, PurpleAirResult } from './normalize.js';

const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_NAME = 'Air-quality sensor';

export interface PurpleAirSettings {
  host?: string;
  latitude?: number;
  longitude?: number;
  name: string;
}

export function parsePurpleAirSettings(raw: Record<string, unknown>): PurpleAirSettings {
  const out: PurpleAirSettings = { name: stringSetting(raw, 'name')?.slice(0, 60) ?? DEFAULT_NAME };
  const host = stringSetting(raw, 'host', { host: true });
  if (host) out.host = host;
  const lat = numberSetting(raw, 'latitude', -90, 90);
  const lon = numberSetting(raw, 'longitude', -180, 180);
  // A position is both numbers or neither.
  if (lat !== undefined && lon !== undefined) {
    out.latitude = lat;
    out.longitude = lon;
  }
  return out;
}

/** The one URL read — `http://<host>/json` — or what is missing. */
export function sensorEndpoint(settings: PurpleAirSettings): LocalEndpoint {
  if (!settings.host) return { ok: false, reason: 'Set the sensor’s address in this source’s settings' };
  return resolveLocalEndpoint(`http://${settings.host}/json`, {
    label: 'Sensor address',
    trustedHostSetting: 'host',
    trustedHost: settings.host,
  });
}

/**
 * Polls one PurpleAir sensor's two-minute averages every two minutes. The sensor is probed
 * before it is polled; when it does not answer the source says "PurpleAir sensor not detected
 * at …" and tries again after a minute. No other address is contacted.
 */
export class PurpleAirLocalProvider extends PollingProvider {
  readonly manifest: ProviderManifest = PURPLEAIR_LOCAL_MANIFEST;
  private settings: PurpleAirSettings = { name: DEFAULT_NAME };
  private endpoint: LocalEndpoint = sensorEndpoint(this.settings);
  private readonly detector = new LocalDeviceDetector({ what: 'PurpleAir sensor', backoffMs: PROBE_BACKOFF_MS });

  protected override async onInitialize(context: ProviderContext): Promise<void> {
    this.applySettings(await context.settings.get());
    context.settings.onChange((s) => this.applySettings(s));
  }

  private applySettings(raw: Record<string, unknown>): void {
    this.settings = parsePurpleAirSettings(raw);
    this.endpoint = sensorEndpoint(this.settings);
    this.detector.reset();
  }

  get detectionState(): Detection {
    return this.detector.state;
  }

  protected async fetchOnce(request: ProviderQuery): Promise<{ observations: Observation[] }> {
    if (request.signal.aborted) throw new ProviderError('CANCELLED', 'cancelled before request');
    if (!this.endpoint.ok) throw new ProviderError('HOST_NOT_ALLOWED', this.endpoint.reason, { retryable: false });
    const { url } = this.endpoint;
    const probe = await this.detector.ensure(
      this.context.local,
      url,
      this.context.clock.now(),
      this.manifest.refreshPolicy.timeoutMs,
    );
    if (probe.newlyDetected) this.context.logger.info('PurpleAir sensor detected', { endpoint: url });
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
      throw new ProviderError('MALFORMED', 'the sensor’s /json is not valid JSON', { retryable: false });
    }
    const now = this.context.clock.now();
    const s = this.settings;
    const result = normalizeSensorJson(payload, this.manifest, {
      receivedAt: new Date(now).toISOString(),
      nowMs: now,
      name: s.name,
      ...(s.latitude !== undefined && s.longitude !== undefined
        ? { position: { latitude: s.latitude, longitude: s.longitude } }
        : {}),
      sourceRef: url,
      hash: (x) => this.context.hash.sha256Hex(x),
    });
    if ('error' in result) {
      // A sensor that answers but has no PM2.5 average yet (just started) is up, with nothing to show.
      if (result.error === 'no PM2.5 reading') return { observations: [] };
      res.invalidate();
      throw new ProviderError('MALFORMED', result.error, { retryable: false });
    }
    return { observations: [result.observation] };
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
      h.message = `PurpleAir sensor not detected at ${this.endpoint.url}`;
    }
    return h;
  }
}

export function createProvider(): PurpleAirLocalProvider {
  return new PurpleAirLocalProvider();
}
