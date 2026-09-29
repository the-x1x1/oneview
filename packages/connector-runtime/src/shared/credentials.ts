import type { ConnectorProviderDefinition } from '@worldview/connector-sdk';
import type { ProviderHttpRequest } from '@worldview/provider-sdk';

/**
 * Credentials by reference. A definition names a credential (`credentials.<name>.secretRef`)
 * and says where it goes (`endpoint.credential`, `websocket.credential`); the connector only
 * ever handles the reference, and the provider host puts the secret into the request or the
 * socket URL itself. These helpers resolve the reference the same way for every connector
 * that reads it the same way.
 */

/**
 * The credential the definition's endpoint names, as the HTTP layer attaches it: the
 * reference, where it goes (`query`, `header`, `bearer`, `path`) and, when the definition
 * gives one, the query parameter or header name. Undefined when the endpoint names no
 * credential or names one the definition does not declare.
 *
 * `rest-json` builds its own: it leaves the name off a `path` credential (A1, phase
 * provider-migration), which this helper's callers never had to.
 */
export function endpointCredential(d: ConnectorProviderDefinition): ProviderHttpRequest['credential'] | undefined {
  const c = d.endpoint?.credential;
  if (!c) return undefined;
  const ref = d.credentials?.[c.name];
  if (!ref) return undefined;
  return { key: ref.secretRef, as: c.as, ...(c.param ? { name: c.param } : {}) };
}

/**
 * The secret reference behind a credential name, for a connection the host opens with it
 * (a socket URL, a broker login); undefined when there is no name or the definition does
 * not declare it.
 */
export function credentialRef(d: ConnectorProviderDefinition, name: string | undefined): string | undefined {
  return name === undefined ? undefined : d.credentials?.[name]?.secretRef;
}
