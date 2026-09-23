/**
 * @worldview/offline — offline world packs (ADR-007).
 *
 *   manifest.ts            WorldPackManifest + strict schema, path rules per content kind
 *   zip.ts                 minimal safe ZIP writer/reader (store/deflate, no zip64, validated before extraction)
 *   verify.ts              verifyWorldPack / extractWorldPack (structure → manifest → signature → cross-check → hashes)
 *   signature.ts           Ed25519 pack signatures over manifest.json, publisher keys, trust
 *   builder.ts             WorldPackBuilder: policy-gated assembly, clipping, search index, NOTICES.md, build report
 *   place-index.ts         PlaceIndex: pure-TS inverted index for local place search
 *   registry.ts            WorldPackRegistry: install/remove/enable, capabilities, merged PlaceIndex, PMTiles paths
 *   connection-monitor.ts  ConnectionMonitor: OS signal + probe + source health → CONNECTED/DEGRADED/OFFLINE with hysteresis
 *   region-presets.ts      bounds-only presets for the CLI
 */
export * from './manifest.js';
export * from './zip.js';
export * from './verify.js';
export * from './signature.js';
export * from './sign-pack.js';
export * from './geojson.js';
export * from './place-index.js';
export * from './place-entries.js';
export * from './notices.js';
export * from './region-presets.js';
export * from './builder.js';
export * from './registry.js';
export * from './connection-monitor.js';

export const OFFLINE_CONTRACT_VERSION = 'architecture-contract-v1';
