import type { WorldProvider } from '@worldview/provider-sdk';
import { createProvider as createCelestrakProvider, type CelestrakProviderOptions } from '@worldview/provider-celestrak';
import { createProvider as createFirmsProvider } from '@worldview/provider-firms';
import { createProvider as createNwsAlertsProvider } from '@worldview/provider-weather';

/**
 * Partial provider-factory map for the space / fire / weather workstream.
 * `providers/registry/src/index.ts` (owned by the registry integration) spreads
 * this into `providerFactories`; keeping it here avoids merge conflicts between
 * provider workstreams that land in parallel.
 */
export type ProviderFactory = () => WorldProvider;

export const spaceFireWeatherFactories: Readonly<Record<string, ProviderFactory>> = Object.freeze({
  celestrak: () => createCelestrakProvider(),
  'nasa-firms': () => createFirmsProvider(),
  'nws-alerts': () => createNwsAlertsProvider(),
});

/** Instantiate every provider in this map (options apply to CelesTrak, e.g. an injected propagator). */
export function createSpaceFireWeatherProviders(options: { celestrak?: CelestrakProviderOptions } = {}): WorldProvider[] {
  return [createCelestrakProvider(options.celestrak ?? {}), createFirmsProvider(), createNwsAlertsProvider()];
}
