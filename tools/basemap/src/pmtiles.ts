import { promises as fs } from 'node:fs';
import { gunzipSync } from 'node:zlib';

/**
 * What a PMTiles v3 archive says about itself: the 127-byte header and the JSON metadata
 * it points to. Read after Planetiler exits, so the report describes the file that was
 * written rather than the command that was run (spec: github.com/protomaps/PMTiles, v3).
 */
export interface PmtilesSummary {
  version: 3;
  tileType: 'mvt' | 'png' | 'jpeg' | 'webp' | 'avif' | 'unknown';
  tileCompression: 'none' | 'gzip' | 'brotli' | 'zstd' | 'unknown';
  minZoom: number;
  maxZoom: number;
  bounds: { west: number; south: number; east: number; north: number };
  addressedTiles: number;
  /** `vector_layers[].id` from the metadata, when it could be read. */
  vectorLayers: string[];
  /** The metadata's `attribution`, `name`, `description` and `version` strings, as written. */
  metadata: { attribution?: string; name?: string; description?: string; version?: string };
}

/**
 * The layers the app's 2D styles draw from (packages/render-maplibre/src/styles): a file
 * without these is not the Protomaps basemap schema, whatever it is called.
 */
export const PROTOMAPS_CORE_LAYERS: readonly string[] = Object.freeze([
  'earth',
  'water',
  'roads',
  'places',
  'boundaries',
]);

const HEADER_BYTES = 127;
const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const TILE_TYPES = ['unknown', 'mvt', 'png', 'jpeg', 'webp', 'avif'] as const;
const COMPRESSIONS = ['unknown', 'none', 'gzip', 'brotli', 'zstd'] as const;

export class PmtilesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PmtilesError';
  }
}

export function parsePmtilesHeader(buf: Uint8Array): Omit<PmtilesSummary, 'vectorLayers' | 'metadata'> & {
  metadataOffset: number;
  metadataLength: number;
  internalCompression: PmtilesSummary['tileCompression'];
} {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < HEADER_BYTES) throw new PmtilesError('shorter than a PMTiles v3 header');
  if (b.toString('ascii', 0, 7) !== 'PMTiles' || b[7] !== 3) throw new PmtilesError('not a PMTiles v3 archive');
  const u64 = (o: number): number => Number(b.readBigUInt64LE(o));
  const e7 = (o: number): number => b.readInt32LE(o) / 1e7;
  return {
    version: 3,
    metadataOffset: u64(24),
    metadataLength: u64(32),
    addressedTiles: u64(72),
    internalCompression: COMPRESSIONS[b[97]!] ?? 'unknown',
    tileCompression: COMPRESSIONS[b[98]!] ?? 'unknown',
    tileType: TILE_TYPES[b[99]!] ?? 'unknown',
    minZoom: b[100]!,
    maxZoom: b[101]!,
    bounds: { west: e7(102), south: e7(106), east: e7(110), north: e7(114) },
  };
}

export async function readPmtilesSummary(file: string): Promise<PmtilesSummary> {
  const handle = await fs.open(file, 'r');
  try {
    const head = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(head, 0, HEADER_BYTES, 0);
    const h = parsePmtilesHeader(head.subarray(0, bytesRead));
    let vectorLayers: string[] = [];
    let metadata: PmtilesSummary['metadata'] = {};
    if (h.metadataLength > 0 && h.metadataLength <= MAX_METADATA_BYTES) {
      const raw = Buffer.alloc(h.metadataLength);
      await handle.read(raw, 0, h.metadataLength, h.metadataOffset);
      let text: string | undefined;
      if (h.internalCompression === 'gzip') text = gunzipSync(raw).toString('utf8');
      else if (h.internalCompression === 'none') text = raw.toString('utf8');
      if (text !== undefined) {
        const json = JSON.parse(text) as Record<string, unknown>;
        if (Array.isArray(json.vector_layers))
          vectorLayers = json.vector_layers
            .map((l) => (l && typeof l === 'object' ? (l as { id?: unknown }).id : undefined))
            .filter((id): id is string => typeof id === 'string');
        for (const key of ['attribution', 'name', 'description', 'version'] as const)
          if (typeof json[key] === 'string') metadata = { ...metadata, [key]: json[key] as string };
      }
    }
    const { metadataOffset: _o, metadataLength: _l, internalCompression: _c, ...rest } = h;
    return { ...rest, vectorLayers, metadata };
  } finally {
    await handle.close();
  }
}

/** Why a summary is not a Protomaps-schema vector basemap, or undefined when it is one. */
export function protomapsSchemaProblem(s: PmtilesSummary): string | undefined {
  if (s.tileType !== 'mvt') return `tiles are ${s.tileType}, not vector (mvt)`;
  const missing = PROTOMAPS_CORE_LAYERS.filter((l) => !s.vectorLayers.includes(l));
  if (missing.length)
    return `vector layers ${missing.join(', ')} are missing (has: ${s.vectorLayers.join(', ') || 'none'}); the app's styles read the Protomaps basemap schema`;
  if (s.addressedTiles === 0) return 'the archive holds no tiles';
  return undefined;
}
