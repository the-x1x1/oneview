import { ObjectTypes } from '@worldview/world-model';

/**
 * Search vocabulary (ADR-010: deterministic grammar, no LLM). Every phrase maps to a
 * canonical object type; multi-word phrases are matched before single words.
 */
export interface TypeVocabulary {
  type: string;
  /** Plural display noun for titles, e.g. "Earthquakes". */
  label: string;
  phrases: readonly string[];
}

export const TYPE_VOCABULARY: readonly TypeVocabulary[] = Object.freeze([
  {
    type: ObjectTypes.Earthquake,
    label: 'Earthquakes',
    phrases: [
      'earthquakes',
      'earthquake',
      'quakes',
      'quake',
      'seismic',
      'seismic events',
      'seismicity',
      'tremors',
      'tremor',
    ],
  },
  {
    type: ObjectTypes.FireDetection,
    label: 'Fires',
    phrases: [
      'fires',
      'fire',
      'wildfires',
      'wildfire',
      'hotspots',
      'hotspot',
      'hot spots',
      'fire detections',
      'fire detection',
      'thermal anomalies',
      'firms',
    ],
  },
  {
    type: ObjectTypes.Aircraft,
    label: 'Aircraft',
    phrases: [
      'aircraft',
      'planes',
      'plane',
      'flights',
      'flight',
      'airplanes',
      'airplane',
      'jets',
      'jet',
      'helicopters',
      'helicopter',
      'adsb',
      'ads-b',
    ],
  },
  {
    type: ObjectTypes.Vessel,
    label: 'Ships',
    phrases: ['ships', 'ship', 'vessels', 'vessel', 'boats', 'boat', 'ais', 'tankers', 'tanker', 'cargo ships'],
  },
  {
    type: ObjectTypes.Satellite,
    label: 'Satellites',
    phrases: ['satellites', 'satellite', 'sats', 'sat', 'orbits', 'spacecraft', 'starlink'],
  },
  {
    type: ObjectTypes.WeatherAlert,
    label: 'Weather alerts',
    phrases: [
      'alerts',
      'alert',
      'warnings',
      'warning',
      'weather alerts',
      'weather alert',
      'weather warnings',
      'watches',
      'advisories',
      'advisory',
    ],
  },
  {
    type: ObjectTypes.Camera,
    label: 'Cameras',
    phrases: ['cameras', 'camera', 'webcams', 'webcam', 'cctv', 'cams', 'cam', 'traffic cameras'],
  },
  {
    type: ObjectTypes.Storm,
    label: 'Storms',
    phrases: [
      'storms',
      'storm',
      'hurricanes',
      'hurricane',
      'typhoons',
      'typhoon',
      'cyclones',
      'cyclone',
      'tropical storms',
    ],
  },
  {
    type: ObjectTypes.WeatherStation,
    label: 'Weather stations',
    phrases: ['weather stations', 'weather station', 'stations', 'metar', 'weather'],
  },
  { type: ObjectTypes.Airport, label: 'Airports', phrases: ['airports', 'airport', 'airfields', 'airfield'] },
  { type: ObjectTypes.Port, label: 'Ports', phrases: ['ports', 'port', 'harbours', 'harbors', 'harbour', 'harbor'] },
  {
    type: ObjectTypes.TransitVehicle,
    label: 'Transit vehicles',
    phrases: ['buses', 'bus', 'trains', 'train', 'transit', 'transit vehicles', 'trams', 'tram'],
  },
  {
    type: ObjectTypes.TrafficSegment,
    label: 'Traffic',
    phrases: ['traffic', 'traffic segments', 'congestion', 'roads'],
  },
  {
    type: ObjectTypes.Infrastructure,
    label: 'Infrastructure',
    phrases: ['infrastructure', 'power plants', 'power plant', 'substations', 'pipelines', 'dams', 'bridges'],
  },
  {
    type: ObjectTypes.Launch,
    label: 'Launches',
    phrases: ['launches', 'launch', 'rocket launches', 'rocket launch', 'rockets', 'rocket'],
  },
  { type: ObjectTypes.Sensor, label: 'Sensors', phrases: ['sensors', 'sensor', 'gauges', 'gauge', 'buoys', 'buoy'] },
  {
    type: ObjectTypes.ImageryScene,
    label: 'Imagery scenes',
    phrases: ['imagery', 'imagery scenes', 'imagery scene', 'scenes', 'scene', 'satellite images', 'satellite imagery'],
  },
  { type: ObjectTypes.Place, label: 'Places', phrases: ['places', 'place', 'towns', 'cities'] },
]);

export function typeLabel(type: string): string {
  return TYPE_VOCABULARY.find((v) => v.type === type)?.label ?? type;
}

/** A command the search box can trigger. Ids are stable for the shell's command router. */
export interface CommandDefinition {
  id: string;
  title: string;
  keywords?: string[];
}

export const DEFAULT_COMMANDS: readonly CommandDefinition[] = Object.freeze([
  { id: 'goto-location', title: 'Go to location', keywords: ['fly', 'navigate', 'jump'] },
  { id: 'go-live', title: 'Go live', keywords: ['now', 'realtime', 'resume'] },
  { id: 'switch-2d', title: 'Switch to 2D', keywords: ['map', 'flat', '2d'] },
  { id: 'switch-3d', title: 'Switch to 3D', keywords: ['globe', '3d'] },
  { id: 'open-source-health', title: 'Open Source Health', keywords: ['sources', 'providers', 'status', 'health'] },
  { id: 'open-diagnostics', title: 'Open Diagnostics', keywords: ['debug', 'logs', 'system'] },
  {
    id: 'lens-aviation',
    title: 'Show only Aviation',
    keywords: ['aircraft', 'flights', 'planes', 'lens', 'layer', 'only'],
  },
  {
    id: 'lens-disasters',
    title: 'Show only Disasters',
    keywords: ['disasters', 'earthquakes', 'fires', 'alerts', 'lens', 'layer', 'only'],
  },
  { id: 'lens-maritime', title: 'Show only Maritime', keywords: ['ships', 'vessels', 'sea', 'lens', 'layer', 'only'] },
  {
    id: 'lens-space',
    title: 'Show only Space',
    keywords: ['satellites', 'orbits', 'launches', 'lens', 'layer', 'only'],
  },
  {
    id: 'lens-weather',
    title: 'Show only Weather',
    keywords: ['storms', 'alerts', 'forecast', 'lens', 'layer', 'only'],
  },
  { id: 'download-offline-pack', title: 'Download offline pack', keywords: ['worldpack', 'offline', 'install'] },
  {
    id: 'manage-providers',
    title: 'Manage providers',
    keywords: ['sources', 'settings', 'credentials', 'enable', 'disable'],
  },
]);

/** Words that carry no meaning for the parser and are dropped before place lookup. */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  'the',
  'a',
  'an',
  'of',
  'all',
  'show',
  'me',
  'find',
  'list',
  'any',
  'and',
  'with',
  'for',
  'to',
  'please',
  'active',
  'current',
  'live',
]);
