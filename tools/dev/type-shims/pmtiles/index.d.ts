/**
 * Declaration shim for `pmtiles` — used ONLY when the real package is not
 * installed (tools/dev/typecheck.mjs maps it in and records that in evidence). It
 * declares the surface `packages/render-maplibre` uses, matching the documented
 * pmtiles ≥ 3 API: `new Protocol()`, `maplibregl.addProtocol('pmtiles', protocol.tile)`,
 * `protocol.add(new PMTiles(url))`, `PMTiles.getHeader()` / `getMetadata()`.
 */
export enum TileType {
  Unknown = 0,
  Mvt = 1,
  Png = 2,
  Jpeg = 3,
  Webp = 4,
  Avif = 5,
}

export interface Header {
  specVersion: number;
  rootDirectoryOffset: number;
  rootDirectoryLength: number;
  jsonMetadataOffset: number;
  jsonMetadataLength: number;
  leafDirectoryOffset: number;
  leafDirectoryLength?: number;
  tileDataOffset: number;
  tileDataLength?: number;
  numAddressedTiles: number;
  numTileEntries: number;
  numTileContents: number;
  clustered: boolean;
  internalCompression: number;
  tileCompression: number;
  tileType: TileType;
  minZoom: number;
  maxZoom: number;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  centerZoom: number;
  centerLon: number;
  centerLat: number;
  etag?: string;
}

export interface RangeResponse {
  data: ArrayBuffer;
  etag?: string;
  expires?: string;
  cacheControl?: string;
}

export interface Source {
  getBytes(offset: number, length: number, signal?: AbortSignal, etag?: string): Promise<RangeResponse>;
  getKey(): string;
}

export class FetchSource implements Source {
  constructor(url: string, customHeaders?: Headers, mustUseRangeHeaders?: boolean);
  getBytes(offset: number, length: number, signal?: AbortSignal, etag?: string): Promise<RangeResponse>;
  getKey(): string;
}

export interface TileJson {
  tilejson: string;
  scheme: 'xyz';
  tiles: string[];
  vector_layers?: unknown[];
  attribution?: string;
  description?: string;
  name?: string;
  version?: string;
  bounds?: [number, number, number, number];
  center?: [number, number, number];
  minzoom: number;
  maxzoom: number;
}

export class PMTiles {
  constructor(source: Source | string);
  readonly source: Source;
  getHeader(): Promise<Header>;
  getMetadata(): Promise<unknown>;
  getTileJson(baseTilesUrl: string): Promise<TileJson>;
  getZxy(z: number, x: number, y: number, signal?: AbortSignal): Promise<RangeResponse | undefined>;
}

export interface ProtocolRequest {
  url: string;
  type?: string;
}

export interface ProtocolResponse {
  data: unknown;
  cacheControl?: string | null;
  expires?: string | null;
}

/** MapLibre custom-protocol adapter: `addProtocol('pmtiles', protocol.tile)`. */
export class Protocol {
  constructor(options?: { metadata?: boolean; errorOnMissingTile?: boolean });
  readonly tiles: Map<string, PMTiles>;
  add(p: PMTiles): void;
  get(url: string): PMTiles | undefined;
  tile: (params: ProtocolRequest, abortController: AbortController) => Promise<ProtocolResponse>;
}
