import type { RenderingRule } from './presentation.js';

/**
 * Lenses (directive §56): a lens selects object/event types, provider preferences,
 * rendering rules and visible panels. Users may customise and save lenses; saved
 * lenses are validated against this shape.
 */
export interface LensDefinition {
  id: string;
  name: string;
  description?: string;
  objectTypes: string[];
  eventTypes: string[];
  providerPreferences?: string[];
  renderingRules: RenderingRule[];
  visiblePanels: string[];
  /** Built-in lenses cannot be deleted; user lenses can. */
  builtIn?: boolean;
}

export const PANELS = ['selection', 'sources', 'timeline', 'related', 'feed', 'collections', 'watchzones'] as const;

const ALL_TYPES = [
  'aircraft',
  'vessel',
  'satellite',
  'earthquake',
  'fire-detection',
  'storm',
  'weather-station',
  'weather-alert',
  'camera',
  'transit-vehicle',
  'traffic-segment',
  'infrastructure',
  'airport',
  'port',
  'place',
  'launch',
  'sensor',
];

export const BUILT_IN_LENSES: LensDefinition[] = [
  {
    id: 'overview',
    name: 'Overview',
    description: 'Everything significant, de-cluttered.',
    objectTypes: ALL_TYPES,
    eventTypes: ['earthquake', 'wildfire-cluster', 'weather-alert', 'storm', 'air-quality', 'launch'],
    renderingRules: [],
    visiblePanels: ['selection', 'sources', 'feed', 'timeline'],
    builtIn: true,
  },
  {
    id: 'aviation',
    name: 'Aviation',
    objectTypes: ['aircraft', 'airport'],
    eventTypes: [],
    providerPreferences: ['readsb-local', 'adsb-lol', 'opensky-network'],
    renderingRules: [],
    visiblePanels: ['selection', 'sources', 'timeline', 'related'],
    builtIn: true,
  },
  {
    id: 'maritime',
    name: 'Maritime',
    objectTypes: ['vessel', 'port'],
    eventTypes: [],
    providerPreferences: ['aisstream'],
    renderingRules: [],
    visiblePanels: ['selection', 'sources', 'timeline', 'related'],
    builtIn: true,
  },
  {
    id: 'space',
    name: 'Space',
    objectTypes: ['satellite', 'launch'],
    eventTypes: ['launch', 'satellite-decay'],
    providerPreferences: ['celestrak'],
    renderingRules: [],
    visiblePanels: ['selection', 'sources', 'timeline'],
    builtIn: true,
  },
  {
    id: 'weather',
    name: 'Weather',
    objectTypes: ['weather-alert', 'storm', 'weather-station'],
    eventTypes: ['weather-alert', 'storm'],
    renderingRules: [],
    visiblePanels: ['selection', 'sources', 'feed', 'timeline'],
    builtIn: true,
  },
  {
    id: 'disasters',
    name: 'Disasters',
    objectTypes: ['earthquake', 'fire-detection', 'storm', 'weather-alert'],
    eventTypes: ['earthquake', 'wildfire-cluster', 'weather-alert', 'storm'],
    providerPreferences: ['usgs-earthquakes', 'nasa-firms'],
    renderingRules: [],
    visiblePanels: ['selection', 'sources', 'feed', 'timeline', 'related'],
    builtIn: true,
  },
  {
    id: 'transportation',
    name: 'Transportation',
    objectTypes: ['transit-vehicle', 'traffic-segment', 'airport', 'port'],
    eventTypes: [],
    renderingRules: [],
    visiblePanels: ['selection', 'sources', 'timeline'],
    builtIn: true,
  },
  {
    id: 'infrastructure',
    name: 'Infrastructure',
    objectTypes: ['infrastructure', 'airport', 'port', 'camera', 'sensor'],
    eventTypes: [],
    renderingRules: [],
    visiblePanels: ['selection', 'sources', 'related'],
    builtIn: true,
  },
  {
    id: 'environment',
    name: 'Environment',
    objectTypes: ['fire-detection', 'weather-station', 'sensor', 'earthquake'],
    eventTypes: ['wildfire-cluster', 'air-quality'],
    renderingRules: [],
    visiblePanels: ['selection', 'sources', 'feed', 'timeline'],
    builtIn: true,
  },
];

export function lensById(id: string, custom: LensDefinition[] = []): LensDefinition | undefined {
  return custom.find((l) => l.id === id) ?? BUILT_IN_LENSES.find((l) => l.id === id);
}
