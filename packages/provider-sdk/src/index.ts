/**
 * @worldview/provider-sdk — the frozen provider contract (architecture-contract-v1).
 *
 * A provider = manifest + data policy + normalizer + fixtures + tests.
 * Providers depend on this package and @worldview/world-model only.
 */
export * from './manifest.js';
export * from './health.js';
export * from './provider.js';
export * from './helpers.js';
export * from './local-device.js';
export * from './local-files.js';
export * from './local-listener.js';
export * as testing from './testing.js';

export const PROVIDER_SDK_CONTRACT_VERSION = 'architecture-contract-v1';
