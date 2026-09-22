import type { JsonValue } from '@worldview/world-model';
import { DEFAULT_READSB_ENDPOINT } from './manifest.js';

/**
 * Endpoint policy for the local receiver. Accepted:
 *   - http(s) to a loopback host (127.0.0.0/8, localhost, ::1) — the default;
 *   - http(s) to exactly the host named in `settings.trustedHost` (user-configured LAN receiver).
 * Everything else is refused with a message the health panel can show. The runtime must add a
 * trusted host to the provider's network allowlist; this module only decides the policy.
 */
export type EndpointResolution =
  { ok: true; url: string; host: string; trusted: boolean } | { ok: false; reason: string };

export interface ReadsbSettings {
  endpoint?: string;
  trustedHost?: string;
}

export function parseReadsbSettings(raw: Record<string, JsonValue | unknown>): ReadsbSettings {
  const out: ReadsbSettings = {};
  const endpoint = raw['endpoint'];
  if (typeof endpoint === 'string' && endpoint.trim()) out.endpoint = endpoint.trim();
  const trusted = raw['trustedHost'];
  if (typeof trusted === 'string' && trusted.trim()) out.trustedHost = trusted.trim().toLowerCase();
  return out;
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || h === '127.0.0.1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

export function resolveEndpoint(settings: ReadsbSettings): EndpointResolution {
  const raw = settings.endpoint ?? DEFAULT_READSB_ENDPOINT;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `readsb endpoint is not a valid URL: ${raw}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return { ok: false, reason: `readsb endpoint must use http or https (got ${url.protocol.replace(':', '')})` };
  if (url.username || url.password) return { ok: false, reason: 'readsb endpoint must not embed credentials' };
  const host = url.hostname.toLowerCase();
  if (isLoopbackHost(host)) return { ok: true, url: url.toString(), host, trusted: false };
  if (settings.trustedHost && settings.trustedHost === host)
    return { ok: true, url: url.toString(), host, trusted: true };
  return {
    ok: false,
    reason: `readsb endpoint host "${host}" is not loopback; set trustedHost to "${host}" to allow it explicitly`,
  };
}
