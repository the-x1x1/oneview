import type { JsonValue } from '@worldview/world-model';
import { isLoopbackHost, resolveLocalEndpoint, stringSetting, type LocalEndpoint } from '@worldview/provider-sdk';
import { DEFAULT_READSB_ENDPOINT } from './manifest.js';

/**
 * Endpoint policy for the local receiver. Accepted:
 *   - http(s) to a loopback host (127.0.0.0/8, localhost, ::1) — the default;
 *   - http(s) to exactly the host named in `settings.trustedHost` (user-configured LAN receiver).
 * Everything else is refused with a message the health panel can show. The runtime must add a
 * trusted host to the provider's network allowlist; this module only decides the policy.
 */
export type EndpointResolution = LocalEndpoint;

export interface ReadsbSettings {
  endpoint?: string;
  trustedHost?: string;
}

export function parseReadsbSettings(raw: Record<string, JsonValue | unknown>): ReadsbSettings {
  const out: ReadsbSettings = {};
  const endpoint = stringSetting(raw, 'endpoint');
  if (endpoint) out.endpoint = endpoint;
  const trusted = stringSetting(raw, 'trustedHost', { host: true });
  if (trusted) out.trustedHost = trusted;
  return out;
}

export { isLoopbackHost };

export function resolveEndpoint(settings: ReadsbSettings): EndpointResolution {
  return resolveLocalEndpoint(settings.endpoint ?? DEFAULT_READSB_ENDPOINT, {
    label: 'readsb endpoint',
    trustedHostSetting: 'trustedHost',
    ...(settings.trustedHost ? { trustedHost: settings.trustedHost } : {}),
  });
}
