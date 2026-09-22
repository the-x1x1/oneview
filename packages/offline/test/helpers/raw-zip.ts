import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../../src/zip.js';

/**
 * Test-only raw ZIP assembler: writes whatever headers we tell it to, so tests can
 * craft hostile archives (traversal names, symlink attributes, lying sizes, zip64
 * markers, encryption flags…) that the production writer refuses to produce.
 */
export interface RawEntry {
  name: string;
  data: Buffer;
  /** 0 = store, 8 = deflate (default). Anything else is written verbatim (unsupported method test). */
  method?: number;
  flags?: number;
  versionMadeBy?: number;
  externalAttributes?: number;
  /** Override the sizes/crc written to BOTH headers (lying headers). */
  declaredUncompressed?: number;
  declaredCompressed?: number;
  declaredCrc?: number;
  /** Name written in the local header when it should differ from the central one. */
  localName?: string;
  /** Extra field bytes appended to the central directory record. */
  centralExtra?: Buffer;
}

export interface RawZipOptions {
  /** Override the EOCD total entry count (zip64 marker test). */
  totalEntries?: number;
  comment?: Buffer;
}

export function rawZip(entries: RawEntry[], opts: RawZipOptions = {}): Buffer {
  const parts: Buffer[] = [];
  let offset = 0;
  const central: Buffer[] = [];
  for (const e of entries) {
    const method = e.method ?? 8;
    const payload = method === 8 ? deflateRawSync(e.data) : e.data;
    const crc = e.declaredCrc ?? crc32(e.data);
    const csize = e.declaredCompressed ?? payload.length;
    const usize = e.declaredUncompressed ?? e.data.length;
    const flags = e.flags ?? 0;
    const localName = Buffer.from(e.localName ?? e.name, 'utf8');
    const centralName = Buffer.from(e.name, 'utf8');
    const local = Buffer.alloc(30 + localName.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(csize >>> 0, 18);
    local.writeUInt32LE(usize >>> 0, 22);
    local.writeUInt16LE(localName.length, 26);
    local.writeUInt16LE(0, 28);
    localName.copy(local, 30);
    parts.push(local, payload);
    const extra = e.centralExtra ?? Buffer.alloc(0);
    const rec = Buffer.alloc(46 + centralName.length + extra.length);
    rec.writeUInt32LE(0x02014b50, 0);
    rec.writeUInt16LE(e.versionMadeBy ?? (3 << 8) | 20, 4);
    rec.writeUInt16LE(20, 6);
    rec.writeUInt16LE(flags, 8);
    rec.writeUInt16LE(method, 10);
    rec.writeUInt16LE(0, 12);
    rec.writeUInt16LE(0x21, 14);
    rec.writeUInt32LE(crc >>> 0, 16);
    rec.writeUInt32LE(csize >>> 0, 20);
    rec.writeUInt32LE(usize >>> 0, 24);
    rec.writeUInt16LE(centralName.length, 28);
    rec.writeUInt16LE(extra.length, 30);
    rec.writeUInt16LE(0, 32);
    rec.writeUInt16LE(0, 34);
    rec.writeUInt16LE(0, 36);
    rec.writeUInt32LE((e.externalAttributes ?? (0o100644 << 16) >>> 0) >>> 0, 38);
    rec.writeUInt32LE(offset, 42);
    centralName.copy(rec, 46);
    extra.copy(rec, 46 + centralName.length);
    central.push(rec);
    offset += local.length + payload.length;
  }
  const cdOffset = offset;
  const cd = Buffer.concat(central);
  const comment = opts.comment ?? Buffer.alloc(0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(opts.totalEntries ?? entries.length, 8);
  eocd.writeUInt16LE(opts.totalEntries ?? entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...parts, cd, eocd, comment]);
}

export async function tempDir(prefix = 'worldview-offline-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function writeTemp(dir: string, name: string, bytes: Buffer | string): Promise<string> {
  const file = path.join(dir, name);
  await fs.writeFile(file, bytes);
  return file;
}
