/**
 * Basemap / terrain options offered in Settings and credited on screen.
 *
 * LOCAL STUB (reported to the lead): the IPC contract exposes only `settings.basemapId`
 * / `terrainId` and no channel that lists the map providers the runtime has configured
 * (a `map.providers.list` request returning BasemapDescriptor/TerrainDescriptor entries
 * would be the right home — see ADR-008 "map-provider registry"). Until that exists the
 * shell offers the zero-credential defaults from ADR-001/ADR-008; entries the runtime
 * cannot serve simply keep the previous selection when settings.set rejects them.
 */
export interface BasemapOption { id: string; name: string; attribution: string; mode: '2D' | '3D' | 'both'; offline: boolean }
export interface TerrainOption { id: string; name: string; attribution: string }

export const BASEMAP_CATALOG: BasemapOption[] = [
  { id: 'natural-earth-ii', name: 'Natural Earth II (bundled)', attribution: 'Natural Earth II — public domain', mode: '3D', offline: true },
  { id: 'worldview-dark', name: 'WORLDVIEW dark (vector, offline pack)', attribution: '© OpenMapTiles © OpenStreetMap contributors', mode: '2D', offline: true },
  { id: 'none', name: 'No basemap (graticule only)', attribution: '', mode: 'both', offline: true },
];

export const TERRAIN_CATALOG: TerrainOption[] = [
  { id: 'ellipsoid', name: 'Ellipsoid (no terrain)', attribution: '' },
];
