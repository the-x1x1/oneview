import { promises as fs } from 'node:fs';
import { inflateSync } from 'node:zlib';
import type { GeoBounds } from '@worldview/world-model';

/**
 * The first block of an `.osm.pbf` file, read far enough to learn the area the extract
 * says it covers (wiki.openstreetmap.org/wiki/PBF_Format): a 4-byte big-endian length,
 * a `BlobHeader` whose type is `OSMHeader`, then a `Blob` holding a `HeaderBlock`, whose
 * optional `bbox` is in nanodegrees. Geofabrik extracts carry one; a file without one is
 * still an OSM file, and the builder then says it could not check the area.
 */
export type OsmHeader = { ok: true; bbox?: GeoBounds } | { ok: false; reason: string };

const MAX_BLOB_HEADER = 64 * 1024;
/** The format caps a header blob at 32 MiB. */
const MAX_HEADER_BLOB = 32 * 1024 * 1024;

class Reader {
  pos = 0;
  constructor(readonly buf: Buffer) {}
  get done(): boolean {
    return this.pos >= this.buf.length;
  }
  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.buf.length) throw new Error('truncated varint');
      const byte = this.buf[this.pos++]!;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
    throw new Error('varint longer than 10 bytes');
  }
  bytes(): Buffer {
    const len = Number(this.varint());
    if (len < 0 || this.pos + len > this.buf.length) throw new Error('truncated field');
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.pos += 4;
    else throw new Error(`unsupported wire type ${wire}`);
    if (this.pos > this.buf.length) throw new Error('truncated field');
  }
}

/** Each field of a protobuf message: its number, wire type and a reader positioned on its value. */
function* fields(buf: Buffer): Generator<{ field: number; wire: number; r: Reader }> {
  const r = new Reader(buf);
  while (!r.done) {
    const key = Number(r.varint());
    yield { field: key >>> 3, wire: key & 7, r };
  }
}

function zigzag(v: bigint): number {
  return Number((v >> 1n) ^ -(v & 1n));
}

export function parseOsmHeaderBlock(block: Buffer): GeoBounds | undefined {
  for (const { field, wire, r } of fields(block)) {
    if (field !== 1 || wire !== 2) {
      r.skip(wire);
      continue;
    }
    const box: Record<number, number> = {};
    for (const f of fields(r.bytes())) {
      if (f.wire === 0 && f.field >= 1 && f.field <= 4) box[f.field] = zigzag(f.r.varint()) / 1e9;
      else f.r.skip(f.wire);
    }
    if ([1, 2, 3, 4].every((k) => box[k] !== undefined))
      return { west: box[1]!, east: box[2]!, north: box[3]!, south: box[4]! };
    return undefined;
  }
  return undefined;
}

export async function readOsmHeader(file: string): Promise<OsmHeader> {
  const handle = await fs.open(file, 'r');
  try {
    const lenBuf = Buffer.alloc(4);
    if ((await handle.read(lenBuf, 0, 4, 0)).bytesRead < 4) return { ok: false, reason: 'the file is too short' };
    const headerLen = lenBuf.readUInt32BE(0);
    if (headerLen === 0 || headerLen > MAX_BLOB_HEADER)
      return { ok: false, reason: 'it does not start like an OSM PBF file' };
    const header = Buffer.alloc(headerLen);
    if ((await handle.read(header, 0, headerLen, 4)).bytesRead < headerLen)
      return { ok: false, reason: 'the first block header is truncated' };
    let type: string | undefined;
    let dataSize: number | undefined;
    for (const { field, wire, r } of fields(header)) {
      if (field === 1 && wire === 2) type = r.bytes().toString('utf8');
      else if (field === 3 && wire === 0) dataSize = Number(r.varint());
      else r.skip(wire);
    }
    if (type !== 'OSMHeader') return { ok: false, reason: 'it does not start like an OSM PBF file' };
    if (dataSize === undefined || dataSize <= 0 || dataSize > MAX_HEADER_BLOB)
      return { ok: false, reason: 'the OSMHeader block has no usable size' };
    const blob = Buffer.alloc(dataSize);
    if ((await handle.read(blob, 0, dataSize, 4 + headerLen)).bytesRead < dataSize)
      return { ok: false, reason: 'the OSMHeader block is truncated' };
    let block: Buffer | undefined;
    for (const { field, wire, r } of fields(blob)) {
      if (field === 1 && wire === 2) block = Buffer.from(r.bytes());
      else if (field === 3 && wire === 2) block = inflateSync(r.bytes(), { maxOutputLength: MAX_HEADER_BLOB });
      else r.skip(wire);
    }
    if (!block) return { ok: false, reason: 'the OSMHeader block uses a compression this tool does not read' };
    const bbox = parseOsmHeaderBlock(block);
    return bbox ? { ok: true, bbox } : { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: `the OSMHeader block could not be read (${err instanceof Error ? err.message : String(err)})`,
    };
  } finally {
    await handle.close();
  }
}
