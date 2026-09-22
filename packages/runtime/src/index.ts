/**
 * @worldview/runtime — the one composition of WORLDVIEW.
 *
 *   providers (@worldview/providers) → ProviderHost → WorldState → events / history /
 *   timeline / search / offline / cameras, all behind the IPC request catalogue.
 *
 * `src/contract.ts` is frozen (architecture-contract-v1); everything else here is the
 * implementation of it. The desktop main process wraps this with the IPC router; the
 * browser and demo modes call it through `createInProcessClient`.
 */
export * from './contract.js';
export { createWorldRuntime, type ComposedWorldRuntime } from './runtime.js';
export { RuntimeCore, isLiveMode } from './core.js';
export { createHandlers } from './handlers.js';
export {
  inProcessHostBridge,
  type HostBridge,
  type FileChoice,
  type RuntimeCredentialStore,
  type WorldRuntimeDeps,
} from './deps.js';
export {
  InvalidRequestError,
  NotFoundError,
  DeniedError,
  UnavailableError,
  validateCollection,
  validateWatchZone,
  validateLens,
  validateRegion,
} from './validate.js';
export { PlaceIndexGazetteer } from './support/gazetteer.js';
export {
  SubscriptionRegistry,
  matchesSubscription,
  filterObjects,
  deltaFor,
  diffObjectSets,
} from './support/subscriptions.js';
export {
  createDemoProviders,
  createDemoEarthquakeProvider,
  createDemoAircraftProvider,
  DEMO_TRACKS,
  type DemoTrack,
} from './demo/index.js';

export const RUNTIME_CONTRACT_VERSION = 'architecture-contract-v1';
