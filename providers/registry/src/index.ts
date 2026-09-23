import type { WorldProvider } from '@worldview/provider-sdk';
import { createProvider as createUsgsEarthquakes } from '@worldview/provider-usgs';
import { createProvider as createCelestrak, type CelestrakProviderOptions } from '@worldview/provider-celestrak';
import { spaceFireWeatherFactories } from './space-fire-weather.js';
import { aviationMaritimeProviders, type AviationMaritimeRegistryOptions } from './aviation-maritime.js';
import { cameraProviderFactories } from './cameras.js';

/**
 * @worldview/providers — the one place that knows which providers ship with WORLDVIEW.
 *
 * The runtime composes `createAllProviders(options)` into the ProviderHost; nothing else
 * imports provider packages (boundary-check enforces it for UI and renderers). Factories
 * are keyed by manifest id and return a fresh instance per call, because a provider owns
 * mutable per-host state.
 *
 * Injections that cannot come from the frozen `ProviderContext` are passed here:
 *   - `aisSecretResolver` — legacy/test seam for the AISStream subscription frame. In
 *     production the runtime resolves the key on the socket itself (ADR-003), so the
 *     desktop leaves this unset.
 *   - `celestrak` — an injected SGP4 propagator for the satellite provider.
 *
 * Camera gateway hooks and local file access are *not* factory options: those providers
 * reach them through `ProviderContext.local` / `ProviderContext.settings`, which the
 * runtime supplies per provider.
 */
export type ProviderFactory = () => WorldProvider;

export type { AviationMaritimeRegistryOptions } from './aviation-maritime.js';
export { spaceFireWeatherFactories, createSpaceFireWeatherProviders } from './space-fire-weather.js';
export { aviationMaritimeProviders, AVIATION_MARITIME_PROVIDER_IDS } from './aviation-maritime.js';
export { cameraProviderFactories } from './cameras.js';
/** Replay: satellites propagated to the cursor from their stored element sets. */
export { createSatelliteReprojector, type SatelliteReprojector } from '@worldview/provider-celestrak';

export interface ProviderRegistryOptions extends AviationMaritimeRegistryOptions {
  /** Options for the CelesTrak provider (e.g. an injected SGP4 propagator). */
  celestrak?: CelestrakProviderOptions;
}

/**
 * The full factory map. Built per call so the injected options reach the providers that
 * need them; the keys are stable and equal to every provider's manifest id.
 */
export function providerFactories(options: ProviderRegistryOptions = {}): Readonly<Record<string, ProviderFactory>> {
  const celestrak = options.celestrak;
  return Object.freeze({
    'usgs-earthquakes': () => createUsgsEarthquakes(),
    ...spaceFireWeatherFactories,
    ...(celestrak ? { celestrak: () => createCelestrak(celestrak) } : {}),
    ...aviationMaritimeProviders(options),
    ...cameraProviderFactories,
  });
}

/** Manifest ids of every provider in the registry, sorted. */
export function providerIds(): string[] {
  return Object.keys(providerFactories()).sort();
}

/** One fresh instance of every provider, in registry key order. */
export function createAllProviders(options: ProviderRegistryOptions = {}): WorldProvider[] {
  return Object.values(providerFactories(options)).map((factory) => factory());
}

/** One provider by manifest id, or undefined when the id is unknown. */
export function createProviderById(id: string, options: ProviderRegistryOptions = {}): WorldProvider | undefined {
  return providerFactories(options)[id]?.();
}
