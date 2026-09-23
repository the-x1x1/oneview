import type { WorldProvider } from '@worldview/provider-sdk';
import { createProvider as createPurpleAirLocal } from '@worldview/provider-purpleair-local';
import { createProvider as createWeatherLinkLocal } from '@worldview/provider-weatherlink-local';

/**
 * Partial provider registry: sensors on the user's own network (roadmap 0.5). Each is off by
 * default and reaches only the one host its user names (ADR-003). The local ADS-B receiver
 * (readsb) predates this map and stays in aviation-maritime.ts.
 */
export type ProviderFactory = () => WorldProvider;

export const localSensorFactories: Readonly<Record<string, ProviderFactory>> = Object.freeze({
  'weatherlink-local': () => createWeatherLinkLocal(),
  'purpleair-local': () => createPurpleAirLocal(),
});
