import { ProviderError, type ProviderErrorCode } from './health.js';
import type { ProviderLocalAccess } from './provider.js';

/**
 * The local-sensor kit (roadmap 0.5: "a local-sensor SDK with the same manifest/data-policy
 * contract"; ADR-003). A local source — a receiver, a weather station, a sensor gateway —
 * is a provider like any other, declared by a manifest with `transport: 'local-process'` or
 * `'hardware'` and a data policy. What they share is here:
 *
 *   - `resolveLocalEndpoint` — which URL may be read: loopback, or exactly the one host the
 *     user named in the manifest's `trustedHostSetting` (which the runtime also adds to the
 *     provider's network allowlist). Nothing else, and never credentials in the URL.
 *   - `LocalDeviceDetector` — detection that stays conservative: the one configured endpoint
 *     is probed before it is polled; when nothing answers the provider says so ("… not
 *     detected at …", OFFLINE) and asks to be retried after a back-off, and a transport
 *     failure later sends it back to probing. No other host, port or address is tried —
 *     there is no discovery.
 */
export type LocalEndpoint = { ok: true; url: string; host: string; trusted: boolean } | { ok: false; reason: string };

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || h === '127.0.0.1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

export interface LocalEndpointOptions {
  /** What the URL is, as messages name it: "readsb endpoint", "WeatherLink Live address". */
  label: string;
  /** The host the user named (already trimmed and lower-cased), if any. */
  trustedHost?: string;
  /** The setting a refused host should be named in, for the message. */
  trustedHostSetting: string;
}

export function resolveLocalEndpoint(raw: string, opts: LocalEndpointOptions): LocalEndpoint {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `${opts.label} is not a valid URL: ${raw}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return { ok: false, reason: `${opts.label} must use http or https (got ${url.protocol.replace(':', '')})` };
  if (url.username || url.password) return { ok: false, reason: `${opts.label} must not embed credentials` };
  const host = url.hostname.toLowerCase();
  if (isLoopbackHost(host)) return { ok: true, url: url.toString(), host, trusted: false };
  if (opts.trustedHost && opts.trustedHost === host) return { ok: true, url: url.toString(), host, trusted: true };
  return {
    ok: false,
    reason: `${opts.label} host "${host}" is not loopback; set ${opts.trustedHostSetting} to "${host}" to allow it explicitly`,
  };
}

/** A setting's string value, trimmed; a host lower-cased. Anything else is absent. */
export function stringSetting(
  raw: Record<string, unknown>,
  key: string,
  opts: { host?: boolean } = {},
): string | undefined {
  const v = raw[key];
  if (typeof v !== 'string' || !v.trim()) return undefined;
  return opts.host ? v.trim().toLowerCase() : v.trim();
}

/** A setting's finite number within [min, max]; a numeric string counts. Anything else is absent. */
export function numberSetting(raw: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = raw[key];
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}

export type Detection = 'unknown' | 'detected' | 'not-detected';

/** Transport-level failures after which the endpoint is probed again before the next poll. */
export const REPROBE_CODES: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>([
  'NETWORK',
  'OFFLINE',
  'DNS',
  'TIMEOUT',
  'HTTP_5XX',
]);

export interface LocalDeviceDetectorOptions {
  /** What is detected, as the message names it: "readsb", "WeatherLink Live". */
  what: string;
  /** How long to wait before probing again after nothing answered. */
  backoffMs: number;
}

export class LocalDeviceDetector {
  private detection: Detection = 'unknown';
  private nextProbeAt = 0;

  constructor(private readonly opts: LocalDeviceDetectorOptions) {}

  get state(): Detection {
    return this.detection;
  }

  /** Forget what is known (settings changed): the next poll probes. */
  reset(): void {
    this.detection = 'unknown';
    this.nextProbeAt = 0;
  }

  /**
   * Resolves when `url` may be polled: at once if it answered before, after a probe
   * otherwise. Throws OFFLINE ("<what> not detected at <url>", retry after the back-off)
   * when the probe finds nothing, or while a back-off from the last one runs.
   */
  async ensure(
    local: ProviderLocalAccess,
    url: string,
    nowMs: number,
    timeoutMs: number,
  ): Promise<{ newlyDetected: boolean; status?: number }> {
    if (this.detection === 'detected') return { newlyDetected: false };
    if (this.detection === 'not-detected' && nowMs < this.nextProbeAt)
      throw this.notDetected(url, this.nextProbeAt - nowMs);
    const probe = await local.probeLocal(url, { timeoutMs });
    if (!probe.reachable) {
      this.detection = 'not-detected';
      this.nextProbeAt = nowMs + this.opts.backoffMs;
      throw this.notDetected(url, this.opts.backoffMs);
    }
    this.detection = 'detected';
    return { newlyDetected: true, ...(probe.status !== undefined ? { status: probe.status } : {}) };
  }

  /** A poll failed: a transport failure sends the next poll back to probing. */
  noteFailure(err: unknown): void {
    if (err instanceof ProviderError && REPROBE_CODES.has(err.code)) this.detection = 'unknown';
  }

  notDetected(url: string, waitMs: number): ProviderError {
    return new ProviderError('OFFLINE', `${this.opts.what} not detected at ${url}`, {
      retryAfterMs: Math.max(1000, Math.round(waitMs)),
    });
  }
}
