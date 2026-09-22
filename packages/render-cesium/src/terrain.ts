/**
 * Adapted from gods-eye-view src/maps/terrain.js (MIT).
 *
 * Terrain factories are lazy: they run only when a terrain descriptor is applied.
 * Default is the flat WGS84 ellipsoid (no network). Quantized-mesh URLs (e.g.
 * Re:Earth / Mapterhorn ellipsoidal mesh, CC BY 4.0) and Cesium World Terrain (ion
 * token) are optional. A `local` descriptor points at a directory served by the
 * shell (worldpack terrain) — `file://` is not fetchable from the renderer, so the
 * shell hands us an app-scheme URL for it.
 */
import type { TerrainDescriptor } from '@worldview/render-core';
import type { CesiumLike, TerrainProviderLike } from './cesium-like.js';

export type TerrainFactoryModule = Pick<
  CesiumLike,
  'EllipsoidTerrainProvider' | 'createTerrainFromUrl' | 'IonResource'
>;

export interface TerrainSource {
  id: string;
  attribution: string;
  create(ctx: { signal: AbortSignal }): Promise<TerrainProviderLike>;
}

export const REEARTH_TERRAIN_URL = 'https://terrain.reearth.land/cesium-mesh/ellipsoid';
export const REEARTH_TERRAIN_ATTRIBUTION = 'Terrain: Re:Earth / Mapterhorn (CC BY 4.0)';

export function ellipsoidTerrain(cesium: TerrainFactoryModule): TerrainSource {
  return { id: 'ellipsoid', attribution: '', create: async () => new cesium.EllipsoidTerrainProvider() };
}

export function quantizedMeshTerrain(cesium: TerrainFactoryModule, url: string, attribution: string): TerrainSource {
  return {
    id: `quantized-mesh:${url}`,
    attribution,
    create: async ({ signal }) => {
      signal.throwIfAborted();
      return cesium.createTerrainFromUrl(url, { requestVertexNormals: true, requestWaterMask: false });
    },
  };
}

export function ionWorldTerrain(cesium: TerrainFactoryModule, accessToken: string): TerrainSource {
  return {
    id: 'cesium-ion-world-terrain',
    attribution: 'Cesium World Terrain © Cesium ion',
    create: async ({ signal }) => {
      const token = accessToken.trim();
      if (!token) throw new Error('Cesium World Terrain requires an explicit ion token');
      signal.throwIfAborted();
      const resource = await cesium.IonResource.fromAssetId(1, { accessToken: token });
      signal.throwIfAborted();
      return cesium.createTerrainFromUrl(resource, { requestVertexNormals: true, requestWaterMask: false });
    },
  };
}

/** Local worldpack terrain: a quantized-mesh tree the shell serves at `servedUrl`. */
export function localTerrain(
  cesium: TerrainFactoryModule,
  path: string,
  attribution: string,
  resolveServedUrl: (path: string) => string,
): TerrainSource {
  return {
    id: `local:${path}`,
    attribution,
    create: async ({ signal }) => {
      signal.throwIfAborted();
      return cesium.createTerrainFromUrl(resolveServedUrl(path), {
        requestVertexNormals: false,
        requestWaterMask: false,
      });
    },
  };
}

export interface TerrainResolverOptions {
  ionToken?: string;
  /** Maps a worldpack path to a URL the renderer may fetch (app scheme). */
  resolveLocalUrl?: (path: string) => string;
}

export function terrainSourceFor(
  cesium: TerrainFactoryModule,
  descriptor: TerrainDescriptor,
  opts: TerrainResolverOptions = {},
): TerrainSource {
  switch (descriptor.kind) {
    case 'ellipsoid':
      return ellipsoidTerrain(cesium);
    case 'quantized-mesh':
      return quantizedMeshTerrain(cesium, descriptor.url, descriptor.attribution);
    case 'cesium-ion-world-terrain':
      return ionWorldTerrain(cesium, opts.ionToken ?? '');
    case 'local':
      return localTerrain(cesium, descriptor.path, descriptor.attribution, opts.resolveLocalUrl ?? ((p) => p));
  }
}
