import type { WorldProvider } from '@worldview/provider-sdk';
import { createProvider as createAdsbLol } from '@worldview/provider-adsb-remote';
import { createProvider as createReadsbLocal } from '@worldview/provider-readsb-local';
import { createProvider as createAisStream, type AisStreamProviderOptions, type SecretResolver } from '@worldview/provider-ais';
import { createProvider as createSeedAirports } from '@worldview/provider-infrastructure';

/**
 * Partial provider registry: aviation, maritime and bundled infrastructure. Merged into the
 * full map by providers/registry/src/index.ts. Factories are keyed by manifest id.
 */
export type ProviderFactory = () => WorldProvider;

export interface AviationMaritimeRegistryOptions {
  /**
   * Resolves the raw AISStream API key for the subscription frame. Without it the AIS provider
   * refuses to subscribe (AUTH) — the frozen ProviderContext only exposes `credentials.has`.
   */
  aisSecretResolver?: SecretResolver;
  ais?: Omit<AisStreamProviderOptions, 'secretResolver'>;
}

export function aviationMaritimeProviders(options: AviationMaritimeRegistryOptions = {}): Readonly<Record<string, ProviderFactory>> {
  const aisOptions: AisStreamProviderOptions = { ...options.ais, ...(options.aisSecretResolver ? { secretResolver: options.aisSecretResolver } : {}) };
  return Object.freeze({
    'adsb-lol': () => createAdsbLol(),
    'readsb-local': () => createReadsbLocal(),
    'aisstream-io': () => createAisStream(aisOptions),
    'worldview-seed-airports': () => createSeedAirports(),
  });
}

/** Manifest ids exported by this partial map, in registration order. */
export const AVIATION_MARITIME_PROVIDER_IDS = Object.freeze(['adsb-lol', 'readsb-local', 'aisstream-io', 'worldview-seed-airports'] as const);
