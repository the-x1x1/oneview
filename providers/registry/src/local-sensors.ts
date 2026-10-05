import type { WorldProvider } from '@worldview/provider-sdk';
import { createProvider as createAisLocal } from '@worldview/provider-ais-local';
import { createProvider as createMeshtasticLocal } from '@worldview/provider-meshtastic-local';
import { createProvider as createNmea2000Local } from '@worldview/provider-nmea2000-local';
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
  'ais-local': () => createAisLocal(),
  // Roadmap 0.6: the user's own Meshtastic mesh, through one of their nodes over TCP.
  'meshtastic-local': () => createMeshtasticLocal(),
  // Roadmap 0.6: the user's own boat on NMEA 2000, through a gateway serving YD RAW over TCP.
  'nmea2000-local': () => createNmea2000Local(),
});
