import type { GeoBounds, GeoPosition } from '@worldview/world-model';

/** Small recorded place index for demo search (coordinates are public knowledge, rounded). */
export interface DemoPlace {
  id: string;
  name: string;
  region: string;
  position: GeoPosition;
  bounds: GeoBounds;
}

const place = (id: string, name: string, region: string, lat: number, lon: number, span: number): DemoPlace => ({
  id,
  name,
  region,
  position: { latitude: lat, longitude: lon },
  bounds: { south: lat - span, north: lat + span, west: lon - span * 1.4, east: lon + span * 1.4 },
});

export const DEMO_PLACES: DemoPlace[] = [
  place('honolulu', 'Honolulu', 'Hawaii, United States', 21.31, -157.86, 0.25),
  place('hilo', 'Hilo', 'Hawaii, United States', 19.72, -155.09, 0.2),
  place('los-angeles', 'Los Angeles', 'California, United States', 34.05, -118.24, 0.6),
  place('san-francisco', 'San Francisco', 'California, United States', 37.77, -122.42, 0.3),
  place('tokyo', 'Tokyo', 'Japan', 35.68, 139.69, 0.5),
  place('london', 'London', 'United Kingdom', 51.51, -0.13, 0.4),
  place('frankfurt', 'Frankfurt', 'Germany', 50.11, 8.68, 0.3),
  place('port-moresby', 'Port Moresby', 'Papua New Guinea', -9.44, 147.18, 0.4),
  place('anchorage', 'Anchorage', 'Alaska, United States', 61.22, -149.9, 0.6),
  place('santiago', 'Santiago', 'Chile', -33.45, -70.67, 0.5),
  place('reykjavik', 'Reykjavík', 'Iceland', 64.15, -21.94, 0.4),
  place('wellington', 'Wellington', 'New Zealand', -41.29, 174.78, 0.4),
];
