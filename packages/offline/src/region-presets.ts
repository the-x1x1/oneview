import type { GeoBounds } from '@worldview/world-model';

/**
 * Named bounding boxes for `worldpack build --region <preset>`. Bounds only —
 * a preset is a convenience for the CLI, not an admin boundary.
 */
export type RegionPresetId =
  | 'hawaii'
  | 'japan'
  | 'california'
  | 'uk'
  | 'western-europe'
  | 'australia-east'
  | 'us-gulf-coast';

export interface RegionPreset {
  id: RegionPresetId;
  name: string;
  bounds: GeoBounds;
}

export const REGION_PRESETS: readonly RegionPreset[] = Object.freeze([
  { id: 'hawaii', name: 'Hawaiian Islands', bounds: { west: -161.0, south: 18.5, east: -154.5, north: 22.5 } },
  { id: 'japan', name: 'Japan', bounds: { west: 122.5, south: 24.0, east: 146.5, north: 46.0 } },
  { id: 'california', name: 'California', bounds: { west: -124.6, south: 32.3, east: -114.0, north: 42.1 } },
  { id: 'uk', name: 'United Kingdom and Ireland', bounds: { west: -11.0, south: 49.5, east: 2.2, north: 61.0 } },
  { id: 'western-europe', name: 'Western Europe', bounds: { west: -10.5, south: 35.5, east: 18.5, north: 58.0 } },
  { id: 'australia-east', name: 'Eastern Australia', bounds: { west: 138.0, south: -39.5, east: 154.5, north: -10.0 } },
  { id: 'us-gulf-coast', name: 'US Gulf Coast', bounds: { west: -98.5, south: 24.0, east: -80.0, north: 31.5 } },
]);

export function regionPreset(id: string): RegionPreset | undefined {
  return REGION_PRESETS.find((p) => p.id === id);
}

export function isRegionPresetId(id: string): id is RegionPresetId {
  return regionPreset(id) !== undefined;
}
