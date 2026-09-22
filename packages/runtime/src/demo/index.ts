import type { WorldProvider } from '@worldview/provider-sdk';
import { createDemoEarthquakeProvider } from './fixture-earthquakes.js';
import { createDemoAircraftProvider } from './synthetic-aircraft.js';

/**
 * Demo mode composes the same runtime graph as production with fixture-backed providers.
 * Everything they emit is `provenance.origin: 'recorded'`, so the shell labels it
 * RECORDED DATA and `app.info.demoMode` is true. No demo provider reaches the network.
 */
export {
  DemoEarthquakeProvider,
  createDemoEarthquakeProvider,
  DEMO_EARTHQUAKE_MANIFEST,
} from './fixture-earthquakes.js';
export {
  DemoAircraftProvider,
  createDemoAircraftProvider,
  DEMO_AIRCRAFT_MANIFEST,
  DEMO_TRACKS,
  type DemoTrack,
} from './synthetic-aircraft.js';

/** `resourcesDir` is the packaged application's read-only data directory, where the demo fixture is staged. */
export function createDemoProviders(resourcesDir?: string): WorldProvider[] {
  return [createDemoEarthquakeProvider(undefined, resourcesDir), createDemoAircraftProvider()];
}
